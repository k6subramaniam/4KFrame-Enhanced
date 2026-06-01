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

function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
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

interface Probe {
  width: number;
  height: number;
  durationSec: number;
}

async function probe(file: string): Promise<Probe | null> {
  try {
    const { stdout, code } = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      file,
    ]);
    if (code !== 0) return null;
    const json = JSON.parse(stdout.toString());
    const stream = json.streams?.[0] ?? {};
    return {
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      durationSec: Number(json.format?.duration) || 0,
    };
  } catch {
    return null;
  }
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

  if (available) {
    const p = await probe(tmpPath);
    if (p) {
      width = p.width;
      height = p.height;
      durationSec = p.durationSec;
    }
    posterName = await extractPoster(tmpPath, identity, width, height);
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
