import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FrameBackup } from '@4kframe/shared';
import { DATA_DIR } from './env.js';
import { createSafeBackup } from './store.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_SNAPSHOTS = 7;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastSnapshotAt: number | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function filename(timestamp: number, label: string): string {
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${label.replace(/[^a-z0-9_-]+/gi, '-')}.json`;
}

async function trimSnapshots(): Promise<void> {
  const files = await fs.readdir(BACKUP_DIR).catch(() => []);
  const json = files.filter((name) => name.endsWith('.json')).sort().reverse();
  await Promise.all(json.slice(MAX_SNAPSHOTS).map((name) => fs.rm(path.join(BACKUP_DIR, name)).catch(() => undefined)));
}

export async function writeBackupSnapshot(label = 'auto'): Promise<FrameBackup> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const backup = createSafeBackup();
  const target = path.join(BACKUP_DIR, filename(backup.exportedAt, label));
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(backup, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
  lastSnapshotAt = backup.exportedAt;
  await trimSnapshots();
  return backup;
}

export function getLastBackupSnapshotAt(): number | null {
  return lastSnapshotAt;
}

export function startBackupSnapshots(): void {
  if (timer) return;
  void writeBackupSnapshot('startup').catch(() => undefined);
  timer = setInterval(() => {
    void writeBackupSnapshot('auto').catch(() => undefined);
  }, SNAPSHOT_INTERVAL_MS);
}
