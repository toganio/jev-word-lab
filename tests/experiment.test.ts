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
    assert.match(await res.text(), /yalnızca Jev/);
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
