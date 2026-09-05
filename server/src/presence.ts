/** Lightweight display heartbeat used by the admin dashboard. */

let lastDisplayHeartbeatAt = 0;

export function reportDisplayHeartbeat(): void {
  lastDisplayHeartbeatAt = Date.now();
}

export function getDisplayPresence(now = Date.now()): { online: boolean; lastSeenAt: number | null } {
  const lastSeenAt = lastDisplayHeartbeatAt || null;
  return {
    online: Boolean(lastSeenAt && now - lastSeenAt < 15_000),
    lastSeenAt,
  };
}
