"""Ranko's clips: what pose each frame of each clip puts him in.

Each motion is a function of how far through its clip a frame is (t in
[0, 1)) and returns a pose for blender/rig.py: turns per bone, in degrees
here and radians there, about the bone's head, in the world's axes of the
rest pose.
"""

import math
from dataclasses import dataclass

from mathutils import Vector

import model
import rig

deg = math.radians
FPS = 24


@dataclass
class Clip:
    motion: str
    frames: int
    loop: bool


CLIPS = {
    "idle": Clip("idle", 48, True),
    "hello": Clip("hello", 56, False),
    "working": Clip("working", 24, True),
    "happy": Clip("happy", 32, False),
    "oops": Clip("oops", 36, False),
    "sleepy": Clip("sleepy", 64, True),
}

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


def sit(p, drop=SIT_DROP):
    p.blend(SIT, 1.0)
    p["@offset"] = (0, 0, -drop)


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


# Where the laptop sits on his lap, as an offset from where it is built, and
# where its keys are then, in the world.
LAPTOP = (0, -0.06, 0.27)
KEYS = (0, -0.42, 0.25 + 0.008)
CUSHION = 0.13  # its height

MOTIONS = {"idle": idle, "hello": hello, "working": working, "happy": happy, "oops": oops, "sleepy": sleepy}


def pose_at(clip_name, frame):
    """Ranko's pose on `frame` of a clip, in rig.pose's terms."""
    clip = CLIPS[clip_name]
    return MOTIONS[clip.motion](frame / clip.frames, frame).for_rig()
