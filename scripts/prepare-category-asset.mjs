import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = new URL(
  '../data/jev-category-map-36-complete.json',
  import.meta.url,
);
const metadata = JSON.parse(
  await readFile(
    new URL('../data/category-map-metadata.json', import.meta.url),
    'utf8',
  ),
);
const bytes = await readFile(source);
if (bytes.byteLength !== metadata.sizeBytes)
  throw new Error('Bundled category file size mismatch.');
if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256)
  throw new Error('Bundled category file checksum mismatch.');
const target = new URL(
  '../public/data/jev-category-map-36-complete.json',
  import.meta.url,
);
await mkdir(new URL('.', target), { recursive: true });
await copyFile(source, target);
console.log(
  `Prepared default categories: ${metadata.words} words, ${metadata.dimensions} dimensions.`,
);
