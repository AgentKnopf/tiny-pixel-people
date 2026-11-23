# LLM providers

The villagers can think with a local model or a hosted one. The provider, endpoint and model are
set in `config.json` (or environment variables) only; switching never needs code changes. Restart
the server after a change. The LLM card in the game and the startup log show what is running.

| `llm.provider` | For                                                                                       | Default `baseUrl`                                  | Embeddings                            |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| `ollama`       | Local models with [Ollama](ollama.md) (default)                                           | `http://127.0.0.1:11434`                           | yes                                   |
| `openai`       | Any OpenAI-compatible API: OpenAI, LM Studio, vLLM, llama.cpp server, OpenRouter, Groq, … | `https://api.openai.com/v1`                        | yes, if the server has `/embeddings`  |
| `anthropic`    | Claude models, native Messages API                                                        | `https://api.anthropic.com`                        | no (use another provider or keywords) |
| `gemini`       | Google Gemini, native API                                                                 | `https://generativelanguage.googleapis.com/v1beta` | yes                                   |
| `mock`         | Tests and demos without any model; deterministic canned answers                           | –                                                  | yes (fake)                            |

## API keys

Keep keys out of `config.json` where possible. Name an environment variable in `apiKeyEnv` and set
it in your shell or in a `.env` file in the repo folder (gitignored; `.env.example` lists the
variables):

```json
{ "llm": { "provider": "openai", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" } }
```

```sh
# .env
OPENAI_API_KEY=sk-...
```

How the key is found, first match wins:

1. `TPP_LLM_API_KEY` (environment), which overrides `llm.apiKey`.
2. `llm.apiKey` (a literal key in the config file).
3. The environment variable named by `llm.apiKeyEnv`.
4. The provider's usual variable, when `apiKey` and `apiKeyEnv` are both empty:
   `ANTHROPIC_API_KEY` for `anthropic`, `GEMINI_API_KEY` or else `GOOGLE_API_KEY` for `gemini`,
   and `OPENAI_API_KEY` for `openai`, but only when `baseUrl` is `api.openai.com`. Your OpenAI key
   is never sent to another OpenAI-compatible server (OpenRouter, Groq, a local server) by accident;
   for those, name the variable in `apiKeyEnv`.

Embeddings look up `TPP_EMBED_API_KEY`, `embeddings.apiKey` and `embeddings.apiKeyEnv` first.
If none is set and the embeddings use the same provider and endpoint as the chat model, they reuse
the chat key; otherwise the provider's usual variable from step 4 applies. Ollama needs no key; if
you set one anyway (for example for an Ollama behind an authenticating proxy), it is sent as
`Authorization: Bearer <key>`.
Keys are never sent to the browser and never written to logs or to the optional prompt log
(`llm.logFile`).

## Examples

Each example is a complete `config.json` for that setup; every other key keeps its default.

### Ollama (default)

```json
{ "llm": { "provider": "ollama", "model": "qwen2.5:7b" } }
```

Embeddings default to Ollama's `nomic-embed-text`. See [Ollama setup](ollama.md).

### OpenAI

```json
{ "llm": { "provider": "openai", "model": "gpt-4o-mini" } }
```

With `OPENAI_API_KEY` set in your shell or `.env`, that is all you need. `embeddings.provider` is
`auto`, which means "the same provider as `llm`". When `embeddings.model` is left at its default
(`nomic-embed-text`, an Ollama name) and the endpoint is `api.openai.com`, the game uses
`text-embedding-3-small` instead. Set `embeddings.model` to pick another one.

### LM Studio

Start LM Studio's local server (Developer tab, default port 1234) and load a model. The model name
is the identifier LM Studio shows for the loaded model.

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "http://localhost:1234/v1",
    "model": "qwen2.5-7b-instruct",
    "jsonMode": false
  },
  "embeddings": {
    "provider": "openai",
    "baseUrl": "http://localhost:1234/v1",
    "model": "text-embedding-nomic-embed-text-v1.5"
  }
}
```

No key is needed for local servers. For a server other than `api.openai.com`, set
`embeddings.model` to an embedding model that server has loaded; the default `nomic-embed-text` is
sent unchanged. Some local servers reject OpenAI's JSON mode (`response_format`). If a server
answers HTTP 400 and the error names `response_format`, the game retries once without it and keeps
it off for the rest of the run; `jsonMode: false` turns it off from the start. In both cases the
game parses JSON from plain text. The same automatic adjustment happens when a server rejects
`max_tokens` (renamed to `max_completion_tokens`) or `temperature` (left out).

### vLLM

```sh
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000
```

```json
{
  "llm": { "provider": "openai", "baseUrl": "http://localhost:8000/v1", "model": "Qwen/Qwen2.5-7B-Instruct" },
  "embeddings": { "provider": "none" }
}
```

A vLLM server usually serves one model; set `embeddings.provider` to `none` (keyword recall) or
point embeddings at Ollama (see [Mixing providers](#mixing-providers)).

### llama.cpp server

```sh
llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf --port 8080
```

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "http://localhost:8080/v1",
    "model": "qwen2.5-7b",
    "jsonMode": false
  }
}
```

### OpenRouter

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "meta-llama/llama-3.1-8b-instruct",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "embeddings": { "provider": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "nomic-embed-text" }
}
```

Use any model id from <https://openrouter.ai/models>. OpenRouter has no embeddings endpoint for
most models, so this example takes embeddings from a local Ollama; use `"provider": "none"` if you
don't run one.

### Groq and other hosted OpenAI-compatible APIs

Same pattern: `provider: "openai"`, the service's base URL (ending in `/v1`), its model id, and a
key via `apiKeyEnv`. For example Groq: `"baseUrl": "https://api.groq.com/openai/v1"`.

### Anthropic (Claude)

```json
{
  "llm": { "provider": "anthropic", "model": "claude-haiku-4-5", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "embeddings": { "provider": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "nomic-embed-text" }
}
```

Use a model id from Anthropic's model list; small, fast models are a good fit because the game
makes many short calls. Anthropic has no embeddings API: with `embeddings.provider: "auto"` the game
switches embeddings off and uses keyword recall. The example above takes embeddings from a local
Ollama instead. `llm.maxTokens` is sent as Anthropic's required `max_tokens`, and `llm.temperature`
is capped at 1, the highest value Anthropic accepts. If `apiKey` and `apiKeyEnv` are empty, the key
comes from `ANTHROPIC_API_KEY`, so `apiKeyEnv` above is optional.

### Google Gemini

```json
{ "llm": { "provider": "gemini", "model": "gemini-2.5-flash" } }
```

Get a key at <https://aistudio.google.com/apikey> and set it as `GEMINI_API_KEY` (or
`GOOGLE_API_KEY`), or name another variable in `llm.apiKeyEnv`. Use model ids from Google's model
list; `models/gemini-2.5-flash` works too. Embeddings come from Gemini as well: when
`embeddings.model` is left at the Ollama default `nomic-embed-text`, the game uses
`gemini-embedding-001`.

### Mock (no model)

```json
{ "llm": { "provider": "mock" } }
```

Canned, deterministic answers. Useful to try the UI, for tests, or on a machine without any model.
Villagers still plan, talk, gossip and run events, but their words are repetitive.

## Mixing providers

Chat and embeddings are configured separately. `embeddings.provider` can be `auto` (same as `llm`,
or `none` for Anthropic), `ollama`, `openai`, `gemini`, `mock` or `none`. Give the embeddings their
own `baseUrl`, `model` and key when they come from a different place than the chat model. `none`
switches embeddings off; villagers then find memories by keywords.

## Switching model or provider without code changes

Any of these works, then restart:

- Edit `llm.provider`, `llm.model` and, if needed, `llm.baseUrl` / `llm.apiKeyEnv` in `config.json`.
- Override for one run: `TPP_LLM_PROVIDER=openai TPP_LLM_MODEL=gpt-4o-mini npm start`.
- Keep several files and choose one: `npm start -- --config configs/claude.json` (or
  `TPP_CONFIG=configs/claude.json`).

If `llm.baseUrl` is empty, the provider's default from the table above is used, so switching
provider doesn't require a base URL. Saves keep working across switches: memories are plain text,
and memories without a matching embedding fall back to keyword recall.

## Costs and rate limits

A game day with 10 villagers makes roughly 200 short calls (a few hundred tokens each), plus your
own chats. At 8× speed that's a day every couple of minutes. With a paid API, watch the call
counter on the stats card. Rate-limit errors (HTTP 429), server errors (5xx) and network errors are
retried up to twice with backoff, honouring the server's `retry-after` (capped at 30 seconds);
timeouts are not retried. Villagers fall back to simple behaviour while the model is unavailable.
Lower `llm.concurrency` if you hit limits often. See [Performance](performance.md) for what the
stats card numbers mean.
