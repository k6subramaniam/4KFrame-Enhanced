/**
 * Media authentication helpers for the display/Chromecast receiver.
 *
 * Native Cast receivers load the public shell without the admin cookie, then receive the
 * signed handoff token as a Cast `auth` control message. Persist that token as the same
 * cookie used by normal admin/login sessions so subsequent <img>/<video> requests for
 * protected `/photos` media carry credentials too.
 */

const AUTH_COOKIE = 'frame_auth';
let receiverAuthToken: string | null = null;

/** Remember a receiver handoff token and make it available to browser media requests. */
export function rememberMediaAuthToken(token: string): void {
  receiverAuthToken = token;
  persistCookie(token);
}

/** Build a protected media URL, with a query-token fallback if cookie persistence failed. */
export function mediaUrl(file: string): string {
  const base = `/photos/${file}`;
  if (!receiverAuthToken || hasReceiverCookie()) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${AUTH_COOKIE}=${encodeURIComponent(receiverAuthToken)}`;
}

function persistCookie(token: string): void {
  const maxAge = tokenMaxAgeSeconds(token);
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function tokenMaxAgeSeconds(token: string): number {
  const dot = token.indexOf('.');
  const expiry = Number(dot >= 0 ? token.slice(0, dot) : NaN);
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
}

function hasReceiverCookie(): boolean {
  return document.cookie.split(';').some((part) => part.trim().startsWith(`${AUTH_COOKIE}=`));
}
