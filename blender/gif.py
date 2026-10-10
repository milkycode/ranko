"""Plays clips from a frames folder as an animated GIF, on a terminal's dark
background, to watch a motion without a terminal.

    python3 blender/gif.py assets/frames out.gif clip [clip ...] [--scale 2] [--loops 2]

Clips play one after the other; a looping clip plays `--loops` times.
`--scale` enlarges the frames (nearest neighbour, as a terminal's pixels).
"""

import json
import os
import sys

from PIL import Image

BACKGROUND = (30, 30, 30, 255)


def frames_of(folder, clip, loops):
    """The frame files to play for a clip, and the frames per second."""
    with open(os.path.join(folder, "manifest.json")) as f:
        manifest = json.load(f)
    info = manifest["clips"][clip]
    names = [os.path.join(folder, clip, f"{i:03d}.png") for i in range(info["frames"])]
    return names * (loops if info["loop"] else 1), manifest["fps"]


def main(args):
    scale, loops = 1, 2
    for flag in ("--scale", "--loops"):
        if flag in args:
            i = args.index(flag)
            value = int(args[i + 1])
            del args[i:i + 2]
            scale, loops = (value, loops) if flag == "--scale" else (scale, value)
    folder, out, clips = args[0], args[1], args[2:]
    images, fps = [], 24
    for clip in clips:
        names, fps = frames_of(folder, clip, loops)
        for name in names:
            frame = Image.open(name).convert("RGBA")
            canvas = Image.new("RGBA", frame.size, BACKGROUND)
            canvas.alpha_composite(frame)
            if scale != 1:
                canvas = canvas.resize((frame.width * scale, frame.height * scale), Image.NEAREST)
            images.append(canvas.convert("RGB"))
    images[0].save(out, save_all=True, append_images=images[1:], duration=round(1000 / fps), loop=0,
                   optimize=False, disposal=1)
    print(f"{out}: {len(images)} frames")


main(sys.argv[1:])
