/**
 * One-shot deferred delivery of terminal completion messages.
 * Settle handlers enqueue; consumers drain. First drain wins.
 */
export class ResultDelivery<T> {
  private pending = new Map<string, T>();

  enqueue(id: string, value: T) {
    this.pending.set(id, value);
  }

  /** Remove and return one pending item, or undefined. */
  take(id: string): T | undefined {
    const value = this.pending.get(id);
    if (value === undefined) return undefined;
    this.pending.delete(id);
    return value;
  }

  /** Drop pending items without returning them (e.g. after bg_kill collected results). */
  consume(ids: readonly string[]) {
    for (const id of ids) {
      this.pending.delete(id);
    }
  }

  drainAll(): Array<{ id: string; value: T }> {
    const out: Array<{ id: string; value: T }> = [];
    for (const [id, value] of this.pending) {
      out.push({ id, value });
    }
    this.pending.clear();
    return out;
  }

  clear() {
    this.pending.clear();
  }
}
