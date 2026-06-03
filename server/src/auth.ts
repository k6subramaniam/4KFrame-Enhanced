/**
 * Optional admin authentication.
 *
 * When FRAME_ADMIN_PASSWORD is set, mutating/management API routes require a valid signed
 * cookie obtained by POSTing the password to /api/login. The display WebSocket uses the
 * same cookie when auth is enabled; the display shell can load for Cast startup, but
 * media under /photos and protected API state require authentication.
 *
 * Stateless: the cookie is `<expiry>.<HMAC(expiry)>` signed with a key derived from the
 * password, so changing the password invalidates existing sessions. No extra dependencies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'frame_auth';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

/** Auth is enforced only when a password is configured. */
function password(): string {
  return process.env.FRAME_ADMIN_PASSWORD || '';
}

export function authRequired(): boolean {
  return password().length > 0;
}

function signingKey(): string {
  return createHmac('sha256', '4kframe-admin-auth').update(password()).digest('hex');
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
  return authRequired() && typeof pw === 'string' && equal(pw, password());
}

export function cookieFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE) return decodeURIComponent(part.slice(idx + 1).trim());
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
