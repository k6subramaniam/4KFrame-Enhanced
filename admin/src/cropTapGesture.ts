export const TAP_MOVEMENT_TOLERANCE_PX = 10;
export const TAP_DURATION_MS = 300;
export const MULTI_TAP_WINDOW_MS = 350;
export const TRIPLE_TAP_ZOOM_STEP = 0.5;

export interface TapSequence {
  zoom: number;
  tapCount: number;
  durationMs: number;
  movementPx: number;
  maxPointerCount: number;
}

export interface TapZoomPatch {
  zoom: number;
  panX?: number;
  panY?: number;
}

/**
 * Resolves a completed touch/pen tap sequence. Triple-tap zooms out by 0.5x;
 * double-tap starts at 2x and subsequent double-taps add 0.5x.
 */
export function calculateTapZoom(
  sequence: TapSequence,
  minZoom: number,
  maxZoom: number,
): TapZoomPatch | null {
  if (
    sequence.durationMs > TAP_DURATION_MS
    || sequence.movementPx > TAP_MOVEMENT_TOLERANCE_PX
    || sequence.maxPointerCount !== 1
  ) {
    return null;
  }

  let nextZoom: number;
  if (sequence.tapCount === 2) {
    nextZoom = sequence.zoom <= minZoom ? 2 : sequence.zoom + 0.5;
  } else if (sequence.tapCount === 3) {
    nextZoom = sequence.zoom - TRIPLE_TAP_ZOOM_STEP;
  } else {
    return null;
  }

  nextZoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
  return nextZoom === minZoom
    ? { zoom: nextZoom, panX: 0, panY: 0 }
    : { zoom: nextZoom };
}
