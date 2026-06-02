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
import { buildFilename, newIdentity, type MediaItem } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';

export function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
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
    transcoding = needsTranscode(cleanExt, p);
  }

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
  };
  return { item };
}

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
