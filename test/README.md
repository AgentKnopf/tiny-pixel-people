# Tests

`npm test` runs the functional tests here with the deterministic `mock` LLM provider. No network, no real model. The timing checks run separately with `npm run test:perf` (a Vitest project of their own, one file at a time). `npm run check` runs `npm test`, then `npm run test:perf`, one after the other. Don't use a bare `npx vitest run`: it runs both projects at the same time, so the timing checks measure a busy machine.

| Path                     | What                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/`                  | Unit tests, incl. the mock provider (`mock-provider.test.ts`) and a self-test of the harness and checks (`harness.test.ts`).                                                                              |
| `acceptance/`            | Acceptance criteria AC1–AC7 and the extended scope (spec §14, §14.1), run headless on the virtual clock.                                                                                                  |
| `helpers/world.ts`       | `createTestWorld({ villagers, seed, startAt, config })`: a `SimEngine` with the mock provider, plus `advanceTo('18:00')`, `until(pred, minutes)`, `command()`, `inspect()`, `memories()`, `of(type)`.     |
| `helpers/checks.ts`      | Pass/fail checks shared with the live run (`scripts/live-acceptance.ts`), so mock and real runs are judged the same way.                                                                                  |
| `helpers/features.ts`    | Feature detection. A suite that needs another work package's code is skipped until the spec'd file exists, e.g. `src/server/sim/engine.ts`. The suite title names what it waits for.                      |
| `helpers/fake-engine.ts` | Tiny fake engine used only by the harness self-test.                                                                                                                                                      |
| `helpers/invariants.ts`  | v2 world invariants (farm caps, animals in pens, the crow near the post office, villagers on walkable tiles, population, hotel, notices). `hourlyInvariants(map)` gives an `onStep` hook for `advanceTo`. |

v2 options of `createTestWorld`: `affinities: mutualAffinity('laude', 'franzi', 8)` presets relationships (scripted affinities), `patchSave(save)` edits the starting save (e.g. preset romances), and `neverAnswer: true` uses a model that never answers (requests hang until the queue times them out; the clock does not wait on the LLM). v2 suites gate on `readyV2(...)`, which also waits for the 128×60 map.

Full validation runs every acceptance suite even if a feature file is missing (missing features then fail instead of skip), plus the timing checks, which `npm test` leaves out:

```sh
TPP_ACCEPTANCE_STRICT=1 npm test && npm run test:perf
```

`TPP_ACCEPTANCE_STRICT=1 npm run check` does the same, with lint, typecheck and the build.

## Mock provider

`src/server/llm/providers/mock.ts` answers each `LlmTask` from `req.meta` (the keys are documented at the top of the file and in spec §13). Tests can override answers (`setScript(task, fn)`), add latency (`setLatency(ms)`), inject failures (`failNext(task, n)`), never answer (`hang(task)` / `unhang(task)`) and inspect calls (`calls`, `callCount(task)`).

## Live run against a real model

```sh
npm run test:live -- --speed 4 --max-minutes 90 --report live-report.json
```

The live run uses the provider in `config.json`. It starts the server on a free port with a temporary save dir, plays one game day from 06:00, tells a villager a fact at 08:00 and posts a door note, then prints a PASS/FAIL report for AC1–AC7. Exit code 0 means every check passed. Slow models need a longer day (`--day-length 60`) or more real time (`--max-minutes`).
