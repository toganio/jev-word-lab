'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Network,
  KeyRound,
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  GitBranch,
  Circle,
  ShieldCheck,
  Check,
  X,
  Square,
  RotateCcw,
  Download,
  LoaderCircle,
  ChevronRight,
  FlaskConical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  buildPreparedTree,
  commonWords,
  categoryLabel,
} from '@/lib/dictionary';
import {
  AXES,
  AXIS_DEFINITIONS,
  AXIS_LABELS,
  CATEGORY_OPTIONS,
  TAXONOMY_VERSION,
  QUESTIONS_PER_REQUEST,
  QUESTIONS_PER_CELL,
  isComplete,
  selectedLabels,
  prepareCategories,
  type CategoryMap,
} from '@/lib/categories';
import {
  makeCategoryFile,
  validateCategoryFile,
  scannedCells,
} from '@/lib/category-file';
import {
  DEFAULT_CONCURRENCY,
  TARGET_INPUT_TPS,
  ProviderError,
  retryThrottled,
} from '@/lib/parallel';
import {
  loadInitialCategories,
  type CategoryPage,
  type CategoryLoadProgress,
} from '@/lib/category-bootstrap';
import { CategoryCheckpoints } from '@/lib/checkpoints';
import { fetchJson } from '@/lib/request';
import { generate } from '@/lib/engine';
import { RunRecorder, type SaveStatus } from '@/lib/recorder';
import { APP_VERSION, type RunStatus } from '@/lib/run-record';
import { validateResponse } from '@/lib/protocol';
import { registerLabTools } from '@/lib/webmcp';
import type {
  Dictionary,
  Evaluate,
  Message,
  Stats,
  Step,
  Trace,
} from '@/lib/types';
type Operation = {
  id: number;
  label: string;
  status: 'pending' | 'done' | 'error' | 'cancelled';
  at: number;
  ms: number;
  questions: number;
  options: number;
  summary: string;
};
const INITIAL: Stats = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  words: 0,
  startedAt: 0,
  elapsedMs: 0,
};
const number = (n: number) => n.toLocaleString('en-US');
function Picker({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  disabled?: boolean;
}) {
  return (
    <label className="picker">
      <span>{label}</span>
      <Select
        value={value}
        onValueChange={(v) => v && onChange(v)}
        disabled={disabled}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>{options.find(([v]) => v === value)?.[1]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export default function Home() {
  const [operations, setOperations] = useState<Operation[]>([]),
    [monitorTab, setMonitorTab] = useState('monitor');
  const operationId = useRef(0);
  const recording = useRef<RunRecorder | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [recordId, setRecordId] = useState('');
  const [key, setKey] = useState(''),
    [connected, setConnected] = useState(false),
    [checking, setChecking] = useState(false);
  const [dict, setDict] = useState<Dictionary | null>(null),
    [loadError, setLoadError] = useState('');
  const [repetitionGuard, setRepetitionGuard] = useState(true);
  const [grammarReview, setGrammarReview] = useState(true);
  const [targetSentences, setTargetSentences] = useState('3');
  const treeCache = useRef<{
    dict: Dictionary;
    prepared: CategoryMap;
    root: ReturnType<typeof buildPreparedTree>;
  } | null>(null);
  const [prompt, setPrompt] = useState('How do I make a good cup of tea?');
  const limit = '0';
  const [beam, setBeam] = useState('3'),
    [maxWords, setMaxWords] = useState('32'),
    [budget, setBudget] = useState('200');
  const [messages, setMessages] = useState<Message[]>([]),
    [steps, setSteps] = useState<Step[]>([]),
    [selected, setSelected] = useState(-1);
  const [running, setRunning] = useState(false),
    [classifying, setClassifying] = useState(false),
    [phase, setPhase] = useState('Connect your API key to begin.'),
    [error, setError] = useState('');
  const [stats, setStats] = useState<Stats>(INITIAL),
    [liveTrace, setLiveTrace] = useState<Trace | null>(null);
  const [overrides, setOverrides] = useState<CategoryMap>({}),
    [query, setQuery] = useState('');
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoryError, setCategoryError] = useState('');
  const [categoryLoadProgress, setCategoryLoadProgress] =
    useState<CategoryLoadProgress>({ stage: 'dictionary' });
  const [bundledCategories, setBundledCategories] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const pendingCategories = useRef<CategoryMap | null>(null);
  const preparationActive = useRef(false);
  const classificationStartCells = useRef(0);
  const [parallelism, setParallelism] = useState(String(DEFAULT_CONCURRENCY));
  const [activeRequests, setActiveRequests] = useState(0);
  const [throughput, setThroughput] = useState({
    tokensPerSecond: 0,
    targetTokensPerSecond: TARGET_INPUT_TPS,
  });
  const sessionRef = useRef<string | null>(null);
  const sourceHash = useRef('');
  const [coverage, setCoverage] = useState<{
    expectedCount: number;
    expectedCells: number;
    verifiedCount: number;
    scannedCells: number;
    missingCount: number;
    complete: boolean;
    sessionId: string | null;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const previewEntries = useMemo(
    () => Object.entries(overrides).slice(0, 100),
    [overrides],
  );
  const categoryGroups = useMemo(
    () =>
      Object.fromEntries(
        AXES.map((axis, index) => {
          const groups: Record<string, string[]> = {};
          // Bounded preview; the downloadable file contains every word.
          for (const [word, assignment] of previewEntries) {
            for (const label of selectedLabels(axis, assignment[index]))
              (groups[label] ||= []).push(word);
          }
          return [axis, groups];
        }),
      ) as Record<string, Record<string, string[]>>,
    [previewEntries],
  );
  const preparedCount = useMemo(
    () => dict?.words.filter(([w]) => isComplete(overrides[w])).length || 0,
    [dict, overrides],
  );
  const scannedCount = useMemo(() => scannedCells(overrides), [overrides]);
  const categoriesReady =
    !categoriesLoading &&
    !categoryError &&
    !importing &&
    !!dict &&
    preparedCount === dict.count &&
    coverage?.complete === true &&
    !pendingCategories.current;
  const categoryLoadPercent =
    categoryLoadProgress.stage === 'ready'
      ? 100
      : categoryLoadProgress.total && categoryLoadProgress.loaded !== undefined
        ? Math.min(
            99,
            Math.floor(
              (categoryLoadProgress.loaded / categoryLoadProgress.total) * 100,
            ),
          )
        : null;
  const categoryLoadLabel = {
    dictionary: 'Loading the English dictionary…',
    checking: 'Checking for saved categories…',
    downloading: 'Downloading category file…',
    saved: 'Loading saved categories…',
    verifying: 'Verifying every word and all 36 dimensions…',
    ready: categoriesReady
      ? 'Every word and all 36 dimensions are ready.'
      : 'Saved categories loaded. Some words still need categorization.',
  }[categoryLoadProgress.stage];
  const categoryLoadDetail =
    categoryLoadProgress.unit === 'bytes'
      ? `${((categoryLoadProgress.loaded || 0) / 1000000).toFixed(1)} / ${((categoryLoadProgress.total || 0) / 1000000).toFixed(1)} MB`
      : categoryLoadProgress.unit === 'words'
        ? `${number(categoryLoadProgress.loaded || 0)}${categoryLoadProgress.total !== undefined ? ` / ${number(categoryLoadProgress.total)}` : ''} words loaded`
        : '';
  async function loadCategories() {
    setCategoriesLoading(true);
    setCategoryLoadProgress({ stage: 'dictionary' });
    setCategoryError('');
    try {
      const dictionary = await dictPromise.current;
      if (!dictionary) throw new Error('Dictionary is not ready.');
      const result = await loadInitialCategories(
        dictionary.words.map(([word]) => word),
        fetch,
        setCategoryLoadProgress,
      );
      sessionRef.current = result.page.sessionId;
      sourceHash.current = result.page.sourceSha256;
      setCoverage(result.page);
      setOverrides(result.page.categories);
      setBundledCategories(result.bundled);
      setStorageUnavailable(result.storageUnavailable);
    } catch (error) {
      setCategoryError(
        error instanceof Error
          ? error.message
          : 'Could not load categories. Reload to try again.',
      );
    } finally {
      setCategoriesLoading(false);
    }
  }
  async function startCategorySession(fromFile = false) {
    const response = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        version: TAXONOMY_VERSION,
        sourceSha256: sourceHash.current,
        sessionId: fromFile ? null : sessionRef.current,
        origin: fromFile ? 'file' : 'jev',
      }),
    });
    if (!response.ok) throw new Error('Could not start the category session.');
    sessionRef.current = (
      (await response.json()) as { sessionId: string }
    ).sessionId;
    setCoverage((old) =>
      old ? { ...old, sessionId: sessionRef.current, complete: false } : old,
    );
  }
  async function verifyCategorySession() {
    const response = await fetch(
      `/api/categories?status=1&session=${encodeURIComponent(sessionRef.current || '')}`,
    );
    if (!response.ok)
      throw new Error('Could not verify full dictionary coverage.');
    const data = (await response.json()) as CategoryPage;
    setCoverage(data);
    return data.complete === true;
  }
  async function saveCategories(categories: CategoryMap) {
    // Idempotent persistence retries never call Jev or add paid model work.
    const entries = Object.entries(categories);
    for (let i = 0; i < entries.length; i += 100) {
      const body = JSON.stringify({
        version: TAXONOMY_VERSION,
        sourceSha256: sourceHash.current,
        sessionId: sessionRef.current,
        categories: Object.fromEntries(entries.slice(i, i + 100)),
      });
      await retryThrottled(
        async () => {
          const timeout = AbortSignal.timeout(30000);
          try {
            const { response: r } = await fetchJson(
              '/api/categories',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
              },
              timeout,
            );
            if (!r.ok)
              throw new ProviderError(
                'Could not save categories; results are retained in memory.',
                r.status,
              );
          } catch (error) {
            if (timeout.aborted)
              throw new ProviderError(
                'Storage timed out; retrying the save without repeating the Jev request.',
                408,
              );
            throw error;
          }
        },
        new AbortController().signal,
        () => setPhase('Saving results; retrying the storage connection.'),
      );
    }
  }
  function downloadCategories() {
    if (!dict || !sourceHash.current) return;
    const file = makeCategoryFile(
      overrides,
      sourceHash.current,
      dict.words.map(([w]) => w),
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(file)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = file.complete
      ? 'jev-category-map-36-complete.json'
      : 'jev-category-map-36-partial.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function uploadCategories(file?: File) {
    if (!file || !dict || busy.current || categoriesLoading) return;
    busy.current = true;
    setImporting(true);
    setError('');
    const c = new AbortController();
    controller.current = c;
    try {
      if (file.size > 64000000)
        throw new Error('The file exceeds the 64 MB limit.');
      const map = validateCategoryFile(
        JSON.parse(await file.text()),
        sourceHash.current,
        dict.words.map(([w]) => w),
      );
      await startCategorySession(true);
      setBundledCategories(false);
      setOverrides({});
      const entries = Object.entries(map);
      for (let i = 0; i < entries.length; i += 100) {
        c.signal.throwIfAborted();
        const batch = Object.fromEntries(entries.slice(i, i + 100));
        pendingCategories.current = batch;
        await saveCategories(batch);
        pendingCategories.current = null;
        setOverrides((old) => ({ ...old, ...batch }));
        setPhase(
          `Uploading category file: ${Math.min(i + 100, entries.length)} / ${entries.length}`,
        );
      }
      const complete = await verifyCategorySession();
      setPhase(
        complete
          ? 'Category file ready · every word and all 36 dimensions verified.'
          : 'Partial file loaded. Jev will scan only missing dimensions.',
      );
    } catch (e) {
      setError(
        c.signal.aborted
          ? 'Upload stopped. Saved progress is retained in the session.'
          : e instanceof Error
            ? e.message
            : 'Could not upload the file.',
      );
    } finally {
      setImporting(false);
      busy.current = false;
      controller.current = null;
    }
  }
  const controller = useRef<AbortController | null>(null),
    statsRef = useRef(INITIAL),
    busy = useRef(false),
    keyRef = useRef(''),
    stateRef = useRef<unknown>({});
  const dictPromise = useRef<Promise<Dictionary> | null>(null);
  keyRef.current = key;
  const loadDictionary = useCallback(() => {
    setLoadError('');
    if (!dictPromise.current)
      dictPromise.current = fetch('/data/dictionary.json').then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      });
    dictPromise.current.then(setDict).catch(() => {
      dictPromise.current = null;
      setLoadError('Could not load the dictionary. Try again.');
    });
  }, []);
  useEffect(() => {
    loadDictionary();
    void loadCategories();
    return () => controller.current?.abort();
  }, [loadDictionary]);
  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);
  stateRef.current = {
    running,
    classifying,
    connected,
    phase,
    stats,
    messages,
    latestStep: steps.at(-1),
    dictionaryWords: dict?.count,
    preparedWords: preparedCount,
    categorySession: coverage,
    operations: operations.slice(-30),
    provider: 'TypeSafe',
    fallback: false,
  };
  useEffect(
    () =>
      registerLabTools(
        () => stateRef.current,
        (q) => {
          if (busy.current) throw new Error('An experiment is running.');
          setPrompt(q);
        },
        stop,
      ),
    [stop],
  );
  const updateStats = (patch: Partial<Stats>) => {
    statsRef.current = { ...statsRef.current, ...patch };
    setStats(statsRef.current);
    recording.current?.patch({ usage: statsRef.current });
  };
  function beginRecording(
    kind: 'conversation' | 'classification',
    question: string,
    conversation: Message[],
  ) {
    const id = crypto.randomUUID();
    setRecordId(id);
    setSaveStatus('saving');
    recording.current = new RunRecorder(
      {
        id,
        revision: 0,
        kind,
        startedAt: Date.now(),
        status: 'running',
        question,
        answer: '',
        reason: 'Started',
        appVersion: APP_VERSION,
        settings: {
          limit: Number(limit),
          beam: Number(beam),
          maxWords: Number(maxWords),
          targetSentences: Number(targetSentences),
          requestBudget:
            kind === 'classification'
              ? Math.ceil(
                  ((dict?.count || 0) * AXES.length * QUESTIONS_PER_CELL) /
                    QUESTIONS_PER_REQUEST,
                )
              : Number(budget),
          repetitionGuard,
          grammarReview,
          parallelism: Number(parallelism),
        },
        conversation: conversation.slice(-10),
        steps: [],
        operations: [],
        usage: statsRef.current,
      },
      setSaveStatus,
    );
  }
  function logOperation(operation: Operation) {
    setOperations((old) =>
      old.some((o) => o.id === operation.id)
        ? old.map((o) => (o.id === operation.id ? operation : o))
        : [...old.slice(-399), operation],
    );
    recording.current?.operation(operation);
  }
  const evaluate: Evaluate = async (state, questions, signal) => {
    signal.throwIfAborted();
    if (
      !preparationActive.current &&
      statsRef.current.requests >= Number(budget)
    )
      throw new Error('API request budget reached. Partial reply retained.');
    updateStats({ requests: statsRef.current.requests + 1 });
    const id = ++operationId.current,
      at = Date.now();
    const entries = Object.entries(questions);
    const label = entries[0][0].startsWith('v')
      ? 'Jev grammar guidance'
      : questions.next
        ? 'Finalist comparison'
        : questions.check
          ? 'API connection check'
          : entries[0][0].startsWith('w')
            ? 'Word classification'
            : entries[0][1].instructions.includes('Group: English dictionary')
              ? 'Category selection'
              : 'Subgroup selection';
    const operation: Operation = {
      id,
      label,
      status: 'pending',
      at,
      ms: 0,
      questions: entries.length,
      options: entries.reduce(
        (n, [, q]) => n + Object.keys(q.criteria).length,
        0,
      ),
      summary: 'Waiting for Jev…',
    };
    logOperation(operation);
    const timeout = AbortSignal.timeout(30000);
    try {
      const { response: r, data } = await fetchJson(
        '/api/decision',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-typesafe-key': keyRef.current.trim(),
          },
          body: JSON.stringify({ state, questions }),
        },
        AbortSignal.any([signal, timeout]),
      );
      if (!r.ok)
        throw new ProviderError(
          data &&
            typeof data === 'object' &&
            'error' in data &&
            typeof data.error === 'string'
            ? data.error
            : `API error (${r.status})`,
          r.status,
          data &&
            typeof data === 'object' &&
            'retryAfterMs' in data &&
            typeof data.retryAfterMs === 'number' &&
            Number.isFinite(data.retryAfterMs)
            ? Math.max(0, data.retryAfterMs)
            : 0,
        );
      validateResponse(data, questions);
      const summary =
        Object.entries(data.answers)
          .slice(0, preparationActive.current ? 32 : 3)
          .map(([qid, a]) =>
            qid === 'next'
              ? `Selected: ${a.choice === '__END__' ? 'End reply' : a.choice}`
              : qid.startsWith('g')
                ? (questions[qid].criteria[a.choice] || a.choice)
                    .split('Examples:')[0]
                    .slice(0, 100)
                : preparationActive.current
                  ? `${(state as { dimension?: string }).dimension || ''} ${questions[qid].instructions.split('. ')[0]}: ${questions[qid].criteria[a.choice] || a.choice}`
                  : a.choice,
          )
          .join(' / ') +
        (!preparationActive.current && entries.length > 3
          ? ` (+${entries.length - 3} results)`
          : '');
      logOperation({
        ...operation,
        status: 'done',
        ms: Date.now() - at,
        summary,
      });
      updateStats({
        inputTokens: statsRef.current.inputTokens + data.usage.input_tokens,
        outputTokens: statsRef.current.outputTokens + data.usage.output_tokens,
        elapsedMs: Date.now() - statsRef.current.startedAt,
      });
      return data;
    } catch (e) {
      const summary = signal.aborted
        ? 'Stopped by the user.'
        : e instanceof Error
          ? e.message
          : 'Request failed.';
      logOperation({
        ...operation,
        status: signal.aborted ? 'cancelled' : 'error',
        ms: Date.now() - at,
        summary,
      });
      if (!signal.aborted && timeout.aborted) {
        throw new ProviderError(
          'Jev request timed out; bounded retries will follow.',
          408,
        );
      }
      throw e;
    }
  };
  async function connect() {
    if (busy.current || !key.trim()) return;
    busy.current = true;
    setChecking(true);
    setError('');
    setOperations([]);
    setMonitorTab('monitor');
    const c = new AbortController();
    controller.current = c;
    statsRef.current = { ...INITIAL, startedAt: Date.now() };
    setStats(statsRef.current);
    try {
      await evaluate(
        { text: 'Hello' },
        {
          check: {
            type: 'choice',
            instructions: 'Which language is the text written in?',
            criteria: { English: null, Turkish: null },
          },
        },
        c.signal,
      );
      setConnected(true);
      setPhase(
        'Connected. Prepare categories with Jev or load a category file.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
      setConnected(false);
    } finally {
      setChecking(false);
      busy.current = false;
      controller.current = null;
    }
  }
  async function run() {
    if (
      busy.current ||
      !connected ||
      !dict ||
      !prompt.trim() ||
      !categoriesReady
    )
      return;
    busy.current = true;
    const c = new AbortController();
    controller.current = c;
    setRunning(true);
    setError('');
    setOperations([]);
    setMonitorTab('monitor');
    setSteps([]);
    setSelected(-1);
    setLiveTrace(null);
    const history: Message[] = [
      ...messages,
      { role: 'user', content: prompt.trim() },
    ];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setPrompt('');
    statsRef.current = { ...INITIAL, startedAt: Date.now() };
    setStats(statsRef.current);
    beginRecording('conversation', history.at(-1)!.content, history);
    let outcome: RunStatus = 'completed',
      outcomeReason = '';
    try {
      if (
        !treeCache.current ||
        treeCache.current.dict !== dict ||
        treeCache.current.prepared !== overrides
      ) {
        treeCache.current = {
          dict,
          prepared: overrides,
          root: buildPreparedTree(dict, Number(limit), overrides),
        };
      }
      const root = treeCache.current.root;
      const result = await generate({
        root,
        common: commonWords(dict, Number(limit)).filter((w) =>
          Object.hasOwn(overrides, w),
        ),
        history,
        beam: Number(beam),
        maxWords: Number(maxWords),
        targetSentences: Number(targetSentences),
        repetitionGuard,
        grammarReview,
        prepared: overrides,
        signal: c.signal,
        evaluate,
        onPhase: (text, trace) => {
          setPhase(text);
          recording.current?.patch({ reason: text });
          if (trace) setLiveTrace(trace);
          if (trace?.excluded?.length) {
            const id = ++operationId.current;
            logOperation({
              id,
              label:
                trace.stage === 'Jev grammar guidance'
                  ? 'Jev grammar decisions'
                  : 'Repetition guard · application filter',
              status: 'done',
              at: Date.now(),
              ms: 0,
              questions: 0,
              options: trace.excluded!.length,
              summary: trace
                .excluded!.map((x) => `${x.word}: ${x.reason}`)
                .join(' / '),
            });
          }
        },
        onStep: (step, text) => {
          setSteps((s) => [...s, step]);
          recording.current?.step(step, text);
          setMessages([...history, { role: 'assistant', content: text }]);
          updateStats({
            words: text.split(/\s+/).filter(Boolean).length,
            elapsedMs: Date.now() - statsRef.current.startedAt,
          });
        },
      });
      outcomeReason = result.reason;
      setPhase(result.reason);
    } catch (e) {
      outcome = c.signal.aborted ? 'stopped' : 'error';
      outcomeReason = c.signal.aborted
        ? 'Stopped by the user'
        : e instanceof Error
          ? e.message
          : 'Experiment failed';
      if (c.signal.aborted) setPhase('Stopped. Partial reply retained.');
      else {
        setError(
          e instanceof Error ? e.message : 'Could not complete the experiment.',
        );
        setPhase('Experiment stopped.');
      }
    } finally {
      updateStats({ elapsedMs: Date.now() - statsRef.current.startedAt });
      const recorder = recording.current;
      recording.current = null;
      await recorder?.finish(outcome, outcomeReason);
      setRunning(false);
      busy.current = false;
      controller.current = null;
      setLiveTrace(null);
    }
  }
  async function classify() {
    if (
      busy.current ||
      !dict ||
      !connected ||
      categoriesLoading ||
      categoryError
    )
      return;
    busy.current = true;
    setClassifying(true);
    preparationActive.current = true;
    setThroughput({
      tokensPerSecond: 0,
      targetTokensPerSecond: TARGET_INPUT_TPS,
    });
    setError('');
    setOperations([]);
    setMonitorTab('monitor');
    const c = new AbortController();
    controller.current = c;
    statsRef.current = { ...INITIAL, startedAt: Date.now() };
    setStats(statsRef.current);
    const restored = { ...overrides, ...pendingCategories.current };
    classificationStartCells.current = scannedCells(restored);
    const words = dict.words
      .slice(0, Number(limit) || dict.count)
      .filter(([w]) => !isComplete(restored[w]))
      .map(([w]) => w);
    let done = 0;
    const checkpoints = new CategoryCheckpoints(saveCategories);
    beginRecording(
      'classification',
      `${words.length} English words: scan missing dimensions using the 36-axis schema (${TAXONOMY_VERSION})`,
      [],
    );
    let outcome: RunStatus = 'completed',
      outcomeReason = '';
    try {
      await startCategorySession();
      if (pendingCategories.current) {
        await saveCategories(pendingCategories.current);
        const recovered = pendingCategories.current;
        setOverrides((old) => ({ ...old, ...recovered }));
        pendingCategories.current = null;
      }
      if (!words.length) {
        if (!(await verifyCategorySession()))
          throw new Error(
            'Full dictionary coverage has not been verified yet.',
          );
        outcomeReason = 'Full dictionary and all 36 dimensions verified';
        setPhase('Jev has already classified every word in this dictionary.');
        return;
      }
      await prepareCategories(
        words,
        restored,
        evaluate,
        c.signal,
        async (result) => {
          done += Object.values(result).filter(isComplete).length;
          updateStats({
            words: done,
            elapsedMs: Date.now() - statsRef.current.startedAt,
          });
          pendingCategories.current = {
            ...pendingCategories.current,
            ...result,
          };
          recording.current?.patch({
            answer: `${done} completed word steps; scanning 36 dimensions. Latest batch: ${JSON.stringify(result)}`,
          });
          setOverrides((old) => ({ ...old, ...result }));
          await checkpoints.save(result);
          const unsaved = { ...pendingCategories.current };
          for (const word of Object.keys(result)) {
            if (unsaved[word] === result[word]) delete unsaved[word];
          }
          pendingCategories.current = Object.keys(unsaved).length
            ? unsaved
            : null;
          setPhase(
            `Jev is scanning all 36 dimensions; completed results have been saved.`,
          );
        },
        {
          concurrency: Number(parallelism),
          onActivity: setActiveRequests,
          onTelemetry: setThroughput,
          onBackoff: (ms, attempt) =>
            setPhase(
              `TypeSafe limit or overload: ${Math.ceil(ms / 1000)} seconds until retry; ${attempt} retry. Jev only.`,
            ),
        },
      );
      if (!(await verifyCategorySession()))
        throw new Error(
          'Scan ended but full coverage is not verified. Resume the remaining words.',
        );
      setPhase(
        'Category file ready · every word and all 36 dimensions verified.',
      );
      outcomeReason = `${done} words classified; full dictionary ready`;
    } catch (e) {
      outcome = c.signal.aborted ? 'stopped' : 'error';
      outcomeReason = c.signal.aborted
        ? 'Stopped by the user'
        : e instanceof Error
          ? e.message
          : 'Classification failed';
      if (c.signal.aborted)
        setPhase('Classification stopped. Completed batches retained.');
      else setError(e instanceof Error ? e.message : 'Classification failed.');
    } finally {
      updateStats({ elapsedMs: Date.now() - statsRef.current.startedAt });
      const recorder = recording.current;
      recording.current = null;
      await recorder?.finish(outcome, outcomeReason);
      setClassifying(false);
      preparationActive.current = false;
      setActiveRequests(0);
      busy.current = false;
      controller.current = null;
    }
  }
  function exportRun() {
    const data = {
      createdAt: new Date().toISOString(),
      recordId,
      appVersion: APP_VERSION,
      model: 'jev-latest',
      dictionary: dict?.source,
      settings: {
        limit: Number(limit),
        beam: Number(beam),
        maxWords: Number(maxWords),
        targetSentences: Number(targetSentences),
        repetitionGuard,
        grammarReview,
        parallelism: Number(parallelism),
        requestBudget: Number(budget),
      },
      messages,
      steps,
      stats,
      operations,
      provider: 'TypeSafe',
      fallback: false,
      taxonomyVersion: TAXONOMY_VERSION,
      categoryDefinitions: CATEGORY_OPTIONS,
      categorySessionId: sessionRef.current,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jev-experiment.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const isBusy = importing || running || classifying || checking;
  const shownStep = selected < 0 ? steps.at(-1) : steps[selected];
  const activeCount = dict ? Number(limit) || dict.count : 0;
  const searchRows =
    dict?.words
      .filter(([w]) => !query || w.includes(query.toLowerCase()))
      .slice(0, 35) || [];
  return (
    <div className="lab-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-icon">
            <Network size={23} />
          </span>
          jev<span className="brand-light">word lab</span>
        </a>
        <span className="tag">JEV ONLY · NO FALLBACK</span>
        <a
          className="docs-link"
          href="https://docs.typesafe.ai"
          target="_blank"
          rel="noreferrer"
        >
          TypeSafe API <ArrowUpRight size={16} />
        </a>
      </header>
      <main className="workspace">
        <div className="heading">
          <div>
            <p className="eyebrow">FROM WORDS TO CONVERSATION</p>
            <h1>The next word.</h1>
            <p className="intro">
              Watch Jev build a reply by choosing categories and words.
            </p>
          </div>
          <span className="model-tag">
            <Circle size={8} fill="currentColor" /> jev-latest
          </span>
        </div>
        <section
          className={`category-loading-status ${categoryError ? 'has-error' : ''}`}
          aria-label="Category loading status"
          aria-busy={categoriesLoading}
        >
          <div className="category-loading-heading">
            {categoriesLoading ? (
              <LoaderCircle className="spin" size={20} aria-hidden="true" />
            ) : categoryError ? (
              <X size={20} aria-hidden="true" />
            ) : (
              <Check size={20} aria-hidden="true" />
            )}
            <h2>
              {categoriesLoading
                ? 'Loading categories'
                : categoryError
                  ? 'Could not load categories'
                  : categoriesReady
                    ? 'Categories ready'
                    : 'Saved categories loaded'}
            </h2>
            {!categoryError && categoryLoadPercent !== null && (
              <span className="category-loading-percent">
                {categoryLoadPercent}%
              </span>
            )}
          </div>
          <p role={categoryError ? 'alert' : 'status'}>
            {categoryError || categoryLoadLabel}
          </p>
          {!categoryError && (
            <Progress
              className={`category-load-progress ${categoryLoadPercent === null ? 'is-indeterminate' : ''}`}
              value={categoryLoadPercent}
              aria-label="Loading category data"
            />
          )}
          {categoryLoadDetail && !categoryError && (
            <p className="category-loading-detail">{categoryLoadDetail}</p>
          )}
          {categoryError && (
            <Button variant="outline" onClick={() => void loadCategories()}>
              Retry loading
            </Button>
          )}
        </section>
        <section className="connection">
          <div className="connection-title">
            <KeyRound size={20} />
            <div>
              <h2>
                API connection{' '}
                {connected && (
                  <span className="connected-label">
                    <Check size={13} />
                    Connected
                  </span>
                )}
              </h2>
              <p>
                Your key stays in memory and is cleared when you close the page.
              </p>
            </div>
          </div>
          <div className="key-controls">
            <Input
              aria-label="TypeSafe API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Enter your TypeSafe API key"
              value={key}
              disabled={isBusy}
              onChange={(e) => {
                setKey(e.target.value);
                setConnected(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect();
              }}
            />
            <Button
              onClick={() => void connect()}
              disabled={isBusy || !key.trim()}
            >
              {checking ? (
                <LoaderCircle className="spin" size={16} />
              ) : connected ? (
                <Check size={16} />
              ) : (
                <KeyRound size={16} />
              )}{' '}
              {connected ? 'Check again' : 'Connect'}
            </Button>
            {key && (
              <Button
                variant="ghost"
                aria-label="Clear API key"
                disabled={isBusy}
                onClick={() => {
                  setKey('');
                  setConnected(false);
                  setPhase('API key cleared.');
                }}
              >
                <X size={17} />
              </Button>
            )}
          </div>
        </section>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={17} />
            </button>
          </div>
        )}
        {loadError && (
          <div className="error-banner" role="alert">
            {loadError}
            <Button onClick={loadDictionary}>Reload</Button>
          </div>
        )}
        <div className="category-preparation">
          <div>
            <strong>1. Create category file</strong>
            <p>
              36 dimensions · multiple labels · {number(preparedCount)} /{' '}
              {number(dict?.count || 0)} words fully scanned.
            </p>
          </div>
          <div className="classify-controls">
            <Picker
              label="Adaptive speed · maximum concurrent requests"
              value={parallelism}
              onChange={setParallelism}
              disabled={isBusy}
              options={[
                ['8', 'Up to 8'],
                ['16', 'Up to 16'],
                ['32', 'Up to 32'],
                ['64', 'Up to 64'],
                ['96', 'Up to 96'],
                ['128', 'Up to 128'],
                ['256', 'Up to 256 · measured fast setting'],
              ]}
            />
            <Button
              onClick={() => void classify()}
              disabled={
                isBusy ||
                !connected ||
                !dict ||
                categoriesLoading ||
                !!categoryError ||
                categoriesReady
              }
            >
              <FlaskConical size={15} />
              {classifying
                ? 'Jev is categorizing the entire dictionary…'
                : categoriesReady
                  ? 'Categorization complete'
                  : scannedCount
                    ? 'Resume categorization with Jev'
                    : 'Create category file · Jev'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setMonitorTab('dictionary')}
            >
              View categories
            </Button>
          </div>
          <p>
            Total {number(dict?.count || 0)} words. Remaining preparation
            requires at least{' '}
            {number(
              Math.ceil(
                (((dict?.count || 0) * AXES.length - scannedCount) *
                  QUESTIONS_PER_CELL) /
                  QUESTIONS_PER_REQUEST,
              ),
            )}{' '}
            TypeSafe requests (36 dimensions; batches respect payload limits)
            and uses your API balance. Keep this page open. You can resume from
            saved progress.
          </p>
          <p>
            {number(throughput.tokensPerSecond)} input tokens/s (last 5 s) ·
            target up to {number(throughput.targetTokensPerSecond)} tokens/s.
            Adjusted automatically from actual API usage and overload responses.
          </p>
          {classifying && stats.elapsedMs > 0 && (
            <p>
              {(
                Math.max(0, scannedCount - classificationStartCells.current) /
                AXES.length /
                (stats.elapsedMs / 1000)
              ).toFixed(1)}{' '}
              word-equivalents/s · 36 dimensions count as one word · this run:{' '}
              {number(stats.words)} words fully completed
            </p>
          )}
          <p>
            {activeRequests} / {parallelism} active Jev requests · up to{' '}
            {QUESTIONS_PER_REQUEST} independent questions per request. The queue
            slows down and retries at token or request limits.
          </p>
          <p>
            Prediction unlocks when the whole dictionary is ready. The budget
            below applies only to prediction.
          </p>
          <p>
            {number(scannedCount)} / {number((dict?.count || 0) * AXES.length)}{' '}
            dimension assessments · {number((dict?.count || 0) - preparedCount)}{' '}
            incomplete words.
          </p>
          <p>
            {coverage?.sessionId
              ? `Saved session: ${coverage.sessionId.slice(0, 8)}`
              : bundledCategories
                ? 'Bundled Jev categories loaded automatically. No upload or categorization required.'
                : 'A persistent session is created on the first preparation.'}
          </p>
          {storageUnavailable && (
            <p role="status">
              Saved sessions are currently unavailable. Using the bundled Jev
              categories; saving imports requires database access.
            </p>
          )}
          {categoriesReady && (
            <p role="status">
              <strong>Category file ready — 100% coverage verified.</strong>{' '}
              Every word was scanned across 36 dimensions. Coverage does not
              imply linguistic accuracy; uncertain and not-applicable results
              are explicitly recorded.
            </p>
          )}
          <div className="classify-controls">
            <Button
              variant="outline"
              onClick={downloadCategories}
              disabled={!scannedCount || isBusy || categoriesLoading}
            >
              <Download size={16} />
              {categoriesReady
                ? 'Download category file'
                : 'Download partial file'}
            </Button>
            <label className="category-upload">
              Upload category file
              <Input
                type="file"
                accept=".json,application/json"
                disabled={
                  isBusy || !dict || categoriesLoading || !!categoryError
                }
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void uploadCategories(file);
                }}
              />
            </label>
          </div>
          <p>
            Uploading makes no Jev calls. The dictionary and schema are
            validated; use preparation to resume missing assessments.
          </p>
          {categoriesLoading && <p>Loading and verifying categories…</p>}
          {categoryError && (
            <p role="alert">
              {categoryError}{' '}
              <Button variant="outline" onClick={() => void loadCategories()}>
                Reload
              </Button>
            </p>
          )}
        </div>
        <div className="repetition-control">
          <Switch
            id="repeat-guard"
            checked={repetitionGuard}
            onCheckedChange={setRepetitionGuard}
            disabled={isBusy}
          />
          <label htmlFor="repeat-guard">Repetition guard</label>
          <span>
            {repetitionGuard
              ? 'The application filters repetition; Jev chooses among the remaining candidates.'
              : 'Raw experiment: repeated candidates are not filtered.'}
          </span>
        </div>
        <div className="repetition-control">
          <Switch
            id="grammar-review"
            checked={grammarReview}
            onCheckedChange={setGrammarReview}
            disabled={isBusy}
          />
          <label htmlFor="grammar-review">Jev grammar guidance</label>
          <span>
            {grammarReview
              ? 'Jev compares grammar and meaning in the final word choice. Ending stays available; no extra filtering requests.'
              : 'Raw selection: no inflection expansion or additional grammar guidance.'}
          </span>
        </div>
        <div className="experiment-settings">
          <Picker
            label="Retained paths"
            value={beam}
            onChange={setBeam}
            disabled={isBusy}
            options={[
              ['1', '1 path · fast'],
              ['3', '3 paths · balanced'],
              ['5', '5 paths · broad'],
            ]}
          />
          <Picker
            label="Reply style"
            value={targetSentences}
            onChange={setTargetSentences}
            disabled={isBusy}
            options={[
              ['3', 'Three short sentences'],
              ['1', 'One short sentence'],
            ]}
          />
          <Picker
            label="Reply limit"
            value={maxWords}
            onChange={setMaxWords}
            disabled={isBusy}
            options={[
              ['16', '16 choices'],
              ['32', '32 choices'],
              ['64', '64 choices'],
            ]}
          />
          <Picker
            label="Prediction request budget"
            value={budget}
            onChange={setBudget}
            disabled={isBusy}
            options={[
              ['80', '80 requests'],
              ['200', '200 requests'],
              ['400', '400 requests'],
            ]}
          />
        </div>
        <div className="work-grid">
          <section className="conversation panel">
            <div className="panel-heading">
              <h2>Results / Conversation</h2>
              <div className="heading-actions">
                <span className="tag">ENGLISH</span>
                <button
                  title="New conversation"
                  aria-label="New conversation"
                  disabled={isBusy || !messages.length}
                  onClick={() => {
                    setMessages([]);
                    setSteps([]);
                    setSelected(-1);
                    setStats(INITIAL);
                    statsRef.current = INITIAL;
                    setPhase('New conversation ready.');
                  }}
                >
                  <RotateCcw size={16} />
                </button>
              </div>
            </div>
            {!messages.length ? (
              <div className="conversation-empty">
                <div className="empty-icon">
                  <GitBranch size={32} />
                </div>
                <h3>See how the reply takes shape.</h3>
                <p>
                  For each word, Jev narrows categories, compares candidates,
                  and selects the next word.
                </p>
                <div className="flow">
                  <span>Category</span>
                  <ArrowRight size={15} />
                  <span>Subgroups</span>
                  <ArrowRight size={15} />
                  <span>Finalists</span>
                </div>
                <div className="examples">
                  {[
                    'Why is the sky blue?',
                    'Tell me about cats.',
                    'How do I make tea?',
                  ].map((q) => (
                    <button
                      key={q}
                      onClick={() => setPrompt(q)}
                      disabled={isBusy}
                    >
                      {q}
                      <ArrowUpRight size={13} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div
                className="messages"
                aria-live="polite"
                aria-relevant="text additions"
              >
                {messages.map((m, i) => (
                  <div key={i} className={`message ${m.role}`}>
                    <span className="message-label">
                      {m.role === 'user' ? 'YOU' : 'JEV'}
                    </span>
                    <p>
                      {m.content ||
                        (running ? (
                          <span className="thinking">
                            <span />
                            Evaluating candidates…
                          </span>
                        ) : (
                          'No word selected yet.'
                        ))}
                      {running && i === messages.length - 1 && m.content && (
                        <span className="cursor" />
                      )}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="composer">
              <label htmlFor="question">Ask a question in English</label>
              <Textarea
                id="question"
                value={prompt}
                disabled={isBusy}
                maxLength={2000}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="Ask Jev a question in English…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void run();
                  }
                }}
              />
              <div className="composer-bottom">
                <span>
                  {!dict
                    ? 'Loading dictionary…'
                    : !connected
                      ? 'Connect your API key first.'
                      : !categoriesReady
                        ? `Categorize the entire dictionary first (${preparedCount}/${dict.count}).`
                        : `${preparedCount} prepared words · Ctrl / ⌘ + Enter`}
                </span>
                {running || classifying || importing ? (
                  <Button variant="destructive" onClick={stop}>
                    <Square size={14} />
                    Stop
                  </Button>
                ) : (
                  <Button
                    onClick={() => void run()}
                    disabled={
                      isBusy ||
                      !connected ||
                      !dict ||
                      !prompt.trim() ||
                      !categoriesReady
                    }
                  >
                    2. Start word prediction <ArrowRight size={16} />
                  </Button>
                )}
              </div>
            </div>
          </section>
          <aside className="panel inspection">
            <Tabs
              value={monitorTab}
              onValueChange={(v) => setMonitorTab(String(v))}
            >
              <div className="panel-heading">
                <TabsList variant="line">
                  <TabsTrigger value="monitor">Live operations</TabsTrigger>
                  <TabsTrigger value="trace">Word trace</TabsTrigger>
                  <TabsTrigger value="dictionary">Dictionary</TabsTrigger>
                </TabsList>
                <span className={`live-dot ${running ? 'active' : ''}`} />
              </div>
              <TabsContent value="monitor">
                <div className="monitor-status">
                  <span className={`live-dot ${isBusy ? 'active' : ''}`} />
                  <span>{phase}</span>
                </div>
                <div className="provider-lock">
                  <ShieldCheck size={14} />
                  <strong>Jev only</strong>
                  <span>No fallback model</span>
                </div>
                <div
                  className="operation-list"
                  role="log"
                  aria-label="Jev live operation log"
                  aria-live="polite"
                >
                  {!operations.length ? (
                    <div className="monitor-empty">
                      <Network size={32} />
                      <h3>Operation monitor ready</h3>
                      <p>
                        Connection checks and each Jev request appear here with
                        their duration.
                      </p>
                    </div>
                  ) : (
                    [...operations].reverse().map((op) => (
                      <div key={op.id} className={`operation ${op.status}`}>
                        <div className="operation-icon">
                          {op.status === 'pending' ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : op.status === 'done' ? (
                            <Check size={15} />
                          ) : op.status === 'cancelled' ? (
                            <Square size={13} />
                          ) : (
                            <X size={15} />
                          )}
                        </div>
                        <div className="operation-body">
                          <div className="operation-title">
                            <strong>{op.label}</strong>
                            <time>
                              {new Date(op.at).toLocaleTimeString('en-US', {
                                hour12: false,
                              })}
                            </time>
                          </div>
                          <p>{op.summary}</p>
                          <div className="operation-meta">
                            <span>#{op.id}</span>
                            <span>
                              {op.questions} questions · {op.options} total
                              options
                            </span>
                            <span>
                              {op.status === 'pending'
                                ? 'running'
                                : `${(op.ms / 1000).toFixed(2)}s`}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {steps.length > 0 && (
                  <div className="monitor-output">
                    <p className="section-label">SELECTED WORDS</p>
                    <div className="word-timeline">
                      {steps.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setSelected(i);
                            setMonitorTab('trace');
                          }}
                        >
                          {s.word}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="method-note">
                  <GitBranch size={18} />
                  <p>
                    Category → prefix groups → word and grammar comparison.
                    Questions run in parallel; each has up to 255 options.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="trace">
                {!shownStep && !liveTrace ? (
                  <div className="trace-empty">
                    <Network size={38} />
                    <h3>No selection yet</h3>
                    <p>
                      Groups, candidate words, and probabilities selected by Jev
                      appear here.
                    </p>
                  </div>
                ) : (
                  <div className="trace-content">
                    {steps.length > 0 && (
                      <div className="word-timeline">
                        <button
                          className={selected < 0 ? 'current' : ''}
                          onClick={() => setSelected(-1)}
                        >
                          Live
                        </button>
                        {steps.map((s, i) => (
                          <button
                            key={i}
                            className={selected === i ? 'current' : ''}
                            onClick={() => setSelected(i)}
                            title={`Selection ${i + 1}`}
                          >
                            {s.word}
                          </button>
                        ))}
                      </div>
                    )}
                    {shownStep && (
                      <>
                        <div className="selected-word">
                          <div>
                            <span className="eyebrow">
                              {shownStep.index + 1}. SELECTION
                            </span>
                            <h3>{shownStep.word}</h3>
                          </div>
                          <div>
                            <strong>
                              {(shownStep.confidence * 100).toFixed(0)}%
                            </strong>
                            <span>API confidence</span>
                          </div>
                        </div>
                        <p className="section-label">Finalist probabilities</p>
                        <div className="candidates">
                          {shownStep.candidates.map((c) => (
                            <div className="candidate" key={c.label}>
                              <div>
                                <span>{c.label}</span>
                                <span>{(c.probability * 100).toFixed(1)}%</span>
                              </div>
                              <div className="prob-track">
                                <span
                                  style={{
                                    width: `${Math.max(0.3, c.probability * 100)}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="prob-note">
                          Probabilities apply only to this set of finalists.
                        </p>
                      </>
                    )}
                    <div className="trace-paths">
                      {(selected < 0 && liveTrace
                        ? [liveTrace]
                        : shownStep?.traces || []
                      ).map((t, i) => (
                        <details key={`${t.path}-${i}`} open={i === 0}>
                          <summary>
                            <ChevronRight size={13} />
                            {t.stage}
                            <span>{t.options} options</span>
                          </summary>
                          <p>{t.path}</p>
                          {t.excluded?.map((item) => (
                            <div
                              key={item.word}
                              className="path-row excluded-row"
                            >
                              <span>{item.word}</span>
                              <span>{item.reason}</span>
                            </div>
                          ))}
                          {t.candidates.map((c) => (
                            <div key={c.label} className="path-row">
                              <span>
                                {c.retained && (
                                  <Circle size={6} fill="currentColor" />
                                )}
                                {c.label}
                              </span>
                              <code>{(c.probability * 100).toFixed(1)}%</code>
                            </div>
                          ))}
                        </details>
                      ))}
                    </div>
                  </div>
                )}
                <div className="method-note">
                  <ShieldCheck size={18} />
                  <p>
                    Up to 255 options. Multiple paths stay in consideration;
                    finalists are compared directly.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="dictionary">
                <div className="dictionary-content">
                  <div className="dictionary-total">
                    <BookOpen size={22} />
                    <div>
                      <strong>{dict ? number(dict.count) : '…'}</strong>
                      <span>downloaded English words</span>
                    </div>
                    <a
                      href="/data/words.txt"
                      download="jev-english-words.txt"
                      title="Download word list"
                    >
                      <Download size={19} />
                    </a>
                  </div>
                  <p className="dictionary-copy">
                    The dictionary comes from WordNet. Jev assigns labels across
                    36 dimensions, with 216 tags plus not-applicable and
                    uncertain options. Prediction unlocks after full
                    preparation.
                  </p>
                  <p className="dictionary-copy">
                    {number(Object.keys(overrides).length)} words assessed by
                    Jev across 36 dimensions and stored privately. A word may
                    have multiple labels. The groups below preview the first 100
                    saved words; the file contains all results.
                  </p>
                  <details className="category-map">
                    <summary>Jev category definitions and word groups</summary>
                    {!preparedCount && <p>No category map prepared yet.</p>}
                    {AXES.map((axis) => (
                      <section key={axis}>
                        <h3>{AXIS_LABELS[axis]}</h3>
                        <p>
                          {
                            AXIS_DEFINITIONS.find((d) => d.id === axis)!
                              .guidance
                          }
                        </p>
                        {Object.entries(CATEGORY_OPTIONS[axis]).map(
                          ([id, description]) => {
                            const members = categoryGroups[axis][id] || [];
                            return (
                              <details key={id}>
                                <summary>
                                  {description.split(':')[0]} · {members.length}
                                </summary>
                                <p>{description}</p>
                                <p>
                                  {members.slice(0, 100).join(', ')}
                                  {members.length > 100
                                    ? ` … (+${members.length - 100}; all available in the category file)`
                                    : ''}
                                </p>
                              </details>
                            );
                          },
                        )}
                      </section>
                    ))}
                  </details>
                  <Input
                    aria-label="Search dictionary"
                    placeholder="Search words…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="dictionary-words">
                    {searchRows.map(([word, ids]) => (
                      <div key={word}>
                        <strong>{word}</strong>
                        <span>
                          {Object.hasOwn(overrides, word)
                            ? AXES.map(
                                (axis, index) =>
                                  `${AXIS_LABELS[axis]}: ${selectedLabels(axis, overrides[word][index]).join(', ') || 'not scanned yet'}`,
                              ).join(' · ')
                            : ids
                                .map((i) => categoryLabel(dict!.categories[i]))
                                .join(', ') + ' · not prepared by Jev yet'}
                        </span>
                      </div>
                    ))}
                    {query && !searchRows.length && <p>No matching words.</p>}
                  </div>
                  <a
                    className="source-link"
                    href="https://wordnet.princeton.edu/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Princeton WordNet 3.0 <ArrowUpRight size={13} />
                  </a>
                </div>
              </TabsContent>
            </Tabs>
          </aside>
        </div>
        <section className="run-status" aria-live="polite">
          <span className={isBusy ? 'running' : ''}>
            {isBusy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Circle size={7} fill="currentColor" />
            )}
            {phase}
          </span>
          <div className="run-numbers">
            <span>
              <b>{stats.words}</b> words
            </span>
            <span>
              <b>{stats.requests}</b> requests
            </span>
            <span>
              <b>{number(stats.inputTokens)}</b> input tokens
            </span>
            <span>
              <b>{(stats.elapsedMs / 1000).toFixed(1)}s</b>
            </span>
            <button
              onClick={exportRun}
              disabled={!steps.length && !Object.keys(overrides).length}
              title="Download experiment results"
            >
              <Download size={15} />
              JSON
            </button>
          </div>
        </section>
        <div
          className={`recording-status ${saveStatus === 'failed' ? 'failed' : ''}`}
          role="status"
        >
          <ShieldCheck size={15} />
          <span>
            {saveStatus === 'saving'
              ? 'Saving experiment…'
              : saveStatus === 'saved'
                ? 'Experiment saved · available for manual review.'
                : saveStatus === 'failed'
                  ? 'Could not save. Download the JSON to keep your results.'
                  : 'Experiments are saved privately. Automatic Codex review is off.'}
          </span>
          <span>Your API key is never saved.</span>
        </div>
        <footer>
          <span>
            <BookOpen size={15} />
            {dict
              ? `${number(activeCount)} active words · ${dict.categories.length} initial categories`
              : 'Loading dictionary…'}
            <a href="/data/words.txt" download>
              Word list ↗
            </a>
          </span>
          <span>All decisions come from Jev. No fallback model.</span>
        </footer>
      </main>
    </div>
  );
}
