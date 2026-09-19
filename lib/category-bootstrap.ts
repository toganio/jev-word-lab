import {
  AXES,
  TAXONOMY_VERSION,
  sanitizeCategories,
  isComplete,
  type CategoryMap,
} from './categories';
import { validateCategoryFile, scannedCells } from './category-file';
import metadata from '../data/category-map-metadata.json';
export type CategoryPage = {
  version: string;
  categories: CategoryMap;
  nextCursor: string | null;
  sourceSha256: string;
  sessionId: string | null;
  expectedCount: number;
  storedCount?: number;
  expectedCells: number;
  verifiedCount: number;
  scannedCells: number;
  missingCount: number;
  complete: boolean;
};
export type CategoryBootstrap = {
  page: CategoryPage;
  bundled: boolean;
  storageUnavailable: boolean;
};
export type CategoryLoadProgress = {
  stage:
    | 'dictionary'
    | 'checking'
    | 'downloading'
    | 'saved'
    | 'verifying'
    | 'ready';
  loaded?: number;
  total?: number;
  unit?: 'bytes' | 'words';
};
type ReportProgress = (progress: CategoryLoadProgress) => void;
async function readBundledFile(response: Response, report: ReportProgress) {
  report({
    stage: 'downloading',
    loaded: 0,
    total: metadata.sizeBytes,
    unit: 'bytes',
  });
  // Stream decoded bytes. Content-Length may describe compressed transfer bytes,
  // so use the checked-in file's byte length for the displayed denominator.
  const reader = response.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let loaded = 0,
      lastReport = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        loaded += value.byteLength;
        if (Date.now() - lastReport >= 100 || loaded >= metadata.sizeBytes) {
          report({
            stage: 'downloading',
            loaded,
            total: metadata.sizeBytes,
            unit: 'bytes',
          });
          lastReport = Date.now();
        }
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else text = await response.text();
  report({ stage: 'verifying' });
  // Give the UI a rendering opportunity before parsing and full-map validation.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return JSON.parse(text);
}
// No model calls or database writes: the shipped Jev snapshot is already complete.
export async function loadInitialCategories(
  words: string[],
  request: typeof fetch = fetch,
  report: ReportProgress = () => {},
): Promise<CategoryBootstrap> {
  report({ stage: 'checking' });
  let page: CategoryPage | undefined;
  let storageUnavailable = false;
  try {
    const response = await request('/api/categories', {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Storage unavailable.');
    page = (await response.json()) as CategoryPage;
  } catch {
    storageUnavailable = true;
  }
  if (!page?.sessionId) {
    report({
      stage: 'downloading',
      loaded: 0,
      total: metadata.sizeBytes,
      unit: 'bytes',
    });
    const response = await request(
      `/data/jev-category-map-36-complete.json?v=${metadata.sha256}`,
      {
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok)
      throw new Error(
        'Could not load the bundled category file. Reload to try again.',
      );
    const file = await readBundledFile(response, report);
    const categories = validateCategoryFile(
      file,
      metadata.dictionarySha256,
      words,
    );
    if (words.some((word) => !isComplete(categories[word])))
      throw new Error(
        'The bundled category file must cover every word and dimension.',
      );
    report({
      stage: 'ready',
      loaded: words.length,
      total: words.length,
      unit: 'words',
    });
    return {
      bundled: true,
      storageUnavailable,
      page: {
        version: TAXONOMY_VERSION,
        categories,
        nextCursor: null,
        sourceSha256: metadata.dictionarySha256,
        sessionId: null,
        expectedCount: words.length,
        storedCount: words.length,
        expectedCells: words.length * AXES.length,
        verifiedCount: words.length,
        scannedCells: scannedCells(categories),
        missingCount: 0,
        complete: true,
      },
    };
  }
  // An existing saved session wins, including partial imports. Never blend it
  // with the default or replace it when a later page fails to load.
  const sessionId = page.sessionId;
  const categories: CategoryMap = {};
  let loaded = 0;
  while (true) {
    if (
      page.version !== TAXONOMY_VERSION ||
      page.sourceSha256 !== metadata.dictionarySha256 ||
      page.sessionId !== sessionId
    )
      throw new Error('Saved category session does not match this dictionary.');
    const batch = sanitizeCategories(page.categories);
    Object.assign(categories, batch);
    loaded += Object.keys(batch).length;
    report({ stage: 'saved', loaded, total: page.storedCount, unit: 'words' });
    if (!page.nextCursor) break;
    const params = new URLSearchParams({
      session: sessionId,
      after: page.nextCursor,
    });
    const response = await request(`/api/categories?${params}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        'Could not load the saved category session. Reload to try again.',
      );
    page = (await response.json()) as CategoryPage;
  }
  report({ stage: 'ready', loaded, total: loaded, unit: 'words' });
  return {
    page: { ...page, categories },
    bundled: false,
    storageUnavailable: false,
  };
}
