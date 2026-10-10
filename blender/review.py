"""Puts renders beside the references they are judged against, on one sheet.

    python3 blender/review.py <preview_dir> <out.png> [--finish fur|draft]

Reads the renders blender/preview.py wrote (<finish>-<pose>-<view>.png) and
the pictures in previews/, and lays them out in pairs: the main picture
beside the wave, the front picture beside the standing pose, a face beside
the face, and the hand, the feet, the back and the terminal size after.
Missing renders are left out.
"""

import os
import sys

from PIL import Image, ImageDraw

SIZE = 640
DARK = (30, 30, 30, 255)
WHITE = (255, 255, 255, 255)
PREVIEWS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "previews")

# (reference picture, its crop or None for all of it, render)
PAIRS = [
    ("n5ocru92jcaa3qe.jpeg", None, "hello-three-quarter"),
    ("cr714zvnmpglrw9.jpeg", None, "stand-front"),
    ("cr714zvnmpglrw9.jpeg", (420, 150, 1650, 1300), "stand-face"),
    ("Ranko_back.jpeg", None, "wave-back"),
    ("n5ocru92jcaa3qe.jpeg", (80, 240, 700, 960), "hello-hand"),
    ("Ranko_at_Work.jpeg", (700, 1450, 1850, 2048), "hello-feet"),
]


def tile(image, background):
    image.thumbnail((SIZE, SIZE))
    out = Image.new("RGBA", (SIZE, SIZE), background)
    out.alpha_composite(image.convert("RGBA"), ((SIZE - image.width) // 2, (SIZE - image.height) // 2))
    return out


def main(preview_dir, out_path, finish="fur"):
    tiles = []
    for picture, crop, render in PAIRS:
        path = os.path.join(preview_dir, f"{finish}-{render}.png")
        if not os.path.exists(path):
            continue
        ref = Image.open(os.path.join(PREVIEWS, picture)).convert("RGB")
        tiles.append(("Vorlage", tile(ref.crop(crop) if crop else ref, WHITE)))
        tiles.append(("Ranko 3D", tile(Image.open(path), DARK)))

    small = [Image.open(os.path.join(preview_dir, f"{finish}-{name}.png"))
             for name in ("hello-three-quarter", "stand-front")
             if os.path.exists(os.path.join(preview_dir, f"{finish}-{name}.png"))]
    columns = 4
    rows = (len(tiles) + columns - 1) // columns
    sheet = Image.new("RGBA", (columns * SIZE, rows * SIZE + (260 if small else 0)), DARK)
    draw = ImageDraw.Draw(sheet)
    for i, (label, image) in enumerate(tiles):
        x, y = (i % columns) * SIZE, (i // columns) * SIZE
        sheet.alpha_composite(image, (x, y))
        draw.text((x + 10, y + 10), label, fill=(255, 170, 40, 255))
    # As in the terminal: 192 pixels square.
    for i, image in enumerate(small):
        t = tile(image, DARK).resize((192, 192), Image.LANCZOS)
        sheet.alpha_composite(t, (20 + i * 230, rows * SIZE + 50))
    if small:
        draw.text((20, rows * SIZE + 20), "192 px, wie im Terminal", fill=(255, 170, 40, 255))
    sheet.convert("RGB").save(out_path, quality=92)
    print(out_path, sheet.size)


args = sys.argv[1:]
finish = "fur"
if "--finish" in args:
    i = args.index("--finish")
    finish = args[i + 1]
    del args[i:i + 2]
main(*args, finish=finish)
