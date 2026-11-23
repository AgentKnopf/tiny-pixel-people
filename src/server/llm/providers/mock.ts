/**
 * Deterministic mock provider for tests and offline demos. Owned by WP6.
 * Answers by `req.task` using `req.meta` (structured context). See specs/technical-spec.md §13.
 * The skeleton only implements a minimal generic answer; WP6 fills in per-task behaviour.
 */
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  EmbeddingProvider,
  HealthResult,
  LlmTask,
} from '../types.ts';

export type MockHandler = (req: ChatRequest) => string | Promise<string>;

export class MockChatProvider implements ChatProvider {
  readonly kind = 'mock' as const;
  private readonly scripts = new Map<LlmTask, MockHandler>();

  constructor(readonly model: string = 'mock') {}

  /** Override the answer for one task (tests). */
  setScript(task: LlmTask, handler: MockHandler | null): void {
    if (handler) this.scripts.set(task, handler);
    else this.scripts.delete(task);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const handler = this.scripts.get(req.task);
    const text = handler ? await handler(req) : defaultAnswer(req);
    return { text, model: this.model, latencyMs: Date.now() - started };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, message: `mock provider (model "${this.model}")` };
  }
}

function defaultAnswer(req: ChatRequest): string {
  switch (req.task) {
    case 'importance.rate':
      return JSON.stringify({ importance: 3 });
    case 'convo.turn':
      return JSON.stringify({ say: 'Hello there!', end: false });
    case 'note.reply':
      return JSON.stringify({ reply: 'Thank you for your note!' });
    case 'event.decide':
      return JSON.stringify({ accept: true, reason: 'Sounds fun.' });
    default:
      return JSON.stringify({});
  }
}

/** Deterministic hashed bag-of-words embeddings (unit length). */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'mock' as const;

  constructor(
    readonly model: string = 'mock-embed',
    readonly dimensions = 64,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
}

export function hashEmbed(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    const idx = (h >>> 0) % dims;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
