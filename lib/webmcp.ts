type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};
export function registerLabTools(
  getState: () => unknown,
  stage: (question: string) => void,
  stop: () => void,
) {
  const context = (
    document as unknown as {
      modelContext?: {
        registerTool: (
          tool: Tool,
          options: { signal: AbortSignal },
        ) => Promise<void> | void;
      };
    }
  ).modelContext;
  if (!context) return () => {};
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    {
      name: 'read_jev_experiment',
      description:
        'Read the visible experiment status and latest choices. Never returns the API key.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => getState(),
    },
    {
      name: 'stage_jev_question',
      description:
        'Fill the question field without calling the API. The user starts the experiment with the visible button.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 2000 },
        },
        required: ['question'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (value) => {
        const q = (value as { question?: unknown })?.question;
        if (typeof q !== 'string' || !q.trim() || q.length > 2000)
          throw new Error('A question of 1–2000 characters is required.');
        stage(q);
        return { staged: true, question: q };
      },
    },
    {
      name: 'stop_jev_experiment',
      description: 'Stop the running experiment, preserving partial output.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => {
        stop();
        return { stopRequested: true };
      },
    },
  ];
  for (const t of tools) {
    try {
      void Promise.resolve(
        context.registerTool(t, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Unsupported experimental implementations should not block the app. */
    }
  }
  return () => lifecycle.abort();
}
