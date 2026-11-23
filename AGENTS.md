# Notes for agents and contributors

- Read `README.md` and the technical spec (architecture, interfaces, work packages) before changing code.
- Stay inside your work package's directories. Shared contracts live in `src/shared/*.ts`,
  `src/server/llm/types.ts`, `src/server/cognition/types.ts`, `src/server/sim/types.ts` and
  `src/server/persistence/types.ts`; change them only in a small dedicated PR.
- The sim loop never awaits an LLM call. Every LLM-driven decision needs a deterministic fallback.
- Tests run against the `mock` provider; never require network access or a real model in `npm test`.
- Before opening a PR run `npm run check` (lint, typecheck, tests, build) and `npm run format`.
- Branch names: `wp<N>/<topic>`. All changes land via PRs into `main`; CI must be green.
- No secrets in the repo: `config.json`, `.env` and `saves/` are gitignored.
- Third-party assets must be MIT, CC0 or CC-BY and listed in `assets/CREDITS.md`.
