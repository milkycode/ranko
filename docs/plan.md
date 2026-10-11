# Ranko: plan

Ranko, the Rankello monster, lives above the Claude Code prompt and reacts to
what Claude is doing, the way plushie's Clawd does. The mod code comes from
[plushie](https://github.com/xyc/plushie) (MIT); the character,
the model and every frame are new.

## What carries over from plushie

The mod never knows which character it plays. It reads
`assets/frames/manifest.json` (fps, cell size, clips) and swaps PNGs from
`assets/frames/<clip>/NNN.png` on a timer. So the TypeScript (`hooks/`,
`tests/`) carries over with renames; the Blender side is rebuilt.

| plushie | Ranko |
| :-- | :-- |
| `blender/plush.py` builds Clawd from primitives in code | `blender/model.py` sculpts Ranko as a distance field, `rig.py` rigs him |
| procedural motion sets object transforms | per-clip pose functions in `clips.py`, setting bones |
| 16×6 cells, 256×192 px (Clawd is wide) | **12×6 cells, 192×192 px** (Ranko is about as wide as tall) |
| `/plushie`, `miniClawds` | `/ranko`, `miniRankos` |
| `composite.py`, `make_sounds.py` | reused, with a hello sound added |

## Where it can show

- `Image` draws only through the kitty graphics protocol: **kitty or
  Ghostty**. Windows Terminal shows nothing. In a terminal on Windows that
  means Claude Code in WSL, inside kitty (WSLg). WezTerm is untested.
- **The desktop app** has no `Image` but draws `Svg`. Each frame is its PNG
  inside an SVG (`<image href="data:image/png;base64,…">`), and the band is
  drawn again for every frame, at most ten times a second. Tested on Windows
  with the app's sessions running in WSL, where a mod installed at the user
  scope loads too; only a new session picks it up. An `isInteractive` SVG
  flipping frames by SMIL drew nothing there. Dragging and pats wait on how
  the desktop reports the pointer to a `Client`.
- The mobile app and VS Code raise no band above the prompt.
- `$.audio.play` plays only on macOS; elsewhere Ranko is silent.

## How the model is made

Ranko is built, rigged and groomed by script in Blender 5.2 LTS, headless
in WSL (Cycles on the RTX 4060 through CUDA; OptiX does not start under
WSL). There is no `.blend` to keep: every run builds him from the scripts in
`blender/`, and every change is checked by rendering it beside the reference
pictures in `previews/`, which stay out of the repo (`blender/review.py`,
`fit.py`).

1. **Sculpt** (`model.py`). A signed distance field: ellipsoids and round
   cones on a skeleton, joined with smooth unions whose fillet sets how soft
   each joint is; eye sockets, the grin and the seam carved with smooth
   differences; brows, lids and lips laid on the skin as tubes. OpenVDB cuts
   one closed quad mesh from it. The rest pose has the arms out at 60° so
   nothing touches.
2. **Look** (`look.py`). Hair on the body, blue with violet patches, darker
   at the roots, shorter on the face and hands, none in the mouth or on the
   soles; a tone painted on the skin shades the fur in sockets and grooves.
   Glossy eyes lit apart from the studio, so the iris stays clear.
3. **Rig** (`rig.py`). An armature on the same skeleton plus face bones
   (eyes, upper and lower lids, brows, jaw). Each bone pulls the skin over
   the shapes it carries, fading out over a reach set per kind of bone; the
   head shares its pull with the jaw and brows. Eyes, lids, teeth and tongue
   hang from their bones. The fur follows the skin.
4. **Clips** (`clips.py`). Each clip is a function of time returning a pose:
   turns in the rest pose's world axes, finger curl and spread, twists,
   offsets, scales, how shut the lids are.
5. **Bake** (`bake.py`, `composite.py`). 192 px frames as a plush and a
   shadow layer, laid over each other as plushie does. Fewer, thicker strands
   than the previews: a pixel is about 6 mm of Ranko.

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
| `fidget-wonder` | idle fidget: scratches his head, puzzled | `Ranko_wondering` |
| `fidget-psst` | idle fidget: finger at his lips, sneaky look | `0wwi3znktas4ylz`, `ay40gawqr5zdpf0` |
| `fidget-thumbs` | idle fidget: thumbs up | `xbxhu067av28qff` (bottom right) |
| `fidget-look` | idle fidget: eyes look around | none |
| `pat`, `held`, `drop`, `idle-plump`/`-stuffed` | pats, drag, context fill | none |

## Phases

0. **Setup.** Repo, kitty, Blender 5.2 LTS in WSL, plushie seen working in
   kitty. *Done.*
1. **Model and look.** Sculpted and dressed until reviews against
   `previews/` came out close. *Done.*
2. **Rig.** Armature, weights, lids, finger controls; a pose with every
   joint bent to catch bad folds. *Done.*
3. **Port the mod.** Renames, 12×6, `hello` on session start, tests pass.
   *Done.*
4. **MVP clips.** `idle`, `hello`, `working` (sitting with a laptop),
   `happy`, `oops` (sweat drop) and `sleepy` (on a cushion, z's rising).
   Props hang from bones and show when a pose names them (`props.py`).
5. **Interaction.** `pat` (hearts), `held` and `drop`, `blush` (pink
   cheeks, hands over his mouth); transitions between standing, sitting and
   the cushion (`sit-down`, `stand-up`, `doze-off`, `wake-up`).
6. **The rest.** Idle fidgets (`wonder`, `psst`, `thumbs`, `look`), tool
   props (`working-magnifier`, `-notepad`, `-binoculars`), stuffing sizes
   (`-plump`, `-stuffed`) and `deflate`.
7. **Publish.** A public repo that is its own marketplace, a README with a
   demo GIF, and a link to [rankello.ai](https://rankello.ai). *Done.*
8. **Desktop app.** Every clip, the minis and the switches drawn as SVG in
   the desktop band. Next: dragging and pats there, once a probe shows how a
   `Client` gets the pointer on the desktop.
