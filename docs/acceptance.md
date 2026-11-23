# Acceptance tests

There are two ways to check that the village works:

- **`npm test`**: unit and acceptance tests with the deterministic `mock` provider on a virtual
  clock. No network, no model. CI runs this on Node 22 and 24.
- **`npm run test:perf`**: the timing checks (`v2/perf-v2.test.ts` and the animal benchmark), one
  file at a time and never next to the other tests, so nothing competes for the CPU while they
  measure. CI runs it as a separate step.
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

### v2: the bigger village

AC1–AC7 still hold with every v2 feature on. The v2 criteria:

| #    | Criterion                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| AC8  | One 128×60 map with seven districts, all reachable; the v1 town is unchanged.              |
| AC9  | A zoo with 12 species, rides, a burger joint and ice cream; villagers go on outings.       |
| AC10 | Farm animals are born, produce, die of old age and go to the butcher; at most 10 per kind. |
| AC11 | Animals and the other rule-based systems never wait on the model.                          |
| AC12 | Visitors arrive by train, stay at the hotel for 1–3 days, join town life and leave.        |
| AC13 | Visitors gossip.                                                                           |
| AC14 | You can walk into houses; owners greet and remember you; snooping lowers affinity.         |
| AC15 | Crushes, dates at fun places and couples; dates become gossip; the inspector shows them.   |
| AC16 | Slow-model behaviour covers the new model tasks.                                           |
| AC17 | v1 saves load into v2.                                                                     |
| AC18 | The performance budgets hold.                                                              |
| AC19 | The UI shows the new world.                                                                |
| AC20 | Letters between villagers and you.                                                         |
| AC21 | The notice board.                                                                          |
| AC22 | Laude learns every note, letter, notice and rumor at once; the Keep archives them.         |
| AC23 | The crow on the post office roof.                                                          |
| AC24 | Laude and Franzi live on the bakery road; Laude goes to bake-offs.                         |
| AC25 | Laude and Franzi's slow, shy crush.                                                        |
| AC26 | The forest with a grove, a lake and small animals.                                         |
| AC27 | The observer API shows the v2 world.                                                       |

The exact checks are in [spec v2 §18](spec/technical-spec-v2.md#18-acceptance-criteria-ac8-verification-on-the-mock).

## Automated suite (mock provider)

```sh
npm test                                   # all functional tests (no timing checks)
npm test -- test/acceptance                # only the acceptance suites
npm test -- test/acceptance/v2/zoo.test.ts # one file
npm run test:perf                          # the timing checks, one file at a time
npm run check                              # lint, typecheck, tests, then timing checks, then build
```

Use the npm scripts rather than a bare `npx vitest run`: that would run the functional tests and
the timing checks at the same time, and the timing checks would measure a busy machine.

| File (`test/acceptance/`)   | Checks                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `one-command-start.test.ts` | AC1: the `npm start` entry point serves `/api/health`, `/api/state` and a WebSocket `hello`; AC7 end to end.                                                                                                             |
| `config-swap.test.ts`       | AC7: `llm.model` from file or environment reaches the requests of all four providers.                                                                                                                                    |
| `full-day.test.ts`          | AC2: 24 virtual hours, every villager has an LLM plan and follows it.                                                                                                                                                    |
| `gossip.test.ts`            | AC3: a fact injected at 08:00 is said by another villager by 20:00 and traced by `originId`.                                                                                                                             |
| `door-note.test.ts`         | AC4: a note stays unread until the owner's next arrival home, then is read and answered.                                                                                                                                 |
| `event.test.ts`             | AC5: at least one event is done with 3 or more attendees.                                                                                                                                                                |
| `rumor.test.ts`             | Rumor tracker hops and `knownBy`.                                                                                                                                                                                        |
| `world-events.test.ts`      | Rain, party, stranger and birthday.                                                                                                                                                                                      |
| `speed.test.ts`             | Pause and 1×/2×/4×/8×.                                                                                                                                                                                                   |
| `needs.test.ts`             | Needs decay, restore and override blocks.                                                                                                                                                                                |
| `player.test.ts`            | Gold, tasks, backpack, gifts, pet, decorating.                                                                                                                                                                           |
| `save.test.ts`              | Save and reload round trip, replay log.                                                                                                                                                                                  |
| `map-data.test.ts`          | Map locations, doors and scenes.                                                                                                                                                                                         |
| `v2/map-v2.test.ts`         | AC8: size, districts, location ids, reachability, the unchanged v1 town, scenes, interiors.                                                                                                                              |
| `v2/zoo.test.ts`            | AC9: species, animals stay in their pens, ride queues and cycles, closing time, outings.                                                                                                                                 |
| `v2/farm.test.ts`           | AC10: 60 game days of births, deaths and butcher trips, the cap of 10, products, toast wording.                                                                                                                          |
| `v2/determinism-v2.test.ts` | AC11: animals, farm, stock, train, hotel and post are identical with a fast and a silent mock.                                                                                                                           |
| `v2/visitors.test.ts`       | AC12: trains, visitor counts, check-in, conversations, departure; fallback profiles.                                                                                                                                     |
| `v2/visitor-gossip.test.ts` | AC13: a fact told to a visitor reaches residents.                                                                                                                                                                        |
| `v2/interiors.test.ts`      | AC14: visits, greetings, snooping, witnesses, exit, public interiors, fallback greeting, door notes.                                                                                                                     |
| `v2/romance.test.ts`        | AC15: Sam and Ivy start at affinity 7 both ways with two earlier chats; a crush within 3 eligible nights, then a date asked and answered, the date, gossip about it and the couple, with no fixed deadline; eligibility. |
| `v2/slow-model-v2.test.ts`  | AC16: 30 s per call; new tasks fall back or are skipped as documented.                                                                                                                                                   |
| `v2/save-migration.test.ts` | AC17: a v1 save fixture loads and runs; Laude and Franzi move in; v2 round trip.                                                                                                                                         |
| `v2/perf-v2.test.ts`        | AC18: sim step time, A\* and message sizes (run by `npm run test:perf`).                                                                                                                                                 |
| `v2/letters.test.ts`        | AC20: posting, delivery rounds, reading, replies, caps, thank-you letters.                                                                                                                                               |
| `v2/notice-board.test.ts`   | AC21: event and player notices, reading, gossip, expiry.                                                                                                                                                                 |
| `v2/laude-keep.test.ts`     | AC22: Laude's instant memories, the Keep, search, archiving, no extra rating calls.                                                                                                                                      |
| `v2/crow.test.ts`           | AC23: perch, flights, sleep, caws and cooldown.                                                                                                                                                                          |
| `v2/new-residents.test.ts`  | AC24: Laude's and Franzi's homes, the v1 set with 10 villagers, the bake-off.                                                                                                                                            |
| `v2/shy-romance.test.ts`    | AC25: seven days of the shy crush: post office visits, short chats, gossip, the first date.                                                                                                                              |
| `v2/forest.test.ts`         | AC26: forest locations, animals and their hours, shyness, forest outings.                                                                                                                                                |
| `v2/observer-v2.test.ts`    | AC27: new event types and endpoints, GET only, no change to the village.                                                                                                                                                 |

AC19 (the UI) is covered by the client's DOM tests and a check in the browser.

AC6 (inspector) is covered by the `inspect.data` checks in the acceptance suites and the client's
inspector tests.

A suite that needs code from a work package that hasn't landed yet is **skipped**, and its title
says what it waits for. A full validation makes missing features fail instead of skip, and runs
the timing checks too, because `npm test` alone leaves them out:

```sh
TPP_ACCEPTANCE_STRICT=1 npm test && npm run test:perf
```

`TPP_ACCEPTANCE_STRICT=1 npm run check` does the same, with lint, typecheck and the build around it.

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
7. Prints the LLM queue statistics (calls done and failed, average time per call, per task) and
   the first distinct server warnings, to tell a slow model from a bug.
8. Prints a PASS/FAIL report. Exit code 0 means every check passed.

A check can pass on a deterministic fallback as well as on model output (for example canned
gossip lines or a default event). So each check of model output gets a second line saying where
its evidence came from:

```
        via fallback: 0/10 plans tagged llm
```

`via llm` and `via fallback` come from the `source` tags on plans, conversation lines, events and
note replies; `mixed` means both. For untagged results the script uses the per-task queue
statistics: no successful call for that task means `fallback`, otherwise `unknown` (a successful
call can still fall back if its answer doesn't parse). The summary counts the passed checks by
source, for example `6/7 checks passed (model-output checks: 1 via LLM, 3 via fallback, 0 unknown)`
(`mixed` counts as fallback). Several checks passing via fallback means the model is too slow for
the settings; see [Performance and slow hardware](setup/performance.md).

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
- Leave a note on a door and wait for the ✉ icon (AC4).
- Use **Tell as rumor** and watch the rumor tracker count up (AC3).
- Try every toolbar button: rain falls, confetti at the party, a stranger walks in, a birthday
  toast.
- Switch scenes in the Map modal, jump Home, change speeds and pause.
- Buy and place a decoration and see it at your cottage.
- Change `llm.model` in `config.json`, restart, and check the LLM card shows the new model (AC7).
