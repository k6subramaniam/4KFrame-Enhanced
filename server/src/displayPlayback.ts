import type { DisplayPlaybackState } from '@4kframe/shared';

const MAX_REPORT_AGE_MS = 5_000;

let latest: DisplayPlaybackState | null = null;
let reporter: object | null = null;

export function reportDisplayPlayback(
  source: object,
  state: Omit<DisplayPlaybackState, 'observedAt'>,
  now = Date.now(),
): void {
  latest = { ...state, observedAt: now };
  reporter = source;
}

export function clearDisplayPlayback(source?: object): void {
  if (source && reporter !== source) return;
  latest = null;
  reporter = null;
}

export function getDisplayPlayback(itemId: string | null, now = Date.now()): DisplayPlaybackState | null {
  if (!itemId || !latest || latest.itemId !== itemId || now - latest.observedAt > MAX_REPORT_AGE_MS) return null;
  return latest;
}
