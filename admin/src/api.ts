/** Thin REST client for the admin PWA. */

import type { ApiDataPayload, MediaItem } from '@4kframe/shared';

export async function fetchItems(): Promise<MediaItem[]> {
  const res = await fetch('/api/thumbs');
  const json = (await res.json()) as { items: MediaItem[] };
  return json.items;
}

export async function fetchData(): Promise<ApiDataPayload> {
  const res = await fetch('/api/current');
  const json = (await res.json()) as { data: ApiDataPayload };
  return json.data;
}

export async function updateData(patch: Record<string, string>): Promise<void> {
  const qs = new URLSearchParams(patch).toString();
  await fetch(`/api/data?${qs}`);
}

export async function castItem(id: string): Promise<void> {
  await fetch(`/api/cast/${id}`);
}

export async function deleteItem(id: string): Promise<void> {
  await fetch(`/api/delete/${id}`);
}

export interface AuthState { required: boolean; authed: boolean; }
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

/** Include/exclude an item from rotation; returns the new enabled state. */
export async function toggleEnabled(id: string): Promise<boolean> {
  const res = await fetch(`/api/toggle/${id}`);
  const json = (await res.json()) as { enabled: boolean };
  return json.enabled;
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
