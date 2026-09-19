import {
  AXIS_DEFINITIONS,
  AXES,
  TAXONOMY_VERSION,
  sanitizeCategories,
  isComplete,
  type CategoryMap,
} from './categories';
export type CategoryFile = {
  format: 'jev-category-file-1';
  taxonomyVersion: string;
  sourceSha256: string;
  dictionaryCount: number;
  definitions: typeof AXIS_DEFINITIONS;
  complete: boolean;
  categories: CategoryMap;
};
export function makeCategoryFile(
  categories: CategoryMap,
  sourceSha256: string,
  dictionaryWords: string[],
): CategoryFile {
  return {
    format: 'jev-category-file-1',
    taxonomyVersion: TAXONOMY_VERSION,
    sourceSha256,
    dictionaryCount: dictionaryWords.length,
    definitions: AXIS_DEFINITIONS,
    complete: dictionaryWords.every((w) => isComplete(categories[w])),
    categories,
  };
}
export function validateCategoryFile(
  input: unknown,
  sourceSha256: string,
  dictionaryWords: string[],
): CategoryMap {
  const file = input as CategoryFile;
  if (
    !file ||
    file.format !== 'jev-category-file-1' ||
    file.taxonomyVersion !== TAXONOMY_VERSION ||
    file.sourceSha256 !== sourceSha256 ||
    file.dictionaryCount !== dictionaryWords.length ||
    JSON.stringify(file.definitions) !== JSON.stringify(AXIS_DEFINITIONS)
  )
    throw new Error(
      'Dosyanın sözlüğü veya 36 boyutlu şeması bu uygulamayla eşleşmiyor.',
    );
  const map = sanitizeCategories(file.categories);
  const words = new Set(dictionaryWords);
  if (Object.keys(map).some((w) => !words.has(w)))
    throw new Error('Dosyada sözlüğün dışında kelime var.');
  const complete = dictionaryWords.every((w) => isComplete(map[w]));
  if (file.complete !== complete)
    throw new Error(
      'Dosyanın tamamlanma iddiası gerçek kapsamıyla eşleşmiyor.',
    );
  return map;
}
export function scannedCells(map: CategoryMap) {
  return Object.values(map).reduce((n, a) => n + a.filter(Boolean).length, 0);
}
export const TOTAL_AXES = AXES.length;
