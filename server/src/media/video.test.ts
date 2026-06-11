import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FaceMetadata } from '@4kframe/shared';
import type { Probe } from './video.js';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-video-test-'));
await mkdir(path.join(process.env.FRAME_DATA_DIR, 'photos'), { recursive: true });

type VideoModule = typeof import('./video.js');
type FaceMatchModule = typeof import('./faceMatch.js');

const [video, faceMatch] = await Promise.all([
  import('./video.js') as Promise<VideoModule>,
  import('./faceMatch.js') as Promise<FaceMatchModule>,
]);

const { ingestVideo, needsTranscode, representativeVideoTimestamps, smoothCropTimeline } = video;

const base: Probe = {
  width: 1920, height: 1080, durationSec: 10,
  videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p',
};

function enableFakeFfmpeg(t: TestContext, probe: Probe | null, onFrame?: (out: string) => Promise<void> | void): void {
  video.setCommandRunnerForTests(async (cmd, args) => {
    if (cmd === 'ffmpeg' && args.includes('-version')) return { code: 0, stdout: Buffer.from('ffmpeg'), stderr: '' };
    if (cmd === 'ffprobe') {
      if (!probe) return { code: 1, stdout: Buffer.alloc(0), stderr: 'invalid data' };
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: probe.videoCodec, width: probe.width, height: probe.height, pix_fmt: probe.pixFmt },
            ...(probe.audioCodec ? [{ codec_type: 'audio', codec_name: probe.audioCodec }] : []),
          ],
          format: { duration: String(probe.durationSec) },
        })),
        stderr: '',
      };
    }
    if (cmd === 'ffmpeg' && args.includes('-frames:v')) {
      const out = args[args.length - 1];
      await writeFile(out, Buffer.from(path.basename(out)));
      await onFrame?.(out);
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  t.after(() => video.resetCommandRunnerForTests());
}

test('a TV-friendly H.264/AAC mp4 does not need transcoding', () => {
  assert.equal(needsTranscode('mp4', base), false);
  assert.equal(needsTranscode('m4v', base), false);
  assert.equal(needsTranscode('mp4', { ...base, audioCodec: '' }), false); // no audio
  assert.equal(needsTranscode('mp4', { ...base, pixFmt: 'yuvj420p' }), false);
});

test('non-friendly sources need transcoding', () => {
  assert.equal(needsTranscode('mkv', base), true);                       // container
  assert.equal(needsTranscode('webm', { ...base, videoCodec: 'vp9' }), true); // codec
  assert.equal(needsTranscode('mp4', { ...base, videoCodec: 'hevc' }), true);
  assert.equal(needsTranscode('mp4', { ...base, audioCodec: 'mp3' }), true);
  assert.equal(needsTranscode('mp4', { ...base, pixFmt: 'yuv444p' }), true);
  assert.equal(needsTranscode('mp4', { ...base, width: 4096, height: 2160 }), true); // >4K
});

test('an unprobeable source is left untouched for transcode decisions', () => {
  assert.equal(needsTranscode('mov', null), false);
});

test('representative sampling keeps short videos to a single in-range frame', () => {
  assert.deepEqual(representativeVideoTimestamps(0.4), [0.2]);
});

test('short video ingest generates a single sampled focus timeline entry', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  enableFakeFfmpeg(t, { ...base, width: 1920, height: 800, durationSec: 0.4 });
  const frameDetections: string[] = [];
  faceMatch.setFaceDetector(({ source }) => {
    if (source === 'video-frame') {
      frameDetections.push(source);
      return [{ box: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } }];
    }
    return [];
  });
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
  });

  const { item } = await ingestVideo(Buffer.from('video'), 'mp4');

  assert.equal(frameDetections.length, 1);
  assert.deepEqual(item.focusTimeline?.map((entry) => entry.timeSec), [0.2]);
  assert.equal(item.cropTimeline?.length, 1);
});

test('unprobeable video ingest rejects without generating framing metadata', async (t) => {
  enableFakeFfmpeg(t, null);

  await assert.rejects(() => ingestVideo(Buffer.from('not-a-video'), 'mov'), /recognisable video/);
});

test('no-subject videos omit focus and crop timelines', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  enableFakeFfmpeg(t, { ...base, durationSec: 6 });
  faceMatch.setFaceDetector(() => []);
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
  });

  const { item } = await ingestVideo(Buffer.from('video'), 'mp4');

  assert.equal(item.faces, undefined);
  assert.equal(item.focusTimeline, undefined);
  assert.equal(item.cropTimeline, undefined);
});

test('moving subjects produce a smoothed multi-keyframe crop path', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  enableFakeFfmpeg(t, { ...base, width: 1920, height: 800, durationSec: 8 });
  const xs = [0.1, 0.3, 0.55, 0.8, 0.9];
  let frameIndex = 0;
  faceMatch.setFaceDetector(({ source }) => {
    if (source !== 'video-frame') return [];
    const x = xs[Math.min(frameIndex, xs.length - 1)];
    frameIndex += 1;
    return [{ box: { x, y: 0.35, width: 0.08, height: 0.2 } } satisfies FaceMetadata];
  });
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
  });

  const { item } = await ingestVideo(Buffer.from('video'), 'mp4');

  assert.deepEqual(item.focusTimeline?.map((entry) => entry.timeSec), [0.5, 2, 4, 6, 7.5]);
  assert.equal(item.cropTimeline?.length, 5);
  assert.ok((item.cropTimeline?.[0].panX ?? 0) < (item.cropTimeline?.[4].panX ?? 0));
  assert.notDeepEqual(item.cropTimeline, item.focusTimeline?.map((_entry, index) => ({ timeSec: item.cropTimeline?.[index].timeSec, panX: xs[index], panY: 0 })));
});

test('crop timeline smoothing damps abrupt jumps while preserving timestamps', () => {
  const smoothed = smoothCropTimeline([
    { timeSec: 0, panX: -1, panY: 0 },
    { timeSec: 1, panX: 1, panY: 0 },
    { timeSec: 2, panX: -1, panY: 0 },
  ]);

  assert.deepEqual(smoothed.map((keyframe) => keyframe.timeSec), [0, 1, 2]);
  assert.deepEqual(smoothed.map((keyframe) => keyframe.panX), [-0.5, 0, -0.5]);
});
