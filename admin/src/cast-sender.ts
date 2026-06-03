/**
 * Google Cast sender integration.
 *
 * When the Cast Sender SDK is present (loaded via the framework script in a Chromium
 * browser) and a receiver application id is configured (`VITE_CAST_APP_ID`), this launches
 * the 4KFrame Custom Web Receiver on a chosen TV and pushes {@link ControlMessage}s to it
 * over {@link CAST_NAMESPACE} — the same control protocol the admin uses over WebSocket.
 *
 * Where Cast is unavailable, callers fall back to the LAN web "cast to frame" flow
 * (a direct `/api/cast/:id` call), so casting always works on the local network.
 */

import { CAST_NAMESPACE, type ControlMessage } from '@4kframe/shared';
import { castAuthToken } from './api.js';

export const CAST_APP_ID = (import.meta as { env?: Record<string, string> }).env?.VITE_CAST_APP_ID ?? '';

// Minimal ambient declarations for the parts of the Cast Sender SDK we use.
interface CastSession {
  sendMessage(namespace: string, message: unknown): Promise<unknown>;
  endSession(stopCasting: boolean): void;
}
interface CastContext {
  setOptions(options: { receiverApplicationId: string; autoJoinPolicy: string }): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSession | null;
  addEventListener(type: string, handler: (event: { sessionState: string }) => void): void;
}

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: {
      framework?: {
        CastContext: { getInstance(): CastContext };
        CastContextEventType: { SESSION_STATE_CHANGED: string };
        SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string };
      };
    };
    chrome?: { cast?: { AutoJoinPolicy: { ORIGIN_SCOPED: string } } };
  }
}

let context: CastContext | null = null;
let connected = false;
let onChange: ((connected: boolean) => void) | undefined;
let authToken: string | null | undefined;

/**
 * Wire up the Cast sender. `onStateChange(connected)` fires when the SDK becomes ready
 * (with `false`) and on every subsequent session start/stop, so the UI can reveal and
 * update a "Cast device" control.
 */
export function initCastSender(onStateChange?: (connected: boolean) => void): void {
  onChange = onStateChange;
  window.__onGCastApiAvailable = (available: boolean) => {
    if (available) initContext();
  };
  // The SDK may have finished loading before this ran; initialise immediately if so.
  if (window.cast?.framework?.CastContext) initContext();
}

function initContext(): void {
  if (context) return;
  const fw = window.cast?.framework;
  const chromeCast = window.chrome?.cast;
  if (!fw || !chromeCast || !CAST_APP_ID) return;

  context = fw.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: CAST_APP_ID,
    autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  context.addEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    connected =
      event.sessionState === fw.SessionState.SESSION_STARTED ||
      event.sessionState === fw.SessionState.SESSION_RESUMED;
    onChange?.(connected);
  });
  // Signal readiness so the UI can reveal the (idle) Cast control.
  onChange?.(false);
}

/** True once the Cast Sender SDK is initialised (a receiver app id is configured). */
export function isCastReady(): boolean {
  return context !== null;
}

/** True when an active Cast session to the frame receiver exists. */
export function isCastConnected(): boolean {
  return connected;
}

/** Open the device picker to start a Cast session, or stop the current one. */
export async function toggleCastSession(): Promise<void> {
  if (!context) return;
  const session = context.getCurrentSession();
  if (session) {
    session.endSession(true);
    return;
  }
  try {
    await context.requestSession();
  } catch {
    /* user dismissed the picker */
  }
}

/**
 * Send a control message to the receiver over the custom namespace.
 * Returns `false` when no Cast session is active, so callers can fall back to REST.
 */
export async function castControl(msg: ControlMessage): Promise<boolean> {
  const session = context?.getCurrentSession();
  if (!session) return false;
  try {
    authToken ??= await castAuthToken().catch(() => null);
    if (authToken) await session.sendMessage(CAST_NAMESPACE, { type: 'auth', token: authToken });
    await session.sendMessage(CAST_NAMESPACE, msg);
    return true;
  } catch {
    return false;
  }
}
