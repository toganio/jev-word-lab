export async function database(): Promise<D1Database> {
  const { env } = await import('cloudflare:workers');
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error('Experiment database is unavailable.');
  return db;
}
