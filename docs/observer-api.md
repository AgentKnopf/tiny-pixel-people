# Observer API (read-only)

The observer API lets another program, or an AI, follow the village without a browser. It is plain
JSON over HTTP, read-only, and by default only answers clients on the same machine.

- **Base URL:** the game server, for example `http://127.0.0.1:3000`. With `observer.port` set it
  moves to its own listener (see [Configuration](#configuration)).
- **Methods:** `GET` and `HEAD` only. Anything else returns `405` with `Allow: GET, HEAD`.
  Unknown paths return `404`.
- **No side effects:** reading never starts model calls and never changes the village (memories
  are read without touching their "last accessed" time).
- **No secrets:** API keys are never returned. `/api/stats` shows the model name only.

## Conventions

| Field            | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ts`             | Real time, ISO-8601 UTC (`2026-11-23T18:20:53.505Z`).                                                            |
| `tick`           | Game time in minutes since day 1, 00:00 (a float while the clock runs).                                          |
| `day`, `time`    | Game clock as shown in the game: `day` starts at 1, `time` is `HH:MM`.                                           |
| ids and `*_name` | Agents, locations and houses are referenced by id (`mia`, `bakery`); most have a readable `*_name` next to them. |
| `player`         | The id of you, the human player. The player is not in `agents`; `/api/state` has a separate `player` object.     |

**Polling with `since`.** `/api/events`, `/api/conversations`, `/api/notes` and
`/api/agents/{id}/memories` accept `since`:

- a number is a game `tick` (exact),
- anything else is parsed as an ISO-8601 timestamp.

Results are strictly newer than `since`. Lists come back oldest first (memories: newest first).
Without `since` you get the newest `limit` items; with `since` you get the first `limit` items
after it, so you can page forward. Paged responses carry an `X-Next-Since` header: pass it as the
next `since` to get only what is new. Town log entries get their `ts` when they are recorded, so
ISO polling of `/api/events` is exact. For memories, conversations and notes, `ts` is derived from
the game clock (the server keeps a game-time to real-time map, saved with the village), so prefer
`since=<tick>` there when you need exact paging.

Errors are JSON: `{ "error": "…" }` with `400` (bad `since`, `limit`, `kind`, `type`, `scale`),
`401` (token), `403` (remote client), `404`, `405`.

## Endpoints

### `GET /api/state`

The whole village at a glance.

```json
{
  "ts": "2026-11-23T18:21:10.485Z",
  "tick": 556.14,
  "day": 1,
  "time": "09:16",
  "paused": false,
  "speed": 1,
  "phase": "running",
  "weather": "clear",
  "event_active": null,
  "agents": [
    {
      "id": "mia",
      "name": "Mia Hartley",
      "kind": "villager",
      "location": "bakery",
      "location_name": "Bakery & Café",
      "x": 21,
      "y": 6,
      "status": "acting",
      "activity": "Baking bread",
      "emoji": "🍞",
      "current_thought": "Hosting Bake-off at 15:00!",
      "mood": "content",
      "needs": { "hunger": 100, "energy": 77, "social": 54, "fun": 57 }
    }
  ],
  "player": {
    "id": "player",
    "name": "You",
    "x": 30,
    "y": 20,
    "location": "square",
    "location_name": "Town Square",
    "gold": 50
  }
}
```

- `paused`: speed is 0. `phase` is `waking_up` while the clock waits at 06:00 for the day plans.
- `event_active`: the village event happening now (`id`, `title`, `host`, `location`,
  `location_name`, `until`, `attendees`), else `null`.
- `agents[].kind`: `villager`, or `visitor` for strangers who are only passing through.
- `talking_to` / `talking_to_name`: only present while the agent is in a conversation.
- `needs`: the game's own needs, 0–100, 100 = fully satisfied. All four exist in the game; none are
  derived or `null`.
- `mood`: one word derived from the needs: `asleep`, `tired`, `hungry`, `lonely` or `bored` (a need
  below 25), otherwise `happy` (average ≥ 75), `content` (≥ 50) or `meh`.
- `x`, `y`: tile coordinates (the map is 128×60 tiles of 16 px).

### `GET /api/agents/{id}`

Everything in the `agents[]` entry above, plus:

```json
{
  "age": 34,
  "occupation": "Baker",
  "bio": "Mia runs the Bakery & Café …",
  "traits": ["warm", "competitive", "early riser"],
  "home": "house_01",
  "home_name": "Mia's house",
  "relationships": [
    {
      "with": "rosa",
      "with_name": "Rosa Bell",
      "kind": "friend",
      "score": 4,
      "note": null,
      "last_talked": "2026-11-23T18:24:01.000Z"
    }
  ],
  "plan_summary": "Mia Hartley works, has lunch, then catches up with neighbours.",
  "plan_source": "llm",
  "plan_today": [
    {
      "time": "06:30",
      "end": "12:00",
      "text": "Baking bread",
      "location": "bakery",
      "location_name": "Bakery & Café",
      "done": false
    }
  ]
}
```

- `relationships`: sorted by `score` (affinity, −10 to 10). `kind` is derived from the score:
  `close_friend` (≥ 6), `friend` (≥ 2), `acquaintance`, `dislikes` (≤ −2), `rival` (≤ −5).
  `note` is the villager's own summary of the relationship, if any.
- `plan_today`: today's plan blocks; `plan_source` is `llm` or `fallback`. Empty before the plan exists.
- `404` for unknown ids (including `player`).

### `GET /api/agents/{id}/memories?limit=50&since=&kind=`

Newest first: `[{ id, ts, tick, day, time, kind, raw_kind, importance, text, archived? }]`.

- `limit`: default 50, max 500.
- `kind`: `observation`, `reflection`, `plan`, `chat` or `note` (comma-separated for several).
  The game's own kind is in `raw_kind`: `conversation` and `heard` (gossip) count as `chat`,
  `summary` (end-of-day summary) as `reflection`, `event` as `observation`.
- `importance`: 1–10.

### `GET /api/conversations?since=&limit=20&agent=`

```json
[
  {
    "id": "c12",
    "ts": "…",
    "updated_ts": "…",
    "tick": 640.5,
    "updated_tick": 652.0,
    "day": 1,
    "time": "10:40",
    "status": "ended",
    "location": "square",
    "location_name": "Town Square",
    "participants": ["mia", "tom"],
    "participant_names": ["Mia Hartley", "Tom Fielding"],
    "lines": [
      {
        "speaker": "Mia Hartley",
        "speaker_id": "mia",
        "text": "Morning, Tom!",
        "day": 1,
        "time": "10:41",
        "tick": 641.2,
        "source": "llm"
      }
    ]
  }
]
```

- `status`: `active`, `ended` or `aborted`. `since` compares with the last activity
  (`updated_tick` / `updated_ts`), so an ongoing conversation shows up again as it grows.
- `source` per line: `llm` (the model wrote it) or `fallback` (canned line).
- `agent`: only conversations with that participant. `limit` max 200.
- The server keeps conversations of the last two game days.

### `GET /api/notes?agent=&since=&limit=100`

Door notes: `[{ id, ts, tick, day, time, from, from_name, to, to_name, house, text, read, status, read_ts?, reply?, reply_ts? }]`.
`agent` matches the author or the house owner. `status` is `unread`, `read` or `replied`.

### `GET /api/events?since=&limit=100&type=&agent=`

The town log, one line per thing that happened:

```json
[
  {
    "seq": 22,
    "ts": "2026-11-23T18:20:58.823Z",
    "tick": 462.86,
    "day": 1,
    "time": "07:42",
    "type": "move",
    "agents": ["nora"],
    "text": "Nora Quill arrived at General Store",
    "data": { "location": "shop" }
  }
]
```

| `type`            | When                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `move`            | An agent arrived at a different place.                                 |
| `chat`            | A conversation ended (with its first line); `data.conversationId`.     |
| `plan_change`     | A new day plan, or a change to today's plan (new block, event, task).  |
| `reflection`      | A villager formed an insight.                                          |
| `note_left`       | Someone left a door note.                                              |
| `note_read`       | The owner read it (and the reply, if any).                             |
| `gossip_spread`   | One agent told another something new; `data.originId` traces the fact. |
| `event_start`     | A village event or world event (rain, party, birthday) started.        |
| `visitor_arrived` | A stranger arrived in town.                                            |
| `visitor_left`    | A stranger left.                                                       |

`type` and `agent` filter (`type` takes a comma-separated list). `limit` max 1000. `seq` increases
by one per entry. The log keeps the last `observer.logSize` entries (default 5000) and is saved with
the village, so it survives restarts. Romance, letters and other v2 features add more types later.

### `GET /api/stats`

```json
{
  "provider": "mock",
  "model": "qwen2.5:7b",
  "online": true,
  "calls": 16,
  "failed": 0,
  "avg_latency_ms": 0,
  "queue_len": 0,
  "running": 0,
  "tokens": 6164,
  "tokens_per_second": null,
  "last_reply_ms": 0,
  "by_task": { "plan.day": { "done": 10, "failed": 0, "avgLatencyMs": 0 } }
}
```

`calls` counts finished model calls (successful plus failed). `queue_len` is the number of requests
waiting.

### `GET /api/screenshot?scale=1`

A PNG of the whole map (2048×960 px at `scale=1`; `scale` 1–4 enlarges it without smoothing) with
every villager, visitor and the player in place. It has no day/night lighting, bubbles or UI.
`501` if the art files in `assets/` are missing.

## Security

- The observer API only answers loopback clients (`127.0.0.0/8`, `::1`), even if the game server
  listens on another address (`server.host: "0.0.0.0"`). Other clients get `403`.
- With a token (`OBSERVER_TOKEN=…` or `observer.token`), every observer request, local ones
  included, needs `Authorization: Bearer <token>`; otherwise `401`.
- To allow other machines, set `observer.allowRemote: true` **and** a token. `allowRemote` without
  a token is ignored (the server logs a warning).
- The game's own endpoints (`/api/health`, `/api/snapshot`, `/api/catalog`, the WebSocket) are not
  part of the observer API and are not affected by these settings.

## Configuration

| Key                    | Default       | Meaning                                                                                                                                                     |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observer.enabled`     | `true`        | Serve the observer API.                                                                                                                                     |
| `observer.port`        | `null`        | `null`: served on the game server. A number: a separate listener on that port (0 = any free port), and the game server no longer serves the observer paths. |
| `observer.host`        | `"127.0.0.1"` | Address of the separate listener (only with `observer.port`).                                                                                               |
| `observer.allowRemote` | `false`       | Accept non-loopback clients; only together with a token.                                                                                                    |
| `observer.token`       | `""`          | Bearer token; `OBSERVER_TOKEN` overrides it. Never logged.                                                                                                  |
| `observer.logSize`     | `5000`        | Town log entries kept (100–100000).                                                                                                                         |

Environment: `OBSERVER_TOKEN` sets `observer.token`, `TPP_OBSERVER_PORT` sets `observer.port`.

## v2: the bigger village

The v2 village adds fields, endpoints and town log types. Everything stays read-only.

### Agents and state

- `agents[].kind` is `villager`, `visitor` (a train visitor staying at the hotel) or `stranger` (a
  passer-by from the toolbar **Stranger** event).
- `/api/state` also has `train` (its state and next arrival), `hotel` (rooms and occupancy),
  `visitors` (ids and departure times), `farm` (animals per species) and `stock` (food per venue).
- `/api/agents/{id}` adds `romance` (stage, partner, dates) and, for visitors, `visitor`. The
  `player` object shows `inside` while you are inside a house. `relationships[].kind` can also be
  `crush`, `shy_crush`, `dating` or `partner`.

### New endpoints

| Endpoint                                | Returns                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/letters?agent=&since=&limit=` | `[{ ts, day, time, from, to, text, status, reply? }]`                                 |
| `GET /api/notices`                      | The notices on the board right now.                                                   |
| `GET /api/keep?since=&kind=&q=&limit=`  | Entries from the Keep (notes, letters, notices, rumors, replies), with a text search. |
| `GET /api/animals?group=&species=`      | `[{ id, species, group, name?, stage?, ageDays?, location, x, y, status }]`           |

`group` is `zoo`, `farm` or `ambient` (forest animals and the crow). `/api/notes` stays door notes
only.

### New town log types

| Topic           | Types                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Romance         | `crush`, `date_asked`, `date`, `date_missed`, `couple`, `romance_ended`, and `romance` for any other change |
| Post            | `letter_sent`, `letter_delivered`, `letter_read`, `letter_replied`, `notice_posted`, `keep_logged`          |
| Train, visitors | `train_arrived`, `train_departed`, `visitor_arrived`, `visitor_checked_in`, `visitor_left`                  |
| Animals         | `animal_born`, `animal_died`, `animal_butchered`                                                            |
| Houses          | `house_visit`, `snooping`                                                                                   |
| Rides and food  | `ride`, `purchase`                                                                                          |

```sh
B=http://127.0.0.1:3000
curl -s "$B/api/letters?agent=laude&limit=10"
curl -s "$B/api/keep?q=biscuit&kind=rumor"
curl -s "$B/api/animals?group=farm&species=cow"
curl -s "$B/api/events?type=couple,date,visitor_arrived"
```

## Examples

```sh
B=http://127.0.0.1:3000
curl -s $B/api/state
curl -s $B/api/agents/mia
curl -s "$B/api/agents/mia/memories?limit=5&kind=reflection,chat"
curl -s "$B/api/conversations?agent=mia&limit=3"
curl -s "$B/api/events?type=gossip_spread,chat&limit=20"
curl -s $B/api/stats
curl -s -o town.png "$B/api/screenshot?scale=2"
# with a token
curl -s -H "Authorization: Bearer $OBSERVER_TOKEN" $B/api/state
```

### Polling for new events

```sh
#!/bin/sh
# Print every new town log line, checking every 2 minutes.
B=http://127.0.0.1:3000
since=0
while true; do
  next=$(curl -s -D - -o /tmp/events.json "$B/api/events?since=$since&limit=1000" \
    | tr -d '\r' | sed -n 's/^x-next-since: //Ip')
  node -e 'for (const e of require("/tmp/events.json")) console.log(`Day ${e.day} ${e.time} [${e.type}] ${e.text}`)'
  [ -n "$next" ] && since=$next
  sleep 120
done
```

The same in JavaScript (Node 22+):

```js
const base = 'http://127.0.0.1:3000';
let since = '0';
for (;;) {
  const res = await fetch(`${base}/api/events?since=${encodeURIComponent(since)}&limit=1000`);
  for (const e of await res.json()) console.log(`Day ${e.day} ${e.time} [${e.type}] ${e.text}`);
  since = res.headers.get('x-next-since') ?? since;
  await new Promise((r) => setTimeout(r, 120_000));
}
```
