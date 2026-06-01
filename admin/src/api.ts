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

export interface UploadResult {
  ok: boolean;
  added: MediaItem[];
  errors?: { filename: string; error: string }[];
}

export async function upload(files: FileList | File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append('file', f, f.name);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) {
    return { ok: false, added: [], errors: [{ filename: '', error: `server responded ${res.status}` }] };
  }
  return (await res.json()) as UploadResult;
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
