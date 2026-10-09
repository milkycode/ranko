# Ranko: plan

Ranko, the Rankello monster, lives above the Claude Code prompt and reacts to
what Claude is doing, the way plushie's Clawd does. The mod code comes from
plushie (MIT, kept in `plushie/` as a reference, not tracked); the character,
the model and every frame are new.

## What carries over from plushie

The mod never knows which character it plays. It reads
`assets/frames/manifest.json` (fps, cell size, clips) and swaps PNGs from
`assets/frames/<clip>/NNN.png` on a timer. So the TypeScript (`hooks/`,
`tests/`) carries over with renames; the Blender side is rebuilt.

| plushie | Ranko |
| :-- | :-- |
| `blender/plush.py` builds Clawd from primitives in code | a sculpted, rigged `blender/ranko.blend`, itself built by script; another script poses and renders it |
| procedural motion sets object transforms | the same per-clip pose functions, setting bones and shape keys |
| 16×6 cells, 256×192 px (Clawd is wide) | **12×6 cells, 192×192 px** (Ranko is about as wide as tall) |
| `/plushie`, `miniClawds` | `/ranko`, `miniRankos` |
| `composite.py`, `make_sounds.py` | reused as they are |

## Where it can show

- `Image` draws only through the kitty graphics protocol: **kitty or
  Ghostty**. Windows Terminal shows nothing. On our Windows PCs that means
  Claude Code in WSL, inside kitty (WSLg). WezTerm is untested.
- `$.audio.play` plays only on macOS; elsewhere Ranko is silent.

## How the model is made

Claude models, rigs and grooms Ranko by script, in Blender 5.2 LTS run
headless in WSL (Cycles on the RTX 4060 through OptiX). Every step is code
in `blender/`, so the `.blend` can be rebuilt from scratch at any time, and
every change is checked by rendering it and comparing it with `previews/`:

1. **Blockout.** A skeleton of points with radii (head, belly, arms,
   hands, fingers, feet, tail) through the Skin modifier: a single mesh
   whose shape follows the bones it will later be rigged to.
2. **Shaping.** Remeshed to even quads, then pushed toward the references:
   front and side silhouettes are cut out of `previews/` and matched against
   renders from the same angle, as a number and by eye.
3. **Face.** Eyes, mouth cavity, teeth and tongue as their own objects;
   shape keys on the body for mouth, lids and brows.
4. **Rig.** The armature from the same skeleton, weights painted
   automatically and corrected where a fold shows.
5. **Fur.** Hair on the body, blue with purple patches, clumped, long
   enough to read as fluffy at 192 px.

The `.blend` opens in Blender (WSLg, or a Windows install of the same
version) for a look around; it is never edited by hand, or the next rebuild
would undo it.

## The model contract

What `ranko.blend` must hold so the scripts can pose and render it; the
intake script checks it.

- **Scale and facing:** metres, Ranko about 1.0 tall, feet on z = 0, facing
  −Y. Rest pose: arms slightly away from the body (A-pose), mouth closed in a
  soft smile.
- **Objects:**
  - `Body`: head, belly, arms, four-finger hands, feet with toe bumps and the
    tail, one watertight quad mesh that deforms cleanly.
  - `EyeL`, `EyeR`: separate white eyeballs with iris, pupil and a
    highlight, pivoting at their centre so they can look around.
  - `TeethUpper`, `TeethLower`, `Tongue`, `MouthInside` (the dark cavity).
- **Shape keys on `Body`:** `mouth_open`, `smile`, `frown`, `mouth_o`,
  `blink_L`, `blink_R`, `brow_up`, `brow_worried`, `brow_angry`, `squint`.
- **Armature `Rig`:** root, hips, spine, chest, head, jaw; per side
  upper arm, forearm, hand, thumb and four fingers, thigh, shin, foot;
  tail in four segments.
- **Fur:** blue base with purple patches (see `previews/`), grown by the
  script.

A clip can also be keyframed: an Action named `clip:<name>` in the file
takes the place of that clip's pose function, for a clip (the wave) that
needs more than a formula.

## Clips, and the references for each

| Clip | When | Reference in `previews/` |
| :-- | :-- | :-- |
| `idle` | nothing under way; breathes, blinks, tail sways | `cr714zvnmpglrw9`, `843bbzjtmtyysp3` |
| `hello` (new) | session start: the wave | `Ranko-waves.mp4`, `Ranko-Hi.png`, `n5ocru92jcaa3qe` |
| `working` (+ tool props) | a turn is running | none yet |
| `happy` | a long turn finished: jumps, arms up | `xbxhu067av28qff` (top right), `xtnofujv6mf567z` (middle) |
| `oops` | a tool failed, or an interrupt: sweat drop, hand on head | `14133987.png`, `Ranko_tears` |
| `sleepy` | idle for two minutes: on a cushion, zzz | `eyb263zuz3jzcln` (bottom right) |
| `blush` | thanks or praise: hand over mouth | `xtnofujv6mf567z` (left) |
| `deflate` | compaction: a big sigh | `ylg0wsk3qlog8q4` (left) |
| `fidget-wonder` | idle fidget: finger on chin | `Ranko_wondering`, `ay40gawqr5zdpf0` |
| `fidget-psst` | idle fidget: sneaky look | `0wwi3znktas4ylz` |
| `fidget-thumbs` | idle fidget: thumbs up | `xbxhu067av28qff` (bottom right) |
| `fidget-look` | idle fidget: eyes look around | none |
| `pat`, `held`, `drop`, `idle-plump`/`-stuffed` | pats, drag, context fill | none |

## Phases

0. **Setup.** Repo, kitty, Blender 5.2 LTS in WSL (done). Run plushie as
   it is in kitty under WSL to confirm mods and pictures work here before
   anything is modelled. Port the bake scripts from macOS/Metal to the
   RTX 4060 (OptiX, Blender path from `$BLENDER`, contact sheets in PIL
   instead of ImageMagick) and time a frame.
1. **Model.** Blockout, shaping and face, as above, until the stills sit
   next to `previews/` without looking like someone else.
2. **Rig and fur.** Armature, weights, shape keys, hair; a contact sheet of
   extreme poses to catch bad folds.
3. **Look-dev.** Fur, eyes, lights and shadow until Ranko reads at 192 px on
   a dark terminal.
4. **MVP clips.** `idle`, `hello`, `working`, `happy`, `oops`, `sleepy`.
5. **Port the mod.** Renames, 12×6, `hello` on session start, tests.
6. **The rest.** The remaining clips, tool props, sounds.
7. **Publish.** `milkycode/ranko`, marketplace, README, demo GIF, a nod to
   Rankello.

## Open

- A reference for `working`, and a view from behind (the tail).
