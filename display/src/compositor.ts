/**
 * Composes the frame contents (one or two photos) onto a 2D canvas at the frame
 * resolution, applying Fill (cover/crop) or Fit (contain/letterbox) scaling and
 * the dual-portrait side-by-side fill behaviour from the original.
 *
 * The resulting canvas is then used as a WebGL texture for transitions.
 */

import type { MediaItem } from '@4kframe/shared';

export interface ComposeOptions {
  frameWidth: number;
  frameHeight: number;
  fill: boolean;
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

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawContain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Compose the given items into a freshly drawn canvas. */
export async function compose(items: MediaItem[], opts: ComposeOptions): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = opts.frameWidth;
  canvas.height = opts.frameHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const photos = items.filter((i) => i.kind === 'photo' || i.poster);
  const imgs = await Promise.all(photos.map((p) => loadImage(imageUrl(p)).catch(() => null)));
  const valid = imgs.filter((i): i is HTMLImageElement => Boolean(i));

  if (valid.length === 0) return canvas;

  if (valid.length >= 2) {
    // Side-by-side dual fill (two portraits filling a landscape frame).
    const half = canvas.width / 2;
    drawCover(ctx, valid[0], 0, 0, half, canvas.height);
    drawCover(ctx, valid[1], half, 0, half, canvas.height);
  } else {
    const draw = opts.fill ? drawCover : drawContain;
    draw(ctx, valid[0], 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}
