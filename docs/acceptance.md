# Acceptance tests

There are two ways to check that the village works:

- **`npm test`**: unit and acceptance tests with the deterministic `mock` provider on a virtual
  clock. No network, no model, a few seconds. CI runs this on Node 22 and 24.
- **`npm run test:live`**: one game day on the real server against the model in your config, judged
  by the same checks.

## The acceptance criteria

| #   | Criterion                                                                               |
| --- | --------------------------------------------------------------------------------------- |
| AC1 | Starts with one command against a running Ollama; no internet needed after setup.       |
| AC2 | 10 villagers run a full game day without crashing; each produces a plan and follows it. |
| AC3 | A fact told to villager A in the morning is mentioned by another villager by evening.   |
| AC4 | A door note is read on the owner's next home visit and gets a reply about its content.  |
| AC5 | A proposed event happens with at least 3 attendees.                                     |
| AC6 | The inspector shows the plan and memories for any villager.                             |
| AC7 | Swapping the model name in config works without code changes.                           |

The extended scope (rumor tracker, scenes, world events, speeds, needs, gold, backpack, pet,
decorating, saving) has its own tests; see [spec §14.1](spec/technical-spec.md).

## Automated suite (mock provider)

```sh
npm test                 # everything
npx vitest run test/acceptance            # only the acceptance suites
npx vitest run test/acceptance/gossip.test.ts
npm run check            # lint, typecheck, tests and build
```

| File (`test/acceptance/`)   | Checks                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `one-command-start.test.ts` | AC1: the `npm start` entry point serves `/api/health`, `/api/state` and a WebSocket `hello`; AC7 end to end. |
| `config-swap.test.ts`       | AC7: `llm.model` from file or environment reaches the requests of all four providers.                        |
| `full-day.test.ts`          | AC2: 24 virtual hours, every villager has an LLM plan and follows it.                                        |
| `gossip.test.ts`            | AC3: a fact injected at 08:00 is said by another villager by 20:00 and traced by `originId`.                 |
| `door-note.test.ts`         | AC4: a note stays unread until the owner's next arrival home, then is read and answered.                     |
| `event.test.ts`             | AC5: at least one event is done with 3 or more attendees.                                                    |
| `rumor.test.ts`             | Rumor tracker hops and `knownBy`.                                                                            |
| `world-events.test.ts`      | Rain, party, stranger and birthday.                                                                          |
| `speed.test.ts`             | Pause and 1×/2×/4×/8×.                                                                                       |
| `needs.test.ts`             | Needs decay, restore and override blocks.                                                                    |
| `player.test.ts`            | Gold, tasks, backpack, gifts, pet, decorating.                                                               |
| `save.test.ts`              | Save and reload round trip, replay log.                                                                      |
| `map-data.test.ts`          | Map locations, doors and scenes.                                                                             |

AC6 (inspector) is covered by the `inspect.data` checks in the acceptance suites and the client's
inspector tests.

A suite that needs code from a work package that hasn't landed yet is **skipped**, and its title
says what it waits for. To make missing features fail instead of skip:

```sh
TPP_ACCEPTANCE_STRICT=1 npm test
```

How the mock provider answers each task, and how tests script it, is described in
[`test/README.md`](../test/README.md) and at the top of `src/server/llm/providers/mock.ts`.

## Live check against a real model

Set up your provider first ([Ollama](setup/ollama.md) or [another one](setup/providers.md)), then:

```sh
npm run test:live
npm run test:live -- --speed 4 --max-minutes 90 --report live-report.json
```

The script:

1. Checks that the configured model answers its health check (AC1).
2. Starts the real server on a free port, with a temporary save folder and debug commands on, and
   starts a new village at 06:00.
3. Checks that the server reports the model from your config (AC7) and sets the speed.
4. At 08:00 tells an awake villager the fact _"The mayor's cat is named Biscuit."_ and pins a door
   note on the house of a villager who is out.
5. At 12:00 inspects every villager (AC6).
6. Plays until midnight, or until the real-time limit, and judges plans (AC2), gossip (AC3, looks
   for "Biscuit" from another speaker by 20:00), the door note (AC4) and events (AC5).
7. Prints a PASS/FAIL report. Exit code 0 means every check passed.

| Option               | Default         | Meaning                          |
| -------------------- | --------------- | -------------------------------- |
| `--config <path>`    | `./config.json` | Config to test.                  |
| `--speed <n>`        | `4`             | Game speed: 1, 2, 4 or 8.        |
| `--day-length <min>` | from config     | Real minutes per game day at 1×. |
| `--max-minutes <n>`  | `90`            | Real-time limit for the run.     |
| `--villagers <n>`    | from config     | Number of villagers.             |
| `--report <file>`    | –               | Also write the results as JSON.  |

With the defaults (15-minute day, speed 4) a day takes about 4 real minutes, which is short for a
local model: villagers get less model time per game hour. If checks fail because things didn't
happen in time, give the model more time, for example
`npm run test:live -- --speed 1 --day-length 30 --max-minutes 45`.

The script never changes your saves or `config.json`. It writes a temporary config (removed at the
end) and uses a temporary save folder.

## Manual checks in the browser

Some things are best checked by eye after `npm start`:

- Click several villagers: the inspector shows the plan and the last memories (AC6).
- Pin a note on a door and wait for the ✉ icon (AC4).
- Use **Tell as rumor** and watch the rumor tracker count up (AC3).
- Try every toolbar button: rain falls, confetti at the party, a stranger walks in, a birthday
  toast.
- Switch scenes in the Map modal, jump Home, change speeds and pause.
- Buy and place a decoration and see it at your cottage.
- Change `llm.model` in `config.json`, restart, and check the LLM card shows the new model (AC7).
