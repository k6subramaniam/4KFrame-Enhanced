/**
 * Composes the frame contents onto a 2D canvas sized to the **actual display screen**, so
 * the same library renders correctly on any aspect ratio (16:9, ultrawide, 4:3, square,
 * portrait). The composed canvas matches the screen aspect exactly, so the WebGL pass that
 * uses it as a texture never distorts.
 *
 * Within the screen it lays out a "content rect":
 *   - aspect 'auto'  -> the whole screen.
 *   - a forced aspect -> a centered rectangle of that aspect (the rest is filled black, or
 *     a blurred copy in blur mode).
 *
 * Fill modes inside the content rect:
 *   - cover   -> scale to fill, cropping overflow (default).
 *   - contain -> fit with letterbox/pillarbox bars.
 *   - blur    -> contain the sharp image over a blurred, zoomed copy of it (no bars, nothing
 *                cropped) — the premium digital-frame look.
 */

import { aspectRatio, faceCenterToPan, type FillMode, type FrameAspect, type FrameConfig, type MediaItem } from '@4kframe/shared';

export type FramingConfig = Pick<FrameConfig, 'fillMode' | 'frameAspect' | 'zoom' | 'panX' | 'panY' | 'smartFraming'>;

export function itemFramingConfig(globalConfig: FramingConfig, item: MediaItem | undefined): FramingConfig {
  return {
    ...globalConfig,
    ...(item?.framing ?? {}),
  };
}

export interface ComposeOptions {
  /** Screen size in device pixels. */
  screenWidth: number;
  screenHeight: number;
  fillMode: FillMode;
  aspect: FrameAspect;
  /** Manual zoom factor (1 = none). */
  zoom: number;
  /** Manual pan -1..1 (0 = centered), applied within any overflow. */
  panX: number;
  panY: number;
  /** Bias crops toward detected face boxes unless manual pan/zoom is active. */
  smartFraming: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const cache = new Map<string, HTMLImageElement>();

export function imageUrl(item: MediaItem): string {
  return `/photos/${item.poster ?? item.file}`;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = cache.get(url);
  if (cached?.complete) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { cache.set(url, img); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

/** Centered rectangle of the given aspect within the screen; whole screen when `auto`. */
export function contentRect(screenW: number, screenH: number, aspect: FrameAspect): Rect {
  const ratio = aspectRatio(aspect);
  if (!ratio) return { x: 0, y: 0, w: screenW, h: screenH };
  let w = screenW;
  let h = screenW / ratio;
  if (h > screenH) {
    h = screenH;
    w = screenH * ratio;
  }
  return { x: (screenW - w) / 2, y: (screenH - h) / 2, w, h };
}

/** Image transform within a rect: base fit (cover/contain/stretch) × zoom, with pan. */
interface Transform {
  fit: 'cover' | 'contain' | 'stretch';
  zoom: number;
  panX: number;
  panY: number;
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Rect): void {
  drawTransformed(ctx, img, r, { fit: 'cover', zoom: 1, panX: 0, panY: 0 });
}

function fittedSize(img: HTMLImageElement, r: Rect, t: Pick<Transform, 'fit' | 'zoom'>): { w: number; h: number } {
  if (t.fit === 'stretch') return { w: r.w * t.zoom, h: r.h * t.zoom };
  const base = t.fit === 'cover'
    ? Math.max(r.w / img.width, r.h / img.height)
    : Math.min(r.w / img.width, r.h / img.height);
  const scale = base * t.zoom;
  return { w: img.width * scale, h: img.height * scale };
}

function smartTransform(item: MediaItem, img: HTMLImageElement, r: Rect, t: Transform, enabled: boolean): Transform {
  const hasManualOverride = Math.abs(t.panX) > 0.001 || Math.abs(t.panY) > 0.001 || t.zoom > 1.001;
  if (!enabled || hasManualOverride || !item.faces?.length) return t;

  const fitted = fittedSize(img, r, t);
  const smart = faceCenterToPan({
    item,
    frameWidth: r.w,
    frameHeight: r.h,
    fittedWidth: fitted.w,
    fittedHeight: fitted.h,
  });
  return { ...t, panX: smart.panX, panY: smart.panY };
}

/**
 * Draw `img` into rect `r` applying fit + zoom + pan, clipped to the rect.
 * Pan moves the image within whatever overflows the rect (no effect when it fits exactly).
 */
function drawTransformed(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Rect, t: Transform): void {
  const fitted = fittedSize(img, r, t);
  const dw = fitted.w;
  const dh = fitted.h;
  const overflowX = Math.max(0, dw - r.w);
  const overflowY = Math.max(0, dh - r.h);
  const dx = r.x + (r.w - dw) / 2 - (t.panX * overflowX) / 2;
  const dy = r.y + (r.h - dh) / 2 - (t.panY * overflowY) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/** Fill the whole canvas with a blurred, screen-covering copy of the image. */
function drawBlurredBackground(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number): void {
  const radius = Math.max(8, Math.round(Math.max(w, h) / 40));
  ctx.save();
  ctx.filter = `blur(${radius}px)`;
  // Overscan so the blur doesn't reveal transparent edges.
  drawCover(ctx, img, { x: -radius * 2, y: -radius * 2, w: w + radius * 4, h: h + radius * 4 });
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, w, h);
}

/** Split a rect into two along its longer axis (orientation-aware dual layout). */
function splitRect(r: Rect): [Rect, Rect] {
  if (r.w >= r.h) {
    const half = r.w / 2;
    return [{ ...r, w: half }, { x: r.x + half, y: r.y, w: half, h: r.h }];
  }
  const half = r.h / 2;
  return [{ ...r, h: half }, { x: r.x, y: r.y + half, w: r.w, h: half }];
}

/** Compose the given items into a freshly drawn, screen-sized canvas. */
export async function compose(items: MediaItem[], opts: ComposeOptions): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(opts.screenWidth));
  canvas.height = Math.max(1, Math.round(opts.screenHeight));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const photos = items.filter((i) => i.kind === 'photo' || i.poster);
  const imgs = await Promise.all(photos.map((p) => loadImage(imageUrl(p)).catch(() => null)));
  const valid = imgs
    .map((img, i) => (img ? { img, item: photos[i] } : null))
    .filter((pair): pair is { img: HTMLImageElement; item: MediaItem } => Boolean(pair));
  if (valid.length === 0) return canvas;

  // Blurred-fill: a blurred copy of the primary image covers the entire screen first.
  if (opts.fillMode === 'blur') drawBlurredBackground(ctx, valid[0].img, canvas.width, canvas.height);

  const rect = contentRect(canvas.width, canvas.height, opts.aspect);

  if (valid.length >= 2) {
    // Dual layout: split the content rect along its longer axis (side-by-side or stacked).
    const [a, b] = splitRect(rect);
    const first = itemFramingConfig({ fillMode: opts.fillMode, frameAspect: opts.aspect, zoom: opts.zoom, panX: opts.panX, panY: opts.panY, smartFraming: opts.smartFraming }, valid[0].item);
    const second = itemFramingConfig({ fillMode: opts.fillMode, frameAspect: opts.aspect, zoom: opts.zoom, panX: opts.panX, panY: opts.panY, smartFraming: opts.smartFraming }, valid[1].item);
    drawTransformed(ctx, valid[0].img, a, smartTransform(valid[0].item, valid[0].img, a, { fit: 'cover', zoom: first.zoom, panX: first.panX, panY: first.panY }, first.smartFraming));
    drawTransformed(ctx, valid[1].img, b, smartTransform(valid[1].item, valid[1].img, b, { fit: 'cover', zoom: second.zoom, panX: second.panX, panY: second.panY }, second.smartFraming));
  } else {
    // blur shows the sharp image "contained" over the blurred background; others use their mode.
    const itemConfig = itemFramingConfig({ fillMode: opts.fillMode, frameAspect: opts.aspect, zoom: opts.zoom, panX: opts.panX, panY: opts.panY, smartFraming: opts.smartFraming }, valid[0].item);
    const itemRect = contentRect(canvas.width, canvas.height, itemConfig.frameAspect);
    const fit = itemConfig.fillMode === 'blur' ? 'contain' : itemConfig.fillMode;
    if (itemConfig.fillMode === 'blur' && opts.fillMode !== 'blur') drawBlurredBackground(ctx, valid[0].img, canvas.width, canvas.height);
    const transform = smartTransform(valid[0].item, valid[0].img, itemRect, { fit, zoom: itemConfig.zoom, panX: itemConfig.panX, panY: itemConfig.panY }, itemConfig.smartFraming);
    drawTransformed(ctx, valid[0].img, itemRect, transform);
  }
  return canvas;
}
