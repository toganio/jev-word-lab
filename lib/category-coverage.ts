import manifest from './dictionary-manifest.json';
import {
  AXES,
  sanitizeCategories,
  isComplete,
  type CategoryMap,
} from './categories';
export const SOURCE_SHA256 = manifest.sourceSha256;
export const EXPECTED_WORDS = manifest.words;
const vocabulary = new Set(EXPECTED_WORDS);
export function validateDictionaryCategories(
  input: unknown,
  max = 100000,
): CategoryMap {
  const map = sanitizeCategories(input, max);
  for (const word of Object.keys(map))
    if (!vocabulary.has(word)) throw new Error('Word not in source dictionary');
  return map;
}
export function verifyCoverage(map: CategoryMap) {
  const valid = validateDictionaryCategories(map);
  let verifiedCount = 0,
    scannedCells = 0;
  for (const word of EXPECTED_WORDS) {
    const a = valid[word];
    if (isComplete(a)) verifiedCount++;
    if (a) scannedCells += a.filter(Boolean).length;
  }
  return {
    expectedCount: EXPECTED_WORDS.length,
    verifiedCount,
    scannedCells,
    expectedCells: EXPECTED_WORDS.length * AXES.length,
    missingCount: EXPECTED_WORDS.length - verifiedCount,
    complete: verifiedCount === EXPECTED_WORDS.length,
    sourceSha256: SOURCE_SHA256,
  };
}
