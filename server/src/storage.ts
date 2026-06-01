/**
 * Storage statistics for the media directory, surfaced as `storageUsed` / `storageFree`
 * (bytes) in the config payload — mirroring the original frame's storage display.
 */

import { promises as fs } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR } from './env.js';

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export async function computeStorage(): Promise<{ used: number; free: number }> {
  const used = await dirSize(MEDIA_DIR);
  let free = 0;
  try {
    const fsStats = await statfs(MEDIA_DIR);
    free = fsStats.bavail * fsStats.bsize;
  } catch {
    free = 0;
  }
  return { used, free };
}
