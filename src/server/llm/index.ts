import { resolveEmbeddingProvider, type AppConfig } from '../config.ts';
import { LlmError } from './errors.ts';
import { MockChatProvider, MockEmbeddingProvider } from './providers/mock.ts';
import type { Providers } from './types.ts';

/**
 * Build chat + embedding providers from config. Switching provider or model is config-only.
 * WP1 replaces the `not implemented` branches with real providers in ./providers/*.ts.
 */
export function createProviders(cfg: AppConfig): Providers {
  const chat = (() => {
    switch (cfg.llm.provider) {
      case 'mock':
        return new MockChatProvider(cfg.llm.model);
      case 'ollama':
      case 'openai':
      case 'anthropic':
      case 'gemini':
        throw new LlmError('config', `LLM provider "${cfg.llm.provider}" is not implemented yet (WP1)`);
    }
  })();
  const embedKind = resolveEmbeddingProvider(cfg);
  const embeddings = (() => {
    switch (embedKind) {
      case 'none':
        return null;
      case 'mock':
        return new MockEmbeddingProvider(cfg.embeddings.model || 'mock-embed');
      default:
        throw new LlmError('config', `Embedding provider "${embedKind}" is not implemented yet (WP1)`);
    }
  })();
  return { chat, embeddings };
}
