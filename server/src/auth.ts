/**
 * Optional admin authentication.
 *
 * Two ways in, either of which enables the auth gate on management API routes:
 *  - Google sign-in: set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and FRAME_ADMIN_EMAILS
 *    (comma-separated allowlist). The admin signs in with their Google account.
 *  - Password fallback: set FRAME_ADMIN_PASSWORD and POST it to /api/login.
 *
 * The display, its WebSocket, media under /photos and a few read-only endpoints stay open
 * so TVs need no login.
 *
 * Stateless: the cookie is `<expiry>.<HMAC(expiry)>`. The HMAC key is derived from
 * FRAME_AUTH_SECRET, else the password (so changing the password invalidates existing
 * sessions), else a random secret generated once and persisted in the store (so
 * Google-only setups survive restarts). No extra dependencies.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAuthSecret, setAuthSecret } from './store.js';

const COOKIE = 'frame_auth';
const STATE_COOKIE = 'frame_oauth_state';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE_S = 60 * 10; // OAuth round-trip window

function password(): string {
  return process.env.FRAME_ADMIN_PASSWORD || '';
}

export function passwordEnabled(): boolean {
  return password().length > 0;
}

/** Google accounts allowed into the admin (comma-separated FRAME_ADMIN_EMAILS). */
export function adminEmails(): string[] {
  return (process.env.FRAME_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function googleLoginEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
    && adminEmails().length > 0;
}

export function isEmailAllowed(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

/** Auth is enforced when a password or Google sign-in is configured. */
export function authRequired(): boolean {
  return passwordEnabled() || googleLoginEnabled();
}

let memorySecret: string | null = null;

function secretMaterial(): string {
  const env = process.env.FRAME_AUTH_SECRET;
  if (env) return env;
  if (passwordEnabled()) return password();
  try {
    const persisted = getAuthSecret();
    if (persisted) return persisted;
    const fresh = randomBytes(32).toString('hex');
    void setAuthSecret(fresh);
    return fresh;
  } catch {
    // Store not initialised (unit tests) — fall back to a per-process secret.
    if (!memorySecret) memorySecret = randomBytes(32).toString('hex');
    return memorySecret;
  }
}

function signingKey(): string {
  return createHmac('sha256', '4kframe-admin-auth').update(secretMaterial()).digest('hex');
}

function sign(data: string): string {
  return createHmac('sha256', signingKey()).update(data).digest('hex');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function issueToken(): string {
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  return `${exp}.${sign(exp)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return equal(sig, sign(exp));
}

export function checkPassword(pw: unknown): boolean {
  return passwordEnabled() && typeof pw === 'string' && equal(pw, password());
}

export function cookieFromHeader(header: string | undefined, name: string = COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function setCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

export function isAuthed(cookieHeader: string | undefined): boolean {
  return !authRequired() || verifyToken(cookieFromHeader(cookieHeader));
}

// --- OAuth state (CSRF protection for the Google sign-in round trip) ---

/** Random nonce + expiry, HMAC-signed like the session token. */
export function issueStateToken(): string {
  const data = `${Date.now() + STATE_MAX_AGE_S * 1000}.${randomBytes(16).toString('hex')}`;
  return `${data}.${sign(data)}`;
}

export function verifyStateToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const data = token.slice(0, dot);
  const exp = Number(data.split('.')[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return equal(token.slice(dot + 1), sign(data));
}

export function stateCookieFromHeader(header: string | undefined): string | undefined {
  return cookieFromHeader(header, STATE_COOKIE);
}

export function setStateCookie(token: string, secure: boolean): string {
  return `${STATE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${STATE_MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}
