"""Renders Ranko, rigged and posed, to judge his shape and look.

    blender -b --factory-startup -P blender/preview.py -- [--clay|--look|--draft|--fur] <out_dir> [pose:view ...]

Each pose:view is one PNG, <out_dir>/<finish>-<pose>-<view>.png, on a clear
background so blender/fit.py can lay its outline over a reference's. The
poses are the references' (`stand` is cr714zvnmpglrw9, `hello` is
n5ocru92jcaa3qe, `wave` is Ranko_back), the views orthographic from the
front, back and sides, plus a three-quarter view through a long lens. He is
built once and posed for each picture.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clips  # noqa: E402
import look  # noqa: E402
import rig  # noqa: E402

deg = math.radians

# Poses on the rig, from its rest pose with the arms out and down at 60°.
ARMS_DOWN = {
    "upper_arm.L": (deg(4), deg(35), 0), "forearm.L": (deg(-10), deg(-6), 0), "hand.L": (0, deg(4), deg(-80)),
    "upper_arm.R": (deg(4), deg(-35), 0), "forearm.R": (deg(-10), deg(6), 0), "hand.R": (0, deg(-4), deg(80)),
}
POSES = {
    "rest": {},
    # Arms hanging at the sides, hands by the hips.
    "stand": ARMS_DOWN,
    # His right arm up and out, palm to the front: the wave.
    "hello": {
        **ARMS_DOWN,
        "upper_arm.R": (deg(-5), deg(65), deg(-12)), "forearm.R": (0, deg(45), 0), "hand.R": (0, deg(5), 0),
    },
    "wave": {
        **ARMS_DOWN,
        "upper_arm.R": (deg(-5), deg(65), deg(-12)), "forearm.R": (0, deg(45), 0), "hand.R": (0, deg(5), 0),
    },
    # Everything bent at once, to see how the skin and fur follow.
    "test": {
        "upper_arm.L": (0, deg(-60), 0), "forearm.L": (deg(-40), 0, 0),
        "index.L": (deg(-50), 0, 0), "middle.L": (deg(-50), 0, 0), "ring.L": (deg(-50), 0, 0),
        "upper_arm.R": (deg(-30), deg(-40), 0), "forearm.R": (deg(-70), 0, 0),
        "head": (deg(8), deg(-12), deg(20)), "thigh.L": (deg(-35), 0, 0), "tail.1": (0, 0, deg(-35)),
        "tail.2": (0, 0, deg(-20)), "jaw": (deg(12), 0, 0), "brow.L": (deg(-15), 0, 0),
        "lid.R": (deg(95), 0, 0), "lid_low.R": (deg(-55), 0, 0), "lid.L": (deg(45), 0, 0),
        "eye.L": (0, 0, deg(20)), "eye.R": (0, 0, deg(20)),
    },
}

# Each view: where the camera sits (a direction from what it looks at),
# what it looks at, and an orthographic width, or None for a long lens.
VIEWS = {
    "front": ((0, -1, 0), (0, 0, 0.56), 1.38),
    "back": ((0, 1, 0), (0, 0, 0.56), 1.38),
    "left": ((1, 0, 0), (0, 0, 0.56), 1.38),
    "right": ((-1, 0, 0), (0, 0, 0.56), 1.38),
    "three-quarter": ((-0.42, -1, 0.08), (0, 0, 0.56), None),
    "face": ((0, -1, 0), (0, -0.1, 0.87), 0.62),
    "face-three-quarter": ((-0.55, -1, 0.06), (0, -0.1, 0.87), 0.66),
    "face-side": ((1, 0, 0), (0, -0.1, 0.87), 0.66),
    "feet": ((-0.25, -1, 0.35), (0, -0.05, 0.10), 0.70),
    "hand": ((-0.3, -1, 0.1), (-0.40, -0.05, 0.95), 0.42),
    "hand-down": ((0.2, -1, 0.1), (0.36, -0.05, 0.36), 0.40),
}
CENTER = Vector((0, 0, 0.53))
SIZE = 640


def setup_render():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type != "CPU"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("World")
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.15
    scene.world = world


def camera(view):
    data = bpy.data.cameras.new("Camera")
    direction, center, width = VIEWS[view]
    direction, center = Vector(direction).normalized(), Vector(center)
    obj = bpy.data.objects.new("Camera", data)
    bpy.context.scene.collection.objects.link(obj)
    if width is None:
        data.lens = 85
        obj.location = center + direction * 3.6
    else:
        data.type = "ORTHO"
        data.ortho_scale = width
        obj.location = center + direction * 5
    obj.rotation_euler = (center - obj.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = obj
    return obj


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    finish = "clay"
    if args[0].startswith("--"):
        finish = args.pop(0)[2:]
    out_dir = os.path.abspath(args[0])
    specs = args[1:] or ["stand:front", "stand:three-quarter", "wave:back", "rest:front", "rest:left"]
    setup_render()
    if finish in ("fur", "draft"):
        bpy.context.scene.cycles.samples = 64 if finish == "fur" else 32
    parts = rig.build(finish, draft=finish == "draft")
    look.lights(parts["eyes"], lids=parts["lids"])
    for spec in specs:
        pose_name, view = spec.split(":")
        # A pose by name, or a clip's frame as clip.frame.
        clip, _, frame = pose_name.partition(".")
        rig.pose(parts, clips.pose_at(clip, int(frame)) if frame else POSES[pose_name])
        cam = camera(view)
        bpy.context.scene.render.filepath = os.path.join(out_dir, f"{finish}-{pose_name}-{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


main()
