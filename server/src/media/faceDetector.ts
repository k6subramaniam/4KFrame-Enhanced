/** CPU-only Tiny Face Detector adapter. This module is loaded only when explicitly enabled. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FaceMetadata } from '@4kframe/shared';
import type { FaceDetectionInput } from './faceMatch.js';

interface TensorLike {}

interface TensorflowNode {
  node: {
    decodeImage(buffer: Buffer, channels: number): TensorLike;
  };
  expandDims(tensor: TensorLike, axis: number): TensorLike;
  dispose(tensors: TensorLike[]): void;
}

interface DetectionResult {
  box: { x: number; y: number; width: number; height: number };
}

interface FaceApiModule {
  nets: {
    tinyFaceDetector: {
      loadFromDisk(modelPath: string): Promise<void>;
    };
  };
  TinyFaceDetectorOptions: new (options: { inputSize: number }) => unknown;
  detectAllFaces(input: TensorLike, options: unknown): Promise<DetectionResult[]>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundledModelDir = path.resolve(__dirname, '../../models/face');
const require = createRequire(import.meta.url);
const packageModelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
const modelDir = process.env.FRAME_FACE_MODEL_DIR
  ? path.resolve(process.env.FRAME_FACE_MODEL_DIR)
  : existsSync(bundledModelDir) ? bundledModelDir : packageModelDir;
const inputSize = parseInputSize(process.env.FRAME_FACE_INPUT_SIZE);

// tfjs-node must register its native backend before face-api is imported.
const tensorflowPackage = '@tensorflow/tfjs-node';
const faceApiPackage = '@vladmandic/face-api';
const tfModule = await import(tensorflowPackage) as unknown as TensorflowNode & { default?: TensorflowNode };
const tf = tfModule.default ?? tfModule;
const faceApiImport = await import(faceApiPackage) as unknown as FaceApiModule & { default?: FaceApiModule };
const faceApi = faceApiImport.default ?? faceApiImport;

await faceApi.nets.tinyFaceDetector.loadFromDisk(modelDir);
const options = new faceApi.TinyFaceDetectorOptions({ inputSize });

/** Detect face bounding boxes locally; no descriptors, embeddings, or labels are computed. */
export async function detectFacesLocal({ buffer }: FaceDetectionInput): Promise<FaceMetadata[]> {
  const decoded = tf.node.decodeImage(buffer, 3);
  const batched = tf.expandDims(decoded, 0);
  try {
    const detections = await faceApi.detectAllFaces(batched, options);
    return detections.map(({ box }) => ({
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    }));
  } finally {
    tf.dispose([decoded, batched]);
  }
}

function parseInputSize(value: string | undefined): number {
  const parsed = Number(value) || 416;
  if (parsed < 128 || parsed > 608 || parsed % 32 !== 0) {
    throw new Error('FRAME_FACE_INPUT_SIZE must be a multiple of 32 between 128 and 608');
  }
  return parsed;
}
