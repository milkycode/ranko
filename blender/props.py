"""The things Ranko holds, sits on or sweats: each hangs from a bone of the
rig and stays out of the picture until a pose shows it. Imported by
blender/rig.py.

A prop is an empty with its pieces under it, so it shows, moves and scales
as one. Poses name it like a bone: `<prop>@show`, `<prop>@offset` (in the
world's axes of the rest pose) and `<prop>@scale`.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

import look
import model

deg = math.radians

# Each prop's place on its bone as built, which poses move it from.
REST = {}


def _group(name, at=None):
    """An empty to hang a prop's pieces from, at `at` in the world: set as its
    world matrix, which rig.to_bone reads before any scene update."""
    empty = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(empty)
    if at is not None:
        empty.matrix_world = Matrix.Translation(at)
    return empty


def _rounded_box(name, size, bevel, material, parent, location=(0, 0, 0), rotation=(0, 0, 0), soft=0):
    """A box with softened edges, its size baked into the mesh; `soft`
    subdivides it into a pillow."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=4, affect="EDGES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.parent = parent
    obj.location = location
    obj.rotation_euler = rotation
    if soft:
        sub = obj.modifiers.new("Soft", "SUBSURF")
        sub.levels = sub.render_levels = soft
    return obj


def _teardrop(name, material, parent):
    """A sweat drop: a sphere whose top half is drawn up into a point."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=1.0)
    for v in bm.verts:
        if v.co.z > 0:
            pinch = 1 - 0.85 * v.co.z
            v.co.x *= pinch
            v.co.y *= pinch
            v.co.z *= 1.7
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.parent = parent
    obj.scale = (0.022, 0.016, 0.026)
    return obj


def _heart(name, material, parent):
    """A heart from two lobes and a point, turned toward the camera."""
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    root.parent = parent
    root.rotation_euler = (0, 0, deg(-22))
    root.scale = (0.045, 0.045, 0.045)
    for side in (-1, 1):
        lobe = bpy.data.objects.new(f"{name}Lobe{side}", _sphere_mesh(f"{name}Lobe{side}", 0.6))
        bpy.context.scene.collection.objects.link(lobe)
        lobe.data.materials.append(material)
        lobe.parent = root
        lobe.location = (side * 0.5, 0, 0.25)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.98, radius2=0.0, depth=1.1)
    me = bpy.data.meshes.new(f"{name}Point")
    bm.to_mesh(me)
    bm.free()
    point = bpy.data.objects.new(f"{name}Point", me)
    bpy.context.scene.collection.objects.link(point)
    point.data.materials.append(material)
    point.parent = root
    point.location = (0, 0, -0.45)
    point.rotation_euler = (deg(180), 0, 0)
    point.scale = (1.0, 0.55, 1.0)
    return root


def _sphere_mesh(name, radius):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=radius)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    return me


def _letter(name, text, size, material, parent):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = text
    curve.size = size
    curve.extrude = size * 0.08
    curve.bevel_depth = size * 0.03
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.parent = parent
    # Upright, facing the camera off to his right.
    obj.rotation_euler = (deg(90), 0, deg(-22))
    return obj


def build(parts, rig, to_bone):
    """Every prop, hidden, hung from its bone: {name: empty}."""
    props = {}

    # A sweat drop at his right temple, the side the camera sees.
    water = look.plain("Water", (0.35, 0.62, 1.0), roughness=0.05, coat=1.0)
    water.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.35, 0.62, 1.0, 1)
    water.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.2
    sweat = _group("Sweat", model._lifted(tuple(model.HEAD_MATRIX @ Vector((-0.235, -0.115, 0.955)))))
    _teardrop("SweatDrop", water, sweat)
    to_bone(sweat, rig, "head")
    props["sweat"] = sweat

    # A little silver laptop, open, for his lap.
    metal = look.plain("Aluminium", (0.42, 0.43, 0.47), roughness=0.45)
    metal.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
    keys = look.plain("Keys", (0.05, 0.05, 0.06), roughness=0.5)
    screen = look.plain("Screen", (0.05, 0.10, 0.25), roughness=0.15, coat=0.8)
    screen.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.35, 0.55, 1.0, 1)
    screen.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.8
    # The keys on the side toward him (+Y); the hinge at the far edge, the lid
    # standing up there, its screen facing him and its back to the camera.
    laptop = _group("Laptop", (0, -0.36, 0.13))
    _rounded_box("LaptopBase", (0.30, 0.20, 0.014), 0.006, metal, laptop)
    _rounded_box("LaptopKeys", (0.26, 0.11, 0.004), 0.0015, keys, laptop, (0, 0.02, 0.008))
    lid = _group("LaptopHinge")
    lid.parent = laptop
    lid.location = (0, -0.10, 0.007)
    # Shut, the lid lies over the keys with its screen down; it opens by
    # turning up about the hinge.
    lid.rotation_euler = (deg(105), 0, 0)
    _rounded_box("LaptopLid", (0.30, 0.20, 0.010), 0.005, metal, lid, (0, 0.10, 0.0))
    _rounded_box("LaptopScreen", (0.26, 0.16, 0.002), 0.0008, screen, lid, (0, 0.10, -0.0055))
    to_bone(laptop, rig, "root")
    props["laptop"] = laptop

    # A velvet cushion to doze on.
    velvet = look.plain("Velvet", (0.025, 0.05, 0.24), roughness=0.75)
    velvet.node_tree.nodes["Principled BSDF"].inputs["Sheen Weight"].default_value = 0.6
    velvet.node_tree.nodes["Principled BSDF"].inputs["Sheen Tint"].default_value = (0.5, 0.6, 1.0, 1)
    cushion = _group("Cushion", (0, 0, 0))
    _rounded_box("CushionBody", (0.72, 0.62, 0.13), 0.03, velvet, cushion, (0, 0, 0.065), soft=2)
    to_bone(cushion, rig, "root")
    props["cushion"] = cushion

    # Three z's rising off him as he sleeps, lit a little from within so they
    # show on a dark terminal.
    ink = look.plain("Zs", (0.30, 0.48, 1.0), roughness=0.4)
    ink.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.30, 0.48, 1.0, 1)
    ink.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.6
    for i, (text, size) in enumerate((("z", 0.07), ("z", 0.09), ("Z", 0.12))):
        z = _group(f"Z{i + 1}", (0.18, -0.05, 1.0))
        _letter(f"Z{i + 1}Letter", text, size, ink, z)
        to_bone(z, rig, "root")
        props[f"z{i + 1}"] = z

    # Three hearts that float up off him when he is patted.
    love = look.plain("Heart", (0.95, 0.12, 0.30), roughness=0.25, coat=1.0)
    love.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.95, 0.12, 0.30, 1)
    love.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.6
    for i, x in enumerate((-0.16, 0.02, 0.18)):
        heart = _group(f"Heart{i + 1}", (x, -0.12, 1.05))
        _heart(f"Heart{i + 1}Shape", love, heart)
        to_bone(heart, rig, "root")
        props[f"heart{i + 1}"] = heart

    for name, prop in props.items():
        REST[name] = prop.matrix_basis.copy()
        show(prop, False)
    return props


def show(prop, visible):
    for obj in [prop, *prop.children_recursive]:
        obj.hide_render = not visible


def meshes(props):
    """The objects that draw something, for the render layers."""
    return [o for p in props.values() for o in p.children_recursive if o.type in ("MESH", "FONT")]


def pose(props, values):
    """Shows, moves and scales the props a pose names; hides the rest."""
    for name, prop in props.items():
        rest = REST[name]
        visible = bool(values.get(f"{name}@show", False))
        show(prop, visible)
        offset = Vector(values.get(f"{name}@offset", (0, 0, 0)))
        scale = values.get(f"{name}@scale", 1.0)
        if not isinstance(scale, (tuple, list)):
            scale = (scale, scale, scale)
        # Hung by rig.to_bone, the prop's own matrix is in the world's axes of
        # the rest pose, its bone's rest undone by the parent inverse.
        prop.matrix_basis = Matrix.Translation(offset) @ rest @ Matrix.Diagonal((*scale, 1.0))
