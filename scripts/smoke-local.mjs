import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const server = spawn(
  process.execPath,
  [
    'node_modules/vinext/dist/cli.js',
    'dev',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4173',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let logs = '';
server.stdout.on('data', (d) => {
  logs += d;
});
server.stderr.on('data', (d) => {
  logs += d;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try {
      const r = await fetch('http://127.0.0.1:4173/', {
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, `Local server did not become ready: ${logs}`);
  const metadata = JSON.parse(
    await readFile('data/category-map-metadata.json', 'utf8'),
  );
  const asset = await fetch(
    'http://127.0.0.1:4173/data/jev-category-map-36-complete.json',
  );
  assert.equal(asset.status, 200);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await asset.arrayBuffer()))
      .digest('hex'),
    metadata.sha256,
  );
  const categories = await fetch('http://127.0.0.1:4173/api/categories');
  assert.equal(categories.status, 200);
  assert.equal((await categories.json()).sessionId, null);
  const runs = await fetch('http://127.0.0.1:4173/api/runs');
  assert.equal(runs.status, 200);
  console.log(
    'Clean local startup passed: page, exact category asset, empty category session and experiment database. No API key used.',
  );
} finally {
  server.kill('SIGTERM');
}
