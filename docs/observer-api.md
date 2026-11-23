# Observer API

The observer API lets another program, or an AI, follow the village without a browser. It is
plain JSON over HTTP and strictly **read-only**: it answers `GET` and `HEAD` requests, never changes
the village, and never makes a language model call.

By default it is served by the game server itself, at `http://127.0.0.1:3000/api/…`.

## Access and security

- **Local only by default.** The game server listens on `127.0.0.1`. Even if you bind the game to
  another address (`server.host`), observer requests from other machines are rejected unless
  `observer.allowRemote` is `true` **and** a token is set.
- **Token (optional).** Set the environment variable `OBSERVER_TOKEN` to require
  `Authorization: Bearer <token>` on every observer request, local ones included. Without the right
  token the answer is `401`.
- **Methods.** `GET` and `HEAD` only; anything else gets `405`. Unknown paths get `404`.
- **No secrets.** API keys are never returned; `/api/stats` names the model only.
- **Configuration.** `observer.enabled` (default `true`) turns the API off. `observer.port` (and
  `observer.host`) give it a listener of its own. See the
  [configuration reference](setup/configuration.md#observer).

## Times and polling

- `ts` is the real time as ISO 8601 (`2026-11-23T14:30:00.000Z`). `day` and `time` (`HH:MM`) are
  the game clock.
- `since` accepts an ISO timestamp or a game time in game minutes (a number). Results are strictly
  newer than `since`.
- Lists that support `since` may include `next_since`: pass it as `since` on your next request to
  get only what's new.
- The town log (`/api/events`) is a ring buffer of the last 5000 entries. It is saved with the game,
  so it survives a restart.

## Endpoints

### `GET /api/state`

The village right now.

```json
{
  "day": 2,
  "time": "14:30",
  "paused": false,
  "speed": 1,
  "weather": "clear",
  "event_active": "Bake-off",
  "agents": [
    {
      "id": "mia",
      "name": "Mia Hartley",
      "kind": "villager",
      "location": "bakery",
      "x": 12.5,
      "y": 8,
      "activity": "bake bread",
      "current_thought": "The bake-off is going to be fun.",
      "mood": "happy",
      "needs": { "hunger": 72, "energy": 60, "social": 45, "fun": 80 },
      "talking_to": null
    }
  ]
}
```

`needs` are 0–100. `mood` is a single word derived from the needs, and may be missing.
`talking_to` is the id of the conversation partner, or `null`.

### `GET /api/agents/{id}`

One villager in detail.

```json
{
  "id": "mia",
  "name": "Mia Hartley",
  "bio": "…",
  "home": "house_01",
  "relationships": [{ "with": "tom", "kind": "friend", "score": 6, "note": "…" }],
  "plan_today": [{ "time": "07:00", "text": "bake bread at Bakery & Café", "done": true }],
  "current_thought": "…"
}
```

### `GET /api/agents/{id}/memories`

Parameters: `limit` (default 50), `since`, `kind` (`observation`, `reflection`, `plan`, `chat` or
`note`). Newest first.

```json
[{ "ts": "…", "day": 2, "time": "14:10", "kind": "chat", "importance": 4, "text": "…" }]
```

### `GET /api/conversations`

Parameters: `since`, `limit` (default 20), `agent`.

```json
[
  {
    "id": "c-123",
    "ts": "…",
    "location": "square",
    "participants": ["mia", "tom"],
    "lines": [{ "speaker": "mia", "text": "Did you hear about Biscuit?" }]
  }
]
```

### `GET /api/notes`

Door notes. Parameter: `agent` (the recipient). Letters have their own endpoint.

```json
[{ "ts": "…", "from": "player", "to": "nora", "text": "…", "read": true, "reply": "…" }]
```

### `GET /api/events`

The town log, one line per thing that happened. Parameters: `since`, `limit` (default 100).

```json
[
  {
    "ts": "…",
    "day": 2,
    "time": "15:00",
    "type": "event_start",
    "agents": ["mia"],
    "text": "The Bake-off started at the Town square."
  }
]
```

Event types: `move`, `chat`, `plan_change`, `reflection`, `note_left`, `note_read`,
`gossip_spread`, `event_start` and `romance` (see [v2 event types](#v2-event-types) for the rest).

### `GET /api/stats`

```json
{ "model": "qwen2.5:7b", "calls": 412, "failed": 3, "avg_latency_ms": 2140, "queue_len": 2 }
```

### `GET /api/screenshot`

A PNG of the current map, drawn on the server. If the server can't draw it, the answer is `501`.

## v2: the bigger village

### Agents and state

- `agents[].kind` is `villager`, `visitor`, `stranger` or `player`.
- `/api/state` also has `train` (its state and next arrival), `hotel` (rooms and occupancy),
  `visitors` (ids and departure times), `farm` (animals per species) and `stock` (food per venue).
- `/api/agents/{id}` adds `romance` (stage, partner, dates), `visitor` (for visitors) and `inside`
  (for the player, when inside a house). `relationships[].kind` can also be `crush`, `shy_crush`,
  `dating` or `partner`.

### New endpoints

| Endpoint                                | Returns                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/letters?agent=&since=&limit=` | `[{ ts, day, time, from, to, text, status, reply? }]`                                 |
| `GET /api/notices`                      | The notices on the board right now.                                                   |
| `GET /api/keep?since=&kind=&q=&limit=`  | Entries from the Keep (notes, letters, notices, rumors, replies), with a text search. |
| `GET /api/animals?group=&species=`      | `[{ id, species, group, name?, stage?, ageDays?, location, x, y, status }]`           |

`group` is `zoo`, `farm` or `ambient` (forest animals and the crow).

### v2 event types

| Topic           | Types                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Romance         | `crush`, `date_asked`, `date`, `date_missed`, `couple`, `romance_ended` (and `romance` for any other change) |
| Post            | `letter_sent`, `letter_delivered`, `letter_read`, `letter_replied`, `notice_posted`, `keep_logged`           |
| Train, visitors | `train_arrived`, `train_departed`, `visitor_arrived`, `visitor_checked_in`, `visitor_left`                   |
| Animals         | `animal_born`, `animal_died`, `animal_butchered`                                                             |
| Houses          | `house_visit`, `snooping`                                                                                    |
| Rides and food  | `ride`, `purchase`                                                                                           |

## Examples

```sh
# Who is where right now
curl -s http://127.0.0.1:3000/api/state

# Everything Mia remembers about the bake-off
curl -s "http://127.0.0.1:3000/api/agents/mia/memories?limit=20&kind=observation"

# With a token
OBSERVER_TOKEN=s3cret npm start
curl -s -H "Authorization: Bearer s3cret" http://127.0.0.1:3000/api/stats
```

A small polling loop that prints each new line of the town log, every minute:

```sh
since=0
while true; do
  out=$(curl -s "http://127.0.0.1:3000/api/events?since=$since")
  echo "$out" | jq -r '.[] | "\(.day) \(.time) [\(.type)] \(.text)"'
  last=$(echo "$out" | jq -r 'if length > 0 then .[-1].ts else empty end')
  [ -n "$last" ] && since=$last
  sleep 60
done
```
