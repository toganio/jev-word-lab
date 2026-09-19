import type { Message, Stats, Step } from './types';
import { MAX_CONCURRENCY } from './parallel';
export const APP_VERSION = 'jev-lab-11-default-categories';
export type RunStatus = 'running' | 'completed' | 'stopped' | 'error';
export type RecordedOperation = {
  id: number;
  label: string;
  status: string;
  at: number;
  ms: number;
  questions: number;
  options: number;
  summary: string;
};
export type RunRecord = {
  id: string;
  revision: number;
  kind: 'conversation' | 'classification';
  startedAt: number;
  status: RunStatus;
  question: string;
  answer: string;
  reason: string;
  appVersion: string;
  settings: {
    limit: number;
    beam: number;
    maxWords: number;
    requestBudget: number;
    repetitionGuard: boolean;
    grammarReview?: boolean;
    parallelism?: number;
  };
  conversation: Message[];
  steps: Step[];
  operations: RecordedOperation[];
  usage: Stats;
};
function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid text');
  return v;
}
function num(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max)
    throw new Error('Invalid number');
  return v;
}
function arr<T>(v: unknown, max: number, fn: (x: any) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Error('Invalid array');
  return v.map(fn);
}
/** Explicit allowlist: API keys, headers, and arbitrary extra fields never enter storage. */
export function sanitizeRecord(input: any): RunRecord {
  if (!input || typeof input !== 'object') throw new Error('Invalid record');
  const id = str(input.id, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error('Invalid id');
  if (
    !['conversation', 'classification'].includes(input.kind) ||
    !['running', 'completed', 'stopped', 'error'].includes(input.status)
  )
    throw new Error('Invalid status');
  const settings = input.settings,
    usage = input.usage;
  if (!settings || !usage || typeof settings.repetitionGuard !== 'boolean')
    throw new Error('Invalid settings');
  const candidate = (c: any) => ({
    label: str(c.label, 200),
    probability: num(c.probability, 1),
    ...(typeof c.retained === 'boolean' ? { retained: c.retained } : {}),
  });
  return {
    id,
    revision: num(input.revision),
    kind: input.kind,
    startedAt: num(input.startedAt),
    status: input.status,
    question: str(input.question, 2000),
    answer: str(input.answer, 12000),
    reason: str(input.reason, 2000),
    appVersion: str(input.appVersion, 80),
    settings: {
      limit: num(settings.limit, 100000),
      beam: num(settings.beam, 5),
      maxWords: num(settings.maxWords, 64),
      requestBudget: num(
        settings.requestBudget,
        input.kind === 'classification' ? 500000 : 400,
      ),
      repetitionGuard: settings.repetitionGuard,
      ...(typeof settings.grammarReview === 'boolean'
        ? { grammarReview: settings.grammarReview }
        : {}),
      ...(typeof settings.parallelism === 'number'
        ? { parallelism: num(settings.parallelism, MAX_CONCURRENCY) }
        : {}),
    },
    conversation: arr(input.conversation, 10, (m) => {
      if (!['user', 'assistant'].includes(m.role))
        throw new Error('Invalid role');
      return { role: m.role, content: str(m.content, 12000) };
    }),
    steps: arr(input.steps, 65, (s) => ({
      index: num(s.index, 64),
      word: str(s.word, 200),
      confidence: num(s.confidence, 1),
      ms: num(s.ms),
      candidates: arr(s.candidates, 8, candidate),
      traces: arr(s.traces, 85, (t) => ({
        stage: str(t.stage, 80),
        path: str(t.path, 2000),
        options: num(t.options, 2000),
        candidates: arr(t.candidates, 8, candidate),
        ...(t.excluded
          ? {
              excluded: arr(t.excluded, 1000, (e) => ({
                word: str(e.word, 200),
                reason: str(e.reason, 120),
              })),
            }
          : {}),
      })),
    })),
    operations: arr(input.operations, 401, (o) => ({
      id: num(o.id),
      label: str(o.label, 100),
      status: str(o.status, 20),
      at: num(o.at),
      ms: num(o.ms),
      questions: num(o.questions, 256),
      options: num(o.options, 65280),
      summary: str(o.summary, 24000),
    })),
    usage: {
      requests: num(
        usage.requests,
        input.kind === 'classification' ? 500000 : 400,
      ),
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      words: num(usage.words, input.kind === 'classification' ? 100000 : 1000),
      startedAt: num(usage.startedAt),
      elapsedMs: num(usage.elapsedMs),
    },
  };
}
