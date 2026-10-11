"""Lays Ranko over his shadow: the frames the mod plays, from the two layers
blender/bake.py renders. After plushie's compositor (MIT, Xiaoyi Chen).

    python3 blender/composite.py build/layers assets/frames [clip ...]
    python3 blender/composite.py --webp assets/frames
    python3 blender/composite.py --still plush.png shadow.png out.png

Each frame is written twice: a PNG, which the terminal draws, and a WebP,
which the desktop app draws in a quarter of the bytes. `--webp` writes the
WebPs of a frames folder anew from its PNGs, without the layers. The
manifest says `"webp": true` once every PNG has its WebP beside it.

The shadow's look lives here, so changing it needs no render: OPACITY scales
it (0 drops it), POOL shapes it into a soft oval under Ranko's feet, and it
fades out before the frame's left, right and bottom edges, where the box the
terminal draws the frame in would slice it off.
"""

import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

OPACITY = 0.8
# The oval the shadow is kept within, as fractions of the frame: half-width,
# half-height, centre height, and how much of it is soft edge. Without it the
# shadow spreads into a band across the whole bottom.
POOL = {"rx": 0.42, "ry": 0.22, "cy": 0.93, "soft": 0.35}
SIDE_FADE = 48  # pixels over which the shadow fades out toward left and right
BOTTOM_FADE = 10
# The desktop's WebPs: lossy colour, lossless alpha. At 90 a frame keeps its
# fur and loses three quarters of the PNG's bytes; at 80 the fur smears.
WEBP = {"quality": 90, "alpha_quality": 100, "method": 6}


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def keep(width, height):
    """How much of the shadow survives at each pixel: inside the pool, away
    from the edges."""
    x = np.arange(width, dtype=np.float32)
    y = np.arange(height, dtype=np.float32)
    side = smoothstep(np.minimum(x, width - 1 - x) / SIDE_FADE)
    bottom = smoothstep((height - 1 - y) / BOTTOM_FADE)

    ox = (x - width / 2) / (width * POOL["rx"])
    oy = (y - height * POOL["cy"]) / (height * POOL["ry"])
    pool = smoothstep((1 - np.sqrt(ox[None, :] ** 2 + oy[:, None] ** 2)) / POOL["soft"] + 0.5)
    return pool * bottom[:, None] * side[None, :]


def composite(plush, shadow):
    """The shadow as black at its own strength, kept to the pool, under Ranko."""
    plush = plush.convert("RGBA")
    strength = np.array(shadow.convert("RGBA"))[..., 3].astype(np.float32) / 255
    alpha = strength * OPACITY * keep(*plush.size)
    under = np.zeros((plush.height, plush.width, 4), dtype=np.uint8)
    under[..., 3] = np.round(alpha * 255).astype(np.uint8)
    return Image.alpha_composite(Image.fromarray(under, "RGBA"), plush)


def composite_clip(layers, frames, clip):
    source = os.path.join(layers, clip)
    target = os.path.join(frames, clip)
    names = sorted(f[: -len(".plush.png")] for f in os.listdir(source) if f.endswith(".plush.png"))
    # The clip's folder is replaced whole, so a clip that got shorter leaves
    # no stale frames behind.
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    for name in names:
        plush = Image.open(os.path.join(source, f"{name}.plush.png"))
        shadow = Image.open(os.path.join(source, f"{name}.shadow.png"))
        frame = composite(plush, shadow)
        frame.save(os.path.join(target, f"{name}.png"))
        frame.save(os.path.join(target, f"{name}.webp"), "WEBP", **WEBP)
    return len(names)


def pngs(frames):
    """Every frame's PNG in a frames folder."""
    return sorted(
        os.path.join(frames, clip, name)
        for clip in os.listdir(frames)
        if os.path.isdir(os.path.join(frames, clip))
        for name in os.listdir(os.path.join(frames, clip))
        if name.endswith(".png")
    )


def write_manifest(frames, manifest):
    """The manifest names only the clips the frames folder holds, so the mod
    never picks one that has no frames yet, and says whether every frame has
    its WebP."""
    manifest["clips"] = {
        name: info for name, info in manifest["clips"].items() if os.path.isdir(os.path.join(frames, name))
    }
    manifest["webp"] = all(os.path.exists(png[: -len(".png")] + ".webp") for png in pngs(frames))
    with open(os.path.join(frames, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def main(args):
    if args[:1] == ["--still"]:
        composite(Image.open(args[1]), Image.open(args[2])).save(args[3])
        return

    if args[:1] == ["--webp"]:
        frames = args[1]
        for png in pngs(frames):
            Image.open(png).save(png[: -len(".png")] + ".webp", "WEBP", **WEBP)
        with open(os.path.join(frames, "manifest.json")) as f:
            write_manifest(frames, json.load(f))
        print(f"wrote a WebP beside each of {len(pngs(frames))} frames in {frames}")
        return

    layers, frames, clips = args[0], args[1], args[2:]
    clips = clips or sorted(d for d in os.listdir(layers) if os.path.isdir(os.path.join(layers, d)))
    total = sum(composite_clip(layers, frames, clip) for clip in clips)
    with open(os.path.join(layers, "manifest.json")) as f:
        write_manifest(frames, json.load(f))
    print(f"composited {total} frames into {frames}")


main(sys.argv[1:])
