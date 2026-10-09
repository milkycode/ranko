"""Builds Ranko's body in Blender: a signed distance field sculpted from soft
shapes on a skeleton, turned into one closed quad mesh by OpenVDB.

Imported by the other scripts in blender/; not run on its own.

Ranko stands about 1.07 tall with his feet on z = 0 and faces -Y, so his
left is +X (Blender's .L). Every shape rides a bone: ellipsoids for belly,
chest, head, cheeks and jowls, round cones for limbs, fingers, brows and
tail. They are joined with a smooth minimum, so each joint gets a soft fillet
of a chosen width, and the eye sockets, the mouth, the seam down the face and
the creases of the smile are carved with a smooth maximum, the way a sculptor
would press them in. The face's details are placed on the skin itself: the
head is sampled first to find where its surface lies.

The rest pose is an A-pose: arms out and down, fingers spread, tail away from
the legs, so no limb touches the body and the rig can move every one.
`build_body(pose)` also builds the body directly in another pose, which is
how its outline is checked against the references (blender/fit.py) before
there is a rig.
"""

import math
from dataclasses import dataclass
from functools import cache

import bmesh
import bpy
import numpy as np
import openvdb as vdb
from mathutils import Euler, Matrix, Vector

# Cell size of the field the mesh is cut from: about 210 cells over his height.
VOXEL = 0.005


@dataclass
class Bone:
    name: str
    parent: str | None
    head: tuple
    tail: tuple


def _mirror(p):
    return (-p[0], p[1], p[2])


# --- Distance functions, on arrays of points (x, y, z) ---------------------

def length(x, y, z):
    return np.sqrt(x * x + y * y + z * z)


def ellipsoid(p, center, radii, basis=None):
    """Approximate distance to an ellipsoid; `basis` turns it (its axes)."""
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


def tube(p, points, radii):
    """Round cones through a chain of points: a brow, a crease, a tail."""
    d = None
    for i in range(len(points) - 1):
        seg = round_cone(p, points[i], points[i + 1], radii[i], radii[i + 1])
        d = seg if d is None else np.minimum(d, seg)
    return d


def smin(a, b, k):
    """Union with a fillet `k` wide."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smax(a, b, k):
    """Intersection with a fillet `k` wide; smax(d, -cut, k) carves `cut`."""
    return -smin(-a, -b, k)


# --- The skeleton -------------------------------------------------------------

def _arm(side, shoulder, out_deg=45.0):
    """Elbow, wrist and knuckles of an arm hanging out at `out_deg` from
    vertical, swung a little forward."""
    out = math.radians(out_deg)
    d = Vector((side * math.sin(out), -0.08, -math.cos(out))).normalized()
    elbow = Vector(shoulder) + d * 0.145
    wrist = elbow + d * 0.125
    knuckles = wrist + d * 0.11
    return tuple(elbow), tuple(wrist), tuple(knuckles)


SHOULDER = (0.250, 0.020, 0.575)
HIP = (0.15, 0.03, 0.22)
ANKLE = (0.172, 0.0, 0.085)
FOOT_X = 0.18
ELBOW_L, WRIST_L, KNUCKLES_L = _arm(1, SHOULDER)
ELBOW_R, WRIST_R, KNUCKLES_R = _arm(-1, _mirror(SHOULDER))

# The tail leaves the lower back on his right and curls out and up.
TAIL = [(-0.12, 0.18, 0.20), (-0.23, 0.28, 0.15), (-0.34, 0.31, 0.18), (-0.42, 0.28, 0.27), (-0.44, 0.22, 0.38)]
TAIL_RADII = [0.055, 0.056, 0.062, 0.068, 0.064]


@dataclass
class Hand:
    """Where a hand's parts lie in the rest pose. The palm faces forward (-Y)
    and the digits fan in the arm's swing plane, thumb on the outside: a hand
    in the anatomical position."""
    palm: Vector
    basis: tuple  # along the hand, toward the thumb, out of the palm
    digits: list  # (name, base, tip, base radius, tip radius)


@cache
def hand(side):
    wrist, knuckles = (WRIST_L, KNUCKLES_L) if side > 0 else (WRIST_R, KNUCKLES_R)
    wrist, knuckles = Vector(wrist), Vector(knuckles)
    axis = (knuckles - wrist).normalized()
    outward = axis.cross(Vector((0, 1, 0))).normalized() * side
    normal = axis.cross(outward)
    palm = wrist + axis * 0.055
    digits = []
    # Three fat fingers, the outer one shortest, with room between them.
    for name, across, spread, size, radius in (("index", 0.056, 14, 0.096, 0.026),
                                               ("middle", 0.0, 0, 0.106, 0.027),
                                               ("ring", -0.056, -18, 0.086, 0.025)):
        s, c = math.sin(math.radians(spread)), math.cos(math.radians(spread))
        base = palm + axis * 0.040 + outward * across
        tip = base + (axis * c + outward * s) * size
        digits.append((name, base, tip, radius, radius + 0.002))
    # The thumb leaves low on the palm's outer edge and leans in front of it.
    thumb = (axis * 0.45 + outward * 0.85 - normal * 0.25).normalized()
    base = palm + outward * 0.052 - axis * 0.020
    digits.append(("thumb", base, base + thumb * 0.070, 0.031, 0.029))
    return Hand(palm, (axis, outward, normal), digits)


def _bones():
    bones = [
        Bone("root", None, (0, 0, 0), (0, 0, 0.12)),
        Bone("hips", "root", (0, 0.02, 0.20), (0, 0.02, 0.44)),
        Bone("chest", "hips", (0, 0.02, 0.44), (0, 0.0, 0.64)),
        Bone("head", "chest", (0, 0.0, 0.62), (0, 0.0, 1.06)),
        Bone("jaw", "head", (0, 0.02, 0.74), (0, -0.20, 0.66)),
    ]
    for side, s in (("L", 1), ("R", -1)):
        shoulder = SHOULDER if s > 0 else _mirror(SHOULDER)
        elbow, wrist, knuckles = (ELBOW_L, WRIST_L, KNUCKLES_L) if s > 0 else (ELBOW_R, WRIST_R, KNUCKLES_R)
        bones += [
            Bone(f"upper_arm.{side}", "chest", shoulder, elbow),
            Bone(f"forearm.{side}", f"upper_arm.{side}", elbow, wrist),
            Bone(f"hand.{side}", f"forearm.{side}", wrist, knuckles),
        ]
        for name, base, tip, _, _ in hand(s).digits:
            bones.append(Bone(f"{name}.{side}", f"hand.{side}", tuple(base), tuple(tip)))
        ankle = ANKLE if s > 0 else _mirror(ANKLE)
        bones += [
            Bone(f"thigh.{side}", "hips", HIP if s > 0 else _mirror(HIP), ankle),
            Bone(f"foot.{side}", f"thigh.{side}", ankle, (s * FOOT_X, -0.18, 0.05)),
        ]
    for i in range(len(TAIL) - 1):
        bones.append(Bone(f"tail.{i + 1}", "hips" if i == 0 else f"tail.{i}", TAIL[i], TAIL[i + 1]))
    return bones


BONES = _bones()


# --- The head and face --------------------------------------------------------

# Measured off previews/n5ocru92jcaa3qe.jpeg: the eyes high on the ball of
# the head, the grin right under them, a big round chin under that.
EYE_RADIUS = 0.079
EYE_X, EYE_Z = 0.096, 0.918
MOUTH_HALF_WIDTH = 0.204
UPPER_LIP_Z, UPPER_LIP_CURVE = 0.808, 0.30


def _head_shape(p):
    """The head before any carving: a big ball, a little wider low down where
    the jowls are, cheeks puffed up beside the mouth, a pad over the upper
    lip and a roll of chin under it."""
    h = ellipsoid(p, (0, -0.005, 0.822), (0.300, 0.255, 0.252))
    h = smin(h, ellipsoid(p, (0, -0.040, 0.722), (0.280, 0.222, 0.145)), 0.10)
    for s in (1, -1):
        h = smin(h, ellipsoid(p, (s * 0.140, -0.192, 0.800), (0.092, 0.070, 0.072)), 0.05)
    h = smin(h, ellipsoid(p, (0, -0.212, 0.845), (0.120, 0.052, 0.042)), 0.04)
    return smin(h, ellipsoid(p, (0, -0.185, 0.680), (0.205, 0.095, 0.075)), 0.06)


@cache
def front(x, z):
    """How far forward (-Y) the uncarved head's skin is at (x, z)."""
    ys = np.linspace(-0.45, 0.1, 1101, dtype=np.float32)
    d = _head_shape((np.full_like(ys, x), ys, np.full_like(ys, z)))
    return float(ys[np.argmax(d < 0)])


@cache
def eye_center(side):
    """Set into the head so a little over a third of the ball stands out."""
    x = side * EYE_X
    return (x, front(x, EYE_Z) + 0.020, EYE_Z)


def _on_skin(x, z, depth=0.0):
    return (x, front(x, z) + depth, z)


@cache
def face_features():
    """Brows, lower lids and the seam, as tubes laid on the skin:
    (name, points, radii, fillet, carve?)."""
    features = []
    for s in (1, -1):
        ex, ey, ez = eye_center(s)
        # A brow arches over each eye, highest at its inner end; its lower edge
        # falls over the top of the eyeball and is the upper lid.
        brow, radii = [], []
        for i in range(9):
            u = i / 8
            angle = math.radians(26 + 86 * u)
            r = EYE_RADIUS + 0.014
            x = ex + s * r * math.cos(angle)
            z = ez + r * math.sin(angle) * 0.80 + 0.012 + 0.016 * u * u
            brow.append(_on_skin(x, z, -0.006))
            radii.append(0.020 + 0.022 * math.sin(math.pi * min(1.0, u * 1.15)))
        features.append(("brow", brow, radii, 0.025, False))
        # A thin rim of lid all round the eye, a little fuller underneath.
        lid = []
        for i in range(17):
            angle = math.radians(i / 16 * 360)
            r = EYE_RADIUS + 0.004
            lid.append(_on_skin(ex + s * r * math.cos(angle), ez + r * math.sin(angle), 0.008))
        features.append(("lid", lid, [0.008 + 0.004 * max(0.0, -math.sin(math.radians(i / 16 * 360)))
                                      for i in range(17)], 0.010, False))
    # The fur parts down the middle of the face, brow to lip.
    seam = [_on_skin(0, z, -0.004) for z in (0.93, 0.90, 0.87, 0.835)]
    features.append(("seam", seam, [0.002, 0.006, 0.007, 0.004], 0.008, True))
    return features


MOUTH_DEPTH = 0.104  # at the middle, wide open


def upper_lip(x):
    return UPPER_LIP_Z + UPPER_LIP_CURVE * x * x


def lower_lip(x, open_=1.0):
    """The lower lip's edge: a deep round curve that meets the upper lip at
    the corners, so the grin is a half moon; `open_` 0 shuts it to a line."""
    w = MOUTH_HALF_WIDTH
    middle = UPPER_LIP_Z - MOUTH_DEPTH * open_ - 0.004
    return middle + (upper_lip(w) - middle) * abs(x / w) ** 2.3


def mouth_hollow(open_=1.0):
    """The cavity behind the lips: an ellipsoid reaching back into the head."""
    return (0, front(0, 0.76) + 0.09, UPPER_LIP_Z - 0.5 * MOUTH_DEPTH * open_), (MOUTH_HALF_WIDTH + 0.01, 0.13, 0.15)


def _mouth(p, open_=1.0):
    """The hollow of the grin: between the two lips, as deep as the cavity."""
    x, y, z = p
    center, radii = mouth_hollow(open_)
    between = np.maximum(z - upper_lip(x), lower_lip(x, open_) - z)
    return np.maximum(ellipsoid(p, center, radii), between)


def _head(p, mouth_open):
    h = _head_shape(p)
    for name, points, radii, fillet, carve in face_features():
        if not carve:
            h = smin(h, tube(p, points, radii), fillet)
    for s in (1, -1):
        h = smax(h, -sphere(p, eye_center(s), EYE_RADIUS + 0.003), 0.008)
    for name, points, radii, fillet, carve in face_features():
        if carve:
            h = smax(h, -tube(p, points, radii), fillet)
    return smax(h, -_mouth(p, mouth_open), 0.010)


# --- Hands and feet -------------------------------------------------------------

def _hand(p_hand, digit_points, side):
    """Palm and digits: `digit_points(name)` gives the points in that digit's frame."""
    h = hand(side)
    d = ellipsoid(p_hand, h.palm, (0.068, 0.074, 0.038), h.basis)
    for name, base, tip, rb, rt in h.digits:
        d = smin(d, round_cone(digit_points(name), base, tip, rb, rt), 0.007)
    return d


def _foot(p, side):
    """A big oval paw, three toes at the front parted by grooves, a flat sole."""
    x = side * FOOT_X
    d = ellipsoid(p, (x, -0.045, 0.070), (0.128, 0.165, 0.074))
    for dx, half in ((-0.070, (0.044, 0.058, 0.050)), (0.0, (0.047, 0.062, 0.053)), (0.070, (0.044, 0.058, 0.050))):
        d = smin(d, ellipsoid(p, (x + dx, -0.172, 0.060), half), 0.008)
    for dx in (-0.035, 0.035):
        d = smax(d, -round_cone(p, (x + dx, -0.250, 0.055), (x + dx, -0.100, 0.135), 0.016, 0.008), 0.010)
    return smax(d, -p[2], 0.012)


# --- Ranko ------------------------------------------------------------------

def field(at, mouth_open=1.0):
    """Ranko's signed distance: `at(bone)` gives the sample points in that
    bone's rest frame, so the same shapes build any pose."""
    hips, chest = at("hips"), at("chest")

    # A pear of a body, widest low down, under a narrower chest, its round
    # bottom held up off the ground by two short legs.
    d = ellipsoid(hips, (0, 0.030, 0.37), (0.268, 0.255, 0.245))
    d = smin(d, ellipsoid(hips, (0, 0.04, 0.262), (0.205, 0.18, 0.095)), 0.08)
    d = smin(d, ellipsoid(chest, (0, 0.025, 0.50), (0.220, 0.21, 0.15)), 0.12)
    d = smin(d, _head(at("head"), mouth_open), 0.03)

    for side, s in (("L", 1), ("R", -1)):
        shoulder = SHOULDER if s > 0 else _mirror(SHOULDER)
        elbow, wrist = (ELBOW_L, WRIST_L) if s > 0 else (ELBOW_R, WRIST_R)
        arm = round_cone(at(f"upper_arm.{side}"), shoulder, elbow, 0.085, 0.078)
        arm = smin(arm, round_cone(at(f"forearm.{side}"), elbow, wrist, 0.076, 0.064), 0.03)
        arm = smin(arm, _hand(at(f"hand.{side}"), lambda name: at(f"{name}.{side}"), s), 0.03)
        d = smin(d, arm, 0.05)

        hip, ankle = (HIP, ANKLE) if s > 0 else (_mirror(HIP), _mirror(ANKLE))
        leg = round_cone(at(f"thigh.{side}"), hip, ankle, 0.088, 0.082)
        leg = smin(leg, _foot(at(f"foot.{side}"), s), 0.04)
        d = smin(d, leg, 0.05)

    tail = None
    for i in range(len(TAIL) - 1):
        seg = round_cone(at(f"tail.{i + 1}"), TAIL[i], TAIL[i + 1], TAIL_RADII[i], TAIL_RADII[i + 1])
        tail = seg if tail is None else smin(tail, seg, 0.02)
    return smin(d, tail, 0.04)


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
    """The field on a grid from `lo` to `hi`."""
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


# Where the eyes look when nothing else is asked: at someone in front of him.
GAZE_TARGET = Vector((0, -3.0, 1.0))
GAZE_OUT = 0.0


def gaze(side, target=GAZE_TARGET, out=GAZE_OUT):
    """The turn that points an eyeball's iris (its -Y) at `target`."""
    direction = (Vector(target) - Vector(eye_center(side))).normalized() + Vector((side * out, 0, 0))
    return Vector((0, -1, 0)).rotation_difference(direction.normalized())


def build_eyes(pose=None):
    """Two big white eyeballs in the sockets, slightly taller than wide, as
    their own objects, turned to look ahead."""
    m = pose_matrices(pose or {})["head"]
    eyes = []
    for side, name in ((1, "EyeL"), (-1, "EyeR")):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=EYE_RADIUS)
        eye = bpy.context.active_object
        eye.name = name
        bpy.ops.object.shade_smooth()
        for v in eye.data.vertices:
            v.co.z *= 1.05
        eye.matrix_world = m @ Matrix.Translation(Vector(eye_center(side))) @ gaze(side).to_matrix().to_4x4()
        eyes.append(eye)
    return eyes


def _tooth(name, location, half, point, turn, taper=0.20):
    """A tooth: a rounded block, a little narrower at its biting end (`point`
    +1 down, -1 up), turned to follow the curve of the mouth."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=1)
    tooth = bpy.context.active_object
    tooth.name = name
    for v in tooth.data.vertices:
        # Squared off toward a rounded block, then narrowed toward the tip.
        c = v.co
        c /= (abs(c.x) ** 4 + abs(c.y) ** 4 + abs(c.z) ** 4) ** 0.25 or 1
        tip = max(0.0, -c.z * point)
        c.x *= 1 - taper * tip * tip
        c.y *= 1 - 0.10 * tip
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
    """Small round upper teeth hanging from the upper lip, bigger lower teeth
    standing on the lower one, and a tongue on the floor of the hollow."""
    m = pose_matrices(pose or {})["head"]
    upper = []
    for i, x in enumerate(np.linspace(-0.146, 0.146, 7)):
        lip = upper_lip(x)
        upper.append(_tooth(f"Upper{i}", (x, front(x, lip) + 0.030, lip - 0.007), (0.0145, 0.010, 0.017), 1,
                            -2.4 * x, taper=0.60))
    lower = []
    for i, x in enumerate(np.linspace(-0.100, 0.100, 6)):
        z = lower_lip(x, open_) + 0.009
        lower.append(_tooth(f"Lower{i}", (x, front(x, z) + 0.030, z), (0.0160, 0.011, 0.016), -1, -2.4 * x))
    (cx, cy, cz), _ = mouth_hollow(open_)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    tongue = bpy.context.active_object
    tongue.scale = (0.115, 0.075, 0.032)
    tongue.location = (0, cy + 0.050, lower_lip(0, open_) + 0.030)
    parts = {"TeethUpper": _joined("TeethUpper", upper), "TeethLower": _joined("TeethLower", lower),
             "Tongue": _joined("Tongue", [tongue])}
    for obj in parts.values():
        obj.matrix_world = m
    return parts


def surface_regions(body, open_=1.0):
    """Per vertex of the rest-pose body: how deep in the mouth it is (0 on
    the skin, 1 inside), whether it is sole (bare pad), and how much fur
    grows there: none in the mouth, under the eyes or on the soles; short on
    the lids, the face and the hands."""
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    p = tuple(co.reshape(-1, 3).T)
    x, y, z = p
    mouth = _mouth(p, open_)
    inside = np.clip(1 - mouth / 0.004, 0, 1)
    sole = (z < 0.008).astype(np.float32)
    fur = np.clip((mouth - 0.010) / 0.03, 0, 1)
    fur = np.minimum(fur, 1 - np.clip((0.022 - z) / 0.012, 0, 1))
    # The face: the front of the head, between the brows and the chin.
    face = ellipsoid(p, (0, -0.25, 0.83), (0.26, 0.10, 0.22))
    fur = np.minimum(fur, 0.50 + 0.50 * np.clip(face / 0.05, 0, 1))
    # The brows keep their full fur, so they stand up out of the short fur
    # of the face.
    for name, points, radii, fillet, carve in face_features():
        if name == "brow":
            fur = np.maximum(fur, 1.1 * np.clip(1 - np.maximum(tube(p, points, radii), 0) / 0.012, 0, 1))
    for s in (1, -1):
        eye = sphere(p, eye_center(s), EYE_RADIUS)
        # Short on the lids, none under the eyeball.
        fur = np.minimum(fur, 0.30 + 0.70 * np.clip((eye - 0.002) / 0.04, 0, 1))
        fur = np.where(eye < 0.002, 0, fur)
        h = hand(s)
        palm = ellipsoid(p, h.palm, (0.068, 0.074, 0.038), h.basis)
        for _, base, tip, rb, rt in h.digits:
            palm = np.minimum(palm, round_cone(p, base, tip, rb, rt))
        fur = np.minimum(fur, 0.22 + 0.78 * np.clip(palm / 0.03, 0, 1))
        foot = ellipsoid(p, (s * FOOT_X, -0.06, 0.07), (0.15, 0.20, 0.10))
        fur = np.minimum(fur, 0.55 + 0.45 * np.clip(foot / 0.03, 0, 1))
    return inside, sole, fur


def surface_tone(body, open_=1.0):
    """Per vertex of the rest-pose body, how light its fur is (1 as is): the
    sockets of the eyes up to the brows, the rim of the mouth, the seam and
    the grooves between the toes fall into shade, and the brows catch the
    light, as on a real coat."""
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    p = tuple(co.reshape(-1, 3).T)

    def near(distance, reach):
        return np.clip(1 - np.maximum(distance, 0) / reach, 0, 1)

    tone = 1 - 0.35 * near(_mouth(p, open_) - 0.004, 0.025)
    for s in (1, -1):
        tone *= 1 - 0.45 * near(sphere(p, eye_center(s), EYE_RADIUS) - 0.004, 0.022)
        x = s * FOOT_X
        for dx in (-0.035, 0.035):
            groove = round_cone(p, (x + dx, -0.250, 0.055), (x + dx, -0.100, 0.135), 0.016, 0.008)
            tone *= 1 - 0.35 * near(groove, 0.012)
    for name, points, radii, fillet, carve in face_features():
        d = tube(p, points, radii)
        if name == "brow":
            tone *= 1 + 0.18 * near(d, 0.006)
            tone *= 1 - 0.40 * near(np.abs(d - 0.012), 0.009)
        elif name == "seam":
            tone *= 1 - 0.25 * near(d, 0.012)
    return tone


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.armatures):
        for item in list(block):
            block.remove(item)
