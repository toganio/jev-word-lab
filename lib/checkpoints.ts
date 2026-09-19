import type { CategoryMap } from './categories';
type Checkpoint = {
  result: CategoryMap;
  resolve: () => void;
  reject: (e: unknown) => void;
};
/** Coalesce cumulative snapshots; overlap at most two disjoint database writes.
 * A word cannot have concurrent writes, and callers wait for durable storage.
 */
export class CategoryCheckpoints {
  private queue: Checkpoint[] = [];
  private locked = new Set<string>();
  private active = 0;
  private scheduled = false;
  constructor(private write: (result: CategoryMap) => Promise<void>) {}
  save(result: CategoryMap): Promise<void> {
    if (Object.keys(result).length > 100)
      return Promise.reject(new Error('Checkpoint exceeds 100 words'));
    return new Promise((resolve, reject) => {
      this.queue.push({ result, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        setTimeout(() => {
          this.scheduled = false;
          this.drain();
        }, 25);
      }
    });
  }
  private drain() {
    while (this.active < 2 && this.queue.length) {
      const batch: Checkpoint[] = [],
        merged: CategoryMap = {};
      const blocked = new Set(this.locked);
      // A skipped older snapshot also blocks its words from being overtaken.
      for (let i = 0; i < this.queue.length;) {
        const next = this.queue[i],
          keys = Object.keys(next.result);
        if (
          keys.some((w) => blocked.has(w)) ||
          new Set([...Object.keys(merged), ...keys]).size > 100
        ) {
          keys.forEach((w) => blocked.add(w));
          i++;
          continue;
        }
        batch.push(this.queue.splice(i, 1)[0]);
        Object.assign(merged, next.result);
      }
      if (!batch.length) return;
      const keys = Object.keys(merged);
      keys.forEach((w) => this.locked.add(w));
      this.active++;
      void Promise.resolve()
        .then(() => this.write(merged))
        .then(
          () => batch.forEach((item) => item.resolve()),
          (error) => batch.forEach((item) => item.reject(error)),
        )
        .finally(() => {
          keys.forEach((w) => this.locked.delete(w));
          this.active--;
          this.drain();
        });
    }
  }
}
