# Performance and slow hardware

The villagers think with the model, so the model's speed sets how lively the village is. The
simulation itself never waits for the model: when an answer is late, villagers carry on with
simple default behaviour. On slow hardware the town keeps running, but villagers plan, talk and
gossip less.

## How much the model has to do

A game day with 10 villagers makes roughly 200 model calls, plus your own chats. With the default
15-minute day at 1×, that is one call every 4.5 real seconds. With `llm.concurrency: 2` each call
may take about 9 seconds and the model still keeps up, provided the machine really runs two calls
in parallel. Higher speeds (2×, 4×, 8×) shrink that budget by the same factor.

For comparison, a test run of `qwen2.5:1.5b` on a 4-core cloud machine with no GPU took 20–60
seconds per call, and some calls took up to 110 seconds. Even with a 40-minute day, 6 of 10
villagers ended up on default plans, and they had very few conversations. The game didn't crash and
every late answer fell back cleanly. A 7B model on an Apple Silicon Mac or a GPU answers in a few
seconds.

## Choose a model for your hardware

| Hardware                                             | Chat model (`llm.model`)                    |
| ---------------------------------------------------- | ------------------------------------------- |
| CPU only (no usable GPU)                             | `gemma3:4b` or `qwen2.5:1.5b`               |
| Apple Silicon with 16 GB, or a GPU with 8 GB VRAM    | 7–8B: `qwen2.5:7b` (default), `llama3.1:8b` |
| Apple Silicon with 32 GB+, or a GPU with 12 GB+ VRAM | up to 14B: `qwen2.5:14b`                    |

See [Which model for which machine](ollama.md#which-model-for-which-machine) for download sizes and
more options. Hosted APIs (see [Providers](providers.md)) are usually fast enough at any speed.

## Settings for CPU-only machines

```json
{
  "llm": { "provider": "ollama", "model": "gemma3:4b", "concurrency": 1 },
  "sim": { "dayLengthMinutes": 90, "villagers": 6 },
  "cognition": { "importanceMode": "heuristic", "maxConversationTurns": 4 }
}
```

- `llm.concurrency: 1`: a CPU runs one call at a time efficiently; sending more only makes each
  one slower and makes timeouts more likely.
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

- **Priorities.** Your chats go first, then conversation turns, then replies to your door notes and
  your requests to villagers, then event decisions, plans, summaries, reflections, event proposals
  and importance ratings. Jobs that have waited a long time
  slowly gain priority, so background work is delayed but not starved.
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
longer day, fewer villagers, or `llm.concurrency: 1` on a CPU.
