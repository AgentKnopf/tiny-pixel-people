> Copy of the workstream spec `visual-style-guide.md`. The shared copy is the source of truth while the game is being built; this copy is updated with it.

# Tiny Pixel People: visual style guide

Status: v1, written from the user's reference video `thinkyville.CSVNowDo.mp4` (the demo game is called "Thinkyville"; 122.5 s, 1440×754, 24 fps, H.264, 12.0 MB).
Owner: visual-reference agent. Audience: whoever builds WP4 (frontend) and WP2 world content (map).

Reference material in the shared folder:

- `reference/01-day-overview.jpg`: whole town by day (06:58). The main look to match.
- `reference/02-inspector.jpg`: villager inspector panel open (Gilda).
- `reference/03-zoomed-home-scene.jpg`: camera zoomed into the "Your home" scene, with big speech bubbles and a toast.
- `reference/04-night-rumor.jpg`: night lighting plus the rumor-tracker panel.
- `reference/05-decorate-modal.jpg` and `reference/06-map-modal.jpg`: modal dialogs.
- `reference/frames.zip`: 25 frames (one every 5 s, `t001`–`t025`), 8 scene-change frames (`s001`–`s008`), and enlarged crops of the UI parts (`crops/`).
- `reference/video.zip`: the original video.

---

## 1. Overall look in one paragraph

A cozy, bright, top-down 16-bit-style pixel town seen from straight above, with "3/4" fronts on buildings (you see the roof and the front wall). Pixel art is chunky and crisp: nearest-neighbour scaling, no blur, 1-px dark outlines on characters, trees and buildings. The world is a warm spring green with sandy-beige dirt paths. A modern, flat, dark, semi-transparent UI floats on top, with rounded corners, small letter-spaced caps labels and a single warm yellow accent. The UI is not pixel art; only the world is. Text in the world (speech bubbles, name tags) uses a monospace pixel-ish font on cream paper bubbles.

## 2. Camera and perspective

- Orthographic top-down with 3/4 front faces on buildings, fences, benches and signs. There is no isometric view and no rotation.
- **Overview ("Plaza, the whole town")**: the whole town fills the viewport edge to edge. In the 1440 px-wide video one art pixel is about 2 screen pixels, so roughly 720×377 art pixels (about 45×24 tiles of 16 px) are visible.
- **Scene zoom**: the Map modal switches the camera to a named scene (Plaza, Farm, Shop street, Park, Your home). The camera pans and zooms (about 2× the overview, so about 4 screen px per art pixel) and follows that area. Bubbles, name tags and sprites scale with the world.
- Zoom buttons `−` / `+` and a "fit" button sit in the bottom toolbar. Clicking empty ground makes the player avatar walk there.
- Rendering rules: `imageSmoothingEnabled = false`, integer scale factors only (2×, 3×, 4×), snap the camera to whole art pixels, `image-rendering: pixelated` on the canvas, and scale the canvas backing store by `devicePixelRatio`.

## 3. Grid, tile and sprite sizes

| Item                    | Size (art px)                                                | Notes                                                                                                               |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Tile                    | **16×16**                                                    | Matches the technical spec (`tileSize` 16, client scales 2–3×).                                                     |
| Map                     | **48×30** tiles (768×480 art px)                             | Implemented draft size. 40×30 can't fit 11 houses, the bakery, shop, farm, plaza and park at the reference spacing. |
| Villager sprite frame   | **16×24** (character body about 11×16; extra rows hold hats) | Measured about 22×32 screen px at 2×. Chibi proportions: head about 50% of height. Feet anchor at (8, 22).          |
| Cottage                 | about 5×4 tiles (80×64)                                      | Roof about 2 tiles tall, front wall with 1 door and 2 windows.                                                      |
| Café (largest building) | about 8×4 tiles                                              | Red roof, red/white striped awning, signboard "CAFE".                                                               |
| Round tree              | 2×2 tiles (32×32)                                            | Canopy only. A 1-tile trunk/shadow is optional.                                                                     |
| Bush                    | 1×1 tile                                                     |                                                                                                                     |
| Lamp post               | 1×2 tiles                                                    | Warm glow at night.                                                                                                 |
| Bench                   | 2×1 tiles                                                    |                                                                                                                     |

## 4. Palette

Sampled from the video frames (hex values are approximate because of video compression; treat them as the target, not exact). Keep the world to about 32 colours.

**World, day**

| Role                          | Hex                                                               |
| ----------------------------- | ----------------------------------------------------------------- |
| Grass base                    | `#85aa4e`                                                         |
| Grass light / highlight       | `#a3bf6f`, `#8bb055`                                              |
| Grass dark / speckle          | `#728f4d`, `#57743e`                                              |
| Tree canopy                   | `#668b4f` (shade `#394829`, light `#7ca149`)                      |
| Autumn tree                   | `#e0882f` / `#b8642a`                                             |
| Dirt path                     | `#e6be81` (edge `#b8a36f`, dark `#a29568`)                        |
| Farm soil / crop rows         | `#908b52`, soil `#80563c`                                         |
| Pond water                    | `#abcad1` (deep `#6f9fb3`)                                        |
| Stone rim (plaza, fountain)   | `#d8d3c6` / `#978263`                                             |
| Wood (fences, benches, doors) | `#a56c48`, `#80563c`, `#583d2c`                                   |
| Café roof red                 | `#bc503b`                                                         |
| Cottage roofs                 | brown `#7a4a32`, blue `#5c7fb0`, teal `#4f8f8a`, purple `#7a5a8c` |
| Walls                         | cream `#ebc58a` / `#e2b77f`, grey `#a8a8a0`                       |
| Windows (lit)                 | `#f2c464`                                                         |
| Outline                       | `#272618` (near-black olive; never pure black)                    |

**World, night**: multiply the world by a dark blue-green tint so the grass becomes about `#38553f` and paths about `#4d564d`. Lamp posts and lit windows keep their colour and cast soft radial warm glows (`#eecd86` at about 35% alpha, radius about 3 tiles). A small moon sits at the top centre of the screen. Interpolate the tint over dusk (about 18:00–20:00) and dawn (about 05:00–07:00).

**UI**

| Role                                        | Hex                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Panel background                            | `#182017` at 85–92% opacity (dark green-black; the grass shows through faintly)      |
| Card inside panel                           | `#232a20`                                                                            |
| Panel border                                | `#ffffff` at 8–10% alpha, 1 px                                                       |
| Primary text                                | `#fef7e5` (warm white)                                                               |
| Secondary / label text                      | `#b9bdb6`                                                                            |
| Accent (titles, active buttons, LIVE badge) | `#f2c94c` / `#eecd86`                                                                |
| Speech bubble fill                          | `#fffaea`, border `#272618`                                                          |
| Name-tag fill                               | `#3c2b17` (dark brown), text `#fbf0d9`                                               |
| Memory text                                 | `#9fd86b` (soft green)                                                               |
| Rumor "you said" text                       | `#8ec5ff` (light blue)                                                               |
| Need bars                                   | hunger `#f08a4b`, energy `#7cc6f2`, social `#e872b8`, fun `#8fd16a`; track `#3a4236` |

## 5. Map layout and locations (reference "Thinkyville")

Overview, left to right and top to bottom:

```
 [cottage brn] [cottage brn]   [====== CAFE (red roof, awning) ======]   [house blue] [house teal]
   lamp   lamp      market stalls (red umbrella, blue umbrella)      lamp      lamp
 ========================= main east-west dirt road (~45% height) ===================== [THINKYVILLE sign]
  trees    |                         |                                        |
 [FARM: fenced crop field, rows]     |       ( PLAZA: big oval sand ring )     [SHOP house, blue roof,
 [small shed]                        +------( round fountain + small pond )     "SHOP" sign, crates ]
  trees, bushes                         benches on the ring               trees
 [purple-roof "your cottage" with garden planters] (bottom-left, own scene)
```

- Paths are 1–2 tiles wide with soft, slightly irregular edges and a lighter centre.
- Every house has a visible door tile that faces a path and a short path stub to the road. Door notes attach there.
- Grass is scattered with tiny flowers (1–2 px white, pink and yellow dots) and darker grass tufts so it never looks flat.
- Decorations: lamp posts along roads, benches around the plaza, market stalls, crates and barrels by the shop, a wooden signpost "THINKYVILLE", fences around the farm and garden.
- Our locations (technical spec §5) map onto this as follows: `bakery` takes the café slot (or rename it cafe/bakery), `square` is the plaza with the fountain, `park` is the tree and pond area, `shop` is shop street, `farm` is the farm, and there are 10 houses with doors. The map modal "scenes" are camera presets over these areas.

## 6. Characters

- 16×24 frame (16×16 chibi body plus room for hats), top-down 3/4 view, facing down, up, left or right. Each villager has a distinct hair colour or style and shirt colour (Gilda green, Joss purple cap, Pia pink, Hale dark hat, and so on), with a 1-px dark outline.
- **Walk cycle**: 4 frames per direction at about 8 fps while moving. Idle is a 2-frame bob (1 px) at about 2 fps. Sleeping villagers are hidden indoors or shown with a "z" emote.
- **Name tag**: a pill under the feet with the name in about 9 px text (`#fbf0d9` on `#3c2b17`), 2 px padding, rounded 3 px. It is always visible.
- **Player avatar** ("karenz" in the reference): yellow shirt, name tag prefixed with `★`, and an optional small red map-pin marker above when selected.
- **Activity / emote**: a small round icon or emoji (about 8 px) floating top-right of the head for activity (the spec's plan-block `emoji`). The reference shows a small blue orb for "thinking/talking" and `...` for typing.
- A tiny 1-tile oval drop shadow under each sprite (`#000` at 20%) is optional.
- Sort sprites by y for overlap. Characters pass behind roofs and tree canopies (`overhead` layer).

## 7. Speech bubbles

- A cream rectangle (`#fffaea`) with a 1-px (art) dark border `#272618` and corner radius about 2 art px, with a small 3–4 px triangle tail pointing down to the speaker's head.
- Text is monospace, dark `#272618`, about 8–9 px at 1× world scale (bubbles scale with zoom). It holds 1–2 lines with a maximum width of about 160 art px; longer lines are truncated with `…`. The full text lives in the inspector and log.
- A bubble lasts about 4–6 s of real time, fading the last 300 ms. In conversations, alternate bubbles over both speakers. Several bubbles across town at once is normal.
- To stop overlaps, nudge a bubble up when it intersects another and keep it on screen.

## 8. UI layout (screen-space overlay, HTML/CSS over the canvas)

All panels share these traits: dark translucent fill, 1-px faint border, radius 8–10 px, 8–12 px padding, and a soft drop shadow. **Labels are small caps with wide letter spacing** (`font-size: 10–11px; letter-spacing: 0.15em; text-transform: uppercase; color: #b9bdb6`).

1. **Top-left HUD pill**: `THINKYVILLE` (game title, bold caps, letter-spaced) · yellow `LIVE` badge · 🌷 season/weather icon · `Day 1` · clock `06:58` (bold, large, monospace digits) · day/night dot. For us: `TINY PIXEL PEOPLE · LIVE · Day N · HH:MM`.
2. **Top-right stats card**: `REAL MODEL CALLS` label, then `102 · 14448 ms · 31248 tok` (calls, total latency, tokens). Below it, `RECORDED FROM RESPONSES`, then `1 online · 20 agents`. This maps to our LLM status badge.
3. **Bottom-left LLM card**: `✈ OFFLINE` (yellow caps), `RUNNING ON THIS MACBOOK · <MODEL> VIA OLLAMA` (grey caps), and `last reply: 5.0s · ~3.4 tok/s` (or `no reply yet – say something`). Show the provider and model from config here.
4. **Bottom toolbar** (left/centre): `⏸ PAUSE` · `−` · fit · `+` · speed segmented control `1× 2× 4× 8×` (active one has a yellow fill and dark text). Event trigger buttons: `🌧 Rain`, `🎉 Party`, `🕵 Stranger`, `🎂 Birthday`, `🗓 Town event`, `💾 Save replay`. Buttons are dark grey rounded rectangles with a 1-px light border, 28 px tall.
5. **Bottom-right dock**: square-ish tiles (about 80×44 px), each with an icon on top, a label, and a small-caps sublabel. The reference has `Backpack`, `Map` (current scene), `Pet`, `Decorate`, `Home`, a counter slot and `Gold`. For v1 we need at least `Map` (scenes) and `Home` (jump to the player's / a door). The others are reference-only (economy is out of scope).
6. **Inspector** (right side, about 240 px wide, full height minus margins, opened by clicking a villager, close `×` top-right). In order:
   - Name (large, bold, accent yellow), occupation (small, teal-blue).
   - Bio as an italic quote with a 2-px yellow left border.
   - `CURRENT THOUGHT` card (current activity or thought).
   - `NEEDS`: 4 labelled bars with percentages (optional for us).
   - `TODAY'S PLAN`: checklist of plan blocks (`☐ 07:00 bake bread at bakery`; done items checked, current one highlighted).
   - `FRIENDS ❤ n`: relationships (we show top affinities).
   - A text input "Say, ask, or whisper a rumor…" with a `Say` button.
   - An info card: `🏠 Lives in: …`, `📍 Now: walking to the park (middle)`.
   - Action buttons in two columns: `Ask to do it`, `Tell as rumor`, a villager dropdown with `Have them talk`, `📍 Find them`, `🏠 Visit their home`.
   - `RECENT MEMORIES · KNOWS ABOUT YOU`: last 10 memories as green text lines with an emoji. This satisfies AC 6.
7. **Rumor tracker panel** (top-left, under the HUD): yellow 1–2 px border (the only bordered panel), title `🗣 RUMOR · 20 OF 20 VILLAGERS KNOW`, then `You said: "…"` in light blue, then propagation lines `Rufus → Otto "…"` with bold names. This is the visual proof of gossip (AC 3). Recommended for us.
8. **Modals** are centred on a 55–65% black backdrop and use the panel style with a title row (icon + caps title) and a `×` button in the bottom-right corner.
   - Map modal: `🗺 MAP` / `SWITCH SCENES`, 2-column buttons (title + small-caps subtitle). The current scene is filled yellow. The footer hint reads "Click empty ground to walk. The camera follows the scene you pick."
   - Decorate modal (reference-only): a 4-column grid of item cards with an icon, a name, and `PLACED ✓` (green border) or a cost.
   - **Door note modal** (ours, not in the reference): use the same modal style, titled `📮 NOTE FOR <OWNER>'S DOOR`, with a textarea, `Pin note` button, and the previous note and reply below.
9. **Toasts**: a bottom-centre dark pill with an icon, for example `📮 Mailbox placed at your cottage ✓`. Lasts about 3 s.

## 9. Fonts (bundled locally; no CDN, the game must work offline)

The reference uses a monospace pixel-ish face for world text and panel body text, and a clean sans for labels. Recommended open fonts:

| Use                                            | Font                              | License     |
| ---------------------------------------------- | --------------------------------- | ----------- |
| Speech bubbles, name tags, panel body, numbers | **Departure Mono** (Helena Zhang) | SIL OFL 1.1 |
| Small-caps labels, title `TINY PIXEL PEOPLE`   | **Silkscreen** (Jason Kottke)     | SIL OFL 1.1 |
| Fallback                                       | `ui-monospace, monospace`         | n/a         |

Ship the `.woff2` files under `assets/fonts/` and use `@font-face` with `font-display: block` so the canvas draws only after the fonts load (`document.fonts.ready`). Do not use AI Town's `upheaval_pro.ttf` or `vcr_osd_mono.ttf`: their licenses are freeware with unclear terms.

## 10. Overlays and effects

- Day/night tint (§4) and lamp glows; lit windows at night.
- Event effects: Rain is diagonal 1-px light-blue streaks plus a slight darkening. Party is confetti particles at the location. A stranger is a new sprite that walks in from the map edge.
- Event marker: a small floating banner or emoji over the event location while the event runs (for example 🍰 for a bake-off), plus a toast at start.
- Door with an unread note: a small paper icon on the door that bounces gently. A door with a reply shows a ✉ icon.
- Selection: a 1-px yellow outline or small pin above the selected villager. "Find them" pans the camera to them.

## 11. Assets: where the art comes from (licenses)

What the reference shows is custom-looking chunky 16 px art. We checked the candidates:

| Source                                              | License                                                                                                                                                                                                                    | Verdict                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI Town `public/assets/*` (code is MIT)             | Art is **not** uniformly MIT. Tilesets credited to George Bailey "16x16 game assets" (**CC-BY 4.0**) and hilau "16x16 RPG tileset" (**CC-BY-SA 3.0 / GPL 3.0**). `32x32folk.png` has no stated source. Fonts are freeware. | Avoid. Share-alike and unclear provenance, and it is 32 px with a different look.                                                                                                                                                                                                                 |
| ansimuz "Tiny RPG Forest" (OpenGameArt)             | **CC0**                                                                                                                                                                                                                    | Usable for trees and grass, but its style is darker and more forest-like. Optional.                                                                                                                                                                                                               |
| **Kenney "Tiny Town"** (kenney.nl/assets/tiny-town) | **CC0**                                                                                                                                                                                                                    | Good fallback. It uses 16×16 tiles: grass, paths, houses with roofs, trees, fences, wells and characters. The palette is close to the reference.                                                                                                                                                  |
| **Own art, made in this repo**                      | Repo license                                                                                                                                                                                                               | **Recommended primary.** Draw the tiles and sprites to this guide's palette and sizes as PNG sheets (`assets/tiles.png`, `assets/villagers.png`), or generate them with a small script (`scripts/gen-sprites.ts`) that writes indexed-palette PNGs. This gives exact parity and simple licensing. |

**Implemented** in PR branch `wp4/art-assets` (see `docs/art/README.md` in the repo for formats; actual paths are `assets/tiles/village.png`, `assets/characters/*.png`, `assets/ui/icons.png`, `assets/maps/village.json`). Original plan: I (visual agent) will produce `assets/tiles.png` (16 px tileset with ground, path autotile edges, water, farm, fences, buildings, trees, decor), `assets/villagers.png` (20 villagers × 4 directions × 4 frames, 16×16), `assets/ui-icons.png`, and `assets/CREDITS.md`. Kenney Tiny Town (CC0) is the fallback for anything missing. Record every third-party file in `assets/CREDITS.md` with author, URL and license, even CC0.

Sheet conventions for the frontend:

- Tileset: a 16 px grid, no padding, row-major indices (index = row × columns + column), with a JSON sidecar `assets/tiles.json` mapping names to indices (for example `grass_0..3`, `path_n/e/s/w/ne/...`, `water_*`, `roof_*`, `door_<colour>`).
- Villager sheet: one row per villager, columns `down0..3, left0..3, right0..3, up0..3` (16 columns × 16 px). The `sprite key` in `villagers.json` is the row name in `assets/villagers.json`.

## 12. Reference video in the repo

- Size is 12.0 MB, which is below GitHub's 50 MB warning and 100 MB hard limit.
- Decision: **commit it as a normal git file** at `docs/reference/thinkyville.mp4`, without git-lfs, so contributors don't need git-lfs installed. Add `docs/reference/frames/` with the 6 key JPEGs. Do not add more video files to git. If the reference ever grows past about 25 MB, move it to git-lfs (`git lfs track "docs/reference/*.mp4"`).

## 13. Reference extras (UPDATE: the human decided all extras are in v1 scope)

Art exists for all of them: rumor tracker, Map/Home scenes, event buttons, 8× speed, needs bars, gold, backpack items, pet Pip, and home decorations. The original suggestion below is kept for history.

The reference also shows backpack, gold, pet, decorating, needs bars and replay saving. The spec rules out economy and inventory. I suggest rendering `Map`, `Home`, the speed controls, event buttons for our event types, and the rumor tracker. Needs bars and the extra dock tiles are optional polish. This is for the orchestrator or human to confirm.
