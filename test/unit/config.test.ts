import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_BASE_URLS,
  loadConfig,
  OLLAMA_DEFAULT_CONCURRENCY,
  redactConfig,
  resolveApiKey,
  resolveEmbeddingProvider,
} from '../../src/server/config.ts';

function tmpConfig(content: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, path };
}

describe('loadConfig', () => {
  it('uses defaults (Ollama on localhost) when no config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-empty-'));
    const cfg = loadConfig({ cwd: dir, env: {} });
    expect(cfg.sourcePath).toBeNull();
    expect(cfg.llm.provider).toBe('ollama');
    expect(cfg.llm.baseUrl).toBe(DEFAULT_BASE_URLS.ollama);
    expect(cfg.llm.concurrency).toBe(OLLAMA_DEFAULT_CONCURRENCY);
    expect(cfg.sim.wakeUpTimeoutSec).toBe(300);
  });

  it('defaults llm.concurrency to 1 for ollama and 2 for other providers unless set', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tpp-empty-'));
    expect(OLLAMA_DEFAULT_CONCURRENCY).toBe(1);
    expect(loadConfig({ cwd: empty, env: { TPP_LLM_PROVIDER: 'openai' } }).llm.concurrency).toBe(2);
    expect(loadConfig({ cwd: empty, env: {}, overrides: { llm: { concurrency: 3 } } }).llm.concurrency).toBe(
      3,
    );
    const { dir } = tmpConfig({ llm: { provider: 'ollama', concurrency: 2 } });
    expect(loadConfig({ cwd: dir, env: {} }).llm.concurrency).toBe(2);
  });

  it('accepts sim.wakeUpTimeoutSec 0 (hold disabled) and rejects negatives', () => {
    const off = tmpConfig({ sim: { wakeUpTimeoutSec: 0 } });
    expect(loadConfig({ cwd: off.dir, env: {} }).sim.wakeUpTimeoutSec).toBe(0);
    const bad = tmpConfig({ sim: { wakeUpTimeoutSec: -1 } });
    expect(() => loadConfig({ cwd: bad.dir, env: {} })).toThrow(/sim\.wakeUpTimeoutSec/);
  });

  it('merges a partial config file over defaults', () => {
    const { dir } = tmpConfig({ llm: { model: 'llama3.1:8b' }, sim: { villagers: 12 } });
    const cfg = loadConfig({ cwd: dir, env: {} });
    expect(cfg.llm.model).toBe('llama3.1:8b');
    expect(cfg.sim.villagers).toBe(12);
    expect(cfg.sim.dayLengthMinutes).toBe(15);
  });

  it('lets environment variables override the file', () => {
    const { dir } = tmpConfig({ llm: { provider: 'openai', model: 'gpt-4o-mini' } });
    const cfg = loadConfig({ cwd: dir, env: { TPP_LLM_MODEL: 'other-model', TPP_PORT: '4000' } });
    expect(cfg.llm.provider).toBe('openai');
    expect(cfg.llm.baseUrl).toBe(DEFAULT_BASE_URLS.openai);
    expect(cfg.llm.model).toBe('other-model');
    expect(cfg.server.port).toBe(4000);
  });

  it('reports readable validation errors', () => {
    const { dir } = tmpConfig({ llm: { provider: 'nope', concurrency: 0 } });
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(ConfigError);
    try {
      loadConfig({ cwd: dir, env: {} });
    } catch (err) {
      expect((err as Error).message).toMatch(/llm\.provider/);
      expect((err as Error).message).toMatch(/llm\.concurrency/);
    }
  });

  it('rejects malformed JSON and missing explicit paths', () => {
    const { dir } = tmpConfig('{ not json');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/Could not parse/);
    expect(() => loadConfig({ cwd: dir, env: {}, path: 'missing.json' })).toThrow(/not found/);
  });

  it('ships a config.example.json that validates', () => {
    const cfg = loadConfig({ path: 'config.example.json', env: {} });
    expect(cfg.llm.provider).toBe('ollama');
    // Copying the example must keep the v2 residents and the Ollama concurrency default.
    expect(cfg.sim.villagers).toBe(12);
    expect(cfg.llm.concurrency).toBe(1);
  });
});

describe('helpers', () => {
  it('resolves API keys from literal or env var', () => {
    expect(resolveApiKey({ apiKey: 'k', apiKeyEnv: 'X' }, { X: 'env' })).toBe('k');
    expect(resolveApiKey({ apiKey: '', apiKeyEnv: 'X' }, { X: 'env' })).toBe('env');
    expect(resolveApiKey({ apiKey: '', apiKeyEnv: '' }, {})).toBeUndefined();
  });

  it('resolves auto embeddings provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-empty-'));
    expect(resolveEmbeddingProvider(loadConfig({ cwd: dir, env: {} }))).toBe('ollama');
    const anth = loadConfig({ cwd: dir, env: { TPP_LLM_PROVIDER: 'anthropic' } });
    expect(resolveEmbeddingProvider(anth)).toBe('none');
  });

  it('redacts secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpp-empty-'));
    const cfg = loadConfig({ cwd: dir, env: { TPP_LLM_API_KEY: 'secret' } });
    expect(redactConfig(cfg).llm.apiKey).toBe('***');
  });
});
