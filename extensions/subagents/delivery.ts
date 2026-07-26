/** One-shot deferred delivery of subagent completion messages. */
export class ResultDelivery<T> {
  private pending = new Map<string, T>();

  enqueue(id: string, value: T) {
    this.pending.set(id, value);
  }

  take(id: string) {
    const value = this.pending.get(id);
    if (value === undefined) return undefined;
    this.pending.delete(id);
    return value;
  }

  consume(ids: readonly string[]) {
    for (const id of ids) this.pending.delete(id);
  }

  drainAll() {
    const out: Array<{ id: string; value: T }> = [];
    for (const [id, value] of this.pending) out.push({ id, value });
    this.pending.clear();
    return out;
  }

  clear() {
    this.pending.clear();
  }
}
