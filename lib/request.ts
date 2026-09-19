/** Bound the whole response, including body reads when a transport fails to settle on abort. */
export function withAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function fetchJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ response: Response; data: any }> {
  return withAbort(async () => {
    const response = await fetch(url, { ...init, signal });
    const data = await response.json().catch((error) => {
      if (response.ok) throw error;
      // Intermediaries can return HTML errors; callers still need the HTTP status.
      return null;
    });
    return { response, data };
  }, signal);
}
