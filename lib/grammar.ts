import exceptions from './inflection-exceptions.json';
import { AXES, selectedLabels, type CategoryMap } from './categories';

/** Spelling candidates only. Jev must approve context and choose the emitted form. */
export function inflectedCandidates(
  word: string,
  prepared: CategoryMap,
): string[] {
  const a = Object.hasOwn(prepared, word) ? prepared[word] : undefined;
  if (!a || !/^[a-z]+$/.test(word)) return [];
  const types = selectedLabels('type', a[AXES.indexOf('type')]);
  const forms = selectedLabels('inflection', a[AXES.indexOf('inflection')]);
  const result = new Set<string>();
  const suffixS = /[^aeiou]y$/.test(word)
    ? word.slice(0, -1) + 'ies'
    : /(?:s|x|z|ch|sh)$/.test(word)
      ? word + 'es'
      : word + 's';
  if (types.includes('noun') && forms.includes('singular')) {
    const irregular = (exceptions.noun as Record<string, string[]>)[word];
    for (const w of irregular || [suffixS]) result.add(w);
  }
  if (types.includes('verb') && forms.includes('base')) {
    result.add(/o$/.test(word) ? word + 'es' : suffixS);
    const irregular = (exceptions.verb as Record<string, string[]>)[word];
    if (irregular) for (const w of irregular) result.add(w);
    {
      const doubled =
        /^[^aeiou]*[aeiou][b-df-hj-np-tv-z]$/.test(word) &&
        !/[wxy]$/.test(word);
      const stem = doubled ? word + word.at(-1) : word;
      if (!irregular)
        result.add(
          /[^aeiou]y$/.test(word)
            ? word.slice(0, -1) + 'ied'
            : /e$/.test(word)
              ? word + 'd'
              : stem + 'ed',
        );
      result.add(
        /ie$/.test(word)
          ? word.slice(0, -2) + 'ying'
          : /[^e]e$/.test(word)
            ? word.slice(0, -1) + 'ing'
            : stem + 'ing',
      );
    }
  }
  result.delete(word);
  return [...result];
}

export function expandCandidates(
  bases: string[],
  common: string[],
  prepared?: CategoryMap,
): string[] {
  const chosen = new Set([...bases.slice(0, 120), ...common.slice(0, 110)]);
  if (prepared) {
    const variants = bases
      .slice(0, 120)
      .map((w) => inflectedCandidates(w, prepared));
    for (let i = 0; i < 8 && chosen.size < 248; i++) {
      for (const forms of variants) {
        if (forms[i]) chosen.add(forms[i]);
        if (chosen.size >= 248) break;
      }
    }
  }
  return [...chosen];
}

/** Guidance for one comparative choice, never an independent candidate veto. */
export const GRAMMAR_GUIDANCE =
  'Compare candidate continuations in context. Respect subject-verb and noun-number agreement, article choice (a/an), verb forms and word order. Prefer the form that fits the existing clause. Do not restart, revise, or repeat words already written. Follow the requested short-sentence plan. Ending does not require an exhaustive explanation; prefer ending early to padding the reply with filler.';
