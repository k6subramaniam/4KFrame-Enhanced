import type { FaceBox, MediaItem } from './api.js';

export interface SmartFramingInput {
  item: Pick<MediaItem, 'width' | 'height' | 'faces'>;
  /** Destination frame width in pixels. */
  frameWidth: number;
  /** Destination frame height in pixels. */
  frameHeight: number;
  /** Fitted media width after cover/contain/stretch and zoom. */
  fittedWidth: number;
  /** Fitted media height after cover/contain/stretch and zoom. */
  fittedHeight: number;
}

export interface SmartFramingPan {
  panX: number;
  panY: number;
}

interface NormalizedFaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Normalise a face box to 0..1 image coordinates. Metadata produced by detectors is often
 * either already normalised or expressed in source pixels; supporting both makes smart framing
 * resilient across ingest implementations.
 */
function normalizeFaceBox(face: FaceBox, itemWidth: number, itemHeight: number): NormalizedFaceBox | null {
  if (![face.x, face.y, face.width, face.height, itemWidth, itemHeight].every(Number.isFinite)) return null;
  if (face.width <= 0 || face.height <= 0 || itemWidth <= 0 || itemHeight <= 0) return null;

  const pixelSpace = face.x > 1 || face.y > 1 || face.width > 1 || face.height > 1;
  const x = pixelSpace ? face.x / itemWidth : face.x;
  const y = pixelSpace ? face.y / itemHeight : face.y;
  const width = pixelSpace ? face.width / itemWidth : face.width;
  const height = pixelSpace ? face.height / itemHeight : face.height;

  const left = clamp(x, 0, 1);
  const top = clamp(y, 0, 1);
  const right = clamp(x + width, 0, 1);
  const bottom = clamp(y + height, 0, 1);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Return the normalized center of the union of all usable face boxes on an item. */
export function faceUnionCenter(item: Pick<MediaItem, 'width' | 'height' | 'faces'>): { x: number; y: number } | null {
  const boxes = (item.faces ?? [])
    .map((face) => normalizeFaceBox(face, item.width, item.height))
    .filter((face): face is NormalizedFaceBox => Boolean(face));
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((face) => face.x));
  const top = Math.min(...boxes.map((face) => face.y));
  const right = Math.max(...boxes.map((face) => face.x + face.width));
  const bottom = Math.max(...boxes.map((face) => face.y + face.height));

  return {
    x: clamp((left + right) / 2, 0, 1),
    y: clamp((top + bottom) / 2, 0, 1),
  };
}

/**
 * Convert the face-union center into existing -1..1 pan coordinates. The result only moves
 * along axes where the fitted media overflows the frame and is clamped so the frame remains
 * fully covered with no exposed background.
 */
export function faceCenterToPan(input: SmartFramingInput): SmartFramingPan {
  const center = faceUnionCenter(input.item);
  if (!center) return { panX: 0, panY: 0 };

  const overflowX = Math.max(0, input.fittedWidth - input.frameWidth);
  const overflowY = Math.max(0, input.fittedHeight - input.frameHeight);

  return {
    panX: overflowX > 0 ? clamp(((center.x - 0.5) * 2 * input.fittedWidth) / overflowX, -1, 1) : 0,
    panY: overflowY > 0 ? clamp(((center.y - 0.5) * 2 * input.fittedHeight) / overflowY, -1, 1) : 0,
  };
}
