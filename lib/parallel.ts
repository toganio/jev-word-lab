/** Account limits are dynamic; 95% of the documented TPS and 19 requests/second are local ceilings.
 * https://docs.typesafe.ai/models and https://docs.typesafe.ai/api#handling-rate-limits
 */
export const DEFAULT_CONCURRENCY = 64;
export const MAX_CONCURRENCY = 96;
export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.max(0, ms),
    );
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
export class RequestPacer {
  private tail: Promise<void> = Promise.resolve();
  private next = 0;
  private cooldown = 0;
  private tokensPerByte = 0.5;
  private scale = 1;
  private successes = 0;
  private samples: { at: number; tokens: number }[] = [];
  observe(bytes: number, tokens: number) {
    if (bytes > 0 && Number.isFinite(tokens) && tokens >= 0) {
      const ratio = tokens / bytes;
      this.tokensPerByte = Math.max(
        ratio,
        this.tokensPerByte * 0.7 + ratio * 0.3,
      );
      this.samples.push({ at: this.now(), tokens });
    }
    if (++this.successes >= 16) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.successes = 0;
    }
  }
  telemetry() {
    const cutoff = this.now() - 5000;
    this.samples = this.samples.filter((s) => s.at > cutoff);
    return {
      tokensPerSecond: Math.round(
        this.samples.reduce((n, s) => n + s.tokens, 0) / 5,
      ),
      targetTokensPerSecond: Math.round(237500 * this.scale),
    };
  }
  constructor(
    private now = () => Date.now(),
    private wait = abortableDelay,
  ) {}
  pause(ms: number) {
    if (this.now() >= this.cooldown)
      this.scale = Math.max(0.1, this.scale * 0.7);
    this.cooldown = Math.max(this.cooldown, this.now() + ms);
    this.successes = 0;
  }
  acquire(inputBytes: number, signal: AbortSignal) {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        for (;;) {
          const delay = Math.max(this.next, this.cooldown) - this.now();
          if (delay <= 0) break;
          await this.wait(delay, signal);
        }
        signal.throwIfAborted();
        // Conservative English-input estimate, not an official tokenizer.
        const estimatedTokens = Math.ceil(inputBytes * this.tokensPerByte);
        this.next =
          this.now() +
          Math.max(
            1000 / (19 * this.scale),
            (estimatedTokens / (237500 * this.scale)) * 1000,
          );
      });
    this.tail = task;
    return task;
  }
}
export async function retryThrottled<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onBackoff: (ms: number, attempt: number) => void,
  wait = abortableDelay,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        ![408, 429, 503, 504, 529].includes(error.status) ||
        attempt >= 3 ||
        signal.aborted
      )
        throw error;
      const ms = Math.max(error.retryAfterMs, 1000 * 2 ** attempt);
      onBackoff(ms, attempt + 1);
      await wait(ms, signal);
    }
  }
}
