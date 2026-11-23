# Reference material

`thinkyville.mp4` is the user's reference video for the look and feel (122 s, 1440×754, 12 MB). It
is committed as a normal git file because it is well below GitHub's 50 MB warning limit, so
contributors don't need git-lfs. Don't add more video files. If the reference ever grows past
about 25 MB, track it with git-lfs (`git lfs track "docs/reference/*.mp4"`).

Key frames are in `frames/`:

| File                       | Shows                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| `01-day-overview.jpg`      | The whole town by day: layout, palette, bubbles, name tags, HUD, toolbar, dock |
| `02-inspector.jpg`         | The villager inspector: bio, thought, needs, plan, friends, actions, memories  |
| `03-zoomed-home-scene.jpg` | A zoomed scene ("Your home") with a toast                                      |
| `04-night-rumor.jpg`       | Night lighting and the rumor tracker panel                                     |
| `05-decorate-modal.jpg`    | The home decorating modal                                                      |
| `06-map-modal.jpg`         | The map / scene switcher modal                                                 |

How our art implements this look is described in `docs/art/README.md`.
