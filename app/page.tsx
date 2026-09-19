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
  isComplete,
  selectedLabels,
  prepareCategories,
  sanitizeCategories,
  type CategoryMap,
} from '@/lib/categories';
import {
  makeCategoryFile,
  validateCategoryFile,
  scannedCells,
} from '@/lib/category-file';
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
type CategoryPage = {
  version: string;
  categories: CategoryMap;
  nextCursor: string | null;
  sourceSha256: string;
  sessionId: string | null;
  expectedCount: number;
  expectedCells: number;
  verifiedCount: number;
  scannedCells: number;
  missingCount: number;
  complete: boolean;
};
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
    [phase, setPhase] = useState('Başlamak için API anahtarını bağla.'),
    [error, setError] = useState('');
  const [stats, setStats] = useState<Stats>(INITIAL),
    [liveTrace, setLiveTrace] = useState<Trace | null>(null);
  const [overrides, setOverrides] = useState<CategoryMap>({}),
    [query, setQuery] = useState('');
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoryError, setCategoryError] = useState('');
  const pendingCategories = useRef<CategoryMap | null>(null);
  const preparationActive = useRef(false);
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
  const categoryGroups = useMemo(
    () =>
      Object.fromEntries(
        AXES.map((axis, index) => {
          const groups: Record<string, string[]> = {};
          // Bounded preview; the downloadable file contains every word.
          for (const [word, assignment] of Object.entries(overrides).slice(
            0,
            100,
          )) {
            for (const label of selectedLabels(axis, assignment[index]))
              (groups[label] ||= []).push(word);
          }
          return [axis, groups];
        }),
      ) as Record<string, Record<string, string[]>>,
    [overrides],
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
  async function loadCategories() {
    setCategoriesLoading(true);
    setCategoryError('');
    try {
      const all: CategoryMap = {};
      let cursor: string | null = null;
      let session: string | null = null;
      do {
        const params = new URLSearchParams();
        if (cursor) params.set('after', cursor);
        if (session) params.set('session', session);
        const response = await fetch(`/api/categories?${params}`);
        if (!response.ok) throw new Error();
        const data = (await response.json()) as CategoryPage;
        if (data.version !== TAXONOMY_VERSION) throw new Error();
        Object.assign(all, sanitizeCategories(data.categories));
        session = data.sessionId;
        sourceHash.current = data.sourceSha256;
        setCoverage(data);
        cursor = data.nextCursor;
      } while (cursor);
      sessionRef.current = session;
      setOverrides(all);
    } catch {
      setCategoryError('Kayıtlı kategori oturumu yüklenemedi. Yeniden yükle.');
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
    if (!response.ok) throw new Error('Kategorizasyon oturumu başlatılamadı.');
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
    if (!response.ok) throw new Error('Sözlüğün tam kapsamı doğrulanamadı.');
    const data = (await response.json()) as CategoryPage;
    setCoverage(data);
    return data.complete === true;
  }
  async function saveCategories(categories: CategoryMap) {
    const r = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: TAXONOMY_VERSION,
        sourceSha256: sourceHash.current,
        sessionId: sessionRef.current,
        categories,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new Error(
        'Kategori oturumu kaydedilemedi. Tamamlanan seçimler korundu; hazırlama tuşuyla yeniden dene.',
      );
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
      if (file.size > 64000000) throw new Error('Dosya 64 MB sınırını aşıyor.');
      const map = validateCategoryFile(
        JSON.parse(await file.text()),
        sourceHash.current,
        dict.words.map(([w]) => w),
      );
      await startCategorySession(true);
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
          `Kategori dosyası yükleniyor: ${Math.min(i + 100, entries.length)} / ${entries.length}`,
        );
      }
      const complete = await verifyCategorySession();
      setPhase(
        complete
          ? 'Kategorize Dosyası Oluştu · bütün kelimeler ve 36 boyut doğrulandı.'
          : 'Kısmi dosya yüklendi. Jev yalnızca eksik boyutları tarayacak.',
      );
    } catch (e) {
      setError(
        c.signal.aborted
          ? 'Yükleme durduruldu. Kaydedilen bölüm oturumda korundu.'
          : e instanceof Error
            ? e.message
            : 'Dosya yüklenemedi.',
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
      setLoadError('Sözlük yüklenemedi. Yeniden dene.');
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
        reason: 'Başladı',
        appVersion: APP_VERSION,
        settings: {
          limit: Number(limit),
          beam: Number(beam),
          maxWords: Number(maxWords),
          requestBudget:
            kind === 'classification'
              ? Math.ceil(
                  ((dict?.count || 0) * AXES.length) / QUESTIONS_PER_REQUEST,
                )
              : Number(budget),
          repetitionGuard,
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
      throw new Error('API istek sınırına ulaşıldı. Kısmi cevap korundu.');
    updateStats({ requests: statsRef.current.requests + 1 });
    const id = ++operationId.current,
      at = Date.now();
    const entries = Object.entries(questions);
    const label = questions.next
      ? 'Finalist karşılaştırması'
      : questions.check
        ? 'API bağlantı kontrolü'
        : entries[0][0].startsWith('w')
          ? 'Kelime sınıflandırma'
          : entries[0][1].instructions.includes('Group: English dictionary')
            ? 'Kategori seçimi'
            : 'Alt grup seçimi';
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
      summary: 'Jev yanıtı bekleniyor…',
    };
    logOperation(operation);
    try {
      const r = await fetch('/api/decision', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-typesafe-key': keyRef.current.trim(),
        },
        body: JSON.stringify({ state, questions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(
          data &&
            typeof data === 'object' &&
            'error' in data &&
            typeof data.error === 'string'
            ? data.error
            : `API hatası (${r.status})`,
        );
      validateResponse(data, questions);
      const summary =
        Object.entries(data.answers)
          .slice(0, preparationActive.current ? 32 : 3)
          .map(([qid, a]) =>
            qid === 'next'
              ? `Seçilen: ${a.choice === '__END__' ? 'Cevabı bitir' : a.choice}`
              : qid.startsWith('g')
                ? (questions[qid].criteria[a.choice] || a.choice)
                    .split('Examples:')[0]
                    .slice(0, 100)
                : preparationActive.current
                  ? `${(state as { targets?: { word: string; dimension: string }[] }).targets?.[Number(qid.slice(1))]?.word || qid} · ${(state as { targets?: { dimension: string }[] }).targets?.[Number(qid.slice(1))]?.dimension || ''}: ${questions[qid].criteria[a.choice] || a.choice}`
                  : a.choice,
          )
          .join(' / ') +
        (!preparationActive.current && entries.length > 3
          ? ` (+${entries.length - 3} sonuç)`
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
        ? 'Kullanıcı tarafından durduruldu.'
        : e instanceof Error
          ? e.message
          : 'İstek başarısız.';
      logOperation({
        ...operation,
        status: signal.aborted ? 'cancelled' : 'error',
        ms: Date.now() - at,
        summary,
      });
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
      setPhase('Bağlantı hazır. Önce Jev ile kategorileri hazırla.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bağlantı kurulamadı.');
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
      const root = buildPreparedTree(dict, Number(limit), overrides);
      const result = await generate({
        root,
        common: commonWords(dict, Number(limit)).filter((w) =>
          Object.hasOwn(overrides, w),
        ),
        history,
        beam: Number(beam),
        maxWords: Number(maxWords),
        repetitionGuard,
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
              label: 'Tekrar koruması · uygulama filtresi',
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
        ? 'Kullanıcı durdurdu'
        : e instanceof Error
          ? e.message
          : 'Deneme başarısız';
      if (c.signal.aborted) setPhase('Durduruldu. Kısmi cevap korundu.');
      else {
        setError(e instanceof Error ? e.message : 'Deneme tamamlanamadı.');
        setPhase('Deneme durdu.');
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
    setError('');
    setOperations([]);
    setMonitorTab('monitor');
    const c = new AbortController();
    controller.current = c;
    statsRef.current = { ...INITIAL, startedAt: Date.now() };
    setStats(statsRef.current);
    const restored = { ...overrides, ...pendingCategories.current };
    const words = dict.words
      .slice(0, Number(limit) || dict.count)
      .filter(([w]) => !isComplete(restored[w]))
      .map(([w]) => w);
    let done = 0;
    beginRecording(
      'classification',
      `${words.length} İngilizce kelimenin eksik boyutlarını 36 boyutlu şemayla tara (${TAXONOMY_VERSION})`,
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
          throw new Error('Sözlüğün tam kapsamı henüz doğrulanamadı.');
        outcomeReason = 'Bütün sözlük ve 36 boyut doğrulandı';
        setPhase(
          'Bu sözlükteki kelimeler zaten Jev tarafından sınıflandırıldı.',
        );
        return;
      }
      await prepareCategories(
        words,
        restored,
        evaluate,
        c.signal,
        async (result) => {
          done += Object.values(result).filter(isComplete).length;
          pendingCategories.current = result;
          recording.current?.patch({
            answer: `${done} tamamlanan kelime adımı; 36 boyutlu tarama sürüyor. Son grup: ${JSON.stringify(result)}`,
          });
          setOverrides((old) => ({ ...old, ...result }));
          await saveCategories(result);
          pendingCategories.current = null;
          setPhase(
            `Jev bütün sözlüğün 36 boyutunu tarıyor; tamamlanan sonuçlar kaydedildi.`,
          );
        },
      );
      if (!(await verifyCategorySession()))
        throw new Error(
          'Tarama bitti ancak bütün kelimeler henüz doğrulanamadı. Kalanlardan devam et.',
        );
      setPhase(
        'Kategorize Dosyası Oluştu · bütün kelimeler ve 36 boyut doğrulandı.',
      );
      outcomeReason = `${done} kelime sınıflandırıldı; bütün sözlük hazır`;
    } catch (e) {
      outcome = c.signal.aborted ? 'stopped' : 'error';
      outcomeReason = c.signal.aborted
        ? 'Kullanıcı durdurdu'
        : e instanceof Error
          ? e.message
          : 'Sınıflandırma başarısız';
      if (c.signal.aborted)
        setPhase('Sınıflandırma durduruldu. Tamamlanan gruplar korundu.');
      else
        setError(e instanceof Error ? e.message : 'Sınıflandırma başarısız.');
    } finally {
      updateStats({ elapsedMs: Date.now() - statsRef.current.startedAt });
      const recorder = recording.current;
      recording.current = null;
      await recorder?.finish(outcome, outcomeReason);
      setClassifying(false);
      preparationActive.current = false;
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
        repetitionGuard,
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
            <p className="eyebrow">KELİMEDEN KONUŞMAYA</p>
            <h1>Bir sonraki kelime.</h1>
            <p className="intro">
              Jev’in kategoriler arasından seçim yaparak cümle kurmasını izle.
            </p>
          </div>
          <span className="model-tag">
            <Circle size={8} fill="currentColor" /> jev-latest
          </span>
        </div>
        <section className="connection">
          <div className="connection-title">
            <KeyRound size={20} />
            <div>
              <h2>
                API bağlantısı{' '}
                {connected && (
                  <span className="connected-label">
                    <Check size={13} />
                    Bağlı
                  </span>
                )}
              </h2>
              <p>Anahtar kaydedilmez; sayfa kapanınca silinir.</p>
            </div>
          </div>
          <div className="key-controls">
            <Input
              aria-label="TypeSafe API anahtarı"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="TypeSafe API anahtarını buraya gir"
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
              {connected ? 'Yeniden kontrol' : 'Bağlan'}
            </Button>
            {key && (
              <Button
                variant="ghost"
                aria-label="API anahtarını sil"
                disabled={isBusy}
                onClick={() => {
                  setKey('');
                  setConnected(false);
                  setPhase('API anahtarı silindi.');
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
            <button
              aria-label="Hata mesajını kapat"
              onClick={() => setError('')}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {loadError && (
          <div className="error-banner" role="alert">
            {loadError}
            <Button onClick={loadDictionary}>Yeniden yükle</Button>
          </div>
        )}
        <div className="category-preparation">
          <div>
            <strong>1. Kategorize Dosyası Oluştur</strong>
            <p>
              36 boyut · çoklu etiketler · {number(preparedCount)} /{' '}
              {number(dict?.count || 0)} kelime tamamen tarandı.
            </p>
          </div>
          <div className="classify-controls">
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
                ? 'Jev bütün sözlüğü kategorize ediyor…'
                : categoriesReady
                  ? 'Kategorizasyon tamamlandı'
                  : scannedCount
                    ? 'Jev ile kategorizasyona devam et'
                    : 'Kategorize Dosyası Oluştur · Jev'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setMonitorTab('dictionary')}
            >
              Kategori metnini gör
            </Button>
          </div>
          <p>
            Toplam {number(dict?.count || 0)} kelime. Kalan hazırlık yaklaşık{' '}
            {number(
              Math.ceil(
                ((dict?.count || 0) * AXES.length - scannedCount) /
                  QUESTIONS_PER_REQUEST,
              ),
            )}{' '}
            TypeSafe isteği gerektirir (36 boyutlu tarama) ve API kullanımına
            yansır. Bu uzun işlem sırasında sayfayı açık tut. Durdurur veya
            kapatırsan kaydedilen kelimelerden devam edilir.
          </p>
          <p>
            Kelime tahmini tüm sözlük tamamlanınca açılır. Aşağıdaki istek
            sınırı yalnızca kelime tahmini içindir.
          </p>
          <p>
            {number(scannedCount)} / {number((dict?.count || 0) * AXES.length)}{' '}
            boyut incelemesi · {number((dict?.count || 0) - preparedCount)}{' '}
            eksik kelime.
          </p>
          <p>
            {coverage?.sessionId
              ? `Kaydedilen oturum: ${coverage.sessionId.slice(0, 8)}`
              : 'İlk hazırlamada kalıcı bir oturum oluşturulur.'}
          </p>
          {categoriesReady && (
            <p role="status">
              <strong>
                Kategorize Dosyası Oluştu — %100 kapsam doğrulandı.
              </strong>{' '}
              Her kelime 36 boyutta tarandı. Bu, dilbilimsel doğruluğun %100
              olduğu anlamına gelmez; belirsiz ve uygulanamaz sonuçlar dosyada
              açıkça yer alır.
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
                ? 'Kategori dosyasını indir'
                : 'Kısmi dosyayı indir'}
            </Button>
            <label className="category-upload">
              Kategori dosyası yükle
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
            Dosya yüklemek Jev çağrısı yapmaz. Sözlük ve şema doğrulanır; eksik
            taramalar varsa hazırlama tuşuyla devam edilir.
          </p>
          {categoriesLoading && <p>Kaydedilmiş kategoriler yükleniyor…</p>}
          {categoryError && (
            <p role="alert">
              {categoryError}{' '}
              <Button variant="outline" onClick={() => void loadCategories()}>
                Yeniden yükle
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
          <label htmlFor="repeat-guard">Tekrar koruması</label>
          <span>
            {repetitionGuard
              ? 'Tekrar adaylarını uygulama eler; kalanlar arasından Jev seçer.'
              : 'Ham deney: tekrar adayları elenmez.'}
          </span>
        </div>
        <div className="experiment-settings">
          <Picker
            label="Açık tutulan yollar"
            value={beam}
            onChange={setBeam}
            disabled={isBusy}
            options={[
              ['1', '1 yol · hızlı'],
              ['3', '3 yol · dengeli'],
              ['5', '5 yol · geniş'],
            ]}
          />
          <Picker
            label="Cevap sınırı"
            value={maxWords}
            onChange={setMaxWords}
            disabled={isBusy}
            options={[
              ['16', '16 seçim'],
              ['32', '32 seçim'],
              ['64', '64 seçim'],
            ]}
          />
          <Picker
            label="Kelime tahmini istek sınırı"
            value={budget}
            onChange={setBudget}
            disabled={isBusy}
            options={[
              ['80', '80 istek'],
              ['200', '200 istek'],
              ['400', '400 istek'],
            ]}
          />
        </div>
        <div className="work-grid">
          <section className="conversation panel">
            <div className="panel-heading">
              <h2>Sonuç / Konuşma</h2>
              <div className="heading-actions">
                <span className="tag">İNGİLİZCE</span>
                <button
                  title="Yeni konuşma"
                  aria-label="Yeni konuşma"
                  disabled={isBusy || !messages.length}
                  onClick={() => {
                    setMessages([]);
                    setSteps([]);
                    setSelected(-1);
                    setStats(INITIAL);
                    statsRef.current = INITIAL;
                    setPhase('Yeni konuşma hazır.');
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
                <h3>Cevabın nasıl oluştuğunu gör.</h3>
                <p>
                  Her kelime için kategoriler daralır, güçlü adaylar
                  karşılaştırılır ve bir kelime seçilir.
                </p>
                <div className="flow">
                  <span>Kategori</span>
                  <ArrowRight size={15} />
                  <span>Alt gruplar</span>
                  <ArrowRight size={15} />
                  <span>Finalistler</span>
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
                      {m.role === 'user' ? 'SEN' : 'JEV'}
                    </span>
                    <p>
                      {m.content ||
                        (running ? (
                          <span className="thinking">
                            <span />
                            Adaylar değerlendiriliyor…
                          </span>
                        ) : (
                          'Henüz kelime seçilmedi.'
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
              <label htmlFor="question">İngilizce bir soru sor</label>
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
                    ? 'Sözlük yükleniyor…'
                    : !connected
                      ? 'Önce API anahtarını bağla.'
                      : !categoriesReady
                        ? `Önce bütün sözlüğü kategorize et (${preparedCount}/${dict.count}).`
                        : `${preparedCount} hazırlanmış kelime · Ctrl / ⌘ + Enter`}
                </span>
                {running || classifying || importing ? (
                  <Button variant="destructive" onClick={stop}>
                    <Square size={14} />
                    Durdur
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
                    2. Kelime tahminini başlat <ArrowRight size={16} />
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
                  <TabsTrigger value="monitor">Canlı işlemler</TabsTrigger>
                  <TabsTrigger value="trace">Kelime izi</TabsTrigger>
                  <TabsTrigger value="dictionary">Sözlük</TabsTrigger>
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
                  <strong>Yalnızca Jev</strong>
                  <span>Yedek model yok</span>
                </div>
                <div
                  className="operation-list"
                  role="log"
                  aria-label="Jev canlı işlem günlüğü"
                  aria-live="polite"
                >
                  {!operations.length ? (
                    <div className="monitor-empty">
                      <Network size={32} />
                      <h3>İşlem monitörü hazır</h3>
                      <p>
                        Bağlantı kontrolü ve her Jev isteği burada zamanıyla
                        birlikte görünecek.
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
                              {new Date(op.at).toLocaleTimeString('tr-TR', {
                                hour12: false,
                              })}
                            </time>
                          </div>
                          <p>{op.summary}</p>
                          <div className="operation-meta">
                            <span>#{op.id}</span>
                            <span>
                              {op.questions} soru · {op.options} toplam seçenek
                            </span>
                            <span>
                              {op.status === 'pending'
                                ? 'çalışıyor'
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
                    <p className="section-label">SEÇİLEN KELİMELER</p>
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
                    Kategori → alt gruplar → finalistler → kelime. Bir istek
                    birden çok bağımsız soru içerebilir; her soru en fazla 255
                    seçenek taşır.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="trace">
                {!shownStep && !liveTrace ? (
                  <div className="trace-empty">
                    <Network size={38} />
                    <h3>Henüz seçim yapılmadı</h3>
                    <p>
                      Jev’in seçtiği gruplar, aday kelimeler ve olasılıkları
                      burada görünecek.
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
                          Canlı
                        </button>
                        {steps.map((s, i) => (
                          <button
                            key={i}
                            className={selected === i ? 'current' : ''}
                            onClick={() => setSelected(i)}
                            title={`${i + 1}. seçim`}
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
                              {shownStep.index + 1}. SEÇİM
                            </span>
                            <h3>{shownStep.word}</h3>
                          </div>
                          <div>
                            <strong>
                              {(shownStep.confidence * 100).toFixed(0)}%
                            </strong>
                            <span>API güveni</span>
                          </div>
                        </div>
                        <p className="section-label">Finalist olasılıkları</p>
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
                          Olasılıklar yalnızca bu finalist kümesine aittir.
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
                            <span>{t.options} seçenek</span>
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
                    En fazla 255 seçenek. Güçlü yollar birlikte korunur; farklı
                    grupların kelimeleri finalde yeniden karşılaştırılır.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="dictionary">
                <div className="dictionary-content">
                  <div className="dictionary-total">
                    <BookOpen size={22} />
                    <div>
                      <strong>{dict ? number(dict.count) : '…'}</strong>
                      <span>indirilen İngilizce kelime</span>
                    </div>
                    <a
                      href="/data/words.txt"
                      download="jev-english-words.txt"
                      title="Kelime listesini indir"
                    >
                      <Download size={19} />
                    </a>
                  </div>
                  <p className="dictionary-copy">
                    Sözlük WordNet’ten gelir. 36 boyutta 216 etiket ve ayrıca
                    uygulanamaz / belirsiz seçenekleri sunulur; her kelimenin 36
                    boyuttaki etiketlerini Jev seçer. Kelime tahmini ancak bütün
                    sözlük hazırlandıktan sonra açılır.
                  </p>
                  <p className="dictionary-copy">
                    {number(Object.keys(overrides).length)} kelime Jev
                    tarafından 36 boyutta inceleniyor ve özel sitede saklanıyor.
                    Bir kelime aynı boyutta birden fazla etiket alabilir.
                    Aşağıdaki gruplar ilk 100 kayıtlı kelimeden örnektir; bütün
                    sonuçlar dosyada bulunur.
                  </p>
                  <details className="category-map">
                    <summary>
                      Jev’in hazırladığı kategori metni ve kelime grupları
                    </summary>
                    {!preparedCount && (
                      <p>Henüz kategori haritası hazırlanmadı.</p>
                    )}
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
                                    ? ` … (+${members.length - 100}; tamamı kategori dosyasında)`
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
                    aria-label="Sözlükte kelime ara"
                    placeholder="Kelime ara…"
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
                                  `${AXIS_LABELS[axis]}: ${selectedLabels(axis, overrides[word][index]).join(', ') || 'henüz taranmadı'}`,
                              ).join(' · ')
                            : ids
                                .map((i) => categoryLabel(dict!.categories[i]))
                                .join(', ') + ' · Jev henüz hazırlamadı'}
                        </span>
                      </div>
                    ))}
                    {query && !searchRows.length && <p>Eşleşen kelime yok.</p>}
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
              <b>{stats.words}</b> kelime
            </span>
            <span>
              <b>{stats.requests}</b> istek
            </span>
            <span>
              <b>{number(stats.inputTokens)}</b> girdi tokenı
            </span>
            <span>
              <b>{(stats.elapsedMs / 1000).toFixed(1)}s</b>
            </span>
            <button
              onClick={exportRun}
              disabled={!steps.length && !Object.keys(overrides).length}
              title="Deneme sonuçlarını indir"
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
              ? 'Deneme kaydediliyor…'
              : saveStatus === 'saved'
                ? 'Deneme kaydedildi · Codex bu kaydı okuyabilir.'
                : saveStatus === 'failed'
                  ? 'Kayıt gönderilemedi. Sonucu JSON olarak indirerek saklayabilirsin.'
                  : 'Yeni denemeler özel sitede otomatik kaydedilir; Codex sonuçları okuyabilir.'}
          </span>
          <span>API anahtarı kaydedilmez.</span>
        </div>
        <footer>
          <span>
            <BookOpen size={15} />
            {dict
              ? `${number(activeCount)} etkin kelime · ${dict.categories.length} başlangıç kategorisi`
              : 'Sözlük yükleniyor…'}
            <a href="/data/words.txt" download>
              Kelime listesi ↗
            </a>
          </span>
          <span>Kararlar yalnızca Jev’den gelir. Yedek model yok.</span>
        </footer>
      </main>
    </div>
  );
}
