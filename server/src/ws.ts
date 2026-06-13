/**
 * WebSocket control & event channel (`/ws`).
 *
 * Displays connect to receive {@link FrameEvent}s in real time (replacing the
 * original `checkPeriod` polling). Controllers (admin, cast senders) send
 * {@link ControlMessage}s to drive the frame.
 */

import type { FastifyInstance } from 'fastify';
import {
  FILL_MODES,
  FRAME_ASPECTS,
  MOTION_MODES,
  PLAYBACK_MEDIA_MODES,
  TRANSITIONS,
  type ControlMessage,
  type FillMode,
  type FrameAspect,
  type FrameConfig,
  type FrameEvent,
  type MotionMode,
  type PlaybackMediaMode,
  type TransitionName,
} from '@4kframe/shared';
import { hub } from './hub.js';
import { getConfig, setConfig } from './store.js';
import { cast, next, previous, progress, getCurrent, refresh, setPaused, playSequence, clearQueue } from './slideshow.js';
import * as auth from './auth.js';

type PublicConfigPatch = Partial<Pick<FrameConfig,
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
>>;

const ADMIN_CONTROL_TYPES = new Set<ControlMessage['type']>(['progress', 'cast', 'playSequence', 'clearQueue', 'config']);
// These display-local controls remain public so unauthenticated display receivers can
// keep working when the admin password gates the admin UI and management APIs.
const PUBLIC_DISPLAY_CONTROL_TYPES = new Set<ControlMessage['type']>(['next', 'previous', 'pause', 'resume', 'publicConfig']);
const PUBLIC_CONFIG_KEYS = new Set([
  'photoPeriod',
  'transitionPeriod',
  'zoom',
  'panX',
  'panY',
  'fillMode',
  'frameAspect',
  'transition',
  'motion',
  'playbackMediaMode',
  'smartFraming',
  'showQr',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function validatePublicConfigPatch(patch: unknown): PublicConfigPatch | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;

  const sanitized: PublicConfigPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PUBLIC_CONFIG_KEYS.has(key)) return null;

    switch (key) {
      case 'photoPeriod': {
        const parsed = parseNumber(value);
        if (parsed === null) return null;
        sanitized.photoPeriod = clamp(parsed, 0, 1200);
        break;
      }
      case 'transitionPeriod': {
        const parsed = parseNumber(value);
        if (parsed === null) return null;
        sanitized.transitionPeriod = clamp(parsed, 0, 30);
        break;
      }
      case 'zoom': {
        const parsed = parseNumber(value);
        if (parsed === null) return null;
        sanitized.zoom = clamp(parsed, 1, 3);
        break;
      }
      case 'panX': {
        const parsed = parseNumber(value);
        if (parsed === null) return null;
        sanitized.panX = clamp(parsed, -1, 1);
        break;
      }
      case 'panY': {
        const parsed = parseNumber(value);
        if (parsed === null) return null;
        sanitized.panY = clamp(parsed, -1, 1);
        break;
      }
      case 'fillMode':
        if (typeof value !== 'string' || !(FILL_MODES as readonly string[]).includes(value)) return null;
        sanitized.fillMode = value as FillMode;
        break;
      case 'frameAspect':
        if (typeof value !== 'string' || !(FRAME_ASPECTS as readonly string[]).includes(value)) return null;
        sanitized.frameAspect = value as FrameAspect;
        break;
      case 'transition':
        if (typeof value !== 'string' || !(TRANSITIONS as readonly string[]).includes(value)) return null;
        sanitized.transition = value as TransitionName;
        break;
      case 'motion':
        if (typeof value !== 'string' || !(MOTION_MODES as readonly string[]).includes(value)) return null;
        sanitized.motion = value as MotionMode;
        break;
      case 'playbackMediaMode':
        if (typeof value !== 'string' || !(PLAYBACK_MEDIA_MODES as readonly string[]).includes(value)) return null;
        sanitized.playbackMediaMode = value as PlaybackMediaMode;
        break;
      case 'smartFraming': {
        const parsed = parseBoolean(value);
        if (parsed === null) return null;
        sanitized.smartFraming = parsed;
        break;
      }
      case 'showQr': {
        const parsed = parseBoolean(value);
        if (parsed === null) return null;
        sanitized.showQr = parsed;
        break;
      }
    }
  }

  return sanitized;
}

async function applyConfigPatch(patch: Partial<FrameConfig>): Promise<void> {
  const cfg = getConfig();
  const updated = { ...cfg, ...patch };
  if (patch.fillMode) updated.frameFill = patch.fillMode === 'cover';
  await setConfig(updated);
  refresh();
  hub.emitEvent({ type: 'config', config: getConfig() });
}

export async function registerWs(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const authed = auth.isAuthed(req.headers.cookie);

    const send = (event: FrameEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Bridge hub events to this client.
    const off = hub.onEvent(send);

    // Send current state on connect.
    send({ type: 'config', config: getConfig() });
    const current = getCurrent();
    if (current.length) send({ type: 'show', items: current, interactive: false });

    socket.on('message', async (raw: Buffer) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!PUBLIC_DISPLAY_CONTROL_TYPES.has(msg.type) && !ADMIN_CONTROL_TYPES.has(msg.type)) return;
      if (ADMIN_CONTROL_TYPES.has(msg.type) && !authed) return;

      switch (msg.type) {
        case 'progress': progress(); break;
        case 'next': next(); break;
        case 'previous': previous(); break;
        case 'pause': setPaused(true); break;
        case 'resume': setPaused(false); break;
        case 'cast': await cast(msg.id); break;
        case 'playSequence':
          if (Array.isArray(msg.ids) && msg.ids.length <= 500 && msg.ids.every((id) => typeof id === 'string')) {
            playSequence([...new Set(msg.ids)]);
          }
          break;
        case 'clearQueue': clearQueue(); break;
        case 'config':
          await applyConfigPatch(msg.patch as Partial<FrameConfig>);
          break;
        case 'publicConfig': {
          const patch = validatePublicConfigPatch(msg.patch);
          if (!patch) return;
          await applyConfigPatch(patch);
          break;
        }
      }
    });

    socket.on('close', off);
  });
}
