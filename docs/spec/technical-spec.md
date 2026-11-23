> Copy of the workstream spec `technical-spec.md`. The shared copy is the source of truth while the game is being built; this copy is updated with it.

# Tiny Pixel People — Technical Spec v1

Owner: architect agent (session 2708f211). Status: v1, binding for work packages unless changed by PR to this doc.
Source requirements: [`00-original-spec-and-decisions.md`](00-original-spec-and-decisions.md) (user spec + binding decisions).
Repo: https://github.com/AgentKnopf/tiny-pixel-people — all changes after the initial commit land via PRs into `main`.

## 1. Goals and constraints (summary)

- 2D top-down pixel village, 10–20 LLM-driven villagers (Generative Agents style).
- Node.js + TypeScript server (authoritative simulation) + browser canvas client. No AI Town fork, no Convex.
- LLM provider configurable by config only: `ollama`, `openai` (any OpenAI-compatible endpoint), `anthropic`, `gemini`, plus `mock` for tests.
- One command start (`npm install` once, then `npm start`). Fully offline with local Ollama.
- v1 also includes everything shown in the reference video (binding scope decision): rumor tracker, Map/Home scenes, toolbar world events (Rain, Party, Stranger, Birthday, Town event, Save replay), speed pause/1×/2×/4×/8×, villager needs bars, and a player avatar with gold, backpack, pet and home decorating (§7.10–§7.17). UI details follow [`visual-style-guide.md`](visual-style-guide.md).
- Movement and rendering never wait on the LLM. LLM calls go through a queue with concurrency N (default 2).
- Runtime: Node >= 22.12 (required by Vitest 5 / Vite 8; Node 20 is end-of-life). CI tests Node 22 and 24. No native modules (keeps `npm install` offline-friendly and cross-platform).

## 2. Prior art and what we take from it

| Source                                                   | What we borrow                                                                                                                                                                                                                                                                                                                                                                                                                               | What we change                                                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Park et al. 2023, _Generative Agents_ (arXiv 2304.03442) | Memory stream; retrieval score = recency + importance + relevance, each min-max normalised to [0,1]; importance 1–10 rated by LLM ("1 is purely mundane (brushing teeth), 10 is extremely poignant (a break up)"); reflection when summed importance of recent memories passes a threshold (paper: 150); reflection = salient questions → retrieve → insights with citations; top-down planning (day → hour → minutes); re-plan on reaction. | Small local models and a tight call budget: plan only at day + block level (no 5–15 min decomposition by LLM), batch importance rating, single-step reflection by default, cheap heuristics for trivial observations. |
| joonspk-research/generative_agents (`retrieve.py`)       | Recency decay 0.995 per step, weights `[recency 0.5, relevance 3, importance 2]` in their final code, `last_accessed` updated on retrieval, idle events excluded.                                                                                                                                                                                                                                                                            | Recency decays per _game hour since last access_ (time-based, not rank-based), default weights `recency 1, importance 1, relevance 1` configurable.                                                                   |
| a16z-infra/ai-town (`convex/constants.ts`)               | Conversation distance ~1.3 tiles, cooldown after a conversation, max ~8 messages per conversation, invite accept probability idea, activities with emoji, memory over-fetch then re-rank, vacuum old memories.                                                                                                                                                                                                                               | No Convex; single in-process engine; our own map/data format. Assets may be borrowed only if license is MIT/CC0/CC-BY and credited in `assets/CREDITS.md`.                                                            |

## 3. Architecture overview

```
 Browser (src/client)                         Node server (src/server)
 ┌───────────────────────┐   WebSocket /ws   ┌──────────────────────────────────────────────┐
 │ canvas renderer       │◄──── state/events ─┤ net/ (http static + ws hub)                 │
 │ inspector, notes UI   │──── commands ─────►│                                              │
 │ speed controls        │                    │ sim/ engine: clock, tick loop, world map,    │
 └───────────────────────┘   HTTP GET /       │      pathfinding, movement, perception,     │
                              (built client)  │      conversation scheduling, event bus     │
                                              │        │ VillagerMind.update(view) → Intent  │
                                              │        ▼                                     │
                                              │ cognition/ memory stream, retrieval,        │
                                              │      importance, reflection, planning,      │
                                              │      conversation turns, gossip, events,    │
                                              │      door notes, nightly summary, prompts   │
                                              │        │ enqueue(task)                       │
                                              │        ▼                                     │
                                              │ llm/ LlmQueue(concurrency N, priority)      │
                                              │      providers: ollama|openai|anthropic|    │
                                              │                 gemini|mock                 │
                                              │ persistence/ JSON save slots (atomic)       │
                                              │ config.ts  (zod schema, file + env)          │
                                              └──────────────────────────────────────────────┘
```

Key rule: **the sim loop is synchronous and never awaits an LLM call**. Cognition schedules jobs on the queue and applies results when they resolve (on a later tick). Until a result arrives, a villager keeps doing its current activity or a deterministic fallback.

## 4. Time and the simulation loop

- Game time is a single number `GameMinutes` = minutes since day 0, 00:00 (`day = floor(t/1440)`, `minuteOfDay = t % 1440`).
- `sim.dayLengthMinutes` (default 15): real minutes for one full 24h game day at 1×. `gameMinutesPerRealSecond = 1440 / (dayLengthMinutes*60)` (= 1.6 at default).
- Speed: `0` (pause), `1`, `2`, `4`, `8` (UI); engine accepts any positive number (tests use large values). At 8× with default day length a game day takes ~1.9 real minutes, so LLM results arrive "late" in game time; that is expected (fallbacks keep the town moving).
- Nights: villagers sleep 22:00–06:00 (per-villager `wakeTime`/`sleepTime` in profile). `sim.nightSpeedMultiplier` (default 6) speeds up the clock while _all_ villagers sleep. Nightly jobs (day summary, memory pruning, next day's plan) run then.
- Tick loop: `setInterval(sim.tickMs=100)` in real mode. Each tick: advance clock by `dt`, update minds (intent), path + move, perception, conversation proximity checks, event attendance, broadcast a `tick` delta (throttled to `server.broadcastMs=100`).
- **Virtual clock for tests**: `SimEngine.advance(gameMinutes, { drainLlm: true })` steps in fixed game-minute increments without real timers and awaits the LLM queue between steps (mock provider) so a full day runs in seconds, deterministically (seeded RNG `sim.seed`).

## 5. World and tile map

- File: `data/map/village.json` (hand-authored JSON; optionally exported from Tiled later). Default 48×30 tiles (agreed with the art package), `tileSize` 16 px (client scales 2–3×).
- Shape (type `WorldMap` in `src/shared/types.ts`): `width`, `height`, `tileSize`, `layers` (`ground`, `decor`, `overhead` as tile-index arrays into `tilesets`), `collision` (0/1 array), `locations[]`.
- `Location`: `id` (e.g. `bakery`, `square`, `park`, `cafe`, `house_ada`), `name`, `kind` (`house|shop|public|nature`), `area` rect (tiles), `entry` tile (where villagers path to), optional `door` tile (houses — clickable for notes), optional `ownerIds`, and `spots[]` (tiles to stand at for activities, so villagers don't stack).
- `scenes[]`: named camera presets `{ id, name, subtitle, rect }` (§7.17). `player_home` is a house location owned by `player` with `decorSlots[]` (tiles for decorations, §7.16). Ground item spawn areas: `itemSpawns[] { itemId, area }`.
- Pathfinding: A* on the collision grid (4-dir, octile optional), path cache per (from,to) pair; recompute on block. Villagers may overlap (no villager-villager collision in v1; small offset when sharing a spot).
- Villager roster: `data/villagers.json` — 10 default (up to 20) `VillagerProfile`s: name, age, occupation, 2–3 sentence bio, traits, `homeId`, sprite key, wake/sleep times, initial relationships (affinity -10..10), optional `seedMemories[]`. At least one villager (e.g. the baker) has a bio that makes hosting a bake-off likely; `sim.villagers` picks the first N.

## 6. Villager state

Types in `src/shared/types.ts` (`VillagerProfile`, `VillagerState`, `DayPlan`, `PlanBlock`, `Relationship`):

- Needs (sim-owned, §7.10): `needs { hunger, energy, social, fun }` 0–100.
- Physical (sim-owned): `pos` (float tiles), `facing`, `path`, `locationId | null`, `status` (`sleeping|walking|idle|acting|talking|attending`), `conversationId?`.
- Activity: `activity { text, emoji, locationId, since }` — shown in the bubble/inspector.
- Plan: `DayPlan { day, summary, blocks: PlanBlock[], revision, source: 'llm'|'fallback' }`, `PlanBlock { start, end (minuteOfDay), locationId, activity, emoji?, eventId? }`.
- Social: `relationships: Record<VillagerId, { affinity: -10..10, lastTalkedAt?, summary? }>`.
- Cognition bookkeeping (cognition-owned, persisted): `importanceSinceReflection`, `lastReflectionAt`, `lastPlanAt`.

Plan execution (sim): the current block → intent `goto(block.locationId)` then `act(block.activity)` at a free spot. If no plan yet: fallback plan built from profile (home → work location by occupation → square at lunch → home), `source: 'fallback'`.

## 7. Cognition

All in `src/server/cognition/`. One `VillagerMind` per villager implements:

```ts
interface VillagerMind {
  readonly id: VillagerId;
  update(view: WorldView): Intent; // sync, cheap, every sim step; may enqueue LLM jobs
  observe(obs: Observation): void; // perception, conversation, notes, events
  onArrive(view: WorldView, locationId: LocationId): void; // e.g. door notes at home
  wantsToTalkTo(view: WorldView, otherId: VillagerId): boolean;
  serialize(): MindSnapshot; // memories + bookkeeping (used by persistence)
}
```

`Intent = goto | act | sleep | talk | wait`. The engine owns physics; the mind owns decisions.

### 7.1 Memory stream

`Memory { id, villagerId, createdAt, lastAccessedAt, kind, text, importance (1–10), embedding?, keywords[], meta }`.
`kind`: `observation | conversation | heard | reflection | plan | note | event | summary`.
`meta`: `{ heardFrom?, originId? (root fact id for gossip tracing), toldTo?: VillagerId[], conversationId?, noteId?, eventId?, sourceIds? (reflection citations) }`.

- Observations are deduplicated: a new observation is stored only when the observed (subject, activity) changes, max one per subject per `cognition.observationCooldownMinutes` (default 30).
- Importance: `cognition.importanceMode = 'llm' | 'heuristic'` (default `llm`). Trivial perception ("X is walking") gets heuristic 2 without a call. Others are rated in **batches** (`importance.rate` task, up to 8 memories per call) and default to a kind-based heuristic until the rating arrives (note 8, heard 5, event 6, conversation 4, observation 2).
- Embeddings are computed asynchronously in batches (cheap queue lane). Missing embedding ⇒ keyword relevance for that memory.

### 7.2 Retrieval

`retrieve(mind, query, k = cognition.retrievalK (8))`:

- Candidates: all memories except `kind=plan` older than today.
- `recency = 0.995 ^ (gameHoursSince(lastAccessedAt))`, `importance = importance/10`, `relevance = cosine(embed(query), m.embedding)` or keyword score (token overlap, stopwords removed, lightly stemmed, BM25-lite) when embeddings are off/missing.
- Each component min-max normalised over candidates, `score = wR*rec + wI*imp + wV*rel` (`cognition.retrievalWeights`, default 1/1/1). Top-k, then `lastAccessedAt = now` for those returned.
- Query embeddings are cached (LRU) because prompts reuse focal points (partner name, location, note text).

### 7.3 Reflection

Trigger: `importanceSinceReflection >= cognition.reflectionThreshold` (default 60 — lower than the paper's 150 because we store far fewer observations), at most once per 3 game hours, never while talking.
Default single-step `reflect` task: the 20 most recent memories (numbered) → JSON `{ insights: [{ text, because: [indices] }] }` (2–3). Insights are stored as `reflection` memories, importance 7 (or rated), `meta.sourceIds`. `cognition.reflectionMode='two-step'` enables the paper's questions → retrieve → insights variant.

### 7.4 Planning

- **Day plan** (`plan.day`, at wake-up or during the night): input = bio, yesterday's summary, top memories for "my plans for today", known upcoming events and accepted invitations, list of location ids. Output JSON `{ summary, blocks: [{ start "HH:MM", end, location, activity, emoji }], proposeEvent?: { title, description, location, start "HH:MM", durationMinutes, invitees: [names] } }` with 5–8 blocks between wake and sleep. Validated with zod: unknown locations mapped to the closest known one or dropped; gaps filled with `idle at home`; overlaps clipped.
- **Block detail**: no extra LLM call by default; the block's activity text + emoji is the visible action. (`cognition.decomposeBlocks=true` would add hourly sub-activities later.)
- **Re-plan** (`plan.revise`): triggered by a high-importance memory (≥ 7) such as an accepted invitation, a door note, or an exciting heard fact; rewrites only blocks after `now`; rate-limited to one per 2 game hours per villager. Accepted events are inserted deterministically (no LLM needed) before any revise.
- Plans are cached in state (`DayPlan.revision`); a day plan for day d+1 may be prepared during the night.

### 7.5 Conversation

- Trigger (sim): two awake, non-busy villagers within `CONVERSATION_DISTANCE` (1.5 tiles) or in the same small location; pair cooldown `cognition.pairCooldownMinutes` (120); per-villager cooldown 30; both `wantsToTalkTo` (probability from affinity + "has news to share" bonus); global cap `cognition.maxConcurrentConversations` (default = llm.concurrency). Approaching: the initiator walks to the partner, both switch to `talking`.
- Turns: `convo.turn` task, alternating speakers, max `cognition.maxConversationTurns` (6). Prompt: speaker bio, relationship summary with partner, retrieved memories for the partner + location, **"news you might share"** (see 7.6), transcript so far. Output `{ say, end }`. Each message is broadcast immediately (speech bubble).
- Wrap-up: one `convo.summarize` call → `{ forA: { summary, learned: [{ text, importance }], affinityDelta }, forB: {...} }`; stored as `conversation` memory (summary) + `heard` memories (learned facts) for each participant; affinity updated (clamped).
- If the LLM is slow, the conversation simply lasts longer in game time; it is aborted after `maxConversationGameMinutes` (60) with the turns so far.

### 7.6 Gossip (information passing)

- Every memory carries `meta.originId` (its own id for first-hand facts). `heard` memories copy the `originId` of the fact they came from and set `heardFrom`.
- "News you might share" for speaker S talking to P = up to 3 memories of kind `note | heard | event | reflection` (or observations with importance ≥ 6) from the last 24 game hours, ranked by importance × recency, **excluding** memories whose `toldTo` already contains P or whose `heardFrom` is P. When S's message is generated with news in the prompt, those memories get `toldTo += P` (conservative: marked when the conversation ends).
- `convo.summarize` must extract learned facts; to make tracing robust it receives the news item ids that were offered and returns `learned[].fromNewsIndex?` so `originId` can be propagated.
- Gossip is verified by tracing `originId` across villagers (see §14, AC3).

### 7.7 Events

- Proposal: via `plan.day.proposeEvent` or a dedicated `event.propose` call (at most `events.maxProposalsPerDay`, default 2). If no event exists for today by 10:00, the most suitable host (bio keyword match, e.g. baker → bake-off) is prompted with `event.propose` (guarantees at least one proposal per day; `events.ensureDaily=true`).
- `VillageEvent { id, title, description, hostId, locationId, start, end, invitees, accepted, declined, attendees, status: proposed|scheduled|happening|done|cancelled }`.
- Invitations: host's invitees (or 4–6 villagers by affinity) receive an `event` memory ("Mia invited me to the Bake-off at the square at 15:00"); villagers also hear about it through conversations (gossip, can self-invite). Each invitee decides with `event.decide` → `{ accept, reason }` using plan + relationship with host + memories. Accept ⇒ deterministic block insertion into the plan (overrides conflicting block).
- Execution: at `start` attendees path to the location; status `happening` while host present; attendance = villagers inside `area` for ≥ 50 % of the window. At `end`, status `done`, every attendee gets an `event` memory (importance 6) with who attended. Broadcast `event.updated`.

### 7.8 Door notes

- Client: click a house door → modal → `note.post { houseId, text }` (max 500 chars). Server creates `DoorNote { id, houseId, ownerId, text, postedAt, status: 'unread' }`, broadcast `note.updated` (a note icon appears on the door).
- Owner reads it on the **next arrival at home** (`onArrive` with `locationId === homeId`, awake): status `read`, `note` memory importance 8 ("I found a note on my door from a stranger: '...'"), `meta.originId` = memory id (gossip-able), then `note.reply` task (prompt: bio, the note, retrieved memories for the note text) → `{ reply }`; must reference the note's content (prompt instructs quoting/addressing it). Status `replied`, `reply` shown on the door (hover/click) and in the inspector; broadcast `note.updated`. May trigger a re-plan.
- Multiple notes per door allowed; the owner processes them oldest first.

### 7.9 Nightly maintenance

While asleep: `day.summarize` (one call per villager → `summary` memory, importance 5), prune: observations older than 2 days with importance ≤ 3 are archived (kept in the save file but excluded from retrieval), and the next day's plan is prepared.

### 7.10 Needs

- Each villager has `needs { hunger, energy, social, fun }`, 0–100 (100 = satisfied), shown as bars in the inspector.
- Decay per game hour (`needs.decayPerHour`, defaults hunger 6, energy 4, social 5, fun 4); sleeping restores energy (+12/h) and costs a little hunger.
- Restored by activities, matched deterministically by location kind and activity keywords: eating at the cafe/bakery or home → hunger; conversation → social (+8 per conversation); events, park, plaza, hobbies → fun; sleeping/resting at home → energy. Table in `src/server/sim/needs.ts`.
- Cognition uses needs in two ways: (1) the current needs go into the `plan.day` / `plan.revise` prompt; (2) a deterministic **override**: when a need drops below 20 and the current block does not address it, the mind inserts a short block to fix it (e.g. "grab a bite at the cafe"). No LLM call needed.
- The inspector's `CURRENT THOUGHT` shows the latest thought: the speech-bubble text, or the current activity.

### 7.11 Player

The player has an avatar in the world (style guide §6, `★ name`). Type `PlayerState`.

- **Movement**: clicking empty ground → `player.move { to }` → server paths the avatar there (same A* as villagers). Villagers perceive the player like any villager ("<player> is walking by the farm"), so memories can be "about you".
- **Home**: the player owns `player_home` (purple cottage, bottom-left), a house location with a door, garden and decoration slots.
- **Say / ask** (inspector text field): `player.say { villagerId, text, mode: 'say' | 'ask' }`. The player avatar walks next to the villager if needed. The villager stops, stores a `conversation` memory (importance rated), and answers with the `player.reply` task (bio, relationship with the player, retrieved memories). The reply is broadcast as a bubble + `conversation.message` (speaker = villager, listener = `player`). `ask` ("Ask to do it") additionally runs `task.decide` → `{ accept, activity, location, time }`; accepted requests become a plan block tagged `taskId` (see 7.14 for the gold reward).
- **Tell as rumor** (`player.rumor { villagerId, text }`): the villager gets a `heard` memory (importance 7, `heardFrom: 'player'`) that starts a **rumor** (7.12). This is the main way to trigger AC3 from the UI.
- **Have them talk** (`player.pairTalk { aId, bId }`): asks the engine to start a conversation between two villagers now (ignores cooldowns, respects sleep). A walks to B.
- **Find them / Visit their home**: client-only camera pan; "Visit" also moves the player avatar to the villager's door and opens the door-note modal.
- The player id is the constant `PLAYER_ID = 'player'` and is valid in `heardFrom`, `toldTo`, relationships and conversation messages.

### 7.12 Rumors (gossip tracker)

- A `Rumor { id, originMemoryId, text, startedBy: 'player' | VillagerId, startedAt, knownBy: VillagerId[], hops: RumorHop[] }`, `RumorHop { from, to, at, text, conversationId }`.
- Created by `player.rumor`, by door notes and by `debug.inject`. Optionally villager-started: any `heard` memory with importance ≥ 7 that is not tied to a rumor.
- Tracking piggybacks on gossip (7.6): when `convo.summarize` returns a learned fact whose `originId` belongs to a rumor, the engine appends a hop (`from` = speaker who mentioned it, `to` = listener, `text` = the sentence in which it was said, else the learned fact text) and adds `to` to `knownBy`.
- Broadcast `rumor.updated`. The client shows the newest rumor in the rumor tracker panel: `🗣 RUMOR · n OF N VILLAGERS KNOW`, `You said: "…"`, then the hops `A → B "…"`. The panel can be dismissed and lists older rumors in a dropdown.

### 7.13 World events (toolbar buttons)

Player-triggered via `world.trigger { kind }`, kinds `rain | party | stranger | birthday | townEvent`. Each one creates a `WorldEvent { id, kind, startedAt, endsAt, data }` record, a toast and a `log`, and gives every awake villager within sight (or everyone, for town-wide kinds) an `event` memory:

- **Rain** (`weather.state = 'rain'`, 1–3 game hours, client draws rain): outdoor plan blocks get swapped for indoor ones (deterministic: public/nature → nearest shop or home) until it ends; villagers get a memory "It started raining" (importance 3). `weather.updated` is broadcast. Weather can also start randomly (`world.randomWeather`, default off).
- **Party**: creates a `VillageEvent` "Party at the plaza" starting in 30 game minutes, lasting 2 h, host = player, invitees = all awake villagers. Invitees go through the normal `event.decide` flow (7.7); confetti effect while `happening`.
- **Stranger**: spawns a transient visitor (`VillagerProfile` with `transient: true`) from a template list in `data/strangers.json` (or the `stranger.create` LLM task when `world.llmStrangers` is true). The stranger walks in from the map edge, has a mind with seed memories (a piece of news it carries, which villagers can gossip about), and leaves at the end of the day. The stranger counts toward the 20-villager cap.
- **Birthday**: picks a villager (or the inspected one), creates an `event` memory for everyone ("Today is Mia's birthday"), and creates a `VillageEvent` "Mia's birthday" at her home or the cafe at 17:00 with friends (affinity ≥ 2) invited.
- **Town event**: runs `event.propose` for the best-suited villager now (same as `events.ensureDaily`).
- **Save replay** (button): `save` command; the server writes the save slot plus `saves/<slot>/replay.jsonl` (an append-only log of all broadcast `conversation.*`, `event.*`, `rumor.*`, `note.*` and `world.*` messages with timestamps), and the client offers it as a download (`GET /api/replay`).

### 7.14 Economy: gold, backpack, tasks

Only the **player** has gold and a backpack. Villagers have no inventory in v1 (keeps the cognition budget small).

- Gold (`player.gold`, start `economy.startGold` = 50). Earned by:
  - Attending a community event (`VillageEvent` reaching `done` while the player avatar was in the event area for ≥ 50 % of the window): `+economy.eventReward` (10).
  - A villager finishing a task the player asked for ("Ask to do it", 7.11): when the tagged plan block completes, `+economy.taskReward` (12), plus an `event` memory for the villager ("I did what <player> asked: …") and affinity +1.
  - Selling items is not in v1.
- Backpack (`player.inventory: InventoryEntry[] { itemId, count }`): forageable items spawn on the map (flowers 🌸 in the park, berries 🫐 near trees, mushrooms 🍄 on the farm edge; `data/items.json`, respawn every `economy.itemRespawnGameMinutes`). The player picks one up by walking onto it (the server detects the overlap). Items can be **gifted** to a villager: `player.gift { villagerId, itemId }` → the item leaves the backpack, the villager gets a memory (importance 5), affinity +1 (+2 if the item matches a liked item in the profile, `likes: string[]`), and replies with `player.reply`. The top-right stats card shows gold and item counts (style guide §8.2).
- Every gold change and pickup is broadcast as `player.updated`.

### 7.15 Pet

- The player has one pet (`pet { name: 'Pip', species: 'cat', pos, mode: 'follow' | 'stay' }`, name from `player.petName`). The pet follows the player avatar at 1–2 tiles, wanders near the player when the player idles, and sits at home while the player is inside.
- The `Pet` dock tile opens a small panel: rename, toggle follow/stay, "Pet Pip" (a small heart emote).
- Villagers perceive the pet (observation "Pip the dog is playing near the fountain", importance 2–3), which gives the gossip and greetings seen in the reference ("Oh, Pip!", "Isn't Pip adorable?"). Movement is deterministic and needs no LLM.

### 7.16 Home decorating

- A decoration catalog in `data/decorations.json`: `DecorationItem { id, name, emoji, cost, sprite, slot }` (reference: welcome rug, porch cushion, flower vase, lanterns, flower pots, garden bench, string lights, mailbox, flag, bird bath). Slots are fixed tiles around `player_home`.
- Decorate modal (style guide §8.8): `decor.toggle { itemId }`. Buying costs gold once (`owned`), and clicking again puts it away or places it again for free. The server validates gold and broadcasts `player.updated` + a toast. Placed items render on the home scene, and villagers passing the player's home observe new decorations ("<player>'s cottage has new string lights", importance 3). That is how decorating feeds memories ("knows about you").
- Stretch (WP8): once the **mailbox** is placed, `player.reply` may return `leaveNote` and the villager later leaves a `DoorNote` for the player (`houseId = 'player_home'`, `ownerId = 'player'`, `authorId = villagerId`).

### 7.17 Scenes and camera (client)

- Scenes are named camera presets in `data/map/village.json` → `scenes: [{ id, name, subtitle, rect }]`: `plaza` (the whole town, the default), `farm`, `shop_street`, `park`, `home` (player's cottage). The Map modal lists them; the `Home` dock tile jumps to `home`. The camera eases to the scene rect at an integer zoom and follows it until the player pans or picks another scene. Purely client-side; the server only ships the presets in `hello.map`.

## 8. LLM layer

### 8.1 Interfaces (`src/server/llm/types.ts`)

```ts
type LlmTask =
  | 'importance.rate'
  | 'plan.day'
  | 'plan.revise'
  | 'convo.turn'
  | 'convo.summarize'
  | 'reflect'
  | 'reflect.questions'
  | 'event.propose'
  | 'event.decide'
  | 'note.reply'
  | 'day.summarize'
  | 'player.reply'
  | 'task.decide'
  | 'stranger.create'
  | 'health';
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
interface ChatRequest {
  task: LlmTask; // used by the queue (priority/stats) and by the mock provider
  messages: ChatMessage[];
  json?: boolean; // ask provider for JSON output where supported
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  meta?: Record<string, unknown>; // structured context for the mock provider + logs (never sent to providers)
}
interface ChatResponse {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
}
interface ChatProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  health(): Promise<HealthResult>;
}
interface EmbeddingProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
```

`createProviders(config)` → `{ chat: ChatProvider, embeddings: EmbeddingProvider | null }`. A `null` embeddings provider means keyword retrieval.

### 8.2 Provider wire formats (implemented with global `fetch`, no SDKs)

| Provider                                                                                                                                                   | Chat                                                                                                                                                                                                    | Embeddings                                                                                                                                                                                        | Auth                                                                                                                                      | JSON mode                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ollama` (default baseUrl `http://127.0.0.1:11434`)                                                                                                        | `POST /api/chat` `{ model, messages, stream:false, format?:"json", options:{ temperature, num_predict }, keep_alive:"30m" }` → `message.content`                                                        | `POST /api/embed` `{ model, input:[...] }` → `embeddings[][]`                                                                                                                                     | none                                                                                                                                      | `format:"json"`                                                   |
| `openai` (OpenAI-compatible; baseUrl includes `/v1`, default `https://api.openai.com/v1`; works with LM Studio, vLLM, llama.cpp server, OpenRouter, Groq…) | `POST {baseUrl}/chat/completions` `{ model, messages, temperature, max_tokens, response_format?:{type:"json_object"} }` → `choices[0].message.content`                                                  | `POST {baseUrl}/embeddings` `{ model, input }` → `data[].embedding`                                                                                                                               | `Authorization: Bearer <key>` (optional for local servers)                                                                                | `response_format` only if `llm.jsonMode` (some servers reject it) |
| `anthropic` (default `https://api.anthropic.com`)                                                                                                          | `POST /v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`; body `{ model, max_tokens (required), system, messages (user/assistant only, system lifted out) }` → concat `content[].text` | none (use another embeddings provider or keyword fallback)                                                                                                                                        | `x-api-key`                                                                                                                               | prompt-only + tolerant parser                                     |
| `gemini` (default `https://generativelanguage.googleapis.com/v1beta`)                                                                                      | `POST /models/{model}:generateContent`, header `x-goog-api-key`; body `{ contents:[{ role:"user"                                                                                                        | "model", parts:[{text}] }], systemInstruction:{ parts:[{text}] }, generationConfig:{ temperature, maxOutputTokens, responseMimeType?:"application/json" } }`→`candidates[0].content.parts[].text` | `POST /models/{model}:batchEmbedContents` `{ requests:[{ model:"models/{model}", content:{ parts:[{text}] } }] }` → `embeddings[].values` | `x-goog-api-key`                                                  | `responseMimeType` |
| `mock`                                                                                                                                                     | deterministic, rule-based per `task` using `meta` (see §13)                                                                                                                                             | deterministic hashed bag-of-words vectors (dim 64)                                                                                                                                                | –                                                                                                                                         | always JSON                                                       |

Errors: HTTP ≥ 400 or network errors → `LlmError { kind: 'network'|'http'|'timeout'|'parse', status?, retryable }`. Retry policy in the queue: 2 retries with backoff for retryable (429, 5xx, network), honour `retry-after`.

### 8.3 Structured output

`src/server/llm/json.ts`: `parseJsonLoose(text)` (strip code fences, take first balanced `{…}`/`[…]`, fix trailing commas) + `askJson(queue, req, zodSchema, fallback)`: validate with zod; on failure one repair retry (append assistant text + "Return only valid JSON matching: …"); then return `fallback` and log. Callers always supply a deterministic fallback so the sim never stalls.

### 8.4 Job queue (`src/server/llm/queue.ts`)

- `LlmQueue({ concurrency, timeoutMs })` with `enqueue(req, { priority, dedupeKey?, expiresAt? }) → Promise<ChatResponse>`; separate lane for embeddings (`embedConcurrency`, default 1, batched up to 16 texts).
- Priorities (high → low): `player.reply` (the player is waiting), `convo.turn`, `note.reply`, `task.decide`, `event.decide`, `plan.day`/`plan.revise`, `convo.summarize`, `reflect`, `event.propose`, `importance.rate`, `day.summarize`.
- Stale jobs are dropped (`expiresAt` in game time via a clock callback), duplicates coalesced by `dedupeKey` (e.g. `plan:ada:day3`).
- Stats (`queued`, `running`, `done`, `failed`, `avgLatencyMs` per task) exposed in `stats` WS message and logs.
- Optional `llm.logFile` writes JSONL of prompts/responses for debugging (off by default; never logs API keys).

### 8.5 Call budget (10 villagers, per game day, estimate)

plans 10 + revisions ~10 + conversations ~15 × (≤6 turns + 1 summary) ≈ 105 + importance batches ~30 + reflections ~15 + events ~12 + notes few + nightly 10 ≈ **~200 calls**, plus player-driven calls (`player.reply`, `task.decide`; highest priority, a few per minute at most). At ~3 s/call (7B model on Apple Silicon) and concurrency 2 this is ~300 s of LLM time inside a 900 s day. Knobs if a machine is slower: `dayLengthMinutes`, `maxConversationTurns`, `importanceMode=heuristic`, `reflectionThreshold`, conversation cooldowns.

## 9. Configuration

File `config.json` in the repo root (gitignored); `config.example.json` is committed and documented. `--config <path>` or `TPP_CONFIG` overrides the path. Missing file ⇒ defaults (Ollama on localhost). Load order: **defaults ← config file ← environment variables**. Validated with zod (`src/server/config.ts`, implemented in the skeleton) with readable error messages.

```jsonc
{
  "llm": {
    "provider": "ollama", // ollama | openai | anthropic | gemini | mock
    "baseUrl": "http://127.0.0.1:11434", // optional; provider default if omitted
    "model": "qwen2.5:7b",
    "apiKey": "", // optional literal (prefer apiKeyEnv)
    "apiKeyEnv": "", // e.g. "OPENAI_API_KEY" / "ANTHROPIC_API_KEY" / "GEMINI_API_KEY"
    "temperature": 0.7,
    "maxTokens": 512,
    "timeoutMs": 120000,
    "concurrency": 2,
    "jsonMode": true,
    "logFile": "",
  },
  "embeddings": {
    "provider": "auto", // auto (same as llm if it supports embeddings) | ollama | openai | gemini | mock | none
    "baseUrl": "",
    "model": "nomic-embed-text",
    "apiKey": "",
    "apiKeyEnv": "",
    "concurrency": 1,
  },
  "sim": {
    "villagers": 10,
    "dayLengthMinutes": 15,
    "startTime": "06:00",
    "speed": 1,
    "nightSpeedMultiplier": 6,
    "tickMs": 100,
    "seed": 42,
  },
  "cognition": {
    "retrievalK": 8,
    "retrievalWeights": { "recency": 1, "importance": 1, "relevance": 1 },
    "importanceMode": "llm",
    "reflectionThreshold": 60,
    "reflectionMode": "single",
    "maxConversationTurns": 6,
    "pairCooldownMinutes": 120,
  },
  "events": { "ensureDaily": true, "maxProposalsPerDay": 2 },
  "server": { "host": "127.0.0.1", "port": 3000 },
  "persistence": { "dir": "./saves", "slot": "default", "loadOnStart": true, "autosaveGameMinutes": 60 },
  "needs": { "enabled": true, "decayPerHour": { "hunger": 6, "energy": 4, "social": 5, "fun": 4 } },
  "player": { "name": "You", "petName": "Pip", "petSpecies": "cat" },
  "economy": { "startGold": 50, "eventReward": 10, "taskReward": 12, "itemRespawnGameMinutes": 180 },
  "world": { "randomWeather": false, "llmStrangers": false },
  "debug": false, // enables debug WS commands (inject memory, jump time)
}
```

Environment overrides: `TPP_LLM_PROVIDER`, `TPP_LLM_MODEL`, `TPP_LLM_BASE_URL`, `TPP_LLM_API_KEY`, `TPP_EMBED_PROVIDER`, `TPP_EMBED_MODEL`, `TPP_EMBED_BASE_URL`, `TPP_EMBED_API_KEY`, `TPP_PORT`, `TPP_DAY_LENGTH_MINUTES`, `TPP_VILLAGERS`, `TPP_DEBUG`. A `.env` file in the repo root is loaded if present (gitignored). Keys are never sent to the client or logged (`redactConfig()`).
Switching model = edit `llm.model` (AC7). On startup the server runs `health()` (Ollama: `GET /api/tags`, checks the model is pulled and prints `ollama pull <model>` if not) and prints a one-line summary; failures don't crash the server — villagers use fallback plans and the UI shows an LLM-offline badge.

## 10. Server ↔ client protocol

Types in `src/shared/protocol.ts` (stubs in skeleton). Transport: WebSocket at `ws://host:port/ws`, JSON text frames, every message has `type`. `PROTOCOL_VERSION = 1`.

Server → client:

| type                   | payload                                                                                                                             | when                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `hello`                | `protocolVersion, map: WorldMap, villagers: VillagerProfilePublic[], snapshot: WorldSnapshot, llm: { provider, model, embeddings }` | on connect                                                   |
| `tick`                 | `time, speed, villagers: VillagerFrame[]` (id, x, y, facing, status, activity text/emoji, bubble?)                                  | every `broadcastMs` (only changed villagers after the first) |
| `conversation.message` | `conversationId, speakerId, listenerId, text, time`                                                                                 | each turn                                                    |
| `conversation.ended`   | `conversationId, participants, summary?`                                                                                            | end                                                          |
| `note.updated`         | `note: DoorNote`                                                                                                                    | post / read / reply                                          |
| `event.updated`        | `event: VillageEvent`                                                                                                               | any status change                                            |
| `inspect.data`         | `villagerId, state, plan, memories (last 10 + pinned), relationships, currentConversation?`                                         | reply to `inspect`, then pushed on change while subscribed   |
| `stats`                | `queue stats, llmOnline, fps of sim`                                                                                                | every 2 s                                                    |
| `player.updated`       | `player: PlayerState` (gold, inventory, decorations, pos, pet)                                                                      | any change                                                   |
| `rumor.updated`        | `rumor: Rumor`                                                                                                                      | created / new hop                                            |
| `world.event`          | `event: WorldEvent` (rain, party, stranger, birthday, townEvent)                                                                    | triggered / ended                                            |
| `weather.updated`      | `weather: Weather`                                                                                                                  | change                                                       |
| `items.updated`        | `items: GroundItem[]` (forageables on the map)                                                                                      | spawn / pickup                                               |
| `toast`                | `icon, text`                                                                                                                        | short user feedback ("📮 Mailbox placed at your cottage ✓")  |
| `log`                  | `level, text, time`                                                                                                                 | notable sim events (feed panel)                              |
| `error`                | `message, requestId?`                                                                                                               | invalid command                                              |

Client → server: `inspect { villagerId | null }` (subscribe/unsubscribe), `speed { speed: 0 | 1 | 2 | 4 | 8 }`, `note.post { houseId, text }`, `save {}`, `player.move { to }`, `player.say { villagerId, text, mode }`, `player.rumor { villagerId, text }`, `player.pairTalk { aId, bId }`, `player.gift { villagerId, itemId }`, `world.trigger { kind, villagerId? }`, `decor.toggle { itemId }`, `pet.command { action: 'follow' | 'stay' | 'pet' | 'rename', name? }`, `debug.inject { villagerId, text, importance }` and `debug.jump { toTime }` (only when `debug: true`). Optional `requestId` on any command for correlation.

HTTP: `GET /` built client (`dist/client`), `GET /api/health`, `GET /api/state` (JSON snapshot, used by live acceptance script), `GET /api/conversations?since=` (transcripts, for gossip checks), `GET /api/rumors`, `GET /api/replay` (download replay.jsonl).

## 11. Persistence

`src/server/persistence/`: `SaveStore` interface with a JSON implementation (no native deps):

- `saves/<slot>/world.json`: `{ schemaVersion, savedAt, time, rngState, villagers: VillagerState[], minds: Record<id, MindSnapshot without memories>, events, notes, conversations (last 2 days), player, rumors, worldEvents, weather, items (forageables on the map), strangers }`.
- `saves/<slot>/replay.jsonl`: append-only broadcast log (§7.13).
- `saves/<slot>/memories/<villagerId>.json`: memories; embeddings stored as base64 Float32 to keep files small.
- Atomic writes (`write tmp` + `rename`), autosave every `autosaveGameMinutes` and on SIGINT/SIGTERM and `save` command. Load on start when `loadOnStart` and the slot exists; `npm start -- --new` starts fresh. `schemaVersion` + migration function list.
- A SQLite store can replace it later behind the same interface (not in v1).

## 12. Repository layout

```
package.json  tsconfig.json  tsconfig.client.json  vite.config.ts  vitest.config.ts  eslint.config.js
config.example.json   .env.example   README.md  LICENSE (MIT)  .github/workflows/ci.yml
data/map/village.json (incl. scenes)  data/villagers.json  data/strangers.json  data/items.json  data/decorations.json
assets/  CREDITS.md            (sprites/tilesets + licenses)
docs/  user-guide.md  providers.md  architecture.md  reference/ (thinkyville.mp4 committed as a normal file, 12 MB, + key frames)
src/shared/    types.ts  protocol.ts  time.ts               (imported by server and client)
src/server/    main.ts  config.ts  log.ts
  llm/         types.ts  index.ts(createProviders)  queue.ts  json.ts  errors.ts
  llm/providers/  ollama.ts  openai.ts  anthropic.ts  gemini.ts  mock.ts
  sim/         engine.ts  clock.ts  world.ts  pathfinding.ts  movement.ts  perception.ts  rng.ts  bus.ts
  cognition/   types.ts  mind.ts  memory.ts  retrieval.ts  keywords.ts  importance.ts  reflection.ts
               planning.ts  conversation.ts  gossip.ts  events.ts  notes.ts  nightly.ts  prompts/*.ts
  player/      types.ts  player.ts  economy.ts  inventory.ts  decor.ts  pet.ts  rumors.ts  world-events.ts  weather.ts
  persistence/ types.ts  json-store.ts  replay.ts
  net/         http.ts  ws.ts
src/client/    index.html  main.ts  net.ts  state.ts  styles.css
  render/      camera.ts  tiles.ts  sprites.ts  bubbles.ts  lighting.ts  effects.ts (rain, confetti)  scenes.ts
  ui/          hud.ts  stats.ts  llm-card.ts  toolbar.ts  dock.ts  inspector.ts  rumor-panel.ts  toasts.ts
               modals/{map,decorate,backpack,pet,door-note}.ts
test/unit/**  test/acceptance/**  test/helpers/**
scripts/       live-acceptance.ts (runs against a real provider, prints AC report)
```

Commands: `npm start` (build client with Vite, start server with tsx, open `http://127.0.0.1:3000`), `npm run dev` (Vite dev server with `/ws` proxy + `tsx watch`), `npm run lint`, `npm run typecheck`, `npm test` (vitest, mock provider), `npm run test:live` (real provider from config), `npm run build`.

## 13. Mock provider and test harness

- `mock` chat provider answers by `req.task` using `req.meta` (structured inputs the prompt builder also passes), e.g.: `plan.day` → fixed plan from profile + any accepted events; `convo.turn` → first turn mentions news item #1 verbatim ("Did you hear? <news text>"), later turns generic, `end` after 4 turns; `convo.summarize` → `learned` = offered news; `event.propose` → bake-off at square 15:00 inviting 5 villagers; `event.decide` → accept if affinity ≥ 0; `note.reply` → "Thanks for your note about '<first 6 words>' …"; `importance.rate` → kind heuristic; `reflect` → one insight citing index 1.
- Prompt builders therefore must pass `meta` with: `villagerId`, `partnerId`, `news: [{ id, text }]`, `noteText`, `event`, `profile`, `locations`.
- Canonical `req.meta` keys (WP6 owns the mock and documents them in `src/server/llm/providers/mock.ts`, WP3 prompt builders must pass them). All tasks: `villagerId`, `profile`, `locations` (Location[] or ids), `now`. Per task: `plan.day { acceptedEvents? }`, `plan.revise { plan }`, `convo.turn { partnerId, partnerName?, news: [{ id, text }], transcript }`, `convo.summarize { participants: [a, b], offered: [{ id, text, by }], transcript }` → `{ forA, forB }` with `learned[].fromNewsIndex` indexing `offered`, `event.propose { villagers: [{ id, name, affinity? }] }`, `event.decide { event, affinity }`, `note.reply { noteText }`, `importance.rate { memories: [{ text, kind }] }` → `{ ratings: number[] }`, `reflect { memories: [{ text }] }`, `player.reply` / `task.decide { text }`, `day.summarize { memories }`.
- Engine construction: `createSimEngine(opts: SimEngineOptions)` from `src/server/sim/engine.ts` (contract in `src/server/sim/types.ts`): `{ config, providers, map?, profiles?, startAt?, restore?, createMind? }`. The engine builds its own `LlmQueue` and minds (WP3 `createMind(profile, deps: MindDeps)` from `src/server/cognition/mind.ts`). Test accessors on `SimEngine`: `memories(villagerId)`, `conversations()`, `toSaveData()`.
- `mock` can also run scripted responses (`setMockScript(task, fn)`) and inject latency/failures to test the queue and fallbacks.
- Headless harness `test/helpers/world.ts`: `createTestWorld({ villagers: 10, seed, provider: 'mock' })` → `SimEngine` with virtual clock; `advanceTo("18:00")`; helpers to query memories, conversations, events, notes.

## 14. Acceptance criteria → verification

| #   | Criterion                                                                            | Automated (CI, mock)                                                                                                                                                                                                                     | Live (Mac, real Ollama)                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One command start against running Ollama, offline                                    | CI: `npm ci && npm run build`; smoke test spawns server with `mock`, checks `/api/health` + WS `hello`. Static check: client bundle has no external URLs (fonts/CDNs).                                                                   | Docs: `npm install && npm start` with Wi-Fi off; `scripts/live-acceptance.ts` checks health of Ollama model.                                                   |
| 2   | 10 villagers run a full day without crashing; each has a plan and follows it visibly | `test/acceptance/full-day.test.ts`: virtual 24 h, no exceptions; every villager has `plan.source='llm'`; ≥ 70 % of awake game minutes spent at/en route to the current block's location.                                                 | Run 1 day at default speed; live script polls `/api/state` and reports per-villager plan adherence; visual check in browser.                                   |
| 3   | Fact told to A in the morning mentioned by another villager by evening               | `gossip.test.ts`: at 08:00 post a door note to A's house (A at home) or `debug.inject` a fact to A; by 20:00 a `conversation.message` by speaker ≠ A contains the fact keywords, and ≥ 1 villager ≠ A has a memory with that `originId`. | Live script injects a distinctive fact ("The mayor's cat is named Biscuit") at 08:00, scans `/api/conversations` until 20:00 for "Biscuit" from a speaker ≠ A. |
| 4   | Door note read on owner's next home visit, reply references content                  | `door-note.test.ts`: post note while owner away; assert status stays `unread` until owner's next arrival home, then `read` within that visit, then `replied`; reply contains a content keyword.                                          | Live: post note via WS, wait, check reply text overlap with note keywords (reported, plus human eyeball).                                                      |
| 5   | Proposed event happens with ≥ 3 attendees                                            | `event.test.ts`: by end of day ≥ 1 event `status=done` with `attendees.length ≥ 3`.                                                                                                                                                      | Live script reports events + attendees for the day.                                                                                                            |
| 6   | Inspector shows plan + memories for any villager                                     | Unit test for `inspect.data` payload (plan + 10 memories) for each villager; client component test (DOM) renders it. Browser check (agent-browser) clicking each villager.                                                               | Manual click-through in browser.                                                                                                                               |
| 7   | Swapping model name works without code changes                                       | `config.test.ts`: `llm.model` from file/env reaches provider requests (fetch mocked) for all 4 providers; provider switch by config only.                                                                                                | Change `llm.model` between two pulled models, restart, header shows the new model, day runs.                                                                   |

### 14.1 Extended scope (reference-video features) → verification

| Feature           | Automated (CI, mock)                                                                                                                                                                        | Manual / browser                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Rumor tracker     | `rumor.test.ts`: `player.rumor` to A at 08:00 → by 20:00 rumor has ≥ 2 hops and `knownBy` ≥ 3; hops reference real conversations.                                                           | Panel shows "n OF N VILLAGERS KNOW" and the hop lines.              |
| Map / Home scenes | `hello.map.scenes` contains plaza, farm, shop_street, park, home with rects inside the map (unit test on map data).                                                                         | Map modal switches camera; Home tile jumps to the cottage.          |
| World events      | `world-events.test.ts`: rain swaps outdoor blocks and ends; party creates a VillageEvent with invitees; stranger spawns, gets a mind, leaves at day end; birthday creates memories + event. | Toolbar buttons show effects (rain, confetti, stranger walking in). |
| Speed 0/1/2/4/8   | Engine test: game-time advance per real second scales with speed; pause stops movement but the LLM queue keeps draining.                                                                    | Segmented control highlights the active speed.                      |
| Needs             | `needs.test.ts`: decay over time, restoration by activity, override block when a need < 20.                                                                                                 | Inspector bars move during the day.                                 |
| Gold / tasks      | `economy.test.ts`: player attends a done event → +10; "ask to do it" accepted and block completed → +12; decor purchase rejects when gold is too low.                                       | Stats card and dock tile show gold.                                 |
| Backpack / gifts  | Pickup on overlap, respawn, gift → memory + affinity change + reply.                                                                                                                        | Backpack modal lists items with counts.                             |
| Pet               | Pet follows within 2 tiles; villagers create pet observations.                                                                                                                              | Pip visible next to the player; Pet panel works.                    |
| Decorating        | Toggle buy/place/put away; villagers passing the cottage observe new decor.                                                                                                                 | Decorate modal grid, placed items render at home.                   |
| Save replay       | `save` writes world.json, memories and replay.jsonl; reload round-trips player, rumors, weather.                                                                                            | Button downloads replay.jsonl.                                      |

## 15. Work packages (parallelizable)

Each WP owns its directories; changes outside them go through the owner or the integrator. All WPs code against the shared types in `src/shared/*`, `src/server/llm/types.ts`, `src/server/cognition/types.ts`, `src/server/sim/types.ts`, `src/server/player/types.ts` and `src/server/persistence/types.ts` (present as stubs on `main`). Changing a shared interface means a small separate PR reviewed by the integrator.

| WP                                       | Scope (owns)                                                                                                            | Depends on                                                                          | Deliverable / done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WP1 LLM providers & queue**            | `src/server/llm/**` except `providers/mock.ts`                                                                          | config (done)                                                                       | 4 providers + `createProviders` + `LlmQueue` + `json.ts` + health check; unit tests with mocked `fetch` per provider (request shape incl. model/auth/JSON mode, response parsing, errors, retry); AC7 test.                                                                                                                                                                                                                                                                                              |
| **WP2 Sim core & world content**         | `src/server/sim/**` (incl. `needs.ts`), `src/server/net/**`, `src/server/main.ts`, `data/map/**`, `data/villagers.json` | shared types, `VillagerMind` interface, style guide §5 (map layout)                 | Map per style guide §5 (cafe/bakery, plaza+fountain, park+pond, farm, shop street, 10 houses + `player_home`, scenes), 10–20 villager profiles (incl. `likes`); clock (real + virtual, speeds 0/1/2/4/8), A*, movement for villagers, player avatar and pet, perception (villagers, player, pet, decorations), plan-block following, needs decay/restore, conversation proximity scheduling, event attendance, WS/HTTP per §10 with command routing to WP3/WP8 handlers. Works with a trivial stub mind. |
| **WP3 Agent cognition**                  | `src/server/cognition/**`                                                                                               | WP1 interfaces (+ mock), shared types                                               | Memory stream, retrieval (embeddings + keyword), importance, reflection, planning (incl. needs + rain-aware), conversation, gossip (originId propagation), events (propose/decide/attend), door notes, `player.reply` / `task.decide`, nightly; prompts; unit tests with mock provider.                                                                                                                                                                                                                  |
| **WP4a Frontend: world renderer**        | `src/client/render/**`, `src/client/main.ts`, `src/client/net.ts`, `src/client/state.ts`                                | protocol types, WP9 asset sheets (placeholder rects until then)                     | Canvas tiles + overhead layer, sprites with walk/idle animation, name tags, emotes, speech bubbles (style guide §7), camera with integer zoom, fit/±, scenes (§7.17), click-to-walk, click villager/door hit-testing, day/night tint + lamp glows, rain + confetti + event markers, ground items, pet, decorations at home, note icons on doors.                                                                                                                                                         |
| **WP4b Frontend: UI panels**             | `src/client/ui/**`, `src/client/styles.css`, `src/client/index.html`                                                    | protocol types, style guide §8–§9                                                   | HUD pill, stats card (calls/latency/tokens, gold, item counts), LLM card, toolbar (pause, zoom, speeds 1/2/4/8, Rain/Party/Stranger/Birthday/Town event/Save replay), dock (Backpack, Map, Pet, Decorate, Home, Gold), inspector (§8.6 incl. needs, plan checklist, friends, say/ask/rumor/have-them-talk/find/visit, last 10 memories), rumor tracker, modals (map, decorate, backpack, pet, door note), toasts, bundled fonts. DOM tests for the inspector (AC6).                                      |
| **WP5 Persistence & replay** (architect) | `src/server/persistence/**`                                                                                             | shared types, `MindSnapshot`, `PlayerState`                                         | JSON save store per §11 (incl. player, rumors, weather, items, strangers), autosave/shutdown hooks, `replay.jsonl` writer + `GET /api/replay`; round-trip tests. (Small; can be combined with WP1.)                                                                                                                                                                                                                                                                                                      |
| **WP6 Test harness & acceptance**        | `test/**`, `src/server/llm/providers/mock.ts`, `scripts/live-acceptance.ts`                                             | WP1–WP3, WP8                                                                        | Mock provider (§13, all tasks incl. `player.reply`, `task.decide`, `stranger.create`), headless harness, acceptance tests for AC1–7 and §14.1, live acceptance script for the Mac. Can start early with tests against the interfaces (skipped until features land).                                                                                                                                                                                                                                      |
| **WP7 Docs**                             | `docs/**`, `README.md`                                                                                                  | all                                                                                 | User guide (install, Ollama models, run, controls, player features, door notes, rumors, events, decorating), provider configuration guide with examples for all 4 providers, architecture doc (from this spec), troubleshooting, asset credits.                                                                                                                                                                                                                                                          |
| **WP8 Player, economy & world events**   | `src/server/player/**`, `data/items.json`, `data/decorations.json`, `data/strangers.json`                               | shared types, WP2 engine hooks, WP3 for `player.reply` / `task.decide` / event flow | `PlayerState` (avatar, home, gold, backpack, decorations, pet), handlers for `player.*`, `decor.toggle`, `pet.command`, `world.trigger` (rain/weather, party, stranger, birthday, town event), rumor tracker (§7.12), item spawning/pickup/gifts, gold rewards (events +10, tasks +12), pet follow logic; unit tests.                                                                                                                                                                                    |
| **WP9 Art & assets** (visual agent)      | `assets/**` (tiles, villagers, UI icons, fonts, `CREDITS.md`), `docs/reference/**`                                      | style guide                                                                         | Sheets + JSON sidecars per style guide §11, player + pet + stranger sprites, decoration and item sprites, reference video + key frames committed.                                                                                                                                                                                                                                                                                                                                                        |
| **WP0 Integration** (architect)          | root config/tooling, shared interfaces, CI                                                                              | –                                                                                   | Reviews/merges PRs, keeps `main` green, resolves cross-WP interface changes, runs the end-to-end acceptance pass.                                                                                                                                                                                                                                                                                                                                                                                        |

Suggested order: WP1, WP2, WP4a, WP4b, WP6, WP9 start immediately; WP3 and WP8 start immediately against the mock and stub engine; WP5 and WP7 can start now and finish last. Milestones: (M1) villagers + player walk with fallback plans on the real map in the browser (WP2+WP4a+WP9); (M2) LLM plans, conversations, gossip, notes, events (WP1+WP3); (M3) player features, economy, world events, rumor tracker, full UI (WP8+WP4b); (M4) all ACs and §14.1 green with mock, then a live run on the Mac.

## 16. Skeleton status (initial commit)

Implemented: config loader (`src/server/config.ts`, complete with tests), time helpers, all shared contracts as types, `LlmError`, minimal mock provider, HTTP+WS server stub (`/api/health`, `/api/state`, `hello` with a generated placeholder map), placeholder canvas client, CI. `createProviders` throws "not implemented" for real providers and `main.ts` falls back to mock until WP1 lands. Contracts: `src/server/llm/types.ts` (incl. `LlmQueue`), `src/server/cognition/types.ts` (`VillagerMind`, `WorldView`, `Intent`, `MemoryStream`, `ConversationRunner`), `src/server/sim/types.ts` (`SimEngine`), `src/server/persistence/types.ts` (`SaveStore`, `SaveData`), `src/server/player/types.ts` (`PlayerState`, `Rumor`, `WorldEvent`, `Weather`, catalog item types).

## 17. Conventions

- TypeScript 6.0 strict (typescript-eslint does not support TS 7 yet), ESM (`"type": "module"`), Node >= 22.12, no native deps. Imports use explicit `.ts` extensions (run by tsx, bundled by Vite). Lint: ESLint flat config + typescript-eslint. Tests: Vitest. Format: Prettier (`npm run format`).
- Branches `wp<N>/<topic>`, PRs into `main`, CI must be green (lint, typecheck, format check, test, build on Node 22 + 24). Squash merge. Commit messages: imperative summary line; include the Co-authored-by trailer required by your tooling.
- No secrets in the repo; `config.json`, `.env`, `saves/` are gitignored.
