import type { ControlMessage } from '@4kframe/shared';

export class DisplayActivityTracker {
  private presentationId = '';
  private pending = new Set<string>();
  private confirmed = new Set<string>();
  constructor(private readonly send: (message: ControlMessage) => void) {}
  begin(id: string | undefined): void {
    if (id === this.presentationId) return;
    this.presentationId = id ?? '';
    this.pending.clear();
    this.confirmed.clear();
  }
  rendered(ids: string[], presentationId: string | undefined): void {
    if (!presentationId || presentationId !== this.presentationId) return;
    for (const id of ids) if (!this.confirmed.has(id)) this.pending.add(id);
    this.retry();
  }
  acknowledge(presentationId: string, ids: string[]): void {
    if (presentationId !== this.presentationId) return;
    for (const id of ids) { this.pending.delete(id); this.confirmed.add(id); }
  }
  retry(): void {
    if (this.presentationId && this.pending.size) this.send({ type: 'mediaViewed', presentationId: this.presentationId, ids: [...this.pending].slice(0, 2) });
  }
}
