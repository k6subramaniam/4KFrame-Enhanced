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

import { CAST_NAMESPACE, type ControlMessage } from '@4kframe/shared';

interface CafCustomEvent {
  data: unknown;
}
interface CafReceiverContext {
  addCustomMessageListener(namespace: string, listener: (event: CafCustomEvent) => void): void;
  start(options?: unknown): void;
}

declare global {
  interface Window {
    cast?: { framework?: { CastReceiverContext?: { getInstance(): CafReceiverContext } } };
  }
}

/**
 * Start the Cast receiver, bridging custom messages to `forward`. Because the CAF script
 * may still be loading when the app boots, we retry briefly before giving up (a no-op on
 * non-Cast displays, which never load the SDK).
 */
export function initCastReceiver(forward: (msg: ControlMessage) => void): void {
  let attempts = 0;
  const tryStart = (): void => {
    const ctor = window.cast?.framework?.CastReceiverContext;
    if (!ctor) {
      if (attempts++ < 20) setTimeout(tryStart, 150); // ~3s, then give up.
      return;
    }
    try {
      const ctx = ctor.getInstance();
      ctx.addCustomMessageListener(CAST_NAMESPACE, (event) => {
        const msg = parseControl(event.data);
        if (msg) forward(msg);
      });
      ctx.start();
    } catch {
      /* ignore — receiver simply stays inactive */
    }
  };
  tryStart();
}

/** Validate an untrusted Cast payload into a known {@link ControlMessage}. */
function parseControl(data: unknown): ControlMessage | null {
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
