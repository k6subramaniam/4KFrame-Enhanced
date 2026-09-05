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
  type FrameBackup,
  type FrameConfig,
  type MediaItem,
} from '@4kframe/shared';
import { DB_FILE, DATA_DIR, MEDIA_DIR } from './env.js';

interface DbDocument {
  config: FrameConfig;
  items: MediaItem[];
  /** Recoverable media removed from the active library. Assets stay on disk until purge. */
  trash: MediaItem[];
  /** Ordered list of item ids forming the play order. */
  order: string[];
  /** Google OAuth tokens (kept server-side only). */
  googleTokens?: { accessToken: string; refreshToken?: string; expiresAt: number };
  /** Random secret signing admin session cookies when no FRAME_AUTH_SECRET/password is set. */
  authSecret?: string;
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
    // The spread is shallow, so nested objects persisted before a new sub-field existed
    // would replace the defaults wholesale and drop it — merge those explicitly.
    doc = {
      config: {
        ...defaultConfig(),
        ...(parsed.config ?? {}),
        googlePhotos: { ...defaultConfig().googlePhotos, ...(parsed.config?.googlePhotos ?? {}) },
        overlays: { ...defaultConfig().overlays, ...(parsed.config?.overlays ?? {}) },
      },
      items: (parsed.items ?? []).map((item) => ({ ...item, ...normalizeTransform(item) })),
      trash: (parsed.trash ?? []).map((item) => ({ ...item, ...normalizeTransform(item) })),
      order: parsed.order ?? (parsed.items ?? []).map((i) => i.id),
      googleTokens: parsed.googleTokens,
      authSecret: parsed.authSecret,
    };
  } catch {
    doc = { config: defaultConfig(), items: [], trash: [], order: [] };
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

export function listTrashItems(): MediaItem[] {
  return [...db().trash].sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
}

export function getTrashItem(id: string): MediaItem | undefined {
  return db().trash.find((item) => item.id === id);
}

/** Move active media into the recoverable Trash without touching on-disk assets. */
export async function trashItems(
  ids: string[],
  trashedAt = Date.now(),
  retentionMs = 30 * 24 * 60 * 60 * 1000,
): Promise<MediaItem[]> {
  const d = db();
  const wanted = new Set(ids);
  const removed = d.items.filter((item) => wanted.has(item.id));
  if (!removed.length) return [];
  d.items = d.items.filter((item) => !wanted.has(item.id));
  d.order = d.order.filter((id) => !wanted.has(id));
  const expiresAt = trashedAt + Math.max(0, retentionMs);
  for (const item of removed) {
    d.trash = d.trash.filter((existing) => existing.id !== item.id);
    d.trash.push({ ...item, trashedAt, trashExpiresAt: expiresAt });
  }
  await flush();
  return removed;
}

/** Restore media from Trash to the active library, preserving its original id/assets. */
export async function restoreTrashItems(ids: string[]): Promise<MediaItem[]> {
  const d = db();
  const wanted = new Set(ids);
  const restoring = d.trash.filter((item) => wanted.has(item.id));
  if (!restoring.length) return [];
  d.trash = d.trash.filter((item) => !wanted.has(item.id));
  const activeIds = new Set(d.items.map((item) => item.id));
  const restored: MediaItem[] = [];
  for (const item of restoring) {
    if (activeIds.has(item.id)) continue;
    const restoredItem: MediaItem = { ...item };
    delete restoredItem.trashedAt;
    delete restoredItem.trashExpiresAt;
    d.items.push(restoredItem);
    d.order.push(restoredItem.id);
    activeIds.add(restoredItem.id);
    restored.push(restoredItem);
  }
  await flush();
  return restored;
}

/** Remove records from Trash so callers can permanently delete their assets. */
export async function removeTrashItems(ids: string[]): Promise<MediaItem[]> {
  const d = db();
  const wanted = new Set(ids);
  const removed = d.trash.filter((item) => wanted.has(item.id));
  d.trash = d.trash.filter((item) => !wanted.has(item.id));
  await flush();
  return removed;
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

// --- Auth secret ---

export function getAuthSecret(): string | undefined {
  return db().authSecret;
}

export async function setAuthSecret(secret: string): Promise<void> {
  db().authSecret = secret;
  await flush();
}


function isBackupMediaItem(value: unknown): value is MediaItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<MediaItem>;
  return typeof item.id === 'string'
    && item.id.length > 0
    && (item.kind === 'photo' || item.kind === 'video')
    && typeof item.file === 'string'
    && item.file.length > 0
    && typeof item.preview === 'string'
    && typeof item.thumb === 'string'
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt);
}

/** Export settings + library catalog without OAuth tokens or authentication secrets. */
export function createSafeBackup(): FrameBackup {
  const d = db();
  return JSON.parse(JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    config: d.config,
    items: d.items,
    trash: d.trash,
    order: d.order,
  })) as FrameBackup;
}

/**
 * Restore a safe backup without deleting newer library entries.
 *
 * Catalog rows are only merged when their main media file still exists on this volume.
 * This makes a metadata/settings restore safe even when the JSON is moved between frames.
 */
export async function restoreSafeBackup(input: unknown): Promise<{
  restoredItems: number;
  restoredTrash: number;
  skippedMissingAssets: number;
}> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid backup');
  const backup = input as Partial<FrameBackup>;
  if (backup.version !== 1 || !backup.config || !Array.isArray(backup.items) || !Array.isArray(backup.trash) || !Array.isArray(backup.order)) {
    throw new Error('unsupported or incomplete backup');
  }
  if (backup.items.some((item) => !isBackupMediaItem(item)) || backup.trash.some((item) => !isBackupMediaItem(item))) {
    throw new Error('backup contains invalid media records');
  }

  const d = db();
  d.config = {
    ...defaultConfig(),
    ...(backup.config as Partial<FrameConfig>),
    googlePhotos: {
      ...defaultConfig().googlePhotos,
      ...((backup.config as Partial<FrameConfig>).googlePhotos ?? {}),
    },
    overlays: {
      ...defaultConfig().overlays,
      ...((backup.config as Partial<FrameConfig>).overlays ?? {}),
    },
  };

  let skippedMissingAssets = 0;
  const validItems: MediaItem[] = [];
  for (const raw of backup.items as MediaItem[]) {
    try {
      await fs.access(path.join(MEDIA_DIR, raw.file));
      validItems.push({ ...raw, ...normalizeTransform(raw) });
    } catch {
      skippedMissingAssets += 1;
    }
  }
  const validTrash: MediaItem[] = [];
  for (const raw of backup.trash as MediaItem[]) {
    try {
      await fs.access(path.join(MEDIA_DIR, raw.file));
      validTrash.push({ ...raw, ...normalizeTransform(raw) });
    } catch {
      skippedMissingAssets += 1;
    }
  }

  const activeById = new Map(d.items.map((item) => [item.id, item]));
  for (const item of validItems) activeById.set(item.id, item);
  d.items = [...activeById.values()];

  const trashById = new Map(d.trash.map((item) => [item.id, item]));
  for (const item of validTrash) trashById.set(item.id, item);
  d.trash = [...trashById.values()];

  const activeIds = new Set(d.items.map((item) => item.id));
  const requestedOrder = (backup.order as string[]).filter((id) => activeIds.has(id));
  d.order = [...new Set([...requestedOrder, ...d.order.filter((id) => activeIds.has(id)), ...activeIds])];

  await flush();
  return {
    restoredItems: validItems.length,
    restoredTrash: validTrash.length,
    skippedMissingAssets,
  };
}
