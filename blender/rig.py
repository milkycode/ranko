"""Rigs Ranko: an armature on the skeleton blender/model.py sculpts him on,
the skin weighed from the shapes each bone carries, and the eyes, lids,
teeth and tongue hung on bones of their own. Imported by the scripts that
pose and render him.

The body is built once, in the rest pose, and the armature bends it from
there, so the fur stays put on the skin from frame to frame.

A pose is a dict: for a bone, its turn about its head, in the world's axes
of the rest pose, applied on top of its parent's (as model.pose_matrices
reads it); `<bone>@twist` turns a bone about its own length first;
`<digit>@curl` and `<digit>@spread` bend a finger at its knuckle and swing
it across the hand; `@offset` moves the whole of him, `<bone>@offset` one
bone; `<bone>@scale` stretches a bone along the world's axes; `@mouth` opens
the mouth from shut (0) to the sculpted grin (1).
"""

import math
from dataclasses import dataclass

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

import look
import model
import props
from model import Bone

# How far each kind of bone's pull reaches beyond its own shapes: wide over
# the soft trunk, tight between the fingers.
REACH = {"hips": 0.05, "chest": 0.05, "head": 0.03, "upper_arm": 0.02, "forearm": 0.02, "hand": 0.012,
         "index": 0.005, "middle": 0.005, "ring": 0.005, "thumb": 0.006, "thigh": 0.025, "foot": 0.02, "tail": 0.03}
MAX_INFLUENCES = 4

# Bones that keep their size when the one they hang from is stretched, so a
# breath swells the belly and not the head or the arms.
OWN_SCALE = {"head", "upper_arm.L", "upper_arm.R", "thigh.L", "thigh.R", "tail.1"}

# Each lid is half a shell over the eyeball, a little larger than it. Open,
# the upper lid lies back over the top of the eye and the lower lid back under
# it, both inside the head; shut, they meet a little below the middle of the
# eye, where their rims draw the lash line. OPEN is where each sits open, as a
# turn about the eye's side-to-side axis from covering its front; SHUT is how
# far each turns to close.
LID_RADIUS = {"upper": model.EYE_RADIUS * 1.09 + 0.003, "lower": model.EYE_RADIUS * 1.07 + 0.003}
OPEN = {"upper": -165.0, "lower": 165.0}
SHUT = {"upper": 95.0, "lower": -55.0}


def from_head(q):
    """A point of the head's own frame, where it sits on the lifted body."""
    return model._lifted(tuple(model.HEAD_MATRIX @ Vector(q)))


def face_bones():
    """Bones for the face, hung from the head: an eye and a lid per side, both
    turning about the eye's centre, a brow per side, and the jaw."""
    bones = []
    for side, s in (("L", 1), ("R", -1)):
        eye = Vector(from_head(model.eye_center(s)))
        bones += [Bone(f"eye.{side}", "head", tuple(eye), tuple(eye + Vector((0, -0.08, 0)))),
                  Bone(f"lid.{side}", "head", tuple(eye), tuple(eye + Vector((0, -0.06, 0)))),
                  Bone(f"lid_low.{side}", "head", tuple(eye), tuple(eye + Vector((0, -0.05, 0))))]
        brow = next(points for name, points, *_ in model.face_features()
                    if name == "brow" and points[0][0] * s > 0)
        middle = Vector(from_head(brow[len(brow) // 2]))
        bones.append(Bone(f"brow.{side}", "head", tuple(middle), tuple(middle + Vector((0, -0.05, 0)))))
    # The hinge sits behind the corners of the mouth, the jaw reaching to the chin.
    hinge = from_head((0, model.front(0, 0.78) + 0.15, 0.79))
    chin = from_head((0, model.front(0, 0.66), 0.66))
    bones.append(Bone("jaw", "head", hinge, chin))
    return bones


def all_bones():
    return list(model.BONES) + face_bones()


def build_armature(bones):
    data = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for b in bones:
        edit = data.edit_bones.new(b.name)
        edit.head, edit.tail = b.head, b.tail
        if b.parent:
            edit.parent = data.edit_bones[b.parent]
        if b.name in OWN_SCALE:
            edit.inherit_scale = "NONE"
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def _smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def weights(body):
    """{bone: weight per vertex}: each bone pulls the skin over its own
    shapes, fading out over its REACH; where the shapes meet, they share."""
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    p = tuple(co.reshape(-1, 3).T)
    parts = {}
    model.field(lambda bone: p, parts=parts)

    names = list(parts)
    distance = np.stack([parts[n] for n in names])
    reach = np.array([REACH[n.split(".")[0]] for n in names], dtype=np.float32)[:, None]
    score = (distance - distance.min(0)) / reach
    w = np.where(score < 6, np.exp(-np.minimum(score, 6)), 0.0)
    # Only the strongest few pulls on each vertex.
    weakest = np.argsort(-w, axis=0)[MAX_INFLUENCES:]
    np.put_along_axis(w, weakest, 0.0, axis=0)
    w /= w.sum(0)
    out = dict(zip(names, w))

    # The head's share is split with the face: the brows, and the jaw below
    # the upper lip at the front of the head.
    ph = model.head_space(model.body_space(p))
    x, y, z = ph
    head = out["head"]
    jaw = (_smooth((model.upper_lip(x) - 0.006 - z) / 0.02)
           * _smooth((model.front(0, 0.72) + 0.17 - y) / 0.06)
           * _smooth((model.MOUTH_HALF_WIDTH + 0.08 - np.abs(x)) / 0.06)
           * _smooth((z - 0.60) / 0.05))
    rest = 1 - jaw
    out["jaw"] = head * jaw
    for name, points, radii, *_ in model.face_features():
        if name == "brow":
            side = "L" if points[0][0] > 0 else "R"
            brow = _smooth(1 - np.maximum(model.tube(ph, points, radii), 0) * model.HEAD_SCALE / 0.022)
            out[f"brow.{side}"] = head * brow
            rest = rest - brow
    out["head"] = head * np.clip(rest, 0, 1)
    return out


def assign(body, rig, bone_weights):
    """Vertex groups from the weights, in steps of 1/256, and the armature
    that bends the body by them, first in its modifier stack."""
    for bone, w in bone_weights.items():
        steps = np.round(w * 256).astype(np.int32)
        if not steps.any():
            continue
        group = body.vertex_groups.new(name=bone)
        for step in np.unique(steps[steps > 0]):
            group.add(np.nonzero(steps == step)[0].tolist(), step / 256, "REPLACE")
    mod = body.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    # Joints keep their volume instead of pinching.
    mod.use_deform_preserve_volume = True
    body.parent = rig


def to_bone(obj, rig, bone):
    """Hangs a rigid part from a bone, where it is now."""
    world = obj.matrix_world.copy()
    b = rig.data.bones[bone]
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    obj.matrix_parent_inverse = (rig.matrix_world @ b.matrix_local @ Matrix.Translation((0, b.length, 0))).inverted()
    obj.matrix_basis = world


def build_lid(side, which):
    """A shell over the front half of the eyeball, as a rounded rim when
    seen edge on; built over the front, then turned open."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=24, radius=LID_RADIUS[which])
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > 1e-4], context="VERTS")
    name = f"Lid{'Low' if which == 'lower' else ''}{side}"
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    lid = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(lid)
    s = 1 if side == "L" else -1
    lid.matrix_world = (Matrix.Translation((0, 0, model.LIFT)) @ model.HEAD_MATRIX
                        @ Matrix.Translation(model.eye_center(s)) @ Matrix.Rotation(math.radians(OPEN[which]), 4, "X"))
    return lid


def thicken(lid):
    """The lid's rim, added after its fur, which grows from the shell itself."""
    thick = lid.modifiers.new("Rim", "SOLIDIFY")
    thick.thickness = 0.007
    thick.offset = -1
    # The rim takes the next material along: the lid's dark line.
    thick.material_offset_rim = 1


def mouth_gap(x):
    """How far the lower lip sits below the upper one at x, as sculpted, in
    the head's own frame: nothing past the corners."""
    return np.clip(model.upper_lip(x) - model.lower_lip(x, 1.0) - 0.002, 0, None)


def closing(p):
    """How far each point of the head's own frame rises when the mouth
    shuts: the lower lip all the way to the upper one, the floor of the mouth
    with it, the chin under it less and less, down to the neck."""
    x, y, z = p
    lip = model.lower_lip(x, 1.0)
    below = _smooth((model.upper_lip(x) - 0.004 - z) / 0.012)
    fade = _smooth((z - 0.58) / np.maximum(lip - 0.01 - 0.58, 1e-3))
    front = _smooth((model.front(0, 0.72) + 0.17 - y) / 0.06)
    return mouth_gap(x) * below * fade * front


def smile(p):
    """How far each point of the head's own frame moves up to bend a shut
    mouth's line into a smile: the corners up, the middle a little down,
    fading out a few centimetres above and below the line and past the
    corners."""
    x, y, z = p
    w = model.MOUTH_HALF_WIDTH
    across = np.minimum(np.abs(x) / w, 1.15)
    bend = 0.028 * across ** 2 - 0.006
    near = _smooth(1 - np.abs(z - model.upper_lip(x)) / 0.055)
    front = _smooth((model.front(0, 0.72) + 0.17 - y) / 0.06)
    inside = 1 - _smooth((np.abs(x) - w - 0.02) / 0.05)
    return bend * near * front * inside


def _shape_key(obj, name, co):
    if obj.data.shape_keys is None:
        obj.shape_key_add(name="Basis", from_mix=False)
    key = obj.shape_key_add(name=name, from_mix=False)
    key.data.foreach_set("co", co.astype(np.float32).ravel())


def _coords(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def add_mouth_keys(parts):
    """A `closed` shape key on everything the mouth is made of: the skin as
    `closing` lifts it and `smile` bends it, the lower teeth and tongue risen with the jaw but
    kept inside, the upper teeth tucked a little up and in. The teeth and
    tongue are meshes in the head's own frame."""
    body = parts["body"]
    co = _coords(body)
    head = model.head_space(model.body_space(tuple(co.T)))
    lift = (closing(head) + smile(head)) * model.HEAD_SCALE
    _shape_key(body, "closed", co + np.stack([0 * lift, 0 * lift, lift], 1))
    for name, back, keep_in in (("TeethLower", 0.02, 0.03), ("Tongue", 0.02, 0.06)):
        obj = parts["mouth"][name]
        co = _coords(obj)
        rise = np.clip(mouth_gap(co[:, 0]) - keep_in, 0, None)
        _shape_key(obj, "closed", co + np.stack([0 * rise, 0 * rise + back, rise], 1))
    obj = parts["mouth"]["TeethUpper"]
    _shape_key(obj, "closed", _coords(obj) + np.array([0, 0.015, 0.008], dtype=np.float32))


def build(finish="fur", draft=False, strands=None):
    """Ranko in the rest pose, rigged and dressed: `finish` is `clay`,
    `look` (materials, no fur), `draft` (thin fur) or `fur`; `strands`
    picks a fur density from look.STRANDS instead."""
    model.clear_scene()
    parts = {"body": model.build_body({}), "eyes": model.build_eyes({}), "mouth": model.build_mouth({}),
             "lids": [build_lid(side, which) for which in ("upper", "lower") for side in "LR"]}
    add_mouth_keys(parts)
    rig = build_armature(all_bones())
    assign(parts["body"], rig, weights(parts["body"]))
    for eye, side in zip(parts["eyes"], "LR"):
        to_bone(eye, rig, f"eye.{side}")
    for lid, bone in zip(parts["lids"], ("lid.L", "lid.R", "lid_low.L", "lid_low.R")):
        to_bone(lid, rig, bone)
    to_bone(parts["mouth"]["TeethUpper"], rig, "head")
    to_bone(parts["mouth"]["TeethLower"], rig, "jaw")
    to_bone(parts["mouth"]["Tongue"], rig, "jaw")
    parts["rig"] = rig
    parts["props"] = props.build(parts, rig, to_bone)

    if finish == "clay":
        look.clay(parts)
    else:
        look.dress(parts, fur=finish in ("fur", "draft"), draft=draft, strands=strands)
    for lid in parts["lids"]:
        thicken(lid)
    return parts


def digit_axis(bone, what):
    """The axis a finger or thumb bends about at its knuckle (`curl`, toward
    the palm) or swings about across the hand (`spread`, toward the thumb),
    in the world's axes of the rest pose."""
    name, side = bone.split(".")
    h = model.hand(1 if side == "L" else -1)
    base, tip = next((b, t) for n, b, t, *_ in h.digits if n == name)
    along = (Vector(tip) - Vector(base)).normalized()
    out_of_palm = h.basis[2]
    if what == "spread":
        return out_of_palm
    return along.cross(out_of_palm).normalized()


def pose(parts, values):
    """Sets the rig to a pose (see the top of this file); bones not named
    return to rest."""
    rig = parts["rig"]
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    world = {}
    for key, value in values.items():
        bone, _, what = key.partition("@")
        if bone in parts.get("props", {}):
            continue
        if what == "":
            world[bone] = Euler(value, "XYZ").to_matrix() @ world.get(bone, Matrix.Identity(3))
        elif what in ("curl", "spread"):
            world[bone] = world.get(bone, Matrix.Identity(3)) @ Matrix.Rotation(value, 3, digit_axis(bone, what))
        elif what == "twist":
            b = rig.data.bones[bone]
            along = (b.tail_local - b.head_local).normalized()
            world[bone] = world.get(bone, Matrix.Identity(3)) @ Matrix.Rotation(value, 3, along)
    for bone, turn_world in world.items():
        turn = rig.data.bones[bone].matrix_local.to_3x3()
        rig.pose.bones[bone].rotation_quaternion = (turn.inverted() @ turn_world @ turn).to_quaternion()
    for key, value in values.items():
        bone, _, what = key.partition("@")
        if bone == "":
            bone, what = "root", key[1:]
        if bone in parts.get("props", {}):
            continue
        b = rig.data.bones[bone]
        turn = b.matrix_local.to_3x3()
        if what in ("", "curl", "spread", "twist", "mouth"):
            continue
        elif what == "offset":
            rig.pose.bones[bone].location = turn.inverted() @ Vector(value)
        elif what == "scale":
            local = turn.inverted() @ Matrix.Diagonal(Vector(value)) @ turn
            rig.pose.bones[bone].scale = (abs(local[0][0]), abs(local[1][1]), abs(local[2][2]))
        else:
            raise ValueError(f"unknown pose key {key}")
    props.pose(parts.get("props", {}), values)
    # How far open the mouth is: 1 the grin as sculpted, 0 shut in a smile.
    shut = min(1.0, max(0.0, 1.0 - values.get("@mouth", 1.0)))
    for obj in (parts["body"], *parts["mouth"].values()):
        obj.data.shape_keys.key_blocks["closed"].value = shut
    # A lid wide open lies inside the head and is left out of the picture, so
    # none of its fur can show through.
    for lid, bone in zip(parts.get("lids", []), ("lid.L", "lid.R", "lid_low.L", "lid_low.R")):
        lid.hide_render = bone not in world or world[bone].to_quaternion().angle < 1e-4
