import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(join(root, 'drizzle')))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const statements = (
  await Promise.all(
    files.map((file) => readFile(join(root, 'drizzle', file), 'utf8')),
  )
)
  .join('\n')
  .replaceAll('--> statement-breakpoint', '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
// These initial migrations only create tables and indexes. Replaying them
// locally must preserve existing data. Future schema alterations need a real
// migration path rather than silent rewriting here.
if (statements.some((s) => !/^CREATE (TABLE|INDEX) /i.test(s)))
  throw new Error('Local bootstrap needs updating for a non-CREATE migration.');
const sql = statements
  .map(
    (s) =>
      s.replace(/^CREATE (TABLE|INDEX) /i, 'CREATE $1 IF NOT EXISTS ') + ';',
  )
  .join('\n');
await mkdir(join(root, '.wrangler'), { recursive: true });
const file = join(root, '.wrangler/local-bootstrap.sql');
await writeFile(file, sql);
const require = createRequire(import.meta.url);
const wrangler = join(
  dirname(require.resolve('wrangler/package.json')),
  'bin/wrangler.js',
);
const result = spawnSync(
  process.execPath,
  [
    wrangler,
    'd1',
    'execute',
    'DB',
    '--local',
    '--config',
    'wrangler.local.json',
    '--file',
    file,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(root, '.wrangler/logs'),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
