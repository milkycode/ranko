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


# Everything above the legs is designed standing on the ground and then lifted
# by this much, which is what gives Ranko legs to stand on.
LIFT = 0.05

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
    for name, across, spread, size, radius in (("index", 0.066, 18, 0.094, 0.024),
                                               ("middle", 0.0, 0, 0.104, 0.025),
                                               ("ring", -0.066, -22, 0.084, 0.023)):
        s, c = math.sin(math.radians(spread)), math.cos(math.radians(spread))
        base = palm + axis * 0.040 + outward * across
        tip = base + (axis * c + outward * s) * size
        digits.append((name, base, tip, radius, radius + 0.002))
    # The thumb leaves low on the palm's outer edge and leans in front of it.
    thumb = (axis * 0.45 + outward * 0.85 - normal * 0.25).normalized()
    base = palm + outward * 0.058 - axis * 0.024
    digits.append(("thumb", base, base + thumb * 0.068, 0.028, 0.027))
    return Hand(palm, (axis, outward, normal), digits)


def _lifted(p):
    return (p[0], p[1], p[2] + LIFT)


def body_space(p):
    """Points carried from the lifted body down to where it was designed."""
    return (p[0], p[1], p[2] - LIFT)


def _bones():
    bones = [_lift_bone(b) for b in _upper_bones()]
    for side, s in (("L", 1), ("R", -1)):
        ankle = ANKLE if s > 0 else _mirror(ANKLE)
        bones += [
            Bone(f"thigh.{side}", "hips", _lifted(HIP if s > 0 else _mirror(HIP)), ankle),
            Bone(f"foot.{side}", f"thigh.{side}", ankle, (s * FOOT_X, -0.18, 0.03)),
        ]
    return bones


def _lift_bone(b):
    return b if b.name == "root" else Bone(b.name, b.parent, _lifted(b.head), _lifted(b.tail))


def _upper_bones():
    """The bones above the legs, where they were designed."""
    bones = [
        Bone("root", None, (0, 0, 0), (0, 0, 0.12)),
        Bone("hips", "root", (0, 0.02, 0.20), (0, 0.02, 0.44)),
        Bone("chest", "hips", (0, 0.02, 0.44), (0, 0.0, 0.64)),
        Bone("head", "chest", (0, 0.0, 0.62), (0, 0.0, 1.03)),
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
    for i in range(len(TAIL) - 1):
        bones.append(Bone(f"tail.{i + 1}", "hips" if i == 0 else f"tail.{i}", TAIL[i], TAIL[i + 1]))
    return bones


BONES = _bones()


# --- The head and face --------------------------------------------------------

# Measured off previews/n5ocru92jcaa3qe.jpeg: the eyes high on the ball of
# the head, the grin right under them, a big round chin under that.
EYE_RADIUS = 0.077
EYE_X, EYE_Z = 0.094, 0.912
MOUTH_HALF_WIDTH = 0.228
UPPER_LIP_Z, UPPER_LIP_CURVE = 0.800, 0.85


# The head is sculpted at the size of the close-ups it was measured from and
# set on the body a little smaller, shrunk toward where it meets the chest.
HEAD_SCALE = 0.88
HEAD_PIVOT = (0.0, -0.04, 0.60)
HEAD_MATRIX = (Matrix.Translation(HEAD_PIVOT) @ Matrix.Scale(HEAD_SCALE, 4)
               @ Matrix.Translation(-Vector(HEAD_PIVOT)))


def head_space(p):
    """Points carried into the head's own, unscaled frame."""
    return tuple((p[i] - HEAD_PIVOT[i]) / HEAD_SCALE + HEAD_PIVOT[i] for i in range(3))


def _head_shape(p):
    """The head before any carving: a big ball, a little taller than wide,
    widest at the cheeks and drawn in again toward the chin, the muzzle
    rounding forward, cheeks puffed up beside the mouth, a pad over the upper
    lip and a big round chin under it."""
    h = ellipsoid(p, (0, -0.005, 0.834), (0.276, 0.252, 0.264))
    h = smin(h, ellipsoid(p, (0, -0.045, 0.730), (0.248, 0.212, 0.130)), 0.10)
    for s in (1, -1):
        h = smin(h, ellipsoid(p, (s * 0.172, -0.172, 0.822), (0.082, 0.072, 0.066)), 0.05)
    # A muzzle: the lower face rounds forward, nearly as far as the eyes,
    # and carries the mouth.
    h = smin(h, ellipsoid(p, (0, -0.165, 0.770), (0.205, 0.125, 0.115)), 0.08)
    h = smin(h, ellipsoid(p, (0, -0.215, 0.848), (0.118, 0.055, 0.044)), 0.04)
    return smin(h, ellipsoid(p, (0, -0.165, 0.682), (0.212, 0.118, 0.092)), 0.06)


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
    """Brows, lower lids, lips and the seam, as tubes laid on the skin:
    (name, points, radii, fillet, carve?)."""
    features = []
    # Soft lips round the grin: a thin upper one that overhangs it, a fat
    # lower one; both thin out into the corners, where the cheeks take over.
    w = MOUTH_HALF_WIDTH
    xs = [w * (2 * k / 14 - 1) * 0.96 for k in range(15)]
    taper = [math.sqrt(max(0.0, 1 - (x / w) ** 2)) for x in xs]
    features.append(("upper lip", [_on_skin(x, upper_lip(x) + 0.004, 0.006) for x in xs],
                     [0.010 + 0.014 * t for t in taper], 0.014, False))
    features.append(("lower lip", [_on_skin(x, lower_lip(x) - 0.004, 0.004) for x in xs],
                     [0.010 + 0.026 * t for t in taper], 0.018, False))
    for s in (1, -1):
        ex, ey, ez = eye_center(s)
        # A brow arches over each eye, highest at its inner end; its lower edge
        # falls over the top of the eyeball and is the upper lid.
        brow, radii = [], []
        for i in range(9):
            u = i / 8
            angle = math.radians(26 + 92 * u)
            r = EYE_RADIUS + 0.014
            x = ex + s * r * math.cos(angle)
            z = ez + r * math.sin(angle) * 0.80 + 0.012 + 0.030 * u * u
            brow.append(_on_skin(x, z, -0.010))
            radii.append(0.022 + 0.026 * math.sin(math.pi * min(1.0, u * 1.15)))
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
    """The lower lip's edge: half an ellipse under the smiling upper lip, so
    the grin is a broad smile with round, raised ends; `open_` 0 shuts it to
    a line."""
    w = MOUTH_HALF_WIDTH
    middle = UPPER_LIP_Z - MOUTH_DEPTH * open_ - 0.004
    # Past the corners it climbs away steeply, so nothing is cut there.
    if np.isscalar(x):
        return middle + (upper_lip(w) - middle) * (1 - math.sqrt(max(0.0, 1 - (x / w) ** 2))) \
            + 10 * max(0.0, abs(x) - w)
    return middle + (upper_lip(w) - middle) * (1 - np.sqrt(np.clip(1 - (x / w) ** 2, 0, 1))) \
        + 10 * np.maximum(0, np.abs(x) - w)


MOUTH_CAVITY = 0.09  # how deep under the skin the mouth reaches


def _mouth(p, open_=1.0):
    """The hollow of the grin: between the two lips, and as deep under the
    skin of the face as the cavity, so a grin this wide follows the face
    round to its corners."""
    x, y, z = p
    # The lips meet in rounded corners, not points.
    between = smax(z - upper_lip(x), lower_lip(x, open_) - z, 0.022)
    under_skin = np.maximum(-_head_shape(p) - MOUTH_CAVITY, y + 0.02)
    return np.maximum(between, under_skin)


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
    # A wide round edge: the lips roll in over it, as lips do.
    return smax(h, -_mouth(p, mouth_open), 0.024)


# --- Hands and feet -------------------------------------------------------------

def _hand(p_hand, digit_points, side):
    """Palm and digits: `digit_points(name)` gives the points in that digit's frame."""
    h = hand(side)
    d = ellipsoid(p_hand, h.palm, (0.068, 0.074, 0.038), h.basis)
    for name, base, tip, rb, rt in h.digits:
        d = smin(d, round_cone(digit_points(name), base, tip, rb, rt), 0.005)
    return d


def _foot(p, side):
    """A big oval paw, three toes at the front parted by grooves, a flat sole."""
    x = side * FOOT_X
    d = ellipsoid(p, (x, -0.045, 0.046), (0.126, 0.162, 0.050))
    for dx, half in ((-0.070, (0.044, 0.058, 0.038)), (0.0, (0.047, 0.062, 0.040)), (0.070, (0.044, 0.058, 0.038))):
        d = smin(d, ellipsoid(p, (x + dx, -0.172, 0.040), half), 0.008)
    for dx in (-0.035, 0.035):
        d = smax(d, -round_cone(p, (x + dx, -0.250, 0.035), (x + dx, -0.100, 0.095), 0.016, 0.008), 0.010)
    return smax(d, -p[2], 0.006)


# --- Ranko ------------------------------------------------------------------

def field(at, mouth_open=1.0):
    """Ranko's signed distance: `at(bone)` gives the sample points in that
    bone's rest frame, so the same shapes build any pose."""
    hips, chest = body_space(at("hips")), body_space(at("chest"))

    # A belly, widest and fullest low down where it bulges forward, under a
    # narrower chest, held up off the ground by two short legs.
    d = ellipsoid(hips, (0, 0.020, 0.350), (0.312, 0.270, 0.220))
    d = smin(d, ellipsoid(hips, (0, -0.045, 0.318), (0.258, 0.232, 0.172)), 0.06)
    d = smin(d, ellipsoid(hips, (0, 0.040, 0.250), (0.210, 0.180, 0.090)), 0.08)
    d = smin(d, ellipsoid(chest, (0, 0.025, 0.510), (0.225, 0.205, 0.150)), 0.12)
    # A crease under the chin, but the back of the head flows into the back.
    head = body_space(at("head"))
    neck = 0.03 + 0.09 * np.clip((head[1] + 0.02) / 0.20, 0, 1)
    d = smin(d, _head(head_space(head), mouth_open) * HEAD_SCALE, neck)

    for side, s in (("L", 1), ("R", -1)):
        shoulder = SHOULDER if s > 0 else _mirror(SHOULDER)
        elbow, wrist = (ELBOW_L, WRIST_L) if s > 0 else (ELBOW_R, WRIST_R)
        arm = round_cone(body_space(at(f"upper_arm.{side}")), shoulder, elbow, 0.085, 0.078)
        arm = smin(arm, round_cone(body_space(at(f"forearm.{side}")), elbow, wrist, 0.076, 0.064), 0.03)
        arm = smin(arm, _hand(body_space(at(f"hand.{side}")), lambda name: body_space(at(f"{name}.{side}")), s), 0.03)
        d = smin(d, arm, 0.05)

        hip, ankle = (_lifted(HIP), ANKLE) if s > 0 else (_lifted(_mirror(HIP)), _mirror(ANKLE))
        leg = round_cone(at(f"thigh.{side}"), hip, ankle, 0.106, 0.090)
        leg = smin(leg, _foot(at(f"foot.{side}"), s), 0.04)
        # Nothing of the leg below the sole.
        leg = smax(leg, -at(f"foot.{side}")[2], 0.006)
        d = smin(d, leg, 0.05)

    tail = None
    for i, (points, radii) in enumerate(tail_curve()):
        seg = tube(body_space(at(f"tail.{i + 1}")), points, radii)
        tail = seg if tail is None else np.minimum(tail, seg)
    return smin(d, tail, 0.04)


@cache
def tail_curve(steps=6):
    """The tail as a smooth curve through its points, cut into the stretch
    each tail bone carries: [(points, radii)] per bone."""
    pts = [Vector(TAIL[0])] + [Vector(q) for q in TAIL] + [Vector(TAIL[-1])]
    rad = [TAIL_RADII[0]] + list(TAIL_RADII) + [TAIL_RADII[-1]]

    def catmull(a, b, c, d, t):
        return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t ** 3)

    stretches = []
    for i in range(len(TAIL) - 1):
        a, b, c, d = pts[i:i + 4]
        ra, rb, rc, rd = rad[i:i + 4]
        ts = [k / steps for k in range(steps + 1)]
        stretches.append(([tuple(catmull(a, b, c, d, t)) for t in ts], [catmull(ra, rb, rc, rd, t) for t in ts]))
    return stretches


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
        eye.matrix_world = (m @ Matrix.Translation((0, 0, LIFT)) @ HEAD_MATRIX @ Matrix.Translation(Vector(eye_center(side)))
                            @ gaze(side).to_matrix().to_4x4())
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
    """Upper teeth hanging half hidden under the upper lip, smaller and a
    little pointed toward the ends; a close row of broad round lower teeth
    along the lower lip; a big tongue on the floor of the hollow. No two
    teeth quite alike, as in a real mouth."""
    m = pose_matrices(pose or {})["head"]
    rng = np.random.default_rng(11)

    def row(halves, gap):
        """Centres along x for teeth of these half widths, `gap` apart."""
        width = 2 * sum(halves) + gap * (len(halves) - 1)
        x, centres = -width / 2, []
        for half in halves:
            centres.append(x + half)
            x += 2 * half + gap
        return centres

    upper = []
    halves = [0.017, 0.022, 0.024, 0.025, 0.024, 0.022, 0.017]
    for i, (x, half) in enumerate(zip(row(halves, 0.005), halves)):
        lip = upper_lip(x)
        tall = 0.012 + 0.50 * half
        jitter = 1 + rng.uniform(-0.06, 0.06)
        upper.append(_tooth(f"Upper{i}", (x, front(x, lip) + 0.034, lip + 0.002), (half, 0.011, tall * jitter), 1,
                            -2.4 * x + rng.uniform(-0.05, 0.05), taper=0.50 if half < 0.018 else 0.30))
    lower = []
    halves = [0.020, 0.022, 0.022, 0.023, 0.022, 0.022, 0.020]
    for i, (x, half) in enumerate(zip(row(halves, 0.002), halves)):
        z = lower_lip(x, open_) + 0.008
        jitter = 1 + rng.uniform(-0.06, 0.06)
        lower.append(_tooth(f"Lower{i}", (x, front(x, z) + 0.032, z), (half, 0.012, 0.019 * jitter), -1,
                            -2.4 * x + rng.uniform(-0.05, 0.05), taper=0.12))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    tongue = bpy.context.active_object
    tongue.scale = (0.135, 0.085, 0.036)
    z = lower_lip(0, open_) + 0.026
    tongue.location = (0, front(0, z) + 0.100, z)
    parts = {"TeethUpper": _joined("TeethUpper", upper), "TeethLower": _joined("TeethLower", lower),
             "Tongue": _joined("Tongue", [tongue])}
    for obj in parts.values():
        obj.matrix_world = m @ Matrix.Translation((0, 0, LIFT)) @ HEAD_MATRIX
    return parts


def surface_regions(body, open_=1.0):
    """Per vertex of the rest-pose body: how deep in the mouth it is (0 on
    the skin, 1 inside), whether it is bare lip, whether it is sole (bare
    pad), and how much fur
    grows there: none in the mouth, under the eyes or on the soles; short on
    the lids, the face and the hands."""
    co = np.empty(len(body.data.vertices) * 3, dtype=np.float32)
    body.data.vertices.foreach_get("co", co)
    p = tuple(co.reshape(-1, 3).T)
    x, y, z = p
    pb = body_space(p)
    ph = head_space(pb)
    mouth = _mouth(ph, open_) * HEAD_SCALE
    inside = np.clip(1 - mouth / 0.004, 0, 1)
    # The bare lip rolling into the mouth, between the fur and the hollow.
    lip = ((mouth >= 0.002) & (mouth < 0.016)).astype(np.float32)
    sole = (z < 0.003).astype(np.float32)
    fur = np.clip((mouth - 0.012) / 0.02, 0, 1)
    fur = np.minimum(fur, 1 - np.clip((0.010 - z) / 0.006, 0, 1))
    # The face: the front of the head, between the brows and the chin.
    face = ellipsoid(ph, (0, -0.25, 0.83), (0.26, 0.10, 0.22))
    fur = np.minimum(fur, 0.45 + 0.55 * np.clip(face / 0.05, 0, 1))
    # The brows keep their full fur, so they stand up out of the short fur
    # of the face.
    for name, points, radii, fillet, carve in face_features():
        if name == "brow":
            fur = np.maximum(fur, 1.1 * np.clip(1 - np.maximum(tube(ph, points, radii), 0) / 0.012, 0, 1))
    for s in (1, -1):
        eye = sphere(ph, eye_center(s), EYE_RADIUS) * HEAD_SCALE
        # Short on the lids, none under the eyeball.
        fur = np.minimum(fur, 0.30 + 0.70 * np.clip((eye - 0.002) / 0.04, 0, 1))
        fur = np.where(eye < 0.002, 0, fur)
        h = hand(s)
        palm = ellipsoid(pb, h.palm, (0.068, 0.074, 0.038), h.basis)
        for _, base, tip, rb, rt in h.digits:
            palm = np.minimum(palm, round_cone(pb, base, tip, rb, rt))
        fur = np.minimum(fur, 0.15 + 0.85 * np.clip(palm / 0.03, 0, 1))
        foot = ellipsoid(p, (s * FOOT_X, -0.06, 0.07), (0.15, 0.20, 0.10))
        fur = np.minimum(fur, 0.55 + 0.45 * np.clip(foot / 0.03, 0, 1))
    return inside, lip, sole, fur


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

    ph = head_space(body_space(p))
    tone = 1 - 0.25 * near(_mouth(ph, open_) - 0.016, 0.02)
    for s in (1, -1):
        tone *= 1 - 0.45 * near(sphere(ph, eye_center(s), EYE_RADIUS) - 0.004, 0.022)
        x = s * FOOT_X
        for dx in (-0.035, 0.035):
            groove = round_cone(p, (x + dx, -0.250, 0.035), (x + dx, -0.100, 0.095), 0.016, 0.008)
            tone *= 1 - 0.35 * near(groove, 0.012)
    for name, points, radii, fillet, carve in face_features():
        d = tube(ph, points, radii)
        if name == "brow":
            # Lit along the ridge, shaded only on its underside, toward the eye.
            side = 1 if points[0][0] > 0 else -1
            under = sphere(ph, eye_center(side), EYE_RADIUS) < d + 0.006
            tone *= 1 + 0.18 * near(d, 0.006)
            tone *= 1 - 0.50 * near(np.abs(d - 0.010), 0.010) * under
        elif name == "seam":
            tone *= 1 - 0.25 * near(d, 0.012)
    return tone


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.armatures):
        for item in list(block):
            block.remove(item)
