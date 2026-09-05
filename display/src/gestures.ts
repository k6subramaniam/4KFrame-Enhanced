/**
 * Touch/pointer gestures on the displayed media.
 *
 * - Double-tap: zoom to 2× around the tap point; double-tap again to reset.
 * - Pinch: continuously zoom around the pinch focal point.
 * - Drag while zoomed: pan the image (updates are rAF-coalesced).
 *
 * Gestures that start on control UI are ignored so buttons/ranges stay native. Single taps
 * are left alone — the shell uses them to reveal its controls.
 */

export interface MediaGestureHandlers {
  getZoom(): number;
  getPan(): { panX: number; panY: number };
  /** Apply an absolute zoom + pan (the caller also clamps to its config limits). */
  setZoomPan(zoom: number, panX: number, panY: number): void;
  resetZoomPan(): void;
}

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 44;
const TAP_SLOP = 12;
const DOUBLE_TAP_ZOOM = 2;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
/** How far a full-screen drag pans, in pan units (-1…1 spans 2). */
const PAN_SENSITIVITY = 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface PointerPoint {
  x: number;
  y: number;
}

interface PinchStart {
  distance: number;
  zoom: number;
  panX: number;
  panY: number;
  centerX: number;
  centerY: number;
}

export function attachMediaGestures(target: HTMLElement, handlers: MediaGestureHandlers): void {
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  const pointers = new Map<number, PointerPoint>();
  let primaryPointer: number | null = null;
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let dragging = false;
  let pinching = false;
  let startPanX = 0;
  let startPanY = 0;
  let pinchStart: PinchStart | null = null;

  let queuedTransform: { zoom: number; panX: number; panY: number } | null = null;
  let rafId = 0;

  const flushTransform = (): void => {
    rafId = 0;
    if (!queuedTransform) return;
    handlers.setZoomPan(queuedTransform.zoom, queuedTransform.panX, queuedTransform.panY);
    queuedTransform = null;
  };

  const queueTransform = (zoom: number, panX: number, panY: number): void => {
    queuedTransform = {
      zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      panX: clamp(panX, -1, 1),
      panY: clamp(panY, -1, 1),
    };
    if (!rafId) rafId = requestAnimationFrame(flushTransform);
  };

  const isControl = (ev: Event): boolean =>
    ev.target instanceof Element
    && ev.target.closest('#public-controls, [data-control], [data-quick-action], button, a, input, select, label') !== null;

  const pointerPair = (): [PointerPoint, PointerPoint] | null => {
    if (pointers.size < 2) return null;
    const pair = [...pointers.values()].slice(0, 2);
    return [pair[0], pair[1]];
  };

  const beginPinch = (): void => {
    const pair = pointerPair();
    if (!pair) return;
    const [a, b] = pair;
    const pan = handlers.getPan();
    pinchStart = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: handlers.getZoom(),
      panX: pan.panX,
      panY: pan.panY,
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
    pinching = true;
    dragging = false;
    lastTapAt = 0;
  };

  target.addEventListener('pointerdown', (ev) => {
    if (isControl(ev)) return;
    try { target.setPointerCapture(ev.pointerId); } catch { /* capture is best-effort */ }
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pointers.size === 1) {
      primaryPointer = ev.pointerId;
      downX = ev.clientX;
      downY = ev.clientY;
      downAt = performance.now();
      dragging = false;
      pinching = false;
      const pan = handlers.getPan();
      startPanX = pan.panX;
      startPanY = pan.panY;
    } else if (pointers.size === 2) {
      primaryPointer = null;
      beginPinch();
    }
  });

  target.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (pointers.size >= 2) {
      if (!pinchStart) beginPinch();
      const pair = pointerPair();
      if (!pair || !pinchStart) return;
      const [a, b] = pair;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const nextZoom = clamp(
        pinchStart.zoom * (distance / pinchStart.distance),
        MIN_ZOOM,
        MAX_ZOOM,
      );

      // Bias pan toward the pinch focal point as magnification grows. The small center
      // translation term also makes a two-finger "pinch and move" feel like direct
      // manipulation rather than zooming around a fixed screen center.
      const startNormX = (pinchStart.centerX / Math.max(1, window.innerWidth)) * 2 - 1;
      const startNormY = (pinchStart.centerY / Math.max(1, window.innerHeight)) * 2 - 1;
      const zoomDelta = nextZoom - pinchStart.zoom;
      const zoomWeight = zoomDelta / Math.max(0.35, nextZoom - MIN_ZOOM + 0.35);
      const centerDx = centerX - pinchStart.centerX;
      const centerDy = centerY - pinchStart.centerY;
      const nextPanX = pinchStart.panX
        + startNormX * zoomWeight
        - (centerDx / Math.max(1, window.innerWidth)) * PAN_SENSITIVITY;
      const nextPanY = pinchStart.panY
        + startNormY * zoomWeight
        - (centerDy / Math.max(1, window.innerHeight)) * PAN_SENSITIVITY;

      queueTransform(nextZoom, nextPanX, nextPanY);
      return;
    }

    if (ev.pointerId !== primaryPointer) return;
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (!dragging && Math.hypot(dx, dy) <= TAP_SLOP) return;
    if (handlers.getZoom() <= 1.01) return;
    dragging = true;
    queueTransform(
      handlers.getZoom(),
      startPanX - (dx / Math.max(1, window.innerWidth)) * PAN_SENSITIVITY,
      startPanY - (dy / Math.max(1, window.innerHeight)) * PAN_SENSITIVITY,
    );
  });

  const end = (ev: PointerEvent): void => {
    if (!pointers.has(ev.pointerId)) return;
    const wasPinching = pinching || pointers.size > 1;
    pointers.delete(ev.pointerId);

    if (rafId) {
      cancelAnimationFrame(rafId);
      flushTransform();
    }

    if (wasPinching) {
      lastTapAt = 0;
      pinchStart = null;
      pinching = false;
      dragging = false;
      const remaining = [...pointers.entries()][0];
      if (remaining) {
        primaryPointer = remaining[0];
        downX = remaining[1].x;
        downY = remaining[1].y;
        downAt = performance.now();
        const pan = handlers.getPan();
        startPanX = pan.panX;
        startPanY = pan.panY;
      } else {
        primaryPointer = null;
      }
      return;
    }

    if (ev.pointerId !== primaryPointer) return;
    primaryPointer = null;

    if (dragging) {
      dragging = false;
      lastTapAt = 0;
      return;
    }
    if (performance.now() - downAt > 400) return;

    const now = performance.now();
    if (
      now - lastTapAt <= DOUBLE_TAP_MS
      && Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY) <= DOUBLE_TAP_DIST
    ) {
      lastTapAt = 0;
      if (handlers.getZoom() > 1.01) {
        handlers.resetZoomPan();
      } else {
        handlers.setZoomPan(
          DOUBLE_TAP_ZOOM,
          clamp((ev.clientX / Math.max(1, window.innerWidth)) * 2 - 1, -1, 1),
          clamp((ev.clientY / Math.max(1, window.innerHeight)) * 2 - 1, -1, 1),
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
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    if (!pointers.size) {
      primaryPointer = null;
      dragging = false;
      pinching = false;
      pinchStart = null;
    } else if (pointers.size === 1) {
      pinchStart = null;
      pinching = false;
      const remaining = [...pointers.entries()][0];
      primaryPointer = remaining[0];
      downX = remaining[1].x;
      downY = remaining[1].y;
      const pan = handlers.getPan();
      startPanX = pan.panX;
      startPanY = pan.panY;
    }
  });
}
