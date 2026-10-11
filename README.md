# Ranko

![Ranko waves, sits down to work, cheers, gives a thumbs up and says psst](docs/demo.gif)

Ranko, the [rankello®](https://rankello.ai) mascot, lives above the Claude Code
prompt and reacts to what Claude is doing. He waves hello when a session
starts; breathes, blinks and swings his tail while he waits; sits down and types on his laptop while
Claude works; jumps for joy after a long turn; clutches his head with a sweat
drop when a tool fails or you interrupt; and dozes off on a cushion, z's
rising, when left alone. Pat him and hearts float up; drag him and he
dangles; thank him, in English or German, and he blushes behind his hands.
Left alone a while, he scratches his head, says psst, gives a thumbs up or
looks around. When Claude waits for your permission or for your answer to a
question, he stops typing, stands up and waves, then says psst now and then
until you answer. A commit, a push or a test run that passes gets a thumbs
up. While a tool runs he holds a prop for it: a magnifier to read or search,
a notepad to edit or keep the task list, binoculars for the web and the
browser. He grows rounder as the context fills, a resumed session's too, and
lets it out with a sigh on compaction, and he sits down and gets up between
all of these rather than jumping.

Beside him the band shows how full the context is and how far off
auto-compaction is, how long the prompt cache stays warm, your plan's 5-hour
and weekly limits with their reset times and when each runs full at the pace
it is used, and, while Claude keeps a task list, how far it has come; without
one, the session: how long it has run, its turns, the agents, background
shells and wakeups under way, and the turn under way or the last one. Each has
a bar; the session's shows how much of the 5-hour window has passed, to set
beside how much of it is used. Beside the context sits a Compact button from
15% on, which stands out in the last tenth before auto-compaction (or from 80%
without it). The figures are read again every 10 seconds and after every
response; the limits come from where `/usage` reads them, once a minute, so
what your other sessions use shows up too. After a compaction, by the button
or `/compact`, the conversation shows the summary Claude carries on with,
under a line with the tokens before and after; Claude doesn't read those
lines. Your sessions share one reading of the limits a minute, and when the
endpoint asks them to wait, they all do.

It is a Claude Code mod: frames baked in Blender, played above the prompt.
In a terminal they play by swapping an `Image`'s source with `$.ui.blit`,
which needs the kitty graphics protocol (kitty, Ghostty); in other terminals,
Windows Terminal among them, the band shows the stats without him. In the
Claude desktop app each frame is drawn as a
WebP in an SVG, ten a second; while you drag him there, a dashed frame shows where he
will land, and he moves when you let go. Asleep for a minute, he is drawn
four times a second, in both; after ten he holds still, drawn not at all,
until you type in the prompt or a turn starts. On Windows the desktop app is the
easy way to meet him; in a terminal, run Claude Code in WSL inside kitty
(WSLg).

![Ranko breathing above the prompt in the Claude desktop app, beside the context, cache, limits and session](docs/desktop.gif)

Meet him and rankello® at [rankello.ai](https://rankello.ai). Developed and
maintained by [milkycode®](https://www.milkycode.com).

## Install

```
/plugin marketplace add milkycode/ranko
/plugin install ranko@ranko
```

Needs Claude Code 2.1.287 or later with mods on. Mods are rolling out; if
`/ranko` isn't listed after installing, they aren't on for your account yet.

The desktop app loads a mod installed from a terminal at the user scope:
install it there, then start a new session in the app.

To run it from a checkout instead:

```bash
claude --plugin-dir path/to/ranko
```

## Commands and switches

- `/ranko` hides or shows him.
- `/ranko <reaction>` plays one of his reactions, e.g. `/ranko hello`:
  `blush`, `deflate`, `doze-off`, `drop`, `fidget-look`, `fidget-psst`,
  `fidget-thumbs`, `fidget-wonder`, `happy`, `held`, `hello`, `idle`,
  `idle-plump`, `idle-stuffed`, `oops`, `pat`, `sit-down`, `sleepy`,
  `stand-up`, `wake-up`, `working`, `working-binoculars`, `working-magnifier`,
  `working-notepad`, `working-plump`, `working-stuffed`.
- `/ranko list` shows every reaction, and every switch with its state. While
  you type, `/ranko` offers its reactions, its verbs and, after `on` or
  `off`, the switches.
- `/ranko collapse` folds the band to one line of figures and the Compact
  button, without Ranko, as the ▴ button at the band's top right does;
  `/ranko expand` or the ▾ at the line's right end opens it again. The band
  stays as you left it in later sessions.
- `/ranko on <switch>` / `/ranko off <switch>` flips a switch: `drag`,
  `pats`, `toolProps`, `miniRankos`, `stuffing`, `blush`, `attention`,
  `thumbsUp`, `fidgets`, `sounds`, `stats`, `compactSummary`.

Sounds play on macOS only. The cache's countdown assumes an hour when you are
logged in with a Claude plan and five minutes with an API key: Claude Code
doesn't say which one it asked for.

## How he is made

Everything is built by script in Blender 5.2, headless; nothing is modelled by
hand.

| Script | What it does |
| :-- | :-- |
| `blender/model.py` | sculpts him as a signed distance field on a skeleton and meshes it with OpenVDB |
| `blender/look.py` | fur, materials, eyes, lights |
| `blender/rig.py` | armature, skin weights from the shapes each bone carries, lids, poses |
| `blender/clips.py` | the motion of every clip, frame by frame |
| `blender/bake.py` | renders each frame as a plush and a shadow layer |
| `blender/composite.py` | lays them over each other into `assets/frames`, as a PNG for the terminal and a WebP for the desktop app |
| `blender/preview.py`, `review.py`, `fit.py` | large renders beside the reference pictures |
| `blender/gif.py` | plays clips as a GIF, to watch a motion outside a terminal |

Rebake the frames:

```bash
blender -b --factory-startup -P blender/bake.py -- render build/layers [clip ...]
python3 blender/composite.py build/layers assets/frames [clip ...]
```

`python3 blender/composite.py --webp assets/frames` writes the WebPs anew
from the PNGs alone, without the layers.

A frame takes about 12 seconds on an RTX 4060 (CUDA), most of it for the fur;
all of them take three hours.

## Test

```bash
claude plugin test .
```

It runs every `*.test.tsx` under the folder.

## License

MIT for the code, the Blender and sound scripts, and the frames and sounds
they make; see [LICENSE](LICENSE). The Ranko character and the Rankello name
are registered trademarks of milkycode GmbH, and the license doesn't cover them.
