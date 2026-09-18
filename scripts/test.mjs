import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'jev-tests-'));
try {
  const target = join(dir, 'tests.mjs');
  await build({
    entryPoints: ['tests/experiment.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: target,
  });
  const result = spawnSync(process.execPath, [target], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
