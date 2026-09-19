import { PUNCTUATION } from './dictionary';

/** Visible decoding constraints, not another model or generated replacement text. */
export function repetitionReason(
  output: string[],
  candidate: string,
  functionWords: ReadonlySet<string>,
): string | null {
  const next = candidate.toLowerCase();
  if (PUNCTUATION.includes(candidate)) {
    return output.length && PUNCTUATION.includes(output.at(-1)!)
      ? 'Consecutive punctuation'
      : null;
  }
  const words = output
    .filter((w) => !PUNCTUATION.includes(w))
    .map((w) => w.toLowerCase());
  if (words.at(-1) === next) return 'Consecutive duplicate word';
  const proposed = [...words, next];
  // Reject a second adjacent copy of a 2–4-word block before appending it.
  for (let size = 2; size <= 4; size++) {
    if (
      proposed.length >= size * 2 &&
      proposed.slice(-size).join(' ') ===
        proposed.slice(-size * 2, -size).join(' ')
    ) {
      return `${size} word repetition loop`;
    }
  }
  if (proposed.length >= 6) {
    const tail = proposed.slice(-3).join(' ');
    for (let i = 0; i <= words.length - 3; i++) {
      if (words.slice(i, i + 3).join(' ') === tail)
        return 'Previously used three-word phrase';
    }
  }
  if (
    !functionWords.has(next) &&
    words.slice(-12).filter((w) => w === next).length >= 2
  ) {
    return 'Third use in the last 12 words';
  }
  return null;
}
