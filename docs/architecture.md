# Architecture

How Tiny Pixel People is built. The binding design is the [technical spec](spec/technical-spec.md);
this page describes the code as it is.

## Overview

```
 Browser (src/client)                          Node.js server (src/server)
 ┌────────────────────────┐   WebSocket /ws   ┌───────────────────────────────────────────────┐
 │ canvas renderer         │◄── state/events ──┤ net/      HTTP (static client + /api/*) + WS  │
 │ HUD, inspector, modals  │─── commands ─────►│ sim/      clock, tick loop, map, A*, movement, │
 │ toolbar, dock, rumors   │                   │           perception, needs, conversations,   │
 └────────────────────────┘   HTTP GET /       │           event attendance                    │
                               (dist/client)   │ cognition/ one VillagerMind per villager:     │
                                               │           memory, retrieval, reflection,      │
                                               │           planning, dialogue, gossip, events, │
                                               │           door notes, nightly summary         │
                                               │ player/   avatar, gold, backpack, pet, decor, │
                                               │           rumors, weather, world events       │
                                               │ llm/      LlmQueue + providers (ollama,       │
                                               │           openai, anthropic, gemini, mock)    │
                                               │ persistence/ JSON save slots + replay log     │
                                               │ config.ts zod schema, file + env              │
                                               └───────────────────────────────────────────────┘
```

The server is authoritative: it owns the world, the clock and every villager. The browser only
draws what the server sends and sends back player commands.

**The one rule:** the simulation loop is synchronous and never waits for a language model. Minds
put jobs on the LLM queue and apply the results on a later tick. Until a result arrives, a villager
keeps doing what it was doing or follows a deterministic fallback. Every LLM-driven decision has
such a fallback, so the town keeps moving even with no model at all.

## Source layout

| Path                      | Contents                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/`             | `types.ts` (world, villagers, memories, player), `protocol.ts` (WebSocket messages), `time.ts` (game clock). Imported by server and client. |
| `src/server/main.ts`      | Entry point: loads `.env` and config, creates providers, runs the health check, builds the engine, starts the server, saves on shutdown.    |
| `src/server/config.ts`    | Config schema, defaults, file + environment loading, key resolution, redaction.                                                             |
| `src/server/llm/`         | Provider interfaces, `createProviders`, the four providers plus `mock`, the job queue, JSON parsing.                                        |
| `src/server/sim/`         | The engine: clock, map, pathfinding, movement, perception, needs, conversation scheduling.                                                  |
| `src/server/cognition/`   | `VillagerMind` and everything a villager thinks: memory stream, retrieval, prompts.                                                         |
| `src/server/player/`      | The player world: avatar, economy, inventory, decorations, pet, rumors, weather, world events, strangers.                                   |
| `src/server/persistence/` | JSON save store, autosave, replay log, migrations.                                                                                          |
| `src/server/net/`         | HTTP and WebSocket server.                                                                                                                  |
| `src/client/`             | Canvas renderer (`render/`) and HTML/CSS UI (`ui/`).                                                                                        |
| `data/`                   | Villagers, map, items, decorations, strangers.                                                                                              |
| `assets/`                 | Generated pixel art (`scripts/art/`), fonts, `CREDITS.md`.                                                                                  |
| `test/`, `scripts/`       | Unit and acceptance tests, the live acceptance script, art generation.                                                                      |

## Time and the loop

- Game time is one number, `GameMinutes`: minutes since day 0, 00:00. `day = floor(t / 1440)`.
- `sim.dayLengthMinutes` (default 15) real minutes make one game day at 1×, so 1.6 game minutes
  pass per real second. Speeds are 0, 1, 2, 4 and 8; while every villager sleeps, the clock also
  runs `sim.nightSpeedMultiplier` (6) times faster.
- Every `sim.tickMs` (100 ms) the engine advances the clock, asks every mind for an intent
  (`goto`, `act`, `sleep`, `talk`, `wait`), moves villagers along A* paths, runs perception,
  starts conversations between nearby villagers, tracks event attendance, updates the player world
  and broadcasts a `tick` with the villagers that changed.
- **Wake-up hold.** The first time each day reaches 06:00, the engine keeps stepping with no game
  time passing until every non-transient villager's day plan is settled, the LLM queue is idle
  (after a 1.5 s grace), the queue reports the model offline, or `sim.wakeUpTimeoutSec` (300) real
  seconds have passed (`0` disables the hold). It broadcasts `sim.status` with `phase: "wakingUp"`,
  `plansReady` and `villagers` while holding (again every stats interval, for late clients) and
  `phase: "running"` at the end; a timeout logs `wake-up: only N/M plans ready, starting the day
anyway`. The client shows a non-blocking banner during the hold.
- Tests use a virtual clock instead: the engine is stepped in fixed game-minute increments and the
  LLM queue is drained between steps, so a full day with the mock provider runs in seconds and is
  deterministic for a given `sim.seed`.

## World

The map is a 48×30 grid of 16 px tiles with `ground`, `decor` and `overhead` layers, a collision
grid and named locations: the plaza (`square`) with its fountain, the bakery/café, the shop, the
farm, the park, eleven houses and the player's cottage (`player_home`). Each location has an
`area`, an `entry` tile, optional `door` and `spots` to stand at. `scenes` are camera presets for
the Map modal; `itemSpawns` say where forageable items grow. The art and map are generated by
`npm run art` (see [docs/art](art/README.md)).

## Villagers and cognition

Each villager has a profile (`data/villagers.json`: bio, traits, home, sprite, wake/sleep times,
likes, starting relationships) and a state (position, status, activity, needs, plan,
relationships). The engine owns the body; the `VillagerMind` owns the decisions. The design follows
_Generative Agents_ (Park et al., 2023), scaled down to small local models:

- **Memory stream.** Timestamped memories of kind `observation`, `conversation`, `heard`,
  `reflection`, `plan`, `note`, `event` or `summary`, each with an importance of 1–10. Trivial
  observations get a fixed score; others are rated by the model in batches (or by a heuristic,
  `cognition.importanceMode`).
- **Retrieval.** Score = recency + importance + relevance, each normalised to 0–1 and weighted by
  `cognition.retrievalWeights`. Recency decays by 0.995 per game hour since last access. Relevance
  is cosine similarity of embeddings, or a keyword score when embeddings are off or missing. The
  top `cognition.retrievalK` memories go into the prompt.
- **Reflection.** When the summed importance of new memories reaches
  `cognition.reflectionThreshold`, the villager writes 2–3 insights citing the memories behind
  them.
- **Planning.** For each day (prepared in the evening, otherwise at wake-up) the model writes a day plan of 5–8 blocks (time, place, activity,
  emoji), taking needs, memories, invitations and the weather into account. The plan is validated
  and repaired (unknown places mapped, gaps filled, overlaps clipped). An answer that can't be used is
  asked for once more at once; after that the villager keeps a fallback plan. A plan prepared while
  the villager is asleep is applied right away, so the engine's 06:00 wake-up hold (see
  [Time and the loop](#time-and-the-loop)) can see it through `isPlanSettled(day)`. Important news
  triggers a rate-limited revision of the rest of the day. Accepted events and player requests are inserted
  deterministically.
- **Needs.** Hunger, energy, social and fun decay per game hour and are restored by matching
  activities. A need below 20 makes the mind insert a short block to fix it, without a model call.
- **Conversation.** Two awake, idle villagers near each other may start a conversation, with
  cooldowns per pair and per villager. Turns alternate, up to `cognition.maxConversationTurns`,
  then one summary call stores a conversation memory, learned facts and an affinity change for
  both.
- **Gossip.** Each memory carries an `originId`. A speaker is offered "news you might share" that
  the listener hasn't heard from it yet; facts the listener learns keep the original `originId`
  and record who they came from. This is how gossip and rumors are traced.
- **Events.** Villagers propose events in their day plan or on request; at least one per day with
  `events.ensureDaily` (asked from 07:00 until 15:00). The proposal call never expires in the queue; if nothing has
  come back by 13:00 (at least an hour after asking), a default event is created. Invitees decide with a model call; accepting inserts a plan block.
  Attendance counts villagers inside the area for at least half the window.
- **Door notes.** A note waits on the door until the owner next arrives home awake, becomes an
  importance-8 memory, and gets a reply that refers to its content.
- **Next day.** In the last 90 minutes before bedtime (unless overloaded) and again overnight, the
  villager asks for tomorrow's plan. While asleep: a day summary and pruning of old trivial
  observations from retrieval.
- **Load levels** (`cognition/llm.ts`, `LoadTracker`). Per queue, cognition tracks a smoothed lag
  in game minutes from asking to answer (raised by the oldest call still waiting; it halves per
  idle game hour). Below 12 the level is `normal`, from 12 `busy`, from 35 `overloaded`. Busy:
  conversations of at most 4 turns with a 20-minute deadline per line and no repair round, fewer
  conversations without news, and no LLM importance ratings, plan revisions (replaced by a 45-minute
  "share the news" block at a social place), reflections, conversation summaries or day summaries.
  Overloaded additionally: only conversations that carry news, at most 3 turns of canned lines
  (which still pass on and echo the news), except that each speaker's first line with news still
  gets one model attempt (priority 104, 45-minute deadline). Under load, news the model leaves out
  of that line is appended as `Did you hear? …` (and the line counts as `fallback`). Overloaded also uses heuristic RSVPs and skips evening
  planning. Calls with a
  deadline are aborted when the game clock passes it, and the fallback is used.

## The player world

`src/server/player/` is a self-contained module behind a small host interface. The engine calls
`update(dt)` every step and routes the `player.*`, `world.trigger`, `decor.toggle` and
`pet.command` commands to it.

- The **avatar** walks at 2 tiles per game minute along A* paths and walks up to villagers before
  talking. Villagers perceive it like anyone else.
- **Say / ask / gift** ask the villager's mind for a reply (`player.reply`, highest queue
  priority). An accepted request becomes a plan block tagged with a `taskId`; finishing it pays
  `economy.taskReward`.
- **Rumors** are started by `player.rumor`, by door notes when read, and by `debug.inject`. When a
  villager learns a fact whose `originId` belongs to a rumor, a hop is added and the listener joins
  `knownBy`.
- **Weather and world events**: rain swaps outdoor plan blocks (public and nature locations) to the
  nearest shop or the villager's home and restores them afterwards; party and birthday create
  village events; strangers are transient villagers from `data/strangers.json` (or the model with
  `world.llmStrangers`) who leave at 22:00.
- **Economy**: gold, event and task rewards, the backpack, item spawns (`itemSpawns` on the map,
  respawning every `economy.itemRespawnGameMinutes`) and gifts that change affinity.
- **Pet** movement is deterministic (3 tiles per game minute, follows within 2 tiles).
- **Decorations** cost gold once and occupy one of ten slots at the cottage; villagers within 4
  tiles notice new ones.

## LLM layer

- `createProviders(config)` returns a chat provider and an optional embeddings provider. All
  providers use the global `fetch`, no SDKs:

  | Provider    | Chat                                   | Embeddings                                | JSON mode                           |
  | ----------- | -------------------------------------- | ----------------------------------------- | ----------------------------------- |
  | `ollama`    | `POST /api/chat`                       | `POST /api/embed`                         | `format: "json"`                    |
  | `openai`    | `POST {baseUrl}/chat/completions`      | `POST {baseUrl}/embeddings`               | `response_format` if `llm.jsonMode` |
  | `anthropic` | `POST /v1/messages`                    | –                                         | prompt only                         |
  | `gemini`    | `POST /models/{model}:generateContent` | `POST /models/{model}:batchEmbedContents` | `responseMimeType`                  |
  | `mock`      | rule-based per task                    | hashed bag-of-words vectors               | always                              |

- Every call names a **task** (`plan.day`, `convo.turn`, `note.reply`, `player.reply`, …). The
  **LlmQueue** runs at most `llm.concurrency` calls at once (default 1 for `ollama`, 2 otherwise;
  the engine also caps simultaneous villager conversations at this number), ordered by priority. The defaults are in `TASK_PRIORITY` (`llm/types.ts`); cognition overrides
  some (`PRIORITY` in `cognition/mind.ts`). The resulting order is: player replies (110), note
  replies (108), today's plan (105), a speaker's first line with news (104), the event proposal
  (101), conversation turns (100), RSVPs (92),
  plan retries (90), player task requests (85), tomorrow's plan and plan revisions (70),
  conversation summaries (60), importance ratings (30), reflections and day summaries (20). Waiting jobs gain +1 priority per 2 s of real
  waiting (at most +50). Duplicate jobs are coalesced. Jobs whose `expiresAt` game time has passed
  before they start are dropped; without an explicit `expiresAt`, background tasks get a default
  lifetime (`DEFAULT_TASK_TTL_MINUTES` in `queue.ts`, e.g. 30 game minutes for `convo.turn`, 360
  for `plan.day`), while player-facing tasks and the event proposal never expire. At most 64 jobs wait; beyond that the
  lowest-priority one is dropped. Retryable errors (408, 409, 429, 5xx, network) are retried twice
  with jittered exponential backoff from 500 ms, honouring `retry-after` up to 30 s; timeouts are
  not retried. Errors are `LlmError`s of kind `network`, `http`, `timeout`, `parse`,
  `config`, `expired` (dropped before it started) or `aborted` (cancelled by the caller).
  Embeddings run in their own lane (batches of up to 16 texts, `embeddings.concurrency` in
  parallel); a permanent embeddings error (unknown model, bad key) switches retrieval to keywords
  for the rest of the run. With `llm.logFile` set, each call is appended as one JSONL line.
- Missing API keys fall back to the conventional variables (`ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENAI_API_KEY` only for `api.openai.com`). An
  `embeddings.model` left at `nomic-embed-text` becomes `gemini-embedding-001` for Gemini and
  `text-embedding-3-small` for `api.openai.com`.
- The OpenAI-compatible provider adapts once to servers that reject `response_format`,
  `max_tokens` (switches to `max_completion_tokens`) or `temperature`, and remembers it.
- Structured output is parsed tolerantly (code fences stripped, first JSON object taken),
  validated with zod, retried once with a repair prompt, and otherwise replaced by the caller's
  fallback.
- **Provenance.** Model-driven results carry `source: 'llm' | 'fallback'` (`Provenance` in
  `src/shared/types.ts`): day plans (`DayPlan.source`), conversation lines
  (`ConversationMessage.source`, also on `conversation.message`), village events
  (`VillageEvent.source`) and door-note replies (`DoorNote.replySource`). `llm` means a model
  answer was parsed and used; anything canned or rule-based is `fallback`.
  The inspector shows `· fallback` on such plans, and the live acceptance script uses the tags.
  Cognition also counts model and fallback answers per task (`fallbackStats` in `cognition/llm.ts`,
  per queue, from server start) and, once per game day when the first villager is asleep, sends
  them as a WebSocket `log` message: `LLM use so far (model / fallback): <task> <llm>/<fallback>, …`.
- At startup `checkLlmHealth` checks the chat and embedding providers (Ollama: `GET /api/tags` and
  is the model pulled; OpenAI-compatible: `GET /models`; Anthropic and Gemini: look up the model)
  and logs one line for each. A failure doesn't stop the server: it seeds the queue's online flag
  (the UI shows the model as unreachable and villagers use fallbacks), and a failed embeddings
  check switches retrieval to keywords. After that the online flag follows the calls: network
  errors, timeouts and 401/403 set it to offline, any success sets it back.
- With 10 villagers a game day costs roughly 200 calls plus player chats.

## Protocol

One WebSocket at `/ws`, JSON text frames with a `type` field (`PROTOCOL_VERSION = 1`, types in
`src/shared/protocol.ts`).

- **Server → client:** `hello` (map, villagers, snapshot, LLM info) on connect, `tick` (time,
  speed, changed villagers), `conversation.message`, `conversation.ended`, `note.updated`,
  `event.updated`, `inspect.data`, `stats` (queue statistics, LLM online), `player.updated`,
  `rumor.updated`, `world.event`, `weather.updated`, `items.updated`, `villagers.changed`,
  `sim.status` (wake-up hold), `toast`, `log`, `error`.
- **Client → server:** `inspect`, `speed`, `note.post`, `save`, `player.move`, `player.say`,
  `player.rumor`, `player.pairTalk`, `player.gift`, `world.trigger`, `decor.toggle`,
  `pet.command`, and with `debug: true` also `debug.inject` and `debug.jump`. Any command may carry
  a `requestId`, echoed in an `error` reply.

HTTP endpoints: `GET /` (the built client), `GET /api/health`, `GET /api/state` (JSON snapshot),
`GET /api/conversations?since=`, `GET /api/rumors`, `GET /api/catalog` (items and decorations for
the UI), `GET /api/replay` (download `replay.jsonl`, 404 until the first save). Other `/api/*` paths
return 404; every other path serves the client.

## Persistence

`JsonSaveStore` writes one slot to `<persistence.dir>/<persistence.slot>/`:

- `world.json`: time, RNG state, villager states, mind bookkeeping, events, notes, recent
  conversations, player, rumors, world events, weather, ground items, strangers, and a
  `schemaVersion` used for migrations.
- `memories/<villagerId>.json`: each villager's memories, embeddings stored as base64 Float32.
- `replay.jsonl`: an append-only log of conversation, event, rumor, note and world messages.

Every file is written to a temporary file and renamed; `world.json` is written last. The game
autosaves every `persistence.autosaveGameMinutes`, on `save` and on SIGINT/SIGTERM, and loads the
slot on startup unless `--new` is given.

## Client

The browser client is plain TypeScript bundled by Vite. A canvas draws the tile layers, sprites
sorted by y, the overhead layer, bubbles and name tags with nearest-neighbour scaling at integer
zoom, plus day/night tint, lamp glows, rain and confetti. The HUD, stats card, LLM card, toolbar,
dock, inspector, rumor tracker, modals and toasts are HTML/CSS on top. Fonts (Departure Mono,
Silkscreen) are bundled, so the client loads nothing from the internet. The look follows the
[visual style guide](spec/visual-style-guide.md).

## Testing

`npm test` runs unit and acceptance tests with the `mock` provider and the virtual clock; no
network. `npm run test:live` runs the same checks against the real provider in your config. See
[Acceptance tests](acceptance.md).
