import type { DecisionResponse, Question } from './types';
export function validateRequest(body: any): void {
  if (
    !body ||
    !body.state ||
    !body.questions ||
    typeof body.questions !== 'object' ||
    Array.isArray(body.questions)
  )
    throw new Error('Invalid request');
  const qs = Object.values(body.questions) as any[];
  if (qs.length < 1 || qs.length > 128) throw new Error('Question count');
  for (const q of qs) {
    if (
      q.type !== 'choice' ||
      typeof q.instructions !== 'string' ||
      !q.instructions ||
      q.instructions.length > 4000 ||
      !q.criteria ||
      typeof q.criteria !== 'object' ||
      Array.isArray(q.criteria)
    )
      throw new Error('Invalid question');
    const entries = Object.entries(q.criteria);
    if (entries.length < 2 || entries.length > 255)
      throw new Error('Option limit');
    for (const [k, v] of entries) {
      if (
        !k ||
        k.length > 200 ||
        (v !== null && (typeof v !== 'string' || v.length > 4000))
      )
        throw new Error('Invalid option');
    }
  }
}
export function validateResponse(
  data: any,
  questions: Record<string, Question>,
): asserts data is DecisionResponse {
  if (!data || !data.answers || typeof data.model !== 'string')
    throw new Error('Invalid response');
  for (const [id, q] of Object.entries(questions)) {
    const a = data.answers[id];
    if (
      !a ||
      a.type !== 'choice' ||
      !Object.hasOwn(q.criteria, a.choice) ||
      !Number.isFinite(a.confidence) ||
      a.confidence < 0 ||
      a.confidence > 1 ||
      !a.probabilities
    )
      throw new Error('Invalid answer');
    let sum = 0;
    for (const k of Object.keys(q.criteria)) {
      const p = a.probabilities[k];
      if (!Number.isFinite(p) || p < 0 || p > 1)
        throw new Error('Invalid probability');
      sum += p;
    }
    if (
      Object.keys(a.probabilities).length !== Object.keys(q.criteria).length ||
      Math.abs(sum - 1) > 0.035
    )
      throw new Error('Invalid distribution');
  }
  if (
    !data.usage ||
    !Number.isFinite(data.usage.input_tokens) ||
    !Number.isFinite(data.usage.output_tokens) ||
    data.usage.input_tokens < 0 ||
    data.usage.output_tokens < 0
  )
    throw new Error('Invalid usage');
}
