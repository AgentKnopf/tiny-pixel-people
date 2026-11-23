# Troubleshooting

Start with the server log in the terminal where you ran `npm start`. The first lines say which
config file was used and whether the model answered. For more detail set `"debug": true` (or
`TPP_DEBUG=1`), and to see every prompt and reply set `"llm": { "logFile": "llm.jsonl" }`.

## Installing and starting

**`npm install` fails or warns about the engine / `npm start` fails with syntax errors.**
You need Node.js 22.12 or newer. Check with `node -v` and upgrade from <https://nodejs.org> (or
with `nvm install 22`).

**`Invalid configuration in …/config.json:` and the server exits.**
A value in `config.json` has the wrong type or an unknown option. The message lists each bad key,
for example `llm.provider: Invalid option`. Compare with `config.example.json` and the
[configuration reference](setup/configuration.md).

**`Could not parse …/config.json`.**
The file isn't valid JSON. Comments and trailing commas aren't allowed.

**`Config file not found`.**
The path given with `--config` or `TPP_CONFIG` doesn't exist. Paths are relative to the folder you
run `npm start` from.

**`EADDRINUSE` / the port is already in use.**
Another program (or another copy of the game) uses port 3000. Stop it, or start on another port:
`TPP_PORT=3001 npm start`.

**The page says `Client not built. Run "npm start"`.**
The server was started without building the client (for example with `npm run dev:server`). Use
`npm start`, or run `npm run build` once.

**The page is blank or doesn't connect.**
Make sure you open the address printed in the log (default <http://127.0.0.1:3000>). If you set
`server.host` to `0.0.0.0` to play from another device, check your firewall. Reload the page after
restarting the server.

## The model

**The LLM card shows `⚠ MODEL UNREACHABLE`, or the log warns that the LLM health check failed.**
(`✈ OFFLINE` on its own is fine: it means the model runs locally and needs no internet.) The game
runs, but villagers use simple default plans and don't talk. Check, depending on the
provider:

- Ollama: is it running? If not, the log ends with `Is Ollama running? Start it with: ollama serve`,
  and `curl http://127.0.0.1:11434/api/tags` must answer. Is the
  model pulled? The log says `model qwen2.5:7b not pulled; run: ollama pull qwen2.5:7b`; run that
  command. `ollama list` must show `llm.model` (a name without a tag means `:latest`).
- OpenAI-compatible: is `llm.baseUrl` right and does it end in `/v1`? Is the local server running
  with a model loaded? Is the model name exactly what the server expects?
- Hosted APIs: is the key set? If you use `apiKeyEnv`, the variable must be set in the shell that
  runs `npm start` or in `.env`. Without `apiKeyEnv`, the game reads `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`, or `OPENAI_API_KEY` (only for `api.openai.com`). A missing
  key shows as `anthropic: no API key; set llm.apiKeyEnv …`. A 401/403 means a wrong key; a 404
  usually a wrong model name (`unknown model …; check llm.model`).

Restart the server after fixing it. While the game runs, the card switches to `⚠ MODEL UNREACHABLE`
when calls fail with network errors, timeouts or a rejected key, and back as soon as a call
succeeds.

**Ollama says the model isn't pulled, but `ollama list` shows it.**
The names must match. `qwen2.5` means `qwen2.5:latest`, which can be a different model from
`qwen2.5:7b`; use the full name from `ollama list`.

**The log says `(not in the server model list; check llm.model)`.**
An OpenAI-compatible server answered, but doesn't list `llm.model`. Local servers often list the
loaded model under another name; if villagers talk, you can ignore it. Otherwise copy the exact
name from the server.

**HTTP 400 errors with an OpenAI-compatible server (LM Studio, llama.cpp, …).**
Some servers reject JSON mode. The game drops `response_format` by itself when the error names it;
if the errors continue, set `"llm": { "jsonMode": false }`.

**The log says `embeddings disabled (…); memory retrieval falls back to keywords`.**
The embedding model can't be used, for example because `nomic-embed-text` isn't pulled or Ollama
wasn't running when the game started. The game keeps running with keyword recall until the next
restart. Pull it (`ollama pull nomic-embed-text`) or, for other
providers, set `embeddings.model` to a model that provider offers, then restart. To switch
embeddings off on purpose, set `"embeddings": { "provider": "none" }`.

**Rate limits (HTTP 429) from a hosted API.**
Calls are retried up to twice with backoff, honouring `retry-after`. If it happens a lot, lower `llm.concurrency`, use a longer day
(`sim.dayLengthMinutes`) or a lower speed.

**Timeouts.**
A call that takes longer than `llm.timeoutMs` (2 minutes by default) is cancelled, not retried, and
the villager uses its fallback. Large models on slow hardware may need more time, but usually a
smaller model is the better fix. See [Performance and slow hardware](setup/performance.md).

## Villagers

**Villagers walk around but never talk, or follow the same simple routine every day.**
The model isn't answering (see above), or is too slow for the day length. Look at the stats card:
if the call count barely moves or the queue keeps growing, the model is offline or slow, and
background jobs expire and fall back to defaults. Use a smaller model, set
`sim.dayLengthMinutes` to 60–120, play at 1×, or lower `sim.villagers`. See
[Performance and slow hardware](setup/performance.md).

**Replies to my messages take a long time.**
Your messages have the highest priority, but each one waits for a free model slot. With a slow
local model, a reply can take 10–30 seconds. Raising `llm.concurrency` helps only if your hardware
(and `OLLAMA_NUM_PARALLEL`) can actually run calls in parallel.

**Villagers talk nonsense or plans look broken.**
Small models sometimes produce invalid JSON; the game repairs or replaces it with defaults, so the
town keeps going. A 7B+ model (see the [sizing table](setup/ollama.md#which-model-for-which-machine))
gives much better results. Setting `llm.temperature` to 0.5 can also help.

**My door note is never read.**
The owner reads notes only when it **arrives** home while awake. If it is out all day, the note
waits until evening. Check the owner's plan in the inspector.

**A rumor doesn't spread.**
Villagers pass news on in conversations, and conversations need the model. Give it time (a few game
hours), make sure the model is online, and try **Have them talk** to start one.

**The Stranger button says the village is full.**
At most 20 villagers live in town, strangers included. Wait until a stranger leaves at 22:00.

**`Not enough gold`.**
Decorations cost gold. Attend events (+10) or ask villagers for favours (+12 when done).

## Saves

**The village starts over after a restart.**
Check that `persistence.loadOnStart` is `true`, that you didn't pass `--new`, and that
`persistence.dir` and `persistence.slot` are the same as before. The game saves every 60 game
minutes and on `Ctrl+C`; if the process was killed hard (`kill -9`, a crash), the last few game
minutes are lost.

**The log says `could not load save "default": …; starting a new world`.**
A save file is damaged or from an incompatible version. The server starts a new village, and its
next save **overwrites the old slot**. To keep the old save, stop the server right away and copy the
slot folder (`saves/default/`) somewhere else.

**I want to start over completely.**
Run `npm start -- --new` (the old save is overwritten at the next save, while `replay.jsonl` keeps
growing), or delete the slot folder under `saves/` for a clean slate.

## Still stuck?

Run the checks: `npm test` should pass on any machine, and `npm run test:live` (see
[Acceptance tests](acceptance.md)) tells you whether your model setup works end to end. When
reporting a problem, include the first 20 lines of the server log and your `config.json` without
keys.
