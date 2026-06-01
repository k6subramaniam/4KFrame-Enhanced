/**
 * Google Cast sender integration.
 *
 * When the Cast Sender SDK is present (loaded via the framework script in a Chromium
 * browser), this lets the companion launch and target the 4KFrame Custom Web Receiver.
 * In environments without the SDK it degrades to the web "cast to frame" flow (a direct
 * `/api/cast/:id` call), so casting always works on the LAN.
 *
 * Set your receiver application id (from the Cast SDK Developer Console) here.
 */

export const CAST_APP_ID = (import.meta as { env?: Record<string, string> }).env?.VITE_CAST_APP_ID ?? '';

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: unknown;
    chrome?: { cast?: unknown };
  }
}

let castAvailable = false;

export function initCastSender(): void {
  window.__onGCastApiAvailable = (available: boolean) => {
    castAvailable = available && Boolean(CAST_APP_ID);
  };
}

export function isCastAvailable(): boolean {
  return castAvailable;
}
