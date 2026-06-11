import type { FrameAspect, MediaItem, PreviewFrameSize } from '@4kframe/shared';
import { FRAME_ASPECTS, aspectRatio, fittedPreviewSize, panFromPixelDrag } from '@4kframe/shared';
import { thumbUrl } from './api.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

export interface CropPreviewConfig {
  fillMode?: string;
  frameAspect?: string;
  zoom?: string | number;
  panX?: string | number;
  panY?: string | number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numeric(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

export type CropPreviewUpdater = (patch: CropPreviewConfig) => void;

export function renderCropPreview(item: MediaItem | undefined, config: CropPreviewConfig): string {
  if (!item) {
    return '<div class="crop-preview-empty muted">Cast or play an item to preview its crop here.</div>';
  }
  const zoom = clamp(numeric(config.zoom, 1), MIN_ZOOM, MAX_ZOOM);
  const panX = clamp(numeric(config.panX, 0), -1, 1);
  const panY = clamp(numeric(config.panY, 0), -1, 1);
  const fillMode = String(config.fillMode ?? 'cover');
  const frameAspect = String(config.frameAspect ?? 'auto');
  const safeAspect = (FRAME_ASPECTS as readonly string[]).includes(frameAspect) ? frameAspect as FrameAspect : 'auto';
  const ratio = aspectRatio(safeAspect) ?? (16 / 9);
  return `<div class="crop-preview" data-crop-preview data-media-width="${item.width}" data-media-height="${item.height}" data-fill-mode="${fillMode}" data-zoom="${zoom}" data-pan-x="${panX}" data-pan-y="${panY}" style="--crop-aspect:${ratio}">
    <div class="crop-preview-frame" data-crop-frame tabindex="0" role="application" aria-label="Crop preview: drag to pan, use mouse wheel or zoom slider to zoom">
      <img class="crop-preview-bg" src="${thumbUrl(item)}" alt="" aria-hidden="true"${fillMode === 'blur' ? '' : ' hidden'} />
      <img class="crop-preview-media" data-crop-media src="${thumbUrl(item)}" alt="Current media crop preview" />
      <div class="crop-preview-mask" aria-hidden="true"></div>
    </div>
    <div class="muted crop-preview-help">Drag to pan · pinch or wheel to zoom · sliders below remain available for keyboard users.</div>
  </div>`;
}

export function wireCropPreview(
  root: HTMLElement,
  updateConfig: (patch: Record<string, string>) => void | Promise<void>,
): CropPreviewUpdater {
  const preview = root.querySelector<HTMLElement>('[data-crop-preview]');
  const frame = root.querySelector<HTMLElement>('[data-crop-frame]');
  const media = root.querySelector<HTMLElement>('[data-crop-media]');
  if (!preview || !frame || !media) return () => {};
  const background = preview.querySelector<HTMLElement>('.crop-preview-bg');

  let zoom = numeric(preview.dataset.zoom, 1);
  let panX = numeric(preview.dataset.panX, 0);
  let panY = numeric(preview.dataset.panY, 0);
  const mediaSize = {
    width: numeric(preview.dataset.mediaWidth, 1),
    height: numeric(preview.dataset.mediaHeight, 1),
  };
  let fillMode = preview.dataset.fillMode ?? 'cover';
  const pointers = new Map<number, PointerEvent>();
  let dragStart: { x: number; y: number; panX: number; panY: number } | null = null;
  let pinchStart: { distance: number; zoom: number } | null = null;

  const frameSize = (): PreviewFrameSize => {
    const rect = frame.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  };

  const applyTransform = (): void => {
    const size = frameSize();
    const fitted = fittedPreviewSize(mediaSize, size, fillMode, zoom);
    const overflowX = Math.max(0, fitted.width - size.width);
    const overflowY = Math.max(0, fitted.height - size.height);
    const x = -(panX * overflowX) / 2;
    const y = -(panY * overflowY) / 2;
    media.style.width = `${fitted.width}px`;
    media.style.height = `${fitted.height}px`;
    media.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  };

  const syncConfig: CropPreviewUpdater = (next) => {
    if (next.zoom !== undefined) zoom = clamp(numeric(next.zoom, 1), MIN_ZOOM, MAX_ZOOM);
    if (next.panX !== undefined) panX = clamp(numeric(next.panX, 0), -1, 1);
    if (next.panY !== undefined) panY = clamp(numeric(next.panY, 0), -1, 1);
    if (next.fillMode !== undefined) fillMode = String(next.fillMode);
    if (next.frameAspect !== undefined) {
      const aspect = String(next.frameAspect);
      const safeAspect = (FRAME_ASPECTS as readonly string[]).includes(aspect) ? aspect as FrameAspect : 'auto';
      frame.style.setProperty('--crop-aspect', String(aspectRatio(safeAspect) ?? (16 / 9)));
      preview.style.setProperty('--crop-aspect', String(aspectRatio(safeAspect) ?? (16 / 9)));
    }
    preview.dataset.fillMode = fillMode;
    preview.dataset.zoom = String(zoom);
    preview.dataset.panX = String(panX);
    preview.dataset.panY = String(panY);
    background?.toggleAttribute('hidden', fillMode !== 'blur');
    applyTransform();
  };

  const patch = async (next: { zoom?: number; panX?: number; panY?: number }): Promise<void> => {
    syncConfig(next);
    await updateConfig(Object.fromEntries(
      Object.entries(next).map(([key, value]) => [key, String(value)]),
    ) as Record<string, string>);
  };

  frame.addEventListener('pointerdown', (event) => {
    frame.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, event);
    if (pointers.size === 1) dragStart = { x: event.clientX, y: event.clientY, panX, panY };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom };
    }
  });

  frame.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      void patch({ zoom: pinchStart.zoom * (distance / Math.max(1, pinchStart.distance)) });
      return;
    }
    if (!dragStart) return;
    const pan = panFromPixelDrag({
      startPanX: dragStart.panX,
      startPanY: dragStart.panY,
      deltaX: event.clientX - dragStart.x,
      deltaY: event.clientY - dragStart.y,
      frame: frameSize(),
      media: mediaSize,
      fillMode,
      zoom,
    });
    void patch(pan);
  });

  const clearPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    dragStart = null;
    pinchStart = null;
  };
  frame.addEventListener('pointerup', clearPointer);
  frame.addEventListener('pointercancel', clearPointer);

  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.06 : 0.94;
    void patch({ zoom: zoom * factor });
  }, { passive: false });

  syncConfig({});
  return syncConfig;
}
