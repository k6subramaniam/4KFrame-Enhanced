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

export interface FaceBox {
  /** Left edge of the detected face. Values may be normalised (0..1) or pixels. */
  x: number;
  /** Top edge of the detected face. Values may be normalised (0..1) or pixels. */
  y: number;
  /** Width of the detected face. Values may be normalised (0..1) or pixels. */
  width: number;
  /** Height of the detected face. Values may be normalised (0..1) or pixels. */
  height: number;
}

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
  /** Epoch ms the item was added. */
  createdAt: number;
  /** Source of the item. */
  source: 'upload' | 'google-photos';
  /** Optional caption (EXIF/description derived). */
  caption?: string;
  /** Face boxes detected on the image, or on the poster for videos. */
  faces?: FaceBox[];
  /** True while a background H.264 transcode is in progress (video only). */
  transcoding?: boolean;
  /** Whether the item is included in automatic slideshow rotation (default true). */
  enabled?: boolean;
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

// --- WebSocket protocol (`/ws`) ---

/** Commands a controller (admin / cast sender / display remote) sends to the server. */
export type ControlMessage =
  | { type: 'progress' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cast'; id: string }
  | { type: 'config'; patch: Partial<FrameConfig> | ApiDataPayload };

/** Events the server pushes to displays and controllers. */
export type FrameEvent =
  | { type: 'show'; items: MediaItem[]; interactive: boolean }
  | { type: 'config'; config: FrameConfig }
  | { type: 'library'; items: MediaItem[] }
  | { type: 'paused'; paused: boolean }
  | { type: 'hold'; holding: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type WsMessage = ControlMessage | FrameEvent;

/**
 * Custom Google Cast namespace. The companion sender posts {@link ControlMessage}s on
 * this namespace; the display (Custom Web Receiver) bridges them onto its WebSocket so
 * native Cast reuses the exact same control protocol as the admin app.
 */
export const CAST_NAMESPACE = 'urn:x-cast:com.4kframe.control';

export const DEFAULT_HTTP_PORT = 9095;
export const DEFAULT_HTTPS_PORT = 9096;
