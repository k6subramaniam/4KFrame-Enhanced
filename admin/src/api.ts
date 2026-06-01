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

export async function upload(files: FileList | File[]): Promise<void> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append('file', f, f.name);
  await fetch('/api/upload', { method: 'POST', body: form });
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
}

export async function googleStatus(): Promise<GoogleStatus> {
  const res = await fetch('/api/google/status');
  return (await res.json()) as GoogleStatus;
}

export function thumbUrl(item: MediaItem): string {
  return `/photos/${item.thumb}`;
}
