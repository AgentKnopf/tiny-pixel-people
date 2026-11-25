# Tiny Pixel People — Technical Spec v2 (expansion)

Status: binding for the v2 expansion. Base: v1 on `main` (e769b2b). Decisions: `specs/10-expansion-v2-decisions.md` (rounds 1 and 2). The map layout was agreed with the art agent. Everything in the v1 spec (`technical-spec.md`) still holds unless this document changes it.

## 1. Goals and hard constraints

- One contiguous map of 128×60 tiles with seven districts: the v1 **town**, the **post row** (post office, Laude and Franzi), a **zoo** with rides and food, a **forest**, a **farmstead** with animals, a **market** road, and a **station + hotel**.
- New features: zoo (12 species, rides, burger joint, ice cream trucks), farm animals with a full lifecycle and hard caps, train visitors who stay at the hotel, house interiors the player can enter, light romance, a post office with letters, a notice board and the Keep archive, two new residents (Laude and Franzi), and a forest with ambient animals.
- **All v1 tests and AC1–AC7 keep passing with v2 defaults** (every feature on). The only v1 assertions that may change are data-shape constants that the bigger map makes wrong (for example `hello.map.width === 48` in `server-smoke.test.ts` becomes 128). The meaning of each AC stays the same. If a v2 feature makes a v1 test flaky, fix the feature.
- The sim never awaits the LLM. Every new LLM decision has a deterministic fallback, records `Provenance`, has a queue priority and a TTL, and reacts to the cognition load level (`normal | busy | overloaded`, `src/server/cognition/llm.ts`).
- **Animals (including the forest animals and the crow), rides, trains, the hotel, the farm economy, letter delivery and the notice board are fully deterministic** (seeded RNG, no LLM). With a hung LLM they behave bit-for-bit like with a fast one.
- Contracts live in the same files as v1 (`src/shared/*`, `src/server/*/types.ts`, `src/server/config.ts`). Every v2 field added to an existing v1 type is optional, so v1 code and v1 saves stay valid.

## 2. Map and districts (owner: art + WP2)

Map: `data/map/village.json` grows to **128×60** at tileSize 16 (96×60 from round 1, plus 32 columns for the forest). The height stays 60, so the v1 town keeps its coordinates and no v1 position moves. `assets/maps/village.json` keeps differing only in `locations`.

| District (`DistrictId`) | Tile rect (x, y, w, h)           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `town`                  | 0, 0, 48, 30                     | The v1 town, **unchanged**: same buildings, location ids, rects, entries and doors. The v1 `farm` stays a crop field. Only decor tiles at x 44–47, y 0–5 (no building) give way to `house_laude`, and the main road opens the south edge at x 43–46, y 27–29 (the road at x 44–45 plus one autotile edge on each side). Every other town tile, in every layer (ground, decor, overhead, collision), equals the v1 map (e769b2b). |
| `post_row`              | 44, 0, 20, 9                     | `house_laude`, `post_office` (with the notice board and the crow), `house_franzi`, on the bakery's road (y 6–8, the v1 top road extended east).                                                                                                                                                                                                                                                                                  |
| `zoo`                   | 48, 0, 48, 34 (minus `post_row`) | `zoo_gate` (on the y 7–8 promenade at x 64), 12 enclosures in three rows, 3 rides, `burger_joint`, 2 ice cream trucks, paths and benches.                                                                                                                                                                                                                                                                                        |
| `forest`                | 96, 0, 32, 60                    | `forest` (trails), `forest_grove`, `forest_lake` (about 12×8 with ducks), many trees, ambient forest animals.                                                                                                                                                                                                                                                                                                                    |
| `farmstead`             | 0, 30, 36, 30                    | `cow_pasture`, `sheep_pasture`, `chicken_coop`, `barn`, `farmhouse`, `butcher` (a shed by the road).                                                                                                                                                                                                                                                                                                                             |
| `market`                | 36, 30, 12, 30                   | The north-south main road, market stalls (decor), the `market` location.                                                                                                                                                                                                                                                                                                                                                         |
| `station`               | 48, 34, 48, 26                   | `station` (a platform at least 12×2) and `hotel` (6 rooms).                                                                                                                                                                                                                                                                                                                                                                      |

`post_row` overlaps `town` (x 44–47) and `zoo` (x 48–63). District lookup checks `post_row` first. No other districts overlap, and together the 7 districts cover every tile of the map. The railway rows run through `farmstead`, `market`, `station` and `forest`.

Roads:

- An east-west road at y 31–32 across the full width (into the forest).
- The y 7–8 promenade from the bakery road east past the post row and the zoo gate into the forest.
- A town→zoo link at about y 20.
- The north-south main road in the market district.
- The railway runs along y 56–58 across the full width. It is blocked except at level crossings on the main road and the forest trail.

Every location `entry` must be reachable from the `square` entry by the sim's A* (tested, AC8).

`WorldMap` gains the optional fields `districts`, `interiors` and `railway` (see §14).

### 2.1 Location ids (contract)

Unchanged v1 ids: `house_01`–`house_11`, `player_home`, `bakery`, `shop`, `square`, `farm`, `park`.

| Id                                                                                                                                                                               | Kind      | Notes                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `house_laude`                                                                                                                                                                    | `house`   | 5×4 at (44, 2), door (46, 5), entry (46, 6). Owner `laude`.                                                                                                                                                                                                                                 |
| `post_office`                                                                                                                                                                    | `post`    | 7×4 at (50, 2), door (53, 5), entry (53, 6). Open 08:00–18:00. Has the `post_office` interior with the counter and the `keep_cupboard` object. `perch` holds 2–4 roof tiles for the crow (about (52, 2)).                                                                                   |
| `notice_board`                                                                                                                                                                   | `public`  | At (56–57, 6) in front of the post office. Its entry is the tile next to it.                                                                                                                                                                                                                |
| `house_franzi`                                                                                                                                                                   | `house`   | 5×4 at (58, 2), door (60, 5), entry (60, 6). Owner `franzi`. Next to the post office.                                                                                                                                                                                                       |
| `zoo_gate`                                                                                                                                                                       | `zoo`     | The entrance on the promenade at x 64. Plans to "go to the zoo" use it.                                                                                                                                                                                                                     |
| `zoo_lion`, `zoo_elephant`, `zoo_giraffe`, `zoo_zebra`, `zoo_penguin`, `zoo_monkey`, `zoo_panda`, `zoo_flamingo`, `zoo_kangaroo`, `zoo_polar_bear`, `zoo_hippo`, `zoo_crocodile` | `zoo`     | Enclosures in rows A (x 64–95, y 0–6: 4), B (y 9–15: 6) and C (y 18–24: 2). Each enclosure's outer rect (fence included) is at least 6×5; its `pen` is the walkable area inside the fence (at least 4×3). Each has 2 or more viewing `spots` outside the fence. `species` names the animal. |
| `rollercoaster`                                                                                                                                                                  | `ride`    | At least 14×8, in y 18–30. `ride: { capacity: 8, durationMin: 10, playerCost: 4, funGain: 35 }`.                                                                                                                                                                                            |
| `ferris_wheel`                                                                                                                                                                   | `ride`    | About 6×7. `ride: { capacity: 8, durationMin: 15, playerCost: 3, funGain: 25 }`.                                                                                                                                                                                                            |
| `carousel`                                                                                                                                                                       | `ride`    | About 5×5. `ride: { capacity: 6, durationMin: 8, playerCost: 2, funGain: 20 }`.                                                                                                                                                                                                             |
| `burger_joint`                                                                                                                                                                   | `food`    | Open 11:00–21:00. Sells `burger`.                                                                                                                                                                                                                                                           |
| `ice_cream_truck_1`, `ice_cream_truck_2`                                                                                                                                         | `food`    | Open 10:00–19:00. Sell `ice_cream`. The trucks stay in place in v2.                                                                                                                                                                                                                         |
| `forest`                                                                                                                                                                         | `nature`  | Trails and the forest entry. `pen` = the woods (habitat of the land animals).                                                                                                                                                                                                               |
| `forest_grove`                                                                                                                                                                   | `nature`  | A grove of old trees with a picnic spot (3 or more spots). Used for walks, picnics and dates.                                                                                                                                                                                               |
| `forest_lake`                                                                                                                                                                    | `nature`  | A lake of about 12×8. The water is blocked; the shore has 3 or more walkable spots. `pen` = water plus shore (habitat of the ducks). Fishing spot for Finn.                                                                                                                                 |
| `cow_pasture`                                                                                                                                                                    | `farm`    | At least 14×10, `species: 'cow'`. Holds 10 cows.                                                                                                                                                                                                                                            |
| `sheep_pasture`                                                                                                                                                                  | `farm`    | At least 12×9, `species: 'sheep'`. Holds 10 sheep.                                                                                                                                                                                                                                          |
| `chicken_coop`                                                                                                                                                                   | `farm`    | At least 10×7, `species: 'chicken'`. Holds 10 chickens.                                                                                                                                                                                                                                     |
| `barn`                                                                                                                                                                           | `farm`    | The farmer's (Tom's) workplace. Cheese is made here.                                                                                                                                                                                                                                        |
| `farmhouse`                                                                                                                                                                      | `farm`    | A workplace with the farm shop counter. **It is not a home**: Tom keeps `house_06`.                                                                                                                                                                                                         |
| `butcher`                                                                                                                                                                        | `farm`    | A small shed by the east-west road. Animals leave the farm here (off-screen).                                                                                                                                                                                                               |
| `market`                                                                                                                                                                         | `public`  | The market road with stalls. A social spot like `square`.                                                                                                                                                                                                                                   |
| `station`                                                                                                                                                                        | `station` | The platform where trains stop.                                                                                                                                                                                                                                                             |
| `hotel`                                                                                                                                                                          | `hotel`   | A lobby with an interior, and the home of visitors. Rooms `hotel_room_1`–`hotel_room_6` are hotel state, not map locations.                                                                                                                                                                 |

New `LocationKind` values: `zoo | ride | food | farm | station | hotel | post`. New optional `Location` fields: `district`, `hours`, `ride`, `species`, `pen`, `perch`, `interiorId`.

Opening hours: the zoo, its enclosures and its rides are open 08:00–21:00 (`zoo.openTime` / `zoo.closeTime`), and the post office 08:00–18:00. Plan sanitizing (WP3, deterministic) moves a block at a closed place to the nearest open alternative (`square`, `park`, `market`, `forest`).

### 2.2 Scenes

Keep every v1 scene unchanged (`plaza` stays the default and still frames the town at 0, 0, 48, 30). Add `overview` (the whole map, 0, 0, 128, 60), `post_row`, `zoo`, `rides`, `forest`, `farmstead`, `station` and `market`. All rects lie inside the map.

### 2.3 Interiors

`WorldMap.interiors: InteriorTemplate[]` holds:

- 2–3 house templates (about 12×8);
- a `hotel_lobby` template;
- a `post_office` template with the counter and the `keep_cupboard` object (`objects: [{ id: 'keep_cupboard', pos }]`).

Every `house` location except `player_home` gets an `interiorId`; `house_laude` and `house_franzi` reuse the house templates.

An interior is a small, separate tile map. It has its own `layers` and `collision`, an `entry` (where the player appears, just inside the door), the `exit` door tile, `spots` (bed, table, chair) where residents who are home are drawn, and `objects` (clickable furniture). Interiors are not part of the 128×60 grid; the client shows them as a separate view (§13).

## 3. Animals (owner: WP2 sim; products via WP8)

All animals are deterministic `AnimalState` records simulated by `AnimalSim` (`src/server/sim/animals.ts`). There is no LLM involvement and no A*. Each animal wanders inside its `pen` rect: one step every 4–12 game minutes, with rest periods and species-specific sleep hours. This keeps about 80 animals cheap per tick.

There are three animal groups (`AnimalGroup`):

- `zoo`: fixed population, no lifecycle;
- `farm`: full lifecycle;
- `ambient`: the forest animals and the crow; fixed population, no lifecycle, and their positions are not saved.

### 3.1 Zoo animals

There are 12 species (`ZOO_SPECIES`): lion, elephant, giraffe, zebra, penguin, monkey, panda, flamingo, kangaroo, polar_bear, hippo and crocodile.

- Each enclosure holds a fixed population, seeded on first start: penguins and flamingos 3, the others 1–2.
- Zoo animals have no lifecycle in v2 (no births or deaths).
- Villagers and the player can "watch the <species>" from enclosure spots, which restores `fun` (+10 per 30 min).

### 3.2 Farm animals and lifecycle

There are three farm species (`FARM_SPECIES`): cow, sheep and chicken. Ages are in game days.

| Species | Initial                  | Adult at | Elder at | Lifespan | Product (adult)                           |
| ------- | ------------------------ | -------- | -------- | -------- | ----------------------------------------- |
| cow     | 4 (2 F, 2 M, mixed ages) | 3        | 12       | 14–18    | `milk` ×1 per female per day at 07:00     |
| sheep   | 4 (2 F, 2 M)             | 3        | 10       | 12–16    | `wool` ×1 per adult every 3 days at 07:00 |
| chicken | 6 (4 F, 2 M)             | 2        | 6        | 8–12     | `egg` ×1 per female per day at 07:00      |

Elders produce at half rate (every other production slot). The lifespan is drawn once at birth from the seeded RNG.

The daily lifecycle step runs at **06:00**, one pass per species in the fixed order cow, sheep, chicken:

1. **Ageing:** update `stage` (baby → adult → elder).
2. **Old age:** an animal past its lifespan dies, and elders also have a 5 % daily chance. Toast: "🕊️ Old Bessie the cow passed away peacefully on the farm." The farmer gets an observation.
3. **Restock:** if a species has no living animal of one sex (counting babies, not counting animals in `leaving` status), one adult of the missing sex is spawned through `spawn()`, under the cap. This keeps every species able to breed.
4. **Breeding (per mother):** each adult or elder female, in id order, can give birth when all of these hold:
   - the species has at least one adult male;
   - `alive < cap`;
   - her own last birth (`AnimalState.lastBirthAt`) was at least 2 days ago, or she has never given birth.

   The birth then happens with chance `farm.breedChance` (0.5), and the mother's `lastBirthAt` is set. Chickens hatch 1–2 chicks, and each chick is checked against the cap. Babies spawn next to the mother. Toast: "🐣 A chick hatched at the coop!"

5. **Cap:** `spawn()` is the only way to create a farm animal. It refuses when the species already has `farm.capPerSpecies` (10, schema max 10) alive, counting animals in `leaving` status. So the cap holds at every step, including after loading a save.

### 3.3 Butcher (off-screen)

At **16:00** daily (`farm.butcherTime`), at most one animal from the whole farm goes to the butcher.

- **When:** a species has `alive >= farm.butcherAtCount` (8), or the `burger` stock at `burger_joint` is below 4 and cows or sheep have at least 6 adults.
- **Which animal:** the oldest non-elder adult male of that species, or the oldest adult if there is none. Ties break by id. The butcher never takes the last living animal of a sex in its species (babies count); if every candidate is the last of its sex, nobody goes that day.

What happens next:

- The animal's status becomes `leaving`.
- If the farmer is awake and in the farmstead, he gets a deterministic override block "taking a <species> to the butcher" (30 min). The farmer is the resident whose occupation is "Farmer" (Tom). He walks to `butcher`, and the animal follows him along the road.
- Otherwise the animal walks to `butcher` on its own. The farmer never blocks this: if he is talking, asleep or absent, the animal goes alone.
- On arrival, or after 120 game minutes at the latest, the animal is removed (`reason: 'butcher'`). Food appears at `burger_joint`: cow → 4 `burger`, sheep → 2 `burger`, chicken → 2 `burger`.
- Toast: "🍔 Tom took a cow to the butcher. Fresh burgers at the Burger Joint!" Nothing graphic is ever shown or written, in toasts or in prompts.

### 3.4 Farm economy (WP8)

`FarmEconomy` turns `AnimalChange` into stock. `FoodStock` is kept per venue:

- `shop` holds `milk`, `egg`, `wool` and `cheese`;
- `burger_joint` holds `burger`;
- the ice cream trucks have unlimited `ice_cream`.

At 18:00 the barn turns 2 `milk` into 1 `cheese`. Stock per item is capped at 30, and the excess is sold off with no effect.

- **Player:** `player.buy` buys one item at a venue that is open and has it in stock. Prices in gold: burger 5, ice_cream 3, milk 2, egg 1, cheese 4, wool 3. Bought items go to the backpack and can be gifted through the v1 gift flow. Villagers' `likes` may name the new items.
- **Villagers:** eating at `burger_joint` uses up one `burger` if any is in stock; otherwise they get a veggie burger, which needs no stock. Either way hunger goes up by 50. Ice cream gives hunger +10 and fun +10. Villagers never wait for stock.
- New `ItemDef`s in `data/items.json`: `burger`, `ice_cream`, `milk`, `egg`, `wool`, `cheese` (the art agent provides the icons).

### 3.5 Forest animals (ambient)

Forest animals (`FOREST_SPECIES`) live in the `forest` pen; ducks live in the `forest_lake` pen (water and shore).

| Species  | Count | Active                                     | Notes                                                        |
| -------- | ----- | ------------------------------------------ | ------------------------------------------------------------ |
| deer     | 3     | 05:00–21:00, mostly at dawn and dusk       |                                                              |
| rabbit   | 5     | 06:00–20:00                                |                                                              |
| squirrel | 4     | 07:00–19:00                                | Hops between tree tiles.                                     |
| hedgehog | 2     | 19:00–06:00                                |                                                              |
| fox      | 2     | 18:00–07:00                                |                                                              |
| bird     | 6     | 06:00–20:00                                | Short flights between trees, drawn above the overhead layer. |
| duck     | 5     | On the water by day, on the shore at night |                                                              |

- Outside its active hours an animal rests in place (`sleeping`).
- Forest animals are shy. When a villager or the player comes within 3 tiles, the animal moves to the reachable pen tile within 4 steps that is farthest from them (deterministic tie-break).
- They have no lifecycle and are never saved; positions are reseeded from `sim.seed` on start and restore.
- A villager at a forest location who comes within 4 tiles of a forest animal gets an observation once per visit, for example "I saw a deer near the lake" (importance 2, set explicitly, so no `importance.rate` call).

### 3.6 The crow

One crow (`species: 'crow'`, group `ambient`, default name "Quill" in `data/ambient.json`) lives on the post office roof.

- It perches on the `post_office.perch` tiles and hops between them every 10–30 game minutes.
- 3–6 times a day it makes a short flight over the post row (a loop of up to 6 tiles, 2–5 minutes) and returns to the perch.
- It sleeps on the perch from 20:00 to 06:00.
- It caws (`animal.emote`, "Caw!") when a letter is posted or delivered at the post office, and when the player comes within 3 tiles. There is a 30-minute cooldown between caws.
- The crow is deterministic and has no LLM involvement. Clicking it shows the animal card.

## 4. Rides (owner: WP2)

Each ride location has a `RideState`.

- **Queueing:** villagers whose plan block is at a ride join its `queue`, standing on queue spots near the entry.
- **Cycle:** a ride starts a cycle when it is idle and has at least one rider waiting. It boards up to `capacity` from the queue, runs `durationMin` and then unloads.
- **Riders:** get status `acting`, an activity such as "riding the rollercoaster 🎢", and `fun + funGain`.
- **Waiting limit:** a villager who waits more than 20 game minutes leaves the queue and does the fallback activity "watching the rides".
- **Hours:** rides are `closed` outside zoo hours.
- **Player:** rides with `player.ride`, which costs `playerCost` gold. The player joins the queue like a villager.

The client animates rides from `RideState.status` and `cycleEndsAt`.

## 5. Train, visitors and hotel (owners: WP2 train, WP8 visitors + hotel, WP3 minds)

### 5.1 Train schedule

`TrainService` (`src/server/sim/train.ts`) is driven by the clock. Trains arrive at each time in `train.arrivals` (default `10:00` and `16:00`).

The train moves through these states: `away` → `arriving` (5 game minutes before the arrival time) → `boarding` (`train.dwellMinutes`, 20) → `departing` (5 minutes) → `away`.

`TrainState` carries the times, so the client interpolates the train sprite along the railway without per-tick messages.

### 5.2 Visitors

Visitors are transient villagers like v1 strangers (`VillagerProfile.transient = true`, plus `visitor: true`), each with a `VisitorInfo` record.

- **Count:** from the first train on, the number of visitors in town stays within `visitors.min`–`visitors.max` (2–4). At each arrival, `VisitorService.onTrainArrived` decides how many arrive: enough to reach `min`, plus a random 0–1 extra. That number is capped by `max`, by the free hotel rooms, and by `MAX_VILLAGERS` (20) for the total villager count. On the first day the 10:00 train brings 2–3 visitors.
- **Profiles:** generated ahead of time by the LLM task `visitor.create`, which is requested when the previous train departs, so an arrival never waits.
  - The request lists the existing names and the allowed sprite keys.
  - The answer is validated: the name must be unique, the sprite known and the bio short.
  - Fallback: the next unused profile from `data/visitors.json` (at least 12 entries).
  - `world.llmVisitors` (default true) turns LLM generation off when false.
- **Stay:** each visitor stays 1–3 days (`visitors.stayDays`, seeded RNG) and leaves on a scheduled train on their last day. That is the 16:00 train by default, or the 10:00 train for one-day stays when 10:00 is more than 18 h after arrival.
- **Arrival:** the visitor spawns on the platform, walks to `hotel` and checks in on arrival, which assigns a room. Their `homeId` is `hotel`, and their mailbox is the hotel.
  - From then on they get a mind (WP3, the same as for strangers), with a day plan, conversations and gossip.
  - Their seed memories say where they came from and why they are visiting.
- **Departure:**
  - On the leaving day the plan is cut so that the last block ends at `station` 30 minutes before departure.
  - When the train departs, every departing visitor on the platform is removed (`villagers.changed.removed`) and checks out.
  - A visitor who is not on the platform (for example, stuck in a conversation) leaves with the next train. At the latest they are removed, wherever they are, at the second departure after their scheduled one.
  - Residents keep their memories of visitors.
- v1 strangers (the toolbar "Stranger" event) are unchanged and independent of trains.

### 5.3 Hotel

`HotelService` (WP8) holds `HotelState`, with `hotel.rooms` rooms (default 6, and at least `visitors.max`).

- Check-in assigns the lowest free room, and check-out frees it. Occupancy never exceeds the room count.
- The lobby has an interior the player can enter. It has no owner, so entering causes no reactions.
- The hotel staff are scenery (a desk sprite), not agents.

## 6. House interiors and player entry (owners: WP2 movement, WP8 rules, WP3 greeting, WP4a view)

Entering and leaving:

- `player.enter { locationId }` is accepted when the player stands on or next to the door of a house with an interior, the hotel or the post office.
- The server then sets `PlayerState.inside = { locationId, pos }` and broadcasts `player.updated`. `pos` is in interior coordinates; the world position stays at the door.
- Inside an interior, `player.move` paths on the interior grid. `player.exit` puts the player back on the door tile.
- `player_home` has no interior in v2; decorating stays outdoors.

An owner counts as **home** when `locationId === houseId`. On entry the server writes a `HouseVisit`, whose kind depends on who is home:

- **Owner home and awake → `visit`.**
  - The first awake owner stops what they are doing for up to 10 game minutes (status `talking`, emote 👋) and greets the player.
  - The greeting comes from the LLM task `visit.greet`. If the answer has not arrived after 60 game minutes, or the player has already left, a template is used: "Oh, hello! Come on in, make yourself at home."
  - The owner gets the memory "<player> came to visit me at home" (importance 5) and affinity +1 (`interiors.visitAffinity`). Both happen at most once per house per game day.
- **Owner home but asleep → `sleeping`.** When the owner wakes, they get the memory "<player> walked into my house while I was asleep" (importance 6) and affinity −1.
- **Nobody home → `snoop`.**
  - On the owner's next arrival home, they get the memory "Someone was in my house while I was out. It was <player>." (importance 7) and affinity −2 (`interiors.snoopAffinity`). This happens at most once per house per day.
  - Villagers within 6 tiles of the door at the time of entry are witnesses. Each gets the observation "I saw <player> go into <owner>'s house while they were out" (importance 6), which spreads as gossip through the v1 originId flow.
- **Public interiors** (`hotel`, `post_office`) have no owner, and entering them causes no reaction.

The player can always walk in; nothing is locked. v1 door notes keep working from outside. Each house visit is broadcast as `visit.updated`.

## 7. Romance (owner: WP3, state stored by WP2)

Romance stays light and wholesome. Prompts and text contain nothing physical beyond holding hands.

Eligibility rules:

- Only villagers aged at least `romance.minAge` (18) take part.
- A villager has at most one crush and at most one partner.
- Visitors can have crushes and dates, but they do not become couples.

- **Crush (deterministic, nightly at 02:00):** A develops a crush on B when all of these hold:
  - A→B affinity is at least `romance.crushAffinity` (6);
  - they talked at least twice in the last 3 days;
  - A has no crush or partner yet, and B is eligible.

  The chance is 0.3 per night for each A, toward A's best-affinity candidate. **Guarantee:** if A has met these conditions on 2 nights in a row without getting a crush, the crush is certain on the 3rd night in a row (chance 1). A night when A is not eligible resets the count. The count is part of A's saved mind state, so it survives a restore. A gets the memory "I think I have a crush on B" (importance 7). The pair's `Romance` record gets stage `crush` and `crushFrom: [A]`.

- **Asking on a date:**
  - A conversation between A and B has ended, A has a crush on B (or they are a couple), and A has no date planned in the coming day. A's mind then enqueues `date.ask`.
  - Possible venues: `zoo_gate`, `burger_joint`, a ride, `ice_cream_truck_*`, `park`, `forest_grove` or `forest_lake`, provided the place is open at the chosen time.
  - The answer gives the invitation text, the venue and the start time. Fallback: a rotating venue, starting at the next 17:00, or 2 hours from now if it is before 15:00.
  - B's mind decides with `date.decide`. Fallback: accept if B→A affinity is at least 4.
- **The date:**
  - It is a `VillageEvent` with `kind: 'date'`, host A, `invitees: [B]` and a length of 90 minutes.
  - It uses the v1 event flow (plan insertion, attendance), but it does not count against `events.maxProposalsPerDay`, is not offered to other villagers and gets no notice on the board.
  - Once B accepts, the stage becomes `dating` and the `DateRecord.status` becomes `planned`.
- **After the date:**
  - If both attended, the date is `done`. Affinity goes up by 2 both ways, and both get the memory "I had a lovely date with X at the Y" (importance 7).
  - Villagers within 8 tiles of the venue during the date get the observation "I saw A and B on a date at the Y" (importance 6), so dates spread as gossip.
  - If one of them does not show up, the date is `missed`, and the one who waited loses 1 affinity.
- **Couple (deterministic, nightly):**
  - The pair becomes a `couple` after `romance.datesForCouple` (2) dates marked `done`, if mutual affinity is at least `romance.coupleAffinity` (7).
  - This produces the toast "💕 A and B are now a couple!", a `world.event` of kind `couple`, and memories for both (importance 8).
  - Couples' plan prompts mention the partner, and they keep asking each other on dates as above.
- **Ending (deterministic, rare):** a couple or crush whose affinity stays below 0 for 3 days quietly becomes `ended`. There are no drama scenes.
- **Inspector:** shows "💕 Partner: B", "💗 Crush on: B" (or "💗 Shy crush on: B") and the last 3 dates.

### 7.1 Laude and Franzi: a slow-burn, shy mutual crush

The pair is seeded from `data/romance.json`: `{ pair: ['laude', 'franzi'], stage: 'crush', crushFrom: ['laude', 'franzi'], shy: true }`, with an initial affinity of 4 both ways (`initialRelationships`). Because both crush slots are taken, neither of them develops a crush on anyone else.

Rules for shy pairs (deterministic unless stated):

- **Post office visits:** Franzi gets a 20–40 minute visit to `post_office` during opening hours on most days (chance `romance.shyVisitChance`, 0.7 per day), unless her plan already has one. Plan sanitizing adds it.
- **Awkward short chats:** when both are at the post office, the pair is preferred for a conversation. Their conversations are capped at `romance.shyMaxTurns` (3) turns, and the prompt says both are shy, kind and a little awkward with each other. Affinity grows by the normal per-conversation amount, so it builds slowly.
- **Gossip:** a villager within 8 tiles who sees them chatting at the post office gets the observation "Franzi was at the post office again, chatting shyly with Laude" (importance 5), at most once per observer per day.
- **First date only after time:** neither may ask before game day `romance.shyMinDays` (5), before both affinities reach 8, and before they have had at least 6 conversations. After that the normal `date.ask` / `date.decide` flow applies, and the couple rule follows as usual.

## 8. Post office, letters, notice board and the Keep (owners: WP8 service, WP3 cognition, WP2 storage)

`PostOfficeService` (`src/server/player/post-office.ts`) owns letters, notices and the Keep archive. The post office works even when Laude is not in the world (for example, a config with `sim.villagers` below 12). In that case only the Laude-specific memories (§8.3) are skipped.

### 8.1 Letters

- **The player** sends `letter.send { to, text }` (≤ `NOTE_MAX_LENGTH`) while inside the post office or within 2 tiles of its door. The post box at the door accepts letters at any time.
  - `to` is any villager in the world, including visitors.
  - The letter is `posted` at once and logged by Laude (§8.3).
- **Delivery:** posted letters are `delivered` to the recipient's mailbox at each time in `post.deliveryTimes` (default `11:00` and `17:00`). The mailbox is the house door, or `hotel` for visitors. The crow caws at each delivery round that has letters.
- **Villager recipients:** read the letter on their next arrival home (the v1 door-note flow), which marks it `read`.
  - `PostOfficeService` (WP8) detects the read (recipient home and awake), marks the letter `read`, and adds the read memory of kind `note` (`meta.letterId`) with importance 6 for letters from the player and 5 otherwise. The engine then calls `mind.onLetterRead`. That hook writes no read memory. For a player letter it only queues one `letter.reply` (deduplicated per letter). The memory of having written the reply is separate and allowed. Cognition does not scan `lettersAtHome` for reads.
  - A letter from the player gets a reply through `letter.reply`. The reply is posted at once and delivered at the next round.
- **Player recipients:** the letter appears in the player's mailbox (`player_home`) and in the Letters modal. `letter.read` marks it `read`.
- **Villager-written letters (`letter.write`):** checked at 21:00, deterministic triggers. At most `post.maxVillagerLettersPerDay` (3) letters for the whole town per day, and at most 1 of them to the player:
  1. a thank-you to the player from a villager who got a gift from the player that day;
  2. a letter to a villager with affinity of at least 5 whom the writer has not talked to for 2 or more days;
  3. one shy note from Franzi to Laude (or the other way round) every 3 days or more, if they are a shy pair.

  Under load level `overloaded`, villager-written letters are skipped. They have no fallback, because they are optional.

- **Visitors:** a letter to a visitor who has left is returned to the sender with the note "moved away".
- **Lifecycle:** a letter moves through `posted → delivered → read → replied`.

### 8.2 Notice board

- **The player** posts with `notice.post { text }` (≤ 200 chars) when within 3 tiles of `notice_board`.
- **Event notices:** every scheduled non-date `VillageEvent` posts a notice from its host automatically, from a template and without the LLM: "📌 <title> at <place>, <HH:MM>. All welcome! (<host>)".
- **Expiry:** notices expire after `post.noticeTtlDays` (3) days, or when their event ends. At most `post.maxNotices` (12) are active; the oldest is removed first.
- **Reading:** a villager who passes within 3 tiles of the board reads each notice they have not read yet, as does a villager whose plan block is at `notice_board` or `post_office`. Each read gives the observation "The notice board says: <text>" (importance 4, or 5 for the player's notices). Its `meta.originId` is `notice.originId ?? notice.id`. Cognition (WP3) alone writes these read memories, from `WorldView.noticesInReach`. `PostOfficeService` (WP8) posts, expires and logs notices. `notice.originId` is Laude's log memory of the notice (§8.3) and stays unset when Laude is absent. So notices spread as gossip and can be traced.

### 8.3 Laude knows everything at once (the omniscience hook)

`PostOfficeService.log(entry)` is called synchronously for each of these:

- every door note created, read or replied to (`MindWorld.upsertNote`);
- every letter posted or replied to;
- every notice posted;
- every rumor started or hop recorded (`RumorTracker.start` / `recordHop`).

Each call does two things:

1. It appends a `KeepEntry` to the Keep. This always happens, whether or not Laude is around.
2. If `laude` is in the world, it adds an observation to Laude's memory stream through a new optional engine hook, `MindWorld.observeFor?(villagerId, obs)`. This is the only place one mind's stream is written from outside its own perception.
   - The engine routes `observeFor` through Laude's `Mind.addMemory` / `observe`, never straight into the store, so the rules below (weighting, batched embeddings, archiving) apply. No extra flag is needed beyond `meta.keepId`.
   - The kind is `heard` for rumors and `note` for the others, with `meta.keepId`.
   - Importance is set explicitly: 3, or 5 for rumors. No `importance.rate` call is made.
   - For rumors, `meta.originId` keeps the rumor's origin, so when Laude later tells someone, that counts as a real hop. The instant log itself never records a rumor hop or adds Laude to `knownBy`.
   - These memories count only 0.25× toward `reflectionThreshold`, so the flood does not trigger extra reflections.
   - Embeddings for them are batched, one request per 10 game minutes at most.

- **Forgetful:** Laude's log memories are archived (`meta.archived`) after 1 game day, so normal retrieval stops finding them.
  - When Laude answers the player (`player.reply`) or takes a conversation turn, WP3 adds up to 3 Keep entries matching the query keywords to his context ("You check the Keep: …"). The match is a deterministic keyword search via `KeepArchive.search`.
  - He shows the thought "📒 checking the Keep…".
  - He shares what he knows like any villager.
- **Writing it down:** while Laude is at the post office and not talking, each new Keep entry gives him a short cosmetic activity, "writing in the Keep 📒" (5 game minutes). It never interrupts a conversation or an event.

### 8.4 The Keep (archive)

- `KeepEntry { id, kind: 'note' | 'letter' | 'notice' | 'rumor' | 'reply', at, refId, authorId, recipientId?, text }`.
- The Keep holds at most `post.keepMax` (2000) entries; the oldest are dropped first and counted in `dropped`.
- **Opening it:** the player opens it inside the post office by clicking `keep_cupboard`, which sends `keep.open { query?, kind?, offset?, limit? }` (limit ≤ 50).
  - The server replies directly with `keep.data { entries, total, offset }`, newest first. The server rejects the command when the player is not inside the post office.
  - While the Keep modal is open, the client appends `keep.added` broadcasts.
  - Opening the Keep has no side effects; it is read-only for the player and for the sim.

## 9. New residents (owner: WP2 data, WP3 behaviour)

Two profiles are added to `data/villagers.json` at **indices 10 and 11**, right after the first ten v1 villagers. The default `sim.villagers` becomes **12**.

- The default game therefore has the v1 ten plus Laude and Franzi.
- Tests that ask for 10 villagers get exactly the v1 set, so they are unchanged.
- A user config that sets `sim.villagers: 10` runs without them. The post office still works (§8).

| Id       | Name   | Age | Occupation                    | Home           | Notes                                                                                                                                                                                             |
| -------- | ------ | --- | ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `laude`  | Laude  | 46  | Postmaster                    | `house_laude`  | Kind, meticulous, a little forgetful, shy around Franzi, loves baking and never misses a bake-off. Works at `post_office` 08:00–18:00 with lunch at the bakery. Likes: `bread`, `cake`, `flower`. |
| `franzi` | Franzi | 31  | Illustrator (draws postcards) | `house_franzi` | Shy, warm, a daydreamer. Often finds a reason to visit the post office. Likes: `flower`, `ink`, `postcard`.                                                                                       |

**Laude and bake-offs:** when a village event whose title or description matches `/bak(e|ing)/i` is scheduled, `laude` is added to its invitees (if he is present and not the host). He accepts deterministically unless he already has a date at that time. The mock's default `event.propose` is a bake-off at the square at 15:00, so this is testable.

Both profiles get sprites from the art agent (`characters/laude.png`, `characters/franzi.png`).

## 10. Forest (owners: art, WP2 animals, WP3 activities)

The forest is the district at x 96–127, y 0–59 (the railway crosses its south edge). It contains `forest` (trails), `forest_grove` (old trees and a picnic spot) and `forest_lake` (about 12×8, with ducks), and it is full of trees. It is reached from the y 7–8 promenade and from the east-west road at y 31–32.

- **Activities:** a forest walk, a picnic at the grove, feeding the ducks, and fishing at the lake (Finn). These restore `fun` and `social` like the park does.
- **Dates:** the grove and the lake are date venues (§7).
- **Hours:** the forest is always open. Plan sanitizing moves forest blocks after 22:00 home.
- **Animals:** ambient, see §3.5.

## 11. New LLM tasks

| Task             | Priority | TTL (game min)       | Load level `busy`                   | Load level `overloaded`    | Fallback                                                     |
| ---------------- | -------- | -------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `visit.greet`    | 105      | none (player-facing) | LLM                                 | LLM                        | Template greeting with the owner's name and the time of day. |
| `letter.reply`   | 90       | none (player-facing) | LLM                                 | LLM                        | Template reply quoting the first 6 words, like `note.reply`. |
| `date.decide`    | 80       | 120                  | LLM                                 | Fallback, no call          | Accept if affinity is at least 4; template reply.            |
| `visitor.create` | 75       | 240                  | LLM                                 | Fallback, no call          | The next unused profile from `data/visitors.json`.           |
| `date.ask`       | 65       | 120                  | LLM, at most 1 per villager per day | Skipped (no date is asked) | Rotating venue, the next 17:00, template invitation.         |
| `letter.write`   | 45       | 360                  | LLM                                 | Skipped                    | None (optional letter).                                      |

JSON outputs are validated. An unparseable or invalid answer counts as a fallback (`source: 'fallback'`).

- `visit.greet` → `{ "reply": string }` (≤ 200 chars). Meta: `villagerId`, `profile`, `playerName`, `houseId`, `affinity`, `now`.
- `letter.reply` → `{ "reply": string }`. Meta: `villagerId`, `profile`, `letterText`, `fromName`, `now`.
- `letter.write` → `{ "text": string }` (≤ 400 chars). Meta: `villagerId`, `profile`, `toId`, `toName`, `reason: 'thanks' | 'missYou' | 'shy'`, `now`.
- `visitor.create` → `{ "name", "age", "occupation", "bio", "traits": string[], "sprite", "origin", "reason", "likes": string[] }`. Meta: `existingNames`, `sprites`, `now`.
- `date.ask` → `{ "text": string, "locationId": string, "start": "HH:MM" }`. Meta: `villagerId`, `partnerId`, `partnerName`, `venues: [{ id, name }]`, `shy`, `now`.
- `date.decide` → `{ "accept": boolean, "reply": string }`. Meta: `villagerId`, `askerId`, `askerName`, `affinity`, `locationId`, `start`, `text`.

The mock provider (WP6) answers all six deterministically:

- greetings and letter replies name the other person and quote the letter;
- `letter.write` produces a short template;
- `visitor.create` returns a pool-style visitor with a unique name;
- `date.ask` picks the first venue at 17:00;
- `date.decide` accepts if `affinity >= 4`.

**Call budget per game day** (12 residents plus up to 4 visitors):

- v1 needed about 120–180 calls for 10 villagers.
- The extra villagers add about 6 × 15 = 90 calls (plans, turns, summaries).
- `visitor.create` adds 1–2, `date.ask` plus `date.decide` 2–6, `letter.*` up to 4, and `visit.greet` one per player visit.
- That makes about 230–300 calls in total. On a slow local model, the load levels cut this as in v1, and the new optional tasks degrade first: date asks and villager-written letters are skipped under `overloaded`.

## 12. Configuration additions

All new sections have defaults, so existing `config.json` files keep working. Two v1 defaults change: `sim.villagers` goes from 10 to 12, and `world.llmVisitors` is new.

```jsonc
{
  "sim": { "villagers": 12 },
  "zoo": { "openTime": "08:00", "closeTime": "21:00" },
  "farm": {
    "enabled": true,
    "capPerSpecies": 10,
    "breedChance": 0.5,
    "butcherTime": "16:00",
    "butcherAtCount": 8,
  },
  "train": { "enabled": true, "arrivals": ["10:00", "16:00"], "dwellMinutes": 20 },
  "visitors": { "enabled": true, "min": 2, "max": 4, "stayDays": [1, 3] },
  "hotel": { "rooms": 6 },
  "romance": {
    "enabled": true,
    "minAge": 18,
    "crushAffinity": 6,
    "coupleAffinity": 7,
    "datesForCouple": 2,
    "shyMinDays": 5,
    "shyVisitChance": 0.7,
    "shyMaxTurns": 3,
  },
  "interiors": { "visitAffinity": 1, "snoopAffinity": -2 },
  "post": {
    "enabled": true,
    "deliveryTimes": ["11:00", "17:00"],
    "maxVillagerLettersPerDay": 3,
    "noticeTtlDays": 3,
    "maxNotices": 12,
    "keepMax": 2000,
  },
  "forest": { "enabled": true },
  "world": { "llmVisitors": true },
}
```

Schema rules:

- `farm.capPerSpecies` is an integer from 1 to 10, so config cannot raise the hard cap.
- `visitors.max` ≤ `hotel.rooms`, and `visitors.min` ≤ `visitors.max`.
- `post.keepMax` is at most 5000.
- The observer API keys (`observer.*`, see `specs/20-observer-api.md`) land separately on v1 main and are kept.

## 13. Client (WP4a renderer, WP4b UI)

- **Camera:** handles the 128×60 world. `plaza` stays the default view, and the Map modal lists all scenes. Fit and overview may use fractional zoom.
- **Rendering:**
  - Pre-render the static layers in chunks (for example 32×32 tiles) and draw only the visible chunks.
  - Draw animals from `tick.animals` frames, with walk and idle animation and baby sprites. Birds and the flying crow are drawn above the overhead layer.
  - Animate rides from `RideState` and the train from `TrainState`. The ice cream trucks are static sprites.
  - Show letter icons on doors with undelivered or unread letters, as for v1 notes.
- **Interiors:**
  - While `player.inside` is set, show the interior template as its own view, with the world dimmed behind it.
  - Draw the player at `inside.pos` and residents who are home at the interior spots, and show an "Exit" button.
  - Clicking a door opens the door modal with "Go inside" (sends `player.enter`) and "Leave a note".
  - In the post office, clicking `keep_cupboard` opens the Keep.
- **UI:**
  - **Animal card** when clicking an animal: species, name, stage and age in days; forest animals and the crow show only species and name.
  - **Inspector:** romance lines (§7) and a "Visitor · leaves Tue 16:00" badge for visitors.
  - **Stats card:** a "🚂 Next train 16:00 · Hotel 3/6" line.
  - **Buttons:** buy buttons at food venues and the farm shop, and "Ride (4 gold)" at rides.
  - **Toolbar:** a "Train" button (`world.trigger { kind: 'train' }`) that brings the next train now.
  - **Letters modal** (dock): inbox, sent, and "Write a letter" (enabled at the post office).
  - **Notice board modal** (click the board): the notices, plus "Post a notice" when the player is near it.
  - **Keep modal:** search box, kind filter, paging, and entries with time, kind, from → to and text.

## 14. Protocol v2 (`PROTOCOL_VERSION = 2`)

The v2 types are on `main` already, but `PROTOCOL_VERSION` stays 1 until the first WP2 PR that sends v2 messages. That PR bumps it to 2 and updates the two smoke tests that assert the version.

New optional `WorldSnapshot` fields: `animals`, `rides`, `train`, `visitors`, `hotel`, `romances`, `houseVisits`, `stock`, `letters`, `notices`, and `keepSize` (the Keep itself is fetched on demand). `WorldMap` gains the optional fields `districts`, `interiors` and `railway`.

Server → client:

| Message                    | Payload                                                                                | When                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tick` (extended)          | `animals?: AnimalFrame[]`                                                              | Only animals that moved or changed status since the last tick.               |
| `animals.changed`          | `added: AnimalState[]`, `removed: { id, species, reason }[]`, `updated: AnimalState[]` | Births, deaths, butcher, stage changes.                                      |
| `animal.emote`             | `animalId`, `emote`                                                                    | For example, the crow's caw.                                                 |
| `ride.updated`             | `ride: RideState`                                                                      | The ride's state changes.                                                    |
| `train.updated`            | `train: TrainState`                                                                    | Each train state change.                                                     |
| `hotel.updated`            | `hotel: HotelState`                                                                    | Check-in or check-out.                                                       |
| `visitor.updated`          | `visitor: VisitorInfo`                                                                 | Arrival, check-in, leaving. Profiles still come through `villagers.changed`. |
| `romance.updated`          | `romance: Romance`                                                                     | Crush, date, couple, ended.                                                  |
| `visit.updated`            | `visit: HouseVisit`                                                                    | Entry, greeting text, noticed.                                               |
| `stock.updated`            | `stock: FoodStock`                                                                     | Any stock change.                                                            |
| `letter.updated`           | `letter: Letter`                                                                       | Posted, delivered, read, replied, returned.                                  |
| `notice.updated`           | `notice: Notice`, `removed?: boolean`                                                  | Posted, expired.                                                             |
| `keep.added`               | `entry: KeepEntry`                                                                     | Each new Keep entry.                                                         |
| `keep.data` (direct reply) | `entries: KeepEntry[]`, `total`, `offset`                                              | The reply to `keep.open`.                                                    |
| `inspect.data` (extended)  | `romance?: Romance \| null`, `visitor?: VisitorInfo \| null`                           | —                                                                            |

Client → server: `player.enter { locationId }`, `player.exit {}`, `player.ride { locationId }`, `player.buy { locationId, itemId }`, `letter.send { to, text }`, `letter.read { letterId }`, `notice.post { text }` and `keep.open { query?, kind?, offset?, limit? }`.

`world.trigger` accepts the new kind `train`. The new `WorldEventKind` values are `train`, `date`, `couple` and `farm`.

## 15. Persistence and save migration (WP5)

`SAVE_SCHEMA_VERSION = 2`. `SaveData` gains these optional fields: `animals` (farm and zoo only), `farm` (`FarmState`), `train`, `visitors`, `hotel`, `romances`, `houseVisits`, `stock`, `letters`, `notices` and `keep`. Rides and ambient animals are not saved; rides restart idle, and ambient animals are reseeded.

`MIGRATIONS[1]` (`src/server/persistence/migrations.ts`) upgrades a v1 save:

- It adds these defaults: `animals: []`, `farm: { seeded: false, nextSeq: 1, lastLifecycleDay: null, lastButcherDay: null }`, `visitors: []`, `hotel: null`, `romances: []`, `houseVisits: []`, `stock: {}`, `train: null`, `letters: []`, `notices: []`, `keep: []`, and `player.inside: null`.
- Everything else is kept as is. v1 coordinates stay valid because the town keeps its position.

On restore:

- The engine seeds zoo and farm animals when `farm.seeded` is false.
- It builds the hotel from config when `hotel` is null, and schedules the next train from the current time.
- It applies the romance seeds that are missing from `romances`.
- **Move-in:** resident profiles that are in the configured profile list but not in the save (Laude and Franzi for a v1 save) are spawned at home, with a toast "🏡 Laude and Franzi moved in near the bakery!".

A v1 save therefore resumes as a v2 world with the same villagers, memories, notes, rumors, gold and decorations.

Determinism across a restore: every saved field restores exactly, including each animal's `pos` at the moment of the save. Lifecycle outcomes (births, deaths, the butcher, products) after a restore are the same as in an uninterrupted run. Animal wandering steps after a restore are not part of the contract, because the wander RNG restarts from `sim.seed`, so later positions may differ from an uninterrupted run while staying inside the pen.

## 16. Performance budgets

| What                                         | Budget                                                | How measured                                                           |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Sim step (20 villagers + 80 animals, 128×60) | p95 ≤ 4 ms, max ≤ 20 ms                               | `perf-v2.test.ts`: 1 game day, virtual clock, mock provider, CI runner |
| A* worst case across the map                 | ≤ 4 ms per query                                      | Unit benchmark over 100 random entry pairs                             |
| `tick` message                               | ≤ 12 KB p95                                           | Measured in `perf-v2.test.ts`                                          |
| `hello` message                              | ≤ 900 KB                                              | Server smoke test                                                      |
| Full v2 acceptance day (mock)                | ≤ 60 s wall time on CI                                | Vitest timing                                                          |
| Client frame (overview, 1440×900)            | ≥ 50 fps on a laptop                                  | Browser check (agent-browser), reported                                |
| Save file                                    | ≤ 150 KB more than v1 for the same day, Keep included | Persistence test                                                       |

The sim step p95 is measured in wall time; the maxes (sim step, A*, the animal benchmark) in main-thread CPU time, cold first step included, because time the OS or the VM host keeps the thread off the CPU is not the code's cost. A\* queries are timed in batches of 10, as one query is shorter than the CPU clock's resolution. A step whose wall time is over 20 ms fails only if a rerun of the day has one too, so a host pause passes and a step that blocks the thread fails. Where Node has no `process.threadCpuUsage`, the maxes use wall time and a failing run is repeated once.

A* may cache paths between location entries, because collision is static. Animals never path-find.

## 17. Observer API (v2 extension)

The read-only observer API (`specs/20-observer-api.md`, WP2) lands on v1 main first. In v2 it must also expose the new features. It stays read-only: no side effects on the sim and no LLM calls.

- **Town log event types** (`/api/events`), in addition to the v1 types:
  - romance: `crush`, `date_asked`, `date`, `date_missed`, `couple`, `romance_ended`;
  - post: `letter_sent`, `letter_delivered`, `letter_read`, `letter_replied`, `notice_posted`, `keep_logged`;
  - visitors and the train: `train_arrived`, `train_departed`, `visitor_arrived`, `visitor_checked_in`, `visitor_left`;
  - animals: `animal_born`, `animal_died`, `animal_butchered`;
  - interiors: `house_visit`, `snooping`;
  - rides and food: `ride`, `purchase`.

  The existing `romance` type stays, as a catch-all for romance changes.

- **`/api/state`:**
  - `agents[].kind` is `villager | visitor | stranger | player`.
  - New top-level fields: `train` (state and next arrival), `hotel` (occupancy and rooms), `visitors` (ids and departure times), `farm` (counts per species) and `stock`.
- **`/api/agents/{id}`:**
  - `relationships[].kind` includes `crush`, `shy_crush`, `dating` and `partner`.
  - New fields: `romance` (stage, partner, dates), `visitor` (for visitors) and `inside` (for the player).
- **New read-only endpoints:**
  - `GET /api/letters?agent=&since=&limit=` → `[{ ts, day, time, from, to, text, status, reply? }]`;
  - `GET /api/notices` → the active notices;
  - `GET /api/keep?since=&kind=&q=&limit=` → Keep entries;
  - `GET /api/animals?group=&species=` → `[{ id, species, group, name?, stage?, ageDays?, location, x, y, status }]`.
- **`/api/notes`** stays door notes only. Letters have their own endpoint.

## 18. Acceptance criteria AC8+ (verification on the mock)

Unless stated otherwise, all of these run in CI with the mock provider and the v2 defaults. AC1–AC7 and §14.1 of v1 stay required.

| #    | Criterion                                                                                                 | Automated check (CI, mock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC8  | One contiguous 128×60 map with districts, reachable everywhere; the v1 town is unchanged                  | `map-v2.test.ts`:<br>• the size is 128×60;<br>• the 7 districts cover the map, and only `post_row` overlaps others;<br>• every §2.1 id exists with the right kind and lies in its district;<br>• every location entry is reachable from `square` by A*;<br>• the v1 locations match a committed fixture of v1 ids, rects, entries and doors exactly, and every v1 town tile (all four layers, building tiles included) equals the v1 map outside the two §2 exceptions;<br>• the scenes (the v1 ones plus 8 new ones) lie inside the map;<br>• enclosures and pastures meet the minimum sizes;<br>• every house except `player_home` has an `interiorId` that resolves, and the post office interior has `keep_cupboard`.                                                                                                                                                                                                                                                                                                                                                                     |
| AC9  | A zoo with ≥ 10 species, rides, a burger joint and ice cream; villagers go on outings                     | `zoo.test.ts`:<br>• all 12 species are present, with at least one animal each;<br>• over 2 virtual days, every zoo animal stays inside its `pen` at every step;<br>• with a scripted plan, 3 villagers queue for the rollercoaster, ride one cycle (status and fun gain) and leave;<br>• a 21:00 block at a ride is moved to an open place;<br>• over 3 default days, at least one villager rides a ride and one eats at `burger_joint` or an ice cream truck.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AC10 | Farm animals breed, produce, die of old age and go to the butcher; hard cap of 10 per species             | `farm.test.ts` (AnimalSim unit, seeded, 60 game days in 1-minute steps):<br>• never more than 10 alive per species at any step;<br>• for each species, at least 1 birth, 1 old-age death and 1 butcher removal;<br>• products appear daily;<br>• the butcher adds `burger` stock and emits a toast with no graphic words (checked against a word blocklist).<br>Engine level, over 5 days: the same invariants hold and the toasts reach clients. The cap also holds after loading a save that has 10 of a species.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC11 | Animals and the other deterministic systems never wait on the LLM                                         | `determinism-v2.test.ts`: run 3 game days twice with the same seed, once with the fast mock and once with a mock that never answers.<br>• Farm and zoo animals, the forest animals, the crow, the farm state, stock, the train, the hotel, letter delivery times and notice expiry are identical at every game hour.<br>• The clock keeps advancing (the wake-up hold ends by timeout).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AC12 | Visitors arrive by train, stay at the hotel 1–3 days, join town life and leave by train                   | `visitors.test.ts`, over 4 days:<br>• trains reach `boarding` at every scheduled time;<br>• after the first train, the visitor count stays within 2–4 (checked every game hour);<br>• each visitor checks in within 2 game hours of arrival, has a room, has at least one conversation with a resident, and is removed at a train departure 1–3 days after arrival;<br>• occupancy never exceeds the room count, and there are never more than 20 villagers in total.<br>With a mock that never answers, visitors still arrive, using fallback profiles (`source: 'fallback'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC13 | Visitors gossip                                                                                           | `visitor-gossip.test.ts`: inject a distinctive fact into a visitor at 09:00 on their first full day. By 20:00, a resident other than the visitor says it, and a resident has a memory with that `originId` and `heardFrom` set to the visitor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AC14 | The player can enter houses at any time; owners greet and remember; snooping lowers affinity              | `interiors.test.ts`:<br>(a) owner home and awake → `player.updated.inside` is set, the owner greets with a bubble (`visit.greet`), the owner has a memory of the visit and affinity +1, and a second visit the same day adds nothing;<br>(b) owner away → no greeting; on the owner's return home, a snooping memory and affinity −2; a witness within 6 tiles gets an observation;<br>(c) `player.exit` puts the player on the door tile;<br>(d) the hotel lobby and the post office can be entered, with no reaction;<br>(e) with a mock that never answers, the greeting falls back within 60 game minutes with `source: 'fallback'`;<br>(f) v1 door notes still work.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AC15 | Romance: crushes, dates at fun places and couples; dates are gossip-worthy; couples show in the inspector | `romance.test.ts` (seeded, with one pair's affinities preset to 7). Every bullet below is about that preset pair; crushes between other villagers neither satisfy nor fail it. The fixture also presets the pair's recent history so that the §7 crush conditions (including two talks in the last 3 days) hold from the first night, and runs long enough for both dates:<br>• a crush forms within 3 nights in every run, whatever the seed (the §7 guarantee), and not before its conditions hold;<br>• a separate seeded rate test checks that nights 1 and 2 stay random at 0.3 (the guarantee does not raise them);<br>• `date.ask` / `date.decide` produce a `date` event at a §7 venue;<br>• both attend, and the date is `done`;<br>• a third villager has a memory about the date, and it spreads to a fourth through conversation;<br>• after the second date the pair becomes a `couple`, with a toast and a `world.event`;<br>• `inspect.data.romance.stage === 'couple'`.<br>Eligibility: a villager under 18 never gets a crush, and a visitor never becomes part of a couple. |
| AC16 | Slow-model behaviour covers the new tasks                                                                 | `slow-model-v2.test.ts`, with mock latency of 30 s per call, concurrency 1, over 1 game day:<br>• no exception, and the sim tick rate is unaffected;<br>• the load level reaches `overloaded`;<br>• `visitor.create` and `date.decide` fall back (provenance `fallback`);<br>• `date.ask` and `letter.write` are skipped;<br>• `visit.greet` and `letter.reply` still answer, either from the LLM or with a fallback, with provenance;<br>• the queue stats list the new tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC17 | v1 saves load into v2                                                                                     | `save-migration.test.ts`:<br>• a committed v1 save fixture (`test/fixtures/save-v1.json`, made with v1 main) loads, and its schemaVersion becomes 2;<br>• villagers, memories, notes, rumors, player gold and decorations are unchanged;<br>• the farm and zoo get seeded, Laude and Franzi move in (toast), and their shy-crush romance is seeded;<br>• the world runs 1 game day.<br>A v2 save round-trips animals, the farm, the train, visitors, the hotel, romances, visits, stock, letters, notices and the Keep. Saves newer than version 2 are rejected (v1 behaviour).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC18 | Performance                                                                                               | `perf-v2.test.ts` checks the §16 budgets for the sim step, A*, and the tick and hello message sizes. The browser frame rate is checked manually and reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AC19 | The UI shows the new world                                                                                | DOM tests:<br>• inspector romance lines (including the shy crush) and the visitor badge;<br>• the animal card;<br>• the train and hotel stats line;<br>• the Map modal lists the new scenes;<br>• the interior view with Exit;<br>• the Letters, Notice board and Keep modals.<br>Browser check (agent-browser): walk into a house, ride the rollercoaster, buy an ice cream, watch the train arrive, send a letter, open the Keep, and see the crow and the ducks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC20 | Letters between villagers and the player                                                                  | `letters.test.ts`:<br>• the player sends a letter to A at 09:00 at the post office; it is `posted` at once and `delivered` at 11:00;<br>• A reads it on the next arrival home (it is `read`, and A has a memory with `meta.letterId`);<br>• the `letter.reply` answer contains a keyword from the letter, is delivered at the next round, and appears in the player's mailbox; `letter.read` marks it read;<br>• `letter.send` is rejected away from the post office;<br>• over 3 days, villager-written letters respect the daily caps, and a gift that day produces a thank-you letter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AC21 | Notice board                                                                                              | `notice-board.test.ts`:<br>• a scheduled event posts a notice from its host automatically;<br>• a player notice is posted when the player is near the board and rejected when far away;<br>• a villager who passes the board gets a memory of each notice, with the notice's `originId`;<br>• by the end of the day, a villager who never passed the board knows the player's notice through gossip;<br>• notices expire after 3 days, and at most 12 are active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AC22 | Laude knows every note, letter, notice and rumor at once; the Keep archives them                          | `laude-keep.test.ts`:<br>• within the same sim step as each event, Laude has a memory with `meta.keepId`, and the Keep has an entry, for a door note, a letter, a notice and a rumor hop;<br>• the rumor's `knownBy` and hops are unchanged by the log;<br>• when Laude later tells the rumor to B, it counts as a real hop;<br>• with `sim.villagers: 10` (no Laude), the Keep still logs everything;<br>• `keep.open` inside the post office returns entries newest first with search and kind filters; outside it is rejected;<br>• Laude's log memories are archived after a day, and his `player.reply` prompt meta contains matching Keep entries;<br>• a whole day of logging adds no `importance.rate` calls.                                                                                                                                                                                                                                                                                                                                                                         |
| AC23 | The crow on the post office roof                                                                          | `crow.test.ts`:<br>• the crow is always on a perch tile, or flying within 6 tiles of the post office;<br>• it sleeps on the perch from 20:00 to 06:00;<br>• it caws when a letter is posted and when the player approaches, with a 30-minute cooldown;<br>• its behaviour is identical with a mock that never answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AC24 | Laude and Franzi live on the bakery road; Laude goes to bake-offs                                         | `new-residents.test.ts`:<br>• with the defaults (12 villagers), `laude` and `franzi` exist and live in `house_laude` and `house_franzi`;<br>• `house_franzi` is adjacent to `post_office`; both houses face the bakery road (their entries lie on y 6–8) and both entries are reachable from the bakery entry by A* (no distance bound);<br>• with `villagers: 10`, the v1 set is unchanged;<br>• on a mock day, the default bake-off has Laude among its invitees and attendees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AC25 | Laude and Franzi's slow-burn shy crush                                                                    | `shy-romance.test.ts`, 7 seeded days:<br>• the seed romance is a `crush` with `shy: true` from both sides;<br>• Franzi visits the post office on at least 4 of the 7 days;<br>• their conversations have at most 3 turns;<br>• at least one other villager has a memory about them at the post office;<br>• no date is asked before day 5, or while either affinity is below 8.<br>With scripted affinities of 8 and 6 chats by day 5, a date is asked and accepted by day 7, and the inspector shows "Shy crush".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC26 | The forest with a grove, a lake and small animals                                                         | `forest.test.ts`:<br>• `forest`, `forest_grove` and `forest_lake` exist in the forest district, and the lake water is blocked with walkable shore spots;<br>• at least 7 forest species are present, and each animal stays in its pen at every step;<br>• ducks are on the water by day and on the shore at night;<br>• hedgehogs and foxes are active only in their hours;<br>• animals move away from a villager within 3 tiles;<br>• over 3 days, at least one villager walks, picnics or fishes in the forest and gets an animal observation, with no `importance.rate` call for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC27 | The observer API exposes the v2 world                                                                     | `observer-v2.test.ts`:<br>• over 3 days, `/api/events` contains each new event type that occurred (visitor_arrived, train_arrived, animal_born, letter_sent, notice_posted, date or couple in the romance-scripted world);<br>• `/api/letters`, `/api/notices`, `/api/keep` and `/api/animals` return the documented shapes;<br>• agents carry a `kind`, and romance relationship kinds appear;<br>• all of it stays GET-only, with no change to the sim (the snapshot is identical before and after a full crawl).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 19. Work packages (v2)

Each WP works in its own branch, `wp<N>/v2-<topic>`, and opens PRs into `main`. The integrator merges them in dependency order once CI is green. Contract changes go through small WP0 PRs. Stubs for every interface below are on `main`, added by the WP0 contracts PR.

| WP                                   | Owns                                                                                                                                                                                                                                                       | Depends on                | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art (visual agent)**               | `assets/**`, the tiles and layout of `data/map/village.json` (with WP2), interior templates                                                                                                                                                                | spec §2, style guide      | • A 128×60 map with the §2.1 ids and minimum sizes.<br>• Interiors: 2–3 house templates, the hotel lobby, and the post office with `keep_cupboard`.<br>• Sprites: cow, sheep and chicken with young variants; the 12 zoo species; the 7 forest species and the crow (perched, hop, flying); the train; ride animations (rollercoaster, Ferris wheel, carousel); the ice cream truck; the burger joint, hotel, station, post office and notice board; forest trees, grove and lake; food icons (burger, ice_cream, milk, egg, wool, cheese); letter and notice icons; Laude, Franzi, and at least 6 visitor sprites.                                                  |
| **WP2 Sim**                          | `src/server/sim/**` (new: `animals.ts`, `rides.ts`, `train.ts`, interior movement), `src/server/net/**` (including the observer API), `data/map/**` locations and scenes, `data/villagers.json`, `data/romance.json`, `data/zoo.json`, `data/ambient.json` | contracts PR, art map     | • AnimalSim (§3: farm, zoo, forest, crow, caps, the butcher walk), RideState (§4) and TrainService (§5.1).<br>• Visitor spawn and despawn through `VisitorService`; the move-in of missing residents.<br>• Player movement inside interiors (§6).<br>• Storage and broadcasts for romances, visits, stock, letters, notices and the Keep; the `observeFor` hook; the new protocol messages and command validation; save and restore of the v2 fields.<br>• A* on 128×60 within budget; the profiles of Laude and Franzi; observer API v2 (§17).<br>• Tests for AC8, AC9 (pens), AC10 (engine level), AC11, AC18, AC23, AC24 (data) and AC27.                         |
| **WP3 Cognition**                    | `src/server/cognition/**`                                                                                                                                                                                                                                  | contracts PR, WP2 hooks   | • The `visit.greet` greeting; visitor minds and seed memories.<br>• `romance.ts`: crush and couple rules, `date.ask` / `date.decide`, date memories, witness observations, shy-pair rules (§7.1).<br>• Plan sanitizing for opening hours, the new location kinds, the forest, and Franzi's post office visits.<br>• The Laude bake-off rule; Laude's Keep lookup in prompts and his forgetful archiving; `letter.reply` / `letter.write`; reading notices; forest animal observations.<br>• Prompts that know the new places; load-level handling for the new tasks.<br>• Tests for AC13, AC15, AC16 (cognition side), AC22 (memory side), AC24 (bake-off) and AC25. |
| **WP8 Player, economy, hotel, post** | `src/server/player/**`, `data/items.json`, `data/visitors.json`                                                                                                                                                                                            | contracts PR, WP2 hooks   | • `FarmEconomy` (§3.4) and `HotelService` (§5.3).<br>• `VisitorService` (§5.2, including `visitor.create` with the fallback pool).<br>• `HouseVisitService` (§6).<br>• `PostOfficeService` (§8: letters, delivery rounds, notices, `KeepArchive`, the `log` hook wired to notes and rumors).<br>• `player.ride` cost and `world.trigger train`.<br>• Tests for AC10 (economy), AC12, AC14, AC20, AC21 and AC22 (Keep side).                                                                                                                                                                                                                                          |
| **WP4a Renderer**                    | `src/client/render/**`, `main.ts`, `net.ts`, `state.ts`                                                                                                                                                                                                    | contracts PR, art sprites | • Chunked rendering at 128×60.<br>• Animals (including birds and the crow above the overhead layer), rides, the train, the interiors view, the new scenes, and letter icons on doors.<br>• State handling for the new messages.<br>• Client tests and a frame-rate check.                                                                                                                                                                                                                                                                                                                                                                                            |
| **WP4b UI**                          | `src/client/ui/**`, styles, `index.html`                                                                                                                                                                                                                   | contracts PR, WP4a state  | • The animal card; inspector romance lines and the visitor badge; the train and hotel stats line.<br>• Buy and ride buttons; the interior Exit button; the Train toolbar button; the new scenes in the Map modal.<br>• The Letters, Notice board and Keep modals.<br>• DOM tests (AC19).                                                                                                                                                                                                                                                                                                                                                                             |
| **WP5 Persistence** (architect)      | `src/server/persistence/**`                                                                                                                                                                                                                                | contracts PR              | The 1→2 migration (in the contracts PR), the v1 fixture, and the v2 round-trip (AC17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **WP6 Tests**                        | `test/**`, `src/server/llm/providers/mock.ts`, `scripts/live-acceptance.ts`                                                                                                                                                                                | all                       | • Mock answers for the 6 new tasks, with their meta documented.<br>• Acceptance tests AC8–AC27, skipped until their features land.<br>• Harness helpers: scripted affinities, a mock that never answers, hourly invariant checks.<br>• The live script, extended to cover visitors, dates, the butcher toast, letters and the Keep.                                                                                                                                                                                                                                                                                                                                  |
| **WP7 Docs**                         | `docs/**`, `README.md`                                                                                                                                                                                                                                     | all                       | • The user guide for the new districts, entering houses, romance, the train and hotel, the farm, the post office, letters, the notice board, the Keep and the forest.<br>• The config reference for §12, the observer API v2, an architecture update, and troubleshooting for performance.                                                                                                                                                                                                                                                                                                                                                                           |
| **WP0 Integration** (architect)      | shared contracts, CI, merges                                                                                                                                                                                                                               | —                         | • The contracts PR.<br>• The merge order: contracts → art map → WP2 → WP8 / WP3 → WP4a → WP4b → WP6 → WP7.<br>• The final strict acceptance run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Milestones:

- **M1:** the 128×60 map in the browser, with villagers and animals walking (art + WP2 + WP4a).
- **M2:** the farm lifecycle, rides, the train, the hotel and visitors (WP2 + WP8).
- **M3:** interiors, the post office, letters, the Keep, romance (including Laude and Franzi) and the new LLM tasks (WP3 + WP8 + WP4b).
- **M4:** AC1–AC27 green on the mock, then a live run.
