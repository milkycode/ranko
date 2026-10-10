# Ranko

Ranko, the Rankello monster, lives above the Claude Code prompt and reacts to
what Claude is doing. He waves hello when a session starts, and breathes,
blinks and swings his tail while he waits. More reactions are on the way:
working, celebrating, wobbling, blushing, napping (see [docs/plan.md](docs/plan.md)).

It is a Claude Code mod: frames baked in Blender, played in the terminal by
swapping an `Image`'s source with `$.ui.blit`. Terminals with the kitty
graphics protocol (kitty, Ghostty) only; elsewhere he stays out of the way.
On Windows, run Claude Code in WSL inside kitty (WSLg).

Developed and maintained by [milkycode GmbH](https://www.milkycode.com). The
mod code comes from [plushie](https://github.com/xyc/plushie) by Xiaoyi Chen.

## Install

Needs Claude Code 2.1.287 or later with mods on.

```
/plugin install ranko --marketplace milkycode/ranko
```

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

A frame takes about 5 seconds on an RTX 4060 (CUDA).

## Test

```bash
claude plugin test .
```

It runs every `*.test.tsx` under the folder, so keep other plugins (such as a
plushie checkout) out of it.

## License

MIT for the code, the Blender and sound scripts, and the frames and sounds
they make; see [LICENSE](LICENSE). The Ranko character and the Rankello name
are milkycode GmbH's, and the license doesn't cover them.
