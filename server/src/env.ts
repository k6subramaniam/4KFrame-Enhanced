import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from '@4kframe/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root directory for all runtime data (media + database). Override with FRAME_DATA_DIR. */
export const DATA_DIR = process.env.FRAME_DATA_DIR
  ? path.resolve(process.env.FRAME_DATA_DIR)
  : path.resolve(__dirname, '../../data');

export const MEDIA_DIR = path.join(DATA_DIR, 'photos');
export const DB_FILE = path.join(DATA_DIR, 'frame.json');

/** Where the built display & admin SPAs are served from, if present. */
export const DISPLAY_DIST = path.resolve(__dirname, '../../display/dist');
export const ADMIN_DIST = path.resolve(__dirname, '../../admin/dist');

// Note: empty-string env values (which `.env` / compose interpolation can produce) are
// treated as "unset" via `||`, so they fall back to defaults rather than breaking.
export const HTTP_PORT = Number(process.env.FRAME_HTTP_PORT) || DEFAULT_HTTP_PORT;
export const HTTPS_PORT = Number(process.env.FRAME_HTTPS_PORT) || DEFAULT_HTTPS_PORT;
export const HOST = process.env.FRAME_HOST || '0.0.0.0';

/** Smart Face Match is opt-in and disabled by default. */
export function faceMatchEnabled(): boolean {
  return process.env.FRAME_ENABLE_FACE_MATCH === '1';
}

/** HTTPS is served on {@link HTTPS_PORT} unless explicitly disabled. */
export const HTTPS_ENABLED = process.env.FRAME_DISABLE_HTTPS !== '1';
/** TLS material. Point these at your own cert/key, or leave unset to auto self-sign. */
export const TLS_CERT_FILE = process.env.FRAME_TLS_CERT || path.join(DATA_DIR, 'cert.pem');
export const TLS_KEY_FILE = process.env.FRAME_TLS_KEY || path.join(DATA_DIR, 'key.pem');

/** Best-effort LAN IPv4 address (used for the QR code and the cert's SAN). */
export function detectLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/** Best-effort LAN address used for the QR code and `lanAddress` config field. */
export function detectLanAddress(port: number = HTTP_PORT): string {
  const ip = detectLanIp();
  return ip ? `http://${ip}:${port}` : `http://localhost:${port}`;
}
