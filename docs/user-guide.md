# User guide

Tiny Pixel People is a small village that lives on its own. Ten villagers (up to sixteen with the
bundled profiles) wake up, plan their day with a language model, go to work, eat, chat, gossip,
throw parties and go to bed. You live there too: you have a cottage, a cat called Pip, a backpack
and some gold. You can talk to villagers, leave notes on their doors, start rumors, and stir things
up with rain or a party.

This guide assumes the game is running. If it isn't, see the [README](../README.md) quick start or
[Installation](setup/installation.md).

![The village with the HUD, stats card, LLM card, toolbar and dock](images/screenshot.png)

- [The screen](#the-screen)
- [Time and speed](#time-and-speed)
- [Moving around and the camera](#moving-around-and-the-camera)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Villagers and the inspector](#villagers-and-the-inspector)
- [Talking to villagers](#talking-to-villagers)
- [Door notes](#door-notes)
- [Rumors and the rumor tracker](#rumors-and-the-rumor-tracker)
- [Village events](#village-events)
- [World events (toolbar)](#world-events-toolbar)
- [Gold](#gold)
- [Backpack and gifts](#backpack-and-gifts)
- [Pip, your pet](#pip-your-pet)
- [Decorating your cottage](#decorating-your-cottage)
- [Mail](#mail)
- [Saving and loading](#saving-and-loading)
- [Tips](#tips)

## The screen

The village fills the window. A dark, see-through interface floats on top of it:

| Where        | What                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top left     | The HUD: `TINY PIXEL PEOPLE`, a status badge (`LIVE`, `PAUSED`, or `CONNECTING` / `OFFLINE` when the browser lost the server), the weather, the day and the clock. The rumor tracker opens below it.                                                                                        |
| Top right    | The stats card: `REAL MODEL CALLS` (calls · total time · tokens), your gold and up to three item counts, how many players are online and villagers live here, and, while calls are waiting, `N in queue · F failed`. See [Performance](setup/performance.md) for what the numbers mean.     |
| Bottom left  | The LLM card: where the villagers think. `✈ OFFLINE` with `RUNNING ON THIS MACHINE · QWEN2.5:7B VIA OLLAMA` means a local model, no internet needed; `☁ ONLINE` means a hosted API. `⚠ MODEL UNREACHABLE` means the model doesn't answer. The last line shows how long the last reply took. |
| Bottom       | The toolbar: `PAUSE`, zoom (`−`, fit, `+`), the speed buttons `1× 2× 4× 8×`, and the world event buttons. On narrower windows the event buttons show only their icons; hover for the name.                                                                                                  |
| Bottom right | The dock: `Backpack`, `Map`, `Pet`, `Decorate`, `Home`, `Mail` and `Gold`.                                                                                                                                                                                                                  |
| Right        | The inspector, when you click a villager.                                                                                                                                                                                                                                                   |

Short messages ("toasts") pop up at the bottom centre, for example `📮 Mailbox placed at your
cottage ✓`. Your conversations with villagers appear in a small dialog there too.

## Time and speed

- One game day takes 15 real minutes at 1× by default (`sim.dayLengthMinutes`). A new village starts
  at 06:00 on day 1.
- The speed buttons run the clock at 1×, 2×, 4× or 8×. `PAUSE` stops the clock and all movement (the
  button then shows `PLAY`). Language model replies already on their way still arrive while paused.
- Villagers sleep at night. Each one has its own hours: early birds get up at 05:00, late risers at
  08:00, and bedtimes are between 21:00 and 23:30. While everybody sleeps, the clock runs 6× faster on
  top of the chosen speed (`sim.nightSpeedMultiplier`), so nights pass quickly.
- **Waking up.** At 06:00 each day the clock waits until every villager's plan for the day is ready,
  so the day starts with real plans. A small banner at the top centre shows
  `🌅 Villagers are waking up… (n/m plans ready)` with a progress bar. The banner doesn't block
  the screen: you can still open the inspector and send messages, but nobody moves until the clock
  runs again. The clock goes on once every villager's plan request has finished (with a
  plan from the model, or a default plan if the model's answer couldn't be used), when the model is
  unreachable, or after 5 real minutes at most (`sim.wakeUpTimeoutSec`; `0` turns the wait off).
  Villagers still without a plan then start the day on a default plan.
- The town darkens in the evening, lamps and windows glow at night, and it gets light again in the
  morning.

At higher speeds the language model has less real time per game hour, so villagers "think slower" in
game time: a conversation takes longer, or a villager follows a simple default plan until its real
plan arrives. That's expected; apart from the short wait at 06:00, the town never waits for the
model.

## Moving around and the camera

- **Click empty ground** to walk there. Your avatar has a `★` in front of its name tag. Pip follows
  you.
- **Drag** to pan the camera; **scroll** to zoom. The toolbar `−` and `+` zoom too, and the fit button
  shows the whole town again.
- **Map** (dock) opens the scene switcher: Plaza (the whole town), Farm, Shop street, Park, Town square
  and Your home. The camera moves to the scene you pick and follows it until you pan. The Map tile
  shows the current scene, or `free` after you pan.
- **Home** (dock) jumps the camera to your cottage, the purple-roofed house at the bottom left.

## Keyboard shortcuts

| Key              | Does                                                            |
| ---------------- | --------------------------------------------------------------- |
| `Space`          | Pause / resume (when you aren't typing)                         |
| `+` / `-`        | Zoom in / out                                                   |
| `0`              | Fit the whole town                                              |
| `h`              | Show your home                                                  |
| `Escape`         | Close the open window, then the chat dialog, then the inspector |
| `Enter`          | In the inspector's text field: Say                              |
| `Ctrl/⌘ + Enter` | In the door note window: pin the note                           |

## Villagers and the inspector

Every villager shows a name tag and, when busy, a small emoji for what it is doing. Speech bubbles
appear over villagers who are talking; the full text is in the inspector. Sleeping villagers are
indoors, with a `z` over their door.

Click a villager to open the **inspector** on the right. Click `×` (or press `Escape`) to close it.
From top to bottom it shows:

- **Name**, **occupation and age**, and the villager's **traits and bio**.
- **Current thought**: what it last said, or what it is doing now.
- **Needs**: hunger, energy, social and fun, each 0–100 %. Needs drop over the day and refill with
  the right activity: eating at the café or at home, sleeping, chatting, parties, the park and
  hobbies. When a need drops very low, the villager squeezes in a short break to fix it, for example
  "grab a bite at the café".
- **Today's plan**: the day's blocks as a checklist (`☐ 07:00 🍞 bake bread at Bakery & Café`). Done
  blocks are ticked and the current one is highlighted. `· fallback` next to the title means the
  model hasn't delivered a usable plan (yet) and the villager follows a simple default. Blocks you asked for
  carry a `your request` tag.
- **Friends ❤ n**: n is the number of close friends; below are the five villagers (or you) it likes
  most, with their affinity from −10 to +10.
- A **text field** with a `Say` button, and the actions described in the next section.
- **🏠 Lives in** and **📍 Now** (what it is doing and where).
- **Recent memories · knows about you: n**: its last 10 memories, newest first. Memories that
  mention you are highlighted.

The inspector updates live while it is open.

## Talking to villagers

Open the inspector, type into the text field (up to 300 characters) and pick an action. Your avatar
first walks up to the villager if it is far away. Sleeping villagers can't be spoken to.

| Action                  | What happens                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Say** (or `Enter`)    | The chat dialog shows "… is thinking…", then the villager's answer. It remembers the chat.                                                                                                                        |
| **Ask to do it**        | A request, for example "Could you water the flowers in the park this afternoon?". The villager decides. If it agrees, the request appears in its plan with a `your request` tag, and you get gold when it's done. |
| **Tell as rumor**       | The villager hears your text as important news and may pass it on. A new rumor opens in the rumor tracker.                                                                                                        |
| **Have them talk**      | Pick a second villager in the dropdown first. The inspected villager walks over and they start a conversation right away.                                                                                         |
| **📍 Find them**        | Moves the camera to the villager and follows it.                                                                                                                                                                  |
| **🏠 Visit their home** | Walks your avatar to the villager's door and opens the door note window.                                                                                                                                          |

## Door notes

Every house has a door. Click a door (or use **Visit their home**) to open the note window, titled
`Note for <owner>'s door`. Type a note of up to 500 characters and press `📌 Pin note`.

- A paper note appears on the door while it is unread.
- The owner reads it **the next time it is home and awake**. If the owner is already at home and
  awake, it reads it right away.
- Notes matter to villagers: the owner remembers it as an important memory, may change its plans
  because of it, may tell others about it, and writes a reply that refers to what you wrote.
- When the reply is ready, the door shows a reply marker. Click the door: the window lists your
  notes with their status (`pinned, not read yet`, `read`, `replied`) and the owner's reply.
- If the model takes more than about 3 game hours to write the reply, the owner posts a simple
  reply of its own that still mentions your note. A note that was read but not answered yet (for
  example because the server was restarted in between) gets its reply the next time the owner
  comes home.
- You can pin several notes on the same door. The owner reads them oldest first.

A note is also a rumor: the rumor tracker follows it once the owner has read it.

## Rumors and the rumor tracker

Villagers pass on news when they talk. Whatever you tell a villager with **Tell as rumor**, and every
door note once it is read, is tracked as a rumor. Villagers can start rumors too, when they hear
something they find very important.

The **rumor tracker** panel (top left, yellow border) opens with the first rumor and shows the newest
one:

```
🗣 RUMOR · 4 OF 10 VILLAGERS KNOW
You said: "The baker is secretly training for a marathon."
Mia Hartley → Tom Fielding  "Did you hear? The baker is training for a marathon!"
Tom Fielding → Ivy Marlowe  "Apparently Mia's been running every morning…"
```

Each line is one hop: who told whom, and how they put it (the last six hops are shown). Retellings
drift, just like real gossip. A rumor a villager started reads `<name> started: "…"`. With more than
one rumor, a dropdown in the panel picks older ones. `×` hides the panel until the rumor spreads
further or a new one starts.

## Village events

Villagers organise small events on their own: a bake-off, a picnic, a book club. The host picks a
place and a time and invites some neighbours. Each invitee decides whether to go, based on its plans
and how much it likes the host; others hear about it through gossip and may join. When the event
starts, the guests walk there and a banner floats over the place. If nobody has proposed an event by
07:00, the best-suited villager is asked to (`events.ensureDaily`), so there is time to invite
guests even on a slow model.

Go to an event yourself and stay for at least half of it to earn gold (see [Gold](#gold)).

## World events (toolbar)

The event buttons in the toolbar shake things up. Each one shows a toast, and villagers who notice
remember it.

| Button             | What happens                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🌧 **Rain**         | It rains for 1–3 game hours. Villagers who planned to be outdoors (plaza, park, farm) go to the nearest shop or home instead, and go back to their plans when it stops. Not available while it is already raining.                   |
| 🎉 **Party**       | You throw a party at the plaza, starting in 30 game minutes and lasting 2 hours. Every villager who is awake is invited and decides whether to come. Only one party at a time.                                                       |
| 🕵 **Stranger**    | A traveller walks in from the edge of the map with a piece of news the villagers can gossip about. It leaves at 22:00 (the next evening if it arrived after 20:00). At most 20 villagers, strangers included.                        |
| 🎂 **Birthday**    | It's the birthday of the villager you are inspecting, or a random one. Everyone learns about it, and its friends are invited to a party at the Bakery & Café at 17:00 (or in 30 minutes if that's later). Once per villager per day. |
| 🗓 **Town event**   | The villager best suited to it proposes a new village event right now.                                                                                                                                                               |
| 💾 **Save replay** | Saves the game and, a second later, downloads `replay.jsonl`: a log of every conversation, event, rumor, note and world event so far.                                                                                                |

## Gold

You start with 50 gold (`economy.startGold`). The `Gold` dock tile and the stats card show how much
you have. You earn gold by:

- **Attending an event**: +10 when a village event ends and you were inside its area for at least
  half of its time (`economy.eventReward`). Your own party counts.
- **Getting help**: +12 when a villager finishes something you asked for with **Ask to do it**
  (`economy.taskReward`). The villager also likes you a little more.

You spend gold on decorations for your cottage. Gold never goes below zero, and items can't be sold.

## Backpack and gifts

Things to collect lie around the village: wild flowers 🌸, apples 🍎, seed packets 🌱, shiny pebbles
💎, bread 🍞 and honey jars 🍯. **Walk onto an item** to pick it up. Picked spots grow back every 3
game hours (`economy.itemRespawnGameMinutes`).

The `Backpack` dock tile (or `Gold`) lists what you carry. To give a gift, first click the villager
so its inspector is open, then open the backpack and press `🎁 Gift` next to the item. Your avatar
walks over, the villager remembers the gift, likes you more (even more if it's something it loves),
and thanks you in the chat dialog.

## Pip, your pet

Pip is your orange cat. Pip follows you within a couple of tiles, wanders around when you stand
still, and stays close while you're at home. Villagers notice Pip and talk about it.

The `Pet` dock tile opens Pip's window:

- **❤ Pet Pip**: a little heart.
- **✋ Stay** / **🐾 Follow me**: Pip stays where it is, or follows you again.
- **Rename**: type a new name (up to 20 characters) and press `Rename`.

The starting name comes from `player.petName`.

## Decorating your cottage

The `Decorate` dock tile opens a grid of ten decorations for your cottage. Each one is bought once
with gold; after that, clicking it puts it away or places it again for free. Cards you can't afford
yet are dimmed.

| Decoration    | Cost |
| ------------- | ---- |
| Welcome rug   | 6    |
| Porch cushion | 6    |
| Flower vase   | 8    |
| Lanterns      | 10   |
| Flower pots   | 8    |
| Garden bench  | 12   |
| String lights | 15   |
| Mailbox       | 6    |
| Flag          | 6    |
| Bird bath     | 10   |

A card shows its price, `Owned · place` once bought, or `Placed ✓`. Placed items appear at your
cottage (press `Home` to look). Villagers who walk past your cottage notice new decorations and
remember them, so they may bring them up later.

## Mail

The `Mail` tile opens your mailbox, and so does clicking your own door. It is meant for letters
villagers leave for you once a mailbox decoration is placed. In this version villagers don't write
letters yet, so the mailbox stays empty.

## Saving and loading

- The game **saves automatically** every 60 game minutes (`persistence.autosaveGameMinutes`) and
  when you stop the server with `Ctrl+C`.
- **💾 Save replay** saves right away and downloads the replay log.
- When you start the server again, it **loads the last save** and the village carries on where it
  stopped (`persistence.loadOnStart`). The log says `resuming save "default" from …`.
- To **start a new village**, run `npm start -- --new`. The log says
  `starting new world (save "default")`. The existing save is ignored and gets overwritten at the
  next save; `replay.jsonl` keeps growing. To keep the old village, copy its
  folder first or use another slot.
- Saves live in `saves/<slot>/`: `world.json`, one memory file per villager in `memories/`, and
  `replay.jsonl`. Use `persistence.slot` to keep several villages side by side, for example
  `"slot": "experiment"`.

## When the model is slow

The village adapts on its own when the model falls behind; there is nothing to configure. It
measures how long answers take in game time and works in one of three modes:

- **Normal**: everything as described in this guide.
- **Busy** (answers take about 12 game minutes or more): conversations are at most 4 lines and
  mostly happen when someone has news to share. Villagers skip optional model work: no plan
  revisions (instead, a villager with news spends 45 minutes at a meeting place to pass it on), no
  reflections, and memories, conversations and the day are summarised by simple rules.
- **Overloaded** (about 35 game minutes or more): only villagers with news start conversations,
  at most 3 lines. The first line with news still goes to the model; the rest are canned
  (`Did you hear? …`, `Really? …? I had no idea!`), so gossip still spreads. Invitees decide about events by a simple rule (how much they like the host
  and whether they're free).

In every mode your chats and door-note replies come first, followed by today's plans for villagers
still on a default plan, news being passed on, and the day's event. Each
villager plans tomorrow in the evening, about 90 minutes before bedtime, while the model is less
busy (except when overloaded). The mode recovers as soon as answers come back faster. For how to
make a slow machine keep up, see [Performance and slow hardware](setup/performance.md).

## Tips

- To watch gossip spread, tell a rumor in the morning, set the speed to 4×, and keep the rumor
  tracker open. By evening several villagers usually know.
- If replies feel slow, use a longer day (`sim.dayLengthMinutes: 30`) or a smaller model. See
  [Troubleshooting](troubleshooting.md).
- The LLM card shows which model is running. To try another one, change `llm.model` in `config.json`
  and restart; see [Providers](setup/providers.md).
