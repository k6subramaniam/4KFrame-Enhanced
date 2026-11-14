/** A shuffle bag with bounded navigation history. Repaints never reshuffle the bag. */
export class ShuffleRotation {
  private known = new Set<string>();
  private remaining: string[] = [];
  private history: string[] = [];
  private cursor = -1;
  constructor(private readonly random: () => number = Math.random) {}

  reset(): void {
    this.known.clear(); this.remaining = []; this.history = []; this.cursor = -1;
  }

  private shuffled(ids: string[]): string[] {
    const result = [...ids];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }

  step(ids: string[], current: string | undefined, delta: number): string | undefined {
    const eligible = new Set(ids);
    if (!eligible.size) { this.reset(); return undefined; }
    const additions = ids.filter((id) => !this.known.has(id));
    this.remaining = this.remaining.filter((id) => eligible.has(id));
    if (additions.length) this.remaining = this.shuffled([...this.remaining, ...additions]);
    this.known = eligible;
    const before = this.history.slice(0, this.cursor + 1).filter((id) => eligible.has(id));
    this.history = [...before, ...this.history.slice(this.cursor + 1).filter((id) => eligible.has(id))];
    this.cursor = before.length - 1;
    // A manual cast becomes the current entry without losing Previous navigation.
    if (current && eligible.has(current) && this.history[this.cursor] !== current) {
      this.history = [...this.history.slice(0, this.cursor + 1), current];
      this.cursor = this.history.length - 1;
      this.remaining = this.remaining.filter((id) => id !== current);
    }
    if (delta < 0 && this.cursor >= 0) {
      this.cursor = Math.max(0, this.cursor - 1);
      return this.history[this.cursor];
    }
    if (this.cursor + 1 < this.history.length) return this.history[++this.cursor];
    if (!this.remaining.length) this.remaining = this.shuffled(ids);
    // Do not repeat the last item immediately when a fresh cycle begins.
    if (this.remaining.length > 1 && this.remaining[0] === current) {
      [this.remaining[0], this.remaining[1]] = [this.remaining[1]!, this.remaining[0]!];
    }
    const next = this.remaining.shift()!;
    this.history.push(next);
    if (this.history.length > 1024) this.history.shift();
    this.cursor = this.history.length - 1;
    return next;
  }
}
