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
LID_REACH = 1.0  # how far from its rim, as a share of its depth, a lid is dark
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


def fur_material(name="Fur", patches=True):
    """The hair: blue and violet by patch, roots in shadow, tips catching light."""
    mat = bpy.data.materials.new(name)
    tree = mat.node_tree
    tree.nodes.remove(tree.nodes["Principled BSDF"])
    hair = tree.nodes.new("ShaderNodeBsdfHairPrincipled")
    hair.parametrization = "COLOR"
    for name, value in {"Roughness": 0.55, "Radial Roughness": 0.7, "Coat": 0.0,
                        "Random Roughness": 0.3}.items():
        hair.inputs[name].default_value = value

    coat = _node(tree, "ShaderNodeMix", Factor=0.0)
    coat.data_type = "RGBA"
    coat.inputs["A"].default_value = (*BLUE, 1)
    coat.inputs["B"].default_value = (*VIOLET, 1)
    if patches:
        tree.links.new(_patches(tree).outputs["Color"], coat.inputs["Factor"])

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


def skin_material(name="Skin", patches=True):
    """The body under the fur, seen between strands: the coat's colours, dark."""
    mat = bpy.data.materials.new(name)
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Sheen Weight"].default_value = 0.6
    bsdf.inputs["Sheen Tint"].default_value = (0.5, 0.6, 1.0, 1)
    coat = _node(tree, "ShaderNodeMix", Factor=0.0)
    coat.data_type = "RGBA"
    coat.inputs["A"].default_value = tuple(c * 0.55 for c in BLUE) + (1,)
    coat.inputs["B"].default_value = tuple(c * 0.55 for c in VIOLET) + (1,)
    if patches:
        tree.links.new(_patches(tree).outputs["Color"], coat.inputs["Factor"])
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
    # A little light carried inside the white; more would wash out the iris.
    bsdf.inputs["Subsurface Weight"].default_value = 0.05

    coords = tree.nodes.new("ShaderNodeTexCoord")
    unit = tree.nodes.new("ShaderNodeVectorMath")
    unit.operation = "NORMALIZE"
    tree.links.new(coords.outputs["Object"], unit.inputs[0])
    facing = tree.nodes.new("ShaderNodeVectorMath")
    facing.operation = "DOT_PRODUCT"
    facing.inputs[1].default_value = (0, -1, 0)
    tree.links.new(unit.outputs["Vector"], facing.inputs[0])

    ramp = tree.nodes.new("ShaderNodeValToRGB")
    # Measured off the main preview: the iris about 0.41 of the eye across,
    # the pupil about 0.24.
    white, ring, iris, inner, pupil = (0.80, 0.80, 0.82), (0.02, 0.02, 0.025), (0.13, 0.13, 0.145), \
        (0.08, 0.08, 0.09), (0.003, 0.003, 0.004)
    stops = [(0.0, white), (0.905, white), (0.911, ring), (0.919, iris), (0.960, inner), (0.967, ring),
             (0.970, pupil), (1.0, pupil)]
    elements = ramp.color_ramp.elements
    while len(elements) < len(stops):
        elements.new(0.5)
    for element, (position, color) in zip(elements, stops):
        element.position = position
        element.color = (*color, 1)
    tree.links.new(facing.outputs["Value"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def add_fur(body, weights, count=220000, length=0.012, children=14, radius=0.0005, lie=0.45):
    """Hair over the body, its density from `weights` (a vertex group)."""
    mod = body.modifiers.new("Fur", "PARTICLE_SYSTEM")
    psys = mod.particle_system
    psys.vertex_group_density = weights
    psys.vertex_group_length = weights
    ps = psys.settings
    ps.type = "HAIR"
    ps.count = count
    # From the skin as built: the armature above it in the stack carries the
    # hair along as it bends the skin.
    ps.use_modifier_stack = False
    ps.emit_from = "FACE"
    ps.use_even_distribution = True
    ps.material = 1  # counted from 1: the body's first slot, Fur
    ps.child_type = "INTERPOLATED"
    ps.child_percent = 4
    ps.rendered_child_count = children
    ps.child_length = 1.0
    ps.clump_factor = 0.20
    ps.clump_shape = 0.25
    ps.roughness_1 = 0.006
    ps.roughness_1_size = 1.0
    ps.roughness_endpoint = 0.008
    ps.roughness_end_shape = 1.0
    ps.root_radius = radius
    ps.tip_radius = 0.0
    ps.radius_scale = 1.0
    ps.display_step = 3
    ps.render_step = 3
    # Tilted off the normal and `lie` of the way downward, as a coat lies.
    ps.factor_random = length * 0.35
    ps.object_align_factor = (0, 0, -length * lie)
    ps.hair_length = length
    return mod


def _fill(me, name, value, kind="FLOAT_COLOR"):
    attribute = me.color_attributes.new(name, kind, "CORNER")
    attribute.data.foreach_set("color", np.full(len(me.loops) * 4, value, dtype=np.float32))


# Strands on the body (count, children each, root radius): in full, for a
# quicker draft, and for the small frames the mod plays, where a pixel is
# about 6 mm of Ranko and thicker, fewer strands read the same.
STRANDS = {"full": (220000, 14, 0.0005), "draft": (120000, 9, 0.0005), "frames": (50000, 6, 0.0010)}


def dress(parts, fur=True, draft=False, strands=None):
    """Materials on every part, fur on the body and the lids (fewer strands
    for a `draft`, or as many as `strands` names). `parts` is what
    blender/rig.py built: body, eyes, lids, and the mouth's teeth and tongue."""
    count, children, radius = STRANDS[strands or ("draft" if draft else "full")]
    body = parts["body"]
    hair = fur_material()
    body.data.materials.append(hair)
    body.data.materials.append(skin_material())
    body.data.materials.append(plain("Mouth", (0.030, 0.022, 0.075), roughness=0.55))

    body.data.materials.append(plain("Pad", (0.05, 0.08, 0.36), roughness=0.55, subsurface=0.1))
    body.data.materials.append(plain("Lip", (0.050, 0.080, 0.340), roughness=0.50, subsurface=0.15))

    inside, lip, sole, density = model.surface_regions(body)
    # Faces just inside the mouth get bare blue lip, those further in its dark
    # lining, the soles their bare pads; the rest, skin.
    me = body.data
    corners = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", corners)
    starts = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", starts)
    sizes = np.diff(np.append(starts, len(corners)))
    depth = np.add.reduceat(inside[corners], starts) / sizes
    pad = np.add.reduceat(sole[corners], starts) / sizes
    bare = np.add.reduceat(lip[corners], starts) / sizes
    index = np.where(bare > 0.5, 4, np.where(depth > 0.5, 2, np.where(pad > 0.5, 3, 1)))
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
        add_fur(body, "fur", count=count, children=children, radius=radius)

    # The lids: short fur over skin, plain blue as the face around them, and
    # a dark line along the rim where they meet the eye when shut.
    lid_fur, lid_skin = fur_material("LidFur", patches=False), skin_material("LidSkin", patches=False)
    lid_line = plain("LidLine", (0.006, 0.008, 0.05), roughness=0.6)
    for lid in parts.get("lids", []):
        for mat in (lid_fur, lid_skin, lid_line):
            lid.data.materials.append(mat)
        lid.data.polygons.foreach_set("material_index", np.ones(len(lid.data.polygons), dtype=np.int32))
        # Toward the rim the lid darkens and its fur thins out, so where the
        # two lids of a shut eye meet, a dark lash line shows.
        co = np.empty(len(lid.data.vertices) * 3, dtype=np.float32)
        lid.data.vertices.foreach_get("co", co)
        from_rim = np.clip(-co[1::3] / (0.30 * LID_REACH * np.abs(co[1::3]).max()), 0, 1)
        lid_corners = np.empty(len(lid.data.loops), dtype=np.int32)
        lid.data.loops.foreach_get("vertex_index", lid_corners)
        tone = (0.30 + 0.70 * from_rim) / TONE_SCALE
        attribute = lid.data.color_attributes.new("tone", "BYTE_COLOR", "CORNER")
        attribute.data.foreach_set("color", np.repeat(tone[lid_corners], 4).astype(np.float32))
        group = lid.vertex_groups.new(name="fur")
        steps = np.round(np.clip(from_rim * 1.6 - 0.6, 0, 1) * 64).astype(np.int32)
        for step in np.unique(steps[steps > 0]):
            group.add(np.nonzero(steps == step)[0].tolist(), step / 64, "REPLACE")
        if fur:
            # Straight out: the lid turns, so "down" in its own frame is anywhere.
            add_fur(lid, "fur", count=max(2000, count // 40), length=0.005, children=children, radius=radius, lie=0)

    eye = eye_material()
    for e in parts["eyes"]:
        e.data.materials.append(eye)
    teeth = plain("Teeth", (0.86, 0.85, 0.80), roughness=0.22, coat=0.4, subsurface=0.2)
    parts["mouth"]["TeethUpper"].data.materials.append(teeth)
    parts["mouth"]["TeethLower"].data.materials.append(teeth)
    parts["mouth"]["Tongue"].data.materials.append(plain("Tongue", (0.50, 0.17, 0.22), roughness=0.35,
                                                         subsurface=0.3))


def clay(parts):
    """Grey-blue clay over everything, to judge shape alone."""
    parts["body"].data.materials.append(plain("Clay", (0.16, 0.22, 0.60), roughness=0.55))
    for lid in parts.get("lids", []):
        lid.data.materials.append(parts["body"].data.materials[0])
    white = plain("White", (0.9, 0.9, 0.9), roughness=0.2, coat=1.0)
    for obj in [*parts["eyes"], *parts["mouth"].values()]:
        obj.data.materials.append(white)


def lights(eyes, center=(0, 0, 0.55), ground=(), lids=()):
    """A soft studio: key from the upper left, fill from the right and a rim
    from behind that makes the fur's edge glow. The eyes are lit apart: the
    big lights, mirrored in their glossy coat, would lay a haze over the
    iris, so the eyes get a soft light they do not mirror and one small
    glint they do."""
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

    def receivers(name, objects, state):
        group = bpy.data.collections.new(name)
        for obj in objects:
            group.objects.link(obj)
        for member in group.collection_objects:
            member.light_linking.link_state = state
        return group

    # Nor do they reach the ground: only the light above casts his shadow.
    not_eyes = receivers("NotEyes", [*eyes, *ground], "EXCLUDE")
    for light in (area("Key", (-2.5, -3.2, 3.2), 380, 3.0, (1.0, 0.97, 0.93)),
                  area("Fill", (3.0, -2.5, 1.2), 120, 4.0, (0.92, 0.95, 1.0))):
        light.light_linking.receiver_collection = not_eyes
    # The rim light makes the fur glow along his outline; on the lids, whose
    # outline lies inside his face, it would ring them in white.
    rim = area("Rim", (0.8, 3.0, 2.6), 220, 2.0, (0.9, 0.85, 1.0))
    rim.light_linking.receiver_collection = receivers("NotLids", [*eyes, *ground, *lids], "EXCLUDE")

    only_eyes = receivers("Eyes", eyes, "INCLUDE")
    soft = area("EyeLight", (-1.4, -3.0, 2.2), 260, 2.5)
    soft.visible_glossy = False
    soft.light_linking.receiver_collection = only_eyes
    glint = area("Glint", (0.9, -3.0, 2.9), 90, 0.12)
    glint.light_linking.receiver_collection = only_eyes
