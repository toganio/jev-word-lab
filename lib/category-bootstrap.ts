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
// No model calls or database writes: the shipped Jev snapshot is already complete.
export async function loadInitialCategories(
  words: string[],
  request: typeof fetch = fetch,
): Promise<CategoryBootstrap> {
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
    const file = await response.json();
    const categories = validateCategoryFile(
      file,
      metadata.dictionarySha256,
      words,
    );
    if (words.some((word) => !isComplete(categories[word])))
      throw new Error(
        'The bundled category file must cover every word and dimension.',
      );
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
  while (true) {
    if (
      page.version !== TAXONOMY_VERSION ||
      page.sourceSha256 !== metadata.dictionarySha256 ||
      page.sessionId !== sessionId
    )
      throw new Error('Saved category session does not match this dictionary.');
    Object.assign(categories, sanitizeCategories(page.categories));
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
  return {
    page: { ...page, categories },
    bundled: false,
    storageUnavailable: false,
  };
}
