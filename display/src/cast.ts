/**
 * Chromecast Custom Web Receiver bootstrap.
 *
 * The display page doubles as a Cast receiver. When loaded inside a Cast context
 * (i.e. the CAF receiver framework is present), this initialises the receiver so a
 * sender app (the companion, Google Photos, etc.) can launch and control it. In a
 * normal browser it is a no-op.
 *
 * To go live, register an application id at the Google Cast SDK Developer Console and
 * point it at the deployed display URL.
 */

declare global {
  interface Window {
    cast?: { framework?: { CastReceiverContext?: { getInstance(): { start(): void } } } };
  }
}

export function initCastReceiver(): void {
  const ctx = window.cast?.framework?.CastReceiverContext;
  if (!ctx) return; // Not running as a Cast receiver.
  try {
    ctx.getInstance().start();
    // Media routing is handled by the sender via custom messages that map to the
    // same WebSocket control protocol used by the admin app.
  } catch {
    /* ignore */
  }
}
