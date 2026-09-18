import type { RunRecord, RecordedOperation, RunStatus } from './run-record';
import type { Step } from './types';
export type SaveStatus = 'saving' | 'saved' | 'failed';
export class RunRecorder {
  private record: RunRecord;
  private dirty = true;
  private pending: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval>;
  constructor(
    record: RunRecord,
    private notify: (status: SaveStatus) => void,
  ) {
    this.record = record;
    this.interval = setInterval(() => void this.flush(), 2000);
    void this.flush();
  }
  patch(patch: Partial<RunRecord>) {
    this.record = { ...this.record, ...patch };
    this.dirty = true;
  }
  step(step: Step, answer: string) {
    this.patch({ steps: [...this.record.steps, step], answer });
  }
  operation(operation: RecordedOperation) {
    const found = this.record.operations.some((o) => o.id === operation.id);
    this.patch({
      operations: found
        ? this.record.operations.map((o) =>
            o.id === operation.id ? operation : o,
          )
        : [...this.record.operations.slice(-399), operation],
    });
  }
  private async flush(): Promise<void> {
    if (this.pending) {
      await this.pending;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.record.revision++;
    const payload = JSON.stringify(this.record);
    this.notify('saving');
    const task = (async () => {
      try {
        const r = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error('Save failed');
        this.notify('saved');
      } catch {
        this.dirty = true;
        this.notify('failed');
      }
    })();
    this.pending = task;
    await task;
    if (this.pending === task) this.pending = null;
  }
  async finish(status: RunStatus, reason: string) {
    clearInterval(this.interval);
    this.patch({ status, reason });
    await this.flush();
  }
}
