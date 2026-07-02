/** Thin REST client for the admin PWA. */

import type { ApiDataPayload, ControlMessage, CurrentResponse, DisplayPlaybackState, MediaItem, MediaKind } from '@4kframe/shared';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({})) as { error?: string; failures?: unknown[] };
  if (!res.ok || body.failures?.length) {
    throw new Error(body.error ?? `Request failed (${res.status})${body.failures?.length ? `: ${body.failures.length} asset operation(s) failed` : ''}`);
  }
  return body as T;
}

export async function fetchItems(): Promise<MediaItem[]> {
  const res = await fetch('/api/thumbs');
  const json = (await res.json()) as { items: MediaItem[] };
  return json.items;
}

export async function fetchCurrent(): Promise<CurrentResponse> {
  const res = await fetch('/api/current');
  return (await res.json()) as CurrentResponse;
}

export async function fetchData(): Promise<ApiDataPayload> {
  return (await fetchCurrent()).data;
}

const STRING_PUBLIC_CONFIG_KEYS = new Set([
  'fillMode',
  'frameAspect',
  'transition',
  'motion',
  'playbackMediaMode',
  'smartFraming',
  'showQr',
  'screenRotation',
  'screenFlipHorizontal',
  'screenFlipVertical',
  'videoAudioMode',
  'videoMuted',
]);

let controlSocket: WebSocket | null = null;

function getControlSocket(): WebSocket | null {
  if (controlSocket && controlSocket.readyState <= WebSocket.OPEN) return controlSocket;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    controlSocket = socket;
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (controlSocket === socket) controlSocket = null;
    };
    return socket;
  } catch {
    controlSocket = null;
    return null;
  }
}

const CONTROL_SOCKET_TIMEOUT_MS = 1500;

function publicConfigMessage(patch: Record<string, string>): string {
  const publicPatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => {
    const numeric = Number(value);
    return [key, Number.isFinite(numeric) && !STRING_PUBLIC_CONFIG_KEYS.has(key) ? numeric : value];
  }));
  return JSON.stringify({ type: 'publicConfig', patch: publicPatch });
}

async function sendPublicConfig(patch: Record<string, string>): Promise<boolean> {
  const socket = getControlSocket();
  if (!socket) return false;
  const message = publicConfigMessage(patch);

  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(message);
      return true;
    } catch {
      socket.close();
      return false;
    }
  }
  if (socket.readyState !== WebSocket.CONNECTING) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (sent: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFailure);
      socket.removeEventListener('close', onFailure);
      resolve(sent);
    };
    const onOpen = (): void => {
      try {
        socket.send(message);
        finish(true);
      } catch {
        socket.close();
        finish(false);
      }
    };
    const onFailure = (): void => finish(false);
    const timeout = window.setTimeout(() => {
      socket.close();
      finish(false);
    }, CONTROL_SOCKET_TIMEOUT_MS);
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onFailure, { once: true });
    socket.addEventListener('close', onFailure, { once: true });
  });
}

export async function sendControl(message: ControlMessage): Promise<boolean> {
  const socket = getControlSocket();
  if (!socket) return false;
  const payload = JSON.stringify(message);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(payload);
    return true;
  }
  if (socket.readyState !== WebSocket.CONNECTING) return false;
  return await new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => resolve(false), CONTROL_SOCKET_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      window.clearTimeout(timeout);
      socket.send(payload);
      resolve(true);
    }, { once: true });
  });
}

export async function updateData(patch: Record<string, string>): Promise<void> {
  if ('videoAudioMode' in patch || 'videoMuted' in patch) {
    const typedPatch: Record<string, string | boolean> = { ...patch };
    if ('videoMuted' in typedPatch) typedPatch.videoMuted = typedPatch.videoMuted === 'true';
    if (await sendControl({ type: 'config', patch: typedPatch } as ControlMessage)) return;
  } else if (await sendPublicConfig(patch)) return;
  const qs = new URLSearchParams(patch).toString();
  await fetch(`/api/data?${qs}`);
}

export async function castItem(id: string): Promise<void> {
  await fetch(`/api/cast/${id}`);
}

export async function deleteItem(id: string): Promise<void> {
  await fetch(`/api/delete/${id}`);
}

export async function setItemsEnabled(ids: string[], enabled: boolean): Promise<void> {
  await requestJson('/api/items/enabled', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, enabled }),
  });
}

export async function deleteItems(ids: string[]): Promise<void> {
  await requestJson('/api/items', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  });
}

export async function playSequence(ids: string[]): Promise<void> {
  await requestJson('/api/play-sequence', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  });
}

export interface AuthState {
  required: boolean;
  authed: boolean;
  /** Which login methods the server offers (older servers omit this). */
  methods?: { password: boolean; google: boolean };
}
export async function me(): Promise<AuthState> {
  const res = await fetch('/api/me');
  return (await res.json()) as AuthState;
}
export async function login(password: string): Promise<boolean> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return res.ok;
}
export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export async function skipNext(): Promise<void> { await fetch('/api/next'); }
export async function skipPrev(): Promise<void> { await fetch('/api/previous'); }

export interface Playback {
  paused: boolean;
  holding: boolean;
  itemId: string | null;
  kind: MediaKind | null;
  display: DisplayPlaybackState | null;
}
export async function getPlayback(): Promise<Playback> {
  const res = await fetch('/api/playback');
  return (await res.json()) as Playback;
}
export async function setPaused(paused: boolean): Promise<void> {
  await fetch(paused ? '/api/pause' : '/api/resume');
}
export async function setHold(holding: boolean): Promise<void> {
  await fetch(holding ? '/api/hold' : '/api/unhold');
}
export async function seekBy(deltaSec: number): Promise<void> {
  await fetch(`/api/seek?delta=${encodeURIComponent(deltaSec)}`);
}

/** Include/exclude an item from rotation; returns the new enabled state. */
export async function toggleEnabled(id: string): Promise<boolean> {
  const res = await fetch(`/api/toggle/${id}`);
  const json = (await res.json()) as { enabled: boolean };
  return json.enabled;
}

export async function patchMediaTransforms(
  ids: string[],
  transform: Partial<Pick<MediaItem, 'rotation' | 'flipHorizontal' | 'flipVertical'>>,
): Promise<MediaItem[]> {
  const res = await fetch('/api/media/transforms', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, transform }),
  });
  if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'transform update failed');
  return ((await res.json()) as { items: MediaItem[] }).items;
}

export interface UploadResult {
  ok: boolean;
  added: MediaItem[];
  errors?: { filename: string; error: string }[];
}

// Upload in small chunks so large files pass proxies/CDNs that cap request body size
// (e.g. GitHub Codespaces returns 413 for big single requests).
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB

/** A random, path-safe id that doesn't require a secure context (works over plain http). */
function uploadId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12)
  );
}

async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<{ item?: MediaItem; error?: string }> {
  const id = uploadId();
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  for (let i = 0; i < total; i++) {
    const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const res = await fetch(`/api/upload/chunk?id=${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
    });
    if (!res.ok) return { error: `upload failed at ${Math.round(((i + 1) / total) * 100)}% (${res.status})` };
    onProgress?.((i + 1) / total);
  }
  const res = await fetch(
    `/api/upload/finish?id=${id}&name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`,
    { method: 'POST' },
  );
  if (!res.ok) return { error: `finalize failed (${res.status})` };
  const json = (await res.json()) as { ok: boolean; item?: MediaItem; error?: string };
  return json.item ? { item: json.item } : { error: json.error ?? 'upload failed' };
}

export async function upload(
  files: FileList | File[],
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const list = Array.from(files);
  const added: MediaItem[] = [];
  const errors: { filename: string; error: string }[] = [];
  for (let f = 0; f < list.length; f++) {
    const result = await uploadFile(list[f], (p) => onProgress?.((f + p) / list.length));
    if (result.item) added.push(result.item);
    else errors.push({ filename: list[f].name, error: result.error ?? 'upload failed' });
  }
  return { ok: errors.length === 0, added, errors };
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const res = await fetch('/api/google/status');
  return (await res.json()) as GoogleStatus;
}

export interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet: boolean;
  pollIntervalMs: number;
}

/** Create a Google Photos Picker session (returns the URI the user opens to pick). */
export async function createPickerSession(): Promise<PickerSession> {
  const res = await fetch('/api/google/picker/session', { method: 'POST' });
  if (!res.ok) throw new Error('failed to create picker session');
  return (await res.json()) as PickerSession;
}

/** Poll a Picker session to see whether the user has finished selecting. */
export async function pollPickerSession(id: string): Promise<PickerSession> {
  const res = await fetch(`/api/google/picker/session/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('failed to poll picker session');
  return (await res.json()) as PickerSession;
}

/** Import the items the user picked in a session. Returns how many were added. */
export async function importPickerSession(id: string): Promise<number> {
  const res = await fetch(`/api/google/picker/session/${encodeURIComponent(id)}/import`, { method: 'POST' });
  if (!res.ok) throw new Error('failed to import picked items');
  const json = (await res.json()) as { imported: number };
  return json.imported;
}

export function thumbUrl(item: MediaItem): string {
  return `/photos/${item.thumb}`;
}
