"""Ranko's clips: what pose each frame of each clip puts him in.

Each motion is a function of how far through its clip a frame is (t in
[0, 1)) and returns a pose for blender/rig.py: turns per bone, in degrees
here and radians there, about the bone's head, in the world's axes of the
rest pose.
"""

import math
from dataclasses import dataclass

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
}

# Arms hanging loose at his sides: out just enough to clear the belly, the
# elbows a little bent so the forearms follow its curve, palms in.
ARMS_DOWN = {
    "upper_arm.L": (-8, 34, 0), "forearm.L": (-14, 18, 0), "hand.L@twist": 85,
    "upper_arm.R": (-8, -34, 0), "forearm.R": (-14, -18, 0), "hand.R@twist": -85,
}
# His right arm up and out, forearm raised, palm to the front.
WAVE_ARM = {"upper_arm.R": (-5, 65, -12), "forearm.R": (0, 45, 0), "hand.R": (0, 5, 0), "hand.R@twist": 0}


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


MOTIONS = {"idle": idle, "hello": hello}


def pose_at(clip_name, frame):
    """Ranko's pose on `frame` of a clip, in rig.pose's terms."""
    clip = CLIPS[clip_name]
    return MOTIONS[clip.motion](frame / clip.frames, frame).for_rig()
