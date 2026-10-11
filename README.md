# Ranko

![Ranko waves, sits down to work, cheers, gives a thumbs up and says psst](docs/demo.gif)

Ranko, the [Rankello](https://rankello.ai) mascot, lives above the Claude Code
prompt and reacts to what Claude is doing. He waves hello when a session
starts; breathes, blinks and swings his tail while he waits; sits down and types on his laptop while
Claude works; jumps for joy after a long turn; clutches his head with a sweat
drop when a tool fails or you interrupt; and dozes off on a cushion, z's
rising, when left alone. Pat him and hearts float up; drag him and he
dangles; thank him and he blushes behind his hands. Left alone a while, he
scratches his head, says psst, gives a thumbs up or looks around. While a
tool runs he holds a prop for it: a magnifier to read or search, a notepad
to edit, binoculars for the web. He grows rounder as the context fills and
lets it out with a sigh on compaction, and he sits down and gets up between
all of these rather than jumping.

It is a Claude Code mod: frames baked in Blender, played above the prompt.
In a terminal they play by swapping an `Image`'s source with `$.ui.blit`,
which needs the kitty graphics protocol (kitty, Ghostty); in other terminals
he stays out of the way. In the Claude desktop app each frame is drawn as an
SVG, ten a second; there he can't be dragged or patted yet. On Windows the
desktop app is the easy way to meet him; in a terminal, run Claude Code in WSL
inside kitty (WSLg).

Meet him and Rankello at [rankello.ai](https://rankello.ai). Developed and
maintained by [milkycode](https://www.milkycode.com).

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
- `/ranko <reaction>` plays one of his reactions, e.g. `/ranko hello`.
- `/ranko list` shows every reaction, and every switch with its state.
- `/ranko on <switch>` / `/ranko off <switch>` flips a switch: `drag`,
  `pats`, `toolProps`, `miniRankos`, `stuffing`, `blush`, `fidgets`, `sounds`.

Sounds play on macOS only.

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
| `blender/composite.py` | lays them over each other into `assets/frames` |
| `blender/preview.py`, `review.py`, `fit.py` | large renders beside the reference pictures |
| `blender/gif.py` | plays clips as a GIF, to watch a motion outside a terminal |

Rebake the frames:

```bash
blender -b --factory-startup -P blender/bake.py -- render build/layers [clip ...]
python3 blender/composite.py build/layers assets/frames [clip ...]
```

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
