import { database } from '../../../lib/db';
import { TAXONOMY_VERSION, AXES, isComplete } from '../../../lib/categories';
import {
  SOURCE_SHA256,
  EXPECTED_WORDS,
  validateDictionaryCategories,
} from '../../../lib/category-coverage';
const headers = { 'Cache-Control': 'no-store' };
type Session = {
  id: string;
  taxonomy_version: string;
  source_sha256: string;
  origin: string;
};
const fail = (error: string, status = 400) =>
  Response.json({ error }, { status, headers });
async function getSession(db: D1Database, id?: string | null) {
  return id
    ? db
        .prepare('SELECT * FROM category_sessions WHERE id = ?')
        .bind(id)
        .first<Session>()
    : db
        .prepare(
          'SELECT * FROM category_sessions WHERE taxonomy_version = ? AND source_sha256 = ? ORDER BY created_at DESC LIMIT 1',
        )
        .bind(TAXONOMY_VERSION, SOURCE_SHA256)
        .first<Session>();
}
async function summary(db: D1Database, s: Session | null) {
  const row = s
    ? await db
        .prepare(
          'SELECT COUNT(*) AS stored,SUM(complete) AS completed,SUM(scanned_count) AS scanned FROM category_results WHERE session_id = ?',
        )
        .bind(s.id)
        .first<{ stored: number; completed: number; scanned: number }>()
    : null;
  const verifiedCount = row?.completed || 0,
    scannedCells = row?.scanned || 0;
  return {
    version: TAXONOMY_VERSION,
    sessionId: s?.id || null,
    origin: s?.origin || null,
    expectedCount: EXPECTED_WORDS.length,
    expectedCells: EXPECTED_WORDS.length * AXES.length,
    verifiedCount,
    scannedCells,
    missingCount: EXPECTED_WORDS.length - verifiedCount,
    complete:
      verifiedCount === EXPECTED_WORDS.length &&
      scannedCells === EXPECTED_WORDS.length * AXES.length,
    sourceSha256: SOURCE_SHA256,
  };
}
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      db = await database();
    const s = await getSession(db, url.searchParams.get('session'));
    if (
      s &&
      (s.taxonomy_version !== TAXONOMY_VERSION ||
        s.source_sha256 !== SOURCE_SHA256)
    )
      return fail('Kategori oturumu eşleşmiyor.', 409);
    if (url.searchParams.get('status') === '1')
      return Response.json(await summary(db, s), { headers });
    const cursor = url.searchParams.get('after') || '';
    const rows = s
      ? (
          await db
            .prepare(
              'SELECT word,assignment_json FROM category_results WHERE session_id = ? AND word > ? ORDER BY word LIMIT 1000',
            )
            .bind(s.id, cursor)
            .all<{ word: string; assignment_json: string }>()
        ).results
      : [];
    const categories = validateDictionaryCategories(
      Object.fromEntries(
        rows.map((r) => [r.word, JSON.parse(r.assignment_json)]),
      ),
    );
    return Response.json(
      {
        ...(await summary(db, s)),
        categories,
        nextCursor: rows.length === 1000 ? rows.at(-1)!.word : null,
      },
      { headers },
    );
  } catch {
    return fail('Kategori oturumu yüklenemedi veya doğrulanamadı.', 503);
  }
}
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return fail('İstek kaynağı geçersiz.', 403);
  let input, categories;
  try {
    const raw = await request.text();
    if (raw.length > 100000) throw new Error();
    input = JSON.parse(raw);
    if (
      input.version !== TAXONOMY_VERSION ||
      input.sourceSha256 !== SOURCE_SHA256
    )
      throw new Error();
    if (input.action !== 'start') {
      categories = validateDictionaryCategories(input.categories, 100);
      if (
        !Object.keys(categories).length ||
        typeof input.sessionId !== 'string'
      )
        throw new Error();
    }
  } catch {
    return fail('Kategori kaydı geçersiz.');
  }
  try {
    const db = await database();
    if (input.action === 'start') {
      const old = input.sessionId
        ? await getSession(db, input.sessionId)
        : null;
      if (
        old &&
        old.taxonomy_version === TAXONOMY_VERSION &&
        old.source_sha256 === SOURCE_SHA256
      )
        return Response.json({ sessionId: old.id }, { headers });
      const id = crypto.randomUUID();
      await db
        .prepare(
          'INSERT INTO category_sessions (id,taxonomy_version,source_sha256,created_at,origin) VALUES (?,?,?,?,?)',
        )
        .bind(
          id,
          TAXONOMY_VERSION,
          SOURCE_SHA256,
          Date.now(),
          input.origin === 'file' ? 'file' : 'jev',
        )
        .run();
      return Response.json({ sessionId: id }, { headers });
    }
    const s = await getSession(db, input.sessionId);
    if (
      !s ||
      s.source_sha256 !== SOURCE_SHA256 ||
      s.taxonomy_version !== TAXONOMY_VERSION
    )
      return fail('Kategori oturumu eşleşmiyor.', 409);
    // All cells are validated before recording. Partial rows are never marked complete.
    // A word only grows in scanned coverage; retries cannot replace a more complete row.
    await db.batch(
      Object.entries(categories!).map(([word, a]) =>
        db
          .prepare(
            'INSERT INTO category_results (id,session_id,word,assignment_json,scanned_count,complete) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET assignment_json=excluded.assignment_json,scanned_count=excluded.scanned_count,complete=excluded.complete WHERE excluded.scanned_count > category_results.scanned_count',
          )
          .bind(
            `${s.id}:${word}`,
            s.id,
            word,
            JSON.stringify(a),
            a.filter(Boolean).length,
            isComplete(a) ? 1 : 0,
          ),
      ),
    );
    return Response.json({ saved: true }, { headers });
  } catch {
    return fail(
      'Kategori oturumu kaydedilemedi. Hazırlığı yeniden deneyebilirsin.',
      503,
    );
  }
}
