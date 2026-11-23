# Tiny Pixel People

A tiny top-down pixel village whose 10–20 villagers are driven by LLMs, in the spirit of
[Generative Agents](https://arxiv.org/abs/2304.03442) (Smallville): each villager has a memory stream,
reflects, plans its day, chats and gossips with neighbours, organises small events, and answers the
notes you leave on its door. Runs fully offline with a local [Ollama](https://ollama.com), or against
OpenAI-compatible, Anthropic or Gemini endpoints, selected by config only.

> Status: early development. The skeleton serves a placeholder map; simulation, cognition and the
> real renderer are being built in parallel work packages.

## Quick start

Requirements: Node.js >= 22.12, and for local models Ollama with a chat model and an embedding model:

```sh
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

Then:

```sh
npm install
npm start          # builds the client and starts the server at http://127.0.0.1:3000
```

Optional: `cp config.example.json config.json` and edit it (provider, model, day length, villagers).
Environment variables (see `.env.example`) override the file.

## Choosing an LLM provider

| `llm.provider`                          | Typical `baseUrl`                                                      | Key                              |
| --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| `ollama`                                | `http://127.0.0.1:11434`                                               | none                             |
| `openai` (any OpenAI-compatible server) | `https://api.openai.com/v1`, `http://localhost:1234/v1` (LM Studio), … | `apiKeyEnv: "OPENAI_API_KEY"`    |
| `anthropic`                             | `https://api.anthropic.com`                                            | `apiKeyEnv: "ANTHROPIC_API_KEY"` |
| `gemini`                                | `https://generativelanguage.googleapis.com/v1beta`                     | `apiKeyEnv: "GEMINI_API_KEY"`    |
| `mock`                                  | –                                                                      | – (deterministic, for tests)     |

Embeddings are configured separately (`embeddings.provider`, default `auto`). Without embeddings the
villagers fall back to keyword-based memory retrieval.

## Development

```sh
npm run dev        # server (tsx watch) + Vite dev server with /ws proxy
npm run lint
npm run typecheck
npm test           # unit + acceptance tests with the mock provider
npm run check      # everything CI runs
```

Layout: `src/shared` (types and WebSocket protocol), `src/server` (config, llm, sim, cognition,
persistence, net), `src/client` (canvas UI), `data` (map and villagers), `assets` (art, see
`assets/CREDITS.md`), `docs`, `test`.

## License

MIT, see [LICENSE](LICENSE). Third-party assets keep their own licenses, listed in `assets/CREDITS.md`.
