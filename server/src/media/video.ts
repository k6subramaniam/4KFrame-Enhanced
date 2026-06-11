/**
 * Video processing pipeline.
 *
 * Uses the `ffmpeg` / `ffprobe` binaries when present to:
 *  - probe dimensions and duration,
 *  - extract a poster frame (used as the thumbnail/preview and for transitions),
 *  - optionally transcode to a TV-friendly H.264 MP4.
 *
 * ffmpeg is treated as an external runtime dependency. If it is not installed the
 * pipeline stores the original video and a placeholder poster so the server keeps
 * working; transcoding is skipped.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildFilename,
  faceCenterToPan,
  newIdentity,
  type FaceMetadata,
  type FocusRegion,
  type FocusTimelineEntry,
  type MediaItem,
  type VideoCropKeyframe,
} from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';
import { detectFacesInGeneratedVideoFrameImage, detectFacesInGeneratedVideoPosterImage } from './faceMatch.js';

export type CommandRunner = (cmd: string, args: string[], input?: Buffer) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

let commandRunner: CommandRunner = defaultRun;

export function setCommandRunnerForTests(next: CommandRunner): void {
  commandRunner = next;
  ffmpegChecked = undefined;
}

export function resetCommandRunnerForTests(): void {
  commandRunner = defaultRun;
  ffmpegChecked = undefined;
}

export function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return commandRunner(cmd, args, input);
}

function defaultRun(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: err }));
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

let ffmpegChecked: boolean | undefined;
export async function videoProcessingAvailable(): Promise<boolean> {
  if (ffmpegChecked !== undefined) return ffmpegChecked;
  try {
    const { code } = await run('ffmpeg', ['-version']);
    ffmpegChecked = code === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

export interface Probe {
  width: number;
  height: number;
  durationSec: number;
  videoCodec: string;
  audioCodec: string;
  pixFmt: string;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
}

async function probe(file: string): Promise<Probe | null> {
  try {
    const { stdout, code } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt:format=duration',
      '-of', 'json',
      file,
    ]);
    if (code !== 0) return null;
    const json = JSON.parse(stdout.toString()) as { streams?: FfStream[]; format?: { duration?: string } };
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    return {
      width: Number(v?.width) || 0,
      height: Number(v?.height) || 0,
      durationSec: Number(json.format?.duration) || 0,
      videoCodec: v?.codec_name ?? '',
      audioCodec: a?.codec_name ?? '',
      pixFmt: v?.pix_fmt ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Whether a source needs transcoding to play reliably on TV browsers / Chromecast.
 * The safe target is an H.264 (yuv420p) + AAC MP4 within 4K.
 */
export function needsTranscode(ext: string, p: Probe | null): boolean {
  if (!p) return false; // couldn't probe — leave the original untouched
  const okContainer = ext === 'mp4' || ext === 'm4v';
  const okVideo = p.videoCodec === 'h264';
  const okAudio = p.audioCodec === '' || p.audioCodec === 'aac';
  const okPix = p.pixFmt === '' || p.pixFmt === 'yuv420p' || p.pixFmt === 'yuvj420p';
  const tooBig = p.width > 3840 || p.height > 2160;
  return tooBig || !(okContainer && okVideo && okAudio && okPix);
}

/** Ingest raw video bytes: probe, write the file, extract a poster, return a MediaItem. */
export async function ingestVideo(
  buf: Buffer,
  ext: string,
  source: MediaItem['source'] = 'upload',
  caption?: string,
): Promise<{ item: MediaItem }> {
  const identity = newIdentity();
  const available = await videoProcessingAvailable();

  // Write the source video first so ffprobe/ffmpeg can read it.
  const cleanExt = ext.replace(/^\./, '').toLowerCase() || 'mp4';
  const tmpName = buildFilename(identity, 0, 0, cleanExt);
  const tmpPath = path.join(MEDIA_DIR, tmpName);
  await fs.writeFile(tmpPath, buf);

  let width = 0;
  let height = 0;
  let durationSec = 0;
  let posterName: string | undefined;
  let transcoding = false;
  let focusTimeline: FocusTimelineEntry[] | undefined;
  let cropTimeline: VideoCropKeyframe[] | undefined;

  if (available) {
    const p = await probe(tmpPath);
    if (!p) {
      // ffmpeg is present but can't read this as video — reject it (e.g. corrupt or not a
      // real video) rather than store a file that plays as a black screen.
      await fs.rm(tmpPath).catch(() => undefined);
      throw new Error('not a recognisable video file');
    }
    width = p.width;
    height = p.height;
    durationSec = p.durationSec;
    posterName = await extractPoster(tmpPath, identity, width, height);
    const focus = await buildVideoFocusMetadata(tmpPath, identity, width, height, durationSec);
    focusTimeline = focus.focusTimeline;
    cropTimeline = focus.cropTimeline;
    transcoding = needsTranscode(cleanExt, p);
  }

  const faces = posterName
    ? await detectFacesInGeneratedVideoPosterImage(await fs.readFile(path.join(MEDIA_DIR, posterName)))
    : undefined;

  // Rename the video file to embed real dimensions, for parity with the convention.
  const finalName = buildFilename(identity, width, height, cleanExt);
  if (finalName !== tmpName) {
    await fs.rename(tmpPath, path.join(MEDIA_DIR, finalName));
  }

  const item: MediaItem = {
    id: identity,
    kind: 'video',
    width,
    height,
    file: finalName,
    preview: posterName ?? finalName,
    thumb: posterName ?? finalName,
    poster: posterName,
    durationSec,
    createdAt: Date.now(),
    source,
    caption,
    ...(transcoding ? { transcoding: true } : {}),
    ...(faces ? { faces } : {}),
    ...(focusTimeline ? { focusTimeline } : {}),
    ...(cropTimeline ? { cropTimeline } : {}),
  };
  return { item };
}

const MAX_FOCUS_SAMPLES = 5;
const MIN_SAMPLE_SEPARATION_SEC = 0.2;

export function representativeVideoTimestamps(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0.5];
  if (durationSec <= 1) return [roundTime(Math.max(0, durationSec / 2))];

  const inset = Math.min(0.5, durationSec / 4);
  const candidates = durationSec < 3
    ? [inset, durationSec / 2, Math.max(inset, durationSec - inset)]
    : [inset, durationSec * 0.25, durationSec * 0.5, durationSec * 0.75, durationSec - inset];

  const timestamps: number[] = [];
  for (const candidate of candidates) {
    const t = roundTime(clamp(candidate, 0, durationSec));
    if (timestamps.every((existing) => Math.abs(existing - t) >= MIN_SAMPLE_SEPARATION_SEC)) timestamps.push(t);
    if (timestamps.length >= MAX_FOCUS_SAMPLES) break;
  }
  return timestamps.length ? timestamps : [roundTime(Math.min(0.5, durationSec))];
}

async function buildVideoFocusMetadata(
  videoPath: string,
  identity: string,
  width: number,
  height: number,
  durationSec: number,
): Promise<{ focusTimeline?: FocusTimelineEntry[]; cropTimeline?: VideoCropKeyframe[] }> {
  if (width <= 0 || height <= 0) return {};

  const entries: FocusTimelineEntry[] = [];
  const frameNames = await extractFocusFrames(videoPath, identity, width, height, representativeVideoTimestamps(durationSec));
  try {
    for (const frame of frameNames) {
      const faces = await detectFacesInGeneratedVideoFrameImage(await fs.readFile(path.join(MEDIA_DIR, frame.name)));
      if (faces?.length) entries.push({ timeSec: frame.timeSec, regions: facesToFocusRegions(faces) });
    }
  } finally {
    await Promise.all(frameNames.map((frame) => fs.rm(path.join(MEDIA_DIR, frame.name)).catch(() => undefined)));
  }

  if (!entries.length) return {};
  return { focusTimeline: entries, cropTimeline: smoothCropTimeline(entriesToCropKeyframes(entries, width, height)) };
}

async function extractFocusFrames(
  videoPath: string,
  identity: string,
  width: number,
  height: number,
  timestamps: number[],
): Promise<Array<{ timeSec: number; name: string }>> {
  const frames: Array<{ timeSec: number; name: string }> = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timeSec = timestamps[index];
    const name = `focus.${index}.${buildFilename(identity, width || 0, height || 0, 'jpg')}`;
    const out = path.join(MEDIA_DIR, name);
    try {
      const { code } = await run('ffmpeg', [
        '-y',
        '-ss', String(timeSec),
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '4',
        out,
      ]);
      if (code === 0) frames.push({ timeSec, name });
    } catch {
      // A missed sample should not fail the whole ingest; the poster/transcode paths can continue.
    }
  }
  return frames;
}

function facesToFocusRegions(faces: FaceMetadata[]): FocusRegion[] {
  return faces.map((face) => ({
    x: face.box.x,
    y: face.box.y,
    width: face.box.width,
    height: face.box.height,
    ...(face.label ? { label: face.label } : {}),
  }));
}

function entriesToCropKeyframes(entries: FocusTimelineEntry[], width: number, height: number): VideoCropKeyframe[] {
  const frameWidth = 16;
  const frameHeight = 9;
  const coverScale = Math.max(frameWidth / width, frameHeight / height);
  const fittedWidth = width * coverScale;
  const fittedHeight = height * coverScale;
  return entries.map((entry) => {
    const pan = faceCenterToPan({
      item: { width, height, faces: entry.regions.map((region) => ({ box: region })) },
      frameWidth,
      frameHeight,
      fittedWidth,
      fittedHeight,
    });
    return { timeSec: entry.timeSec, panX: pan.panX, panY: pan.panY };
  });
}

export function smoothCropTimeline(keyframes: VideoCropKeyframe[]): VideoCropKeyframe[] {
  if (keyframes.length <= 1) return keyframes;

  return keyframes.map((keyframe, index) => {
    const prev = keyframes[Math.max(0, index - 1)];
    const next = keyframes[Math.min(keyframes.length - 1, index + 1)];
    return {
      timeSec: keyframe.timeSec,
      panX: roundPan(clamp((prev.panX + keyframe.panX * 2 + next.panX) / 4, -1, 1)),
      panY: roundPan(clamp((prev.panY + keyframe.panY * 2 + next.panY) / 4, -1, 1)),
    };
  });
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const roundTime = (v: number): number => Math.round(v * 1000) / 1000;
const roundPan = (v: number): number => Math.round(v * 1000) / 1000;

async function extractPoster(
  videoPath: string,
  identity: string,
  width: number,
  height: number,
): Promise<string | undefined> {
  const name = buildFilename(identity, width || 0, height || 0, 'jpg');
  const out = path.join(MEDIA_DIR, `poster.${name}`);
  try {
    const { code } = await run('ffmpeg', [
      '-y',
      '-ss', '0.5',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '3',
      out,
    ]);
    if (code !== 0) return undefined;
    return `poster.${name}`;
  } catch {
    return undefined;
  }
}
