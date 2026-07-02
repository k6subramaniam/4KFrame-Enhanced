/**
 * Touch/pointer gestures on the displayed media.
 *
 * - Double-tap: zoom to 2× centered on the tap point; double-tap again to reset.
 * - Drag while zoomed: pan the image (updates are rAF-coalesced).
 *
 * Gestures that start on control UI (any element inside `[data-control]`) are ignored so
 * buttons stay tappable. Single taps are left alone — the shell uses them to reveal its
 * controls.
 */

export interface MediaGestureHandlers {
  getZoom(): number;
  getPan(): { panX: number; panY: number };
  /** Apply an absolute zoom + pan (values already clamped by the caller's config layer). */
  setZoomPan(zoom: number, panX: number, panY: number): void;
  resetZoomPan(): void;
}

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 44; // px between the two taps
const TAP_SLOP = 12; // px of movement still counting as a tap
const DOUBLE_TAP_ZOOM = 2;
/** How far a full-screen drag pans, in pan units (-1…1 spans 2). */
const PAN_SENSITIVITY = 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function attachMediaGestures(target: HTMLElement, handlers: MediaGestureHandlers): void {
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  let activePointer: number | null = null;
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let dragging = false;
  let startPanX = 0;
  let startPanY = 0;

  let queuedPan: { panX: number; panY: number } | null = null;
  let rafId = 0;

  const flushPan = (): void => {
    rafId = 0;
    if (!queuedPan) return;
    handlers.setZoomPan(handlers.getZoom(), queuedPan.panX, queuedPan.panY);
    queuedPan = null;
  };

  const isControl = (ev: Event): boolean =>
    ev.target instanceof Element
    && ev.target.closest('#public-controls, [data-control], [data-quick-action], button, a, input, select, label') !== null;

  target.addEventListener('pointerdown', (ev) => {
    if (isControl(ev) || activePointer !== null) return;
    activePointer = ev.pointerId;
    downX = ev.clientX;
    downY = ev.clientY;
    downAt = performance.now();
    dragging = false;
    const pan = handlers.getPan();
    startPanX = pan.panX;
    startPanY = pan.panY;
  });

  target.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== activePointer) return;
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (!dragging && Math.hypot(dx, dy) <= TAP_SLOP) return;
    if (handlers.getZoom() <= 1.01) return; // only pan when zoomed in
    dragging = true;
    // Dragging right moves the image right, i.e. reveals content to the left.
    queuedPan = {
      panX: clamp(startPanX - (dx / window.innerWidth) * PAN_SENSITIVITY, -1, 1),
      panY: clamp(startPanY - (dy / window.innerHeight) * PAN_SENSITIVITY, -1, 1),
    };
    if (!rafId) rafId = requestAnimationFrame(flushPan);
  });

  const end = (ev: PointerEvent): void => {
    if (ev.pointerId !== activePointer) return;
    activePointer = null;
    if (dragging) {
      if (rafId) { cancelAnimationFrame(rafId); flushPan(); }
      lastTapAt = 0; // a drag never chains into a double-tap
      return;
    }
    if (performance.now() - downAt > 400) return; // long press, not a tap
    const now = performance.now();
    if (now - lastTapAt <= DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY) <= DOUBLE_TAP_DIST) {
      lastTapAt = 0;
      if (handlers.getZoom() > 1.01) {
        handlers.resetZoomPan();
      } else {
        // Zoom in centered on the tap: map the tap point to pan units (-1…1).
        handlers.setZoomPan(
          DOUBLE_TAP_ZOOM,
          clamp((ev.clientX / window.innerWidth) * 2 - 1, -1, 1),
          clamp((ev.clientY / window.innerHeight) * 2 - 1, -1, 1),
        );
      }
    } else {
      lastTapAt = now;
      lastTapX = ev.clientX;
      lastTapY = ev.clientY;
    }
  };

  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', (ev) => {
    if (ev.pointerId === activePointer) { activePointer = null; dragging = false; }
  });
}
