/**
 * Slideshow engine.
 *
 * Owns the notion of "what is currently on the frame" and drives automatic
 * progression. Mirrors the original behaviour:
 *  - photos advance after `photoPeriod` seconds (0 = paused),
 *  - when `frameFill` is enabled and the current photo is portrait, a second
 *    portrait photo may be paired to fill a landscape frame,
 *  - casting promotes an item and shows it immediately (interactive transition).
 *
 * Videos play for their natural duration (or `photoPeriod`, whichever is longer)
 * before advancing.
 */

import type { MediaItem } from '@4kframe/shared';
import { getConfig, listItems, promoteItem } from './store.js';
import { hub } from './hub.js';

let pointer = 0;
let current: MediaItem[] = [];
let timer: NodeJS.Timeout | undefined;
let paused = false;

function isPortrait(i: MediaItem): boolean {
  return i.height > i.width && i.width > 0;
}

/** Choose the item(s) to display starting at `index` in the play order. */
function selectAt(index: number): MediaItem[] {
  const items = listItems();
  if (items.length === 0) return [];
  const cfg = getConfig();
  const primary = items[index % items.length];
  if (!primary) return [];

  // Fill a landscape frame with two portrait photos when possible.
  if (cfg.frameFill && primary.kind === 'photo' && isPortrait(primary)) {
    const frameLandscape = cfg.frameWidth >= cfg.frameHeight;
    if (frameLandscape) {
      const partner = items
        .filter((i, idx) => idx !== index % items.length && i.kind === 'photo' && isPortrait(i))
        .at(0);
      if (partner) return [primary, partner];
    }
  }
  return [primary];
}

function durationMs(items: MediaItem[]): number {
  const cfg = getConfig();
  if (cfg.photoPeriod <= 0) return 0; // paused
  const base = cfg.photoPeriod * 1000;
  const video = items.find((i) => i.kind === 'video');
  if (video?.durationSec) return Math.max(base, video.durationSec * 1000);
  return base;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (paused) return; // hold on the current item until resumed
  const ms = durationMs(current);
  if (ms <= 0) return; // paused via photoPeriod = 0
  timer = setTimeout(() => advance(1, false), ms);
}

/** Pause/resume automatic progression (e.g. from the TV remote). Manual next/previous still work. */
export function setPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  if (paused) {
    if (timer) clearTimeout(timer);
  } else {
    schedule();
  }
  hub.emitEvent({ type: 'paused', paused });
}

function show(interactive: boolean): void {
  hub.emitEvent({ type: 'show', items: current, interactive });
  schedule();
}

/** Advance by `delta` steps (e.g. +1 next, -1 previous). */
export function advance(delta: number, interactive: boolean): void {
  const items = listItems();
  if (items.length === 0) {
    current = [];
    return;
  }
  pointer = (pointer + delta + items.length) % items.length;
  current = selectAt(pointer);
  show(interactive);
}

/** Re-show the current item(s) (used by `/api/progress`). */
export function progress(): void {
  advance(1, false);
}

export function next(): void {
  advance(1, true);
}

export function previous(): void {
  advance(-1, true);
}

/** Cast a specific item: promote it and display immediately. */
export async function cast(id: string): Promise<boolean> {
  const items = listItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  await promoteItem(id);
  pointer = 0; // promoted item is now first
  current = selectAt(0);
  show(true);
  return true;
}

export function getCurrent(): MediaItem[] {
  return current;
}

/** Initialise the engine and start automatic progression. */
export function startSlideshow(): void {
  const items = listItems();
  pointer = 0;
  current = items.length ? selectAt(0) : [];
  if (current.length) show(false);
}

/** Re-evaluate timing after a config or library change. */
export function refresh(): void {
  const items = listItems();
  if (current.length === 0 && items.length) {
    startSlideshow();
  } else {
    schedule();
  }
}
