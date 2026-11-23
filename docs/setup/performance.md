# Performance and slow hardware

The villagers think with the model, so the model's speed sets how lively the village is. The
simulation itself never waits for the model: when an answer is late, villagers carry on with
simple default behaviour. On slow hardware the town keeps running, but villagers plan, talk and
gossip less.

## How much the model has to do

A game day with 10 villagers makes roughly 200 model calls, plus your own chats. With the default
15-minute day at 1×, that is one call every 4.5 real seconds. With Ollama the game sends one call at
a time by default (`llm.concurrency` 1; hosted providers default to 2). On a GPU or Apple Silicon
Mac that really runs two calls in parallel, `llm.concurrency: 2` lets each call take about 9
seconds. Higher speeds (2×, 4×, 8×) shrink that budget by the same factor.

For comparison, two test runs on a 4-core cloud machine with 7.8 GB of memory and no GPU
(`llm.concurrency` 2, a 40-minute day, speed 2):

| Model          | Calls per game day | `plan.day` call | Door-note reply | Plans from the model | Live checks passed |
| -------------- | ------------------ | --------------- | --------------- | -------------------- | ------------------ |
| `qwen2.5:1.5b` | about 30           | 48 s            | 6 s             | at most 5 of 10      | 6 of 7             |
| `gemma3:4b`    | about 30           | 92 s            | 86 s            | 1 of 10              | 6 of 7             |

On this machine `gemma3:4b` was about twice as slow as `qwen2.5:1.5b`, and half of its day plans
hit the 2-minute timeout. The gossip and event checks passed in both runs, but through the
fallbacks (canned gossip lines and a default event), not through model output. An earlier version
of the game made about 214 calls per game day on the same machine and passed 4 of 7 checks. The
game didn't crash, and every late answer fell back cleanly. A 7B model on an Apple Silicon Mac or
a GPU answers in a few seconds.

## Choose a model for your hardware

| Hardware                                             | Chat model (`llm.model`)                       |
| ---------------------------------------------------- | ---------------------------------------------- |
| CPU only (no usable GPU)                             | `qwen2.5:1.5b`, or `gemma3:4b` on a faster CPU |
| Apple Silicon with 16 GB, or a GPU with 8 GB VRAM    | 7–8B: `qwen2.5:7b` (default), `llama3.1:8b`    |
| Apple Silicon with 32 GB+, or a GPU with 12 GB+ VRAM | up to 14B: `qwen2.5:14b`                       |

See [Which model for which machine](ollama.md#which-model-for-which-machine) for download sizes and
more options. Hosted APIs (see [Providers](providers.md)) are usually fast enough at any speed.

## Settings for CPU-only machines

```json
{
  "llm": { "provider": "ollama", "model": "qwen2.5:1.5b" },
  "sim": { "dayLengthMinutes": 90, "villagers": 6 },
  "cognition": { "importanceMode": "heuristic", "maxConversationTurns": 4 }
}
```

- `llm.concurrency` stays at its Ollama default of 1: a CPU runs one call at a time efficiently;
  sending more only makes each one slower and makes timeouts more likely. It also means one
  villager conversation at a time.
- `sim.dayLengthMinutes` 60–120: a longer day gives each call more real time. Play at 1×.
- `sim.villagers`: fewer villagers make fewer calls.
- `cognition.importanceMode: "heuristic"`: rates memories with a rule instead of a model call.
- `cognition.maxConversationTurns` (default 6): shorter conversations need fewer calls.
- Keep `nomic-embed-text` for embeddings; it is small and fast even on a CPU.

## Reading the stats card and the LLM card

The **stats card** (top right) shows, under `REAL MODEL CALLS`:

- `N · T ms · K tok`: `N` calls answered so far, `T` the total time those calls took (added up, so
  it can exceed the time played when calls run in parallel), and `K` the tokens sent and received,
  as reported by the provider.
- `Q in queue · F failed` (only shown when not zero): `Q` calls waiting or running right now, `F`
  calls that failed after their retries. A queue that keeps growing means the model is slower than
  the game.

The **LLM card** (bottom left) shows `last reply: 12.3 s · ~8.5 tok/s`: how long the most recent
answer took, and the average output speed of the model in tokens per second (shown once enough
replies have been measured). As a rule of thumb, replies under about 5 seconds keep the default
settings lively; above 20 seconds, use the CPU settings above.

## What happens under load

- **Priorities.** Your chats go first, then replies to your door notes, then today's plan for a
  villager still on a default plan, then conversation turns, the daily event and the invitees'
  answers, then your requests to villagers, then tomorrow's plans, summaries, importance ratings
  and reflections. Jobs that have waited a long time slowly gain priority, so background work is
  delayed but not starved.
- **Load levels.** The villagers notice when answers take long in game time and cut back on
  optional work by themselves: **busy** from about 12 game minutes per answer, **overloaded** from
  about 35. Busy means shorter conversations (at most 4 lines), mostly when someone has news, and
  no plan revisions, reflections or model-written summaries. Overloaded means only conversations
  that carry news, with at most 3 canned lines, and invitees answer by a simple rule. There is no
  setting for this; it recovers as soon as the model catches up. See
  [When the model is slow](../user-guide.md#when-the-model-is-slow) in the user guide.
- **Waiting for plans at 06:00.** Each morning the clock holds until the villagers' day plans are
  in, the queue is idle, the model is offline, or `sim.wakeUpTimeoutSec` (300) real seconds have
  passed. On a slow model this wait gives the plans a head start; set it to `0` to never wait.
  When it times out, the log says `[sim] wake-up: only N/M plans ready, starting the day anyway`.
- **Earlier daily event, evening planning.** The daily event is proposed at 07:00, and villagers
  plan tomorrow in the evening, so both are ready before the morning rush.
- **Jobs expire.** Background jobs have a lifetime in game time, for example 30 game minutes for a
  conversation turn, 2 hours for revising a plan, 4 hours for proposing an event and 6 hours for a
  day plan. A job that hasn't started by then is dropped, and the villager uses its fallback
  instead, such as a default day plan. With `TPP_DEBUG=1` the log shows each one as
  `<task>: request failed (<task>: dropped, expired before it started); using fallback`. Your
  chats, door-note replies and requests never expire.
- **The queue is capped.** At most 64 jobs wait at once; beyond that the lowest-priority job is
  dropped the same way. Dropped jobs are not counted as failed on the stats card.
- **Timeouts are not retried.** A call that takes longer than `llm.timeoutMs` (2 minutes) is
  cancelled and the villager falls back; resending it would only add load to a busy model. Other
  temporary errors (HTTP 429, 5xx, network) are retried up to twice.

If the village feels quiet, follow the steps in this guide: a smaller or faster model, a
longer day, fewer villagers, and `llm.concurrency` 1 on a CPU.
