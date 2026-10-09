"""Lays a render's outline over a reference's, to see where the shape is off.

    python3 blender/fit.py <render.png> <reference image> <out.png>

The reference's outline is cut from its white background; the render's is
its alpha. Both are scaled to the same height and lined up on the floor and
on the middle of the head. The overlay shows the reference alone in red,
the render alone in blue and both in grey, beside the two pictures, and the
overlap (intersection over union) is printed.
"""

import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HEIGHT = 600


def reference_mask(path):
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    mask = ((rgb.max(-1) - rgb.min(-1)) > 38) | (rgb.max(-1) < 170)
    mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask, iterations=4))
    labels, n = ndimage.label(mask)
    sizes = ndimage.sum(mask, labels, range(1, n + 1))
    return labels == 1 + int(np.argmax(sizes))


def render_mask(path):
    return np.asarray(Image.open(path).convert("RGBA"))[..., 3] > 128


def normalised(mask, image):
    """The mask and its image cropped to the figure and scaled to HEIGHT,
    with the column of the head's middle."""
    ys, xs = np.nonzero(mask)
    top, bottom, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    scale = HEIGHT / (bottom - top)
    width = max(1, round((right - left) * scale))
    crop = Image.fromarray(mask[top:bottom, left:right].astype(np.uint8) * 255)
    small = np.asarray(crop.resize((width, HEIGHT), Image.LANCZOS)) > 127
    picture = image.crop((left, top, right, bottom)).resize((width, HEIGHT), Image.LANCZOS)
    head = np.nonzero(small[: HEIGHT // 8].any(0))[0]
    return small, picture, (head.min() + head.max()) / 2


def main(render_path, reference_path, out_path):
    model, model_picture, model_head = normalised(render_mask(render_path), Image.open(render_path).convert("RGBA"))
    ref, ref_picture, ref_head = normalised(reference_mask(reference_path), Image.open(reference_path).convert("RGBA"))

    # One canvas wide enough for both, each placed so their heads line up.
    pad = 40
    shift = round(ref_head - model_head)
    left = min(0, shift)
    width = max(ref.shape[1], model.shape[1] + shift) - left + 2 * pad
    canvas_ref = np.zeros((HEIGHT, width), bool)
    canvas_model = np.zeros((HEIGHT, width), bool)
    canvas_ref[:, pad - left: pad - left + ref.shape[1]] = ref
    canvas_model[:, pad - left + shift: pad - left + shift + model.shape[1]] = model

    both = canvas_ref & canvas_model
    overlay = np.full((HEIGHT, width, 3), 255, np.uint8)
    overlay[canvas_ref & ~canvas_model] = (220, 60, 60)
    overlay[canvas_model & ~canvas_ref] = (60, 90, 220)
    overlay[both] = (170, 170, 170)
    iou = both.sum() / (canvas_ref | canvas_model).sum()

    sheet = Image.new("RGB", (width + ref_picture.width + model_picture.width + 2 * pad, HEIGHT), "white")
    sheet.paste(ref_picture.convert("RGB"), (0, 0))
    white = Image.new("RGBA", model_picture.size, (255, 255, 255, 255))
    sheet.paste(Image.alpha_composite(white, model_picture).convert("RGB"), (ref_picture.width + pad, 0))
    sheet.paste(Image.fromarray(overlay), (ref_picture.width + model_picture.width + 2 * pad, 0))
    sheet.save(out_path)
    print(f"{out_path}: overlap {iou:.3f}")


main(*sys.argv[1:4])
