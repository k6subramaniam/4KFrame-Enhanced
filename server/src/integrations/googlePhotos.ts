/**
 * Google Photos integration.
 *
 * Supports BOTH usage modes requested:
 *   - Manual import: list albums / recent media and import selected items on demand.
 *   - Auto-sync: a scheduled worker pulls new media from selected albums.
 *
 * The OAuth2 + Library API calls are implemented for real and become active once
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are provided in the environment.
 * Without credentials the module reports `configured: false` so the admin UI can guide
 * the user through setup, and the rest of the server runs unaffected.
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
import { hub } from '../hub.js';
import { refresh } from '../slideshow.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:9095/api/google/callback';
const SCOPE = 'https://www.googleapis.com/auth/photoslibrary.readonly';
const API = 'https://photoslibrary.googleapis.com/v1';

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

export interface GoogleAlbum {
  id: string;
  title: string;
  mediaItemsCount?: string;
  coverPhotoBaseUrl?: string;
}

export async function listAlbums(): Promise<GoogleAlbum[]> {
  const token = await accessToken();
  const albums: GoogleAlbum[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/albums`);
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const json = (await res.json()) as { albums?: GoogleAlbum[]; nextPageToken?: string };
    albums.push(...(json.albums ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return albums;
}

interface GoogleMediaItem {
  id: string;
  baseUrl: string;
  mimeType: string;
  filename: string;
  mediaMetadata?: { width?: string; height?: string };
}

async function mediaItemsForAlbum(albumId: string): Promise<GoogleMediaItem[]> {
  const token = await accessToken();
  const items: GoogleMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch(`${API}/mediaItems:search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ albumId, pageSize: 100, pageToken }),
    });
    if (!res.ok) break;
    const json = (await res.json()) as { mediaItems?: GoogleMediaItem[]; nextPageToken?: string };
    items.push(...(json.mediaItems ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return items;
}

/** Download a Google media item at full resolution and ingest it into the library. */
async function importMediaItem(m: GoogleMediaItem): Promise<void> {
  const isVideo = m.mimeType.startsWith('video/');
  // `=d` downloads the original bytes; `=w<n>-h<n>` would size an image.
  const downloadUrl = isVideo ? `${m.baseUrl}=dv` : `${m.baseUrl}=d`;
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed for ${m.filename}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { item } = isVideo
    ? await ingestVideo(buf, m.filename.split('.').pop() ?? 'mp4', 'google-photos', m.filename)
    : await ingestImage(buf, 'google-photos', m.filename);
  await addItem(item);
}

/** Import a specific set of media items (manual import flow). */
export async function importItems(items: GoogleMediaItem[]): Promise<number> {
  let n = 0;
  for (const m of items) {
    try {
      await importMediaItem(m);
      n++;
    } catch (err) {
      hub.emitEvent({ type: 'log', level: 'warn', message: `Google import skipped: ${(err as Error).message}` });
    }
  }
  if (n) refresh();
  return n;
}

/** Run one auto-sync pass over the configured albums. */
export async function syncAlbums(): Promise<number> {
  if (!isConnected()) return 0;
  const cfg = getConfig();
  let imported = 0;
  for (const albumId of cfg.googlePhotos.syncAlbumIds) {
    const media = await mediaItemsForAlbum(albumId);
    imported += await importItems(media);
  }
  await setConfig({ ...cfg, googlePhotos: { ...cfg.googlePhotos, lastSyncAt: Date.now() } });
  return imported;
}

let syncTimer: NodeJS.Timeout | undefined;

/** Start the background auto-sync worker honouring the configured interval. */
export function startSyncWorker(): void {
  const tick = async () => {
    const cfg = getConfig();
    const minutes = cfg.googlePhotos.syncIntervalMinutes;
    if (isConnected() && minutes > 0 && cfg.googlePhotos.syncAlbumIds.length) {
      try {
        const n = await syncAlbums();
        if (n) hub.emitEvent({ type: 'log', level: 'info', message: `Google Photos sync imported ${n} item(s)` });
      } catch (err) {
        hub.emitEvent({ type: 'log', level: 'error', message: `Google Photos sync failed: ${(err as Error).message}` });
      }
    }
    const next = Math.max(1, getConfig().googlePhotos.syncIntervalMinutes || 60);
    syncTimer = setTimeout(tick, next * 60_000);
  };
  // First pass shortly after boot, then on the configured cadence.
  syncTimer = setTimeout(tick, 10_000);
}

export function stopSyncWorker(): void {
  if (syncTimer) clearTimeout(syncTimer);
}

export type { GoogleMediaItem };
