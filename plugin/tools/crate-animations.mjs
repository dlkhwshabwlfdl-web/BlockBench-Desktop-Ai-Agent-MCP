/**
 * Legendary Crate — animation set.
 *
 * Every animation is a set of sampled curves rather than a handful of poses, so easing,
 * overshoot and secondary motion all survive into Blockbench. The important principle is
 * *layering*: nothing moves on the same beat. Each animation gives a part a `stage`
 * window and the parts fire in a fixed causal order —
 *
 *     lock -> lid -> crystals -> energy
 *
 * — with the decorations lagging further still, so the crate never reads as one rigid
 * object being rotated.
 *
 * Rotation sign conventions (derived from the geometry, not guessed):
 *   lid      pivot (0,17,-11.5), mass toward +Z  ->  -X lifts the front open, +X presses it shut
 *   lock     pivot (0,13.6,11.8), mass toward +Z ->  -X tilts the plaque up
 *   crystals pivot below the shards, +Y mass     ->  +X leans the shard forward,
 *                                                    -Z splays the LEFT crystal outward,
 *                                                    +Z splays the RIGHT crystal outward
 *   core     pivot at the crate centre           ->  +Y spins it, +X tumbles it
 *   root     rotation is applied at the ground   ->  +Y turns the crate toward its left
 */
import { BONE_NAMES } from './crate-design.mjs';

/* ------------------------------------------------------------------- easing */

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** Normalised progress through [t0,t1]. */
const seg = (t, t0, t1) => clamp01((t - t0) / (t1 - t0));
const lerp = (a, b, t) => a + (b - a) * t;

const easeInQuad = (t) => t * t;
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoots past 1 then settles — the basis of every "weight" beat here. */
const easeOutBack = (t, s = 1.9) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
const easeOutElastic = (t, amp = 1, period = 0.35) =>
  t <= 0 ? 0 : t >= 1 ? 1 : amp * 2 ** (-10 * t) * Math.sin(((t - period / 4) * (2 * Math.PI)) / period) + 1;
const easeOutBounce = (t) => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
/** +1..-1 sine wave, `phase` in cycles. */
const wave = (t, phase = 0) => Math.sin((t + phase) * Math.PI * 2);
/** 0..1 sine wave. */
const swell = (t, phase = 0) => (wave(t, phase) + 1) / 2;
/** Rises from 0 to 1 across [t0,t1] and stays there. */
const gate = (t, t0, t1) => easeInOut(seg(t, t0, t1));
/** A single pulse: 0 outside [t0,t1], peaking at the midpoint. */
const pulse = (t, t0, t1) => {
  if (t <= t0 || t >= t1) return 0;
  const u = (t - t0) / (t1 - t0);
  return Math.sin(u * Math.PI);
};

/* --------------------------------------------------------------- key helpers */

const INTERPOLATIONS = new Set(['linear', 'catmullrom', 'bezier', 'step']);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** One keyframe, with every field normalised so a bad call site cannot poison a payload. */
export function kf(node, channel, time, x, y, z, interpolation = 'catmullrom') {
  const interp = INTERPOLATIONS.has(interpolation) ? interpolation : 'catmullrom';
  const ch = ['rotation', 'position', 'scale'].includes(channel) ? channel : 'rotation';
  const num = (v) => (Number.isFinite(Number(v)) ? round3(Number(v)) : 0);
  return { node, channel: ch, time: round3(time), x: num(x), y: num(y), z: num(z), interpolation: interp };
}

/**
 * Sample a normalised 0..1 cycle into keyframes.
 * `fn` returns [x,y,z], a scalar (replicated on all three axes), or null to skip.
 */
function track(node, channel, length, samples, fn, interpolation = 'catmullrom') {
  const out = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const v = fn(t);
    if (v === null || v === undefined) continue;
    const time = t * length;
    if (Array.isArray(v)) out.push(kf(node, channel, time, v[0], v[1], v[2], interpolation));
    else out.push(kf(node, channel, time, v, v, v, interpolation));
  }
  return out;
}

/** Samples for a clip: smooth clips get fewer, snappy ones need more. */
const S = (length, rate) => Math.max(8, Math.round(length * rate));

/* -------------------------------------------------------------- bone aliases */

const ROOT = 'LegendaryCrate';
const BASE = 'Base';
const BOTTOM = 'BottomFrame';
const BODY = 'Body';
const POSTS = 'CornerPosts';
const FF = 'FrontFrame';
const BF = 'BackFrame';
const LF = 'LeftFrame';
const RF = 'RightFrame';
const LID = 'Lid';
const LIDM = 'LidMain';
const LIDF = 'LidFrame';
const LIDS = 'LidSeparator';
const LIDD = 'LidDecoration';
const LOCK = 'Lock';
const LOCKF = 'LockFrame';
const LOCKC = 'LockCore';
const LOCKG = 'LockGlow';
const CRY_L = 'LeftCrystal';
const CRY_R = 'RightCrystal';
const CRY_T = 'TopCrystal';
const CORE = 'MagicCore';
const HALO = 'CoreHalo';
const ENERGY = 'EnergyDetails';

/* ------------------------------------------------------------- shared curves */

/** The idle "breath": slow, small, and slightly out of phase per part. */
function breath(t, phase, amount) {
  return wave(t, phase) * amount;
}

/**
 * The lid opening with weight: press shut (anticipation), swing open past vertical,
 * recoil off the hinge, then settle. `open` is negative.
 */
function lidSwing(t, open, t0, t1, t2) {
  const press = seg(t, 0, t0);
  const swing = seg(t, t0, t1);
  const settle = seg(t, t1, t2);
  if (t <= t0) return lerp(0, 3.2, press);
  if (t <= t1) return lerp(3.2, open * 1.07, easeOutCubic(swing));
  return lerp(open * 1.07, open, easeInOutCubic(settle));
}

/** A decaying rattle — vibration that dies out, used by shake and open_legendary. */
function rattle(t, t0, t1, freq, amount, decay = 1) {
  if (t <= t0 || t >= t1) return 0;
  const u = (t - t0) / (t1 - t0);
  return wave(u * freq, 0) * amount * (1 - u) ** decay;
}

/** Energy flare: 0 -> spike -> settle to `rest`. */
function flare(t, t0, t1, peak, rest = 1) {
  const u = seg(t, t0, t1);
  if (u <= 0) return 1;
  if (u >= 1) return rest;
  return u < 0.35 ? lerp(1, peak, easeOutQuad(u / 0.35)) : lerp(peak, rest, easeInOut((u - 0.35) / 0.65));
}

/** Energy drain: 1 -> stutter down to `floor`. */
function drain(t, t0, t1, floor) {
  const u = seg(t, t0, t1);
  if (u <= 0) return 1;
  if (u >= 1) return floor;
  const stutter = Math.sin(u * Math.PI * 3) * 0.06 * (1 - u);
  return lerp(1, floor, easeInCubic(u)) + stutter;
}

/* --------------------------------------------------------------- animations */

/**
 * Each entry is one clip. `length` is in seconds and `loop` maps to Blockbench's loop
 * modes. `build()` returns the keyframe list.
 */
export const ANIMATIONS = [
  /* ---------------------------------------------------------------- 1 idle */
  {
    name: 'idle',
    length: 2.4,
    loop: 'loop',
    note: 'breathing-like mechanical rest: body float, lid micro-rock, crystals drift',
    build: () => {
      const L = 2.4;
      const n = S(L, 11);
      return [
        ...track(BODY, 'position', L, n, (t) => [0, breath(t, 0, 0.17), 0]),
        ...track(LID, 'rotation', L, n, (t) => [breath(t, 0.12, 0.9), 0, breath(t, 0.05, 0.5)]),
        ...track(LIDD, 'rotation', L, n, (t) => [breath(t, 0.18, 0.9), 0, 0]),
        ...track(LOCK, 'rotation', L, n, (t) => [breath(t, 0.22, 1.0), 0, breath(t, 0.3, 0.9)]),
        ...track(LOCK, 'position', L, n, (t) => [0, breath(t, 0.26, 0.2), 0]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + swell(t, 0.3) * 0.26),
        ...track(CORE, 'scale', L, n, (t) => 1 + swell(t, 0.4) * 0.14),
        ...track(CORE, 'rotation', L, n, (t) => [0, t * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.2, 1.8), 0, -breath(t, 0.2, 2.2)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.2, 1.8), 0, breath(t, 0.2, 2.2)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [breath(t, 0.34, 2.2), 0, breath(t, 0.16, 1.6)]),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.5, 0.32), 0]),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, breath(t, 0.44, 9), 0]),
        ...track(BOTTOM, 'position', L, n, (t) => [0, -breath(t, 0.08, 0.16), 0]),
      ];
    },
  },

  /* ---------------------------------------------------------- 2 idle_magic */
  {
    name: 'idle_magic',
    length: 3.2,
    loop: 'loop',
    note: 'core leads, conduits follow, crystals answer last',
    build: () => {
      const L = 3.2;
      const n = S(L, 10);
      return [
        ...track(CORE, 'scale', L, n, (t) => 1.02 + swell(t, 0) * 0.2),
        ...track(CORE, 'rotation', L, n, (t) => [0, t * 720, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.1) * 14, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.12, 0.45), 0]),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + swell(t, 0.16) * 0.28),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + swell(t, 0.24) * 0.3),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.3, 1.6), 0, -2.4 - breath(t, 0.3, 2.2)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.3, 1.6), 0, 2.4 + breath(t, 0.3, 2.2)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [breath(t, 0.38, 2.0), 0, breath(t, 0.22, 1.4)]),
        ...track(CRY_L, 'scale', L, n, (t) => 1 + swell(t, 0.34) * 0.16),
        ...track(CRY_R, 'scale', L, n, (t) => 1 + swell(t, 0.34) * 0.16),
        ...track(LID, 'rotation', L, n, (t) => [breath(t, 0.44, 0.75), 0, breath(t, 0.4, 0.3)]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 + swell(t, 0.5) * 0.03, 1]),
        ...track(FF, 'position', L, n, (t) => [0, 0, swell(t, 0.2) * 0.28]),
        ...track(BF, 'position', L, n, (t) => [0, 0, -swell(t, 0.2) * 0.28]),
      ];
    },
  },

  /* ----------------------------------------------------------- 3 idle_glow */
  {
    name: 'idle_glow',
    length: 2.0,
    loop: 'loop',
    note: 'the lock breathes light; the frame flexes a hair outward as it charges',
    build: () => {
      const L = 2.0;
      const n = S(L, 12);
      return [
        ...track(LOCKG, 'scale', L, n, (t) => 1 + swell(t, 0) * 0.45),
        ...track(LOCKG, 'position', L, n, (t) => [0, 0, swell(t, 0) * 0.22]),
        ...track(LOCKC, 'scale', L, n, (t) => 1 + swell(t, 0.08) * 0.22),
        ...track(LOCK, 'rotation', L, n, (t) => [breath(t, 0.12, 0.25), 0, 0]),
        ...track(CORE, 'scale', L, n, (t) => 1 + swell(t, 0.2) * 0.24),
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'scale', L, n, (t) => [1, 1 + swell(t, 0.28) * 0.34, 1]),
        ...track(CRY_L, 'scale', L, n, (t) => 1 + swell(t, 0.34) * 0.09),
        ...track(CRY_R, 'scale', L, n, (t) => 1 + swell(t, 0.34) * 0.09),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + swell(t, 0.4) * 0.11),
        ...track(FF, 'position', L, n, (t) => [0, 0, swell(t, 0.06) * 0.2]),
        ...track(LID, 'rotation', L, n, (t) => [breath(t, 0.3, 0.4), 0, 0]),
      ];
    },
  },

  /* --------------------------------------------------------------- 4 hover */
  {
    name: 'hover',
    length: 2.6,
    loop: 'loop',
    note: 'the whole crate floats; the underside and lid trail the root so it feels attached, not rigid',
    build: () => {
      const L = 2.6;
      const n = S(L, 12);
      return [
        ...track(ROOT, 'position', L, n, (t) => [0, swell(t, 0) * 1.15, 0]),
        ...track(ROOT, 'rotation', L, n, (t) => [breath(t, 0.05, 0.9), breath(t, 0.2, 2.2), breath(t, 0.1, 0.7)]),
        ...track(BOTTOM, 'position', L, n, (t) => [0, -breath(t, 0.18, 0.3), 0]),
        ...track(LID, 'rotation', L, n, (t) => [-swell(t, 0.14) * 1.6, 0, breath(t, 0.3, 0.9)]),
        ...track(LIDD, 'rotation', L, n, (t) => [-swell(t, 0.2) * 1.1, 0, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.24, 2.2), 0, -2.6 - breath(t, 0.24, 3.0)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.24, 2.2), 0, 2.6 + breath(t, 0.24, 3.0)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [breath(t, 0.36, 2.6), 0, breath(t, 0.2, 1.8)]),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.42, 0.5), 0]),
        ...track(CORE, 'scale', L, n, (t) => 1 + swell(t, 0.32) * 0.24),
        ...track(CORE, 'rotation', L, n, (t) => [0, t * 360, 0], 'linear'),
      ];
    },
  },

  /* --------------------------------------------------------------- 5 shake */
  {
    name: 'shake',
    length: 0.9,
    loop: 'once',
    note: 'anticipation lean, then a decaying rattle that the lid and crystals join late',
    build: () => {
      const L = 0.9;
      const n = S(L, 22);
      return [
        ...track(ROOT, 'position', L, n, (t) => [rattle(t, 0.18, 0.95, 9, 0.55), 0, rattle(t, 0.2, 0.95, 7, 0.4)]),
        ...track(ROOT, 'rotation', L, n, (t) => [lerp(0, -2.4, easeOutQuad(seg(t, 0, 0.18))) + rattle(t, 0.18, 0.95, 9, 1.1), 0, rattle(t, 0.22, 0.95, 8, 1.3)]),
        ...track(LID, 'rotation', L, n, (t) => [rattle(t, 0.26, 0.95, 11, 1.5), 0, rattle(t, 0.3, 0.95, 10, 1.1)]),
        ...track(LIDD, 'rotation', L, n, (t) => [rattle(t, 0.34, 0.95, 13, 1.7), 0, 0]),
        ...track(LOCK, 'rotation', L, n, (t) => [rattle(t, 0.24, 0.95, 12, 1.4), 0, rattle(t, 0.28, 0.95, 10, 2.0)]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.3, 0.95) * 0.5),
        ...track(CRY_L, 'rotation', L, n, (t) => [rattle(t, 0.36, 0.95, 14, 2.6), 0, -rattle(t, 0.36, 0.95, 12, 2.2)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [rattle(t, 0.36, 0.95, 14, 2.6), 0, rattle(t, 0.36, 0.95, 12, 2.2)]),
        ...track(ENERGY, 'position', L, n, (t) => [rattle(t, 0.4, 0.95, 16, 0.6), rattle(t, 0.42, 0.95, 14, 0.4), 0]),
        ...track(CORE, 'scale', L, n, (t) => 1 + pulse(t, 0.28, 0.95) * 0.16),
      ];
    },
  },

  /* ---------------------------------------------------------- 6 key_insert */
  {
    name: 'key_insert',
    length: 1.2,
    loop: 'once',
    note: 'key goes in, mechanism pushes, then twists and locks with a violet spike',
    build: () => {
      const L = 1.2;
      const n = S(L, 22);
      const push = (t) => (t < 0.15 ? 0 : t < 0.45 ? lerp(0, 0.42, easeOutQuad(seg(t, 0.15, 0.45))) : 0.42);
      const twist = (t) => (t < 0.55 ? 0 : t < 0.88 ? lerp(0, -22, easeOutBack(seg(t, 0.55, 0.88))) : lerp(-22, -18, easeInOut(seg(t, 0.88, 1))));
      return [
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, push(t)]),
        ...track(LOCKC, 'scale', L, n, (t) => 1 + pulse(t, 0.55, 0.95) * 0.22),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, twist(t)]),
        ...track(LOCKF, 'position', L, n, (t) => [0, 0, push(t) * 0.25 + pulse(t, 0.6, 1.0) * 0.1]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.5, 0.95) * 0.85),
        ...track(CORE, 'scale', L, n, (t) => 1 + pulse(t, 0.55, 1.0) * 0.18),
        // one full turn, so releasing the clip is invisible
        ...track(HALO, 'rotation', L, n, (t) => [0, -easeOutCubic(seg(t, 0.5, 1)) * 360, 0], 'linear'),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -pulse(t, 0.62, 1.0) * 5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, pulse(t, 0.62, 1.0) * 5]),
        ...track(BODY, 'position', L, n, (t) => [0, -pulse(t, 0.5, 0.95) * 0.22, 0]),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + pulse(t, 0.6, 1.0) * 0.35),
      ];
    },
  },

  /* -------------------------------------------------------------- 7 unlock */
  {
    name: 'unlock',
    length: 1.5,
    loop: 'once',
    note: 'the mechanism reacts before the lid — two sharp mechanism beats, then the lid lifts a hair',
    build: () => {
      const L = 1.5;
      const n = S(L, 20);
      const untwist = (t) => (t < 0.1 ? -18 : t < 0.34 ? lerp(-18, -6, easeOutCubic(seg(t, 0.1, 0.34))) : t < 0.52 ? lerp(-6, 0, easeOutBack(seg(t, 0.34, 0.52))) : 0);
      return [
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, untwist(t)]),
        ...track(LOCK, 'position', L, n, (t) => [0, 0, t < 0.42 ? 0.42 : lerp(0.42, 0, easeInOut(seg(t, 0.42, 0.68)))]),
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, t < 0.42 ? 0.42 : lerp(0.42, 0, easeInOut(seg(t, 0.42, 0.68)))]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.28, 0.72) * 0.7),
        ...track(LOCKF, 'position', L, n, (t) => [0, 0, pulse(t, 0.4, 0.8) * 0.22]),
        // the lid only breathes here: a small pop up and back down, still shut
        ...track(LID, 'rotation', L, n, (t) => [-pulse(t, 0.5, 0.95) * 3.4, 0, 0]),
        ...track(LIDD, 'rotation', L, n, (t) => [-pulse(t, 0.56, 1.0) * 2.2, 0, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, pulse(t, 0.46, 0.9) * 0.25, 0]),
        ...track(CORE, 'scale', L, n, (t) => 1 + pulse(t, 0.34, 1.0) * 0.24),
        ...track(HALO, 'rotation', L, n, (t) => [0, -gate(t, 0.3, 0.95) * 360, 0], 'linear'),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -pulse(t, 0.54, 1.0) * 4.5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, pulse(t, 0.54, 1.0) * 4.5]),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + pulse(t, 0.6, 1.0) * 0.24),
      ];
    },
  },

  /* ---------------------------------------------------------------- 8 open */
  {
    name: 'open',
    length: 2.2,
    loop: 'once',
    note: 'anticipation dip, heavy lid swing with hinge recoil, then the frame settles',
    build: () => {
      const L = 2.2;
      const n = S(L, 20);
      return [
        ...track(LID, 'rotation', L, n, (t) => [lidSwing(t, -106, 0.16, 0.6, 0.82), 0, breath(t, 0.5, 0.4)]),
        ...track(LIDM, 'rotation', L, n, (t) => [pulse(t, 0.5, 0.78) * 2.2, 0, 0]),
        ...track(LIDF, 'rotation', L, n, (t) => [pulse(t, 0.55, 0.85) * 1.6, 0, 0]),
        ...track(LIDD, 'rotation', L, n, (t) => [pulse(t, 0.6, 0.95) * 3.0, 0, pulse(t, 0.65, 1.0) * 2.0]),
        ...track(LIDS, 'position', L, n, (t) => [0, pulse(t, 0.62, 0.95) * 0.18, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -easeInOut(seg(t, 0, 0.18)) * 0.3 + pulse(t, 0.4, 0.75) * 0.28, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 - pulse(t, 0.38, 0.72) * 0.032, 1]),
        ...track(LOCK, 'rotation', L, n, (t) => [pulse(t, 0.35, 0.7) * 2.2, 0, -18 * easeOutQuad(seg(t, 0.3, 0.62))]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.45, 0.95) * 0.4),
        ...track(CORE, 'scale', L, n, (t) => 1 + gate(t, 0.35, 0.85) * 0.2),
        ...track(CORE, 'rotation', L, n, (t) => [0, -gate(t, 0.3, 1) * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [0, -gate(t, 0.4, 1) * 360, 0], 'linear'),
        ...track(CRY_L, 'rotation', L, n, (t) => [pulse(t, 0.55, 1.0) * 3.5, 0, -pulse(t, 0.5, 1.0) * 6]),
        ...track(CRY_R, 'rotation', L, n, (t) => [pulse(t, 0.55, 1.0) * 3.5, 0, pulse(t, 0.5, 1.0) * 6]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-pulse(t, 0.6, 1.0) * 4.5, 0, 0]),
        ...track(ENERGY, 'position', L, n, (t) => [0, pulse(t, 0.6, 1.0) * 0.9, 0]),
        ...track(POSTS, 'position', L, n, (t) => [0, pulse(t, 0.42, 0.8) * 0.24, 0]),
      ];
    },
  },

  /* ---------------------------------------------------------- 9 open_magic */
  {
    name: 'open_magic',
    length: 2.8,
    loop: 'once',
    note: 'the open beat plus a full magical bring-up: core spin, halo churn, conduits flaring outward',
    build: () => {
      const L = 2.8;
      const n = S(L, 18);
      return [
        ...track(LID, 'rotation', L, n, (t) => [lidSwing(t, -112, 0.14, 0.56, 0.78), 0, breath(t, 0.5, 0.5)]),
        ...track(LIDD, 'rotation', L, n, (t) => [pulse(t, 0.58, 0.95) * 3.4, 0, pulse(t, 0.62, 1.0) * 2.4]),
        ...track(LIDS, 'position', L, n, (t) => [0, pulse(t, 0.6, 0.95) * 0.22, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -easeInOut(seg(t, 0, 0.16)) * 0.34 + pulse(t, 0.38, 0.72) * 0.32, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 - pulse(t, 0.36, 0.7) * 0.034, 1]),
        ...track(LOCK, 'rotation', L, n, (t) => [pulse(t, 0.3, 0.66) * 2.6, 0, -20 * easeOutQuad(seg(t, 0.26, 0.58))]),
        ...track(LOCKG, 'scale', L, n, (t) => flare(t, 0.3, 1, 1.9, 1.25)),
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, 0.4 * easeOutQuad(seg(t, 0.24, 0.52))]),
        ...track(CORE, 'scale', L, n, (t) => flare(t, 0.3, 0.92, 1.5, 1.22)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(CORE, 'position', L, n, (t) => [0, gate(t, 0.4, 0.9) * 0.5, 0]),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.2) * 10, -t * 720, 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => [1, 1 + swell(t, 0.35) * 0.24, 1]),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + swell(t, 0.15) * 0.5),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.45, 0.55), 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.55, 3.2), 0, -5 - breath(t, 0.55, 3.6)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.55, 3.2), 0, 5 + breath(t, 0.55, 3.6)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [breath(t, 0.6, 3.0), 0, breath(t, 0.4, 2.0)]),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + swell(t, 0.5) * 0.2),
        ...track(FF, 'position', L, n, (t) => [0, 0, swell(t, 0.2) * 0.25]),
        ...track(BF, 'position', L, n, (t) => [0, 0, -swell(t, 0.2) * 0.25]),
        ...track(ROOT, 'position', L, n, (t) => [0, swell(t, 0.45) * 0.22, 0]),
      ];
    },
  },

  /* ----------------------------------------------------- 10 open_legendary */
  {
    name: 'open_legendary',
    length: 4.2,
    loop: 'once',
    note: 'settle -> anticipation -> vibration -> lock -> lid -> energy burst -> proud hold',
    build: () => {
      const L = 4.2;
      const n = S(L, 18);
      const T = {
        settle: 0.1,
        antic: 0.3,
        vib: 0.46,
        lockAct: 0.6,
        lidOpen: 0.82,
        burst: 0.92,
        resolve: 1.0,
      };
      /** Stage progress helper so the sequence reads as one causal chain. */
      const st = (t, a, b) => easeInOut(seg(t, T[a], T[b]));
      return [
        // 1 settle: a single quiet breath so the sequence starts still
        ...track(BODY, 'position', L, n, (t) => [0, breath(t * (L / 2.4), 0, 0.08) * (1 - T.antic > 0 ? 1 - seg(t, 0, T.antic) : 0), 0]),
        // 2 anticipation: the crate gathers itself, lid presses, lock draws back
        ...track(ROOT, 'position', L, n, (t) => [
          rattle(t, T.antic, T.lidOpen, 7, 0.7, 0.8),
          0,
          rattle(t, T.antic, T.lidOpen, 6, 0.5, 0.8),
        ]),
        ...track(ROOT, 'rotation', L, n, (t) => [
          -lerp(0, 3.2, easeOutQuad(seg(t, 0, T.antic))) + rattle(t, T.antic, T.lidOpen, 8, 1.4, 0.7) + gate(t, T.lidOpen, T.resolve) * 1.6,
          breath(t * (L / 2.4), 0.2, 3.4) * (1 - seg(t, 0, T.antic)),
          rattle(t, T.antic, T.lidOpen, 7, 1.0, 0.8),
        ]),
        // 3 vibration: the whole shell buzzes, decoration lags
        ...track(BODY, 'position', L, n, (t) => [
          0,
          -easeInOut(seg(t, 0, T.antic)) * 0.45 + rattle(t, T.antic, T.burst, 16, 0.22, 0.6) + gate(t, T.lidOpen, T.resolve) * 0.3,
          0,
        ]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 - pulse(t, T.lidOpen, T.burst) * 0.04, 1]),
        // 4 lock activation
        ...track(LOCK, 'rotation', L, n, (t) => [
          rattle(t, T.vib, T.lockAct, 12, 1.2, 1),
          0,
          lerp(0, -24, easeOutBack(seg(t, T.lockAct, T.lidOpen))) + lerp(-24, -18, easeInOut(seg(t, T.burst, T.resolve))),
        ]),
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, lerp(0, 0.45, easeOutQuad(seg(t, T.vib, T.lockAct)))]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, T.vib, T.burst) * 0.9 + gate(t, T.burst, T.resolve) * 0.2),
        // 5 lid opens with weight, and the lid's own sub-groups lag behind it
        ...track(LID, 'rotation', L, n, (t) => [lidSwing(t, -108, T.antic, T.lidOpen, T.burst), 0, rattle(t, T.burst, T.resolve, 6, 0.6, 1)]),
        ...track(LIDM, 'rotation', L, n, (t) => [pulse(t, T.lidOpen, T.burst) * 2.6, 0, 0]),
        ...track(LIDF, 'rotation', L, n, (t) => [pulse(t, T.lidOpen + 0.02, T.burst) * 2.0, 0, 0]),
        ...track(LIDD, 'rotation', L, n, (t) => [pulse(t, T.lidOpen + 0.04, T.resolve) * 3.6, 0, pulse(t, T.lidOpen + 0.06, T.resolve) * 2.6]),
        ...track(LIDS, 'position', L, n, (t) => [0, pulse(t, T.lidOpen + 0.05, T.resolve) * 0.24, 0]),
        // 6 energy burst, then settle into a proud hold
        ...track(CORE, 'scale', L, n, (t) => flare(t, T.lidOpen, T.burst, 1.85, 1.3)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(CORE, 'position', L, n, (t) => [0, gate(t, T.burst, T.resolve) * 1.1, 0]),
        // halos sit still until the lock fires, then wind up to three whole turns
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 1080 * gate(t, T.lockAct, T.burst), 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => 1 + pulse(t, T.burst, T.resolve) * 0.22),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + pulse(t, T.lidOpen, T.burst) * 0.7 + gate(t, T.burst, T.resolve) * 0.25),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, pulse(t, T.burst, T.resolve) * 1.4 + breath(t * (L / 2.4), 0.5, 0.3) * seg(t, T.resolve, 1) * 0, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [pulse(t, T.burst, T.resolve) * 5, 0, -lerp(0, 7, easeOutBack(seg(t, T.lidOpen, T.burst))) - breath(t * (L / 3.2), 0.3, 2.4)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [pulse(t, T.burst, T.resolve) * 5, 0, lerp(0, 7, easeOutBack(seg(t, T.lidOpen, T.burst))) + breath(t * (L / 3.2), 0.3, 2.4)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-pulse(t, T.burst, T.resolve) * 6, 0, breath(t * (L / 3.2), 0.4, 1.6)]),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + pulse(t, T.burst, T.resolve) * 0.18),
        ...track(POSTS, 'position', L, n, (t) => [0, pulse(t, T.lidOpen, T.burst) * 0.16, 0]),
        ...track(FF, 'position', L, n, (t) => [0, 0, pulse(t, T.burst, T.resolve) * 0.3]),
        ...track(BF, 'position', L, n, (t) => [0, 0, -pulse(t, T.burst, T.resolve) * 0.3]),
      ];
    },
  },

  /* --------------------------------------------------------------- 11 close */
  {
    name: 'close',
    length: 2.0,
    loop: 'once',
    note: 'a short lift before the drop, a heavy fall, one bounce, and the body absorbing it',
    build: () => {
      const L = 2.0;
      const n = S(L, 20);
      const fall = (t) => {
        if (t < 0.14) return lerp(-106, -114, easeOutQuad(seg(t, 0, 0.14)));
        if (t < 0.5) return lerp(-114, 2.4, easeInCubic(seg(t, 0.14, 0.5)));
        if (t < 0.66) return lerp(2.4, -1.4, easeOutBounce(seg(t, 0.5, 0.66)));
        if (t < 0.8) return lerp(-1.4, 0.5, easeInOut(seg(t, 0.66, 0.8)));
        return lerp(0.5, 0, easeInOut(seg(t, 0.8, 1)));
      };
      return [
        ...track(LID, 'rotation', L, n, (t) => [fall(t), 0, rattle(t, 0.5, 0.85, 7, 0.5, 1)]),
        ...track(LIDM, 'rotation', L, n, (t) => [-pulse(t, 0.48, 0.72) * 2.6, 0, 0]),
        ...track(LIDD, 'rotation', L, n, (t) => [-pulse(t, 0.52, 0.82) * 3.4, 0, -pulse(t, 0.56, 0.9) * 2.2]),
        ...track(LIDS, 'position', L, n, (t) => [0, -pulse(t, 0.52, 0.86) * 0.26, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -pulse(t, 0.48, 0.78) * 0.4, 0]),
        // squash on impact: widen as it flattens, so the crate reads as heavy
        ...track(BODY, 'scale', L, n, (t) => [1 + pulse(t, 0.48, 0.78) * 0.028, 1 - pulse(t, 0.48, 0.78) * 0.042, 1 + pulse(t, 0.48, 0.78) * 0.028]),
        ...track(ROOT, 'position', L, n, (t) => [0, -pulse(t, 0.5, 0.8) * 0.24, 0]),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, lerp(-18, 0, easeOutQuad(seg(t, 0, 0.2))) + pulse(t, 0.52, 0.8) * 2.4]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0, 0.3) * 0.35 - pulse(t, 0.55, 1.0) * 0.15),
        ...track(CORE, 'scale', L, n, (t) => lerp(1.2, 0.88, easeInOut(seg(t, 0, 0.55))) + pulse(t, 0.5, 0.9) * 0.1),
        ...track(HALO, 'rotation', L, n, (t) => [0, -lerp(240, 0, easeOutCubic(seg(t, 0, 0.8))), 0], 'linear'),
        ...track(CRY_L, 'rotation', L, n, (t) => [pulse(t, 0.58, 1.0) * 4, 0, -6 + pulse(t, 0.55, 1.0) * 5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [pulse(t, 0.58, 1.0) * 4, 0, 6 - pulse(t, 0.55, 1.0) * 5]),
        ...track(CRY_T, 'rotation', L, n, (t) => [pulse(t, 0.6, 1.0) * 5, 0, 0]),
        ...track(ENERGY, 'position', L, n, (t) => [0, -pulse(t, 0.56, 1.0) * 0.6, 0]),
        ...track(ENERGY, 'scale', L, n, (t) => lerp(1.25, 1, easeInOut(seg(t, 0, 0.7))) - pulse(t, 0.56, 1.0) * 0.1),
        ...track(POSTS, 'position', L, n, (t) => [0, -pulse(t, 0.5, 0.8) * 0.24, 0]),
      ];
    },
  },

  /* --------------------------------------------------------- 12 close_magic */
  {
    name: 'close_magic',
    length: 2.4,
    loop: 'once',
    note: 'close plus a controlled drain: the core winds down and the conduits lose their filament',
    build: () => {
      const L = 2.4;
      const n = S(L, 18);
      const fall = (t) => {
        if (t < 0.12) return lerp(-112, -120, easeOutQuad(seg(t, 0, 0.12)));
        if (t < 0.46) return lerp(-120, 2.0, easeInCubic(seg(t, 0.12, 0.46)));
        if (t < 0.62) return lerp(2.0, -1.2, easeOutBounce(seg(t, 0.46, 0.62)));
        return lerp(-1.2, 0, easeInOut(seg(t, 0.62, 0.85)));
      };
      return [
        ...track(LID, 'rotation', L, n, (t) => [fall(t), 0, rattle(t, 0.46, 0.8, 7, 0.5, 1)]),
        ...track(LIDD, 'rotation', L, n, (t) => [-pulse(t, 0.48, 0.8) * 3.6, 0, -pulse(t, 0.52, 0.88) * 2.4]),
        ...track(LIDS, 'position', L, n, (t) => [0, -pulse(t, 0.48, 0.82) * 0.28, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -pulse(t, 0.44, 0.74) * 0.42, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1 + pulse(t, 0.44, 0.74) * 0.034, 1 - pulse(t, 0.44, 0.74) * 0.05, 1 + pulse(t, 0.44, 0.74) * 0.034]),
        ...track(ROOT, 'position', L, n, (t) => [0, -pulse(t, 0.46, 0.78) * 0.26, 0]),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, lerp(-20, 0, easeOutQuad(seg(t, 0, 0.18))) + pulse(t, 0.5, 0.78) * 2.2]),
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, lerp(0.4, 0, easeInOut(seg(t, 0.55, 0.9)))]),
        ...track(LOCKG, 'scale', L, n, (t) => flare(t, 0, 0.35, 1.5, 1) * (1 - pulse(t, 0.55, 1.0) * 0.15)),
        ...track(CORE, 'scale', L, n, (t) => drain(t, 0, 0.7, 0.9)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [0, -lerp(360, 0, easeOutCubic(seg(t, 0, 0.75))), 0], 'linear'),
        ...track(ENERGY, 'scale', L, n, (t) => [1, lerp(1.3, 0.72, easeInOut(seg(t, 0, 0.65))), 1]),
        ...track(ENERGY, 'position', L, n, (t) => [0, -pulse(t, 0.5, 1.0) * 0.7 - gate(t, 0.6, 1) * 0.3, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, 4 - lerp(0, 4, easeInOut(seg(t, 0, 0.7)))]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, -4 + lerp(0, 4, easeInOut(seg(t, 0, 0.7)))]),
        ...track(CRY_L, 'scale', L, n, (t) => lerp(1, 0.76, easeInOut(seg(t, 0.2, 0.8)))),
        ...track(CRY_R, 'scale', L, n, (t) => lerp(1, 0.76, easeInOut(seg(t, 0.2, 0.8)))),
        ...track(CRY_T, 'scale', L, n, (t) => lerp(1, 0.7, easeInOut(seg(t, 0.25, 0.85)))),
      ];
    },
  },

  /* ---------------------------------------------------------- 13 activation */
  {
    name: 'activation',
    length: 1.6,
    loop: 'once',
    note: 'power-up: spin ramps, conduits flare, shell buzzes, then everything eases back to rest',
    build: () => {
      const L = 1.6;
      const n = S(L, 22);
      // Ramps up and then decelerates onto a whole turn, so the clip releases cleanly
      // back to rest instead of holding a 72-degree offset.
      const spin = (t) => -easeInOutCubic(seg(t, 0.1, 0.8));
      return [
        ...track(CORE, 'scale', L, n, (t) => 1 + pulse(t, 0.05, 0.9) * 0.6),
        ...track(CORE, 'rotation', L, n, (t) => [0, spin(t) * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [0, spin(t) * 720, 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => 1 + pulse(t, 0.2, 0.95) * 0.3),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + pulse(t, 0.12, 0.95) * 0.65),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, spin(t) * 360, 0], 'linear'),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.15, 0.9) * 0.8),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, rattle(t, 0.15, 0.85, 11, 2.4, 1)]),
        ...track(ROOT, 'position', L, n, (t) => [rattle(t, 0.12, 0.9, 10, 0.4), 0, rattle(t, 0.14, 0.9, 9, 0.3)]),
        ...track(ROOT, 'rotation', L, n, (t) => [0, 0, rattle(t, 0.16, 0.9, 8, 1.0)]),
        ...track(LID, 'rotation', L, n, (t) => [-pulse(t, 0.12, 0.95) * 4.0, 0, rattle(t, 0.2, 0.9, 12, 0.9)]),
        ...track(LIDD, 'rotation', L, n, (t) => [-pulse(t, 0.2, 1.0) * 3.0, 0, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -pulse(t, 0.25, 1.0) * 8]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, pulse(t, 0.25, 1.0) * 8]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-pulse(t, 0.3, 1.0) * 7, 0, 0]),
        ...track(CRY_L, 'scale', L, n, (t) => 1 + pulse(t, 0.28, 1.0) * 0.22),
        ...track(CRY_R, 'scale', L, n, (t) => 1 + pulse(t, 0.28, 1.0) * 0.22),
        ...track(BODY, 'position', L, n, (t) => [0, pulse(t, 0.2, 0.95) * 0.28, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 + pulse(t, 0.5, 1.0) * 0.028, 1]),
      ];
    },
  },

  /* ------------------------------------------------------- 14 reward_reveal */
  {
    name: 'reward_reveal',
    length: 3.0,
    loop: 'once',
    note: 'the core rises clear of the crate and the crystals spread: the crate presenting its prize',
    build: () => {
      const L = 3.0;
      const n = S(L, 18);
      return [
        ...track(LID, 'rotation', L, n, (t) => [lidSwing(t, -114, 0.1, 0.42, 0.62), 0, breath(t, 0.5, 0.4)]),
        ...track(LIDD, 'rotation', L, n, (t) => [pulse(t, 0.44, 0.9) * 3.2, 0, pulse(t, 0.5, 0.95) * 2.2]),
        ...track(BODY, 'position', L, n, (t) => [0, -easeInOut(seg(t, 0, 0.12)) * 0.4 + gate(t, 0.4, 0.8) * 0.34, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 - pulse(t, 0.3, 0.62) * 0.032, 1]),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, -22 * easeOutBack(seg(t, 0.18, 0.5))]),
        ...track(LOCKG, 'scale', L, n, (t) => flare(t, 0.2, 1, 1.8, 1.3)),
        ...track(CORE, 'position', L, n, (t) => [0, gate(t, 0.42, 0.92) * 4.4, 0]),
        ...track(CORE, 'scale', L, n, (t) => flare(t, 0.36, 0.95, 1.55, 1.35)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.3) * 16, -t * 720, 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => 1 + gate(t, 0.4, 0.9) * 0.4),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, gate(t, 0.45, 0.95) * 1.2 + breath(t, 0.5, 0.3), 0]),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + gate(t, 0.35, 0.9) * 0.4),
        ...track(CRY_L, 'rotation', L, n, (t) => [pulse(t, 0.4, 0.95) * 4, 0, -gate(t, 0.4, 0.9) * 14 - breath(t, 0.3, 2.0)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [pulse(t, 0.4, 0.95) * 4, 0, gate(t, 0.4, 0.9) * 14 + breath(t, 0.3, 2.0)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-gate(t, 0.4, 0.9) * 10, 0, breath(t, 0.4, 1.4)]),
        ...track(CRY_L, 'scale', L, n, (t) => 1 + gate(t, 0.4, 0.9) * 0.2),
        ...track(CRY_R, 'scale', L, n, (t) => 1 + gate(t, 0.4, 0.9) * 0.2),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + gate(t, 0.45, 0.95) * 0.24),
        ...track(ROOT, 'position', L, n, (t) => [0, gate(t, 0.5, 1.0) * 0.4, 0]),
      ];
    },
  },

  /* -------------------------------------------------------- 15 reward_burst */
  {
    name: 'reward_burst',
    length: 1.8,
    loop: 'once',
    note: 'a two-beat climax — snap open, then a shaped burst that eases back rather than ending chaotic',
    build: () => {
      const L = 1.8;
      const n = S(L, 24);
      // three clean phases: snap (0-0.3), burst (0.3-0.6), settle (0.6-1)
      return [
        ...track(LID, 'rotation', L, n, (t) => [t < 0.3 ? lerp(0, -104, easeOutBack(seg(t, 0, 0.3), 2.4)) : t < 0.62 ? lerp(-104, -112, easeOutQuad(seg(t, 0.3, 0.62))) : lerp(-112, -106, easeInOut(seg(t, 0.62, 1))), 0, pulse(t, 0.3, 0.7) * 1.2]),
        ...track(LIDD, 'rotation', L, n, (t) => [pulse(t, 0.32, 0.72) * 5.0, 0, pulse(t, 0.36, 0.8) * 3.0]),
        ...track(LIDS, 'position', L, n, (t) => [0, pulse(t, 0.34, 0.76) * 0.32, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -pulse(t, 0.3, 0.6) * 0.34, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1 + pulse(t, 0.28, 0.6) * 0.034, 1 - pulse(t, 0.28, 0.6) * 0.055, 1 + pulse(t, 0.28, 0.6) * 0.034]),
        ...track(ROOT, 'position', L, n, (t) => [0, pulse(t, 0.3, 0.68) * 0.5, 0]),
        ...track(ROOT, 'rotation', L, n, (t) => [0, 0, rattle(t, 0.28, 0.72, 6, 1.6, 1)]),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, -22 * easeOutBack(seg(t, 0, 0.28))]),
        ...track(LOCKG, 'scale', L, n, (t) => flare(t, 0, 0.5, 2.2, 1.35)),
        ...track(CORE, 'scale', L, n, (t) => flare(t, 0.22, 0.6, 2.1, 1.4)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(CORE, 'position', L, n, (t) => [0, gate(t, 0.4, 0.85) * 1.6, 0]),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.2) * 24, -t * 1080, 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => 1 + pulse(t, 0.35, 0.85) * 0.5),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + pulse(t, 0.3, 0.75) * 0.85),
        // nodes fly out and are pulled back — the burst, but shaped
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, pulse(t, 0.32, 0.8) * 2.4, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [pulse(t, 0.34, 0.8) * 7, 0, -pulse(t, 0.3, 0.78) * 16]),
        ...track(CRY_R, 'rotation', L, n, (t) => [pulse(t, 0.34, 0.8) * 7, 0, pulse(t, 0.3, 0.78) * 16]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-pulse(t, 0.36, 0.82) * 12, 0, 0]),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + pulse(t, 0.34, 0.8) * 0.24),
        ...track(POSTS, 'position', L, n, (t) => [0, pulse(t, 0.3, 0.7) * 0.2, 0]),
      ];
    },
  },

  /* --------------------------------------------------------------- 16 pulse */
  {
    name: 'pulse',
    length: 1.4,
    loop: 'loop',
    note: 'one beat travelling outward: shell, then lock, then crystals, then the core brightest last',
    build: () => {
      const L = 1.4;
      const n = S(L, 16);
      return [
        ...track(ROOT, 'scale', L, n, (t) => 1 + swell(t, 0) * 0.03),
        ...track(ROOT, 'position', L, n, (t) => [0, swell(t, 0) * 0.2, 0]),
        ...track(LOCK, 'scale', L, n, (t) => 1 + swell(t, 0.08) * 0.16),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + swell(t, 0.1) * 0.4),
        ...track(CRY_L, 'scale', L, n, (t) => 1 + swell(t, 0.18) * 0.22),
        ...track(CRY_R, 'scale', L, n, (t) => 1 + swell(t, 0.18) * 0.22),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + swell(t, 0.18) * 0.22),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -swell(t, 0.18) * 5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, swell(t, 0.18) * 5]),
        ...track(CORE, 'scale', L, n, (t) => 1 + swell(t, 0.24) * 0.34),
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + swell(t, 0.3) * 0.4),
        ...track(ENERGY, 'position', L, n, (t) => [0, swell(t, 0.34) * 0.5, 0]),
        ...track(LID, 'rotation', L, n, (t) => [-swell(t, 0.14) * 1.8, 0, 0]),
      ];
    },
  },

  /* --------------------------------------------------------- 17 celebration */
  {
    name: 'celebration',
    length: 3.4,
    loop: 'loop',
    note: 'two hops with squash on landing; the lid flaps on its own beat and the crystals ring after',
    build: () => {
      const L = 3.4;
      const n = S(L, 20);
      /** Two hops: rise, fall, squash, recover. */
      const hop = (t) => {
        const phase = (t * 2) % 1;
        return phase < 0.45 ? lerp(0, 2.0, easeOutQuad(phase / 0.45)) : lerp(2.0, 0, easeInQuad((phase - 0.45) / 0.55));
      };
      const squash = (t) => {
        const phase = (t * 2) % 1;
        return phase < 0.45 ? 0 : pulse(phase, 0.45, 1) * 0.9;
      };
      return [
        ...track(ROOT, 'position', L, n, (t) => [0, hop(t), 0]),
        ...track(ROOT, 'rotation', L, n, (t) => [0, breath(t, 0.1, 7), breath(t, 0.05, 2.4)]),
        ...track(BODY, 'scale', L, n, (t) => [1 + squash(t) * 0.02, 1 - squash(t) * 0.035, 1 + squash(t) * 0.02]),
        ...track(BOTTOM, 'position', L, n, (t) => [0, -squash(t) * 0.3, 0]),
        ...track(LID, 'rotation', L, n, (t) => [-8 + breath(t, 0.22, 8) - squash(t) * 5, 0, breath(t, 0.18, 1.6)]),
        ...track(LIDD, 'rotation', L, n, (t) => [breath(t, 0.3, 4.5), 0, breath(t, 0.26, 2.5)]),
        ...track(LIDS, 'position', L, n, (t) => [0, breath(t, 0.28, 0.2), 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.34, 4.0) - squash(t) * 4, 0, -7 + breath(t, 0.34, 6)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.34, 4.0) - squash(t) * 4, 0, 7 - breath(t, 0.34, 6)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-5 + breath(t, 0.42, 5.0), 0, breath(t, 0.3, 3.0)]),
        ...track(CRY_T, 'scale', L, n, (t) => 1 + swell(t, 0.36) * 0.14),
        ...track(CORE, 'scale', L, n, (t) => 1.15 + swell(t, 0.4) * 0.3),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.3) * 18, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.46, 0.55) + squash(t) * 0.4, 0]),
        ...track(ENERGY, 'scale', L, n, (t) => [1 + swell(t, 0.44) * 0.35, 1 + swell(t, 0.5) * 0.25, 1 + swell(t, 0.44) * 0.35]),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, -22 + breath(t, 0.5, 2.5)]),
        ...track(LOCKG, 'scale', L, n, (t) => 1.25 + swell(t, 0.52) * 0.3),
      ];
    },
  },

  /* ------------------------------------------------------------ 18 shutdown */
  {
    name: 'shutdown',
    length: 2.2,
    loop: 'once',
    note: 'power-down: a stuttering fade, the core collapsing, the shards dropping, the lid sagging',
    build: () => {
      const L = 2.2;
      const n = S(L, 20);
      return [
        ...track(CORE, 'scale', L, n, (t) => drain(t, 0.05, 0.85, 0.12)),
        ...track(CORE, 'rotation', L, n, (t) => [0, -lerp(0, 360, easeOutCubic(seg(t, 0, 0.9))), 0], 'linear'),
        ...track(CORE, 'position', L, n, (t) => [0, -gate(t, 0.5, 1) * 0.6, 0]),
        ...track(HALO, 'rotation', L, n, (t) => [0, -lerp(260, 0, easeOutCubic(seg(t, 0, 0.8))), 0], 'linear'),
        ...track(HALO, 'scale', L, n, (t) => 1 - gate(t, 0.3, 0.9) * 0.25),
        ...track(ENERGY, 'scale', L, n, (t) => 1 - gate(t, 0.25, 0.9) * 0.55),
        ...track(ENERGY, 'position', L, n, (t) => [0, -gate(t, 0.4, 1) * 1.7 + rattle(t, 0.1, 0.5, 12, 0.12, 1), 0]),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -lerp(0, 360, easeOutCubic(seg(t, 0, 0.9))), 0], 'linear'),
        ...track(CRY_L, 'scale', L, n, (t) => 1 - gate(t, 0.3, 0.95) * 0.45),
        ...track(CRY_R, 'scale', L, n, (t) => 1 - gate(t, 0.3, 0.95) * 0.45),
        ...track(CRY_T, 'scale', L, n, (t) => 1 - gate(t, 0.35, 0.95) * 0.5),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, gate(t, 0.3, 1) * 5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, -gate(t, 0.3, 1) * 5]),
        ...track(CRY_T, 'rotation', L, n, (t) => [gate(t, 0.35, 1) * 6, 0, 0]),
        ...track(LOCKG, 'scale', L, n, (t) => 1.3 - gate(t, 0.1, 0.8) * 0.95),
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, gate(t, 0.5, 0.95) * 6]),
        ...track(LID, 'rotation', L, n, (t) => [gate(t, 0.5, 1) * 1.8, 0, 0]),
        ...track(ROOT, 'position', L, n, (t) => [0, -gate(t, 0.35, 1) * 0.35, 0]),
        // the shell settles as the power drains out of it
        ...track(BODY, 'scale', L, n, (t) => [1, 1 - gate(t, 0.5, 1) * 0.03, 1]),
      ];
    },
  },

  /* ------------------------------------------------------- 19 float_rotate */
  {
    name: 'float_rotate',
    length: 3.6,
    loop: 'loop',
    note: 'showcase turntable: a clean continuous spin with the crate still breathing on top of it',
    build: () => {
      const L = 3.6;
      const n = S(L, 20);
      return [
        ...track(ROOT, 'rotation', L, n, (t) => [breath(t, 0.1, 0.8), t * 360, breath(t, 0.05, 0.6)], 'linear'),
        ...track(ROOT, 'position', L, n, (t) => [0, 0.7 + swell(t / 1, 0.3) * 0.8, 0]),
        ...track(LID, 'rotation', L, n, (t) => [breath(t, 0.2, 1.2), 0, breath(t, 0.3, 0.7)]),
        ...track(LIDD, 'rotation', L, n, (t) => [breath(t, 0.28, 0.9), 0, 0]),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.3, 2.4), 0, -2 - breath(t, 0.3, 3.0)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.3, 2.4), 0, 2 + breath(t, 0.3, 3.0)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [breath(t, 0.4, 2.8), 0, breath(t, 0.25, 1.8)]),
        ...track(CORE, 'scale', L, n, (t) => 1 + swell(t, 0.35) * 0.18),
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, breath(t, 0.5, 0.4), 0]),
        ...track(BOTTOM, 'position', L, n, (t) => [0, -breath(t, 0.24, 0.25), 0]),
      ];
    },
  },

  /* -------------------------------------------------------------- 20 beacon */
  {
    name: 'beacon',
    length: 2.8,
    loop: 'loop',
    note: 'the core stretches into a column and the halos wind up around it — a beacon, not a wobble',
    build: () => {
      const L = 2.8;
      const n = S(L, 16);
      return [
        ...track(CORE, 'scale', L, n, (t) => [1 + swell(t, 0.1) * 0.12, 1 + swell(t, 0.1) * 0.75, 1 + swell(t, 0.1) * 0.12]),
        ...track(CORE, 'position', L, n, (t) => [0, swell(t, 0.1) * 2.6, 0]),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(HALO, 'rotation', L, n, (t) => [0, -t * 720, 0], 'linear'),
        ...track(HALO, 'position', L, n, (t) => [0, swell(t, 0.25) * 1.2, 0]),
        ...track(HALO, 'scale', L, n, (t) => [1 + swell(t, 0.2) * 0.3, 1, 1 + swell(t, 0.2) * 0.3]),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, swell(t, 0.4) * 0.9, 0]),
        ...track(ENERGY, 'scale', L, n, (t) => 1 + swell(t, 0.35) * 0.45),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -6 - swell(t, 0.3) * 5]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, 6 + swell(t, 0.3) * 5]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-swell(t, 0.35) * 8, 0, 0]),
        ...track(CRY_T, 'scale', L, n, (t) => [1, 1 + swell(t, 0.4) * 0.2, 1]),
        ...track(LOCKG, 'scale', L, n, (t) => 1.2 + swell(t, 0.45) * 0.35),
        ...track(LID, 'rotation', L, n, (t) => [2.2 - swell(t, 0.2) * 1.4, 0, 0]),
        ...track(BODY, 'scale', L, n, (t) => [1, 1 + swell(t, 0.5) * 0.03, 1]),
      ];
    },
  },

  /* ---------------------------------------------------------------- 21 deny */
  {
    name: 'deny',
    length: 1.4,
    loop: 'once',
    note: 'the lock refuses: a hard rejecting shake, the mechanism jams in, and the glow drops out',
    build: () => {
      const L = 1.4;
      const n = S(L, 22);
      return [
        // Twists hard, jams, then releases back to rest so `deny` can be replayed.
        ...track(LOCK, 'rotation', L, n, (t) => [0, 0, -14 * pulse(t, 0, 0.85) + rattle(t, 0.14, 0.8, 16, 9, 1.1)]),
        ...track(LOCKC, 'position', L, n, (t) => [0, 0, 0.5 * pulse(t, 0, 0.9)]),
        ...track(LOCKF, 'position', L, n, (t) => [0, 0, pulse(t, 0.2, 0.8) * 0.16]),
        ...track(LOCKG, 'scale', L, n, (t) => 1 + pulse(t, 0.02, 0.4) * 0.5 - gate(t, 0.4, 0.8) * 0.65),
        ...track(ROOT, 'rotation', L, n, (t) => [0, 0, rattle(t, 0.24, 0.9, 12, 2.6, 1)]),
        ...track(ROOT, 'position', L, n, (t) => [rattle(t, 0.26, 0.9, 14, 0.35), 0, 0]),
        ...track(BODY, 'position', L, n, (t) => [0, -pulse(t, 0.18, 0.7) * 0.25, 0]),
        ...track(LID, 'rotation', L, n, (t) => [rattle(t, 0.3, 0.95, 14, 1.6, 1), 0, rattle(t, 0.32, 0.95, 12, 1.2)]),
        ...track(CRY_L, 'rotation', L, n, (t) => [0, 0, -rattle(t, 0.34, 0.95, 16, 3.0)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [0, 0, rattle(t, 0.34, 0.95, 16, 3.0)]),
        ...track(CORE, 'scale', L, n, (t) => 1 + pulse(t, 0.05, 0.35) * 0.1 - gate(t, 0.4, 0.85) * 0.35),
        ...track(HALO, 'rotation', L, n, (t) => [0, -lerp(0, 360, easeOutCubic(seg(t, 0.1, 0.9))), 0], 'linear'),
        ...track(ENERGY, 'scale', L, n, (t) => 1 - gate(t, 0.35, 0.9) * 0.3),
      ];
    },
  },

  /* ----------------------------------------------------------- 22 open_idle */
  {
    name: 'open_idle',
    length: 2.4,
    loop: 'loop',
    note: 'the resting state of an opened crate — what a server crate actually sits in',
    build: () => {
      const L = 2.4;
      const n = S(L, 12);
      return [
        // held open, with a slow wing-like drift instead of a static pose
        ...track(LID, 'rotation', L, n, (t) => [-106 + breath(t, 0.12, 1.4), breath(t, 0.22, 2.0), breath(t, 0.1, 0.6)]),
        ...track(LIDD, 'rotation', L, n, (t) => [breath(t, 0.2, 1.0), 0, breath(t, 0.16, 0.7)]),
        ...track(LIDS, 'position', L, n, (t) => [0, breath(t, 0.24, 0.18), 0]),
        ...track(BODY, 'position', L, n, (t) => [0, breath(t, 0.3, 0.18), 0]),
        ...track(LOCK, 'rotation', L, n, (t) => [breath(t, 0.26, 1.0), 0, -18 + breath(t, 0.34, 1.2)]),
        ...track(LOCKG, 'scale', L, n, (t) => 1.2 + swell(t, 0.4) * 0.2),
        ...track(CORE, 'scale', L, n, (t) => 1.22 + swell(t, 0.5) * 0.14),
        ...track(CORE, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(CORE, 'position', L, n, (t) => [0, 0.4 + breath(t, 0.45, 0.22), 0]),
        ...track(HALO, 'rotation', L, n, (t) => [swell(t, 0.15) * 8, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'rotation', L, n, (t) => [0, -t * 360, 0], 'linear'),
        ...track(ENERGY, 'position', L, n, (t) => [0, 0.6 + breath(t, 0.55, 0.32), 0]),
        ...track(ENERGY, 'scale', L, n, (t) => 1.1 + swell(t, 0.6) * 0.16),
        ...track(CRY_L, 'rotation', L, n, (t) => [breath(t, 0.4, 1.4), 0, -6 - breath(t, 0.4, 2.0)]),
        ...track(CRY_R, 'rotation', L, n, (t) => [breath(t, 0.4, 1.4), 0, 6 + breath(t, 0.4, 2.0)]),
        ...track(CRY_T, 'rotation', L, n, (t) => [-4 + breath(t, 0.5, 1.6), 0, breath(t, 0.35, 1.1)]),
        ...track(CRY_T, 'scale', L, n, (t) => 1.05 + swell(t, 0.55) * 0.2),
      ];
    },
  },
];

/** Animation length/loop metadata, for validation before anything is sent. */
export const ANIMATION_SUMMARY = ANIMATIONS.map((a) => ({
  name: a.name,
  length: a.length,
  loop: a.loop,
  note: a.note,
}));

/**
 * Guard rails, run before any keyframe reaches Blockbench: every track must name a real
 * bone, stay inside the clip, and use finite numbers. Cheap here, expensive to debug
 * after a partially applied bulk keyframe call.
 */
export function validateAnimations() {
  const known = new Set(BONE_NAMES);
  const problems = [];
  for (const anim of ANIMATIONS) {
    const keys = anim.build();
    if (!keys.length) problems.push(`${anim.name}: no keyframes`);
    const nodes = new Set();
    for (const k of keys) {
      nodes.add(k.node);
      if (!known.has(k.node)) problems.push(`${anim.name}: unknown bone "${k.node}"`);
      if (k.time < 0 || k.time > anim.length + 1e-6) problems.push(`${anim.name}: key at ${k.time} exceeds length ${anim.length}`);
      for (const axis of ['x', 'y', 'z']) {
        if (!Number.isFinite(k[axis])) problems.push(`${anim.name}/${k.node}.${axis}: not finite`);
      }
    }
    if (nodes.size < 2) problems.push(`${anim.name}: only animates ${nodes.size} bone(s) — needs layered motion`);
    // A clip must not leave a part displaced on a channel it never returns from.
    for (const node of nodes) {
      const chans = new Set(keys.filter((k) => k.node === node).map((k) => k.channel));
      for (const c of chans) {
        const series = keys.filter((k) => k.node === node && k.channel === c).sort((a, b) => a.time - b.time);
        const first = series[0];
        const last = series[series.length - 1];
        if (anim.loop === 'loop') {
          // A rotation channel that ends a whole number of turns away from where it
          // started is seamless (360 == 0); anything else snaps on loop.
          const wrap = (d) => {
            if (c !== 'rotation') return d;
            const r = Math.abs(d) % 360;
            return Math.min(r, 360 - r);
          };
          const drift = Math.max(wrap(first.x - last.x), wrap(first.y - last.y), wrap(first.z - last.z));
          if (drift > 0.75) problems.push(`${anim.name}: ${node}.${c} loops but starts ${drift.toFixed(2)} off its end value`);
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, total_keyframes: ANIMATIONS.reduce((s, a) => s + a.build().length, 0) };
}
