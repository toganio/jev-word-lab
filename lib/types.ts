export type Criteria = Record<string, string | null>;
export type Question = {
  type: 'choice';
  instructions: string;
  criteria: Criteria;
};
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type DecisionResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};
export type Evaluate = (
  state: unknown,
  questions: Record<string, Question>,
  signal: AbortSignal,
) => Promise<DecisionResponse>;
export type Dictionary = {
  source: string;
  sourceUrl: string;
  categories: string[];
  words: [string, number[]][];
  count: number;
  rankNote: string;
};
export type Candidate = {
  label: string;
  probability: number;
  retained?: boolean;
};
export type Trace = {
  stage: string;
  path: string;
  options: number;
  candidates: Candidate[];
  excluded?: { word: string; reason: string }[];
};
export type Step = {
  index: number;
  word: string;
  confidence: number;
  traces: Trace[];
  candidates: Candidate[];
  ms: number;
};
export type Message = { role: 'user' | 'assistant'; content: string };
export type Stats = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  words: number;
  startedAt: number;
  elapsedMs: number;
};
