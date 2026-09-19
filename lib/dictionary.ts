import type { Dictionary } from './types';
import {
  AXES,
  AXIS_DEFINITIONS,
  AXIS_LABELS,
  selectedLabels,
  isComplete,
  type CategoryMap,
} from './categories';
export type WordNode = { kind: 'word'; word: string; label: string; count: 1 };
export type GroupNode = {
  kind: 'group';
  label: string;
  description: string;
  count: number;
  children: Node[];
};
export type Node = WordNode | GroupNode;
export const LEAF_SIZE = 200;
export const STOP = '__END__';
export const PUNCTUATION = ['.', ',', '?', '!', ':', ';'];
export function categoryLabel(id: string) {
  const [pos, topic] = id.split('.');
  const names: Record<string, string> = {
    adj: 'Adjectives',
    adv: 'Adverbs',
    noun: 'Nouns',
    verb: 'Verbs',
    function: 'Function words',
    Tops: 'general concepts',
    act: 'actions',
    artifact: 'objects and tools',
    cognition: 'thinking and knowledge',
    communication: 'communication',
    feeling: 'feelings',
    food: 'food and drink',
    group: 'groups',
    location: 'places',
    motive: 'motivation',
    object: 'natural objects',
    person: 'people',
    phenomenon: 'natural phenomena',
    plant: 'plants',
    possession: 'ownership',
    process: 'processes',
    quantity: 'quantities',
    relation: 'relationships',
    shape: 'shapes',
    state: 'states',
    substance: 'materials',
    time: 'time',
    body: 'body',
    animal: 'animals',
    attribute: 'properties',
    event: 'events',
    change: 'change',
    competition: 'competition',
    consumption: 'eating and drinking',
    contact: 'physical contact',
    creation: 'creation',
    emotion: 'emotion',
    motion: 'movement',
    perception: 'senses',
    social: 'social actions',
    stative: 'states of being',
    weather: 'weather',
    all: 'general',
    pert: 'relational',
    ppl: 'participial',
  };
  return [names[pos] || pos, names[topic] || topic].filter(Boolean).join(' · ');
}
function wordNode(word: string): WordNode {
  return { kind: 'word', word, label: word, count: 1 };
}
/** Flatten redundant prefix levels while retaining every word and at most 200 options. */
export function compactChildren(input: Node[]): Node[] {
  let children = [...input];
  while (true) {
    const expandable = children
      .map((node, index) => ({ node, index }))
      .filter(
        ({ node }) =>
          node.kind === 'group' &&
          children.length - 1 + node.children.length <= LEAF_SIZE,
      )
      .sort(
        (a, b) =>
          (a.node as GroupNode).children.length -
          (b.node as GroupNode).children.length,
      )[0];
    if (!expandable) return children;
    children.splice(
      expandable.index,
      1,
      ...(expandable.node as GroupNode).children,
    );
  }
}
function branch(
  words: string[],
  label: string,
  prefix = '',
  cache?: Map<string, WordNode>,
): GroupNode {
  const leaf = (w: string) => {
    let n = cache?.get(w);
    if (!n) {
      n = wordNode(w);
      cache?.set(w, n);
    }
    return n;
  };
  let children: Node[];
  if (words.length <= LEAF_SIZE) children = words.map(leaf);
  else {
    // Balanced alphabetical ranges avoid long single-letter chains. Every word
    // remains reachable, with at most 200 ranges and 200 words per leaf.
    const sorted = [...words].sort();
    const width = Math.max(LEAF_SIZE, Math.ceil(sorted.length / LEAF_SIZE));
    children = [];
    for (let i = 0; i < sorted.length; i += width) {
      const batch = sorted.slice(i, i + width);
      const range = `${batch[0]} … ${batch.at(-1)}`;
      children.push(
        branch(batch, `${label.split(' / ')[0]} / ${range}`, range, cache),
      );
    }
  }
  return {
    kind: 'group',
    label,
    count: words.length,
    children: compactChildren(children),
    description: `${label}. Examples: ${words.slice(0, 3).join(', ')}. ${words.length} words.`,
  };
}
export function buildTree(
  dict: Dictionary,
  limit: number,
  overrides: Record<string, string> = {},
): GroupNode {
  const rows = limit ? dict.words.slice(0, limit) : dict.words;
  const buckets = new Map<string, string[]>();
  for (const [word, indices] of rows) {
    const cats = Object.hasOwn(overrides, word)
      ? [overrides[word]]
      : indices.map((i) => dict.categories[i]);
    for (const cat of cats) {
      const b = buckets.get(cat) || [];
      b.push(word);
      buckets.set(cat, b);
    }
  }
  const children = [...buckets]
    .filter(([, ws]) => ws.length)
    .map(([cat, ws]) => branch(ws, categoryLabel(cat)));
  return {
    kind: 'group',
    label: 'English dictionary',
    description: dict.source,
    count: rows.length,
    children,
  };
}
export function commonWords(dict: Dictionary, limit: number): string[] {
  return dict.words
    .slice(0, limit || dict.count)
    .filter(([, ids]) => ids.some((i) => dict.categories[i] === 'function'))
    .slice(0, 110)
    .map(([w]) => w);
}
/** All memberships come from Jev; unprepared words are never silently added. */
export function buildPreparedTree(
  dict: Dictionary,
  limit: number,
  prepared: CategoryMap,
): GroupNode {
  const rows = dict.words
    .slice(0, limit || dict.count)
    .filter(([word]) => isComplete(prepared[word]));
  if (
    rows.length < 2 ||
    rows.length !== (limit ? Math.min(limit, dict.count) : dict.count)
  )
    throw new Error(
      'Categorize the entire dictionary with Jev before prediction.',
    );
  const cache = new Map<string, WordNode>();
  const children = AXES.map((axis, axisIndex) => {
    const buckets = new Map<string, string[]>();
    for (const [word] of rows) {
      for (const id of selectedLabels(axis, prepared[word][axisIndex])) {
        const words = buckets.get(id) || [];
        words.push(word);
        buckets.set(id, words);
      }
    }
    const groups = [...buckets].map(([id, words]) =>
      branch(words, `${axis}: ${id}`, '', cache),
    );
    return {
      kind: 'group' as const,
      label: `${axis} · ${AXIS_LABELS[axis]}`,
      description: `Search by ${axis}. ${AXIS_DEFINITIONS[axisIndex].guidance} Groups: ${groups.map((g) => g.label).join('; ')}. Memberships can overlap. Use the conversation and current sentence to choose the relevant route.`,
      count: rows.length,
      children: groups,
    };
  });
  return {
    kind: 'group',
    label: 'English dictionary',
    description: 'Jev-prepared multidimensional category map',
    count: rows.length,
    children,
  };
}
export function joinWords(words: string[]): string {
  let result = '';
  for (const w of words) {
    if (PUNCTUATION.includes(w)) result = result.trimEnd() + w;
    else result += (result ? ' ' : '') + w;
  }
  return result
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\bi\b/g, 'I');
}
