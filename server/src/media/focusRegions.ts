import type { FaceMetadata, FocusRegion } from '@4kframe/shared';
import { faceMatchEnabled } from '../env.js';

export type FocusDetectionSource = 'image' | 'video-poster';

export interface FocusDetectionInput {
  buffer: Buffer;
  source: FocusDetectionSource;
}

export type FocusRegionDetector = (input: FocusDetectionInput) => Promise<FocusRegion[]> | FocusRegion[];

let detectors: FocusRegionDetector[] = [];

/**
 * Whether local subject/saliency detection should run during ingest.
 *
 * `FRAME_ENABLE_FOCUS_REGIONS=1` enables generic detectors. Smart Face Match also enables
 * the local detection path so face boxes can be mirrored into generic focus regions for
 * smart framing without calling any external media service.
 */
export function focusRegionDetectionEnabled(): boolean {
  return process.env.FRAME_ENABLE_FOCUS_REGIONS === '1' || faceMatchEnabled();
}

/**
 * Register a privacy-preserving local subject/saliency detector.
 *
 * Detectors receive in-memory image bytes and must run locally. The framework deliberately
 * provides no remote upload integration; callers that need ML-backed regions should install
 * on-device models at startup and return only bounding boxes, confidence, source, and labels.
 */
export function registerFocusRegionDetector(next: FocusRegionDetector): void {
  detectors = [...detectors, next];
}

/** Replace all local focus-region detectors. Intended for tests and controlled startup wiring. */
export function setFocusRegionDetectorsForTests(next: FocusRegionDetector[]): void {
  detectors = [...next];
}

/** Test-only helper that restores the privacy-preserving no-op detector registry. */
export function resetFocusRegionDetectorsForTests(): void {
  detectors = [];
}

export async function detectFocusRegionsInImageBuffer(
  buffer: Buffer,
  faces?: FaceMetadata[],
): Promise<FocusRegion[] | undefined> {
  return detectFocusRegions({ buffer, source: 'image' }, faces);
}

export async function detectFocusRegionsInGeneratedVideoPosterImage(
  buffer: Buffer,
  faces?: FaceMetadata[],
): Promise<FocusRegion[] | undefined> {
  return detectFocusRegions({ buffer, source: 'video-poster' }, faces);
}

async function detectFocusRegions(input: FocusDetectionInput, faces: FaceMetadata[] = []): Promise<FocusRegion[] | undefined> {
  if (!focusRegionDetectionEnabled()) return undefined;

  const detected = (await Promise.all(detectors.map((detector) => detector(input)))).flat();
  const faceRegions = faces.map(faceToFocusRegion);
  const sanitized = sanitizeFocusRegions([...faceRegions, ...detected]);
  return sanitized.length ? sanitized : undefined;
}

function faceToFocusRegion(face: FaceMetadata): FocusRegion {
  return {
    box: face.box,
    confidence: 1,
    source: 'face',
    ...(face.label ? { label: face.label } : {}),
  };
}

export function sanitizeFocusRegions(regions: FocusRegion[]): FocusRegion[] {
  return regions
    .map((region) => {
      const x = finite(region.box?.x);
      const y = finite(region.box?.y);
      const width = finite(region.box?.width);
      const height = finite(region.box?.height);
      if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      if (width <= 0 || height <= 0) return undefined;
      if (!isFocusRegionSource(region.source)) return undefined;
      const confidence = finite(region.confidence);
      return {
        box: { x, y, width, height },
        source: region.source,
        ...(confidence === undefined ? {} : { confidence: clamp(confidence, 0, 1) }),
        ...(region.label ? { label: String(region.label) } : {}),
      } satisfies FocusRegion;
    })
    .filter((region): region is FocusRegion => Boolean(region));
}

function isFocusRegionSource(source: unknown): source is FocusRegion['source'] {
  return source === 'face' || source === 'saliency' || source === 'object' || source === 'manual';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
