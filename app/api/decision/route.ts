import { validateRequest, validateResponse } from '../../../lib/protocol';
import { withAbort } from '../../../lib/request';
export async function POST(request: Request) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  const fail = (error: string, status = 400) =>
    Response.json({ error }, { status, headers });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return fail('Requests must originate from this site.', 403);
  const key = request.headers.get('x-typesafe-key')?.trim();
  if (!key || key.length < 8 || key.length > 1024 || /[\r\n]/.test(key))
    return fail('Enter a valid TypeSafe API key.', 401);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 180000) return fail('Request too large.', 413);
    body = JSON.parse(raw);
    validateRequest(body);
  } catch {
    return fail('Invalid choice request. Each question needs 2–255 options.');
  }
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    const response = await withAbort(
      () =>
        fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'jev-latest',
            state: body.state,
            questions: body.questions,
          }),
          signal,
        }),
      signal,
    );
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'API key rejected. Check your TypeSafe key.',
        402: 'Insufficient TypeSafe balance.',
        403: 'This key does not have Jev access.',
        422: 'TypeSafe rejected the request. Try fewer retained paths.',
        429: 'TypeSafe rate limit reached. Wait and try again.',
        529: 'TypeSafe is overloaded. Try again shortly.',
      };
      const retry = response.headers.get('retry-after');
      const seconds = retry === null ? NaN : Number(retry);
      const retryAfterMs =
        retry === null
          ? 0
          : Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retry) - Date.now()) || 0;
      return Response.json(
        {
          error:
            messages[response.status] ||
            `TypeSafe request failed (${response.status}).`,
          retryAfterMs,
        },
        { status: response.status, headers },
      );
    }
    const data = await withAbort(() => response.json(), signal);
    validateResponse(data, body.questions);
    if (!/^jev(?:[-.:]|$)/i.test(data.model))
      return fail(
        'Unexpected model response. This application only uses Jev.',
        502,
      );
    return Response.json(data, { headers });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError')
    )
      return fail('Request timed out or was cancelled.', 504);
    return fail(
      'Could not validate the TypeSafe connection or response. Try again.',
      502,
    );
  }
}
