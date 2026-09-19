import { validateRequest, validateResponse } from '../../../lib/protocol';
export async function POST(request: Request) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  const fail = (error: string, status = 400) =>
    Response.json({ error }, { status, headers });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return fail(
      'Bu istek yalnızca uygulamanın kendi sayfasından gönderilebilir.',
      403,
    );
  const key = request.headers.get('x-typesafe-key')?.trim();
  if (!key || key.length < 8 || key.length > 1024 || /[\r\n]/.test(key))
    return fail('Geçerli bir TypeSafe API anahtarı gir.', 401);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 180000) return fail('İstek çok büyük.', 413);
    body = JSON.parse(raw);
    validateRequest(body);
  } catch {
    return fail('Geçersiz seçim isteği. Her soru 2–255 seçenek içermeli.');
  }
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
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
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'API anahtarı kabul edilmedi. TypeSafe anahtarını kontrol et.',
        402: 'TypeSafe bakiyesi yetersiz.',
        403: 'Bu anahtarın Jev erişimi yok.',
        422: 'TypeSafe isteği kabul etmedi. Daha küçük bir sözlük veya grup genişliği dene.',
        429: 'TypeSafe istek sınırına ulaşıldı. Biraz bekleyip tekrar dene.',
        529: 'TypeSafe şu anda yoğun. Biraz sonra tekrar dene.',
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
            `TypeSafe isteği başarısız (${response.status}).`,
          retryAfterMs,
        },
        { status: response.status, headers },
      );
    }
    const data = await response.json();
    validateResponse(data, body.questions);
    if (!/^jev(?:[-.:]|$)/i.test(data.model))
      return fail(
        'Beklenmeyen model yanıtı. Bu uygulama yalnızca Jev kullanır.',
        502,
      );
    return Response.json(data, { headers });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError')
    )
      return fail('İstek zaman aşımına uğradı veya durduruldu.', 504);
    return fail(
      'TypeSafe bağlantısı veya yanıtı doğrulanamadı. Tekrar deneyebilirsin.',
      502,
    );
  }
}
