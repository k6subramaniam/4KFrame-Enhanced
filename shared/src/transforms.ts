import type { FaceBox } from './api.js';

export const QUARTER_TURNS = [0, 90, 180, 270] as const;
export type QuarterTurn = (typeof QUARTER_TURNS)[number];

export interface DisplayTransform {
  rotation: QuarterTurn;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export const IDENTITY_TRANSFORM: DisplayTransform = {
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
};

export function isQuarterTurn(value: unknown): value is QuarterTurn {
  return typeof value === 'number' && QUARTER_TURNS.includes(value as QuarterTurn);
}

export function normalizeTransform(value: Partial<DisplayTransform> | null | undefined): DisplayTransform {
  return {
    rotation: isQuarterTurn(value?.rotation) ? value.rotation : 0,
    flipHorizontal: value?.flipHorizontal === true,
    flipVertical: value?.flipVertical === true,
  };
}

export function orientedDimensions(width: number, height: number, rotation: QuarterTurn): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

/** Apply flips first, then clockwise rotation, in normalized 0..1 coordinates. */
export function transformPoint(
  point: { x: number; y: number },
  transform: DisplayTransform,
): { x: number; y: number } {
  let x = transform.flipHorizontal ? 1 - point.x : point.x;
  let y = transform.flipVertical ? 1 - point.y : point.y;
  switch (transform.rotation) {
    case 90: [x, y] = [1 - y, x]; break;
    case 180: [x, y] = [1 - x, 1 - y]; break;
    case 270: [x, y] = [y, 1 - x]; break;
  }
  return { x, y };
}

export function transformBox(box: FaceBox, transform: DisplayTransform): FaceBox {
  const corners = [
    transformPoint({ x: box.x, y: box.y }, transform),
    transformPoint({ x: box.x + box.width, y: box.y }, transform),
    transformPoint({ x: box.x, y: box.y + box.height }, transform),
    transformPoint({ x: box.x + box.width, y: box.y + box.height }, transform),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
