# Ollama setup

[Ollama](https://ollama.com) runs open models on your own machine. It is the default provider:
with Ollama running and the two default models pulled, `npm start` needs no config at all.

## 1. Install and start Ollama

- **macOS / Windows**: download the app from <https://ollama.com/download> and start it. It runs in
  the background (menu bar / tray).
- **Linux**: `curl -fsSL https://ollama.com/install.sh | sh`. The installer sets up a service; if
  it isn't running, start it with `ollama serve`.

Check that it answers:

```sh
curl http://127.0.0.1:11434/api/tags
```

## 2. Pull a chat model and an embedding model

```sh
ollama pull qwen2.5:7b          # chat model (default)
ollama pull nomic-embed-text    # embeddings (default), ~270 MB
```

The chat model writes plans, dialogue, replies and reflections. The embedding model helps villagers
find relevant memories. Without an embedding model the villagers fall back to keyword matching,
which works but recalls memories less well.

## 3. Start the game

```sh
npm start
```

On startup the server checks that Ollama answers and that the model is pulled. If it isn't, the log
tells you what to run, for example
`LLM ollama/qwen2.5:7b: model qwen2.5:7b not pulled; run: ollama pull qwen2.5:7b`. If Ollama isn't
running, the log ends with `Is Ollama running? Start it with: ollama serve`. The game still starts:
villagers follow simple default plans and the LLM card shows `⚠ MODEL UNREACHABLE`. A second line,
`embeddings: …`, reports the embedding model the same way. If the embedding model can't be used at
startup, the game logs `embeddings disabled (…); memory retrieval falls back to keywords` and keeps
keyword recall until the next restart. Pull the models (or start Ollama) and restart the server. When
everything works the card reads `✈ OFFLINE · RUNNING ON THIS MACHINE · QWEN2.5:7B VIA OLLAMA`:
"offline" here means no internet is needed.

## Which model for which machine

The model must follow JSON instructions reliably; Qwen 2.5 and Llama 3.x do this well. Sizes are
for the default 4-bit quantisations Ollama downloads.

| Machine                                                    | Chat model (`llm.model`)                    | Download | Suggested settings                                                                              |
| ---------------------------------------------------------- | ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 8 GB RAM, no GPU (or a laptop on battery)                  | `gemma3:4b` or `qwen2.5:1.5b`               | ~1–3 GB  | `llm.concurrency: 1`, `sim.dayLengthMinutes: 60`–`120`, `cognition.importanceMode: "heuristic"` |
| 16 GB Apple Silicon (M1 or newer), or a GPU with 8 GB VRAM | **`qwen2.5:7b`** (default) or `llama3.1:8b` | ~5 GB    | defaults                                                                                        |
| 32 GB Apple Silicon, or a GPU with 12–16 GB VRAM           | `qwen2.5:14b`                               | ~9 GB    | defaults; try `llm.concurrency: 3`                                                              |
| 64 GB+ Apple Silicon, or a GPU with 24 GB VRAM             | `qwen2.5:32b`                               | ~20 GB   | `sim.dayLengthMinutes: 20`, since big models are slower per call                                |
| Old CPU-only machine                                       | `gemma3:4b` or `qwen2.5:1.5b`               | ~1–3 GB  | as for 8 GB but `sim.dayLengthMinutes: 90`, plus `sim.villagers: 6`. Expect simpler dialogue.   |

Rules of thumb:

- The model needs to fit in GPU memory (or, on Apple Silicon, in about two thirds of RAM) with room
  to spare, or it gets very slow.
- A game day makes roughly 200 model calls with 10 villagers. With the default 15-minute day at 1×
  that is one call every 4.5 seconds, so about 9 seconds per call when two run at once. If your
  model is slower, villagers are still fine; they just talk and plan less. A longer day or fewer
  villagers gives each one more thinking time. See [Performance and slow hardware](performance.md).
- Embeddings are cheap; keep `nomic-embed-text` on every machine. `mxbai-embed-large` also works.

## Switching models

Edit `config.json` and restart:

```json
{ "llm": { "model": "llama3.1:8b" } }
```

or, for one run:

```sh
TPP_LLM_MODEL=llama3.1:8b npm start
```

The LLM card in the game shows the model that is running. Pull the model first (`ollama list`
shows what you have).

## Parallel requests

`llm.concurrency` (default 2) is how many model calls the game sends at once. Ollama decides how
many it actually runs in parallel with its own `OLLAMA_NUM_PARALLEL` setting; recent versions pick
it automatically from free memory. If you raise `llm.concurrency`, also allow Ollama to run that
many:

```sh
OLLAMA_NUM_PARALLEL=3 ollama serve
```

On the macOS app, set it with `launchctl setenv OLLAMA_NUM_PARALLEL 3` and restart the app.

## Ollama on another machine

Point the game at it:

```json
{ "llm": { "provider": "ollama", "baseUrl": "http://192.168.1.20:11434", "model": "qwen2.5:7b" } }
```

On that machine, make Ollama listen on the network with `OLLAMA_HOST=0.0.0.0 ollama serve`.
Embeddings use the same server unless you set `embeddings.baseUrl`. If that Ollama sits behind a
proxy that wants a key, set `llm.apiKeyEnv` (or `llm.apiKey`); the game then sends
`Authorization: Bearer <key>`, and the embeddings reuse it on the same server.
