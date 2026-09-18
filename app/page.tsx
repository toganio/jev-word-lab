'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { buildTree, commonWords, categoryLabel } from '@/lib/dictionary';
import { generate, classifyWords } from '@/lib/engine';
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
  const [key, setKey] = useState(''),
    [connected, setConnected] = useState(false),
    [checking, setChecking] = useState(false);
  const [dict, setDict] = useState<Dictionary | null>(null),
    [loadError, setLoadError] = useState('');
  const [prompt, setPrompt] = useState('How do I make a good cup of tea?');
  const [limit, setLimit] = useState('0'),
    [beam, setBeam] = useState('3'),
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
  const [overrides, setOverrides] = useState<Record<string, string>>({}),
    [classifyCount, setClassifyCount] = useState('240'),
    [query, setQuery] = useState('');
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
  };
  const evaluate: Evaluate = async (state, questions, signal) => {
    signal.throwIfAborted();
    if (statsRef.current.requests >= Number(budget))
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
    setOperations((old) => [
      ...old.slice(-399),
      {
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
      },
    ]);
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
          .slice(0, 3)
          .map(([qid, a]) =>
            qid === 'next'
              ? `Seçilen: ${a.choice === '__END__' ? 'Cevabı bitir' : a.choice}`
              : qid.startsWith('g')
                ? (questions[qid].criteria[a.choice] || a.choice)
                    .split('Examples:')[0]
                    .slice(0, 100)
                : a.choice,
          )
          .join(' / ') +
        (entries.length > 3 ? ` (+${entries.length - 3} sonuç)` : '');
      setOperations((old) =>
        old.map((o) =>
          o.id === id
            ? { ...o, status: 'done', ms: Date.now() - at, summary }
            : o,
        ),
      );
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
      setOperations((old) =>
        old.map((o) =>
          o.id === id
            ? {
                ...o,
                status: signal.aborted ? 'cancelled' : 'error',
                ms: Date.now() - at,
                summary,
              }
            : o,
        ),
      );
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
      setPhase('Bağlantı hazır. İngilizce bir soru sor.');
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
    if (busy.current || !connected || !dict || !prompt.trim()) return;
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
    try {
      const root = buildTree(dict, Number(limit), overrides);
      const result = await generate({
        root,
        common: commonWords(dict, Number(limit)),
        history,
        beam: Number(beam),
        maxWords: Number(maxWords),
        signal: c.signal,
        evaluate,
        onPhase: (text, trace) => {
          setPhase(text);
          if (trace) setLiveTrace(trace);
        },
        onStep: (step, text) => {
          setSteps((s) => [...s, step]);
          setMessages([...history, { role: 'assistant', content: text }]);
          updateStats({
            words: text.split(/\s+/).filter(Boolean).length,
            elapsedMs: Date.now() - statsRef.current.startedAt,
          });
        },
      });
      setPhase(result.reason);
    } catch (e) {
      if (c.signal.aborted) setPhase('Durduruldu. Kısmi cevap korundu.');
      else {
        setError(e instanceof Error ? e.message : 'Deneme tamamlanamadı.');
        setPhase('Deneme durdu.');
      }
    } finally {
      updateStats({ elapsedMs: Date.now() - statsRef.current.startedAt });
      setRunning(false);
      busy.current = false;
      controller.current = null;
      setLiveTrace(null);
    }
  }
  async function classify() {
    if (busy.current || !dict || !connected) return;
    busy.current = true;
    setClassifying(true);
    setError('');
    setOperations([]);
    setMonitorTab('monitor');
    const c = new AbortController();
    controller.current = c;
    statsRef.current = { ...INITIAL, startedAt: Date.now() };
    setStats(statsRef.current);
    const count = Number(classifyCount);
    const words = dict.words
      .slice(0, Number(limit) || dict.count)
      .filter(
        ([w, ids]) =>
          !Object.hasOwn(overrides, w) &&
          !ids.some((i) => dict.categories[i] === 'function'),
      )
      .slice(0, count)
      .map(([w]) => w);
    let done = 0;
    try {
      if (!words.length) {
        setPhase(
          'Bu sözlükteki kelimeler zaten Jev tarafından sınıflandırıldı.',
        );
        return;
      }
      await classifyWords(
        words,
        Object.fromEntries(
          dict.categories.map((cat) => [cat, categoryLabel(cat)]),
        ),
        evaluate,
        c.signal,
        (result) => {
          done += Object.keys(result).length;
          setOverrides((old) => ({ ...old, ...result }));
          setPhase(
            `Jev ${done} / ${words.length} kelimeyi kategorilere ayırdı.`,
          );
        },
      );
      setPhase(
        `${done} kelime Jev tarafından sınıflandırıldı. Yeni gruplar sonraki denemede kullanılacak.`,
      );
    } catch (e) {
      if (c.signal.aborted)
        setPhase('Sınıflandırma durduruldu. Tamamlanan gruplar korundu.');
      else
        setError(e instanceof Error ? e.message : 'Sınıflandırma başarısız.');
    } finally {
      updateStats({ elapsedMs: Date.now() - statsRef.current.startedAt });
      setClassifying(false);
      busy.current = false;
      controller.current = null;
    }
  }
  function exportRun() {
    const data = {
      createdAt: new Date().toISOString(),
      model: 'jev-latest',
      dictionary: dict?.source,
      settings: {
        limit: Number(limit),
        beam: Number(beam),
        maxWords: Number(maxWords),
        requestBudget: Number(budget),
      },
      messages,
      steps,
      stats,
      operations,
      provider: 'TypeSafe',
      fallback: false,
      jevCategories: overrides,
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
  const isBusy = running || classifying || checking;
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
        <div className="experiment-settings">
          <Picker
            label="Kelime havuzu"
            value={limit}
            onChange={setLimit}
            disabled={isBusy}
            options={[
              [
                '0',
                dict
                  ? `Tüm sözlük · ${number(dict.count)}`
                  : 'Sözlük yükleniyor…',
              ],
              ['5000', 'İlk 5.000 kelime'],
              ['15000', 'İlk 15.000 kelime'],
            ]}
          />
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
            label="API istek sınırı"
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
                      : 'Ctrl / ⌘ + Enter ile başlat'}
                </span>
                {running || classifying ? (
                  <Button variant="destructive" onClick={stop}>
                    <Square size={14} />
                    Durdur
                  </Button>
                ) : (
                  <Button
                    onClick={() => void run()}
                    disabled={isBusy || !connected || !dict || !prompt.trim()}
                  >
                    Denemeyi başlat <ArrowRight size={16} />
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
                    Başlangıç grupları WordNet’in{' '}
                    {dict?.categories.length || 46} sözlük kategorisinden gelir.
                    Jev’in kendi sınıflandırmasını da deneyebilirsin.
                  </p>
                  <div className="classify-controls">
                    <Picker
                      label="Jev’in sınıflandıracağı kelimeler"
                      value={classifyCount}
                      onChange={setClassifyCount}
                      disabled={isBusy}
                      options={[
                        ['240', 'Sıradaki 240 kelime'],
                        ['960', 'Sıradaki 960 kelime'],
                        ['4800', 'Sıradaki 4.800 kelime'],
                      ]}
                    />
                    <Button
                      variant="outline"
                      onClick={() => void classify()}
                      disabled={isBusy || !connected || !dict}
                    >
                      <FlaskConical size={15} />
                      Jev ile kategorile
                    </Button>
                  </div>
                  <p className="dictionary-copy">
                    {number(Object.keys(overrides).length)} kelime Jev
                    tarafından gruplandı. Sonuçlar bu oturumda tutulur; JSON
                    çıktısına dahil edilir.
                  </p>
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
                            ? `Jev · ${categoryLabel(overrides[word])}`
                            : ids
                                .map((i) => categoryLabel(dict!.categories[i]))
                                .join(', ')}
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
