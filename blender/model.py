"""Builds Ranko's body in Blender: a signed distance field sculpted from soft
shapes on a skeleton, turned into one closed quad mesh by OpenVDB.

Imported by the other scripts in blender/; not run on its own.

Ranko stands 1.0 tall with his feet on z = 0 and faces -Y, so his left is +X
(Blender's .L). Every shape rides a bone: ellipsoids for belly, chest, head
and muzzle, round cones for limbs, fingers and tail. They are joined with a
smooth minimum, so each joint gets a soft fillet of a chosen width, and the
eye sockets and the mouth are carved out with a smooth maximum, the way a
sculptor would press them in.

The rest pose is an A-pose: arms out and down, fingers spread, tail away from
the legs, so no limb touches the body and the rig can move every one.
`build_body(pose)` also builds the body directly in another pose, which is
how its outline is checked against the references (blender/fit.py) before
there is a rig.
"""

import math
from dataclasses import dataclass

import bmesh
import bpy
import numpy as np
import openvdb as vdb
from mathutils import Euler, Matrix, Vector

# Cell size of the field the mesh is cut from: about 200 cells over his height.
VOXEL = 0.005


@dataclass
class Bone:
    name: str
    parent: str | None
    head: tuple
    tail: tuple


def _mirror(p):
    return (-p[0], p[1], p[2])


def _arm(side, shoulder, out_deg=45.0):
    """Elbow, wrist and knuckles of an arm hanging out at `out_deg` from
    vertical, swung a little forward."""
    out = math.radians(out_deg)
    d = Vector((side * math.sin(out), -0.08, -math.cos(out))).normalized()
    elbow = Vector(shoulder) + d * 0.17
    wrist = elbow + d * 0.15
    knuckles = wrist + d * 0.10
    return tuple(elbow), tuple(wrist), tuple(knuckles)


SHOULDER = (0.205, 0.015, 0.55)
HIP = (0.16, 0.03, 0.21)
ANKLE = (0.175, 0.0, 0.10)
ELBOW_L, WRIST_L, KNUCKLES_L = _arm(1, SHOULDER)
ELBOW_R, WRIST_R, KNUCKLES_R = _arm(-1, _mirror(SHOULDER))

# The tail leaves the lower back on his right and curls out and up.
TAIL = [(-0.12, 0.18, 0.20), (-0.23, 0.28, 0.15), (-0.34, 0.31, 0.18), (-0.42, 0.28, 0.27), (-0.44, 0.22, 0.38)]
TAIL_RADII = [0.055, 0.056, 0.062, 0.068, 0.064]

BONES = [
    Bone("root", None, (0, 0, 0), (0, 0, 0.12)),
    Bone("hips", "root", (0, 0.02, 0.20), (0, 0.02, 0.44)),
    Bone("chest", "hips", (0, 0.02, 0.44), (0, 0.0, 0.64)),
    Bone("head", "chest", (0, 0.0, 0.62), (0, 0.0, 1.06)),
    Bone("jaw", "head", (0, 0.02, 0.74), (0, -0.20, 0.66)),
    Bone("upper_arm.L", "chest", SHOULDER, ELBOW_L),
    Bone("forearm.L", "upper_arm.L", ELBOW_L, WRIST_L),
    Bone("hand.L", "forearm.L", WRIST_L, KNUCKLES_L),
    Bone("upper_arm.R", "chest", _mirror(SHOULDER), ELBOW_R),
    Bone("forearm.R", "upper_arm.R", ELBOW_R, WRIST_R),
    Bone("hand.R", "forearm.R", WRIST_R, KNUCKLES_R),
    Bone("thigh.L", "hips", HIP, ANKLE),
    Bone("foot.L", "thigh.L", ANKLE, (0.18, -0.18, 0.05)),
    Bone("thigh.R", "hips", _mirror(HIP), _mirror(ANKLE)),
    Bone("foot.R", "thigh.R", _mirror(ANKLE), (-0.18, -0.18, 0.05)),
    *[Bone(f"tail.{i + 1}", "hips" if i == 0 else f"tail.{i}", TAIL[i], TAIL[i + 1]) for i in range(len(TAIL) - 1)],
]

# The muzzle the grin is cut into, and the grin: its upper lip a curve
# rising to the corners, its hollow an ellipsoid that opens downward.
MUZZLE = ((0, -0.075, 0.705), (0.300, 0.200, 0.150))
UPPER_LIP_Z, UPPER_LIP_CURVE = 0.730, 0.95


def mouth_hollow(open_):
    return (0, -0.262, 0.714 - 0.030 * open_), (0.228, 0.13, 0.012 + 0.065 * open_)


EYE_RADIUS = 0.072
EYE_X, EYE_Y, EYE_Z = 0.092, -0.222, 0.895


# --- Distance functions, on arrays of points (x, y, z) ---------------------

def length(x, y, z):
    return np.sqrt(x * x + y * y + z * z)


def ellipsoid(p, center, radii, basis=None):
    """Approximate distance to an ellipsoid; `basis` turns it (columns are its axes)."""
    x, y, z = (p[i] - center[i] for i in range(3))
    if basis is not None:
        x, y, z = (x * basis[j][0] + y * basis[j][1] + z * basis[j][2] for j in range(3))
    rx, ry, rz = radii
    k0 = length(x / rx, y / ry, z / rz)
    k1 = length(x / (rx * rx), y / (ry * ry), z / (rz * rz))
    return k0 * (k0 - 1) / np.maximum(k1, 1e-6)


def sphere(p, center, radius):
    return length(*(p[i] - center[i] for i in range(3))) - radius


def round_cone(p, a, b, ra, rb):
    """Distance to a cone with round ends: radius `ra` at `a`, `rb` at `b`."""
    ba = [b[i] - a[i] for i in range(3)]
    pa = [p[i] - a[i] for i in range(3)]
    l2 = sum(c * c for c in ba)
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    y = pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]
    z = y - l2
    w = [pa[i] * l2 - ba[i] * y for i in range(3)]
    x2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2]
    y2 = y * y * l2
    z2 = z * z * l2
    k = math.copysign(1, rr) * rr * rr * x2
    near_b = np.sign(z) * a2 * z2 > k
    near_a = np.sign(y) * a2 * y2 < k
    side = (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra
    return np.where(near_b, np.sqrt(x2 + z2) * il2 - rb, np.where(near_a, np.sqrt(x2 + y2) * il2 - ra, side))


def smin(a, b, k):
    """Union with a fillet `k` wide."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smax(a, b, k):
    """Intersection with a fillet `k` wide; smax(d, -cut, k) carves `cut`."""
    return -smin(-a, -b, k)


# --- Ranko ------------------------------------------------------------------

def _hand(p, side, wrist, knuckles):
    """Palm, three fingers and a thumb. The palm faces forward (-Y), the
    fingers fan in the arm's swing plane, thumb on the outside: a hand in the
    anatomical position."""
    wrist, knuckles = Vector(wrist), Vector(knuckles)
    axis = (knuckles - wrist).normalized()
    outward = axis.cross(Vector((0, 1, 0))).normalized() * side
    normal = axis.cross(outward)
    palm = wrist + axis * 0.055
    d = ellipsoid(p, palm, (0.076, 0.070, 0.042), (axis, outward, normal))
    for spread, size, radius in ((26, 0.070, 0.031), (3, 0.080, 0.032), (-20, 0.066, 0.030)):
        s, c = math.sin(math.radians(spread)), math.cos(math.radians(spread))
        base = palm + axis * 0.045 + outward * 0.054 * s / math.sin(math.radians(26))
        tip = base + (axis * c + outward * s) * size
        d = smin(d, round_cone(p, base, tip, radius + 0.002, radius), 0.016)
    thumb = (axis * 0.30 + outward * 0.80 - normal * 0.45).normalized()
    base = palm + outward * 0.052 - axis * 0.012
    return smin(d, round_cone(p, base, base + thumb * 0.058, 0.035, 0.031), 0.018)


def _foot(p, side):
    x = side * 0.18
    d = ellipsoid(p, (x, -0.04, 0.078), (0.126, 0.160, 0.086))
    for dx in (-0.062, 0.0, 0.062):
        d = smin(d, sphere(p, (x + dx, -0.165, 0.056), 0.050), 0.022)
    # Flat soles to stand on.
    return smax(d, -p[2], 0.012)


def _mouth(p, open_=1.0):
    """The hollow of the grin: wide, its upper lip curving up at the corners,
    its lower lip a deep curve; `open_` 0 shuts it to a thin line."""
    x, y, z = p
    center, radii = mouth_hollow(open_)
    upper_lip = z - (UPPER_LIP_Z + UPPER_LIP_CURVE * x * x)
    return np.maximum(ellipsoid(p, center, radii), upper_lip)


def field(at, mouth_open=1.0):
    """Ranko's signed distance: `at(bone)` gives the sample points in that
    bone's rest frame, so the same shapes build any pose."""
    hips, chest, head = at("hips"), at("chest"), at("head")

    # A pear of a body, widest low down, flowing into broad shoulders.
    d = ellipsoid(hips, (0, 0.025, 0.33), (0.31, 0.27, 0.28))
    d = smin(d, ellipsoid(hips, (0, 0.04, 0.19), (0.27, 0.22, 0.13)), 0.08)
    d = smin(d, ellipsoid(chest, (0, 0.025, 0.50), (0.220, 0.21, 0.15)), 0.12)

    # The head: a dome, and a wide muzzle in front for the grin.
    h = ellipsoid(head, (0, -0.015, 0.830), (0.275, 0.240, 0.240))
    h = smin(h, ellipsoid(head, *MUZZLE), 0.05)
    d = smin(d, h, 0.03)

    for side, s in (("L", 1), ("R", -1)):
        shoulder = SHOULDER if s > 0 else _mirror(SHOULDER)
        elbow, wrist, knuckles = (ELBOW_L, WRIST_L, KNUCKLES_L) if s > 0 else (ELBOW_R, WRIST_R, KNUCKLES_R)
        arm = round_cone(at(f"upper_arm.{side}"), shoulder, elbow, 0.085, 0.078)
        arm = smin(arm, round_cone(at(f"forearm.{side}"), elbow, wrist, 0.076, 0.066), 0.03)
        arm = smin(arm, _hand(at(f"hand.{side}"), s, wrist, knuckles), 0.03)
        d = smin(d, arm, 0.05)

        hip, ankle = (HIP, ANKLE) if s > 0 else (_mirror(HIP), _mirror(ANKLE))
        leg = round_cone(at(f"thigh.{side}"), hip, ankle, 0.10, 0.095)
        leg = smin(leg, _foot(at(f"foot.{side}"), s), 0.04)
        d = smin(d, leg, 0.05)

    tail = None
    for i in range(len(TAIL) - 1):
        seg = round_cone(at(f"tail.{i + 1}"), TAIL[i], TAIL[i + 1], TAIL_RADII[i], TAIL_RADII[i + 1])
        tail = seg if tail is None else smin(tail, seg, 0.02)
    d = smin(d, tail, 0.04)

    # Sockets for the eyes, a little larger than the eyeballs.
    for s in (1, -1):
        d = smax(d, -sphere(head, (s * EYE_X, EYE_Y, EYE_Z), EYE_RADIUS + 0.005), 0.015)
    return smax(d, -_mouth(head, mouth_open), 0.012)


def pose_matrices(pose):
    """World matrices that carry rest-pose points into `pose`: {bone: (x, y, z)
    rotation in radians about the bone's head, in world axes}."""
    mats = {}
    for b in BONES:
        parent = mats[b.parent] if b.parent else Matrix.Identity(4)
        rot = Euler(pose.get(b.name, (0, 0, 0)), "XYZ").to_matrix().to_4x4()
        head = Vector(b.head)
        mats[b.name] = parent @ Matrix.Translation(head) @ rot @ Matrix.Translation(-head)
    return mats


def sample(pose, lo, hi, step, **params):
    """The field on a grid from `lo` to `hi`, and the grid's shape."""
    axes = [np.arange(lo[i], hi[i] + step, step, dtype=np.float32) for i in range(3)]
    grid = np.meshgrid(*axes, indexing="ij")
    inverse = {name: m.inverted() for name, m in pose_matrices(pose).items()}

    # Not cached: a frame per bone at this size would take gigabytes.
    def at(bone):
        m = inverse[bone]
        if m == Matrix.Identity(4):
            return grid
        m = np.array(m, dtype=np.float32)
        return tuple(m[i, 0] * grid[0] + m[i, 1] * grid[1] + m[i, 2] * grid[2] + m[i, 3] for i in range(3))

    return field(at, **params).astype(np.float32)


def _bounds(pose, **params):
    """The box the surface lies in, from a coarse pass over a generous one."""
    lo, hi, step = (-1.2, -1.0, -0.1), (1.2, 1.0, 1.5), 0.02
    d = sample(pose, lo, hi, step, **params)
    inside = np.argwhere(d < step)
    first, last = inside.min(0), inside.max(0)
    margin = 2 * step
    return (tuple(lo[i] + first[i] * step - margin for i in range(3)),
            tuple(lo[i] + last[i] * step + margin for i in range(3)))


def build_body(pose=None, **params):
    """Ranko's body as one closed, smooth mesh object named Body."""
    pose = pose or {}
    lo, hi = _bounds(pose, **params)
    d = sample(pose, lo, hi, VOXEL, **params)

    grid = vdb.FloatGrid(VOXEL * 3)
    grid.copyFromArray(d)
    grid.transform = vdb.createLinearTransform(voxelSize=VOXEL)
    points, quads = grid.convertToQuads(0.0)
    points = points + np.array(lo, dtype=np.float32)

    me = bpy.data.meshes.new("Body")
    me.from_pydata(points.tolist(), [], quads.tolist())
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # Evens out the stair-steps the cells leave on gentle slopes.
    for _ in range(2):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True

    body = bpy.data.objects.new("Body", me)
    bpy.context.scene.collection.objects.link(body)
    return body


def build_eyes(pose=None):
    """Two big white eyeballs set into the sockets, as their own objects."""
    m = pose_matrices(pose or {})["head"]
    eyes = []
    for side, name in ((1, "EyeL"), (-1, "EyeR")):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=EYE_RADIUS)
        eye = bpy.context.active_object
        eye.name = name
        bpy.ops.object.shade_smooth()
        eye.matrix_world = m @ Matrix.Translation(Vector((side * EYE_X, EYE_Y, EYE_Z)))
        eyes.append(eye)
    return eyes


def muzzle_front(x, z):
    """How far forward (-Y) the muzzle's skin is at (x, z)."""
    (cx, cy, cz), (rx, ry, rz) = MUZZLE
    inside = max(0.0, 1 - ((x - cx) / rx) ** 2 - ((z - cz) / rz) ** 2)
    return cy - ry * math.sqrt(inside)


def _tooth(name, location, half, point, turn):
    """A tooth: a rounded nub, drawn to a blunt point at one end (`point` +1
    down, -1 up), turned to follow the curve of the mouth."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=1)
    tooth = bpy.context.active_object
    tooth.name = name
    for v in tooth.data.vertices:
        tip = max(0.0, -v.co.z * point)
        v.co.x *= 1 - 0.22 * tip
        v.co.y *= 1 - 0.12 * tip
    tooth.scale = half
    tooth.rotation_euler = (0, 0, turn)
    tooth.location = location
    return tooth


def _joined(name, objects):
    """One mesh object from several, their transforms applied."""
    bm = bmesh.new()
    for obj in objects:
        me = obj.data.copy()
        # matrix_basis, not matrix_world: that one waits for a depsgraph update.
        me.transform(obj.matrix_basis)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        mesh = obj.data
        bpy.data.objects.remove(obj)
        bpy.data.meshes.remove(mesh)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_mouth(pose=None, open_=1.0):
    """Upper teeth hanging from the upper lip, lower teeth standing on the
    lower one, and a tongue on the floor of the hollow."""
    m = pose_matrices(pose or {})["head"]
    upper = []
    for i, x in enumerate(np.linspace(-0.160, 0.160, 8)):
        z = UPPER_LIP_Z + UPPER_LIP_CURVE * x * x - 0.016
        y = muzzle_front(x, z + 0.012) + 0.028
        upper.append(_tooth(f"Upper{i}", (x, y, z), (0.0195, 0.012, 0.020), 1, -2.0 * x))
    (cx, cy, cz), (rx, ry, rz) = mouth_hollow(open_)
    lower = []
    for i, x in enumerate(np.linspace(-0.136, 0.136, 7)):
        z = cz - rz * math.sqrt(max(0.0, 1 - (x / rx) ** 2)) + 0.016
        y = muzzle_front(x, z - 0.01) + 0.030
        lower.append(_tooth(f"Lower{i}", (x, y, z), (0.0195, 0.012, 0.018), -1, -2.0 * x))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    tongue = bpy.context.active_object
    tongue.scale = (0.120, 0.070, 0.028)
    tongue.location = (0, cy + 0.095, cz - rz + 0.012)
    parts = {"TeethUpper": _joined("TeethUpper", upper), "TeethLower": _joined("TeethLower", lower),
             "Tongue": _joined("Tongue", [tongue])}
    for obj in parts.values():
        obj.matrix_world = m
    return parts


def face_regions(body, open_=1.0):
    """Per vertex of the rest-pose body: how deep in the mouth it is (0 on the
    skin, 1 inside) and how much fur grows there (none in the mouth or under
    the eyes, thinning toward the lips)."""
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    p = tuple(co.reshape(-1, 3).T)
    mouth = _mouth(p, open_)
    inside = np.clip(1 - mouth / 0.004, 0, 1)
    fur = np.clip((mouth - 0.012) / 0.03, 0, 1)
    for s in (1, -1):
        eye = sphere(p, (s * EYE_X, EYE_Y, EYE_Z), EYE_RADIUS)
        fur = np.minimum(fur, np.clip((eye - 0.003) / 0.015, 0, 1))
        # Shorter on the hands, so the fingers keep their shape.
        wrist, knuckles = (WRIST_L, KNUCKLES_L) if s > 0 else (WRIST_R, KNUCKLES_R)
        hand = _hand(p, s, wrist, knuckles)
        fur = np.minimum(fur, 0.45 + 0.55 * np.clip(hand / 0.03, 0, 1))
    return inside, fur


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.armatures):
        for item in list(block):
            block.remove(item)
