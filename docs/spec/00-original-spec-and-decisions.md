> Copy of the workstream spec `00-original-spec-and-decisions.md`. The shared copy is the source of truth while the game is being built; this copy is updated with it.

# Pixel Village: local LLM agents — spec v1 (original from user)

## Goal

A small 2D pixel town (top-down) with ~10–20 villagers, each driven by a local LLM through Ollama. Villagers live a day: plan, move, talk to each other, spread news, run small events (e.g. a bake-off). The player can leave notes on villagers' doors; villagers read and answer them. Runs fully offline on one machine. Reference: the attached demo video (look and feel).

## Prior art (study first, don't reinvent)

- Paper: "Generative Agents: Interactive Simulacra of Human Behavior" — Park et al. 2023. https://arxiv.org/abs/2304.03442 — memory stream, retrieval (recency + importance + relevance), reflection, planning. Town "Smallville" (25 agents).
- Official code: https://github.com/joonspk-research/generative_agents (OpenAI API; architecture reference).
- AI Town: https://github.com/a16z-infra/ai-town — MIT. Reference for ideas/assets (decision: we do NOT fork it, see decisions below).

## Architecture

- LLM backend: Ollama HTTP API (/api/chat). Model name configurable. One model serves all villagers.
- World: tile map (e.g. 40×30), named locations (bakery, square, houses with doors, park). Sim clock: 1 game day ≈ 10–20 real minutes, configurable.
- Villager state: name, bio/personality (2–3 sentences), home, current location, current activity, relationships (affinity per villager).
- Memory stream per villager: timestamped observations, each with LLM-rated importance 1–10.
- Retrieval: recency decay + importance + relevance (embeddings via Ollama, or keyword fallback). Top-k into prompt.
- Reflection: when summed importance passes threshold, write 2–3 insights into memory.
- Planning: day-start coarse plan (5–8 blocks) → hourly actions; re-plan on surprising events.
- Conversation: two nearby villagers, max ~6 turns, both store memory. Gossip = info passing through memories.
- Events: villagers propose events (bake-off, picnic); invitees decide based on plan + relationship.
- Door notes: player clicks a door, types a note. Owner finds it on next home visit, stores high-importance memory, writes reply shown on door.

## UI

- Browser canvas frontend, pixel sprites, speech bubbles, click villager → current activity, plan, last 10 memories.
- Speed controls: pause / 1× / 4×.

## Performance

- Queue LLM calls; max N concurrent (default 2). Movement never waits on LLM.
- Cache plans; summarize old memories nightly.

## Persistence

- Save/load world + memories to local JSON or SQLite.

## Acceptance criteria

1. Starts with one command against a running Ollama; no internet needed after setup.
2. 10 villagers run a full game day without crashing; each produces a plan and follows it visibly.
3. A fact told to villager A in the morning is mentioned by another villager by evening (gossip).
4. A door note is read on owner's next home visit and gets a reply referencing its content.
5. A proposed event happens with ≥3 attendees.
6. Inspector panel shows plan + memories for any villager.
7. Swapping the model name in config works without code changes.

## Out of scope (v1)

Combat, inventory/economy, multiplayer, voice.

---

## User decisions (workstream, binding)

- Repo: https://github.com/AgentKnopf/tiny-pixel-people (empty at start). Work lands via PRs into main.
- Base: lightweight custom Node.js + TypeScript server + browser canvas frontend. Borrow AI Town / Smallville ideas and MIT-licensed assets (credit licenses); do not fork AI Town / no Convex.
- LLM endpoint must be configurable: local Ollama OR remote. Providers: Ollama (native), OpenAI-compatible (base URL + API key + model), native Anthropic, native Gemini. Switching provider/model/endpoint = config only.
- Visual parity with the user's reference video: `thinkyville.CSVNowDo.mp4` (on the user's Mac; committed as `docs/reference/thinkyville.mp4`). Copy it into the repo working dir (e.g. docs/reference/, consider git-lfs or .gitignore if large) .
- Deliverables beyond the game: specs, documentation, user guides.
- Scope expansion (user, binding): v1 ALSO includes, per visual-style-guide.md: rumor tracker panel, Map and Home scenes, event buttons (Rain/Party/Stranger/Birthday), 8x speed (pause/1x/2x/4x/8x), and villager needs bars, gold, backpack/inventory, pet, home decorating. This overrides the original 'out of scope: inventory/economy' line.
