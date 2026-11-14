import type { InteractionKind, MediaActivityUpdate } from '@4kframe/shared';

function eventId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : `event_${Date.now().toString(36)}_${Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('')}`;
}

/** Batches large selections; one retry reuses the same receipt, never a new increment. */
export async function recordInteraction(ids: string[], kind: InteractionKind): Promise<MediaActivityUpdate[]> {
  const unique = [...new Set(ids)];
  const updates: MediaActivityUpdate[] = [];
  for (let at = 0; at < unique.length; at += 500) {
    const body = JSON.stringify({ ids: unique.slice(at, at + 500), kind, eventId: eventId() });
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      let response: Response;
      try {
        response = await fetch('/api/media/activity', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
        });
      } catch (error) {
        if (attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new Error(`Activity was not saved (${response.status}).`);
      }
      const result = await response.json() as { updates: MediaActivityUpdate[] };
      updates.push(...result.updates);
      saved = true;
    }
  }
  return updates;
}
