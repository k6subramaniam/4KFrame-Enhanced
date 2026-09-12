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
  start(options?: CafReceiverOptions): void;
}

declare global {
  interface Window {
    cast?: { framework?: { CastReceiverContext?: { getInstance(): CafReceiverContext } } };
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

      // Make the page itself transparent while the hardware-video layer is active. The
      // TV remains black outside the video bounds, but an opaque page can no longer cover
      // a decoder overlay that Chromecast places below Chromium's normal paint layers.
      if (visible) {
        document.documentElement.style.setProperty('background', 'transparent', 'important');
        document.body.style.setProperty('background', 'transparent', 'important');
      } else {
        document.documentElement.style.removeProperty('background');
        document.body.style.removeProperty('background');
      }

      // main.ts has a repaint pump that appends translateZ() to the video. That is useful
      // on desktop Chromium but can force Chromecast's hardware video into a black GPU
      // composition surface. Preserve all 2D positioning/rotation while removing only Z.
      const rawTransform = mediaElement.style.transform || 'none';
      const safeTransform = rawTransform.replace(/\s*translateZ\([^)]*\)/g, '').trim() || 'none';
      if (mediaElement.style.getPropertyValue('--cast-video-transform') !== safeTransform) {
        mediaElement.style.setProperty('--cast-video-transform', safeTransform);
      }

      // These are also set by main.ts; keeping them explicit here makes the Cast-specific
      // layer policy survive config rerenders and video-to-video transitions.
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
    const ctor = window.cast?.framework?.CastReceiverContext;
    if (!ctor) {
      if (attempts++ < 20) setTimeout(tryStart, 150); // ~3s, then give up.
      return;
    }
    try {
      stabilizeCastVideoLayer(mediaElement);
      const ctx = ctor.getInstance();
      ctx.addCustomMessageListener(CAST_NAMESPACE, (event) => {
        const msg = parseControl(event.data);
        if (msg) forward(msg);
      });
      ctx.start({
        mediaElement,
        // Playback is driven directly through the page's HTMLMediaElement; CAF only
        // provides receiver lifecycle and custom-message transport for this app.
        skipPlayersLoad: true,
        statusText: 'Ready to display photos and videos',
      });
    } catch {
      /* ignore — receiver simply stays inactive */
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
