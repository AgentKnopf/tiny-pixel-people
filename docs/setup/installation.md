# Installation

## Requirements

| What                          | Version / notes                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------- |
| [Node.js](https://nodejs.org) | **22.12 or newer** (22 LTS and 24 are tested in CI). Check with `node -v`.        |
| npm                           | Comes with Node.js.                                                               |
| A language model              | Local: [Ollama](ollama.md). Remote: any [supported provider](providers.md).       |
| Browser                       | A current Chrome, Edge, Firefox or Safari.                                        |
| OS                            | macOS, Linux or Windows. There are no native modules, so nothing needs compiling. |

## Install

```sh
git clone https://github.com/AgentKnopf/tiny-pixel-people.git
cd tiny-pixel-people
npm install
```

`npm install` is the only step that needs the internet (plus pulling Ollama models). The client
bundles its fonts and art, so the game itself makes no external requests.

## Start

```sh
npm start
```

This builds the browser client into `dist/client` and starts the server. Open
<http://127.0.0.1:3000>. The first lines of the server log show which config file was used and
whether the chat model and the embedding model answered their health checks:

```
INFO  [main] config: /path/to/tiny-pixel-people/config.json
INFO  [main] resuming save "default" from /path/to/tiny-pixel-people/saves/default
INFO  [main] LLM ollama/qwen2.5:7b: ollama at http://127.0.0.1:11434, model qwen2.5:7b ready
INFO  [main] embeddings: ollama at http://127.0.0.1:11434, model nomic-embed-text ready
INFO  [main] world: 128x60 tiles, 12 villagers
INFO  [main] Tiny Pixel People running at http://127.0.0.1:3000
```

Without a `config.json` the first line reads `config: defaults (no config.json)`. The second line
says which village you get:

- `resuming save "default" from <folder>`: the saved village was loaded.
- `starting new world (save "default")`: there was no save yet, you passed `--new`, or
  `persistence.loadOnStart` is `false`. A new world overwrites the old save at its next save.
- `ERROR [main] could not load save "default": <reason>`, followed by `starting new world …`: the
  save is damaged; see [Troubleshooting](../troubleshooting.md#saves).

Stop the server with `Ctrl+C`; it saves the game first and logs
`INFO  [autosave] SIGINT: saving before exit` and `INFO  [autosave] saved at game time <n>`
(`SIGTERM` instead of `SIGINT` when stopped by a service manager or `kill`).

### Command-line options

Pass options after `--`:

| Option            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `--config <path>` | Use this config file instead of `./config.json` (same as `TPP_CONFIG`).          |
| `--new`           | Start a new village and ignore the saved one; the next save overwrites the slot. |

```sh
npm start -- --config ./configs/openrouter.json
npm start -- --new
```

## Configure

Without a `config.json`, the defaults are used: Ollama on `http://127.0.0.1:11434` with
`qwen2.5:7b`, 12 villagers, a 15-minute day. To change anything:

```sh
cp config.example.json config.json
```

Edit `config.json`; you only need the keys you want to change, everything else keeps its default.
Environment variables (and a `.env` file, see `.env.example`) override the file. Restart the server
after changes. Details: [Configuration reference](configuration.md).

`config.json`, `.env` and `saves/` are gitignored, so your keys and villages stay out of git.

## Common setups

- **Other port**: `TPP_PORT=8080 npm start`, or `"server": { "port": 8080 }`.
- **Play from another device on your network**: set `"server": { "host": "0.0.0.0" }` and open
  `http://<your-computer's-IP>:3000`. The game has no login, so only do this on a network you trust.
- **Slow machine**: see the [Ollama sizing table](ollama.md#which-model-for-which-machine).

## Update

```sh
git pull
npm install
npm start
```

Saves carry a schema version and are migrated on load. If a save can't be read after an update,
start fresh with `npm start -- --new` (or move `saves/` away).

## Development mode

```sh
npm run dev
```

Runs the server with `tsx watch` (restarts on changes) and the Vite dev server with hot reload. Vite
prints the URL to open and proxies `/ws` to the game server. See
[Acceptance tests](../acceptance.md) for the test commands.
