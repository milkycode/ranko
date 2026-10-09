"""Renders Ranko's body in grey-blue clay, to judge its shape.

    blender -b --factory-startup -P blender/preview.py -- [--clay|--look|--fur] <out_dir> [pose:view ...]

Each pose:view is one PNG, <out_dir>/<finish>-<pose>-<view>.png, on a clear
background so blender/fit.py can lay its outline over a reference's. The
poses are the references' (`stand` is cr714zvnmpglrw9, `wave` is
Ranko_back), the views orthographic from the front, back and sides, plus a
three-quarter view through a long lens.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import look  # noqa: E402
import model  # noqa: E402

deg = math.radians

POSES = {
    "rest": {},
    # Arms hanging close at the sides, hands by the hips.
    "stand": {
        "upper_arm.L": (0, deg(4), 0), "forearm.L": (deg(-8), deg(26), 0), "hand.L": (0, 0, deg(-90)),
        "upper_arm.R": (0, deg(-4), 0), "forearm.R": (deg(-8), deg(-26), 0), "hand.R": (0, 0, deg(90)),
    },
    # His right arm up and out, palm to the front: the wave.
    "hello": {
        "upper_arm.R": (deg(-10), deg(105), deg(-20)), "forearm.R": (0, deg(12), 0), "hand.R": (0, 0, 0),
        "upper_arm.L": (0, deg(4), 0), "forearm.L": (deg(-8), deg(26), 0), "hand.L": (0, 0, deg(-90)),
    },
    "wave": {
        "upper_arm.R": (0, deg(92), 0), "forearm.R": (0, deg(20), 0),
        "upper_arm.L": (0, deg(4), 0), "forearm.L": (deg(-8), deg(26), 0), "hand.L": (0, 0, deg(-90)),
    },
}

# Where each camera sits, looking at the middle of the body.
VIEWS = {
    "front": (0, -1, 0),
    "back": (0, 1, 0),
    "left": (1, 0, 0),
    "right": (-1, 0, 0),
    "three-quarter": (-0.42, -1, 0.08),
}
CENTER = Vector((0, 0, 0.53))
SIZE = 640


def clay(name, color, roughness=0.55, coat=0.0):
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Coat Weight"].default_value = coat
    return mat


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


def light(name, location, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.size = energy, size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (CENTER - Vector(location)).to_track_quat("-Z", "Y").to_euler()


def camera(view):
    data = bpy.data.cameras.new("Camera")
    direction = Vector(VIEWS[view]).normalized()
    obj = bpy.data.objects.new("Camera", data)
    bpy.context.scene.collection.objects.link(obj)
    if view == "three-quarter":
        data.lens = 85
        obj.location = CENTER + direction * 3.6
    else:
        data.type = "ORTHO"
        data.ortho_scale = 1.35
        obj.location = CENTER + direction * 5
    obj.rotation_euler = (CENTER - obj.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = obj
    return obj


def build(pose_name, finish):
    """Ranko in a pose: `clay`, `look` (materials, no fur) or `fur`."""
    model.clear_scene()
    pose = POSES[pose_name]
    parts = {"body": model.build_body(pose), "eyes": model.build_eyes(pose), "mouth": model.build_mouth(pose)}
    if finish == "clay":
        parts["body"].data.materials.append(clay("Clay", (0.16, 0.22, 0.60)))
        white = clay("White", (0.9, 0.9, 0.9), roughness=0.2, coat=1.0)
        for obj in [*parts["eyes"], *parts["mouth"].values()]:
            obj.data.materials.append(white)
    else:
        look.dress(parts, fur=finish == "fur")
    light("Key", (-2.5, -3.2, 3.2), 380, 3.0)
    light("Fill", (3.0, -2.5, 1.2), 120, 4.0)
    light("Rim", (0.8, 3.0, 2.6), 220, 2.0)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    finish = "clay"
    if args[0].startswith("--"):
        finish = args.pop(0)[2:]
    out_dir = os.path.abspath(args[0])
    specs = args[1:] or ["stand:front", "stand:three-quarter", "wave:back", "rest:front", "rest:left"]
    setup_render()
    if finish == "fur":
        bpy.context.scene.cycles.samples = 64
    built = None
    for spec in specs:
        pose_name, view = spec.split(":")
        if pose_name != built:
            build(pose_name, finish)
            built = pose_name
        cam = camera(view)
        bpy.context.scene.render.filepath = os.path.join(out_dir, f"{finish}-{pose_name}-{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


main()
