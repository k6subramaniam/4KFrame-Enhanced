/**
 * TLS material for the HTTPS listener.
 *
 * Resolution order:
 *   1. An existing key/cert pair at {@link TLS_KEY_FILE} / {@link TLS_CERT_FILE} (either a
 *      cert you supplied via FRAME_TLS_CERT/KEY, or one generated on a previous boot).
 *   2. Otherwise, auto-generate a long-lived self-signed cert with `openssl` (the same
 *      external-binary approach used for ffmpeg). Browsers will warn on a self-signed cert;
 *      supply your own for a trusted setup.
 *
 * If no cert exists and `openssl` is unavailable, returns null and HTTPS is skipped — HTTP
 * keeps working regardless.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { TLS_CERT_FILE, TLS_KEY_FILE } from './env.js';

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
}

/** Load existing TLS material, generating a self-signed cert if necessary. */
export async function loadOrCreateTls(sanIps: string[]): Promise<TlsMaterial | null> {
  const existing = await read();
  if (existing) return existing;
  const generated = await generateSelfSigned(sanIps);
  return generated ? read() : null;
}

async function read(): Promise<TlsMaterial | null> {
  try {
    const [key, cert] = await Promise.all([
      fs.readFile(TLS_KEY_FILE),
      fs.readFile(TLS_CERT_FILE),
    ]);
    return { key, cert };
  } catch {
    return null;
  }
}

/** Generate a self-signed cert/key into the configured paths. Resolves false on failure. */
async function generateSelfSigned(sanIps: string[]): Promise<boolean> {
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...sanIps.map((ip) => `IP:${ip}`)]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(',');
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', TLS_KEY_FILE,
    '-out', TLS_CERT_FILE,
    '-days', '3650',
    '-subj', '/CN=4kframe',
    '-addext', `subjectAltName=${san}`,
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('openssl', args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
