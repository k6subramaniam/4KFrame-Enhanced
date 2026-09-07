/** Timestamped local face sampling for videos. */

import path from 'node:path';
import type { FaceBox, FaceMetadata, MediaItem } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';
import { run } from './video.js';
import { detectFacesInVideoFrame } from './faceMatch.js';

interface Track {
  id: string;
  box: FaceBox;
  lastTime: number;
}

const DEFAULT_INTERVAL_SEC = 3;
const DEFAULT_MAX_SAMPLES = 60;

/**
 * Sample a video locally with ffmpeg and return normalized face boxes tagged with timestamps
 * and best-effort track ids. No frames leave the server.
 */
export async function detectFacesAcrossVideo(
  item: MediaItem,
  existingFaces: FaceMetadata[] = item.faces ?? [],
): Promise<FaceMetadata[]> {
  if (item.kind !== 'video' || !item.file || !Number.isFinite(item.durationSec) || Number(item.durationSec) <= 0) {
    return [];
  }

  const duration = Math.max(0, Number(item.durationSec));
  const configuredInterval = clampNumber(process.env.FRAME_FACE_VIDEO_INTERVAL_SEC, DEFAULT_INTERVAL_SEC, 1, 30);
  const maxSamples = Math.round(clampNumber(process.env.FRAME_FACE_VIDEO_MAX_SAMPLES, DEFAULT_MAX_SAMPLES, 5, 180));
  const interval = Math.max(configuredInterval, duration / maxSamples);
  const start = Math.min(0.5, Math.max(0, duration * 0.02));
  const timestamps: number[] = [];
  for (let t = start; t < Math.max(start + 0.01, duration - 0.05) && timestamps.length < maxSamples; t += interval) {
    timestamps.push(Math.round(t * 100) / 100);
  }
  if (!timestamps.length) timestamps.push(0);

  const videoPath = path.join(MEDIA_DIR, item.file);
  const tracks: Track[] = [];
  const output: FaceMetadata[] = [];
  let nextTrack = 1;

  for (const timestampSec of timestamps) {
    const frame = await extractFrame(videoPath, timestampSec);
    if (!frame) continue;

    const sharpModule = await import('sharp');
    const sharp = sharpModule.default ?? sharpModule;
    const metadata = await sharp(frame, { failOn: 'none' }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) continue;

    const detections = await detectFacesInVideoFrame(frame);
    if (!detections?.length) continue;

    const normalized = detections
      .map((face) => normalizeFace(face, width, height))
      .filter((face): face is FaceMetadata => Boolean(face));

    const usedTracks = new Set<string>();
    for (const face of normalized) {
      let best: Track | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const track of tracks) {
        if (usedTracks.has(track.id)) continue;
        if (timestampSec - track.lastTime > interval * 2.6) continue;
        const score = boxDistance(track.box, face.box);
        if (score < bestScore) {
          best = track;
          bestScore = score;
        }
      }

      if (!best || bestScore > 0.36) {
        best = { id: `face-${nextTrack++}`, box: face.box, lastTime: timestampSec };
        tracks.push(best);
      } else {
        best.box = face.box;
        best.lastTime = timestampSec;
      }
      usedTracks.add(best.id);

      const preservedLabel = findExistingLabel(existingFaces, timestampSec, face.box, interval);
      output.push({
        ...face,
        timestampSec,
        trackId: best.id,
        ...(preservedLabel ? { label: preservedLabel } : {}),
      });
    }
  }

  return output;
}

async function extractFrame(videoPath: string, timestampSec: number): Promise<Buffer | undefined> {
  try {
    const result = await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(Math.max(0, timestampSec)),
      '-i', videoPath,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ]);
    return result.code === 0 && result.stdout.length ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFace(face: FaceMetadata, width: number, height: number): FaceMetadata | undefined {
  const box = face.box;
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height)) {
    return undefined;
  }
  const normalized = {
    x: clamp01(box.x / width),
    y: clamp01(box.y / height),
    width: clamp01(box.width / width),
    height: clamp01(box.height / height),
  };
  if (normalized.width <= 0 || normalized.height <= 0) return undefined;
  return {
    box: normalized,
    ...(face.embedding?.length ? { embedding: face.embedding } : {}),
  };
}

function boxDistance(a: FaceBox, b: FaceBox): number {
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const center = Math.hypot(acx - bcx, acy - bcy);
  const size = Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
  return center + size * 0.35;
}

function findExistingLabel(
  faces: FaceMetadata[],
  timestampSec: number,
  box: FaceBox,
  interval: number,
): string | undefined {
  let best: { label: string; score: number } | undefined;
  for (const face of faces) {
    if (!face.label) continue;
    const time = Number(face.timestampSec ?? 0);
    const timeGap = Math.abs(time - timestampSec);
    if (timeGap > Math.max(2, interval * 1.5)) continue;
    const score = boxDistance(face.box, box) + timeGap / Math.max(1, interval) * 0.08;
    if (!best || score < best.score) best = { label: face.label, score };
  }
  return best && best.score <= 0.42 ? best.label : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
