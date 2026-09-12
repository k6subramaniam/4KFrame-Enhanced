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

interface CafCustomEvent {
  data: unknown;
}
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
 * Chromecast's WebView and hardware decoder do not always agree on normal DOM compositing.
 * In particular, an opaque canvas/backdrop or a 3D transform on the HTMLVideoElement can
 * result in perfectly audible playback whose decoded frames never reach the screen.
 *
 * Keep this workaround Cast-only so ordinary browser displays retain the richer blur
 * backdrop. The still-frame fallback remains available when videoWidth stays at zero.
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
        visibility: visible !important;
        opacity: 1 !important;
        z-index: 12 !important;
        transform: var(--cast-video-transform, none) !important;
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

  let syncing = false;
  const sync = (): void => {
    if (syncing) return;
    syncing = true;
    try {
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
      } else {
        document.documentElement.style.removeProperty('background');
        document.body.style.removeProperty('background');
      }

      const rawTransform = mediaElement.style.transform || 'none';
      const safeTransform = rawTransform.replace(/\s*translateZ\([^)]*\)/g, '').trim() || 'none';
      if (mediaElement.style.getPropertyValue('--cast-video-transform') !== safeTransform) {
        mediaElement.style.setProperty('--cast-video-transform', safeTransform);
      }

      if (visible) {
        canvas?.style.setProperty('visibility', 'hidden', 'important');
        if (!missingDecodedFrames) backdrop?.style.setProperty('visibility', 'hidden', 'important');
        else backdrop?.style.removeProperty('visibility');
      } else {
        canvas?.style.removeProperty('visibility');
        backdrop?.style.removeProperty('visibility');
      }
    } finally {
      syncing = false;
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
 * CAF then owns the media session and its MPL/Shaka/native playback pipeline.
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

    // main.ts has already selected this clip. Stop the direct HTMLMediaElement path before
    // it can settle into the broken audio-only WebView compositor, then reload via CAF.
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
      // If CAF itself refuses the item, leave the original source in place and let the
      // display's existing retry/skip path handle it rather than freezing the slideshow.
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

/**
 * Start the Cast receiver, bridging custom messages to `forward`. Because the CAF script
 * may still be loading when the app boots, we retry briefly before giving up (a no-op on
 * non-Cast displays, which never load the SDK).
 */
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
      if (attempts++ < 20) setTimeout(tryStart, 150); // ~3s, then give up.
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
        // Do NOT set skipPlayersLoad here. CAF's managed MPL/Shaka/native playback path is
        // required on Cast devices; disabling it is what left our HTML video compositor in
        // charge and produced audio with a black picture on affected TVs.
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
