import fs from 'node:fs';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const input = process.argv[2];
if (!input)
  throw new Error(
    'Usage: node scripts/export-category-file.mjs /path/to/category-map.json',
  );
const dir = await mkdtemp(join(tmpdir(), 'jev-export-'));
try {
  const outfile = join(dir, 'categories.mjs');
  await build({
    entryPoints: ['lib/category-file.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const { makeCategoryFile, validateCategoryFile, scannedCells } = await import(
    pathToFileURL(outfile).href
  );
  const manifest = JSON.parse(
    fs.readFileSync('lib/dictionary-manifest.json', 'utf8'),
  );
  const categories = JSON.parse(fs.readFileSync(input, 'utf8'));
  const file = makeCategoryFile(
    categories,
    manifest.sourceSha256,
    manifest.words,
  );
  validateCategoryFile(file, manifest.sourceSha256, manifest.words);
  if (!file.complete || scannedCells(categories) !== manifest.words.length * 36)
    throw new Error('Refusing incomplete export');
  fs.mkdirSync('data', { recursive: true });
  const name = 'jev-category-map-36-complete.json';
  const raw = JSON.stringify(file) + '\n';
  fs.writeFileSync('data/' + name, raw);
  const report = {
    file: name,
    sha256: createHash('sha256').update(raw).digest('hex'),
    dictionarySha256: manifest.sourceSha256,
    words: manifest.words.length,
    dimensions: 36,
    scannedCells: scannedCells(categories),
    complete: true,
    model: 'jev-latest',
    source: 'User-authorized export of saved Jev classifications',
    exportedAt: new Date().toISOString(),
    note: 'Coverage is complete; classifications may be uncertain or incorrect. Contains no API keys, conversation logs or session identifiers.',
  };
  fs.writeFileSync(
    'data/category-map-metadata.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      words: report.words,
      scannedCells: report.scannedCells,
      bytes: Buffer.byteLength(raw),
      sha256: report.sha256,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
