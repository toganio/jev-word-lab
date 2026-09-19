import exceptions from './inflection-exceptions.json';
import { AXES, selectedLabels, type CategoryMap } from './categories';
import type { Evaluate, Question, Trace } from './types';
import { STOP } from './dictionary';

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
  const chosen = new Set([...bases.slice(0, 48), ...common.slice(0, 110)]);
  if (prepared) {
    const variants = bases
      .slice(0, 48)
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

/** All validity judgments and completion checks are independent questions answered by Jev. */
export async function reviewGrammar(
  state: unknown,
  candidates: string[],
  evaluate: Evaluate,
  signal: AbortSignal,
): Promise<{ allowed: Set<string>; trace: Trace }> {
  signal.throwIfAborted();
  const grammarState = {
    ...(state as Record<string, unknown>),
    grammar_rules:
      'Judge whether the exact candidate token can follow reply_so_far as a grammatical English reply. Check spelling, subject-verb and number agreement, articles, word order, verb forms and sentence boundaries. A partial clause is allowed if a valid completion remains possible. Start a NEW assistant sentence, not a continuation of the user question. Reject malformed inflections. Do not require each token to finish the answer. This is a validity check, not a preference ranking.',
  };
  const questions: Record<string, Question> = {};
  candidates.forEach((word, i) => {
    questions[`v${i}`] = {
      type: 'choice',
      instructions:
        word === STOP
          ? 'Does reply_so_far already answer the latest user request with useful specific information, in complete grammatical English? For a how-to, require actionable steps; for why, an actual explanation. A vague restatement is not complete. Judge only the existing reply.'
          : `Apply state.grammar_rules: can exactly ${JSON.stringify(word)} be appended as a grammatical next token?`,
      criteria: { allow: 'Yes', reject: 'No' },
    };
  });
  const response = await evaluate(grammarState, questions, signal);
  const allowed = new Set<string>();
  const excluded: { word: string; reason: string }[] = [];
  candidates.forEach((word, i) => {
    const a = response.answers[`v${i}`];
    if (!a || !['allow', 'reject'].includes(a.choice))
      throw new Error('Invalid Jev grammar decision.');
    if (a.choice === 'allow') allowed.add(word);
    else
      excluded.push({
        word,
        reason:
          word === STOP
            ? 'Jev: reply is not complete or useful yet'
            : 'Jev: not a grammatical continuation',
      });
  });
  return {
    allowed,
    trace: {
      stage: 'Jev grammar review',
      path: 'Independent validity checks before final selection',
      options: candidates.length,
      candidates: candidates.slice(0, 8).map((word, i) => ({
        label: word === STOP ? '[End reply]' : word,
        probability: response.answers[`v${i}`].probabilities.allow,
        retained: allowed.has(word),
      })),
      excluded,
    },
  };
}
