"""Bakes Ranko's clips into the frames the mod plays.

    blender -b --factory-startup -P blender/bake.py -- render build/layers [clip ...]
    blender -b --factory-startup -P blender/bake.py -- stills <dir> <scale> clip:frame ...

Every frame is rendered as two layers: Ranko alone on a clear background
(NNN.plush.png) and only the shadow he casts on the floor (NNN.shadow.png).
blender/composite.py lays one over the other into assets/frames, so the
shadow's look can change without rendering again. `render` also writes
<dir>/manifest.json, listing every clip in blender/clips.py.
"""

import json
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clips  # noqa: E402
import look  # noqa: E402
import props  # noqa: E402
import rig  # noqa: E402

# A square of 12 x 6 cells: about 192 x 192 device pixels in a Retina
# terminal, whose cells are roughly twice as tall as they are wide.
FRAME = 192
COLUMNS, ROWS = 12, 6

# Samples per layer: the shadow is a soft blur and needs far fewer.
LAYERS = {"plush": 48, "shadow": 16}

# The camera stands off to his right and a little above, as the main preview
# sees him, far enough back for a raised arm and a hop to stay in frame.
CAMERA = {"direction": (-0.42, -1.0, 0.20), "target": (0, 0, 0.60), "distance": 3.7, "lens": 85}


def setup_render(size):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type != "CPU"
    scene.cycles.device = "GPU"
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.compression = 90
    scene.view_settings.view_transform = "Standard"
    # A faint sky, as in the previews; the darkening it leaves round his feet
    # is kept to a pool there by blender/composite.py.
    world = bpy.data.worlds.new("World")
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.15
    scene.world = world


def setup_scene(parts):
    """The camera, the floor that keeps only his shadow, and the lights: the
    studio for him and one big light overhead, for the floor alone."""
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "Floor"
    floor.is_shadow_catcher = True
    ground = bpy.data.collections.new("Ground")
    ground.objects.link(floor)

    look.lights(parts["eyes"], ground=[floor], lids=parts["lids"])
    data = bpy.data.lights.new("Shadow", "AREA")
    data.energy, data.size = 300, 5.0
    shadow = bpy.data.objects.new("Shadow", data)
    bpy.context.scene.collection.objects.link(shadow)
    shadow.location = (0, 0, 2.6)
    # Big and close overhead, so the shadow is all soft edge: a pool, not a slab.
    shadow.light_linking.receiver_collection = ground

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = CAMERA["lens"]
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    target = Vector(CAMERA["target"])
    cam.location = target + Vector(CAMERA["direction"]).normalized() * CAMERA["distance"]
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    parts["floor"] = floor
    parts["toy"] = [parts["body"], *parts["eyes"], *parts["lids"], *parts["mouth"].values(),
                    *props.meshes(parts["props"])]


def set_layer(parts, layer):
    """Ranko alone (no floor), or the floor's shadow alone: Ranko hidden from
    the camera but still blocking the light, so the shadow is all that shows."""
    parts["floor"].hide_render = layer != "shadow"
    for obj in parts["toy"]:
        obj.visible_camera = layer == "plush"
    bpy.context.scene.cycles.samples = LAYERS[layer]


def _entry(clip):
    entry = {"frames": clip.frames, "loop": clip.loop}
    if clip.posture != "stand":
        entry["posture"] = clip.posture
    if clip.transition:
        entry["transition"] = list(clip.transition)
    return entry


def write_manifest(out_dir):
    manifest = {
        "fps": clips.FPS,
        "columns": COLUMNS,
        "rows": ROWS,
        "clips": {name: _entry(c) for name, c in clips.CLIPS.items()},
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


def render_frame(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    command = args[0]
    parts = rig.build("fur", strands="frames")
    setup_scene(parts)

    if command == "stills":
        # stills <dir> <scale> clip:frame ...: single frames for a contact sheet.
        out_dir, scale = os.path.abspath(args[1]), int(args[2])
        setup_render(FRAME * scale)
        for layer in LAYERS:
            set_layer(parts, layer)
            for spec in args[3:]:
                clip, frame = spec.split(":")
                rig.pose(parts, clips.pose_at(clip, int(frame)))
                render_frame(os.path.join(out_dir, f"{clip}-{frame}.{layer}.png"))
    elif command == "render":
        out_dir = os.path.abspath(args[1])
        names = args[2:] or list(clips.CLIPS)
        write_manifest(out_dir)
        setup_render(FRAME)
        for name in names:
            for layer in LAYERS:
                set_layer(parts, layer)
                for frame in range(clips.CLIPS[name].frames):
                    rig.pose(parts, clips.pose_at(name, frame))
                    render_frame(os.path.join(out_dir, name, f"{frame:03d}.{layer}.png"))
    else:
        raise SystemExit(f"unknown command {command}")


main()
