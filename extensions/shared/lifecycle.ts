/**
 * Tracks how many active waiters (wait/cancel/kill) still care about an id's
 * settled result, so async completion delivery can skip ids already consumed
 * by an explicit waiter. Shared by every manager pairing a wait-for-settle
 * path with async push notifications (subagents, background terminals,
 * workflows).
 */
export class InterestTracker {
  private counts = new Map<string, number>();

  add(id: string) {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  release(id: string) {
    const n = (this.counts.get(id) ?? 0) - 1;
    if (n <= 0) this.counts.delete(id);
    else this.counts.set(id, n);
  }

  has(id: string): boolean {
    return (this.counts.get(id) ?? 0) > 0;
  }

  clear() {
    this.counts.clear();
  }
}

/**
 * Evict the oldest settled entries once they exceed maxTracked. Shared prune
 * policy for every manager that retains a bounded history of finished work.
 */
export function pruneSettled<E extends { id: string; settledAt?: number }>(
  entries: Map<string, E>,
  maxTracked: number,
  isRunning: (entry: E) => boolean,
  onEvict?: (entry: E) => void,
) {
  const settled = [...entries.values()]
    .filter((e) => !isRunning(e))
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  while (settled.length > maxTracked) {
    const oldest = settled.shift();
    if (!oldest) break;
    entries.delete(oldest.id);
    onEvict?.(oldest);
  }
}
