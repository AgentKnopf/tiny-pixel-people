# User guide

Tiny Pixel People is a small village that lives on its own. Ten villagers (up to twenty) wake up,
plan their day with a language model, go to work, eat, chat, gossip, throw parties and go to bed.
You live there too: you have a cottage, a cat called Pip, a backpack and some gold. You can talk to
villagers, leave notes on their doors, start rumors, and stir things up with rain or a party.

This guide assumes the game is running. If it isn't, see the [README](../README.md) quick start or
[Installation](setup/installation.md).

- [The screen](#the-screen)
- [Time and speed](#time-and-speed)
- [Moving around and the camera](#moving-around-and-the-camera)
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
- [Saving and loading](#saving-and-loading)
- [Tips](#tips)

## The screen

The village fills the window. A dark, see-through interface floats on top of it:

| Where        | What                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top left     | The HUD: `TINY PIXEL PEOPLE`, a `LIVE` badge, the weather, the day number and the clock. The rumor tracker opens below it.                                                              |
| Top right    | The stats card: how many real model calls were made, their total time and tokens, how many villagers live here, your gold and item counts.                                              |
| Bottom left  | The LLM card: which provider and model the villagers run on, for example `QWEN2.5:7B VIA OLLAMA`, and how long the last reply took. It shows `OFFLINE` when the model can't be reached. |
| Bottom       | The toolbar: pause, zoom (`−`, fit, `+`), the speed buttons `1× 2× 4× 8×`, and the world event buttons.                                                                                 |
| Bottom right | The dock: `Backpack`, `Map`, `Pet`, `Decorate`, `Home` and `Gold`.                                                                                                                      |
| Right        | The inspector, when you click a villager.                                                                                                                                               |

Short messages ("toasts") pop up at the bottom centre, for example `📮 Mailbox placed at your
cottage ✓`.

## Time and speed

- One game day takes 15 real minutes at 1× by default (`sim.dayLengthMinutes`). The game starts at
  06:00 on day 1.
- The speed buttons run the clock at 1×, 2×, 4× or 8×. `⏸ PAUSE` stops the clock and all movement.
  Language model replies that are already on their way still arrive while paused.
- Villagers sleep at night (usually 22:00 to 06:00). While everybody sleeps, the clock runs 6×
  faster on top of the chosen speed (`sim.nightSpeedMultiplier`), so nights pass quickly.
- The town darkens from about 18:00 to 20:00, lamps and windows glow at night, and it gets light
  again from about 05:00 to 07:00.

At higher speeds the language model has less real time per game hour, so villagers may think
"slower" in game time: a conversation can take longer, or a villager follows a simple default plan
until its real plan arrives. That's expected; the town never waits for the model.

## Moving around and the camera

- **Click empty ground** to walk there. Your avatar has a `★` in front of its name tag.
- **Zoom** with `−` and `+` in the toolbar; the fit button shows the whole town again.
- **Map** (dock) opens the scene switcher: Plaza (the whole town), Farm, Shop street, Park, Town
  square and Your home. The camera moves to the scene you pick and follows it. Click empty ground
  to walk; the camera keeps following the scene.
- **Home** (dock) jumps the camera straight to your cottage, the purple-roofed house at the bottom
  left.

## Villagers and the inspector

Every villager shows a name tag and, when busy, a small emoji for what it is doing. Speech bubbles
appear over villagers who are talking; the full text is in the inspector.

Click a villager to open the **inspector** on the right. Click `×` to close it. From top to
bottom it shows:

- **Name and occupation**, and the villager's **bio** as a quote.
- **Current thought**: what it last said, or what it is doing now.
- **Needs**: hunger, energy, social and fun, each 0–100 %. Needs drop over the day and refill with
  the right activity: eating at the café, bakery or at home; sleeping; chatting; parties, the park
  and hobbies. When a need drops very low (below 20 %), the villager squeezes in a short break to
  fix it, for example "grab a bite at the café".
- **Today's plan**: the day's blocks as a checklist. Done blocks are ticked and the current one is
  highlighted.
- **Friends**: the villagers it likes most.
- A **text field** with a `Say` button and the actions described in the next section.
- **Lives in** and **Now** (where it is and what it is doing).
- **Recent memories**: its last 10 memories, including what it knows about you.

The inspector updates live while it is open.

## Talking to villagers

Open the inspector, type into the text field (up to 300 characters) and pick an action. Your
avatar first walks up to the villager if it is far away. Sleeping villagers can't be spoken to.

| Action                  | What happens                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Say**                 | The villager answers you in a speech bubble and remembers the chat.                                                                                                                                        |
| **Ask to do it**        | A request, for example "Could you water the flowers in the park this afternoon?". The villager decides whether to do it. If it agrees, the request shows up in its plan, and you get gold when it is done. |
| **Tell as rumor**       | The villager hears your text as an important piece of news and may pass it on. A new entry opens in the rumor tracker.                                                                                     |
| **Have them talk**      | Pick a second villager from the dropdown. The first one walks over and they start a conversation right away.                                                                                               |
| **📍 Find them**        | Moves the camera to the villager.                                                                                                                                                                          |
| **🏠 Visit their home** | Walks your avatar to the villager's door and opens the door note window.                                                                                                                                   |

## Door notes

Every house has a door. Click a door (or use **Visit their home**) to open the note window, type a
note of up to 500 characters and press `Pin note`.

- A small paper icon appears on the door while the note is unread.
- The owner reads it **the next time it comes home** while awake, not before. If the owner is at
  home and awake when you pin it, it may read it right away.
- Notes matter to villagers: the owner remembers it as an important memory, may change its plans
  because of it, may tell others about it, and writes a reply that refers to what you wrote.
- When the reply is ready the door shows a ✉ icon. Click the door to read the note and the reply;
  the owner's inspector shows it too.
- You can pin several notes on the same door. The owner reads them oldest first.

A note is also a rumor: the rumor tracker follows it once the owner has read it.

## Rumors and the rumor tracker

Villagers pass on news when they talk. Whatever you tell a villager with **Tell as rumor**, and
every door note once it is read, is tracked as a rumor.

The **rumor tracker** panel (top left, yellow border) shows the newest rumor:

```
🗣 RUMOR · 4 OF 10 VILLAGERS KNOW
You said: "The baker is secretly training for a marathon."
Mia → Tom   "Did you hear? The baker is training for a marathon!"
Tom → Ada   "Apparently Mia's been running every morning…"
```

Each line is one hop: who told whom, and how they put it. Retellings drift, just like real gossip.
You can dismiss the panel and pick older rumors from its dropdown. Villagers can start rumors too,
when they hear something they find very important.

## Village events

Villagers organise small events on their own: a bake-off, a picnic, a book club. The host picks a
place and a time and invites some neighbours. Each invitee decides whether to go, based on its
plans and how much it likes the host; others hear about the event through gossip and may join.
When the event starts, the guests walk to the place and a marker floats over it. At least one event
is proposed each day (`events.ensureDaily`).

Go to an event yourself and stay for at least half of it to earn gold (see [Gold](#gold)).

## World events (toolbar)

The event buttons in the toolbar let you shake things up. Each one shows a toast, and the villagers
who notice remember it.

| Button             | What happens                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🌧 **Rain**         | It rains for 1–3 game hours. Villagers who planned to be outdoors (plaza, park, farm) go to the nearest shop or home instead and return to their plans when it stops. Not available while it is already raining.                      |
| 🎉 **Party**       | You throw a party at the plaza, starting in 30 game minutes and lasting 2 hours. Every villager who is awake is invited and decides whether to come. Only one party at a time.                                                        |
| 🕵 **Stranger**    | A travelling visitor walks in from the edge of the map, carrying a piece of news the villagers can gossip about. The stranger leaves at 22:00 (the next evening if it arrived after 20:00). At most 20 villagers, strangers included. |
| 🎂 **Birthday**    | It's somebody's birthday: the villager you are inspecting, or a random one. Everyone learns about it, and the villager's friends are invited to a party at the café at 17:00 (or 30 minutes from now if that's later).                |
| 🗓 **Town event**   | The villager best suited to it proposes a new village event right now.                                                                                                                                                                |
| 💾 **Save replay** | Saves the game and downloads `replay.jsonl`, a log of every conversation, event, rumor, note and world event so far.                                                                                                                  |

## Gold

You start with 50 gold (`economy.startGold`). The `Gold` dock tile and the stats card show how
much you have. You earn gold by:

- **Attending an event**: +10 when a village event ends and you were inside its area for at least
  half of its time (`economy.eventReward`). Your own party counts.
- **Getting help**: +12 when a villager finishes something you asked for with **Ask to do it**
  (`economy.taskReward`). The villager also likes you a little more.

You spend gold on decorations for your cottage. Gold never goes below zero, and items can't be
sold.

## Backpack and gifts

Things to collect lie around the village: wild flowers 🌸, apples 🍎, seed packets 🌱, shiny pebbles
💎, bread 🍞 and honey jars 🍯. **Walk onto an item** to pick it up. Picked items grow back every 3
game hours (`economy.itemRespawnGameMinutes`).

The `Backpack` dock tile lists what you carry. To give a gift, open the backpack and choose a
villager (or choose an item from the inspector). The villager remembers the gift, likes you more
(more so if it is something it loves), and thanks you.

## Pip, your pet

Pip is your orange cat (rename it with `player.petName`). Pip follows you within a couple of tiles,
wanders around when you stand still, and sits at home while you're inside. Villagers notice Pip and
talk about it.

The `Pet` dock tile opens Pip's panel:

- **Follow** / **Stay**: Pip follows you, or stays where it is.
- **Pet Pip**: a little heart.
- **Rename**: 1–24 characters.

## Decorating your cottage

The `Decorate` dock tile opens a grid of ten decorations for your cottage. Each one is bought once
with gold; after that, clicking it puts it away or places it again for free.

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

Placed items show `PLACED ✓` and appear at your cottage (use **Home** to look). Villagers who
walk past your cottage notice new decorations and remember them, so they may bring them up later.

## Saving and loading

- The game **saves automatically** every 60 game minutes (`persistence.autosaveGameMinutes`) and
  when you stop the server with `Ctrl+C`.
- **💾 Save replay** saves right away and downloads the replay log.
- When you start the server again, it **loads the last save** and the village carries on where it
  stopped (`persistence.loadOnStart`).
- To **start a new village**, run `npm start -- --new`. The old save is replaced at the next save.
- Saves live in `saves/<slot>/` (`world.json`, one memory file per villager in `memories/`, and
  `replay.jsonl`). Use `persistence.slot` to keep several villages side by side, for example
  `"slot": "experiment"`.

## Tips

- To watch gossip spread, tell a rumor in the morning, set the speed to 4×, and keep the rumor
  tracker open. By evening several villagers usually know.
- If replies feel slow, use a longer day (`sim.dayLengthMinutes: 30`) or a smaller model. See
  [Troubleshooting](troubleshooting.md).
- The LLM card shows which model is running. To try another model, change `llm.model` in
  `config.json` and restart; see [Providers](setup/providers.md).
