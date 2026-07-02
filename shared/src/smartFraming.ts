import type { FaceBox, FaceMetadata, FocusRegion, MediaItem } from './api.js';
import { normalizeTransform, transformPoint } from './transforms.js';

export interface SmartFramingInput {
  item: Pick<MediaItem, 'width' | 'height' | 'faces' | 'focusRegions' | 'rotation' | 'flipHorizontal' | 'flipVertical'>;
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

interface NormalizedFocusBox {
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  confidence: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const focusSourcePriority: Record<FocusRegion['source'], number> = {
  manual: 4,
  face: 3,
  object: 2,
  saliency: 1,
};

/**
 * Normalize a box to 0..1 image coordinates. Metadata produced by detectors is often
 * either already normalized or expressed in source pixels; supporting both makes smart
 * framing resilient across ingest implementations.
 */
function normalizeBox(box: FaceBox, itemWidth: number, itemHeight: number): Omit<NormalizedFocusBox, 'priority' | 'confidence'> | null {
  if (![box.x, box.y, box.width, box.height, itemWidth, itemHeight].every(Number.isFinite)) return null;
  if (box.width <= 0 || box.height <= 0 || itemWidth <= 0 || itemHeight <= 0) return null;

  const pixelSpace = box.x > 1 || box.y > 1 || box.width > 1 || box.height > 1;
  const x = pixelSpace ? box.x / itemWidth : box.x;
  const y = pixelSpace ? box.y / itemHeight : box.y;
  const width = pixelSpace ? box.width / itemWidth : box.width;
  const height = pixelSpace ? box.height / itemHeight : box.height;

  const left = clamp(x, 0, 1);
  const top = clamp(y, 0, 1);
  const right = clamp(x + width, 0, 1);
  const bottom = clamp(y + height, 0, 1);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeFocusRegion(region: FocusRegion, itemWidth: number, itemHeight: number): NormalizedFocusBox | null {
  const box = normalizeBox(region.box, itemWidth, itemHeight);
  if (!box) return null;
  const priority = focusSourcePriority[region.source];
  if (priority === undefined) return null;
  const confidence = Number.isFinite(region.confidence) ? clamp(region.confidence ?? 1, 0, 1) : 1;
  return { ...box, priority, confidence };
}

function normalizeFaceMetadata(face: FaceMetadata, itemWidth: number, itemHeight: number): NormalizedFocusBox | null {
  const box = normalizeBox(face.box, itemWidth, itemHeight);
  return box ? { ...box, priority: focusSourcePriority.face, confidence: 1 } : null;
}

function unionCenter(boxes: NormalizedFocusBox[]): { x: number; y: number } | null {
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    x: clamp((left + right) / 2, 0, 1),
    y: clamp((top + bottom) / 2, 0, 1),
  };
}

function prioritizedFocusBoxes(item: Pick<MediaItem, 'width' | 'height' | 'focusRegions'>): NormalizedFocusBox[] {
  const boxes = (item.focusRegions ?? [])
    .map((region) => normalizeFocusRegion(region, item.width, item.height))
    .filter((region): region is NormalizedFocusBox => Boolean(region));
  if (boxes.length === 0) return [];

  const bestPriority = Math.max(...boxes.map((box) => box.priority));
  const priorityMatches = boxes.filter((box) => box.priority === bestPriority);
  const bestConfidence = Math.max(...priorityMatches.map((box) => box.confidence));

  // Keep similarly confident regions of the highest-priority source so group subjects frame together,
  // while low-confidence outliers do not pull the crop away from the intended subject.
  return priorityMatches.filter((box) => box.confidence >= bestConfidence * 0.75);
}

/** Return the normalized center of the union of all usable legacy face boxes on an item. */
export function faceUnionCenter(item: Pick<MediaItem, 'width' | 'height' | 'faces'>): { x: number; y: number } | null {
  const boxes = (item.faces ?? [])
    .map((face) => normalizeFaceMetadata(face, item.width, item.height))
    .filter((face): face is NormalizedFocusBox => Boolean(face));
  return unionCenter(boxes);
}

/**
 * Return the normalized smart-framing target. Generic focus regions are preferred and
 * ranked by source priority (manual, face, object, saliency), then confidence. Legacy
 * `faces` metadata remains a fallback for older library records.
 */
export function focusRegionCenter(item: Pick<MediaItem, 'width' | 'height' | 'faces' | 'focusRegions'>): { x: number; y: number } | null {
  const focusCenter = unionCenter(prioritizedFocusBoxes(item));
  return focusCenter ?? faceUnionCenter(item);
}

/**
 * Convert the focus-region center into existing -1..1 pan coordinates. The result only moves
 * along axes where the fitted media overflows the frame and is clamped so the frame remains
 * fully covered with no exposed background.
 */
export function faceCenterToPan(input: SmartFramingInput): SmartFramingPan {
  const sourceCenter = focusRegionCenter(input.item);
  if (!sourceCenter) return { panX: 0, panY: 0 };
  const center = transformPoint(sourceCenter, normalizeTransform(input.item));

  const overflowX = Math.max(0, input.fittedWidth - input.frameWidth);
  const overflowY = Math.max(0, input.fittedHeight - input.frameHeight);

  return {
    panX: overflowX > 0 ? clamp(((center.x - 0.5) * 2 * input.fittedWidth) / overflowX, -1, 1) : 0,
    panY: overflowY > 0 ? clamp(((center.y - 0.5) * 2 * input.fittedHeight) / overflowY, -1, 1) : 0,
  };
}
