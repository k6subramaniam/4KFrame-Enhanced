import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FaceMetadata } from '@4kframe/shared';

process.env.FRAME_DATA_DIR = await mkdtemp(path.join(tmpdir(), '4kframe-face-test-'));

type FaceMatchModule = typeof import('./faceMatch.js');
type ImageModule = typeof import('./images.js');
type StoreModule = typeof import('../store.js');
type VideoModule = typeof import('./video.js');

const [faceMatch, images, store, video] = await Promise.all([
  import('./faceMatch.js') as Promise<FaceMatchModule>,
  import('./images.js') as Promise<ImageModule>,
  import('../store.js') as Promise<StoreModule>,
  import('./video.js') as Promise<VideoModule>,
]);

await store.initStore();

const face: FaceMetadata = {
  box: { x: 4, y: 8, width: 32, height: 40 },
  embedding: [0.1, 0.2, 0.3],
  label: 'Family',
};

async function tinyJpeg(): Promise<Buffer> {
  const sharp = await import('sharp').then((m) => m.default ?? m).catch(() => null);
  if (!sharp) return Buffer.from('not-a-real-image-but-valid-for-fallback');
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#999' } }).jpeg().toBuffer();
}

test('face metadata is omitted when FRAME_ENABLE_FACE_MATCH is unset', async (t) => {
  delete process.env.FRAME_ENABLE_FACE_MATCH;
  faceMatch.setFaceDetector(() => [face]);
  t.after(() => faceMatch.resetFaceDetectorForTests());

  const { item } = await images.ingestImage(await tinyJpeg());

  assert.equal(item.faces, undefined);
});

test('face metadata is persisted when Smart Face Match is enabled', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  faceMatch.setFaceDetector(() => [face]);
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
  });

  const { item } = await images.ingestImage(await tinyJpeg());
  await store.addItem(item);
  const persisted = JSON.parse(await readFile(process.env.FRAME_DATA_DIR + '/frame.json', 'utf8')) as { items: Array<{ id: string; faces?: FaceMetadata[] }> };

  assert.deepEqual(item.faces, [face]);
  assert.deepEqual(persisted.items.find((persistedItem) => persistedItem.id === item.id)?.faces, [face]);
});

test('video face detection uses generated still frames instead of scanning the whole file', async (t) => {
  process.env.FRAME_ENABLE_FACE_MATCH = '1';
  const posterBytes = Buffer.from('poster-frame-bytes');
  const videoBytes = Buffer.from('source-video-bytes');
  const detectorInputs: Array<{ source: string; buffer: Buffer }> = [];

  faceMatch.setFaceDetector(({ source, buffer }) => {
    detectorInputs.push({ source, buffer });
    return [face];
  });
  video.setCommandRunnerForTests(async (cmd, args) => {
    if (cmd === 'ffmpeg' && args.includes('-version')) return { code: 0, stdout: Buffer.from('ffmpeg'), stderr: '' };
    if (cmd === 'ffprobe') {
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p' }],
          format: { duration: '12.5' },
        })),
        stderr: '',
      };
    }
    if (cmd === 'ffmpeg' && args.includes('-frames:v')) {
      await writeFile(args[args.length - 1], posterBytes);
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  t.after(() => {
    delete process.env.FRAME_ENABLE_FACE_MATCH;
    faceMatch.resetFaceDetectorForTests();
    video.resetCommandRunnerForTests();
  });

  const { item } = await video.ingestVideo(videoBytes, 'mp4');

  assert.ok(detectorInputs.length > 1);
  const posterInput = detectorInputs.find((input) => input.source === 'video-poster');
  assert.ok(posterInput);
  assert.deepEqual(posterInput.buffer, posterBytes);
  assert.ok(detectorInputs.some((input) => input.source === 'video-frame'));
  assert.ok(detectorInputs.every((input) => !input.buffer.equals(videoBytes)));
  assert.deepEqual(item.faces, [face]);
  assert.ok(item.focusTimeline?.length);
  assert.ok(item.cropTimeline?.length);
});
