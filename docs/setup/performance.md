# Performance and slow hardware

The villagers think with the model, so the model's speed sets how lively the village is. The
simulation itself never waits for the model: when an answer is late, villagers carry on with
simple default behaviour. On slow hardware the town keeps running, but villagers plan, talk and
gossip less.

## How much the model has to do

A game day with 10 villagers can make up to roughly 200 model calls, plus your own chats (the
v2 default of 12 residents plus visitors makes more; see
[The bigger village and the model](#the-bigger-village-and-the-model)). On a slow
model the game cuts back on optional work, so it makes fewer (about 100 in the measured run below). At 200 calls
and the default 15-minute day at 1×, that is one call every 4.5 real seconds. With Ollama the game sends one call at
a time by default (`llm.concurrency` 1; hosted providers default to 2). On a GPU or Apple Silicon
Mac that really runs two calls in parallel, `llm.concurrency: 2` lets each call take about 9
seconds. Higher speeds (2×, 4×, 8×) shrink that budget by the same factor.

### Measured on a CPU-only machine

This run was made with v1 (10 villagers, before the bigger village and its live checks). It used `qwen2.5:1.5b` on a 4-core cloud machine with 7.8 GB of memory and no GPU,
with the default settings (`llm.concurrency` 1, `sim.wakeUpTimeoutSec` 300) and a 40-minute day at
speed 2:

| What                    | Typical time |
| ----------------------- | ------------ |
| A day plan (`plan.day`) | about 26 s   |
| A conversation line     | about 7 s    |
| A door-note reply       | about 6 s    |
| Average over all calls  | about 11 s   |
| The 06:00 wake-up wait  | about 5 min  |

The game made about 100 model calls that day. All 10 villagers ended up with a plan from the model.
The 06:00 wait ran to its 5-minute limit with 9 of 10 plans ready, and the last plan arrived in the
background before noon. Gossip, the door-note reply and the village event all came from the model.
The v1 live check passed 6 of its 7 checks. The one failure was an extra sanity rule in the test script, not the
acceptance criterion: one villager stayed in a single place all day. Day plans now always include at
least two places. An earlier run with the same setup passed all 7.

If the wait at 06:00 often ends at its limit with plans still missing, raise
`sim.wakeUpTimeoutSec` (for example to 600).

Earlier test runs on the same machine, with `llm.concurrency` 2, show why the default for Ollama
is 1. Two calls at once made each call about twice as slow (`plan.day` 48 s instead of 26 s with `qwen2.5:1.5b`).
`gemma3:4b` was about twice as slow again (92 s, and half of its plans hit the 2-minute timeout),
so on a CPU like this it does worse than `qwen2.5:1.5b`. The game never crashed, and every late
answer fell back cleanly. A 7B model on an Apple Silicon Mac or a GPU answers in a few seconds.

## The bigger village and the model

The default village has 12 residents (the ten originals plus Laude and Franzi) and, once the first
train has come, 2–4 visitors. That is about 230–300 model calls a day instead of 120–200: the
extra minds plan, talk and summarise like everyone else, and visitors, dates, letters and house
greetings add a few calls each.

Everything else in the bigger village never waits for the model: the animals, the farm, rides, the
train, the hotel, letter delivery and the notice board run on fixed rules. On a slow model they
work exactly as on a fast one.

The new model tasks give way first when the model can't keep up:

| Task                              | Busy               | Overloaded                                  |
| --------------------------------- | ------------------ | ------------------------------------------- |
| Greeting you in a house           | model              | model (a simple greeting after 60 game min) |
| A villager's reply to your letter | model              | model (a simple reply if it fails)          |
| Answering a date invitation       | model              | simple rule, no call                        |
| Inventing a train visitor         | model              | ready-made visitor, no call                 |
| Asking someone on a date          | model, 1 a day max | skipped                                     |
| A villager writing a letter       | model              | skipped                                     |

To save model calls on a slow machine, turn off the parts that add minds or optional calls:

```json
{
  "visitors": { "enabled": false },
  "romance": { "enabled": false },
  "world": { "llmVisitors": false }
}
```

- `visitors.enabled: false` saves the most: no visitor minds at all. With visitors on,
  `world.llmVisitors: false` still saves the call that invents each one.
- `sim.villagers: 11` leaves out Franzi, and 10 or fewer leaves out Laude too; the post office
  and the Keep keep working without them.
- The zoo, farm, forest and train cost no model calls, so there is nothing to gain by turning them
  off.

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
- `sim.villagers`: fewer villagers make fewer calls. Below 12, Laude and Franzi stay away.
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

- **Priorities.** Your chats and the villagers' first request for today's plan go first, then
  replies to your door notes, then the first line of a villager who has news to share, then
  retries of plans that fell back to the default, then the daily event, other conversation turns and the invitees' answers, then your requests to villagers, then tomorrow's plans, summaries, importance ratings
  and reflections. Jobs that have waited a long time slowly gain priority, so background work is
  delayed but not starved.
- **Load levels.** The villagers notice when answers take long in game time and cut back on
  optional work by themselves: **busy** from about 12 game minutes per answer, **overloaded** from
  about 35. Busy means shorter conversations (at most 4 lines), mostly when someone has news, and
  no plan revisions, reflections or model-written summaries. Overloaded means only conversations
  that carry news, with at most 3 lines, and invitees answer by a simple rule. The first line of a
  villager with news still goes to the model once; the other lines are canned. In every mode a
  villager with fresh important news walks up to someone who hasn't heard it, so gossip spreads
  even when chance meetings are rare. Under load, if the
  model's line leaves the news out, the game adds it (`Did you hear? …`). There is no
  setting for this; it recovers as soon as the model catches up.
- **Morning rush.** While any villager is still waiting for its plan for today (up to 2 game hours
  after it wakes), the whole village acts as if overloaded: optional model work is skipped and
  conversations use canned lines, apart from each speaker's first line with news. This leaves the
  model to the morning plans, which the 06:00 wait depends on.
- **Rescuing default plans.** A villager that started the day on a default plan keeps asking the
  model in the background, every 30 game minutes, until 12:00 (or 2 game hours after waking, if
  that's later), at most 8 tries a day. When a usable plan arrives, it replaces the rest of the
  day. See
  [When the model is slow](../user-guide.md#when-the-model-is-slow) in the user guide.
- **Waiting for plans at 06:00.** Each morning the clock holds until every villager's day-plan
  request has finished (with a model plan or a fallback), the model is offline, or `sim.wakeUpTimeoutSec` (300) real seconds have
  passed. On a slow model this wait gives the plans a head start; set it to `0` to never wait.
  When it times out, the log says `[sim] wake-up: only N/M plans ready, starting the day anyway`.
- **Earlier daily event, evening planning.** The daily event is proposed at 07:00, and villagers
  plan tomorrow in the evening, so both are ready before the morning rush. The event proposal
  always gets a real model attempt; only if no answer has come by 13:00 does the villager fall
  back to a default event. A day plan the game can't use is asked for once more right away.
- **Model or fallback, per night.** Once a night, when the first villager is asleep, the server
  prints a line with how many answers so far came from the model and how many from a
  fallback, per task, for example
  `2026-11-23T14:30:00.000Z INFO  [sim] LLM use so far (model / fallback): convo.turn 12/30, event.propose 1/0, plan.day 14/6`.
  The counts run from server start. A high fallback count for a task means the model is too slow
  (or its answers unusable) for that task.
- **Jobs expire.** Background jobs have a lifetime in game time, for example 30 game minutes for a
  conversation turn, 2 hours for revising a plan and 6 hours for a day plan (the daily event proposal
  doesn't expire). A job that hasn't started by then is dropped, and the villager uses its fallback
  instead, such as a default day plan. With `TPP_DEBUG=1` the log shows each one as
  `<task>: request failed (<task>: dropped, expired before it started); using fallback`. Your
  chats, door-note replies and requests never expire in the queue, but a door-note reply that
  hasn't come back after 3 game hours is replaced by a simple reply that mentions the note.
- **Memory lookups don't wait long.** A villager looking up memories waits at most 4 real seconds
  (or 10 game minutes) for the embedding model, then ranks memories by keywords instead, so a
  busy model server doesn't hold up replies and plans.
- **The queue is capped.** At most 64 jobs wait at once; beyond that the lowest-priority job is
  dropped the same way. Dropped jobs are not counted as failed on the stats card.
- **Timeouts are not retried.** A call that takes longer than `llm.timeoutMs` (2 minutes) is
  cancelled and the villager falls back; resending it would only add load to a busy model. Other
  temporary errors (HTTP 429, 5xx, network) are retried up to twice.

If the village feels quiet, follow the steps in this guide: a smaller or faster model, a
longer day, fewer villagers, and `llm.concurrency` 1 on a CPU.
