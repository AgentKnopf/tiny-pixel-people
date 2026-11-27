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

`config.example.json` lists the main keys with their defaults; sections it leaves out (the v2
ones such as `zoo` or `post`) keep their defaults too. It leaves out `llm.concurrency`, so the
provider's default applies (1 for Ollama, 2 for the others). Restart the server after any change.
Config files from v1 keep working: every v2 section has defaults. The one changed default is
`sim.villagers` (10 → 12).

## `llm`: the chat model

| Key               | Default        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | `"ollama"`     | `ollama`, `openai` (any OpenAI-compatible API), `anthropic`, `gemini` or `mock`. See [Providers](providers.md).                                                                                                                                                                                                                                                                                                  |
| `baseUrl`         | `""`           | API endpoint. Empty means the provider's default: `http://127.0.0.1:11434`, `https://api.openai.com/v1`, `https://api.anthropic.com`, `https://generativelanguage.googleapis.com/v1beta`. OpenAI-compatible URLs end in `/v1`.                                                                                                                                                                                   |
| `model`           | `"qwen2.5:7b"` | Model name as the provider knows it. Must not be empty.                                                                                                                                                                                                                                                                                                                                                          |
| `apiKey`          | `""`           | Literal API key. Prefer `apiKeyEnv`.                                                                                                                                                                                                                                                                                                                                                                             |
| `apiKeyEnv`       | `""`           | Name of an environment variable holding the key, e.g. `"OPENROUTER_API_KEY"`. Used when `apiKey` is empty. If both are empty, the provider's usual variable is used (see [API keys](providers.md#api-keys)).                                                                                                                                                                                                     |
| `temperature`     | `0.7`          | Sampling temperature, 0–2.                                                                                                                                                                                                                                                                                                                                                                                       |
| `maxTokens`       | `512`          | Maximum tokens per reply.                                                                                                                                                                                                                                                                                                                                                                                        |
| `timeoutMs`       | `120000`       | Timeout per call attempt in milliseconds. The startup health check uses at most 10 seconds.                                                                                                                                                                                                                                                                                                                      |
| `concurrency`     | `1` / `2`      | How many model calls run at once, 1–64. Default: 1 for `ollama`, 2 for other providers; an explicit value always wins. It also caps how many villager conversations run at the same time.                                                                                                                                                                                                                        |
| `jsonMode`        | `true`         | Use the provider's JSON output mode (`format` for Ollama, `response_format` for OpenAI-compatible, `responseMimeType` for Gemini). Anthropic has none. Turn off for servers that reject it.                                                                                                                                                                                                                      |
| `think`           | unset          | Thinking on reasoning models (Qwen 3, Gemma 4, Inkling and others). Unset: the provider's default, and nothing is sent. `false` turns thinking off, which makes day plans much faster with the same quality (see [Performance](performance.md#reasoning-models-turn-thinking-off)). Ollama gets `"think"`; OpenAI-compatible servers get `reasoning_effort` while it is `false`. Anthropic and Gemini ignore it. |
| `reasoningEffort` | `"none"`       | The `reasoning_effort` value the `openai` provider sends while `think` is `false`. `""` sends no field. If the server rejects the field, the game drops it for the rest of the run and logs one warning.                                                                                                                                                                                                         |
| `logFile`         | `""`           | If set, every prompt and reply (or error) is appended to this JSONL file, one line per call with time, task, model and latency. For debugging; API keys are never written.                                                                                                                                                                                                                                       |

## `embeddings`: memory recall

| Key           | Default              | Meaning                                                                                                                                 |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`    | `"auto"`             | `auto` (same as `llm.provider`; `none` when that is `anthropic`), `ollama`, `openai`, `gemini`, `mock` or `none` (keyword recall only). |
| `baseUrl`     | `""`                 | Endpoint for embeddings. Empty means the embeddings provider's default.                                                                 |
| `model`       | `"nomic-embed-text"` | Embedding model name. Left at this default, Gemini uses `gemini-embedding-001` and `api.openai.com` uses `text-embedding-3-small`.      |
| `apiKey`      | `""`                 | Literal key for embeddings.                                                                                                             |
| `apiKeyEnv`   | `""`                 | Environment variable holding the embeddings key. If no key is set, the chat key or the provider's usual variable is used.               |
| `concurrency` | `1`                  | Parallel embedding requests, 1–16.                                                                                                      |

## `sim`: the simulation

| Key                    | Default   | Meaning                                                                                                                                                                                                              |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `villagers`            | `12`      | Number of villagers, 1–20: the first N profiles in `data/villagers.json`, which ships 18. The first ten are the original villagers; 11 and 12 are Laude and Franzi. Strangers and visitors count toward a cap of 20. |
| `dayLengthMinutes`     | `15`      | Real minutes for one 24-hour game day at 1×.                                                                                                                                                                         |
| `startTime`            | `"06:00"` | Game clock at the start of a new village (`HH:MM`).                                                                                                                                                                  |
| `speed`                | `1`       | Starting speed. The UI offers 0 (pause), 1, 2, 4 and 8.                                                                                                                                                              |
| `nightSpeedMultiplier` | `6`       | Extra speed-up while every villager is asleep (at least 1).                                                                                                                                                          |
| `tickMs`               | `100`     | Real milliseconds between simulation steps (at least 10).                                                                                                                                                            |
| `seed`                 | `42`      | Random seed. The same seed and the mock provider give the same day.                                                                                                                                                  |
| `wakeUpTimeoutSec`     | `300`     | At 06:00 each day the clock waits until the villagers' plans are ready, at most this many real seconds. `0` turns the wait off.                                                                                      |

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
| `ensureDaily`        | `true`  | If nobody has proposed an event by 07:00, ask the best-suited villager. |
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
| `llmVisitors`   | `true`  | The model invents each train visitor. Off: visitors come from `data/visitors.json`.       |

## `zoo`

| Key         | Default   | Meaning                                                             |
| ----------- | --------- | ------------------------------------------------------------------- |
| `openTime`  | `"08:00"` | When the zoo, its enclosures and its rides open.                    |
| `closeTime` | `"21:00"` | When they close. Plan blocks at a closed place move to an open one. |

## `farm`

| Key              | Default   | Meaning                                                                                                      |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `enabled`        | `true`    | Cows, sheep and chickens with their lifecycle.                                                               |
| `capPerSpecies`  | `10`      | Most animals of one kind alive at a time, 1–10. It can be lowered but never raised above 10.                 |
| `breedChance`    | `0.5`     | Daily chance of a birth for a kind that can breed, 0–1.                                                      |
| `butcherTime`    | `"16:00"` | When at most one animal a day goes to the butcher (off-screen).                                              |
| `butcherAtCount` | `8`       | A kind with this many animals or more sends one to the butcher, 1–10. A low burger stock can trigger it too. |

## `train`

| Key            | Default              | Meaning                                            |
| -------------- | -------------------- | -------------------------------------------------- |
| `enabled`      | `true`               | Trains stop at the station.                        |
| `arrivals`     | `["10:00", "16:00"]` | Arrival times each day (at least one).             |
| `dwellMinutes` | `20`                 | Game minutes a train waits at the platform, 1–120. |

## `visitors`

| Key        | Default  | Meaning                                                                                      |
| ---------- | -------- | -------------------------------------------------------------------------------------------- |
| `enabled`  | `true`   | Trains bring visitors who stay at the hotel.                                                 |
| `min`      | `2`      | Fewest visitors in town once the first train has come, 0–10. Must be at most `max`.          |
| `max`      | `4`      | Most visitors at once, 0–10. Must be at most `hotel.rooms`. The total stays at 20 villagers. |
| `stayDays` | `[1, 3]` | Shortest and longest stay in game days (`[min, max]`, min ≤ max).                            |

## `hotel`

| Key     | Default | Meaning            |
| ------- | ------- | ------------------ |
| `rooms` | `6`     | Hotel rooms, 1–20. |

## `romance`

| Key              | Default | Meaning                                                                    |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `enabled`        | `true`  | Crushes, dates and couples.                                                |
| `minAge`         | `18`    | Youngest age that takes part (at least 18).                                |
| `crushAffinity`  | `6`     | Affinity (−10 to 10) a villager needs toward someone to develop a crush.   |
| `coupleAffinity` | `7`     | Affinity both need toward each other to become a couple.                   |
| `datesForCouple` | `2`     | Good dates before two villagers become a couple.                           |
| `shyMinDays`     | `5`     | A shy pair (Laude and Franzi) doesn't ask for a date before this game day. |
| `shyVisitChance` | `0.7`   | Daily chance that Franzi drops by the post office, 0–1.                    |
| `shyMaxTurns`    | `3`     | Longest conversation of a shy pair, 2–20 lines.                            |

## `interiors`

| Key             | Default | Meaning                                                                    |
| --------------- | ------- | -------------------------------------------------------------------------- |
| `visitAffinity` | `1`     | Affinity change when you visit an owner who is home and awake (−10 to 10). |
| `snoopAffinity` | `-2`    | Affinity change when the owner finds out you were inside while it was out. |

## `post`

| Key                        | Default              | Meaning                                                           |
| -------------------------- | -------------------- | ----------------------------------------------------------------- |
| `enabled`                  | `true`               | Post office, letters, notice board and the Keep.                  |
| `deliveryTimes`            | `["11:00", "17:00"]` | When posted letters are delivered (at least one time).            |
| `maxVillagerLettersPerDay` | `3`                  | Letters villagers write per day, for the whole village.           |
| `noticeTtlDays`            | `3`                  | Game days a notice stays on the board.                            |
| `maxNotices`               | `12`                 | Most notices on the board at once; a new one replaces the oldest. |
| `keepMax`                  | `2000`               | Entries the Keep holds, 1–5000; the oldest are dropped first.     |

## `forest`

| Key       | Default | Meaning                                   |
| --------- | ------- | ----------------------------------------- |
| `enabled` | `true`  | The forest animals and forest activities. |

## `observer`: read-only API for other programs

| Key           | Default       | Meaning                                                                                     |
| ------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `enabled`     | `true`        | Serve the [observer API](../observer-api.md).                                               |
| `port`        | `null`        | `null`: on the game server. A number: separate listener on that port (0 picks a free port). |
| `host`        | `"127.0.0.1"` | Address of the separate listener.                                                           |
| `allowRemote` | `false`       | Accept clients from other machines; only together with `token`.                             |
| `token`       | `""`          | Bearer token required on every observer request when set (`OBSERVER_TOKEN` overrides it).   |
| `logSize`     | `5000`        | Town log entries kept.                                                                      |

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
| `TPP_OBSERVER_PORT`      | `observer.port`                           |
| `OBSERVER_TOKEN`         | `observer.token`                          |

Empty variables are ignored. Any other variable can hold an API key and be referenced with
`llm.apiKeyEnv` / `embeddings.apiKeyEnv`, for example `OPENROUTER_API_KEY`. Without
`apiKey`/`apiKeyEnv`, the game reads `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` and
`OPENAI_API_KEY` (the last one only for `api.openai.com`) on its own.

## Data files

The village itself is described by JSON files in `data/` and `assets/`. Edit them to change the
village; restart and start a new village (`--new`) to see the changes.

| File                    | Contents                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `data/villagers.json`   | Villager profiles: name, age, occupation, bio, traits, home, sprite, wake and sleep times, likes.  |
| `data/map/village.json` | The tile map, locations, doors and scenes.                                                         |
| `data/items.json`       | Items you can pick up and give away.                                                               |
| `data/decorations.json` | Decorations for your cottage, with their cost and slot.                                            |
| `data/strangers.json`   | Travellers for the Stranger event, each with a piece of news.                                      |
| `data/visitors.json`    | Ready-made train visitors, used when the model doesn't invent one (or `world.llmVisitors` is off). |
| `data/romance.json`     | Romances that exist from the start (Laude and Franzi's shy crush).                                 |
| `data/zoo.json`         | Zoo animals per enclosure.                                                                         |
| `data/ambient.json`     | Forest animals and the crow.                                                                       |
