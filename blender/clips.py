"""Ranko's clips: what pose each frame of each clip puts him in.

Each motion is a function of how far through its clip a frame is (t in
[0, 1)) and returns a pose for blender/rig.py: turns per bone, in degrees
here and radians there, about the bone's head, in the world's axes of the
rest pose.
"""

import math
from dataclasses import dataclass

from mathutils import Euler, Matrix, Vector

import model
import rig

deg = math.radians
FPS = 24


@dataclass
class Clip:
    motion: str
    frames: int
    loop: bool
    # How he is when the clip ends: standing, sitting on the floor, or on his
    # cushion. The mod plays a transition when the next clip's differs.
    posture: str = "stand"
    # For a transition, the postures it goes from and to.
    transition: tuple = None
    # How full of context he is: normal, plump or stuffed.
    size: str = "normal"


CLIPS = {
    "idle": Clip("idle", 48, True),
    "hello": Clip("hello", 56, False),
    "working": Clip("working", 24, True, posture="sit"),
    "happy": Clip("happy", 32, False),
    "oops": Clip("oops", 36, False),
    "sleepy": Clip("sleepy", 64, True, posture="cushion"),
    "sit-down": Clip("sit_down", 16, False, posture="sit", transition=("stand", "sit")),
    "stand-up": Clip("stand_up", 16, False, posture="stand", transition=("sit", "stand")),
    "doze-off": Clip("doze_off", 30, False, posture="cushion", transition=("stand", "cushion")),
    "wake-up": Clip("wake_up", 24, False, posture="stand", transition=("cushion", "stand")),
    "pat": Clip("pat", 28, False),
    "held": Clip("held", 24, True),
    "drop": Clip("drop", 16, False),
    "blush": Clip("blush", 32, False),
    "fidget-wonder": Clip("wonder", 40, False),
    "fidget-psst": Clip("psst", 40, False),
    "fidget-thumbs": Clip("thumbs", 32, False),
    "fidget-look": Clip("look", 36, False),
    # While a tool runs: a variant of working for each kind of tool.
    "working-magnifier": Clip("working_magnifier", 24, True, posture="sit"),
    "working-notepad": Clip("working_notepad", 24, True, posture="sit"),
    "working-binoculars": Clip("working_binoculars", 24, True, posture="sit"),
    # While Claude thinks, before it writes or calls a tool.
    "working-thinking": Clip("working_thinking", 48, True, posture="sit"),
    # Rounder as the context fills, and a sigh back to size on compaction.
    "idle-plump": Clip("idle", 48, True, size="plump"),
    "idle-stuffed": Clip("idle", 48, True, size="stuffed"),
    "working-plump": Clip("working", 24, True, posture="sit", size="plump"),
    "working-stuffed": Clip("working", 24, True, posture="sit", size="stuffed"),
    "deflate": Clip("deflate", 32, False),
}
PROPS = ("sweat", "laptop", "cushion", "z1", "z2", "z3", "heart1", "heart2", "heart3",
         "magnifier", "pencil", "notepad", "binoculars")

# How much bigger his belly is, plump and stuffed: wider, deeper, a little taller.
SIZES = {"normal": (1.0, 1.0, 1.0), "plump": (1.10, 1.22, 1.06), "stuffed": (1.20, 1.42, 1.12)}

# Arms hanging loose at his sides: out just enough to clear the belly, the
# elbows a little bent so the forearms follow its curve, palms in.
ARMS_DOWN = {
    "upper_arm.L": (-8, 34, 0), "forearm.L": (-14, 18, 0), "hand.L@twist": 85,
    "upper_arm.R": (-8, -34, 0), "forearm.R": (-14, -18, 0), "hand.R@twist": -85,
}
# His right arm up and out, forearm raised, palm to the front.
WAVE_ARM = {"upper_arm.R": (-5, 65, -12), "forearm.R": (0, 45, 0), "hand.R": (0, 5, 0), "hand.R@twist": 0}
# Sitting on the floor: lowered so his bottom rests on it, legs out in front,
# a little apart, soles to the front.
SIT_DROP = 0.15
SIT = {"thigh.L": (-85, 0, 8), "thigh.R": (-85, 0, -8), "foot.L": (-10, 0, 0), "foot.R": (-10, 0, 0)}
# Both arms up and out in a V, hands open.
CHEER = {"upper_arm.L": (-12, -88, 0), "forearm.L": (0, -12, 0), "hand.L@twist": 0,
         "upper_arm.R": (-12, 88, 0), "forearm.R": (0, 12, 0), "hand.R@twist": 0}


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, x):
    return a + (b - a) * x


class Pose(dict):
    """Turns in degrees per bone, added up as the motion builds them."""

    def turn(self, bone, x=0.0, y=0.0, z=0.0):
        ox, oy, oz = self.get(bone, (0, 0, 0))
        self[bone] = (ox + x, oy + y, oz + z)

    def blend(self, target, amount):
        """Moves the bones `target` names toward its turns by `amount`."""
        for key, value in target.items():
            if isinstance(value, tuple):
                old = self.get(key, (0, 0, 0))
                self[key] = tuple(lerp(o, v, amount) for o, v in zip(old, value))
            else:
                self[key] = lerp(self.get(key, 0), value, amount)

    def lid(self, side, shut, lower=0.0):
        """One eye's lids, from open (0) to shut (1): a wink."""
        self[f"lid.{side}"] = (rig.SHUT["upper"] * shut, 0, 0)
        self[f"lid_low.{side}"] = (rig.SHUT["lower"] * lower, 0, 0)

    def hand_shape(self, side, shape, amount=1.0):
        """A fist, a pointing index finger, or a thumb up, `amount` of the way
        from how the hand is."""
        curls = {"fist": (95, 95, 95, 40), "point": (0, 100, 100, 50), "thumb": (100, 100, 100, -10)}[shape]
        for finger, curl in zip(("index", "middle", "ring", "thumb"), curls):
            key = f"{finger}.{side}@curl"
            self[key] = lerp(self.get(key, 0), curl, amount)
            self[f"{finger}.{side}@spread"] = lerp(self.get(f"{finger}.{side}@spread", 0), 0, amount)

    def lids(self, shut, lower=None):
        """The lids of both eyes, from open (0) to shut (1); the lower lids
        as far as `lower`, or as the upper ones."""
        lower = shut if lower is None else lower
        for side in "LR":
            self[f"lid.{side}"] = (rig.SHUT["upper"] * shut, 0, 0)
            self[f"lid_low.{side}"] = (rig.SHUT["lower"] * lower, 0, 0)

    def relax_hands(self, curl=35, together=10):
        """Fingers drawn together and curled a little, as hands hang at rest."""
        for side in "LR":
            for finger, spread in (("index", -together), ("middle", 0), ("ring", together)):
                self[f"{finger}.{side}@curl"] = curl
                self[f"{finger}.{side}@spread"] = spread
            self[f"thumb.{side}@curl"] = curl * 0.6

    def for_rig(self):
        """The pose in rig.pose's terms: turns in radians, the rest as is."""
        out = {}
        for key, value in self.items():
            if "@" not in key:
                out[key] = tuple(map(deg, value))
            elif key.endswith(("@curl", "@spread", "@twist")):
                out[key] = deg(value)
            else:
                out[key] = value
        return out


def _euler(q):
    return tuple(math.degrees(a) for a in q.to_euler("XYZ"))


def reach(p, side, wrist, pole, amount=1.0):
    """Turns the arm on `side` so its wrist comes to `wrist`, a point in the
    world where he stands now, the elbow bending out toward `pole`; with
    `amount` under 1, only that far from the pose the arm already has. A
    two-bone reach, worked out in the rest pose's frame: the chest is taken
    as unturned, so it suits poses that move him without leaning him much."""
    s = 1 if side == "L" else -1
    mirror = (lambda v: Vector(v)) if s > 0 else (lambda v: Vector((-v[0], v[1], v[2])))
    shoulder = Vector(model._lifted(model.SHOULDER if s > 0 else model._mirror(model.SHOULDER)))
    elbow_rest = Vector(model._lifted(model.ELBOW_L if s > 0 else model.ELBOW_R))
    wrist_rest = Vector(model._lifted(model.WRIST_L if s > 0 else model.WRIST_R))
    upper, fore = (elbow_rest - shoulder).length, (wrist_rest - elbow_rest).length

    target = Vector(wrist) - Vector(p.get("@offset", (0, 0, 0))) - shoulder
    span = min(target.length, upper + fore - 1e-4)
    along = target.normalized()
    bend = mirror(pole)
    bend = (bend - along * bend.dot(along)).normalized()
    cos_a = (upper * upper + span * span - fore * fore) / (2 * upper * span)
    sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
    elbow = along * upper * cos_a + bend * upper * sin_a
    upper_turn = (elbow_rest - shoulder).normalized().rotation_difference(elbow.normalized())
    fore_dir = (along * span - elbow).normalized()
    # The forearm turns on top of the upper arm, in the rest pose's frame.
    fore_turn = (wrist_rest - elbow_rest).normalized().rotation_difference(upper_turn.inverted() @ fore_dir)
    for bone, turn in ((f"upper_arm.{side}", upper_turn), (f"forearm.{side}", fore_turn)):
        old = p.get(bone, (0, 0, 0))
        p[bone] = tuple(lerp(o, n, amount) for o, n in zip(old, _euler(turn)))


def orient_hand(p, side, along, thumb, amount=1.0):
    """Turns the hand on `side` so its fingers point `along` and its thumb
    side faces `thumb`, both in the world, whatever the arm above it does;
    with `amount` under 1, only that far from how it was."""
    h = model.hand(1 if side == "L" else -1)
    axis, outward = h.basis[0], h.basis[1]
    rest = Matrix((axis, outward, axis.cross(outward))).transposed()
    along = Vector(along).normalized()
    thumb = Vector(thumb)
    thumb = (thumb - along * thumb.dot(along)).normalized()
    want = Matrix((along, thumb, along.cross(thumb))).transposed()
    arm = Matrix.Identity(3)
    for bone in (f"upper_arm.{side}", f"forearm.{side}"):
        arm = arm @ Euler(tuple(map(deg, p.get(bone, (0, 0, 0)))), "XYZ").to_matrix()
    turn = _euler((arm.inverted() @ want @ rest.transposed()).to_quaternion())
    old = p.get(f"hand.{side}", (0, 0, 0))
    p[f"hand.{side}"] = tuple(lerp(o, n, amount) for o, n in zip(old, turn))
    p[f"hand.{side}@twist"] = lerp(p.get(f"hand.{side}@twist", 0), 0, amount)


def point_index(p, tip, finger, thumb, pole, amount=1.0):
    """His right index finger pointing along `finger`, its tip at `tip`, the
    thumb side toward `thumb`: the wrist goes where that puts it."""
    finger = Vector(finger).normalized()
    thumb = Vector(thumb)
    thumb = (thumb - finger * thumb.dot(finger)).normalized()
    # The index finger leaves the hand at an angle toward the thumb.
    h = model.hand(-1)
    to_tip = [d for d in h.digits if d[0] == "index"][0][2] - h.palm + h.basis[0] * 0.055
    angle = math.atan2(to_tip.dot(h.basis[1]), to_tip.dot(h.basis[0]))
    along = finger * math.cos(angle) - thumb * math.sin(angle)
    wrist = Vector(tip) - finger * to_tip.length
    reach(p, "R", tuple(wrist), pole=pole, amount=amount)
    orient_hand(p, "R", along=along, thumb=thumb, amount=amount)
    p.hand_shape("R", "point", amount)


def sit(p, drop=SIT_DROP):
    p.blend(SIT, 1.0)
    p["@offset"] = (0, 0, -drop)


# Where the head turns, as designed: the head bone's base.
HEAD_BASE = next(b for b in model._upper_bones() if b.name == "head").head


def look_at_viewer(p, amount=1.0):
    """The camera sits off to his right: the head turns a little toward it and
    the eyes the rest of the way."""
    p.turn("head", z=-6 * amount)
    p.turn("eye.L", z=-14 * amount)
    p.turn("eye.R", z=-14 * amount)


def blink(frame, start):
    """How shut the lids are `frame` frames into a blink starting at `start`."""
    return {0: 0.55, 1: 1.0, 2: 1.0, 3: 0.5}.get(frame - start, 0.0)


def idle(t, frame):
    """Breathes, sways a little, lets the tail swing and blinks once."""
    wave = math.sin(2 * math.pi * t)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    p["hips@scale"] = (1 + 0.010 * wave, 1 + 0.010 * wave, 1 + 0.016 * wave)
    p.turn("root", z=2.5 * math.sin(2 * math.pi * t))
    p.turn("head", x=1.5 * math.sin(2 * math.pi * t + 1.0), y=1.5 * wave)
    p.turn("upper_arm.L", y=2 * wave)
    p.turn("upper_arm.R", y=-2 * wave)
    for i in range(1, 5):
        p.turn(f"tail.{i}", z=7 * math.sin(2 * math.pi * t - 0.7 * i))
    p.lids(blink(frame, 30))
    # A smile, the lips parting a little with each breath.
    p["@mouth"] = 0.10 + 0.06 * (0.5 + 0.5 * wave)
    look_at_viewer(p)
    return p


def hello(t, frame):
    """Raises his right arm and opens his mouth in a big grin, waves two and
    a half times with raised brows, and lowers it again, the grin settling
    back into a smile."""
    up = ease(t / 0.18) if t < 0.18 else (1 - ease((t - 0.84) / 0.16) if t > 0.84 else 1.0)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    # The waving hand opens.
    for finger in ("index", "middle", "ring", "thumb"):
        p.pop(f"{finger}.R@curl", None)
        p.pop(f"{finger}.R@spread", None)
    p.blend(WAVE_ARM, up)
    waving = min(1.0, max(0.0, (t - 0.18) / 0.66))
    swing = math.sin(2 * math.pi * 2.5 * waving) * up
    p.turn("forearm.R", y=22 * swing)
    p.turn("hand.R", y=12 * swing)
    # A little bounce as the arm goes up, a tilt of the head, the grin.
    p["@offset"] = (0, 0, 0.025 * math.sin(math.pi * min(1.0, t / 0.18)))
    p.turn("head", y=5 * up, x=-3 * up)
    grin = ease((t - 0.10) / 0.16) if t < 0.62 else 1 - ease((t - 0.62) / 0.30)
    p["@mouth"] = lerp(0.12, 1.0, grin)
    for side in "LR":
        p[f"brow.{side}@offset"] = (0, 0, 0.010 * up)
    for i in range(1, 5):
        p.turn(f"tail.{i}", z=10 * math.sin(2 * math.pi * 2 * t - 0.7 * i) * up)
    p.lids(blink(frame, 48))
    look_at_viewer(p)
    return p


def working(t, frame):
    """Sits with a laptop on his lap and types away, grinning at the screen."""
    p = Pose(ARMS_DOWN)
    p.relax_hands(curl=25, together=4)
    sit(p)
    p["laptop@show"] = True
    p["laptop@offset"] = LAPTOP
    p.turn("chest", x=5)
    p.turn("head", x=7, y=2 * math.sin(2 * math.pi * t))
    for side, s, phase in (("L", 1, 0.0), ("R", -1, math.pi)):
        tap = max(0.0, math.sin(4 * math.pi * t + phase))
        reach(p, side, (s * 0.085, KEYS[1] + 0.07, KEYS[2] + 0.035 + 0.014 * tap), pole=(1, 0.6, -0.6))
        p[f"hand.{side}@twist"] = 0
        p.turn(f"hand.{side}", x=-12 - 10 * tap)
    for side in "LR":
        p.turn(f"eye.{side}", x=14)
    p["@mouth"] = 0.55 + 0.05 * math.sin(4 * math.pi * t)
    for i in range(1, 5):
        p.turn(f"tail.{i}", z=5 * math.sin(2 * math.pi * t - 0.7 * i))
    return p


def happy(t, frame):
    """Crouches, jumps with both arms up in a V and a big grin, one leg
    tucked, and lands with a squash."""
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    if t < 0.2:
        u = ease(t / 0.2)
        p["hips@scale"] = (1 + 0.06 * u, 1 + 0.06 * u, 1 - 0.12 * u)
        p["@offset"] = (0, 0, -0.03 * u)
        cheer, grin, lift = 0.15 * u, lerp(0.15, 0.6, u), 0.0
    elif t < 0.66:
        u = (t - 0.2) / 0.46
        p["hips@scale"] = (0.97, 0.97, 1.06)
        p["@offset"] = (0, 0, 0.22 * math.sin(math.pi * u))
        cheer, grin, lift = ease(u * 3), 1.0, math.sin(math.pi * u)
    elif t < 0.82:
        u = (t - 0.66) / 0.16
        squash = 0.10 * math.sin(math.pi * u)
        p["hips@scale"] = (1 + squash / 2, 1 + squash / 2, 1 - squash)
        cheer, grin, lift = 1 - 0.6 * ease(u), 1.0, 0.0
    else:
        u = ease((t - 0.82) / 0.18)
        cheer, grin, lift = 0.4 * (1 - u), lerp(1.0, 0.13, u), 0.0
    p.blend(CHEER, cheer)
    for side in "LR":
        for finger in ("index", "middle", "ring", "thumb"):
            p[f"{finger}.{side}@curl"] = lerp(p.get(f"{finger}.{side}@curl", 0), 0, cheer)
    p.turn("thigh.L", x=-35 * lift)
    p.turn("thigh.R", x=12 * lift)
    p.turn("tail.1", x=-20 * lift)
    p["@mouth"] = grin
    p.turn("jaw", x=6 * cheer)
    for side in "LR":
        p[f"brow.{side}@offset"] = (0, 0, 0.012 * cheer)
    p.lids(0, lower=0.25 * cheer)
    look_at_viewer(p)
    return p


def oops(t, frame):
    """Startled, he clutches his head with his right hand and his belly with
    his left, a sweat drop running down his temple, wobbles, and recovers."""
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    startle = ease(t / 0.12) * (1 - ease((t - 0.12) / 0.15))
    hold = ease((t - 0.12) / 0.18) * (1 - ease((t - 0.80) / 0.20))
    p["@offset"] = (0, 0.03 * ease(t / 0.12) * (1 - ease((t - 0.8) / 0.2)), 0.04 * math.sin(math.pi * min(1, t / 0.2)))
    p.turn("upper_arm.L", y=-25 * startle)
    p.turn("upper_arm.R", y=25 * startle)
    scratch = 0.012 * math.sin(2 * math.pi * 4 * t) * hold
    reach(p, "R", (-0.27, -0.02, 1.00 + scratch), pole=(1, 0.5, -0.3), amount=hold)
    reach(p, "L", (0.09, -0.27, 0.43), pole=(1, 0.2, -0.6), amount=hold)
    p["hand.R@twist"] = lerp(p["hand.R@twist"], -20, hold)
    wobble = (t - 0.3) / 0.5
    if 0 < wobble < 1:
        p.turn("root", y=9 * (1 - wobble) * math.sin(5 * math.pi * wobble))
    p.turn("head", y=-6 * hold, x=-4 * hold)
    for side, s in (("L", 1), ("R", -1)):
        p.turn(f"brow.{side}", y=14 * s * hold)
        p[f"brow.{side}@offset"] = (0, 0, 0.012 * max(startle, hold))
        p.turn(f"eye.{side}", x=-10 * hold, z=8 * hold)
    p["@mouth"] = lerp(0.13, 0.5, max(startle, hold))
    p.turn("jaw", x=4 * hold)
    sweat = ease((t - 0.25) / 0.1) * (1 - ease((t - 0.85) / 0.12))
    if sweat > 0.01:
        p["sweat@show"] = True
        p["sweat@scale"] = sweat
        p["sweat@offset"] = (0, 0, -0.035 * min(1, max(0, (t - 0.3) / 0.5)))
    return p


def sleepy(t, frame):
    """Dozes on a cushion, eyes shut, hands on his belly, breathing slowly,
    z's rising off him."""
    wave = math.sin(2 * math.pi * t)
    p = Pose(ARMS_DOWN)
    p.relax_hands(curl=20, together=6)
    sit(p, SIT_DROP - CUSHION)
    p["cushion@show"] = True
    p["cushion@offset"] = (0, 0, SIT_DROP - CUSHION)
    for side, s in (("L", 1), ("R", -1)):
        reach(p, side, (s * 0.13, -0.29, 0.40 - 0.01 * wave), pole=(1, 0.3, -0.5))
        p[f"hand.{side}@twist"] = s * 40
    p["hips@scale"] = (1 + 0.012 * wave, 1 + 0.012 * wave, 1 + 0.025 * wave)
    p.turn("head", x=11 + 2 * wave, y=5)
    p.turn("tail.1", z=-15)
    p.lids(1.0)
    p["@mouth"] = 0.04 + 0.04 * (0.5 + 0.5 * wave)
    for i in range(3):
        u = (t + i / 3) % 1.0
        size = (0.6 + 0.5 * u) * (1 - ease((u - 0.75) / 0.25))
        if size > 0.02:
            p[f"z{i + 1}@show"] = True
            p[f"z{i + 1}@scale"] = size
            p[f"z{i + 1}@offset"] = (0.05 + 0.10 * u + 0.02 * math.sin(2 * math.pi * u), 0, 0.10 + 0.32 * u)
    return p


def _default(key):
    """What a pose key is when a pose leaves it out."""
    name, _, what = key.partition("@")
    if what == "":
        return (0.0, 0.0, 0.0)
    if what == "mouth":
        return 1.0
    if what == "scale":
        return 0.0 if name in PROPS else (1.0, 1.0, 1.0)
    if what == "offset":
        return (0.0, 0.0, 0.0)
    if what == "show":
        return False
    return 0.0


def mix(a, b, u):
    """A pose `u` of the way from `a` to `b`, every key of either moving. A
    prop shown in only one of them grows from nothing, or shrinks to it."""
    def sized(pose):
        """Every prop's size made explicit: as set, 1 if shown, 0 if not."""
        pose = Pose(pose)
        for name in PROPS:
            shown = bool(pose.get(f"{name}@show"))
            pose[f"{name}@scale"] = pose.get(f"{name}@scale", 1.0) if shown else 0.0
        return pose

    a, b = sized(a), sized(b)
    out = Pose()
    for key in set(a) | set(b):
        if key.endswith("@show"):
            continue
        name, _, what = key.partition("@")
        if name in PROPS and what == "offset" and (key not in a or key not in b):
            # A prop coming or going stays where the pose that shows it puts it.
            out[key] = a.get(key, b.get(key))
            continue
        old, new = a.get(key, _default(key)), b.get(key, _default(key))
        out[key] = tuple(lerp(o, n, u) for o, n in zip(old, new)) if isinstance(old, tuple) else lerp(old, new, u)
    for name in PROPS:
        if out.get(f"{name}@scale", 0.0) > 0.01:
            out[f"{name}@show"] = True
    return out


def sit_down(t, frame):
    """From standing to sitting at his laptop: he sinks, leaning back a
    little as his legs swing out, and the laptop pops up on his lap."""
    u = ease(t)
    p = mix(idle(0, 0), working(0, 0), u)
    p["@offset"] = (0, 0, -SIT_DROP * ease(t * 1.15))
    p.turn("chest", x=-9 * math.sin(math.pi * t))
    pop = ease((t - 0.55) / 0.35)
    p["laptop@scale"] = pop * (1 + 0.12 * math.sin(math.pi * pop))
    p["laptop@show"] = pop > 0.01
    return p


def stand_up(t, frame):
    """From his laptop back to his feet: the laptop goes, he pushes up."""
    p = sit_down(1 - t, frame)
    p["@offset"] = (0, 0, p["@offset"][2] + 0.03 * math.sin(math.pi * t))
    return p


def doze_off(t, frame):
    """Yawns with a big stretch while his cushion appears, and settles onto
    it, eyes shut."""
    u = ease((t - 0.35) / 0.65)
    p = mix(idle(0, 0), sleepy(0, 0), u)
    yawn = math.sin(math.pi * min(1.0, t / 0.6))
    p.blend({k: v for k, v in CHEER.items() if "@" not in k}, 0.6 * yawn * (1 - u))
    p["@mouth"] = max(p.get("@mouth", 1.0), yawn)
    p.turn("jaw", x=10 * yawn)
    p.turn("chest", x=-8 * yawn)
    p.lids(max(ease(t / 0.3), u))
    p["cushion@scale"] = ease(t / 0.4)
    p["cushion@show"] = p["cushion@scale"] > 0.01
    return p


def wake_up(t, frame):
    """Opens his eyes, stretches up off the cushion, which goes."""
    return doze_off(1 - t, frame)


def happy_eyes(p, amount):
    """Eyes squeezed into happy crescents: the lower lids pushed up, the upper
    ones a little down."""
    p.lids(0.30 * amount, lower=0.60 * amount)


def pat(t, frame):
    """Squished by the pat, he bounces back pleased, eyes squeezed happy, and
    three hearts float up off him."""
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    if t < 0.25:
        squash = 0.14 * ease(t / 0.25)
        hop = 0.0
    elif t < 0.55:
        u = (t - 0.25) / 0.3
        squash = lerp(0.14, -0.06, ease(u))
        hop = 0.035 * math.sin(math.pi * u)
    else:
        u = (t - 0.55) / 0.45
        squash = -0.06 * (1 - ease(u))
        hop = 0.0
    p["hips@scale"] = (1 + squash / 2, 1 + squash / 2, 1 - squash)
    p["@offset"] = (0, 0, hop)
    glee = ease(t / 0.15) * (1 - ease((t - 0.85) / 0.15))
    p.turn("root", z=5 * math.sin(4 * math.pi * t) * (1 - t))
    p.turn("upper_arm.L", y=-18 * glee)
    p.turn("upper_arm.R", y=18 * glee)
    happy_eyes(p, glee)
    p["@mouth"] = lerp(0.13, 0.8, glee)
    for side in "LR":
        p[f"brow.{side}@offset"] = (0, 0, 0.010 * glee)
    for i in range(3):
        u = (t - 0.10 - i * 0.13) / 0.6
        if 0 < u < 1:
            p[f"heart{i + 1}@show"] = True
            p[f"heart{i + 1}@scale"] = math.sin(math.pi * u) * 1.2
            p[f"heart{i + 1}@offset"] = (0.03 * math.sin(3 * math.pi * u), 0, 0.30 * u)
    look_at_viewer(p)
    return p


def held(t, frame):
    """Lifted off the floor and dangling: legs kicking, body swinging, arms
    up, mouth open in a "wheee"."""
    swing = math.sin(2 * math.pi * t)
    p = Pose(ARMS_DOWN)
    p.relax_hands(curl=10)
    p["@offset"] = (0, 0, 0.20)
    p["hips@scale"] = (0.97, 0.97, 1.06)
    p.turn("root", y=6 * swing)
    # Arms up and bent, as if lifted under them.
    p.blend({k: v for k, v in CHEER.items() if "@" not in k}, 0.8)
    p.turn("forearm.L", y=-25, x=-10)
    p.turn("forearm.R", y=25, x=-10)
    p.turn("upper_arm.L", y=-8 * math.sin(4 * math.pi * t))
    p.turn("upper_arm.R", y=8 * math.sin(4 * math.pi * t + 1))
    for i, side in enumerate("LR"):
        p.turn(f"thigh.{side}", x=14 * math.sin(4 * math.pi * t + i * math.pi))
        p.turn(f"foot.{side}", x=25)
    for i in range(1, 5):
        p.turn(f"tail.{i}", z=10 * math.sin(2 * math.pi * t - 0.7 * i), x=6)
    p["@mouth"] = 0.75
    for side in "LR":
        p[f"brow.{side}@offset"] = (0, 0, 0.012)
    look_at_viewer(p)
    return p


def drop(t, frame):
    """Set down from a hold: he drops, squashes on landing with his eyes
    squeezed, and bounces back up."""
    start = held(0, 0)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    if t < 0.3:
        u = t / 0.3
        p = mix(start, p, 0.3 * u)
        p["@offset"] = (0, 0, 0.20 * (1 - u * u))
        squash, eyes = 0.0, 0.0
    elif t < 0.55:
        u = (t - 0.3) / 0.25
        squash, eyes = 0.18 * math.sin(math.pi * u), math.sin(math.pi * u)
        p["@offset"] = (0, 0, 0)
    else:
        u = (t - 0.55) / 0.45
        squash, eyes = -0.05 * math.sin(math.pi * u) * (1 - u), 0.0
        p["@offset"] = (0, 0, 0.025 * math.sin(math.pi * u))
    p["hips@scale"] = (1 + squash / 2, 1 + squash / 2, 1 - squash)
    p.lids(0.7 * eyes, lower=0.4 * eyes)
    p["@mouth"] = lerp(0.6, 0.13, ease(t))
    look_at_viewer(p)
    return p


def blush(t, frame):
    """Kind words: his cheeks turn pink, he hides his grin behind his hands
    and sways shyly, eyes squeezed, looking down and away."""
    b = ease(t / 0.2) if t < 0.2 else (1 - ease((t - 0.82) / 0.18) if t > 0.82 else 1.0)
    p = Pose(ARMS_DOWN)
    p.relax_hands(curl=15, together=2)
    p["@blush"] = b
    for side, s in (("L", 1), ("R", -1)):
        x = s * 0.075
        mouth = rig.from_head((x, model.front(x, 0.74) - 0.03, 0.71))
        reach(p, side, mouth, pole=(1, 0.2, -0.8), amount=b)
        p[f"hand.{side}@twist"] = lerp(p[f"hand.{side}@twist"], s * 10, b)
    p.turn("root", z=6 * math.sin(4 * math.pi * t) * b)
    p.turn("head", x=6 * b, y=7 * b)
    for side, s in (("L", 1), ("R", -1)):
        p.turn(f"eye.{side}", x=8 * b, z=-10 * b)
        p.turn(f"brow.{side}", y=8 * s * b)
    p.lids(0.25 * b, lower=0.45 * b)
    p["@mouth"] = lerp(0.13, 0.45, b)
    return p


def _gesture(t, start=0.15, end=0.82):
    """How far into a gesture a fidget is: in by `start`, out from `end`."""
    return ease(t / start) * (1 - ease((t - end) / (1 - end)))


def wonder(t, frame):
    """Puzzled: scratches his head with his right hand, looking up, one brow
    raised, mouth a little open and askew."""
    g = _gesture(t)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    scratch = 0.012 * math.sin(2 * math.pi * 5 * t) * g
    reach(p, "R", (-0.26, 0.0, 1.0 + scratch), pole=(1, 0.5, -0.2), amount=g)
    p["hand.R@twist"] = lerp(p["hand.R@twist"], -30, g)
    p.hand_shape("R", "fist", 0.5 * g)
    reach(p, "L", (0.09, -0.27, 0.43), pole=(1, 0.2, -0.6), amount=g)
    p.turn("head", y=-8 * g, x=-5 * g)
    p.turn("brow.R", y=-10 * g)
    p["brow.R@offset"] = (0, 0, 0.016 * g)
    for side in "LR":
        p.turn(f"eye.{side}", x=-14 * g, z=10 * g)
    p["@mouth"] = lerp(0.13, 0.3, g)
    p.turn("jaw", x=3 * g, z=3 * g)
    return p


def psst(t, frame):
    """Up to something: turns his face to you and holds a finger up across
    his lips, the other hand on his hip, a sly look under lowered brows."""
    g = _gesture(t)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    head = (0, 0, -28)  # to the camera off to his right, and a little past
    p.turn("head", *(a * g for a in head))
    # His arms are short, so his face turns to meet the hand: the index finger
    # stands up in front of his lips, a little to his right and leaning
    # forward, and the wrist goes where that puts it.
    turn = Euler(tuple(map(deg, head)), "XYZ").to_matrix()
    pivot = Vector(model._lifted(HEAD_BASE))
    lips = pivot + turn @ (Vector(rig.from_head((-0.08, model.front(-0.08, 0.79), 0.79))) - pivot)
    face = turn @ Vector((0, -1, 0))
    tip = lips + face * 0.035 + Vector((0, 0, 0.035))
    point_index(p, tip, finger=(0.1, -0.25, 1), thumb=(0.3, 1, 0), pole=(1, 0.1, -1), amount=g)
    p["thumb.R@curl"] = lerp(p["thumb.R@curl"], 90, g)  # tucked in, out of the way
    reach(p, "L", (0.36, 0.03, 0.43), pole=(1, 0.8, 0.1), amount=g)
    p.hand_shape("L", "fist", 0.6 * g)
    for side, s in (("L", 1), ("R", -1)):
        p.turn(f"brow.{side}", y=-12 * s * g)
        p[f"brow.{side}@offset"] = (0, 0, -0.006 * g)
        p.turn(f"eye.{side}", z=4 * g)
    p.lids(0.35 * g, lower=0.15 * g)
    p["@mouth"] = lerp(0.13, 0.0, g)
    return p


def thumbs(t, frame):
    """Pleased with himself: a thumb up at you, a wink and a smug smile, his
    other hand on his belly."""
    g = _gesture(t, 0.2, 0.8)
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    reach(p, "R", (-0.34, -0.30, 0.57), pole=(0, 0.5, -1), amount=g)
    # Knuckles to the camera off to his right, the thumb straight up.
    orient_hand(p, "R", along=(-0.45, -1, 0.1), thumb=(0, 0, 1), amount=g)
    p.hand_shape("R", "thumb", g)
    reach(p, "L", (0.09, -0.27, 0.43), pole=(1, 0.2, -0.6), amount=g)
    wink = ease((t - 0.35) / 0.08) * (1 - ease((t - 0.6) / 0.08))
    p.lid("R", 0.25 * g + 0.75 * wink, lower=0.3 * g + 0.3 * wink)
    p.lid("L", 0.25 * g, lower=0.3 * g)
    p.turn("head", y=-5 * g)
    p["@mouth"] = lerp(0.13, 0.35, g)
    p["@offset"] = (0, 0, 0.02 * math.sin(math.pi * min(1, t / 0.25)))
    look_at_viewer(p)
    return p


def look(t, frame):
    """Looks around: turns his head and eyes to his left, holds, across to
    his right, holds, and back."""
    keys = [(0.0, 0.0), (0.15, -1.0), (0.38, -1.0), (0.6, 1.0), (0.82, 1.0), (1.0, 0.0)]
    side = 0.0
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t0 <= t < t1:
            side = lerp(a, b, ease((t - t0) / (t1 - t0)))
            break
    p = Pose(ARMS_DOWN)
    p.relax_hands()
    p.turn("head", z=-22 * side, x=-3 * abs(side))
    p.turn("root", z=-5 * side)
    for eye in "LR":
        p.turn(f"eye.{eye}", z=-18 * side)
    p.lids(blink(frame, 15))
    p["@mouth"] = 0.13
    return p


def working_magnifier(t, frame):
    """At his laptop, peering at the screen through a magnifying glass held up
    in his right fist, his left hand still on the keys."""
    p = working(t, frame)
    for finger in ("index", "middle", "ring", "thumb"):
        p.pop(f"{finger}.R@spread", None)
    bob = 0.01 * math.sin(2 * math.pi * t)
    reach(p, "R", (-0.12, -0.36, 0.62 + bob), pole=(1, 0.4, -0.7))
    orient_hand(p, "R", along=(0.15, -1, 0.15), thumb=(0.45, 0, 1))
    p.hand_shape("R", "fist")
    p["magnifier@show"] = True
    p.turn("head", y=-4)
    for side in "LR":
        p.turn(f"eye.{side}", z=8)
    p["@mouth"] = 0.25
    for side in "LR":
        p[f"brow.{side}@offset"] = (0, 0, 0.008)
    return p


def working_notepad(t, frame):
    """Writing on a notepad on his lap instead of typing, the pencil going in
    little loops."""
    p = working(t, frame)
    p["laptop@show"] = False
    p["notepad@show"] = True
    p["notepad@offset"] = (LAPTOP[0], LAPTOP[1] + 0.03, LAPTOP[2] + 0.06)
    p["pencil@show"] = True
    for finger in ("index", "middle", "ring", "thumb"):
        p.pop(f"{finger}.R@spread", None)
    loop = (0.03 * math.sin(4 * math.pi * t), 0, 0.012 * math.cos(4 * math.pi * t))
    reach(p, "R", (-0.04 + loop[0], -0.40, 0.42 + loop[2]), pole=(1, 0.5, -0.4))
    orient_hand(p, "R", along=(0.6, -1, 0.1), thumb=(0.1, 0.2, 1))
    p.hand_shape("R", "fist")
    # The left hand holds the pad by its edge, palm down, fingers over it.
    reach(p, "L", (0.25, -0.38, 0.48), pole=(1, 0.3, -0.5))
    orient_hand(p, "L", along=(-1, -0.3, -0.3), thumb=(0, 1, 0))
    p.hand_shape("L", "fist", 0.3)
    for side in "LR":
        p.turn(f"eye.{side}", x=16)
    p["@mouth"] = 0.15
    return p


def working_binoculars(t, frame):
    """Holds binoculars to his eyes with both hands, scanning slowly side to
    side: looking something up on the web."""
    p = working(t, frame)
    p["laptop@show"] = False
    p["binoculars@show"] = True
    scan = math.sin(2 * math.pi * t)
    p.turn("head", z=-10 * scan, x=-6)
    for side, s in (("L", 1), ("R", -1)):
        p.pop(f"index.{side}@spread", None)
        reach(p, side, (s * 0.20, -0.32, 0.68), pole=(1, 0.4, -0.8))
        orient_hand(p, side, along=(-s * 0.4, -0.3, 1), thumb=(0, -1, 0.2))
        p.hand_shape(side, "fist", 0.7)
    p["@mouth"] = 0.2
    return p


def working_thinking(t, frame):
    """At his laptop, lost in thought: the tip of his right index finger at
    his chin under his lip, tapping, eyes up and off to the side, one brow
    raised, lips pressed shut and pushed aside, while the fingers of his left
    hand drum on the keys."""
    p = Pose(ARMS_DOWN)
    p.relax_hands(curl=25, together=4)
    sit(p)
    p["laptop@show"] = True
    p["laptop@offset"] = LAPTOP
    # The head turns a little toward you and leans toward the hand, nodding
    # slowly as he mulls.
    head = (-3 + 1.5 * math.sin(2 * math.pi * t), 8, -14)
    p.turn("head", *head)
    # His chin is one with his belly, so a fist under it would sit on his
    # chest: the finger goes under the right of his lower lip instead,
    # wherever the head puts it, tapping twice a loop.
    turn = Euler(tuple(map(deg, head)), "XYZ").to_matrix()
    pivot = Vector(model._lifted(HEAD_BASE))
    spot = Vector(rig.from_head((-0.12, model.front(-0.12, 0.725), 0.725)))
    tap = 0.012 * max(0.0, math.sin(2 * math.pi * 2 * t))
    tip = pivot + turn @ (spot - pivot) + turn @ Vector((0, -0.012, 0)) + Vector((0, 0, -SIT_DROP - tap))
    point_index(p, tip, finger=(0.15, -0.2, 1), thumb=(0.3, 1, 0), pole=(1, 0.1, -1))
    p["thumb.R@curl"] = 90  # tucked in, out of the way
    # The left hand rests on the keys, its fingers drumming twice a loop.
    reach(p, "L", (0.085, KEYS[1] + 0.07, KEYS[2] + 0.035), pole=(1, 0.6, -0.6))
    p["hand.L@twist"] = 0
    p.turn("hand.L", x=-12)
    for i, finger in enumerate(("ring", "middle", "index")):
        lift = max(0.0, math.sin(2 * math.pi * 2 * t - 0.9 * i)) ** 2
        p[f"{finger}.L@curl"] = 25 - 30 * lift
    # Eyes up and drifting, a brow raised, the lips shut and askew.
    for side in "LR":
        p.turn(f"eye.{side}", x=-16, z=12 + 6 * math.sin(2 * math.pi * t))
    p.turn("brow.R", y=-10)
    p["brow.R@offset"] = (0, 0, 0.016)
    p.lids(blink(frame, 36))
    p["@mouth"] = 0.04
    p.turn("jaw", z=4)
    for i in range(1, 5):
        p.turn(f"tail.{i}", z=4 * math.sin(2 * math.pi * t - 0.7 * i))
    return p


def deflate(t, frame):
    """From stuffed back to his own size, with a big sigh: a breath in, then
    all of it out, eyes shut, arms sagging, and a shake back to normal."""
    p = idle(0, 0)
    if t < 0.25:
        u = ease(t / 0.25)
        size, mouth, shut, sag = 1.0, lerp(0.13, 0.05, u), 0.3 * u, 0.0
        p["hips@scale"] = (1, 1, 1 + 0.04 * u)
    elif t < 0.75:
        u = ease((t - 0.25) / 0.5)
        size, mouth, shut, sag = 1 - u, lerp(0.05, 0.55, math.sin(math.pi * min(1.0, u * 1.2))), 0.9, u
        p["hips@scale"] = (1, 1, 1 + 0.04 * (1 - u) - 0.06 * u)
    else:
        u = ease((t - 0.75) / 0.25)
        size, mouth, shut, sag = 0.0, lerp(0.15, 0.13, u), 0.9 * (1 - u), 1 - u
        p["hips@scale"] = (1, 1, 1 - 0.06 * (1 - u) + 0.02 * math.sin(3 * math.pi * u) * (1 - u))
    stuffed = SIZES["stuffed"]
    grown(p, tuple(lerp(1, f, size) for f in stuffed))
    p.turn("upper_arm.L", y=10 * sag)
    p.turn("upper_arm.R", y=-10 * sag)
    p.turn("head", x=6 * sag)
    p["@mouth"] = mouth
    p.lids(shut, lower=0.3 * shut)
    return p


# Where the laptop sits on his lap, as an offset from where it is built, and
# where its keys are then, in the world.
LAPTOP = (0, -0.06, 0.27)
KEYS = (0, -0.40, 0.25 + 0.008)
CUSHION = 0.13  # its height

MOTIONS = {"idle": idle, "hello": hello, "working": working, "happy": happy, "oops": oops, "sleepy": sleepy,
           "sit_down": sit_down, "stand_up": stand_up, "doze_off": doze_off, "wake_up": wake_up,
           "pat": pat, "held": held, "drop": drop, "blush": blush,
           "wonder": wonder, "psst": psst, "thumbs": thumbs, "look": look,
           "working_magnifier": working_magnifier, "working_notepad": working_notepad,
           "working_binoculars": working_binoculars, "working_thinking": working_thinking,
           "deflate": deflate}


def grown(p, size):
    """The pose with his belly `size` (a SIZES entry or factors) and his arms
    out a little further to clear it."""
    factors = SIZES[size] if isinstance(size, str) else size
    sx, sy, sz = p.get("hips@scale", (1, 1, 1))
    p["hips@scale"] = (sx * factors[0], sy * factors[1], sz * factors[2])
    out = (factors[0] - 1) * 120
    p.turn("upper_arm.L", y=out)
    p.turn("upper_arm.R", y=-out)
    return p


def pose_at(clip_name, frame):
    """Ranko's pose on `frame` of a clip, in rig.pose's terms."""
    clip = CLIPS[clip_name]
    p = MOTIONS[clip.motion](frame / clip.frames, frame)
    if clip.size != "normal":
        p = grown(p, clip.size)
    return p.for_rig()
