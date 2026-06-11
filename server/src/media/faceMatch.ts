import type { FaceMetadata } from '@4kframe/shared';
import { faceMatchEnabled } from '../env.js';

export type FaceDetectionSource = 'image' | 'video-poster' | 'video-frame';

export interface FaceDetectionInput {
  buffer: Buffer;
  source: FaceDetectionSource;
}

export type FaceDetector = (input: FaceDetectionInput) => Promise<FaceMetadata[]> | FaceMetadata[];

let detector: FaceDetector = () => [];

/**
 * Register the local Smart Face Match detector.
 *
 * The default detector is intentionally a no-op so enabling the feature never uploads
 * images or biometric data to an external service. Integrations can install a local
 * detector (for example, an on-device model) at startup and return only app-owned
 * bounding boxes / embeddings.
 */
export function setFaceDetector(next: FaceDetector): void {
  detector = next;
}

/** Test-only helper that restores the privacy-preserving no-op detector. */
export function resetFaceDetectorForTests(): void {
  detector = () => [];
}

export async function detectFacesInImageBuffer(buffer: Buffer): Promise<FaceMetadata[] | undefined> {
  return detectFaces({ buffer, source: 'image' });
}

export async function detectFacesInGeneratedVideoPosterImage(buffer: Buffer): Promise<FaceMetadata[] | undefined> {
  return detectFaces({ buffer, source: 'video-poster' });
}

export async function detectFacesInGeneratedVideoFrameImage(buffer: Buffer): Promise<FaceMetadata[] | undefined> {
  return detectFaces({ buffer, source: 'video-frame' });
}

async function detectFaces(input: FaceDetectionInput): Promise<FaceMetadata[] | undefined> {
  if (!faceMatchEnabled()) return undefined;
  const faces = await detector(input);
  const sanitized = sanitizeFaces(faces);
  return sanitized.length ? sanitized : undefined;
}

function sanitizeFaces(faces: FaceMetadata[]): FaceMetadata[] {
  return faces
    .map((face) => {
      const x = finite(face.box?.x);
      const y = finite(face.box?.y);
      const width = finite(face.box?.width);
      const height = finite(face.box?.height);
      if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
      if (width <= 0 || height <= 0) return undefined;
      const embedding = Array.isArray(face.embedding)
        ? face.embedding.filter((value) => Number.isFinite(value))
        : undefined;
      return {
        box: { x, y, width, height },
        ...(embedding?.length ? { embedding } : {}),
        ...(face.label ? { label: String(face.label) } : {}),
      } satisfies FaceMetadata;
    })
    .filter((face): face is FaceMetadata => Boolean(face));
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
