/**
 * Ephemeral "Live Cast" slot.
 *
 * Lets the companion app push a freshly-taken photo or short clip straight onto the frame
 * without it becoming part of the library: the bytes are held **only in process memory**,
 * served to displays from `/api/live-cast/:id`, and dropped when the TTL expires (or when
 * a newer push replaces them). Nothing is written to MEDIA_DIR and no MediaItem is created.
 *
 * Honest framing: this avoids persistent storage, but it is not peer-to-peer — the bytes
 * still transit the server's RAM. That is also why the size cap below is deliberately
 * small: a live cast is meant for a photo or a few seconds of video, not a 4K movie.
 *
 * A single active slot matches the rest of the product: every display shows the same
 * content at any moment, so a new push simply replaces the old one (last write wins).
 */

import { randomUUID } from 'node:crypto';
import type { LiveCastInfo, MediaKind } from '@4kframe/shared';
import { hub } from './hub.js';

export const MIN_TTL_SEC = 5;
export const MAX_TTL_SEC = 300;
export const DEFAULT_TTL_SEC = 20;

/** Hard ceiling on a single push, since it is held in memory for the whole TTL. */
export const MAX_LIVE_CAST_BYTES = 60 * 1024 * 1024; // 60 MB

interface LiveCastSlot extends LiveCastInfo {
  bytes: Buffer;
  timer: NodeJS.Timeout;
}

let active: LiveCastSlot | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Drop the active slot (releasing its buffer) and tell displays to resume the slideshow. */
function expire(): void {
  if (!active) return;
  clearTimeout(active.timer);
  active = null;
  hub.emitEvent({ type: 'liveCastEnd' });
}

export interface PushLiveCastInput {
  kind: MediaKind;
  mimeType: string;
  bytes: Buffer;
  ttlSec?: number;
}

/**
 * Replace the active live cast. Returns the public info to broadcast; the caller emits the
 * `liveCast` event so this stays a pure store operation.
 */
export function pushLiveCast(input: PushLiveCastInput): LiveCastInfo {
  // Clear the previous timer first so it can't expire the *new* slot early.
  if (active) clearTimeout(active.timer);

  const ttlMs = clamp(input.ttlSec ?? DEFAULT_TTL_SEC, MIN_TTL_SEC, MAX_TTL_SEC) * 1000;
  const info: LiveCastInfo = {
    id: randomUUID(),
    kind: input.kind,
    mimeType: input.mimeType,
    expiresAt: Date.now() + ttlMs,
  };
  active = { ...info, bytes: input.bytes, timer: setTimeout(expire, ttlMs) };
  return info;
}

/** Stop the active live cast early. Returns whether anything was actually stopped. */
export function stopLiveCast(): boolean {
  if (!active) return false;
  expire();
  return true;
}

/** Public metadata for the active cast — never exposes the buffer. */
export function getActiveLiveCast(): LiveCastInfo | null {
  if (!active) return null;
  const { id, kind, mimeType, expiresAt } = active;
  return { id, kind, mimeType, expiresAt };
}

/** Bytes for a live cast id, or null if it isn't the active one (replaced or expired). */
export function readActiveLiveCastBytes(id: string): { bytes: Buffer; mimeType: string } | null {
  if (!active || active.id !== id) return null;
  return { bytes: active.bytes, mimeType: active.mimeType };
}

/** Test hook: drop any active cast without broadcasting. */
export function resetLiveCastForTests(): void {
  if (active) clearTimeout(active.timer);
  active = null;
}
