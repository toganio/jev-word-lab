import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildTree,
  commonWords,
  joinWords,
  STOP,
  type GroupNode,
  type Node,
} from '../lib/dictionary';
import { generate, classifyWords } from '../lib/engine';
import { validateRequest, validateResponse } from '../lib/protocol';
import { POST } from '../app/api/decision/route';
import type {
  Dictionary,
  Evaluate,
  DecisionResponse,
  Question,
} from '../lib/types';
const dictionary = JSON.parse(
  fs.readFileSync('public/data/dictionary.json', 'utf8'),
) as Dictionary;
function answer(
  questions: Record<string, Question>,
  select: (id: string, q: Question) => Record<string, number>,
): DecisionResponse {
  return {
    model: 'test-double',
    usage: { input_tokens: 10, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, q]) => {
        const probabilities = Object.fromEntries(
          Object.keys(q.criteria).map((k) => [k, 0]),
        );
        Object.assign(probabilities, select(id, q));
        return [
          id,
          {
            type: 'choice',
            choice: Object.entries(probabilities).sort(
              (a, b) => b[1] - a[1],
            )[0][0],
            probabilities,
            confidence: 0.8,
          },
        ];
      }),
    ),
  };
}
const word = (w: string): Node => ({
  kind: 'word',
  word: w,
  label: w,
  count: 1,
});
const group = (label: string, children: Node[]): GroupNode => ({
  kind: 'group',
  label,
  description: label,
  count: children.reduce((n, c) => n + c.count, 0),
  children,
});
test('every downloaded word is reachable and no dictionary branch exceeds API limits', () => {
  const root = buildTree(dictionary, 0);
  const found = new Set<string>();
  let maxDepth = 0;
  const walk = (n: Node, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    if (n.kind === 'word') {
      found.add(n.word);
      return;
    }
    assert.ok(n.children.length <= 255);
    assert.ok(n.children.length > 0);
    if (n.children.every((c) => c.kind === 'word'))
      assert.ok(n.children.length <= 200);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  assert.equal(found.size, dictionary.count);
  assert.ok(dictionary.count > 80000);
  assert.ok(maxDepth < 16);
  assert.deepEqual(
    new Set(
      fs.readFileSync('public/data/words.txt', 'utf8').trim().split('\n'),
    ),
    found,
  );
  assert.ok(commonWords(dictionary, 0).includes('the'));
});
test('final comparison can pick a word from a weaker category; stop does not leak into text', async () => {
  const root = group('root', [
    group('A', [word('apple'), word('pear')]),
    group('B', [word('water'), word('tea')]),
  ]);
  let finals = 0;
  const seen: string[][] = [];
  const evaluate: Evaluate = async (state, qs) => {
    validateRequest({ state, questions: qs });
    const r = answer(qs, (id, q): Record<string, number> => {
      if (id === 'next') {
        seen.push(Object.keys(q.criteria));
        return { [finals++ === 0 ? 'water' : STOP]: 1 };
      }
      if (q.instructions.includes('Group: root')) return { o0: 0.6, o1: 0.4 };
      return { o0: 0.8, o1: 0.2 };
    });
    validateResponse(r, qs);
    return r;
  };
  const result = await generate({
    root,
    common: ['the'],
    history: [{ role: 'user', content: 'What should I drink?' }],
    beam: 2,
    maxWords: 5,
    signal: new AbortController().signal,
    evaluate,
    onPhase: () => {},
    onStep: () => {},
  });
  assert.equal(result.text, 'Water');
  assert.equal(finals, 2);
  assert.ok(seen[0].includes('apple') && seen[0].includes('water'));
  assert.ok(!seen[0].includes(STOP));
});
test('cancelled experiment makes zero provider calls', async () => {
  const c = new AbortController();
  c.abort();
  let calls = 0;
  await assert.rejects(
    generate({
      root: group('root', [word('yes'), word('no')]),
      common: [],
      history: [],
      beam: 1,
      maxWords: 2,
      signal: c.signal,
      evaluate: async () => {
        calls++;
        throw new Error();
      },
      onPhase: () => {},
      onStep: () => {},
    }),
  );
  assert.equal(calls, 0);
});
test('malformed upstream results and over-limit requests are rejected', () => {
  const q = {
    test: {
      type: 'choice' as const,
      instructions: 'Pick',
      criteria: { yes: null, no: null },
    },
  };
  const result = answer(q, () => ({ yes: 1 }));
  validateResponse(result, q);
  result.answers.test.choice = 'invented';
  assert.throws(() => validateResponse(result, q));
  result.answers.test.choice = 'yes';
  result.answers.test.probabilities.yes = 0.1;
  assert.throws(() => validateResponse(result, q));
  assert.throws(() =>
    validateRequest({
      state: 'x',
      questions: {
        a: {
          type: 'choice',
          instructions: 'pick',
          criteria: Object.fromEntries(
            Array.from({ length: 256 }, (_, i) => [String(i), null]),
          ),
        },
      },
    }),
  );
});
test('classification batches include the target word in each independent question', async () => {
  const words = Array.from({ length: 49 }, (_, i) => `word${i}`);
  let calls = 0;
  const result: Record<string, string> = {};
  await classifyWords(
    words,
    { n: 'Noun', v: 'Verb' },
    async (state, qs) => {
      calls++;
      validateRequest({ state, questions: qs });
      for (const q of Object.values(qs))
        assert.match(q.instructions, /word\d+/);
      return answer(qs, () => ({ n: 1 }));
    },
    new AbortController().signal,
    (r) => Object.assign(result, r),
  );
  assert.equal(calls, 3);
  assert.equal(Object.keys(result).length, 49);
});
test('proxy refuses absent keys and cross-origin requests without contacting upstream', async () => {
  const missing = await POST(
    new Request('https://lab.example/api/decision', {
      method: 'POST',
      body: '{}',
    }),
  );
  assert.equal(missing.status, 401);
  const cross = await POST(
    new Request('https://lab.example/api/decision', {
      method: 'POST',
      headers: {
        origin: 'https://other.example',
        'x-typesafe-key': 'fake-test-key',
      },
      body: '{}',
    }),
  );
  assert.equal(cross.status, 403);
});
test('proxy fixes upstream endpoint, forwards key only in auth header, and sanitizes errors', async () => {
  const original = globalThis.fetch;
  let called = 0;
  const key = 'fake-unit-test-key';
  try {
    globalThis.fetch = (async (url, init) => {
      called++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer ${key}`,
      );
      assert.ok(!String(init?.body).includes(key));
      return new Response(JSON.stringify({ secret: key }), { status: 401 });
    }) as typeof fetch;
    const res = await POST(
      new Request('https://lab.example/api/decision', {
        method: 'POST',
        headers: { origin: 'https://lab.example', 'x-typesafe-key': key },
        body: JSON.stringify({
          state: 'x',
          questions: {
            pick: {
              type: 'choice',
              instructions: 'Which?',
              criteria: { a: null, b: null },
            },
          },
        }),
      }),
    );
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes(key));
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('punctuation and standalone I are formatted as English', () => {
  assert.equal(
    joinWords(['i', 'like', 'tea', ',', 'and', 'you', '?']),
    'I like tea, and you?',
  );
});
test('backend rejects a non-Jev upstream result and ignores client model overrides', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'jev-latest');
      const r = answer(body.questions, () => ({ a: 1 }));
      r.model = 'other-model';
      return Response.json(r);
    }) as typeof fetch;
    const res = await POST(
      new Request('https://lab.example/api/decision', {
        method: 'POST',
        headers: { 'x-typesafe-key': 'fake-test-key' },
        body: JSON.stringify({
          model: 'other-model',
          state: 'x',
          questions: {
            pick: {
              type: 'choice',
              instructions: 'Which?',
              criteria: { a: null, b: null },
            },
          },
        }),
      }),
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /only uses Jev/);
  } finally {
    globalThis.fetch = original;
  }
});

test('repeat guard excludes duplicate words before Jev final choice and logs the rule', async () => {
  const root = group('root', [word('tea'), word('water')]);
  let finals = 0;
  const excluded: string[] = [];
  const evaluate: Evaluate = async (state, qs) => {
    validateRequest({ state, questions: qs });
    return answer(qs, (id, q): Record<string, number> => {
      if (id === 'next') {
        if (finals++ === 0) return { tea: 1 };
        assert.ok(!Object.hasOwn(q.criteria, 'tea'));
        assert.ok(Object.hasOwn(q.criteria, 'water'));
        return { [STOP]: 1 };
      }
      return { o0: 0.99, o1: 0.01 };
    });
  };
  const result = await generate({
    root,
    common: ['the'],
    history: [],
    beam: 1,
    maxWords: 4,
    signal: new AbortController().signal,
    evaluate,
    onPhase: (_p, t) => {
      excluded.push(...(t?.excluded?.map((x) => x.word) || []));
    },
    onStep: () => {},
  });
  assert.equal(result.text, 'Tea');
  assert.ok(excluded.includes('tea'));
});
test('raw experiment mode preserves Jev repetitions when guard is disabled', async () => {
  const root = group('root', [word('tea'), word('water')]);
  const result = await generate({
    root,
    common: ['the'],
    history: [],
    beam: 1,
    maxWords: 3,
    repetitionGuard: false,
    signal: new AbortController().signal,
    evaluate: async (_state, qs) =>
      answer(
        qs,
        (id): Record<string, number> =>
          id === 'next' ? { tea: 1 } : { o0: 1 },
      ),
    onPhase: () => {},
    onStep: () => {},
  });
  assert.equal(result.text, 'Tea tea tea');
});
import { repetitionReason } from '../lib/repetition';
test('guard stops word and phrase loops while allowing normal reuse of function words', () => {
  const common = new Set(['the', 'is', 'and']);
  assert.ok(repetitionReason(['Tea', ','], 'tea', common));
  assert.ok(repetitionReason(['very', 'good', 'very'], 'good', common));
  assert.ok(
    repetitionReason(['one', 'two', 'three', 'one', 'two'], 'three', common),
  );
  assert.ok(
    repetitionReason(
      ['one', 'two', 'three', 'four', 'one', 'two', 'three'],
      'four',
      common,
    ),
  );
  assert.ok(
    repetitionReason(['tea', 'is', 'nice', 'tea', 'is', 'warm'], 'tea', common),
  );
  assert.equal(
    repetitionReason(['the', 'cat', 'and', 'the', 'dog', 'and'], 'the', common),
    null,
  );
  assert.equal(
    repetitionReason(['tea', 'is', 'nice', 'and'], 'tea', common),
    null,
  );
  assert.ok(repetitionReason(['tea', '.'], '.', common));
  assert.equal(repetitionReason(['tea'], '?', common), null);
});
import { sanitizeRecord, type RunRecord, APP_VERSION } from '../lib/run-record';
function recordFixture(): RunRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    kind: 'conversation',
    startedAt: Date.now(),
    status: 'completed',
    question: 'Hello?',
    answer: 'Hello.',
    reason: 'Complete',
    appVersion: APP_VERSION,
    settings: {
      limit: 0,
      beam: 3,
      maxWords: 32,
      requestBudget: 200,
      repetitionGuard: true,
    },
    conversation: [],
    steps: [],
    operations: [],
    usage: {
      requests: 2,
      inputTokens: 50,
      outputTokens: 2,
      words: 1,
      startedAt: Date.now(),
      elapsedMs: 100,
    },
  };
}
test('full dictionary classification logs accept measured parallelism and more than 1000 completed words', () => {
  const record = recordFixture();
  record.kind = 'classification';
  record.settings.parallelism = 256;
  record.usage.words = dictionary.count;
  assert.equal(sanitizeRecord(record).usage.words, dictionary.count);
  record.kind = 'conversation';
  assert.throws(() => sanitizeRecord(record));
});
test('saved snapshots strip API keys, headers and unknown fields recursively', () => {
  const fixture = recordFixture();
  const secret = 'never-store-this-api-key';
  const dirty = {
    ...fixture,
    apiKey: secret,
    headers: { Authorization: secret },
    settings: { ...fixture.settings, key: secret },
    usage: { ...fixture.usage, key: secret },
    operations: [
      {
        id: 1,
        label: 'API',
        status: 'done',
        at: 1,
        ms: 1,
        questions: 1,
        options: 2,
        summary: 'Finished',
        apiKey: secret,
      },
    ],
  };
  const saved = sanitizeRecord(dirty);
  assert.ok(!JSON.stringify(saved).includes(secret));
  assert.equal(saved.answer, 'Hello.');
  assert.equal(saved.operations.length, 1);
  assert.throws(() => sanitizeRecord({ ...fixture, id: 'invalid' }));
  assert.throws(() => sanitizeRecord({ ...fixture, status: 'unknown' }));
});
import { RunRecorder } from '../lib/recorder';
test('recorder saves final answer after an in-flight checkpoint without losing its terminal status', async () => {
  const original = globalThis.fetch;
  const sent: RunRecord[] = [];
  const states: string[] = [];
  let release: () => void = () => {};
  try {
    globalThis.fetch = (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return Response.json({ saved: true });
    }) as typeof fetch;
    const fixture = recordFixture();
    fixture.status = 'running';
    fixture.answer = '';
    const recorder = new RunRecorder(fixture, (s) => states.push(s));
    recorder.patch({ answer: 'The final answer.' });
    const finish = recorder.finish('completed', 'Jev finished');
    release();
    await finish;
    assert.equal(sent.length, 2);
    assert.equal(sent[1].answer, 'The final answer.');
    assert.equal(sent[1].status, 'completed');
    assert.ok(sent[1].revision > sent[0].revision);
    assert.equal(states.at(-1), 'saved');
  } finally {
    globalThis.fetch = original;
  }
});

import {
  AXES,
  AXIS_DEFINITIONS,
  QUESTIONS_PER_REQUEST,
  NOT_APPLICABLE,
  UNCERTAIN,
  isComplete,
  selectedLabels,
  prepareCategories,
  type CategoryMap,
} from '../lib/categories';
import { buildPreparedTree } from '../lib/dictionary';
import { makeCategoryFile, validateCategoryFile } from '../lib/category-file';
import {
  EXPECTED_WORDS,
  SOURCE_SHA256,
  verifyCoverage,
  validateDictionaryCategories,
} from '../lib/category-coverage';

test('compact paired decisions scan all 36 dimensions within context bounds and preserve multi-label meaning', async () => {
  const saved: CategoryMap = {};
  const seen = new Set<string>();
  await prepareCategories(
    ['water', 'bank'],
    {},
    async (state, qs) => {
      validateRequest({ state, questions: qs });
      assert.ok(Object.keys(qs).length <= QUESTIONS_PER_REQUEST);
      assert.equal(Object.keys(qs).length % 2, 0);
      assert.ok(
        Buffer.byteLength(JSON.stringify({ state, questions: qs })) <=
          CATEGORY_REQUEST_BYTES,
      );
      for (const q of Object.values(qs)) {
        assert.equal(Object.keys(q.criteria).length, 9);
        const signature = q.instructions + JSON.stringify(q.criteria);
        assert.ok(!seen.has(signature));
        seen.add(signature);
      }
      const r = answer(qs, (id) => ({
        [Number(id.slice(1)) % 2 === 0 ? '3' : String(NOT_APPLICABLE)]: 1,
      }));
      validateResponse(r, qs);
      return r;
    },
    new AbortController().signal,
    (batch) => {
      Object.assign(saved, batch);
    },
  );
  assert.equal(seen.size, 2 * 36 * 2);
  assert.ok(isComplete(saved.water));
  assert.deepEqual(selectedLabels('type', saved.water[AXES.indexOf('type')]), [
    'noun',
    'verb',
  ]);
  assert.deepEqual(selectedLabels('type', NOT_APPLICABLE), ['not_applicable']);
  assert.deepEqual(selectedLabels('type', UNCERTAIN), ['uncertain']);
  for (let value = 1; value < 64; value++) {
    assert.equal(
      combineTagGroups(
        value & 7 || NOT_APPLICABLE,
        value >> 3 || NOT_APPLICABLE,
      ),
      value,
    );
  }
  assert.equal(
    combineTagGroups(NOT_APPLICABLE, NOT_APPLICABLE),
    NOT_APPLICABLE,
  );
  assert.equal(combineTagGroups(1, UNCERTAIN), UNCERTAIN);
  assert.throws(() => combineTagGroups(8, 1));
});
test('an interrupted compact scan resumes only missing complete pairs', async () => {
  const controller = new AbortController();
  let calls = 0;
  const saved: CategoryMap = {};
  const words = ['water', 'tea', 'bank', 'run'];
  const evaluate: Evaluate = async (_state, qs) => {
    calls++;
    return answer(qs, () => ({ '1': 1 }));
  };
  await assert.rejects(
    prepareCategories(words, {}, evaluate, controller.signal, (batch) => {
      Object.assign(saved, batch);
      controller.abort();
    }),
  );
  assert.equal(calls, 1);
  const scanned = Object.values(saved).reduce(
    (n, a) => n + a.filter(Boolean).length,
    0,
  );
  assert.ok(scanned > 0 && scanned < words.length * 36);
  let remainingQuestions = 0;
  await prepareCategories(
    words,
    structuredClone(saved),
    async (state, qs) => {
      remainingQuestions += Object.keys(qs).length;
      return evaluate(state, qs, new AbortController().signal);
    },
    new AbortController().signal,
    (batch) => {
      Object.assign(saved, batch);
    },
  );
  assert.equal(remainingQuestions, (words.length * 36 - scanned) * 2);
  assert.ok(words.every((w) => isComplete(saved[w])));
  const before = calls;
  await prepareCategories(
    words,
    saved,
    evaluate,
    new AbortController().signal,
    () => {},
  );
  assert.equal(calls, before);
});
test('category files round trip with multiple labels and reject wrong dictionaries, schemas, and false completion', () => {
  const a = AXES.map(() => 3);
  const map = { water: a, tea: [...a] };
  const words = ['water', 'tea'];
  const file = JSON.parse(
    JSON.stringify(makeCategoryFile(map, 'test-hash', words)),
  );
  assert.deepEqual(validateCategoryFile(file, 'test-hash', words), map);
  assert.throws(() => validateCategoryFile(file, 'wrong-hash', words));
  assert.throws(() =>
    validateCategoryFile({ ...file, definitions: [] }, 'test-hash', words),
  );
  assert.throws(() =>
    validateCategoryFile(
      { ...file, categories: { water: a } },
      'test-hash',
      words,
    ),
  );
  assert.throws(() =>
    validateCategoryFile(
      { ...file, categories: { ...map, water: [...a.slice(1), 999] } },
      'test-hash',
      words,
    ),
  );
  const partial = makeCategoryFile(
    { water: [1, ...AXES.slice(1).map(() => 0)] },
    'test-hash',
    words,
  );
  assert.equal(partial.complete, false);
  assert.deepEqual(
    validateCategoryFile(partial, 'test-hash', words),
    partial.categories,
  );
});
test('coverage verification checks every source word and dimension; one missing cell prevents 100 percent', () => {
  assert.equal(EXPECTED_WORDS.length, dictionary.count);
  assert.deepEqual(
    new Set(EXPECTED_WORDS),
    new Set(dictionary.words.map(([w]) => w)),
  );
  const map = Object.fromEntries(
    EXPECTED_WORDS.map((w) => [w, AXES.map(() => UNCERTAIN)]),
  );
  const full = verifyCoverage(map);
  assert.equal(full.complete, true);
  assert.equal(full.scannedCells, dictionary.count * 36);
  map[EXPECTED_WORDS[0]][35] = 0;
  const partial = verifyCoverage(map);
  assert.equal(partial.complete, false);
  assert.equal(partial.missingCount, 1);
  assert.equal(partial.scannedCells, full.scannedCells - 1);
  assert.throws(() =>
    validateDictionaryCategories({ zzzzinvalidwordzzzz: AXES.map(() => 1) }),
  );
});
test('prediction requires complete coverage and exposes the same word in several Jev-selected paths', () => {
  const dict: Dictionary = {
    ...dictionary,
    count: 2,
    words: [
      ['water', []],
      ['tea', []],
    ],
  };
  const map = { water: AXES.map(() => 3), tea: AXES.map(() => 1) };
  assert.throws(() => buildPreparedTree(dict, 0, { water: map.water }));
  const tree = buildPreparedTree(dict, 0, map);
  assert.equal(tree.children.length, 36);
  const type = tree.children[AXES.indexOf('type')] as GroupNode;
  assert.equal(type.children.length, 2);
  const noun = type.children[0] as GroupNode;
  const verb = type.children[1] as GroupNode;
  assert.equal(
    noun.children.find((n) => n.label === 'water'),
    verb.children.find((n) => n.label === 'water'),
  );
  assert.deepEqual(
    new Set(type.children.map((n) => n.label)),
    new Set(['type: noun', 'type: verb']),
  );
});

import {
  RequestPacer,
  TARGET_INPUT_TPS,
  ProviderError,
  retryThrottled,
  abortableDelay,
} from '../lib/parallel';
const unpaced = { acquire: async () => {}, pause: () => {} };
test('parallel preparation overlaps independent Jev calls and independent-word saves while preserving all cells', async () => {
  const words = dictionary.words.slice(0, 32).map(([w]) => w);
  const output: CategoryMap = {};
  const seen = new Set<string>();
  let active = 0,
    peak = 0,
    saves = 0;
  await prepareCategories(
    words,
    {},
    async (state, qs, signal) => {
      active++;
      peak = Math.max(peak, active);
      for (const q of Object.values(qs)) {
        const signature = q.instructions + JSON.stringify(q.criteria);
        assert.ok(!seen.has(signature));
        seen.add(signature);
      }
      await abortableDelay(1, signal);
      active--;
      return answer(qs, () => ({ '3': 1 }));
    },
    new AbortController().signal,
    async (batch) => {
      saves++;
      assert.ok(saves <= 4);
      await new Promise((r) => setTimeout(r, 1));
      Object.assign(output, batch);
      saves--;
    },
    { concurrency: 4, pacer: unpaced },
  );
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(seen.size, words.length * 36 * 2);
  assert.ok(words.every((w) => isComplete(output[w])));
});
test('parallel cancellation settles every outstanding operation before returning', async () => {
  const controller = new AbortController();
  let active = 0,
    calls = 0;
  const pending = prepareCategories(
    dictionary.words.slice(0, 32).map(([w]) => w),
    {},
    async (_state, qs, signal) => {
      active++;
      calls++;
      try {
        await abortableDelay(100, signal);
        return answer(qs, () => ({ '1': 1 }));
      } finally {
        active--;
      }
    },
    controller.signal,
    () => {},
    { concurrency: 4, pacer: unpaced },
  );
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(active, 0);
  assert.equal(calls, 4);
});
test('rate limit retries honor Retry-After, stop at bounded attempts, and do not retry auth failures', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryThrottled(
    async () => {
      if (++attempts < 3) throw new ProviderError('busy', 429, 5000);
      return 'jev';
    },
    new AbortController().signal,
    () => {},
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(result, 'jev');
  assert.deepEqual(waits, [5000, 5000]);
  attempts = 0;
  await assert.rejects(
    retryThrottled(
      async () => {
        attempts++;
        throw new ProviderError('auth', 401);
      },
      new AbortController().signal,
      () => {},
      async () => {},
    ),
  );
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(
    retryThrottled(
      async () => {
        attempts++;
        throw new ProviderError('busy', 529);
      },
      new AbortController().signal,
      () => {},
      async () => {},
    ),
  );
  assert.equal(attempts, 4);
});
test('shared pacing adapts to real token use and delays all workers after throttling', async () => {
  let now = 0;
  const waits: number[] = [];
  const pacer = new RequestPacer(
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  const signal = new AbortController().signal;
  await Promise.all([
    pacer.acquire(100000, signal),
    pacer.acquire(100000, signal),
  ]);
  assert.ok(now >= (50000 / TARGET_INPUT_TPS) * 1000);
  pacer.observe(100000, 20000);
  assert.equal(pacer.telemetry().tokensPerSecond, 4000);
  pacer.pause(5000);
  assert.ok(pacer.telemetry().targetTokensPerSecond < TARGET_INPUT_TPS);
  const before = now;
  await pacer.acquire(100000, signal);
  assert.ok(now - before >= 5000);
  assert.ok(waits.length >= 2);
});
test('proxy passes through sanitized Retry-After hints without changing Jev provider', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '3' },
      })) as typeof fetch;
    const result = await POST(
      new Request('https://lab.example/api/decision', {
        method: 'POST',
        headers: { 'x-typesafe-key': 'fake-unit-test-key' },
        body: JSON.stringify({
          state: 'x',
          questions: {
            pick: {
              type: 'choice',
              instructions: 'Pick',
              criteria: { a: null, b: null },
            },
          },
        }),
      }),
    );
    assert.equal(result.status, 429);
    assert.equal(
      ((await result.json()) as { retryAfterMs: number }).retryAfterMs,
      3000,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('upstream HTML 520 retries the same Jev request, honors Retry-After, and remains bounded', async () => {
  const original = globalThis.fetch;
  const payload = {
    state: 'Classify the same word',
    questions: {
      pick: {
        type: 'choice' as const,
        instructions: 'Pick a tag for cat',
        criteria: { animal: null, other: null },
      },
    },
  };
  const sent: string[] = [];
  let recover = true;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      sent.push(String(init?.body));
      if (!recover || sent.length === 1)
        return new Response('<html>Origin failed</html>', {
          status: 520,
          headers: { 'Retry-After': '3' },
        });
      return Response.json({
        ...answer(payload.questions, () => ({ animal: 1 })),
        model: 'jev-latest',
      });
    };
    const operation = async () => {
      const response = await POST(
        new Request('https://lab.example/api/decision', {
          method: 'POST',
          headers: { 'x-typesafe-key': 'fake-unit-test-key' },
          body: JSON.stringify(payload),
        }),
      );
      const data = (await response.json()) as DecisionResponse & {
        error: string;
        retryAfterMs: number;
      };
      if (!response.ok)
        throw new ProviderError(data.error, response.status, data.retryAfterMs);
      return data;
    };
    const waits: number[] = [];
    const result = await retryThrottled(
      operation,
      new AbortController().signal,
      () => {},
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(result.answers.pick.choice, 'animal');
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
    assert.equal(JSON.parse(sent[0]).model, 'jev-latest');
    assert.deepEqual(waits, [3000]);
    recover = false;
    sent.length = 0;
    waits.length = 0;
    await assert.rejects(
      retryThrottled(
        operation,
        new AbortController().signal,
        () => {},
        async (ms) => {
          waits.push(ms);
        },
      ),
      (e: unknown) => e instanceof ProviderError && e.status === 520,
    );
    assert.equal(sent.length, 4);
    assert.deepEqual(waits, [3000, 3000, 4000]);
  } finally {
    globalThis.fetch = original;
  }
});

test('transient timeouts retry but explicit cancellation never retries', async () => {
  let calls = 0;
  const controller = new AbortController();
  await retryThrottled(
    async () => {
      if (++calls === 1) throw new ProviderError('timeout', 504);
      return 'jev';
    },
    controller.signal,
    () => {},
    async () => {},
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    retryThrottled(
      async () => {
        calls++;
        controller.abort();
        throw new ProviderError('timeout', 408);
      },
      controller.signal,
      () => {},
      async () => {},
    ),
  );
  assert.equal(calls, 1);
});

import { CATEGORY_REQUEST_BYTES, combineTagGroups } from '../lib/categories';
import { CategoryCheckpoints } from '../lib/checkpoints';
test('checkpoint batching coalesces parallel saves, stays bounded and acknowledges only durable writes', async () => {
  let writes = 0,
    active = 0;
  const stored: CategoryMap = {};
  const queue = new CategoryCheckpoints(async (batch) => {
    writes++;
    active++;
    assert.ok(active <= 2);
    assert.ok(Object.keys(batch).length <= 100);
    await new Promise((resolve) => setTimeout(resolve, 2));
    Object.assign(stored, batch);
    active--;
  });
  await Promise.all(
    Array.from({ length: 160 }, (_, i) => {
      const word = `word${i}`;
      return queue
        .save({ [word]: AXES.map(() => 1) })
        .then(() => assert.ok(stored[word]));
    }),
  );
  assert.equal(writes, 2);
  assert.equal(Object.keys(stored).length, 160);
  const failed = new CategoryCheckpoints(async () => {
    throw new Error('offline');
  });
  const results = await Promise.allSettled([
    failed.save({ a: [] }),
    failed.save({ b: [] }),
  ]);
  assert.ok(results.every((r) => r.status === 'rejected'));
});
test('compact question payload reduces repeated criteria for the same complete dictionary sample', async () => {
  let bytes = 0,
    calls = 0,
    count = 0;
  const words = dictionary.words.slice(0, 32).map(([w]) => w);
  await prepareCategories(
    words,
    {},
    async (state, qs) => {
      const size = Buffer.byteLength(JSON.stringify({ state, questions: qs }));
      assert.ok(size <= CATEGORY_REQUEST_BYTES);
      bytes += size;
      calls++;
      count += Object.keys(qs).length;
      return answer(qs, () => ({ '1': 1 }));
    },
    new AbortController().signal,
    () => {},
    { concurrency: 4, pacer: unpaced },
  );
  const legacyCriteriaBytes =
    words.length *
    AXIS_DEFINITIONS.reduce(
      (n, d) =>
        n +
        Buffer.byteLength(
          JSON.stringify(
            Object.fromEntries(
              Array.from({ length: 63 }, (_, i) => [
                String(i + 1),
                d.tags.filter((_, b) => (i + 1) & (1 << b)).join(' + '),
              ]),
            ),
          ),
        ),
      0,
    );
  assert.equal(count, words.length * 36 * 2);
  assert.ok(
    bytes < legacyCriteriaBytes * 0.6,
    `${bytes} vs legacy criteria alone ${legacyCriteriaBytes}`,
  );
  console.log(
    `Compact 32-word sample: ${calls} requests, ${bytes} serialized bytes; legacy criteria alone ${legacyCriteriaBytes} bytes`,
  );
});

test('dictionary words matching inherited object properties classify in large cohorts', async () => {
  const index = dictionary.words.findIndex(([word]) => word === 'constructor');
  assert.ok(index >= 0);
  const words = dictionary.words.slice(index - 48, index + 48).map(([w]) => w);
  const existing: CategoryMap = {};
  await prepareCategories(
    words,
    existing,
    async (_state, questions) =>
      answer(questions, (_id, q) => ({ [Object.keys(q.criteria)[0]]: 1 })),
    new AbortController().signal,
    () => {},
    { concurrency: 8, pacer: unpaced },
  );
  assert.ok(Object.hasOwn(existing, 'constructor'));
  assert.ok(words.every((word) => isComplete(existing[word])));
  assert.deepEqual(
    existing['constructor'],
    AXES.map(() => 9),
  );
});

test('constructor classifies in small scans, resumes, checkpoints and survives category file reuse', async () => {
  const words = ['constructor', 'cat'];
  const nativeConstructor = Object.getOwnPropertyDescriptors(Object);
  const existing: CategoryMap = {};
  const persisted: CategoryMap = {};
  const checkpoints = new CategoryCheckpoints(async (batch) => {
    Object.assign(persisted, JSON.parse(JSON.stringify(batch)));
  });
  let questionsSeen = 0;
  const evaluate: Evaluate = async (_state, questions) => {
    questionsSeen += Object.keys(questions).length;
    return answer(questions, () => ({ '1': 1 }));
  };
  await prepareCategories(
    words,
    existing,
    evaluate,
    new AbortController().signal,
    (batch) => checkpoints.save(batch),
    { concurrency: 1, pacer: unpaced },
  );
  assert.equal(questionsSeen, words.length * AXES.length * 2);
  assert.ok(Object.hasOwn(persisted, 'constructor'));
  assert.ok(words.every((w) => isComplete(persisted[w])));
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), nativeConstructor);
  // A saved partial assignment is read as an own property and retains prior choices.
  const partial = {
    ...persisted,
    constructor: AXES.map((_, i) => (i === 0 ? 3 : 0)),
  };
  const file = JSON.parse(
    JSON.stringify(makeCategoryFile(partial, 'test-hash', words)),
  );
  const resumed = validateCategoryFile(file, 'test-hash', words);
  questionsSeen = 0;
  await prepareCategories(
    words,
    resumed,
    evaluate,
    new AbortController().signal,
    (batch) => checkpoints.save(batch),
    { concurrency: 1, pacer: unpaced },
  );
  assert.equal(questionsSeen, (AXES.length - 1) * 2);
  assert.equal(persisted['constructor'][0], 3);
  const completedFile = JSON.parse(
    JSON.stringify(makeCategoryFile(persisted, 'test-hash', words)),
  );
  assert.equal(completedFile.complete, true);
  assert.deepEqual(
    validateCategoryFile(completedFile, 'test-hash', words),
    persisted,
  );
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), nativeConstructor);
});

test('dimension cohorts merge concurrent axes without lost cells and preserve all existing decisions', async () => {
  const words = dictionary.words.slice(0, 96).map(([w]) => w);
  const existing: CategoryMap = {
    [words[0]]: [3, ...AXES.slice(1).map(() => 0)],
  };
  const stored: CategoryMap = {};
  const seen = new Set<string>();
  let calls = 0,
    writes = 0,
    bytes = 0,
    active = 0,
    peak = 0;
  const persistence = new CategoryCheckpoints(async (batch) => {
    writes++;
    await new Promise((r) => setTimeout(r, 2));
    for (const [word, assignment] of Object.entries(batch)) {
      assert.ok(
        assignment.filter(Boolean).length >=
          (stored[word]?.filter(Boolean).length || 0),
      );
      stored[word] = assignment;
    }
  });
  await prepareCategories(
    words,
    existing,
    async (state, qs, signal) => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      validateRequest({ state, questions: qs });
      const size = Buffer.byteLength(JSON.stringify({ state, questions: qs }));
      bytes += size;
      assert.ok(size <= CATEGORY_REQUEST_BYTES);
      const dimension = (state as { dimension: string }).dimension;
      assert.ok(AXES.includes(dimension as any));
      for (const q of Object.values(qs)) {
        assert.equal(Object.keys(q.criteria).length, 9);
        const word = JSON.parse(
          q.instructions.match(/tags apply to ("[^"]+")/)![1],
        );
        assert.ok(words.includes(word));
        const signature = `${word}:${dimension}:${Object.keys(q.criteria)[0]}`;
        assert.ok(!seen.has(signature));
        seen.add(signature);
        assert.ok(!(word === words[0] && dimension === AXES[0]));
      }
      await abortableDelay(calls % 3, signal);
      active--;
      return answer(qs, (_id, q) => ({ [Object.keys(q.criteria)[0]]: 1 }));
    },
    new AbortController().signal,
    (batch) => persistence.save(batch),
    { concurrency: 8, pacer: unpaced },
  );
  assert.equal(seen.size, (words.length * 36 - 1) * 2);
  assert.equal(peak, 8);
  assert.ok(words.every((w) => isComplete(stored[w])));
  assert.equal(stored[words[0]][0], 3);
  assert.ok(words.slice(1).every((w) => stored[w].every((v) => v === 9)));
  assert.ok(writes < calls);
  console.log(
    `Dimension cohort 96-word sample: ${calls} requests, ${writes} database writes, ${bytes} serialized bytes`,
  );
});

test('interleaved word sets coalesce without delaying or losing the newest axes', async () => {
  const left = dictionary.words.slice(0, 96).map(([w]) => w);
  const right = dictionary.words.slice(96, 192).map(([w]) => w);
  const snapshot = (words: string[], cells: number) =>
    Object.fromEntries(
      words.map((w) => [w, AXES.map((_, i) => (i < cells ? 1 : 0))]),
    );
  const writes: CategoryMap[] = [];
  const checkpoints = new CategoryCheckpoints(async (batch) => {
    writes.push(batch);
  });
  await Promise.all([
    checkpoints.save(snapshot(left, 1)),
    checkpoints.save(snapshot(right, 1)),
    checkpoints.save(snapshot(left, 2)),
    checkpoints.save(snapshot(right, 2)),
  ]);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((batch) => Object.keys(batch).length === 96));
  assert.ok(
    writes.every((batch) =>
      Object.values(batch).every((a) => a.filter(Boolean).length === 2),
    ),
  );
});
test('cancelling a dimension cohort settles every in-flight request', async () => {
  let active = 0,
    calls = 0;
  const c = new AbortController();
  const task = prepareCategories(
    dictionary.words.slice(0, 96).map(([w]) => w),
    {},
    async (_state, qs, signal) => {
      active++;
      calls++;
      try {
        await abortableDelay(100, signal);
        return answer(qs, (_id, q) => ({ [Object.keys(q.criteria)[0]]: 1 }));
      } finally {
        active--;
      }
    },
    c.signal,
    () => {},
    { concurrency: 8, pacer: unpaced },
  );
  await new Promise((r) => setTimeout(r, 5));
  c.abort();
  await assert.rejects(task);
  assert.equal(active, 0);
  assert.equal(calls, 8);
});

test('three cohorts overlap while respecting a shared odd concurrency ceiling', async () => {
  const words = dictionary.words.slice(0, 576).map(([w]) => w);
  const output: CategoryMap = {};
  let active = 0,
    peak = 0;
  const started = new Set<number>();
  await prepareCategories(
    words,
    {},
    async (_state, qs, signal) => {
      active++;
      peak = Math.max(peak, active);
      const word = JSON.parse(
        Object.values(qs)[0].instructions.match(/tags apply to ("[^"]+")/)![1],
      );
      started.add(Math.floor(words.indexOf(word) / 192));
      await abortableDelay(1, signal);
      active--;
      return answer(qs, (_id, q) => ({ [Object.keys(q.criteria)[0]]: 1 }));
    },
    new AbortController().signal,
    async (batch) => {
      await new Promise((r) => setTimeout(r, 1));
      for (const [word, a] of Object.entries(batch)) {
        if (
          a.filter(Boolean).length >=
          (output[word]?.filter(Boolean).length || 0)
        )
          output[word] = a;
      }
    },
    { concurrency: 5, pacer: unpaced },
  );
  assert.equal(peak, 5);
  assert.equal(active, 0);
  assert.equal(started.size, 3);
  assert.ok(words.every((w) => isComplete(output[w])));
});

test('storage overlaps disjoint words but serializes successive snapshots of one word', async () => {
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let begin!: () => void;
  const began = new Promise<void>((resolve) => (begin = resolve));
  const queue = new CategoryCheckpoints(async (batch) => {
    const name = Object.keys(batch).join(',');
    const version = batch.a?.[0] || 0;
    events.push(`start:${name}:${version}`);
    if (batch.a && version === 1) {
      begin();
      await held;
    }
    events.push(`done:${name}:${version}`);
  });
  const first = queue.save({ a: [1] });
  await began;
  const second = queue.save({ a: [2] });
  const separate = queue.save({ b: [1] });
  await separate;
  assert.ok(!events.includes('start:a:2'));
  release();
  await Promise.all([first, second]);
  assert.ok(events.indexOf('done:a:1') < events.indexOf('start:a:2'));
  assert.ok(events.indexOf('done:b:0') < events.indexOf('done:a:1'));
});

import { fetchJson, withAbort } from '../lib/request';
test('HTML gateway errors preserve status for retries while malformed successes fail', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response('<html>Unavailable</html>', { status: 503 });
    const result = await fetchJson(
      'https://example.test',
      {},
      new AbortController().signal,
    );
    assert.equal(result.response.status, 503);
    assert.equal(result.data, null);
    globalThis.fetch = async () => new Response('<html>Invalid</html>');
    await assert.rejects(
      fetchJson('https://example.test', {}, new AbortController().signal),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('request cancellation bounds a response body that never settles and does not start pre-cancelled work', async () => {
  const controller = new AbortController();
  let invoked = 0;
  const pending = withAbort(async () => {
    invoked++;
    return new Promise<never>(() => {});
  }, controller.signal);
  await Promise.resolve();
  controller.abort(new Error('bounded cancellation'));
  await assert.rejects(pending, /bounded cancellation/);
  assert.equal(invoked, 1);
  assert.throws(
    () =>
      withAbort(async () => {
        invoked++;
        return 1;
      }, controller.signal),
    /bounded cancellation/,
  );
  assert.equal(invoked, 1);
  const original = globalThis.fetch;
  const bodyController = new AbortController();
  let bodyStarted!: () => void;
  const started = new Promise<void>((r) => (bodyStarted = r));
  try {
    globalThis.fetch = (async () => ({
      json: () => {
        bodyStarted();
        return new Promise(() => {});
      },
    })) as unknown as typeof fetch;
    const request = fetchJson(
      'https://example.test',
      {},
      bodyController.signal,
    );
    await started;
    bodyController.abort(new Error('body timeout'));
    await assert.rejects(request, /body timeout/);
  } finally {
    globalThis.fetch = original;
  }
});

import {
  inflectedCandidates,
  expandCandidates,
  reviewGrammar,
} from '../lib/grammar';
import { compactChildren } from '../lib/dictionary';

test('compacting nested prefixes preserves words and removes serial decisions', () => {
  const original = [
    group('a', [
      group('ab', [word('able'), word('about')]),
      group('ac', [word('act'), word('acid')]),
    ]),
    group('b', [word('book'), word('boil')]),
  ];
  const compact = compactChildren(original);
  assert.deepEqual(
    new Set(compact.map((n) => (n.kind === 'word' ? n.word : 'group'))),
    new Set(['able', 'about', 'act', 'acid', 'book', 'boil']),
  );
  assert.equal(compact.length, 6);
});

function grammaticalMap(entries: [string, number, number][]): CategoryMap {
  return Object.fromEntries(
    entries.map(([w, type, inflection]) => {
      const a = Array(36).fill(128);
      a[AXES.indexOf('type')] = type;
      a[AXES.indexOf('inflection')] = inflection;
      return [w, a];
    }),
  );
}

test('missing plurals and verb forms are candidates only, and remain bounded', () => {
  const map = grammaticalMap([
    ['animal', 1, 1],
    ['book', 1, 1],
    ['child', 1, 1],
    ['go', 2, 4],
    ['boil', 2, 4],
    ['stop', 2, 4],
    ['make', 2, 4],
  ]);
  assert.ok(inflectedCandidates('animal', map).includes('animals'));
  assert.ok(inflectedCandidates('child', map).includes('children'));
  assert.ok(inflectedCandidates('go', map).includes('went'));
  assert.ok(inflectedCandidates('boil', map).includes('boils'));
  assert.ok(inflectedCandidates('stop', map).includes('stopped'));
  assert.ok(inflectedCandidates('make', map).includes('making'));
  assert.deepEqual(inflectedCandidates('unknown', map), []);
  assert.deepEqual(inflectedCandidates('constructor', {}), []);
  const many = grammaticalMap(
    Array.from({ length: 48 }, (_, i) => [
      'word' +
        String.fromCharCode(97 + (i % 26)) +
        String.fromCharCode(97 + Math.floor(i / 26)),
      3,
      5,
    ]),
  );
  assert.ok(
    expandCandidates(
      Object.keys(many),
      Array.from({ length: 110 }, (_, i) => 'common' + i),
      many,
    ).length <= 248,
  );
});

test('parallel Jev validity decisions exclude invalid grammar and premature stopping before final selection', async () => {
  const root = group('root', [word('animal'), word('cat')]);
  const prepared = grammaticalMap([
    ['animal', 1, 1],
    ['cat', 1, 1],
  ]);
  const sequence = ['they', 'are', 'animals', STOP];
  let index = 0,
    grammarCalls = 0;
  const evaluate: Evaluate = async (state: any, qs) => {
    validateRequest({ state, questions: qs });
    assert.ok(JSON.stringify({ state, questions: qs }).length < 90000);
    if (Object.keys(qs)[0].startsWith('v')) {
      grammarCalls++;
      return answer(qs, (_id, q) => ({
        [q.instructions.includes('exactly "animal"') ||
        (q.instructions.startsWith('Does reply') && index < 3)
          ? 'reject'
          : 'allow']: 1,
      }));
    }
    if (qs.next) {
      assert.ok(!Object.hasOwn(qs.next.criteria, 'animal'));
      if (index < 3) assert.ok(!Object.hasOwn(qs.next.criteria, STOP));
      assert.ok(Object.hasOwn(qs.next.criteria, sequence[index]));
      return answer(qs, () => ({ [sequence[index++]]: 1 }));
    }
    return answer(qs, () => ({ o0: 0.9, o1: 0.1 }));
  };
  const result = await generate({
    root,
    common: ['they', 'are', 'the'],
    history: [{ role: 'user', content: 'Tell me about cats.' }],
    beam: 1,
    maxWords: 8,
    grammarReview: true,
    prepared,
    signal: new AbortController().signal,
    evaluate,
    onPhase: () => {},
    onStep: () => {},
  });
  assert.equal(result.text, 'They are animals');
  assert.equal(grammarCalls, 4);
});

test('grammar rejection fails closed and does not emit an assistant-authored substitute', async () => {
  let emitted = false;
  await assert.rejects(
    generate({
      root: group('root', [word('cat'), word('book')]),
      common: [],
      history: [],
      beam: 1,
      maxWords: 2,
      grammarReview: true,
      signal: new AbortController().signal,
      evaluate: async (_state, qs) =>
        answer(
          qs,
          (id): Record<string, number> =>
            id.startsWith('v') ? { reject: 1 } : { o0: 1 },
        ),
      onPhase: () => {},
      onStep: () => {
        emitted = true;
      },
    }),
    /too few grammatical/,
  );
  assert.equal(emitted, false);
});

test('grammar batch supports all 255 candidates in one bounded request and respects cancellation', async () => {
  const candidates = Array.from(
    { length: 254 },
    (_, i) => 'candidate' + i,
  ).concat(STOP);
  let calls = 0;
  const evaluate: Evaluate = async (state, qs) => {
    calls++;
    validateRequest({ state, questions: qs });
    assert.ok(
      Buffer.byteLength(JSON.stringify({ state, questions: qs })) < 90000,
    );
    return answer(qs, () => ({ allow: 1 }));
  };
  const reviewed = await reviewGrammar(
    { reply_so_far: 'They are animals.' },
    candidates,
    evaluate,
    new AbortController().signal,
  );
  assert.equal(reviewed.allowed.size, 255);
  assert.equal(calls, 1);
  const c = new AbortController();
  c.abort();
  await assert.rejects(reviewGrammar({}, candidates, evaluate, c.signal));
  assert.equal(calls, 1);
});

test('old category files remain compatible after translating presentation labels, but semantic changes are rejected', () => {
  const map = grammaticalMap([
      ['animal', 1, 1],
      ['book', 1, 1],
    ]),
    words = Object.keys(map);
  const file = JSON.parse(JSON.stringify(makeCategoryFile(map, 'hash', words)));
  file.definitions.forEach((d: any) => {
    d.label = 'Previous translated label';
  });
  assert.deepEqual(validateCategoryFile(file, 'hash', words), map);
  file.definitions[0].tags[0] = 'different-meaning';
  assert.throws(() => validateCategoryFile(file, 'hash', words));
});

import { loadInitialCategories } from '../lib/category-bootstrap';
import { TAXONOMY_VERSION } from '../lib/categories';
import categoryMetadata from '../data/category-map-metadata.json';
test('fresh installations automatically load the complete shipped Jev map without model calls or writes', async () => {
  const calls: string[] = [];
  const raw = fs.readFileSync('data/jev-category-map-36-complete.json', 'utf8');
  const result = await loadInitialCategories(
    dictionary.words.map(([w]) => w),
    async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, undefined);
      if (String(url) === '/api/categories')
        return Response.json({ sessionId: null });
      assert.ok(
        String(url).startsWith('/data/jev-category-map-36-complete.json?v='),
      );
      return new Response(raw);
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.bundled, true);
  assert.equal(result.page.complete, true);
  assert.equal(result.page.verifiedCount, 87776);
  assert.equal(result.page.scannedCells, 87776 * 36);
  assert.equal(Object.keys(result.page.categories).length, dictionary.count);
});
test('partial saved sessions are preserved and never blended with bundled classifications', async () => {
  const calls: string[] = [];
  const base = {
    version: TAXONOMY_VERSION,
    sourceSha256: categoryMetadata.dictionarySha256,
    sessionId: 'saved',
    complete: false,
  };
  const result = await loadInitialCategories(['water', 'tea'], async (url) => {
    calls.push(String(url));
    return Response.json(
      calls.length === 1
        ? {
            ...base,
            categories: { water: AXES.map(() => 1) },
            nextCursor: 'water',
          }
        : { ...base, categories: { tea: AXES.map(() => 0) }, nextCursor: null },
    );
  });
  assert.equal(result.bundled, false);
  assert.equal(result.page.complete, false);
  assert.deepEqual(Object.keys(result.page.categories), ['water', 'tea']);
  assert.ok(calls.every((url) => url.startsWith('/api/categories')));
});
test('unavailable storage permits the default map, but incomplete default files fail closed', async () => {
  const good = makeCategoryFile(
    { water: AXES.map(() => 1) },
    categoryMetadata.dictionarySha256,
    ['water'],
  );
  const request =
    (file: unknown): typeof fetch =>
    async (url) => {
      if (String(url) === '/api/categories') throw new Error('No database');
      return Response.json(file);
    };
  const loaded = await loadInitialCategories(['water'], request(good));
  assert.equal(loaded.storageUnavailable, true);
  assert.equal(loaded.page.complete, true);
  const partial = makeCategoryFile(
    { water: AXES.map(() => 0) },
    categoryMetadata.dictionarySha256,
    ['water'],
  );
  await assert.rejects(
    loadInitialCategories(['water'], request(partial)),
    /must cover every word/,
  );
  await assert.rejects(
    loadInitialCategories(
      ['water'],
      request({ ...good, sourceSha256: 'wrong' }),
    ),
    /does not match/,
  );
});
test('a failed later saved page cannot silently replace a known session with the bundled map', async () => {
  let calls = 0;
  await assert.rejects(
    loadInitialCategories(['water'], async (url) => {
      assert.ok(String(url).startsWith('/api/categories'));
      calls++;
      if (calls > 1) return new Response('', { status: 503 });
      return Response.json({
        version: TAXONOMY_VERSION,
        sourceSha256: categoryMetadata.dictionarySha256,
        sessionId: 'saved',
        categories: {},
        nextCursor: 'water',
      });
    }),
    /Could not load the saved/,
  );
});
