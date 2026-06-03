/**
 * Slideshow engine.
 *
 * Owns the notion of "what is currently on the frame" and drives automatic
 * progression. Mirrors the original behaviour:
 *  - photos advance after `photoPeriod` seconds (0 = paused),
 *  - when `frameFill` is enabled and the current photo is portrait, a second
 *    portrait photo may be paired to fill a landscape frame only when the
 *    primary photo matches the target frame/content aspect,
 *  - casting shows a specific item immediately (interactive transition).
 *
 * Items excluded from rotation (`enabled === false`) are skipped by automatic
 * progression but can still be cast explicitly. "Hold" pins the current item
 * (looping a video); "pause" stops progression and pauses video.
 *
 * Videos play for their natural duration (or `photoPeriod`, whichever is longer)
 * before advancing.
 */

import { aspectRatio, type MediaItem } from '@4kframe/shared';
import { getConfig, listItems, getItem } from './store.js';
import { hub } from './hub.js';

let pointer = 0;
let current: MediaItem[] = [];
let timer: NodeJS.Timeout | undefined;
let paused = false;
let holding = false;

function mediaAspect(item: MediaItem): number | null {
  return item.width > 0 && item.height > 0 ? item.width / item.height : null;
}

function isPortrait(i: MediaItem): boolean {
  const ratio = mediaAspect(i);
  return ratio !== null && ratio < 1;
}

function targetAspect(): number | null {
  const cfg = getConfig();
  const configuredAspect = aspectRatio(cfg.frameAspect);
  if (configuredAspect !== null) return configuredAspect;
  return cfg.frameWidth > 0 && cfg.frameHeight > 0 ? cfg.frameWidth / cfg.frameHeight : null;
}

/** Items eligible for automatic rotation (excluded items are filtered out). */
function rotation(): MediaItem[] {
  return listItems().filter((i) => i.enabled !== false);
}

/** Choose the item(s) to display at `index` within the rotation. */
function selectAt(index: number): MediaItem[] {
  const items = rotation();
  if (items.length === 0) return [];
  const cfg = getConfig();
  const at = ((index % items.length) + items.length) % items.length;
  const primary = items[at];
  if (!primary) return [];

  // Fill a landscape frame with two portrait photos when possible.
  if (cfg.frameFill && primary.kind === 'photo' && isPortrait(primary)) {
    const primaryAspect = mediaAspect(primary);
    const contentAspect = targetAspect();
    if (primaryAspect === null || contentAspect === null || Math.abs(primaryAspect - contentAspect) > 0.01) {
      return [primary];
    }

    const frameLandscape = cfg.frameWidth >= cfg.frameHeight;
    if (frameLandscape) {
      const partner = items
        .filter((i, idx) => idx !== at && i.kind === 'photo' && isPortrait(i))
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
  if (paused || holding) return; // hold on the current item
  const ms = durationMs(current);
  if (ms <= 0) return; // paused via photoPeriod = 0
  timer = setTimeout(() => advance(1, false), ms);
}

/** Pause/resume automatic progression (manual next/previous still work). */
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

/** Hold/loop the current item: stay on it and loop video. */
export function setHold(value: boolean): void {
  if (holding === value) return;
  holding = value;
  if (holding) {
    if (timer) clearTimeout(timer);
  } else {
    schedule();
  }
  hub.emitEvent({ type: 'hold', holding });
}

export function isPaused(): boolean {
  return paused;
}

export function isHolding(): boolean {
  return holding;
}

function show(interactive: boolean): void {
  hub.emitEvent({ type: 'show', items: current, interactive });
  schedule();
}

/** Advance by `delta` steps within the rotation (e.g. +1 next, -1 previous). */
export function advance(delta: number, interactive: boolean): void {
  const items = rotation();
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
  // Manual navigation also releases a hold so the frame moves on.
  if (holding) setHold(false);
  advance(1, true);
}

export function previous(): void {
  if (holding) setHold(false);
  advance(-1, true);
}

/** Cast a specific item: display it immediately, even if excluded from rotation. */
export async function cast(id: string): Promise<boolean> {
  const item = getItem(id);
  if (!item) return false;
  current = [item];
  const rot = rotation();
  const idx = rot.findIndex((r) => r.id === id);
  if (idx >= 0) pointer = idx; // continue rotation from here when not held
  show(true);
  return true;
}

export function getCurrent(): MediaItem[] {
  return current;
}

/** Initialise the engine and start automatic progression. */
export function startSlideshow(): void {
  pointer = 0;
  current = rotation().length ? selectAt(0) : [];
  if (current.length) show(false);
}

/** Re-evaluate timing after a config or library change. */
export function refresh(): void {
  if (current.length === 0 && rotation().length) {
    startSlideshow();
  } else {
    schedule();
  }
}
