/**
 * Background video transcoding and quality upscaling.
 *
 * Jobs run one-at-a-time so a 4K encode cannot saturate the frame server alongside
 * another transcode. Upscaling preserves the pre-upscale source file so changing from
 * 1080p to 4K always starts from the best available source rather than scaling an upscale.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildFilename, type MediaItem, type VideoUpscaleTarget } from '@4kframe/shared';
import { MEDIA_DIR } from '../env.js';
import { run, videoProcessingAvailable } from './video.js';
import { getItem, updateItem, listItems } from '../store.js';
import { hub } from '../hub.js';
import { refresh } from '../slideshow.js';
import {
  cancelQueuedProcessingJob,
  createProcessingJob,
  getProcessingJob,
  setProcessingJobState,
} from '../processingJobs.js';
import { invalidateStorageCache } from '../storage.js';

let chain: Promise<void> = Promise.resolve();

/** Queue a flagged video for background compatibility transcoding (no-op otherwise). */
export function enqueueTranscode(item: MediaItem): string | null {
  if (!item.transcoding) return null;
  const job = createProcessingJob('transcode', item.id, item.originalFilename ?? item.file);
  chain = chain.then(async () => {
    if (getProcessingJob(job.id)?.state === 'cancelled') return;
    setProcessingJobState(job.id, 'running');
    try {
      const error = await transcodeOne(item);
      setProcessingJobState(job.id, error ? 'failed' : 'completed', error ?? undefined);
    } catch (error) {
      await updateItem(item.id, { transcoding: false });
      setProcessingJobState(job.id, 'failed', (error as Error).message);
    }
  }).catch(() => undefined);
  return job.id;
}

async function transcodeOne(item: MediaItem): Promise<string | null> {
  if (!(await videoProcessingAvailable())) {
    await updateItem(item.id, { transcoding: false });
    return 'ffmpeg video processing is unavailable';
  }

  const srcPath = path.join(MEDIA_DIR, item.file);
  const outName = `h264.${buildFilename(item.id, item.width, item.height, 'mp4')}`;
  const outPath = path.join(MEDIA_DIR, outName);

  let scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  if (item.width > 0 && item.height > 0) {
    let w = item.width;
    let h = item.height;
    const s = Math.min(3840 / w, 2160 / h, 1);
    w = Math.floor((w * s) / 2) * 2;
    h = Math.floor((h * s) / 2) * 2;
    scale = `scale=${w}:${h}`;
  }

  hub.emitEvent({ type: 'log', level: 'info', message: `Transcoding ${item.file}…` });
  const { code } = await run('ffmpeg', [
    '-y', '-i', srcPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-vf', scale,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ]);

  if (code !== 0) {
    await fs.rm(outPath).catch(() => undefined);
    await updateItem(item.id, { transcoding: false });
    hub.emitEvent({ type: 'log', level: 'warn', message: `Transcode failed for ${item.file}; serving original.` });
    return 'transcode failed';
  }

  const oldFile = item.file;
  await updateItem(item.id, { file: outName, transcoding: false });
  if (oldFile !== outName) await fs.rm(path.join(MEDIA_DIR, oldFile)).catch(() => undefined);

  refresh();
  invalidateStorageCache();
  hub.emitEvent({ type: 'library', items: listItems() });
  hub.emitEvent({ type: 'log', level: 'info', message: `Transcoded ${item.file} → ${outName}.` });
  return null;
}

function targetDimensions(
  width: number,
  height: number,
  target: VideoUpscaleTarget,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const landscape = width >= height;
  const box = target === '4k'
    ? (landscape ? { width: 3840, height: 2160 } : { width: 2160, height: 3840 })
    : (landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 });
  const scale = Math.min(box.width / width, box.height / height);
  if (!Number.isFinite(scale) || scale <= 1.001) return null;
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

export interface UpscaleQueueResult {
  queued: boolean;
  error?: string;
}

export async function enqueueUpscale(
  item: MediaItem,
  target: VideoUpscaleTarget,
): Promise<UpscaleQueueResult> {
  if (item.kind !== 'video') return { queued: false, error: 'only videos can be upscaled' };
  if (item.transcoding || item.upscaling) return { queued: false, error: 'video is already processing' };
  if (!(await videoProcessingAvailable())) return { queued: false, error: 'ffmpeg video processing is unavailable' };

  const sourceWidth = item.upscaleSourceWidth ?? item.width;
  const sourceHeight = item.upscaleSourceHeight ?? item.height;
  if (!targetDimensions(sourceWidth, sourceHeight, target)) {
    return { queued: false, error: `source already meets or exceeds the ${target === '4k' ? '4K' : '1080p'} target` };
  }

  await updateItem(item.id, { upscaling: true });
  hub.emitEvent({ type: 'library', items: listItems() });
  const job = createProcessingJob('upscale', item.id, item.originalFilename ?? item.file, target);
  chain = chain
    .then(async () => {
      if (getProcessingJob(job.id)?.state === 'cancelled') return;
      setProcessingJobState(job.id, 'running');
      try {
        const error = await upscaleOne(item.id, target);
        setProcessingJobState(job.id, error ? 'failed' : 'completed', error ?? undefined);
      } catch (error) {
        await updateItem(item.id, { upscaling: false });
        setProcessingJobState(job.id, 'failed', (error as Error).message);
        hub.emitEvent({ type: 'library', items: listItems() });
        hub.emitEvent({ type: 'log', level: 'error', message: `Upscale failed: ${(error as Error).message}` });
      }
    })
    .catch(() => undefined);
  return { queued: true };
}

async function upscaleOne(id: string, target: VideoUpscaleTarget): Promise<string | null> {
  const item = getItem(id);
  if (!item || item.kind !== 'video') return 'video no longer exists';

  let sourceFile = item.upscaleSourceFile ?? item.file;
  let sourceWidth = item.upscaleSourceWidth ?? item.width;
  let sourceHeight = item.upscaleSourceHeight ?? item.height;
  let sourcePath = path.join(MEDIA_DIR, sourceFile);

  try {
    await fs.access(sourcePath);
  } catch {
    sourceFile = item.file;
    sourceWidth = item.width;
    sourceHeight = item.height;
    sourcePath = path.join(MEDIA_DIR, sourceFile);
  }

  const dims = targetDimensions(sourceWidth, sourceHeight, target);
  if (!dims) {
    await updateItem(id, { upscaling: false });
    hub.emitEvent({ type: 'library', items: listItems() });
    return 'source already meets target';
  }

  const outName = `upscaled-${target}.${buildFilename(item.id, dims.width, dims.height, 'mp4')}`;
  const outPath = path.join(MEDIA_DIR, outName);
  hub.emitEvent({
    type: 'log',
    level: 'info',
    message: `Upscaling ${sourceFile} to ${dims.width}×${dims.height} (${target})…`,
  });

  const { code } = await run('ffmpeg', [
    '-y', '-i', sourcePath,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=${dims.width}:${dims.height}:flags=lanczos,unsharp=5:5:0.35:3:3:0.0`,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ]);

  if (code !== 0) {
    await fs.rm(outPath).catch(() => undefined);
    await updateItem(id, { upscaling: false });
    hub.emitEvent({ type: 'library', items: listItems() });
    hub.emitEvent({ type: 'log', level: 'warn', message: `Upscale failed for ${sourceFile}; keeping current video.` });
    return 'upscale failed';
  }

  const latest = getItem(id);
  if (!latest) {
    await fs.rm(outPath).catch(() => undefined);
    return 'video removed during upscale';
  }

  const preservedSourceFile = latest.upscaleSourceFile ?? sourceFile;
  const preservedSourceWidth = latest.upscaleSourceWidth ?? sourceWidth;
  const preservedSourceHeight = latest.upscaleSourceHeight ?? sourceHeight;
  const oldDisplayFile = latest.file;

  await updateItem(id, {
    file: outName,
    width: dims.width,
    height: dims.height,
    upscaling: false,
    upscaleTarget: target,
    upscaleSourceFile: preservedSourceFile,
    upscaleSourceWidth: preservedSourceWidth,
    upscaleSourceHeight: preservedSourceHeight,
  });

  if (oldDisplayFile !== preservedSourceFile && oldDisplayFile !== outName) {
    await fs.rm(path.join(MEDIA_DIR, oldDisplayFile)).catch(() => undefined);
  }

  invalidateStorageCache();
  refresh();
  hub.emitEvent({ type: 'library', items: listItems() });
  hub.emitEvent({
    type: 'log',
    level: 'info',
    message: `Upscale complete: ${sourceFile} → ${dims.width}×${dims.height}.`,
  });
  return null;
}

export async function cancelVideoProcessingJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const job = cancelQueuedProcessingJob(jobId);
  if (!job) return { ok: false, error: 'only queued jobs can be cancelled' };
  const item = getItem(job.mediaId);
  if (item) {
    await updateItem(job.mediaId, job.kind === 'transcode' ? { transcoding: false } : { upscaling: false });
    hub.emitEvent({ type: 'library', items: listItems() });
  }
  return { ok: true };
}

export async function retryVideoProcessingJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const previous = getProcessingJob(jobId);
  if (!previous || (previous.state !== 'failed' && previous.state !== 'cancelled')) {
    return { ok: false, error: 'only failed or cancelled jobs can be retried' };
  }
  const item = getItem(previous.mediaId);
  if (!item || item.kind !== 'video') return { ok: false, error: 'video no longer exists' };

  if (previous.kind === 'transcode') {
    const updated = await updateItem(item.id, { transcoding: true });
    if (!updated) return { ok: false, error: 'video no longer exists' };
    enqueueTranscode(updated);
    hub.emitEvent({ type: 'library', items: listItems() });
    return { ok: true };
  }

  if (!previous.target) return { ok: false, error: 'upscale target is missing' };
  return enqueueUpscale(item, previous.target);
}
