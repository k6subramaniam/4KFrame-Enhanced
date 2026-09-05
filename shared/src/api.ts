/**
 * API contract shared between server, display and admin.
 *
 * Original routes preserved for compatibility:
 *   /api/progress, /api/next, /api/previous, /api/current, /api/data, /api/thumbs,
 *   /photos/:filename, /api/cast/:id, /api/delete/:id, /api/photo/:id, /api/preview/:id
 * New routes:
 *   /api/upload, /api/google/*, /api/video/:id, WebSocket /ws
 */

import type { ApiDataPayload, FrameConfig } from './config.js';
import type { MediaKind } from './filename.js';
import type { QuarterTurn } from './transforms.js';

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceMetadata {
  box: FaceBox;
  /** Optional local face embedding vector. Never required and only stored when generated locally. */
  embedding?: number[];
  /** Optional app-owned label assigned by an administrator. */
  label?: string;
}

/** Generic, privacy-preserving subject metadata used by smart framing. */
export type FocusRegionSource = 'face' | 'saliency' | 'object' | 'manual';

export interface FocusRegion {
  /**
   * Subject box in either normalized 0..1 image coordinates or source pixel coordinates.
   * Consumers normalize with the media dimensions so detectors can use their native output.
   */
  box: FaceBox;
  /** Optional detector confidence in the 0..1 range. Higher confidence is preferred. */
  confidence?: number;
  /** Detector/source category. Manual regions are considered the highest priority. */
  source: FocusRegionSource;
  /** Optional detector label or app-owned human label. */
  label?: string;
}

/** Video quality targets supported by the server-side upscale pipeline. */
export const VIDEO_UPSCALE_TARGETS = ['1080p', '4k'] as const;
export type VideoUpscaleTarget = (typeof VIDEO_UPSCALE_TARGETS)[number];

/** A single media item in the library. */
export interface MediaItem {
  id: string;
  kind: MediaKind;
  width: number;
  height: number;
  /** Filename of the main asset (image or video). */
  file: string;
  /** Preview asset filename (image). */
  preview: string;
  /** Thumbnail asset filename. */
  thumb: string;
  /** Poster image filename for videos. */
  poster?: string;
  /** Video duration in seconds, when applicable. */
  durationSec?: number;
  /** Epoch ms the item was added to this frame. */
  createdAt: number;
  /** Epoch ms the item was uploaded/imported to this frame. Legacy items fall back to createdAt. */
  uploadedAt?: number;
  /** Epoch ms reported by the original file/source when available. */
  originalCreatedAt?: number;
  /** Original filename before 4KFrame generated its storage filename. */
  originalFilename?: string;
  /** Best-effort source/main-file size in bytes. */
  sizeBytes?: number;
  /** Human-readable uploader/source label shown in admin filters. */
  uploader?: string;
  /** Human-readable storage backend/location label. */
  storageLocation?: string;
  /** Epoch ms when the item was moved to Trash. */
  trashedAt?: number;
  /** Epoch ms when the item becomes eligible for permanent purge from Trash. */
  trashExpiresAt?: number;
  /** Source of the item. */
  source: 'upload' | 'google-photos';
  /** Optional caption (EXIF/description derived). */
  caption?: string;
  /** Face metadata detected on the image, or on the poster for videos.
   *  When Smart Face Match is enabled, includes embeddings and labels.
   *  Otherwise, contains only box coordinates. */
  faces?: FaceMetadata[];
  /** Generic focus/subject regions detected locally on the image, or on the poster for videos. */
  focusRegions?: FocusRegion[];
  /** True while a background H.264 transcode is in progress (video only). */
  transcoding?: boolean;
  /** True while a requested higher-resolution video rendition is being generated. */
  upscaling?: boolean;
  /** Last successfully generated quality target. */
  upscaleTarget?: VideoUpscaleTarget;
  /** Preserved pre-upscale video used so later quality changes do not upscale an upscale. */
  upscaleSourceFile?: string;
  upscaleSourceWidth?: number;
  upscaleSourceHeight?: number;
  /** Whether the item is included in automatic slideshow rotation (default true). */
  enabled?: boolean;
  /** Persisted display transform. Flips are applied before clockwise rotation. */
  rotation?: QuarterTurn;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

/** Response of `/api/current` — the active item(s) plus the loose config payload. */
export interface CurrentResponse {
  current: string[];
  data: ApiDataPayload;
}

/** Response of `/api/thumbs`. */
export interface ThumbsResponse {
  items: MediaItem[];
}

export interface MediaIdsPayload {
  ids: string[];
}

export interface SetItemsEnabledPayload extends MediaIdsPayload {
  enabled: boolean;
}

export interface QueueState {
  ids: string[];
  index: number;
  active: boolean;
}

/** Transient playback details reported by a connected display for the active video. */
export interface DisplayPlaybackState {
  itemId: string;
  currentTime: number;
  duration: number;
  seekable: boolean;
  observedAt: number;
}

// --- WebSocket protocol (`/ws`) ---

/** Commands a controller (admin / cast sender / display remote) sends to the server. */
export type ControlMessage =
  | { type: 'progress' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; offsetSec: SeekOffsetSec }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'playbackState'; itemId: string; currentTime: number; duration: number; seekable: boolean }
  | { type: 'cast'; id: string }
  | { type: 'playSequence'; ids: string[] }
  | { type: 'clearQueue' }
  | { type: 'config'; patch: Partial<FrameConfig> | ApiDataPayload }
  | {
      type: 'publicConfig';
      patch: Partial<Pick<FrameConfig,
        | 'photoPeriod'
        | 'transitionPeriod'
        | 'zoom'
        | 'panX'
        | 'panY'
        | 'fillMode'
        | 'frameAspect'
        | 'transition'
        | 'motion'
        | 'playbackMediaMode'
        | 'smartFraming'
        | 'showQr'
        | 'screenRotation'
        | 'screenFlipHorizontal'
        | 'screenFlipVertical'
      >> | ApiDataPayload;
    };

/** Events the server pushes to displays and controllers. */
export type FrameEvent =
  | { type: 'show'; items: MediaItem[]; interactive: boolean }
  | { type: 'seek'; offsetSec: SeekOffsetSec }
  | { type: 'config'; config: FrameConfig }
  | { type: 'library'; items: MediaItem[] }
  | { type: 'paused'; paused: boolean }
  | { type: 'hold'; holding: boolean }
  | { type: 'queue'; queue: QueueState }
  | { type: 'seek'; itemId: string; deltaSec: number }
  | { type: 'liveCast'; liveCast: LiveCastInfo }
  | { type: 'liveCastEnd' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * A one-off "show this right now" push from the companion app. The bytes live only in
 * server memory under {@link LiveCastInfo.id} until `expiresAt`, and are never added to
 * the library or written to disk — displays fetch them from `/api/live-cast/:id`.
 */
export interface LiveCastInfo {
  id: string;
  kind: MediaKind;
  mimeType: string;
  /** Epoch ms after which the server drops the bytes and displays resume the slideshow. */
  expiresAt: number;
}

export type WsMessage = ControlMessage | FrameEvent;

/** Deliberately small seek allowlist exposed by frame controls. */
export const SEEK_OFFSETS_SEC = [-15, -5, 5, 15] as const;
export type SeekOffsetSec = typeof SEEK_OFFSETS_SEC[number];

export function isSeekOffsetSec(value: unknown): value is SeekOffsetSec {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (SEEK_OFFSETS_SEC as readonly number[]).includes(value);
}

/**
 * Custom Google Cast namespace. The companion sender posts {@link ControlMessage}s on
 * this namespace; the display (Custom Web Receiver) bridges them onto its WebSocket so
 * native Cast reuses the exact same control protocol as the admin app.
 */
export const CAST_NAMESPACE = 'urn:x-cast:com.4kframe.control';

export const DEFAULT_HTTP_PORT = 9095;
export const DEFAULT_HTTPS_PORT = 9096;
