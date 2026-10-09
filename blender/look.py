"""Ranko's materials and fur: what turns the clay body into the monster in
previews/. Imported by the scripts that render him.

The fur is a hair particle system on the body, cerulean blue with violet
patches, darker at the roots and lighter at the tips. It leaves out the
inside of the mouth and the skin under the eyeballs, and thins toward the
lips, from the weights blender/model.py works out.
"""

import bpy
import numpy as np

import model

BLUE = (0.07, 0.19, 0.80)
TONE_SCALE = 1.25  # the tone is stored divided by this, to stay under 1
VIOLET = (0.17, 0.08, 0.52)


def _node(tree, kind, **inputs):
    node = tree.nodes.new(kind)
    for name, value in inputs.items():
        node.inputs[name].default_value = value
    return node


def _patches(tree, scale=3.2):
    """A 0..1 field of large blotches, the violet patches of the coat."""
    coords = tree.nodes.new("ShaderNodeTexCoord")
    noise = _node(tree, "ShaderNodeTexNoise", Scale=scale, Detail=2.0, Roughness=0.55)
    tree.links.new(coords.outputs["Object"], noise.inputs["Vector"])
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.42
    ramp.color_ramp.elements[1].position = 0.70
    tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    return ramp


def _toned(tree, color):
    """`color` times the body's `tone` attribute (hair takes it from the
    skin at its root), so shaded places darken the coat."""
    tone = tree.nodes.new("ShaderNodeAttribute")
    tone.attribute_name = "tone"
    scaled = _node(tree, "ShaderNodeMath", Value_001=TONE_SCALE)
    scaled.operation = "MULTIPLY"
    tree.links.new(tone.outputs["Fac"], scaled.inputs[0])
    mul = _node(tree, "ShaderNodeMix", Factor=1.0)
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    tree.links.new(color, mul.inputs["A"])
    tree.links.new(scaled.outputs["Value"], mul.inputs["B"])
    return mul.outputs["Result"]


def fur_material():
    """The hair: blue and violet by patch, roots in shadow, tips catching light."""
    mat = bpy.data.materials.new("Fur")
    tree = mat.node_tree
    tree.nodes.remove(tree.nodes["Principled BSDF"])
    hair = tree.nodes.new("ShaderNodeBsdfHairPrincipled")
    hair.parametrization = "COLOR"
    for name, value in {"Roughness": 0.55, "Radial Roughness": 0.7, "Coat": 0.0,
                        "Random Roughness": 0.3}.items():
        hair.inputs[name].default_value = value

    patches = _patches(tree)
    coat = _node(tree, "ShaderNodeMix", Factor=0.0)
    coat.data_type = "RGBA"
    coat.inputs["A"].default_value = (*BLUE, 1)
    coat.inputs["B"].default_value = (*VIOLET, 1)
    tree.links.new(patches.outputs["Color"], coat.inputs["Factor"])

    # Darker toward the root, a touch lighter and bluer at the tip.
    info = tree.nodes.new("ShaderNodeHairInfo")
    shade = tree.nodes.new("ShaderNodeValToRGB")
    shade.color_ramp.elements[0].color = (0.35, 0.33, 0.45, 1)
    shade.color_ramp.elements[1].color = (1.0, 1.04, 1.1, 1)
    tree.links.new(info.outputs["Intercept"], shade.inputs["Fac"])
    tinted = _node(tree, "ShaderNodeMix", Factor=1.0)
    tinted.data_type = "RGBA"
    tinted.blend_type = "MULTIPLY"
    tree.links.new(coat.outputs["Result"], tinted.inputs["A"])
    tree.links.new(shade.outputs["Color"], tinted.inputs["B"])

    tree.links.new(_toned(tree, tinted.outputs["Result"]), hair.inputs["Color"])
    tree.links.new(hair.outputs["BSDF"], tree.nodes["Material Output"].inputs["Surface"])
    return mat


def skin_material():
    """The body under the fur, seen between strands: the coat's colours, dark."""
    mat = bpy.data.materials.new("Skin")
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Sheen Weight"].default_value = 0.6
    bsdf.inputs["Sheen Tint"].default_value = (0.5, 0.6, 1.0, 1)
    patches = _patches(tree)
    coat = _node(tree, "ShaderNodeMix", Factor=0.0)
    coat.data_type = "RGBA"
    coat.inputs["A"].default_value = tuple(c * 0.55 for c in BLUE) + (1,)
    coat.inputs["B"].default_value = tuple(c * 0.55 for c in VIOLET) + (1,)
    tree.links.new(patches.outputs["Color"], coat.inputs["Factor"])
    tree.links.new(_toned(tree, coat.outputs["Result"]), bsdf.inputs["Base Color"])
    return mat


def plain(name, color, roughness=0.4, coat=0.0, subsurface=0.0):
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Subsurface Weight"].default_value = subsurface
    bsdf.inputs["Subsurface Radius"].default_value = (0.02, 0.01, 0.008)
    return mat


def eye_material():
    """White, a grey iris with a dark rim, a black pupil, all under a glossy
    coat; the iris sits where the eyeball's -Y points, so turning the eye
    moves the gaze."""
    mat = bpy.data.materials.new("Eye")
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.25
    bsdf.inputs["Coat Weight"].default_value = 1.0
    bsdf.inputs["Coat Roughness"].default_value = 0.03
    bsdf.inputs["Subsurface Weight"].default_value = 0.15

    coords = tree.nodes.new("ShaderNodeTexCoord")
    unit = tree.nodes.new("ShaderNodeVectorMath")
    unit.operation = "NORMALIZE"
    tree.links.new(coords.outputs["Object"], unit.inputs[0])
    facing = tree.nodes.new("ShaderNodeVectorMath")
    facing.operation = "DOT_PRODUCT"
    facing.inputs[1].default_value = (0, -1, 0)
    tree.links.new(unit.outputs["Vector"], facing.inputs[0])

    ramp = tree.nodes.new("ShaderNodeValToRGB")
    # A big iris, about half the eye across, and a big pupil in it.
    white, ring, iris, inner, pupil = (0.80, 0.80, 0.82), (0.04, 0.04, 0.05), (0.30, 0.30, 0.33), \
        (0.20, 0.20, 0.22), (0.003, 0.003, 0.004)
    stops = [(0.0, white), (0.852, white), (0.861, ring), (0.874, iris), (0.938, inner), (0.951, ring),
             (0.955, pupil), (1.0, pupil)]
    elements = ramp.color_ramp.elements
    while len(elements) < len(stops):
        elements.new(0.5)
    for element, (position, color) in zip(elements, stops):
        element.position = position
        element.color = (*color, 1)
    tree.links.new(facing.outputs["Value"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def add_fur(body, weights, count=160000, length=0.013):
    """Hair over the body, its density from `weights` (a vertex group)."""
    mod = body.modifiers.new("Fur", "PARTICLE_SYSTEM")
    psys = mod.particle_system
    psys.vertex_group_density = weights
    psys.vertex_group_length = weights
    ps = psys.settings
    ps.type = "HAIR"
    ps.count = count
    ps.use_modifier_stack = True
    ps.emit_from = "FACE"
    ps.use_even_distribution = True
    ps.material = 1  # counted from 1: the body's first slot, Fur
    ps.child_type = "INTERPOLATED"
    ps.child_percent = 4
    ps.rendered_child_count = 14
    ps.child_length = 1.0
    ps.clump_factor = 0.20
    ps.clump_shape = 0.25
    ps.roughness_1 = 0.006
    ps.roughness_1_size = 1.0
    ps.roughness_endpoint = 0.008
    ps.roughness_end_shape = 1.0
    ps.root_radius = 0.0007
    ps.tip_radius = 0.0
    ps.radius_scale = 1.0
    ps.display_step = 3
    ps.render_step = 3
    # Tilted off the normal and a little downward, as a coat lies.
    ps.factor_random = length * 0.35
    ps.object_align_factor = (0, 0, -length * 0.45)
    ps.hair_length = length
    return mod


def dress(parts, fur=True):
    """Materials on every part, fur on the body. `parts` is what
    blender/model.py built: body, eyes, and the mouth's teeth and tongue."""
    body = parts["body"]
    hair = fur_material()
    body.data.materials.append(hair)
    body.data.materials.append(skin_material())
    body.data.materials.append(plain("Mouth", (0.018, 0.010, 0.045), roughness=0.55))

    body.data.materials.append(plain("Pad", (0.05, 0.08, 0.36), roughness=0.55, subsurface=0.1))

    inside, sole, density = model.surface_regions(body)
    # Faces in the hollow of the mouth get its dark lining, the soles their
    # bare pads; the rest, skin.
    me = body.data
    corners = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", corners)
    starts = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", starts)
    sizes = np.diff(np.append(starts, len(corners)))
    depth = np.add.reduceat(inside[corners], starts) / sizes
    pad = np.add.reduceat(sole[corners], starts) / sizes
    index = np.where(depth > 0.5, 2, np.where(pad > 0.5, 3, 1))
    me.polygons.foreach_set("material_index", index.astype(np.int32))
    # Weights in steps of 1/64, a call per step rather than per vertex.
    group = body.vertex_groups.new(name="fur")
    steps = np.round(density * 64).astype(np.int32)
    for step in np.unique(steps[steps > 0]):
        group.add(np.nonzero(steps == step)[0].tolist(), step / 64, "REPLACE")
    # Hair reads only byte colours per face corner from the skin under it, so
    # the tone is stored that way, scaled to fit under 1.
    tone = model.surface_tone(body)[corners] / TONE_SCALE
    attribute = me.color_attributes.new("tone", "BYTE_COLOR", "CORNER")
    attribute.data.foreach_set("color", np.repeat(tone, 4).astype(np.float32))
    if fur:
        add_fur(body, "fur")

    eye = eye_material()
    for e in parts["eyes"]:
        e.data.materials.append(eye)
    teeth = plain("Teeth", (0.86, 0.85, 0.80), roughness=0.22, coat=0.4, subsurface=0.2)
    parts["mouth"]["TeethUpper"].data.materials.append(teeth)
    parts["mouth"]["TeethLower"].data.materials.append(teeth)
    parts["mouth"]["Tongue"].data.materials.append(plain("Tongue", (0.62, 0.20, 0.26), roughness=0.35,
                                                         subsurface=0.3))


def lights(eyes, center=(0, 0, 0.55)):
    """A soft studio: key from the upper left, fill from the right, a rim
    from behind that makes the fur's edge glow, and a small light that only
    the eyes see, for the glint in them."""
    from mathutils import Vector
    center = Vector(center)

    def area(name, location, energy, size, color=(1, 1, 1)):
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.size, data.color = energy, size, color
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (center - Vector(location)).to_track_quat("-Z", "Y").to_euler()
        return obj

    area("Key", (-2.5, -3.2, 3.2), 380, 3.0, (1.0, 0.97, 0.93))
    area("Fill", (3.0, -2.5, 1.2), 120, 4.0, (0.92, 0.95, 1.0))
    area("Rim", (0.8, 3.0, 2.6), 220, 2.0, (0.9, 0.85, 1.0))
    glint = area("Glint", (1.2, -3.0, 2.0), 60, 0.25)
    seen_by = bpy.data.collections.new("Eyes")
    for eye in eyes:
        seen_by.objects.link(eye)
    glint.light_linking.receiver_collection = seen_by
