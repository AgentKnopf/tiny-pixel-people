# Tiny Pixel People

A tiny top-down pixel village whose villagers (12 by default, up to 18) are driven by LLMs, in the spirit of
[Generative Agents](https://arxiv.org/abs/2304.03442) (Smallville). Each villager has a memory
stream, reflects on what happened, plans its day, chats and gossips with its neighbours, organises
small events, and answers the notes you pin to its door. You walk around the village as yourself,
with your cat Pip, earn gold, collect things in your backpack and decorate your cottage. Beyond
the town lie a zoo with rides, a farm, a forest with a lake, a post office and a train station
with a hotel for visitors.

It runs fully offline with a local [Ollama](https://ollama.com), or against any OpenAI-compatible
server (LM Studio, vLLM, llama.cpp, OpenRouter, …), Anthropic or Gemini. The provider and model are
chosen in a config file; no code changes needed.

![The v2 town view on Day 1: the plaza with its fountain, the bakery, the shop and the crop field of the old town, with the HUD, the stats card (here `MOCK MODEL CALLS`, from the mock provider), the LLM card, the toolbar and the dock](docs/images/screenshot.png)

## Install and run

You need [Node.js](https://nodejs.org) 22.12 or newer (check with `node -v`) and, for the default
local model, [Ollama](https://ollama.com). On a Mac (or Windows), install the native Ollama app from
<https://ollama.com/download> and open it; it keeps running in the background (menu bar or tray). On Linux, start it
with `ollama serve` if its service isn't running. Then pull the default chat and embedding models
once:

```sh
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

Get the game and start it:

```sh
git clone https://github.com/AgentKnopf/tiny-pixel-people.git
cd tiny-pixel-people
npm ci
npm start
```

`npm start` builds the browser client and starts the server. Open <http://127.0.0.1:3000>. Stop
the server with `Ctrl+C` in its terminal; it saves the village first. After `npm ci` and the model
pulls, no internet connection is needed.

npm 11 may warn during `npm ci` that `esbuild` has an install script not covered by
`allowScripts`. In our tests (npm 11.19 on Linux) the game built and ran without approving it,
because esbuild's ready-made binary for your platform is installed as a normal dependency; this
wasn't checked on a Mac. If the build fails with an esbuild error, approve it. If you do approve it
(`npm install-scripts approve esbuild`), npm writes an `allowScripts` field into `package.json`, which
counts as a local change when you update (see below).

The model provider must be up before you start: with the defaults, that is Ollama on
`127.0.0.1:11434` with `qwen2.5:7b`. The first lines of the server log say whether the chat and
embedding models answered. If Ollama isn't running or a model isn't pulled, the game still starts,
but villagers follow simple default plans and the LLM card shows `⚠ MODEL UNREACHABLE`; start Ollama
or pull the model, then restart the server.

A model is optional for a quick look: `TPP_LLM_PROVIDER=mock npm start` runs the game with canned,
deterministic answers instead of a model (the stats card then reads `MOCK MODEL CALLS`). It uses the
same save as a normal run. To use another provider or model, copy `config.example.json` to
`config.json` and edit the `llm` section, or set environment variables; see
[Providers](docs/setup/providers.md). The full setup is in [Installation](docs/setup/installation.md)
and [Ollama setup](docs/setup/ollama.md).

## Update an existing install

1. Stop the server with `Ctrl+C`, so it saves the village.
2. In the game folder, check what you have:

   ```sh
   git status
   ```

   It should say `On branch main`; if not, run `git switch main`.

3. If `git status` lists changed files (for example a field you added to `package.json`), look at
   the changes with `git diff` first. `git pull` stops if the update touches a file you changed.
   To keep your changes and update anyway, put them aside under a name you'll recognise:

   ```sh
   git stash push --include-untracked -m "my changes before update"
   ```

   This also sets aside untracked files, such as an image you saved in the folder. Your
   `config.json`, `.env` and `saves/` are ignored by git, so they stay where they are either way.
   Nothing is deleted: `git stash list` shows the saved entry, and
   `git stash show --include-untracked --stat` lists what is in it. After the update, bring back
   what you still need, by hand or with `git stash apply` (the entry stays in the list until you
   drop it). Don't use `git reset --hard`, `git restore` or `git clean` here: they can throw
   local changes away for good.

4. Update and start:

   ```sh
   git pull --ff-only
   npm ci
   npm start
   ```

   `--ff-only` only moves your `main` forward to GitHub's; if your `main` has commits of its own,
   it stops instead of creating a merge commit. `npm ci` installs exactly the dependency versions in `package-lock.json`.

Saves are upgraded on load, and v1 saves keep working. If a save can't be read after an update,
see [Troubleshooting](docs/troubleshooting.md#saves).

## What you can do

- Watch villagers wake up, plan their day, walk to work, eat, chat and go to bed. Click a villager
  to see its current thought, needs, today's plan, friends and recent memories.
- Pin a note to a villager's door. The owner reads it the next time they come home and writes a
  reply.
- Tell a villager a rumor and follow it from villager to villager in the rumor tracker.
- Trigger world events from the toolbar: rain, a party, a stranger, a birthday or a town event.
- Run the clock at pause, 1×, 2×, 4× or 8×.
- Walk around, pick up flowers and apples, give gifts, earn gold, decorate your cottage, and take
  Pip for a walk.
- Visit the zoo, ride the rollercoaster, buy burgers and ice cream, and watch the farm animals
  grow up.
- Meet the visitors the train brings, walk into villagers' houses (they notice snooping), and
  watch crushes turn into dates and couples.
- Send letters from the post office, pin notices on the notice board, and browse the Keep, where
  Laude the postmaster records everything.
- Follow the village from another program through the read-only [observer API](docs/observer-api.md).

The [user guide](docs/user-guide.md) explains everything in detail.

## Documentation

| Document                                               | What's in it                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| [User guide](docs/user-guide.md)                       | How to play: the village, zoo, farm, train, houses, letters, romance |
| [Installation](docs/setup/installation.md)             | Requirements, install, start, update, run on another port            |
| [Ollama setup](docs/setup/ollama.md)                   | Local models and which one to pick for your RAM / GPU                |
| [Providers](docs/setup/providers.md)                   | OpenAI-compatible, LM Studio, vLLM, OpenRouter, Anthropic, Gemini    |
| [Configuration reference](docs/setup/configuration.md) | Every config key, its default, and the environment variables         |
| [Troubleshooting](docs/troubleshooting.md)             | Common problems and fixes                                            |
| [Observer API](docs/observer-api.md)                   | Read-only HTTP API for following the village from another program    |
| [Architecture](docs/architecture.md)                   | How the server, cognition, LLM queue and client fit together         |
| [Acceptance tests](docs/acceptance.md)                 | Running the test suite and the live check against a real model       |
| [Specs](docs/spec/)                                    | The original spec, the technical spec and the visual style guide     |

## Development

```sh
npm run dev        # server (tsx watch) + Vite dev server with /ws proxy
npm run lint
npm run typecheck
npm test           # unit + acceptance tests with the mock provider, no network
npm run test:perf  # timing checks, one file at a time
npm run check      # lint, typecheck, tests, timing checks and build (CI runs the same steps plus format:check)
npm run format
```

Layout: `src/shared` (types and the WebSocket protocol), `src/server` (config, llm, sim, cognition,
player, persistence, net), `src/client` (canvas renderer and UI), `data` (villagers, items,
decorations, strangers, visitors, romance, animals), `assets` (art, see `assets/CREDITS.md`), `docs`, `test`, `scripts`.
Contributors: read [AGENTS.md](AGENTS.md) and the [architecture](docs/architecture.md) first.

## License

MIT, see [LICENSE](LICENSE). The pixel art is original and generated by code in `scripts/art/`.
Fonts and any third-party assets keep their own licenses, listed in
[`assets/CREDITS.md`](assets/CREDITS.md).
