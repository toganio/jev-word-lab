import type { CategoryMap } from './categories';

/** Coalesce concurrent workers into bounded, idempotent database writes.
 * Each caller waits for durable storage; failure never silently acknowledges data.
 */
export class CategoryCheckpoints {
  private queue: {
    result: CategoryMap;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  private running = false;
  constructor(private write: (result: CategoryMap) => Promise<void>) {}
  save(result: CategoryMap): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ result, resolve, reject });
      if (!this.running) {
        this.running = true;
        setTimeout(() => void this.drain(), 25);
      }
    });
  }
  private async drain() {
    while (this.queue.length) {
      const batch: typeof this.queue = [];
      const merged: CategoryMap = {};
      while (this.queue.length) {
        const next = this.queue[0];
        if (Object.keys(merged).length + Object.keys(next.result).length > 100)
          break;
        batch.push(this.queue.shift()!);
        Object.assign(merged, next.result);
      }
      try {
        if (!batch.length) throw new Error('Checkpoint exceeds 100 words');
        await this.write(merged);
        batch.forEach((item) => item.resolve());
      } catch (error) {
        [...batch, ...this.queue.splice(0)].forEach((item) =>
          item.reject(error),
        );
      }
    }
    this.running = false;
  }
}
