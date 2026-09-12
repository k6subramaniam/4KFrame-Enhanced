/**
 * Chromecast Custom Web Receiver bridge.
 *
 * The display page doubles as a Cast receiver. When loaded on a Chromecast the CAF
 * receiver framework is present (injected on Chromecast user-agents by index.html); this
 * starts the receiver and listens on {@link CAST_NAMESPACE}. Incoming {@link ControlMessage}s
 * are forwarded onto the same backend WebSocket the display already uses, so a Cast sender
 * drives the frame through the identical control protocol as the admin app.
 *
 * In a normal browser the framework is absent and this is a no-op.
 *
 * To go live, register an application id at the Google Cast SDK Developer Console and
 * point it at the deployed display URL (see `packaging/cast/`).
 */

import { CAST_NAMESPACE, isSeekOffsetSec, type ControlMessage } from '@4kframe/shared';

interface CafCustomEvent { data: unknown; }
interface CafPlaybackConfig {
  autoPauseDuration?: number;
  autoResumeDuration?: number;
  initialBandwidth?: number;
  segmentRequestRetryLimit?: number;
}
interface CafMediaInformation {
  contentId: string;
  contentType: string;
  contentUrl?: string;
  streamType?: string;
}
interface CafLoadRequestData {
  autoplay?: boolean;
  currentTime?: number;
  media: CafMediaInformation;
}
interface CafMessages {
  MediaInformation: new () => CafMediaInformation;
  LoadRequestData: new () => CafLoadRequestData;
}
interface CafPlayerManager {
  load(loadRequest: CafLoadRequestData): Promise<void>;
  pause(): void;
  play(): void;
  seek(seekTime: number): void;
}
interface CafReceiverOptions {
  adBreakPreloadTime?: number;
  customNamespaces?: Record<string, string>;
  disableIdleTimeout?: boolean;
  enforceSupportedCommands?: boolean;
  localSenderId?: string;
  maxInactivity?: number;
  mediaElement?: HTMLMediaElement;
  playbackConfig?: CafPlaybackConfig;
  playWatchedBreak?: boolean;
  preferredPlaybackRate?: number;
  preferredTextLanguage?: string;
  queue?: unknown;
  shakaVariant?: unknown;
  shakaVersion?: string;
  skipMplLoad?: boolean;
  skipPlayersLoad?: boolean;
  skipShakaLoad?: boolean;
  statusText?: string;
  supportedCommands?: number;
  uiConfig?: unknown;
  useLegacyDashSupport?: boolean;
  useShakaForHls?: boolean;
  versionCode?: number;
}
interface CafReceiverContext {
  addCustomMessageListener(namespace: string, listener: (event: CafCustomEvent) => void): void;
  getPlayerManager(): CafPlayerManager;
  start(options?: CafReceiverOptions): void;
}

declare global {
  interface Window {
    cast?: {
      framework?: {
        CastReceiverContext?: { getInstance(): CafReceiverContext };
        messages?: CafMessages;
      };
    };
  }
}

const CAST_VIDEO_LAYER_STYLE_ID = 'cast-video-layer-fix';

/**
 * Keep Cast video on the simplest possible hardware-overlay-friendly surface. Chromecast
 * devices can decode frames successfully yet paint only black when the video element is
 * transformed or when an opaque WebGL/backdrop layer sits over the hardware plane.
 */
function stabilizeCastVideoLayer(mediaElement: HTMLMediaElement): void {
  const video = mediaElement as HTMLVideoElement;
  const canvas = document.getElementById('gl') as HTMLElement | null;
  const backdrop = document.getElementById('video-bg') as HTMLElement | null;

  if (!document.getElementById(CAST_VIDEO_LAYER_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = CAST_VIDEO_LAYER_STYLE_ID;
    style.textContent = `
      body.cast-video-active #gl {
        visibility: hidden !important;
        opacity: 0 !important;
      }
      body.cast-video-active #video-bg {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        z-index: 1 !important;
      }
      body.cast-video-active #video {
        position: fixed !important;
        inset: 0 !important;
        left: 0 !important;
        top: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        visibility: visible !important;
        opacity: 1 !important;
        z-index: 12 !important;
        transform: none !important;
        clip-path: none !important;
        object-fit: contain !important;
        object-position: center center !important;
      }
      body.cast-video-active #app {
        background: transparent !important;
      }
      body.cast-video-fallback #video-bg {
        visibility: visible !important;
        opacity: 1 !important;
        z-index: 13 !important;
      }
    `;
    document.head.appendChild(style);
  }

  const sync = (): void => {
    const visible = mediaElement.classList.contains('visible');
    const missingDecodedFrames = visible
      && !mediaElement.paused
      && mediaElement.currentTime > 0.75
      && video.videoWidth === 0;

    document.body.classList.toggle('cast-video-active', visible);
    document.body.classList.toggle('cast-video-fallback', missingDecodedFrames);

    if (visible) {
      document.documentElement.style.setProperty('background', 'transparent', 'important');
      document.body.style.setProperty('background', 'transparent', 'important');
      canvas?.style.setProperty('visibility', 'hidden', 'important');
      if (!missingDecodedFrames) backdrop?.style.setProperty('visibility', 'hidden', 'important');
      else backdrop?.style.removeProperty('visibility');
    } else {
      document.documentElement.style.removeProperty('background');
      document.body.style.removeProperty('background');
      canvas?.style.removeProperty('visibility');
      backdrop?.style.removeProperty('visibility');
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(mediaElement, { attributes: true, attributeFilter: ['class', 'style'] });
  for (const eventName of ['playing', 'loadeddata', 'loadedmetadata', 'timeupdate', 'emptied', 'pause'] as const) {
    mediaElement.addEventListener(eventName, sync);
  }
  sync();
}

function mediaContentType(url: string): string {
  const path = new URL(url, window.location.href).pathname.toLowerCase();
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.m4v')) return 'video/mp4';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

/**
 * The slideshow historically assigned video.src directly. On Chromecast that leaves the
 * WebView in charge of decoding/compositing; on some devices the audio plays while decoded
 * video frames never reach the panel. Route each source through CAF PlayerManager instead.
 */
function routeVideoSourcesThroughCaf(
  mediaElement: HTMLMediaElement,
  playerManager: CafPlayerManager,
  messages: CafMessages,
): void {
  let lastManagedUrl = '';
  let loading = false;

  const route = (): void => {
    if (loading) return;
    const source = mediaElement.getAttribute('src')?.trim();
    if (!source) {
      lastManagedUrl = '';
      return;
    }
    const absolute = new URL(source, window.location.href).href;
    if (absolute === lastManagedUrl) return;
    lastManagedUrl = absolute;

    mediaElement.pause();
    const media = new messages.MediaInformation();
    media.contentId = absolute;
    media.contentUrl = absolute;
    media.contentType = mediaContentType(absolute);
    media.streamType = 'BUFFERED';
    const request = new messages.LoadRequestData();
    request.media = media;
    request.autoplay = true;
    request.currentTime = Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0;

    loading = true;
    void playerManager.load(request).catch((error: unknown) => {
      console.error('CAF PlayerManager failed to load video; falling back to direct playback.', error);
      void mediaElement.play().catch(() => {});
    }).finally(() => {
      loading = false;
    });
  };

  const observer = new MutationObserver(route);
  observer.observe(mediaElement, { attributes: true, attributeFilter: ['src'] });
  mediaElement.addEventListener('loadstart', route);
  route();
}

/** Start the Cast receiver and let CAF own video playback on Cast hardware. */
export function initCastReceiver(
  mediaElement: HTMLMediaElement,
  forward: (msg: ControlMessage) => void,
): void {
  let attempts = 0;
  const tryStart = (): void => {
    const framework = window.cast?.framework;
    const ctor = framework?.CastReceiverContext;
    const messages = framework?.messages;
    if (!ctor || !messages) {
      if (attempts++ < 20) setTimeout(tryStart, 150);
      return;
    }
    try {
      stabilizeCastVideoLayer(mediaElement);
      const ctx = ctor.getInstance();
      const playerManager = ctx.getPlayerManager();
      routeVideoSourcesThroughCaf(mediaElement, playerManager, messages);
      ctx.addCustomMessageListener(CAST_NAMESPACE, (event) => {
        const msg = parseControl(event.data);
        if (msg) forward(msg);
      });
      ctx.start({
        mediaElement,
        // Intentionally leave MPL/Shaka/native player loading enabled. CAF's managed player
        // is the reliable Cast path; skipPlayersLoad=true was our old audio-black path.
        statusText: 'Ready to display photos and videos',
      });
    } catch (error) {
      console.error('Failed to initialize Cast receiver playback.', error);
    }
  };
  tryStart();
}

/** Validate an untrusted Cast payload into a known {@link ControlMessage}. */
export function parseControl(data: unknown): ControlMessage | null {
  const raw = typeof data === 'string' ? safeParse(data) : data;
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  switch (type) {
    case 'progress':
    case 'next':
    case 'previous':
    case 'pause':
    case 'resume':
      return { type };
    case 'seek': {
      const offsetSec = (raw as { offsetSec?: unknown }).offsetSec;
      return isSeekOffsetSec(offsetSec) ? { type, offsetSec } : null;
    }
    case 'cast': {
      const id = (raw as { id?: unknown }).id;
      return typeof id === 'string' ? { type, id } : null;
    }
    case 'playSequence': {
      const ids = (raw as { ids?: unknown }).ids;
      return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? { type, ids } : null;
    }
    case 'clearQueue':
      return { type };
    case 'config':
    case 'publicConfig': {
      const patch = (raw as { patch?: unknown }).patch;
      if (!patch || typeof patch !== 'object') return null;
      return { type: 'publicConfig', patch } as ControlMessage;
    }
    default:
      return null;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
