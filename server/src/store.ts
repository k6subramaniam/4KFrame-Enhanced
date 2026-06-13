/**
 * Persistent store for frame configuration and the media library.
 *
 * The plan calls for SQLite (better-sqlite3) in production. To keep the foundation
 * dependency-light and reliably installable, this implementation persists to a single
 * JSON document behind a small async-safe interface. The interface is deliberately
 * storage-agnostic so it can be swapped for a SQLite-backed implementation without
 * touching callers (routes, slideshow engine, sync worker).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defaultConfig,
  normalizeTransform,
  type DisplayTransform,
  type FrameConfig,
  type MediaItem,
} from '@4kframe/shared';
import { DB_FILE, DATA_DIR, MEDIA_DIR } from './env.js';

interface DbDocument {
  config: FrameConfig;
  items: MediaItem[];
  /** Ordered list of item ids forming the play order. */
  order: string[];
  /** Google OAuth tokens (kept server-side only). */
  googleTokens?: { accessToken: string; refreshToken?: string; expiresAt: number };
}

let doc: DbDocument | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function ensureDirs(): Promise<void> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function initStore(): Promise<void> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DbDocument>;
    doc = {
      config: { ...defaultConfig(), ...(parsed.config ?? {}) },
      items: (parsed.items ?? []).map((item) => ({ ...item, ...normalizeTransform(item) })),
      order: parsed.order ?? (parsed.items ?? []).map((i) => i.id),
      googleTokens: parsed.googleTokens,
    };
  } catch {
    doc = { config: defaultConfig(), items: [], order: [] };
    await flush();
  }
}

function db(): DbDocument {
  if (!doc) throw new Error('Store not initialised — call initStore() first');
  return doc;
}

/** Serialise the current document to disk, chained to avoid concurrent writes. */
function flush(): Promise<void> {
  const snapshot = JSON.stringify(db(), null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = path.join(DATA_DIR, `.frame.${process.pid}.tmp`);
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, DB_FILE);
  });
  return writeChain;
}

// --- Config ---

export function getConfig(): FrameConfig {
  return db().config;
}

export async function setConfig(next: FrameConfig): Promise<FrameConfig> {
  db().config = next;
  await flush();
  return next;
}

// --- Media library ---

export function listItems(): MediaItem[] {
  const { items, order } = db();
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = order.map((id) => byId.get(id)).filter((i): i is MediaItem => Boolean(i));
  // Append any items missing from the order (defensive).
  for (const i of items) if (!order.includes(i.id)) ordered.push(i);
  return ordered;
}

export function getItem(id: string): MediaItem | undefined {
  return db().items.find((i) => i.id === id);
}

export async function addItem(item: MediaItem): Promise<MediaItem> {
  const d = db();
  d.items.push(item);
  d.order.push(item.id);
  await flush();
  return item;
}

/** Shallow-merge a patch onto an existing item (e.g. swap `file` after transcoding). */
export async function updateItem(id: string, patch: Partial<MediaItem>): Promise<MediaItem | undefined> {
  const item = db().items.find((i) => i.id === id);
  if (!item) return undefined;
  Object.assign(item, patch);
  await flush();
  return item;
}

export async function patchItemTransforms(ids: string[], patch: Partial<DisplayTransform>): Promise<MediaItem[] | undefined> {
  const d = db();
  const uniqueIds = [...new Set(ids)];
  const selected = uniqueIds.map((id) => d.items.find((item) => item.id === id));
  if (selected.some((item) => !item)) return undefined;
  for (const item of selected as MediaItem[]) Object.assign(item, patch);
  await flush();
  return selected as MediaItem[];
}

/** Atomically update the Favorite/automatic-playback flag for existing items. */
export async function setItemsEnabled(ids: string[], enabled: boolean): Promise<MediaItem[]> {
  const wanted = new Set(ids);
  const updated = db().items.filter((item) => wanted.has(item.id));
  for (const item of updated) item.enabled = enabled;
  await flush();
  return updated;
}

/** Atomically remove multiple records and their play-order entries. */
export async function removeItems(ids: string[]): Promise<MediaItem[]> {
  const d = db();
  const wanted = new Set(ids);
  const removed = d.items.filter((item) => wanted.has(item.id));
  d.items = d.items.filter((item) => !wanted.has(item.id));
  d.order = d.order.filter((id) => !wanted.has(id));
  await flush();
  return removed;
}

export async function removeItem(id: string): Promise<MediaItem | undefined> {
  const d = db();
  const idx = d.items.findIndex((i) => i.id === id);
  if (idx === -1) return undefined;
  const [removed] = d.items.splice(idx, 1);
  d.order = d.order.filter((o) => o !== id);
  await flush();
  return removed;
}

/** Move an item to the front of the play order (used when casting). */
export async function promoteItem(id: string): Promise<void> {
  const d = db();
  d.order = [id, ...d.order.filter((o) => o !== id)];
  await flush();
}

// --- Google tokens ---

export function getGoogleTokens(): DbDocument['googleTokens'] {
  return db().googleTokens;
}

export async function setGoogleTokens(tokens: DbDocument['googleTokens']): Promise<void> {
  db().googleTokens = tokens;
  await flush();
}
