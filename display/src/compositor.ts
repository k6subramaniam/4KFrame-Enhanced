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

import { aspectRatio, type FillMode, type FrameAspect, type MediaItem } from '@4kframe/shared';

export interface ComposeOptions {
  /** Screen size in device pixels. */
  screenWidth: number;
  screenHeight: number;
  fillMode: FillMode;
  aspect: FrameAspect;
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

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Rect): void {
  const scale = Math.max(r.w / img.width, r.h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawContain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: Rect): void {
  const scale = Math.min(r.w / img.width, r.h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
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
  const valid = imgs.filter((i): i is HTMLImageElement => Boolean(i));
  if (valid.length === 0) return canvas;

  // Blurred-fill: a blurred copy of the primary image covers the entire screen first.
  if (opts.fillMode === 'blur') drawBlurredBackground(ctx, valid[0], canvas.width, canvas.height);

  const rect = contentRect(canvas.width, canvas.height, opts.aspect);

  if (valid.length >= 2) {
    // Dual layout: split the content rect along its longer axis (side-by-side or stacked).
    const [a, b] = splitRect(rect);
    drawCover(ctx, valid[0], a);
    drawCover(ctx, valid[1], b);
  } else if (opts.fillMode === 'cover') {
    drawCover(ctx, valid[0], rect);
  } else {
    drawContain(ctx, valid[0], rect);
  }
  return canvas;
}
