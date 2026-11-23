# Configuration reference

The server reads its settings in this order; later sources override earlier ones:

1. Built-in defaults (`src/server/config.ts`).
2. The config file: `./config.json`, or the file given with `--config <path>` or `TPP_CONFIG`.
   A missing `./config.json` is fine (defaults are used); a missing file named explicitly is an
   error.
3. Environment variables (see [below](#environment-variables)). A `.env` file in the folder you
   start from is loaded first, if it exists.

The file only needs the keys you want to change. Unknown values are rejected on startup with a
message that names the key, for example:

```
Invalid configuration in /path/config.json:
  - llm.provider: Invalid option: expected one of "ollama"|"openai"|"anthropic"|"gemini"|"mock"
```

`config.example.json` contains every key with its default. Restart the server after any change.

## `llm`: the chat model

| Key           | Default        | Meaning                                                                                                                                                                                                                        |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`    | `"ollama"`     | `ollama`, `openai` (any OpenAI-compatible API), `anthropic`, `gemini` or `mock`. See [Providers](providers.md).                                                                                                                |
| `baseUrl`     | `""`           | API endpoint. Empty means the provider's default: `http://127.0.0.1:11434`, `https://api.openai.com/v1`, `https://api.anthropic.com`, `https://generativelanguage.googleapis.com/v1beta`. OpenAI-compatible URLs end in `/v1`. |
| `model`       | `"qwen2.5:7b"` | Model name as the provider knows it. Must not be empty.                                                                                                                                                                        |
| `apiKey`      | `""`           | Literal API key. Prefer `apiKeyEnv`.                                                                                                                                                                                           |
| `apiKeyEnv`   | `""`           | Name of an environment variable holding the key, e.g. `"OPENAI_API_KEY"`. Used when `apiKey` is empty.                                                                                                                         |
| `temperature` | `0.7`          | Sampling temperature, 0–2.                                                                                                                                                                                                     |
| `maxTokens`   | `512`          | Maximum tokens per reply.                                                                                                                                                                                                      |
| `timeoutMs`   | `120000`       | Timeout per call in milliseconds.                                                                                                                                                                                              |
| `concurrency` | `2`            | How many model calls run at once, 1–64.                                                                                                                                                                                        |
| `jsonMode`    | `true`         | Ask the provider for JSON output where supported. Turn off for OpenAI-compatible servers that reject `response_format`.                                                                                                        |
| `logFile`     | `""`           | If set, every prompt and reply is appended to this JSONL file (for debugging). API keys are never written.                                                                                                                     |

## `embeddings`: memory recall

| Key           | Default              | Meaning                                                                                                                                 |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`    | `"auto"`             | `auto` (same as `llm.provider`; `none` when that is `anthropic`), `ollama`, `openai`, `gemini`, `mock` or `none` (keyword recall only). |
| `baseUrl`     | `""`                 | Endpoint for embeddings. Empty means the embeddings provider's default.                                                                 |
| `model`       | `"nomic-embed-text"` | Embedding model name. Change it for OpenAI or Gemini (for example `text-embedding-3-small`, `text-embedding-004`).                      |
| `apiKey`      | `""`                 | Literal key for embeddings.                                                                                                             |
| `apiKeyEnv`   | `""`                 | Environment variable holding the embeddings key.                                                                                        |
| `concurrency` | `1`                  | Parallel embedding requests, 1–16.                                                                                                      |

## `sim`: the simulation

| Key                    | Default   | Meaning                                                                                                                       |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `villagers`            | `10`      | Number of villagers, 1–20: the first N profiles in `data/villagers.json`, which ships 16. Strangers count toward a cap of 20. |
| `dayLengthMinutes`     | `15`      | Real minutes for one 24-hour game day at 1×.                                                                                  |
| `startTime`            | `"06:00"` | Game clock at the start of a new village (`HH:MM`).                                                                           |
| `speed`                | `1`       | Starting speed. The UI offers 0 (pause), 1, 2, 4 and 8.                                                                       |
| `nightSpeedMultiplier` | `6`       | Extra speed-up while every villager is asleep (at least 1).                                                                   |
| `tickMs`               | `100`     | Real milliseconds between simulation steps (at least 10).                                                                     |
| `seed`                 | `42`      | Random seed. The same seed and the mock provider give the same day.                                                           |

## `cognition`: how villagers think

| Key                    | Default                                             | Meaning                                                                                                                 |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `retrievalK`           | `8`                                                 | How many memories go into a prompt.                                                                                     |
| `retrievalWeights`     | `{ "recency": 1, "importance": 1, "relevance": 1 }` | Weights of the three parts of the memory score (each at least 0).                                                       |
| `importanceMode`       | `"llm"`                                             | `llm`: the model rates how important each memory is (in batches). `heuristic`: a fixed score per memory kind, no calls. |
| `reflectionThreshold`  | `60`                                                | Summed importance of new memories that triggers a reflection.                                                           |
| `reflectionMode`       | `"single"`                                          | `single`: one call per reflection. `two-step`: questions first, then insights (as in the paper; more calls).            |
| `maxConversationTurns` | `6`                                                 | Maximum lines in a villager conversation, 2–20.                                                                         |
| `pairCooldownMinutes`  | `120`                                               | Game minutes before the same two villagers chat again.                                                                  |

## `events`: village events

| Key                  | Default | Meaning                                                                 |
| -------------------- | ------- | ----------------------------------------------------------------------- |
| `ensureDaily`        | `true`  | If nobody has proposed an event by 10:00, ask the best-suited villager. |
| `maxProposalsPerDay` | `2`     | Maximum event proposals per day.                                        |

## `server`

| Key    | Default       | Meaning                                                                                         |
| ------ | ------------- | ----------------------------------------------------------------------------------------------- |
| `host` | `"127.0.0.1"` | Address to listen on. `0.0.0.0` makes the game reachable from your network (there is no login). |
| `port` | `3000`        | HTTP and WebSocket port, 0–65535 (0 picks a free port).                                         |

## `persistence`: saving

| Key                   | Default     | Meaning                                                                                               |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `dir`                 | `"./saves"` | Folder for save slots.                                                                                |
| `slot`                | `"default"` | Save slot name (letters, digits, `_` and `-`). Files go to `<dir>/<slot>/`.                           |
| `loadOnStart`         | `true`      | Load the slot on startup if it exists. `npm start -- --new` ignores it (the next save overwrites it). |
| `autosaveGameMinutes` | `60`        | Autosave interval in game minutes. `0` turns autosave off.                                            |

## `needs`

| Key            | Default                                               | Meaning                                              |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `enabled`      | `true`                                                | Villagers have hunger, energy, social and fun.       |
| `decayPerHour` | `{ "hunger": 6, "energy": 4, "social": 5, "fun": 4 }` | Points lost per game hour (needs run from 0 to 100). |

## `player`

| Key          | Default | Meaning                                                  |
| ------------ | ------- | -------------------------------------------------------- |
| `name`       | `"You"` | Your name in the village (1–24 characters).              |
| `petName`    | `"Pip"` | Your pet's starting name (1–24 characters).              |
| `petSpecies` | `"cat"` | Your pet's species, used in what villagers say about it. |

## `economy`

| Key                      | Default | Meaning                                                |
| ------------------------ | ------- | ------------------------------------------------------ |
| `startGold`              | `50`    | Gold at the start of a new village.                    |
| `eventReward`            | `10`    | Gold for attending at least half of a village event.   |
| `taskReward`             | `12`    | Gold when a villager finishes something you asked for. |
| `itemRespawnGameMinutes` | `180`   | How often picked items grow back, in game minutes.     |

## `world`

| Key             | Default | Meaning                                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------------------------- |
| `randomWeather` | `false` | Rain may start on its own during the day (about a 6 % chance per game hour, 07:00–19:00). |
| `llmStrangers`  | `false` | The model invents each stranger. Off: strangers come from `data/strangers.json`.          |

## `debug`

| Key     | Default | Meaning                                                                                                     |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `debug` | `false` | Enables debug commands over the WebSocket (`debug.inject` a memory, `debug.jump` the clock) and debug logs. |

## Environment variables

| Variable                 | Sets                                      |
| ------------------------ | ----------------------------------------- |
| `TPP_CONFIG`             | Path of the config file                   |
| `TPP_LLM_PROVIDER`       | `llm.provider`                            |
| `TPP_LLM_MODEL`          | `llm.model`                               |
| `TPP_LLM_BASE_URL`       | `llm.baseUrl`                             |
| `TPP_LLM_API_KEY`        | `llm.apiKey`                              |
| `TPP_EMBED_PROVIDER`     | `embeddings.provider`                     |
| `TPP_EMBED_MODEL`        | `embeddings.model`                        |
| `TPP_EMBED_BASE_URL`     | `embeddings.baseUrl`                      |
| `TPP_EMBED_API_KEY`      | `embeddings.apiKey`                       |
| `TPP_PORT`               | `server.port`                             |
| `TPP_DAY_LENGTH_MINUTES` | `sim.dayLengthMinutes`                    |
| `TPP_VILLAGERS`          | `sim.villagers`                           |
| `TPP_DEBUG`              | `debug` (`1`, `true` or `yes` turn it on) |

Empty variables are ignored. Any other variable can hold an API key and be referenced with
`llm.apiKeyEnv` / `embeddings.apiKeyEnv`; the usual names are `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`.

## Data files

The village itself is described by JSON files in `data/` and `assets/`. Edit them to change the
village; restart and start a new village (`--new`) to see the changes.

| File                    | Contents                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `data/villagers.json`   | Villager profiles: name, age, occupation, bio, traits, home, sprite, wake and sleep times, likes. |
| `data/map/village.json` | The tile map, locations, doors and scenes.                                                        |
| `data/items.json`       | Items you can pick up and give away.                                                              |
| `data/decorations.json` | Decorations for your cottage, with their cost and slot.                                           |
| `data/strangers.json`   | Travellers for the Stranger event, each with a piece of news.                                     |
