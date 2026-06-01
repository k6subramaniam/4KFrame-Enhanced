/**
 * Google Photos integration — Picker API.
 *
 * Google retired broad Library API access in March 2025: third-party apps can no longer
 * list a user's albums or search their whole library. The supported path is now the
 * **Photos Picker API**, where the user explicitly selects items in Google's own UI and the
 * app imports just those. This is on-demand selection — there is no album auto-sync.
 *
 * Flow:
 *   1. createSession()  -> returns a `pickerUri` the user opens to pick photos.
 *   2. getSession(id)   -> poll until `mediaItemsSet` is true.
 *   3. importSession(id)-> list the picked items, download each (Bearer-authenticated),
 *                          ingest into the library, then delete the session.
 *
 * OAuth2 becomes active once `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set; without
 * them the module reports `configured: false` and the rest of the server runs unaffected.
 */

import {
  getGoogleTokens,
  setGoogleTokens,
  getConfig,
  setConfig,
  addItem,
} from '../store.js';
import { ingestImage } from '../media/images.js';
import { ingestVideo } from '../media/video.js';
import { enqueueTranscode } from '../media/transcode.js';
import { hub } from '../hub.js';
import { refresh } from '../slideshow.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:9095/api/google/callback';
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PICKER_API = 'https://photospicker.googleapis.com/v1';

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function isConnected(): boolean {
  return Boolean(getGoogleTokens());
}

/** Build the consent-screen URL the admin opens to connect an account. */
export function authUrl(state = ''): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID ?? '',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange an authorization code for tokens and persist them. */
export async function handleCallback(code: string): Promise<void> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID ?? '',
      client_secret: CLIENT_SECRET ?? '',
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  await setGoogleTokens({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  const cfg = getConfig();
  await setConfig({ ...cfg, googlePhotos: { ...cfg.googlePhotos, connected: true } });
}

/** Disconnect the account (clears stored tokens). */
export async function disconnect(): Promise<void> {
  await setGoogleTokens(undefined);
  const cfg = getConfig();
  await setConfig({ ...cfg, googlePhotos: { ...cfg.googlePhotos, connected: false } });
}

async function accessToken(): Promise<string> {
  const tokens = getGoogleTokens();
  if (!tokens) throw new Error('Google Photos not connected');
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID ?? '',
      client_secret: CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json()) as { access_token: string; expires_in: number };
  await setGoogleTokens({ ...tokens, accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

// --- Picker sessions ---

interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
}

/** Public summary returned to the admin to drive the picker UI. */
export interface PickerSessionInfo {
  id: string;
  pickerUri: string;
  mediaItemsSet: boolean;
  /** Recommended poll interval in milliseconds. */
  pollIntervalMs: number;
}

function toInfo(s: PickerSession): PickerSessionInfo {
  return {
    id: s.id,
    pickerUri: s.pickerUri,
    mediaItemsSet: Boolean(s.mediaItemsSet),
    pollIntervalMs: durationToMs(s.pollingConfig?.pollInterval, 3000),
  };
}

/** Create a Picker session; the user opens `pickerUri` to choose media. */
export async function createSession(): Promise<PickerSessionInfo> {
  const token = await accessToken();
  const res = await fetch(`${PICKER_API}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Picker session create failed: ${res.status}`);
  return toInfo((await res.json()) as PickerSession);
}

/** Poll a Picker session to learn whether the user has finished selecting. */
export async function getSession(id: string): Promise<PickerSessionInfo> {
  const token = await accessToken();
  const res = await fetch(`${PICKER_API}/sessions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Picker session poll failed: ${res.status}`);
  return toInfo((await res.json()) as PickerSession);
}

/** Delete a Picker session (best-effort cleanup). */
export async function deleteSession(id: string): Promise<void> {
  try {
    const token = await accessToken();
    await fetch(`${PICKER_API}/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* ignore cleanup failures */
  }
}

// --- Picked media import ---

interface PickedMediaItem {
  id: string;
  type?: string; // 'PHOTO' | 'VIDEO' | 'TYPE_UNSPECIFIED'
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  };
}

async function listPickedItems(sessionId: string): Promise<PickedMediaItem[]> {
  const token = await accessToken();
  const items: PickedMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${PICKER_API}/mediaItems`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const json = (await res.json()) as { mediaItems?: PickedMediaItem[]; nextPageToken?: string };
    items.push(...(json.mediaItems ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return items;
}

/** Download one picked item at full resolution and ingest it into the library. */
async function importPicked(m: PickedMediaItem): Promise<void> {
  const file = m.mediaFile;
  if (!file?.baseUrl) throw new Error('picked item missing baseUrl');
  const isVideo = m.type === 'VIDEO' || Boolean(file.mimeType?.startsWith('video/'));
  // Picker baseUrls require the OAuth bearer token and a download suffix (=d photo, =dv video).
  const token = await accessToken();
  const res = await fetch(`${file.baseUrl}=${isVideo ? 'dv' : 'd'}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${file.filename ?? m.id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = file.filename ?? `${m.id}.${isVideo ? 'mp4' : 'jpg'}`;
  const { item } = isVideo
    ? await ingestVideo(buf, filename.split('.').pop() ?? 'mp4', 'google-photos', filename)
    : await ingestImage(buf, 'google-photos', filename);
  await addItem(item);
  enqueueTranscode(item);
}

/**
 * Import all items the user picked in a session, then delete the session.
 * Returns the number of items successfully imported.
 */
export async function importSession(sessionId: string): Promise<number> {
  const picked = await listPickedItems(sessionId);
  let imported = 0;
  for (const m of picked) {
    try {
      await importPicked(m);
      imported++;
    } catch (err) {
      hub.emitEvent({ type: 'log', level: 'warn', message: `Google import skipped: ${(err as Error).message}` });
    }
  }
  if (imported) {
    const cfg = getConfig();
    await setConfig({ ...cfg, googlePhotos: { ...cfg.googlePhotos, lastImportAt: Date.now() } });
    refresh();
    hub.emitEvent({ type: 'log', level: 'info', message: `Google Photos import added ${imported} item(s)` });
  }
  await deleteSession(sessionId);
  return imported;
}

/** Parse a protobuf Duration string (e.g. "3s", "2.5s") to milliseconds. */
function durationToMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value.endsWith('s') ? value.slice(0, -1) : value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallback;
}
