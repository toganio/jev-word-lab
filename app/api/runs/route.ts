import { database } from '../../../lib/db';
import { sanitizeRecord } from '../../../lib/run-record';
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return Response.json(
      { error: 'İstek kaynağı geçersiz.' },
      { status: 403, headers },
    );
  let record;
  try {
    const raw = await request.text();
    if (raw.length > 1800000)
      return Response.json(
        { error: 'Kayıt çok büyük.' },
        { status: 413, headers },
      );
    record = sanitizeRecord(JSON.parse(raw));
  } catch {
    return Response.json(
      { error: 'Deneme kaydı geçersiz.' },
      { status: 400, headers },
    );
  }
  try {
    const db = await database();
    await db
      .prepare(`INSERT INTO experiments (id,revision,kind,started_at,updated_at,status,question,answer,reason,app_version,requests,input_tokens,snapshot_json)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,status=excluded.status,answer=excluded.answer,reason=excluded.reason,requests=excluded.requests,input_tokens=excluded.input_tokens,snapshot_json=excluded.snapshot_json
 WHERE excluded.revision > experiments.revision`)
      .bind(
        record.id,
        record.revision,
        record.kind,
        record.startedAt,
        Date.now(),
        record.status,
        record.question,
        record.answer,
        record.reason,
        record.appVersion,
        record.usage.requests,
        record.usage.inputTokens,
        JSON.stringify(record),
      )
      .run();
    return Response.json(
      { saved: true, id: record.id, revision: record.revision },
      { headers },
    );
  } catch {
    return Response.json(
      {
        error:
          'Deneme kaydedilemedi. JSON çıktısını indirerek saklayabilirsin.',
      },
      { status: 503, headers },
    );
  }
}
/** Access is protected by this Site's owner-only platform gate, including API paths. */
export async function GET(request: Request) {
  const url = new URL(request.url),
    id = url.searchParams.get('id');
  try {
    const db = await database();
    if (id) {
      if (!/^[a-f0-9-]{36}$/i.test(id))
        return Response.json(
          { error: 'Geçersiz kayıt.' },
          { status: 400, headers },
        );
      const row = await db
        .prepare(
          'SELECT snapshot_json,updated_at FROM experiments WHERE id = ?',
        )
        .bind(id)
        .first<{ snapshot_json: string; updated_at: number }>();
      if (!row)
        return Response.json(
          { error: 'Kayıt bulunamadı.' },
          { status: 404, headers },
        );
      return Response.json(
        { record: JSON.parse(row.snapshot_json), updatedAt: row.updated_at },
        { headers },
      );
    }
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      return Response.json(
        { error: 'Geçersiz zaman.' },
        { status: 400, headers },
      );
    const data = await db
      .prepare(
        'SELECT id,revision,kind,started_at,updated_at,status,question,answer,reason,app_version,requests,input_tokens FROM experiments WHERE updated_at > ? ORDER BY updated_at ASC,id ASC LIMIT 25',
      )
      .bind(after)
      .all();
    return Response.json({ runs: data.results }, { headers });
  } catch {
    return Response.json(
      { error: 'Kayıtlar okunamadı.' },
      { status: 503, headers },
    );
  }
}
