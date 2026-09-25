/**
 * Animation pass.
 *
 * The project declares nineteen animations but they contain **zero keyframes** — the
 * previous build created the names and then failed every `bulk_create_keyframes` call. So
 * there is nothing to "improve" yet: these nineteen are authored for the first time,
 * keeping their original names, lengths and loop modes, and the six that were never
 * created are added for 25 in total.
 *
 * Rotation signs, derived from the geometry rather than guessed (model faces +Z, Y up,
 * the model's LEFT is +X):
 *   +X on a bone swings whatever sits in front of its pivot DOWN. So the head lifts with
 *      -X on the neck, the jaw opens with +X on `lower_jaw`, and a tail bone — whose cube
 *      sits behind its pivot — lifts with +X.
 *   -X on a leg bone swings the limb forward; +X on `*_shin` bends the knee backwards.
 *   +Y turns toward the model's left.
 *
 * Quality comes from four things applied throughout: anticipation before a big move, a
 * held impact frame, follow-through afterwards, and a tail that propagates — every segment
 * lags the one in front of it and swings wider, so the tail reads as a chain rather than
 * seven bones rotating in lockstep.
 */

const TAIL = ['tail_01', 'tail_02', 'tail_03', 'tail_04', 'tail_05', 'tail_06', 'tail_07'];
const LEGS = ['left', 'right'];

/** The settled stance every one-shot starts and ends on. */
const REST = {
  left_shin: [5, 0, 0],
  right_shin: [5, 0, 0],
  left_foot: [-5, 0, 0],
  right_foot: [-5, 0, 0],
  left_lower_arm: [-18, 0, 0],
  right_lower_arm: [-18, 0, 0],
};

export function build(kf) {
  /* ---------------------------------------------------------------- helpers */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  /** Rising 0..1 then falling 0..1 across a normalised window. */
  const bump = (t, start, peak, end) => {
    if (t <= start || t >= end) return 0;
    return t < peak ? (t - start) / (peak - start) : 1 - (t - peak) / (end - peak);
  };
  /** 0 for a whole number of cycles — used to make loops seamless. */
  const wave = (t, cycles, phase = 0) => Math.sin(2 * Math.PI * (cycles * t + phase));

  const restOf = (overrides = {}) => ({ ...REST, ...overrides });

  /** Explicit poses: [time, rotations, positions?, interpolation?]. */
  function pose(entries) {
    const keys = [];
    for (const entry of entries) {
      const time = entry[0];
      let interp = 'catmullrom';
      const sheets = [];
      for (const item of entry.slice(1)) {
        if (typeof item === 'string') interp = item;
        else if (item && typeof item === 'object') sheets.push(item);
      }
      for (const [bone, v] of Object.entries(sheets[0] ?? {})) keys.push(kf(bone, 'rotation', time, v[0], v[1], v[2], interp));
      for (const [bone, v] of Object.entries(sheets[1] ?? {})) keys.push(kf(bone, 'position', time, v[0], v[1], v[2], interp));
    }
    return keys;
  }

  /** Sample a channel plan over an animation, one value per sample. */
  function sample(length, samples, plan, interp = 'catmullrom') {
    const keys = [];
    for (const entry of plan) {
      const channel = entry.channel ?? 'rotation';
      for (let s = 0; s <= samples; s += 1) {
        const t = s / samples;
        const v = entry.fn(t);
        if (v === null || v === undefined) continue;
        // A scalar is a uniform-channel value (scale), not a vector: 
        if (Array.isArray(v)) keys.push(kf(entry.node, channel, t * length, v[0], v[1], v[2], entry.interp ?? interp));
        else keys.push(kf(entry.node, channel, t * length, v, v, v, entry.interp ?? interp));
      }
    }
    return keys;
  }

  /**
   * Tail motion that propagates. Each segment lags the one in front by `lag` and its
   * swing grows by `grow`, so a wave travels down the tail instead of the whole tail
   * swinging as one rigid piece.
   */
  function tailCycle(length, samples, o = {}) {
    const { amp = 6, lift = 0, lag = 0.075, grow = 1.2, bob = 0.35, interp } = o;
    const keys = [];
    TAIL.forEach((bone, i) => {
      const swing = amp * grow ** i;
      const l = i * lag;
      const liftBase = lift * (1 + i * 0.14);
      for (let s = 0; s <= samples; s += 1) {
        const t = s / samples;
        const y = swing * Math.sin(2 * Math.PI * (t - l));
        const x = liftBase * (1 - bob + bob * Math.cos(2 * Math.PI * (2 * (t - l * 1.2))));
        keys.push(kf(bone, 'rotation', t * length, x, y, 0, interp));
      }
    });
    return keys;
  }

  /**
   * Tail poses for one-shots. Each segment is staggered so the motion travels down the
   * tail, and the staggered time is clamped to the last frame — otherwise a 3.95s death
   * carries tail keys out to 4.67s and Blockbench silently stretches the animation to
   * fit, which breaks the declared length and anything driving it.
   */
  function tailPose(frames, fn, interp) {
    const keys = [];
    const end = Math.max(...frames.map((frame) => frame[0]));
    TAIL.forEach((bone, i) => {
      for (const [time, offset = 0.03] of frames) {
        const [x, y, z] = fn(i, time, i * offset);
        keys.push(kf(bone, 'rotation', Math.min(end, time + i * offset), x, y, z, interp));
      }
    });
    return keys;
  }

  /**
   * Shared locomotion generator. Phase walks the leg cycle; the knee flexes only while
   * the foot is off the ground, the foot counter-rotates to stay near flat, and the toes
   * grip on push-off. Without those three the cycle reads as a wind-up toy.
   */
  function locomotion(o) {
    const { length, samples = 10, stride, knee, ankle, toe, bob, lean, roll, yaw = 0, headDrop, armSwing, tailAmp, tailLift } = o;
    const keys = [];

    // The trunk moves, and the legs hang off it — so the legs must cancel the trunk's
    // roll and yaw or their swing plane rotates with it. Without this the two legs swing
    // in different planes as the body rolls once per cycle, which reads as the animal
    // running diagonally (or lame) instead of straight ahead.
    const bodyPitch = (t) => lean + bob * 0.8 * Math.sin(4 * Math.PI * t);
    const bodyYaw = (t) => yaw * Math.sin(2 * Math.PI * t);
    const bodyRoll = (t) => roll * Math.sin(2 * Math.PI * t);

    for (const tag of LEGS) {
      const p = tag === 'left' ? 0 : 0.5;
      const thigh = (t) => -stride * Math.cos(2 * Math.PI * (t - p));
      const shin = (t) => 5 + knee * clamp(Math.sin(2 * Math.PI * (t - p - 0.12)) * 1.35, 0, 1);
      const foot = (t) => -3 - (thigh(t) + (shin(t) - 5)) * 0.45 + ankle * Math.sin(2 * Math.PI * (t - p + 0.18));
      const toes = (t) => -toe * Math.max(0, Math.sin(2 * Math.PI * (t - p + 0.3)));
      keys.push(...sample(length, samples, [
        { node: `${tag}_leg`, fn: (t) => [thigh(t), -bodyYaw(t), -bodyRoll(t)] },
        { node: `${tag}_shin`, fn: (t) => [shin(t), 0, 0] },
        { node: `${tag}_foot`, fn: (t) => [foot(t), 0, 0] },
        { node: `${tag}_toes`, fn: (t) => [toes(t), 0, 0] },
      ]));
    }
    keys.push(...sample(length, samples, [
      // Bob twice per stride (each footfall), roll and yaw once per cycle.
      { node: 'body', channel: 'position', fn: (t) => [0, bob * Math.cos(4 * Math.PI * t) - bob * 0.6, 0] },
      { node: 'body', fn: (t) => [bodyPitch(t), bodyYaw(t), bodyRoll(t)] },
      { node: 'chest', fn: (t) => [-1.5 * Math.sin(4 * Math.PI * t), -3.5 * Math.sin(2 * Math.PI * t), 0] },
      { node: 'neck_01', fn: (t) => [-1.6 * Math.sin(4 * Math.PI * (t + 0.1)), 2 * Math.sin(2 * Math.PI * (t + 0.15)), 0] },
      { node: 'neck_02', fn: (t) => [-1.2 * Math.sin(4 * Math.PI * (t + 0.18)), 1.6 * Math.sin(2 * Math.PI * (t + 0.22)), 0] },
      // The head counter-moves against the body so the gaze stays level.
      { node: 'head', fn: (t) => [headDrop - 1.4 * Math.sin(4 * Math.PI * t), -2.4 * Math.sin(2 * Math.PI * (t + 0.2)), 0] },
      { node: 'lower_jaw', fn: (t) => [2 + 1.5 * Math.sin(2 * Math.PI * t), 0, 0] },
      { node: 'left_arm', fn: (t) => [armSwing * Math.sin(2 * Math.PI * t), 0, 0] },
      { node: 'right_arm', fn: (t) => [-armSwing * Math.sin(2 * Math.PI * t), 0, 0] },
      { node: 'left_lower_arm', fn: (t) => [-18 + 5 * Math.sin(2 * Math.PI * (t - 0.15)), 0, 0] },
      { node: 'right_lower_arm', fn: (t) => [-18 - 5 * Math.sin(2 * Math.PI * (t - 0.15)), 0, 0] },
    ]));
    keys.push(...tailCycle(length, samples, { amp: tailAmp, lift: tailLift, lag: 0.07, grow: 1.18, bob: 0.5 }));
    return keys;
  }

  /** Head-led turn: the head goes first, the body follows, the tail trails. */
  function turn(direction, length) {
    const d = direction;
    const keys = pose([
      [0, restOf()],
      // Anticipation: the head looks the way it is about to go.
      [0.18, restOf({ head: [-2, 16 * d, 0], neck_03: [0, 7 * d, 0], neck_02: [0, 5 * d, 0], chest: [0, 3 * d, 0] })],
      [0.45, restOf({ head: [-3, 20 * d, 0], neck_03: [0, 10 * d, 0], neck_02: [0, 8 * d, 0], neck_01: [0, 5 * d, 0], chest: [0, 4 * d, 0], body: [0, 7 * d, 0], left_leg: [-8 * d, 0, 0], right_leg: [8 * d, 0, 0] })],
      // The pivot lands, then the weight settles over the new stance.
      [0.7, restOf({ head: [-2, 16 * d, 0], neck_03: [0, 8 * d, 0], neck_02: [0, 6 * d, 0], neck_01: [0, 4 * d, 0], chest: [0, 3 * d, 0], body: [0, 6 * d, 0], left_leg: [-5 * d, 0, 0], right_leg: [5 * d, 0, 0], left_toes: [-6 * d, 0, 0] })],
      [length, restOf({ head: [-2, 18 * d, 0], neck_03: [0, 9 * d, 0], neck_02: [0, 7 * d, 0], neck_01: [0, 4 * d, 0], chest: [0, 4 * d, 0], body: [0, 7 * d, 0] })],
    ]);
    keys.push(...tailPose([[0.18, 0.02], [0.45, 0.035], [0.7, 0.04], [length, 0.04]], (i, t) => [3, (10 + i * 3.5) * d * Math.min(1, t / 0.6), 0]));
    return keys;
  }

  /* ------------------------------------------------------- the animation set */

  const ANIMATIONS = [];

  /* idle — alive, not still: breathing, a slow head scan, a weight shift, a drifting tail */
  ANIMATIONS.push({
    name: 'idle',
    loop: 'loop',
    length: 4,
    keys: () => [
      ...sample(4, 16, [
        { node: 'chest', channel: 'scale', fn: (t) => 1 + 0.022 * wave(t, 1) },
        { node: 'chest', fn: (t) => [-1.4 * wave(t, 1), 0, 0] },
        { node: 'neck_01', fn: (t) => [-1.2 * wave(t, 1, 0.08), 0, 0] },
        { node: 'neck_02', fn: (t) => [-0.9 * wave(t, 1, 0.14), 0, 0] },
        { node: 'neck_03', fn: (t) => [-0.7 * wave(t, 1, 0.2), 0, 0] },
        // The head scans: a slow turn out and back with a small lift, then a settle.
        { node: 'head', fn: (t) => [1.5 * wave(t, 2, 0.1) - 1, 9 * wave(t, 1, 0.06), 1.2 * wave(t, 1, 0.2)] },
        { node: 'lower_jaw', fn: (t) => [1.5 + 1.2 * wave(t, 1), 0, 0] },
        { node: 'body', channel: 'position', fn: (t) => [0, 0.35 * wave(t, 1, 0.25) - 0.15, 0] },
        { node: 'body', fn: (t) => [0.5 * wave(t, 1, 0.5), 1.6 * wave(t, 1), 1.1 * wave(t, 1, 0.1)] },
        { node: 'left_leg', fn: (t) => [-0.9 * wave(t, 1), 0, 0] },
        { node: 'right_leg', fn: (t) => [0.9 * wave(t, 1), 0, 0] },
        { node: 'left_arm', fn: (t) => [1.4 * wave(t, 1, 0.2), 0, 0] },
        { node: 'right_arm', fn: (t) => [-1.4 * wave(t, 1, 0.2), 0, 0] },
        { node: 'left_lower_arm', fn: (t) => [-18 + 2.5 * wave(t, 1, 0.3), 0, 0] },
        { node: 'right_lower_arm', fn: (t) => [-18 - 2.5 * wave(t, 1, 0.3), 0, 0] },
      ]),
      ...tailCycle(4, 16, { amp: 5, lift: 3, lag: 0.08, grow: 1.22, bob: 0.4 }),
    ],
  });

  /* breathe — the ribcage alone, slow and deep */
  ANIMATIONS.push({
    name: 'breathe',
    loop: 'loop',
    length: 3,
    keys: () => [
      ...sample(3, 12, [
        { node: 'chest', channel: 'scale', fn: (t) => 1 + 0.042 * wave(t, 1) },
        { node: 'chest', fn: (t) => [-2.6 * wave(t, 1), 0, 0] },
        { node: 'neck_01', fn: (t) => [-2.2 * wave(t, 1, 0.06), 0, 0] },
        { node: 'neck_02', fn: (t) => [-1.6 * wave(t, 1, 0.12), 0, 0] },
        { node: 'neck_03', fn: (t) => [-1.2 * wave(t, 1, 0.18), 0, 0] },
        { node: 'head', fn: (t) => [1.6 * wave(t, 1, 0.24), 0, 0] },
        { node: 'body', channel: 'position', fn: (t) => [0, -0.3 - 0.3 * Math.cos(2 * Math.PI * t), 0] },
        { node: 'body', fn: (t) => [0.7 * wave(t, 1, 0.1), 0, 0] },
      ]),
      ...tailCycle(3, 12, { amp: 2, lift: 2, lag: 0.09, grow: 1.25, bob: 0.6 }),
    ],
  });

  /* tail_sway — a wave travelling down the tail, damped by the body */
  ANIMATIONS.push({
    name: 'tail_sway',
    loop: 'loop',
    length: 3,
    keys: () => [
      ...tailCycle(3, 18, { amp: 9, lift: 4, lag: 0.085, grow: 1.26, bob: 0.3 }),
      ...sample(3, 18, [
        { node: 'body', fn: (t) => [0, -1.8 * wave(t, 1), 1.4 * wave(t, 1)] },
        { node: 'chest', fn: (t) => [0, -1.5 * wave(t, 1), 0] },
        { node: 'head', fn: (t) => [0, -3.5 * wave(t, 1, 0.12), 0] },
        { node: 'left_leg', fn: (t) => [0, 1.2 * wave(t, 1), 0] },
        { node: 'right_leg', fn: (t) => [0, 1.2 * wave(t, 1), 0] },
      ]),
    ],
  });

  ANIMATIONS.push({ name: 'walk', loop: 'loop', length: 1, keys: () => locomotion({ length: 1, samples: 10, stride: 20, knee: 26, ankle: 7, toe: 13, bob: 0.75, lean: 2, roll: 2.6, headDrop: -1, armSwing: 12, tailAmp: 7, tailLift: 3 }) });
  ANIMATIONS.push({ name: 'run', loop: 'loop', length: 0.72, keys: () => locomotion({ length: 0.72, samples: 10, stride: 33, knee: 44, ankle: 11, toe: 20, bob: 1.3, lean: 7, roll: 4, headDrop: -3, armSwing: 24, tailAmp: 11, tailLift: 8 }) });
  ANIMATIONS.push({ name: 'sprint', loop: 'loop', length: 0.55, keys: () => locomotion({ length: 0.55, samples: 10, stride: 44, knee: 56, ankle: 14, toe: 26, bob: 1.7, lean: 12, roll: 5, headDrop: -5, armSwing: 32, tailAmp: 14, tailLift: 13 }) });

  /* attack — coil, strike, impact, recover. The tail counterweights the lunge. */
  ANIMATIONS.push({
    name: 'attack',
    loop: 'once',
    length: 0.95,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        // Anticipation: shift back, coil the neck, load the legs.
        [0.20, restOf({ body: [4, 0, 0], chest: [-3, 0, 0], neck_01: [-12, 0, 0], neck_02: [-9, 0, 0], neck_03: [-6, 0, 0], head: [-4, 0, 0], lower_jaw: [4, 0, 0], left_leg: [-9, 0, 0], right_leg: [-7, 0, 0], left_shin: [17, 0, 0], right_shin: [14, 0, 0] }, { body: [0, -1.3, -1.4] })],
        // Strike: neck drives forward and down, jaw wide.
        [0.36, restOf({ body: [11, 0, 0], chest: [4, 0, 0], neck_01: [17, 0, 0], neck_02: [13, 0, 0], neck_03: [9, 0, 0], head: [5, 0, 0], lower_jaw: [44, 0, 0], left_leg: [-15, 0, 0], right_leg: [11, 0, 0], left_shin: [7, 0, 0], right_shin: [4, 0, 0] }, { body: [0, 0.5, 2.4], chest: [0, 0, 2.5] })],
        // Impact: the jaws close on the target; a linear key keeps the snap sharp.
        [0.47, restOf({ body: [13, 0, 0], chest: [3, 0, 0], neck_01: [15, 0, 0], neck_02: [12, 0, 0], neck_03: [8, 0, 0], head: [3, 0, 0], lower_jaw: [2, 0, 0], left_leg: [-16, 0, 0], right_leg: [12, 0, 0] }, { body: [0, 0.2, 2.6], chest: [0, 0, 2.5] }, 'linear')],
        // Follow-through: the head overshoots, then settles.
        [0.60, restOf({ body: [9, 0, 0], chest: [2, 0, 0], neck_01: [11, 0, 0], neck_02: [8, 0, 0], neck_03: [5, 0, 0], head: [1, 0, 0], lower_jaw: [7, 0, 0] }, { body: [0, -0.2, 1.6] })],
        [0.78, restOf({ body: [3, 0, 0], neck_01: [3, 0, 0], neck_02: [2, 0, 0], head: [1, 0, 0], lower_jaw: [3, 0, 0] }, { body: [0, -0.1, 0.5] })],
        [0.95, restOf(), { body: [0, 0, 0] }, 'linear'],
      ]);
      keys.push(...tailPose([[0.20, 0.02], [0.36, 0.02], [0.47, 0.02], [0.62, 0.03], [0.95, 0.04]], (i, t) => {
        // The tail lifts and swings out as the body pitches forward.
        const drive = bump(t, 0.14, 0.5, 0.85);
        return [5 + i * 1.1 + 16 * drive, (4 + i * 2.6) * Math.sin(t * 6.2), 0];
      }));
      keys.push(...sample(0.95, 8, [{ node: 'chest', channel: 'scale', fn: (t) => 1 + 0.05 * bump(t, 0.12, 0.5, 0.9) }]));
      return keys;
    },
  });

  /* bite — smaller and faster than attack, with a clear jaw snap */
  ANIMATIONS.push({
    name: 'bite',
    loop: 'once',
    length: 0.62,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        [0.13, restOf({ body: [-3, 0, 0], neck_01: [-7, 0, 0], neck_02: [-5, 0, 0], neck_03: [-4, 0, 0], head: [-3, 0, 0], lower_jaw: [22, 0, 0] }, { body: [0, 0.2, -0.7] })],
        [0.26, restOf({ body: [8, 0, 0], neck_01: [13, 0, 0], neck_02: [10, 0, 0], neck_03: [7, 0, 0], head: [4, 0, 0], lower_jaw: [42, 0, 0] }, { body: [0, 0.3, 1.5], chest: [0, 0, 1.6] })],
        [0.34, restOf({ body: [9, 0, 0], neck_01: [11, 0, 0], neck_02: [9, 0, 0], neck_03: [6, 0, 0], head: [3, 0, 0], lower_jaw: [0, 0, 0] }, { body: [0, 0.1, 1.6], chest: [0, 0, 1.6] }, 'linear')],
        [0.44, restOf({ body: [6, 0, 0], neck_01: [7, 0, 0], neck_02: [5, 0, 0], head: [2, 0, 0], lower_jaw: [4, 0, 0] }, { body: [0, 0, 1] })],
        [0.62, restOf(), { body: [0, 0, 0] }, 'linear'],
      ]);
      keys.push(...tailPose([[0.13, 0.015], [0.26, 0.02], [0.36, 0.02], [0.62, 0.03]], (i, t) => [3 + i * 0.8 + 9 * bump(t, 0.08, 0.32, 0.7), (3 + i * 1.8) * Math.sin(t * 8), 0]));
      return keys;
    },
  });

  /* roar — chest expands, neck rises, jaw opens wide, the body recoils */
  ANIMATIONS.push({
    name: 'roar',
    loop: 'once',
    length: 1.7,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        // Inhale and gather.
        [0.36, restOf({ body: [4, 0, 0], chest: [2, 0, 0], neck_01: [9, 0, 0], neck_02: [7, 0, 0], neck_03: [5, 0, 0], head: [4, 0, 0], lower_jaw: [2, 0, 0], left_shin: [11, 0, 0], right_shin: [9, 0, 0] }, { body: [0, -0.9, -0.5] })],
        // Rise: neck up, chest out, jaw wide.
        [0.72, restOf({ body: [-6, 0, 0], chest: [-5, 0, 0], neck_01: [-19, 0, 0], neck_02: [-15, 0, 0], neck_03: [-11, 0, 0], head: [-9, 0, 0], lower_jaw: [46, 0, 0], left_arm: [-10, 0, 0], right_arm: [-10, 0, 0] }, { body: [0, 1.3, -0.8] })],
        // Sustain with a slight waver so it does not look frozen.
        [1.05, restOf({ body: [-7, 0, 0.8], chest: [-5, 0, 0], neck_01: [-17, 0, -1.4], neck_02: [-14, 0, 1], neck_03: [-10, 0, 0.8], head: [-8, 2.4, 0], lower_jaw: [50, 0, 0] }, { body: [0, 1.2, -0.7] })],
        [1.28, restOf({ body: [-6, 0, -0.6], chest: [-4, 0, 0], neck_01: [-18, 0, 1.2], neck_02: [-14, 0, -1], neck_03: [-10, 0, -0.8], head: [-8, -2.2, 0], lower_jaw: [46, 0, 0] }, { body: [0, 1.2, -0.7] })],
        // Close and settle.
        [1.5, restOf({ body: [-2, 0, 0], chest: [-1, 0, 0], neck_01: [-6, 0, 0], neck_02: [-4, 0, 0], neck_03: [-3, 0, 0], head: [-2, 0, 0], lower_jaw: [10, 0, 0] }, { body: [0, 0.4, -0.2] })],
        [1.7, restOf(), { body: [0, 0, 0] }, 'linear'],
      ]);
      keys.push(...tailPose([[0.36, 0.03], [0.72, 0.02], [1.05, 0.04], [1.28, 0.04], [1.5, 0.04], [1.7, 0.05]], (i, t) => [4 + i * 1.4 + 14 * bump(t, 0.25, 0.72, 1.5), (5 + i * 2.2) * Math.sin(t * 5.5), 0]));
      keys.push(...sample(1.7, 10, [{ node: 'chest', channel: 'scale', fn: (t) => 1 + 0.085 * bump(t, 0.2, 0.72, 1.45) }]));
      keys.push(...sample(1.7, 8, [
        { node: 'left_leg', fn: (t) => [-3 - 4 * bump(t, 0.3, 0.75, 1.4), 0, 0] },
        { node: 'right_leg', fn: (t) => [3 + 4 * bump(t, 0.3, 0.75, 1.4), 0, 0] },
      ]));
      return keys;
    },
  });

  /* roar_aggressive — steps in, shakes the head, snaps the jaw */
  ANIMATIONS.push({
    name: 'roar_aggressive',
    loop: 'once',
    length: 2,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        [0.22, restOf({ body: [6, 0, 0], neck_01: [10, 0, 0], neck_02: [8, 0, 0], neck_03: [5, 0, 0], head: [5, 0, 0], left_shin: [16, 0, 0], right_shin: [13, 0, 0], left_leg: [-9, 0, 0], right_leg: [-6, 0, 0] }, { body: [0, -1.7, -1.6] })],
        [0.52, restOf({ body: [-9, 0, 0], chest: [-6, 0, 0], neck_01: [-24, 0, 0], neck_02: [-19, 0, 0], neck_03: [-14, 0, 0], head: [-12, 0, 0], lower_jaw: [52, 0, 0], left_leg: [-15, 0, 0], right_leg: [10, 0, 0], left_shin: [7, 0, 0], right_shin: [5, 0, 0] }, { body: [0, 1.9, 2.3], chest: [0, 0, 2.2] })],
        // Head shake: big, fast Y oscillation while the jaw stays open.
        [0.78, restOf({ body: [-8, 0, -1.5], chest: [-5, 0, 0], neck_01: [-21, 5, 0], neck_02: [-17, -6, 0], neck_03: [-12, 7, 0], head: [-10, 14, -3], lower_jaw: [50, 0, 0] }, { body: [0, 1.6, 2] })],
        [0.96, restOf({ body: [-8, 0, 1.5], chest: [-5, 0, 0], neck_01: [-21, -5, 0], neck_02: [-17, 6, 0], neck_03: [-12, -7, 0], head: [-10, -14, 3], lower_jaw: [48, 0, 0] }, { body: [0, 1.6, 2] })],
        [1.14, restOf({ body: [-8, 0, -1], chest: [-5, 0, 0], neck_01: [-22, 3, 0], neck_02: [-18, -4, 0], neck_03: [-13, 5, 0], head: [-11, 9, -2], lower_jaw: [47, 0, 0] }, { body: [0, 1.5, 2] })],
        // A warning snap, linear so it lands hard.
        [1.32, restOf({ body: [-4, 0, 0], chest: [-3, 0, 0], neck_01: [-16, 0, 0], neck_02: [-12, 0, 0], neck_03: [-9, 0, 0], head: [-8, 0, 0], lower_jaw: [4, 0, 0] }, { body: [0, 0.9, 1.2] }, 'linear')],
        [1.52, restOf({ body: [-1, 0, 0], neck_01: [-5, 0, 0], neck_02: [-4, 0, 0], head: [-2, 0, 0], lower_jaw: [12, 0, 0] }, { body: [0, 0.4, 0.4] })],
        [2, restOf(), { body: [0, 0, 0] }, 'linear'],
      ]);
      keys.push(...tailPose([[0.22, 0.03], [0.52, 0.02], [0.78, 0.04], [0.96, 0.04], [1.14, 0.04], [1.32, 0.03], [1.6, 0.04], [2, 0.05]], (i, t) => [5 + i * 1.5 + 18 * bump(t, 0.15, 0.6, 1.7), (8 + i * 3.2) * Math.sin(t * 5.2), 0]));
      keys.push(...sample(2, 10, [{ node: 'chest', channel: 'scale', fn: (t) => 1 + 0.095 * bump(t, 0.15, 0.55, 1.6) }]));
      return keys;
    },
  });

  /* hurt — a short, sharp recoil that settles quickly */
  ANIMATIONS.push({
    name: 'hurt',
    loop: 'once',
    length: 0.5,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        [0.07, restOf({ body: [-9, 0, 3], chest: [-5, 0, 0], neck_01: [-8, 0, 0], neck_02: [-5, 0, 0], neck_03: [-4, 0, 0], head: [-6, -5, 0], lower_jaw: [14, 0, 0], left_leg: [5, 0, 0], right_leg: [-4, 0, 0], left_shin: [13, 0, 0], right_shin: [11, 0, 0] }, { body: [0, -1.1, -1.5] }, 'linear')],
        [0.19, restOf({ body: [-5, 0, -2], chest: [-3, 0, 0], neck_01: [-4, 0, 0], head: [-3, 4, 0], lower_jaw: [9, 0, 0], left_shin: [9, 0, 0], right_shin: [8, 0, 0] }, { body: [0, -0.5, -0.7] })],
        [0.33, restOf({ body: [1, 0, 0.8], neck_01: [2, 0, 0], head: [1, -1, 0], lower_jaw: [4, 0, 0] }, { body: [0, 0.1, 0.2] })],
        [0.5, restOf(), { body: [0, 0, 0] }, 'linear'],
      ]);
      keys.push(...tailPose([[0.07, 0.02], [0.2, 0.03], [0.35, 0.03], [0.5, 0.03]], (i, t) => [3 + i * 1.6 * bump(t, 0, 0.12, 0.45), (4 + i * 2.4) * Math.sin(t * 9), 0]));
      return keys;
    },
  });

  /* death — stagger, the legs give way, the body drops and rolls, then settles */
  ANIMATIONS.push({
    name: 'death',
    loop: 'once',
    length: 3.95,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        // Hit: a big recoil away from the blow.
        [0.22, restOf({ body: [-13, 0, 7], chest: [-7, 0, 0], neck_01: [-13, 0, 0], neck_02: [-9, 0, 0], neck_03: [-7, 0, 0], head: [-11, -8, 0], lower_jaw: [26, 0, 0], left_leg: [9, 0, 0], right_leg: [-7, 0, 0], left_shin: [19, 0, 0], right_shin: [16, 0, 0] }, { body: [0, -1.6, -2.3] })],
        // Stagger back a step; the head lolls.
        [0.70, restOf({ body: [5, 0, -5], chest: [2, 0, 0], neck_01: [4, 0, -3], neck_02: [3, 0, 2], neck_03: [2, 0, 2], head: [7, 10, -4], lower_jaw: [20, 0, 0], left_leg: [-13, 0, 0], right_leg: [11, 0, 0], left_shin: [23, 0, 0], right_shin: [19, 0, 0] }, { body: [0, -2.6, -1.1] })],
        // The hind legs fold; the hips drop.
        [1.45, restOf({ body: [13, 0, -9], chest: [5, 0, 0], neck_01: [7, 0, -4], neck_02: [5, 0, 3], neck_03: [4, 0, 3], head: [9, 12, -6], lower_jaw: [30, 0, 0], left_leg: [-21, 0, 0], right_leg: [-19, 0, 0], left_shin: [34, 0, 0], right_shin: [30, 0, 0], left_foot: [14, 0, 0], right_foot: [12, 0, 0] }, { body: [0, -12, -0.4] })],
        // Down: torso on the ground, pitched forward and rolled onto one side.
        [2.25, restOf({ body: [23, 0, -15], chest: [7, 0, -3], neck_01: [11, 0, -5], neck_02: [8, 0, 4], neck_03: [6, 0, 4], head: [13, 8, -8], lower_jaw: [22, 0, 0], left_leg: [-24, 0, 0], right_leg: [-22, 0, 0], left_shin: [40, 0, 0], right_shin: [37, 0, 0], left_foot: [18, 0, 0], right_foot: [16, 0, 0] }, { body: [0, -21, 0.9] })],
        // The neck slackens and the jaw falls open as the head settles.
        [2.95, restOf({ body: [25, 0, -17], chest: [6, 0, -3], neck_01: [14, 4, -6], neck_02: [11, -3, 5], neck_03: [8, 3, 5], head: [16, -6, -9], lower_jaw: [30, 0, 0], left_leg: [-25, 0, 0], right_leg: [-23, 0, 0], left_shin: [42, 0, 0], right_shin: [39, 0, 0], left_foot: [19, 0, 0], right_foot: [17, 0, 0] }, { body: [0, -22.5, 1.1] })],
        // A last shallow breath, then nothing.
        [3.35, restOf({ body: [25, 0, -17], chest: [5, 0, -3], neck_01: [15, 2, -6], neck_02: [12, -2, 5], neck_03: [9, 2, 5], head: [17, -3, -9], lower_jaw: [26, 0, 0], left_leg: [-25, 0, 0], right_leg: [-23, 0, 0], left_shin: [42, 0, 0], right_shin: [39, 0, 0], left_foot: [19, 0, 0], right_foot: [17, 0, 0] }, { body: [0, -22.8, 1.1] })],
        [3.95, restOf({ body: [26, 0, -17], chest: [4, 0, -3], neck_01: [16, 0, -6], neck_02: [13, 0, 5], neck_03: [9, 0, 5], head: [18, 0, -9], lower_jaw: [20, 0, 0], left_leg: [-25, 0, 0], right_leg: [-23, 0, 0], left_shin: [42, 0, 0], right_shin: [39, 0, 0], left_foot: [19, 0, 0], right_foot: [17, 0, 0] }, { body: [0, -23, 1.1] }, 'linear')],
      ]);
      // The tail goes limp: it stays up as the body drops, then flops down segment by
      // segment, the tip last.
      keys.push(...tailPose([[0, 0.05], [0.7, 0.06], [1.45, 0.08], [2.25, 0.09], [2.95, 0.1], [3.95, 0.12]], (i, t) => {
        const up = 12 * bump(t, 0.1, 1.1, 2.2);
        const flop = -34 * clamp(bump(t, 1.5 + i * 0.28, 2.6 + i * 0.28, 3.9), 0, 1);
        return [3 + i * 1.2 + up + flop, (3 + i * 2.2) * Math.sin(t * 3.4), 0];
      }));
      keys.push(...sample(3.95, 10, [{ node: 'chest', channel: 'scale', fn: (t) => 1 + 0.05 * bump(t, 0, 2.2, 3.6) }]));
      return keys;
    },
  });

  /* jump — crouch, launch, tuck, reach, impact, recover */
  ANIMATIONS.push({
    name: 'jump',
    loop: 'once',
    length: 1.15,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        // Crouch: legs load, body compresses.
        [0.18, restOf({ body: [9, 0, 0], chest: [3, 0, 0], neck_01: [7, 0, 0], neck_02: [5, 0, 0], neck_03: [4, 0, 0], head: [4, 0, 0], left_leg: [-19, 0, 0], right_leg: [-19, 0, 0], left_shin: [36, 0, 0], right_shin: [36, 0, 0], left_foot: [16, 0, 0], right_foot: [16, 0, 0], left_toes: [-10, 0, 0], right_toes: [-10, 0, 0] }, { body: [0, -5.2, -0.4] })],
        // Launch: everything extends, the toes push off.
        [0.33, restOf({ body: [-10, 0, 0], chest: [-5, 0, 0], neck_01: [-13, 0, 0], neck_02: [-10, 0, 0], neck_03: [-8, 0, 0], head: [-9, 0, 0], lower_jaw: [18, 0, 0], left_leg: [16, 0, 0], right_leg: [16, 0, 0], left_shin: [2, 0, 0], right_shin: [2, 0, 0], left_foot: [-30, 0, 0], right_foot: [-30, 0, 0], left_toes: [16, 0, 0], right_toes: [16, 0, 0] }, { body: [0, 3.4, 0.6] }, 'linear')],
        // Airborne: legs tucked under, arms up, tail counterbalances forward.
        [0.62, restOf({ body: [-4, 0, 0], chest: [-3, 0, 0], neck_01: [-7, 0, 0], neck_02: [-6, 0, 0], neck_03: [-4, 0, 0], head: [-6, 0, 0], left_leg: [-26, 0, 0], right_leg: [-22, 0, 0], left_shin: [46, 0, 0], right_shin: [42, 0, 0], left_foot: [-8, 0, 0], right_foot: [-8, 0, 0], left_arm: [-18, 0, 0], right_arm: [-18, 0, 0], left_lower_arm: [-30, 0, 0], right_lower_arm: [-30, 0, 0] }, { body: [0, 4.6, 0.3] })],
        // Descent: legs reach for the ground.
        [0.88, restOf({ body: [4, 0, 0], neck_01: [4, 0, 0], head: [3, 0, 0], left_leg: [-12, 0, 0], right_leg: [-12, 0, 0], left_shin: [18, 0, 0], right_shin: [18, 0, 0], left_foot: [-16, 0, 0], right_foot: [-16, 0, 0] }, { body: [0, 1.2, -0.3] })],
        // Impact and absorb.
        [0.99, restOf({ body: [11, 0, 0], chest: [4, 0, 0], neck_01: [9, 0, 0], neck_02: [7, 0, 0], head: [6, 0, 0], left_leg: [-22, 0, 0], right_leg: [-22, 0, 0], left_shin: [40, 0, 0], right_shin: [40, 0, 0], left_foot: [18, 0, 0], right_foot: [18, 0, 0] }, { body: [0, -5.6, -0.5] }, 'linear')],
        [1.15, restOf(), { body: [0, 0, 0] }],
      ]);
      keys.push(...tailPose([[0.18, 0.02], [0.33, 0.02], [0.62, 0.04], [0.88, 0.03], [0.99, 0.02], [1.15, 0.04]], (i, t) => {
        const crouch = -7 * bump(t, 0.05, 0.18, 0.31);
        const lift = (14 + i * 3) * Math.sin(Math.PI * clamp((t - 0.28) / 0.62, 0, 1));
        return [2 + i * 1.1 + crouch + lift, (3 + i * 1.8) * Math.sin(t * 7.5), 0];
      }));
      return keys;
    },
  });

  /* fall — a looping airborne pose with a slow, nervous flutter */
  ANIMATIONS.push({
    name: 'fall',
    loop: 'loop',
    length: 1,
    keys: () => {
      const keys = sample(1, 10, [
        { node: 'body', fn: (t) => [6 + 2 * wave(t, 1), 1.5 * wave(t, 1, 0.2), 2 * wave(t, 1, 0.1)] },
        { node: 'chest', fn: (t) => [2, -1.5 * wave(t, 1, 0.3), 0] },
        { node: 'neck_01', fn: (t) => [3 + 1.5 * wave(t, 2), 0, 0] },
        { node: 'neck_02', fn: (t) => [2, 0, 0] },
        { node: 'head', fn: (t) => [4 + 2 * wave(t, 2, 0.15), 3 * wave(t, 1, 0.4), 0] },
        { node: 'lower_jaw', fn: (t) => [12 + 4 * wave(t, 2), 0, 0] },
        // Legs trail below and flex against the air.
        { node: 'left_leg', fn: (t) => [-10 + 4 * wave(t, 1), 0, 0] },
        { node: 'right_leg', fn: (t) => [-14 + 4 * wave(t, 1, 0.5), 0, 0] },
        { node: 'left_shin', fn: (t) => [26 + 6 * wave(t, 1, 0.2), 0, 0] },
        { node: 'right_shin', fn: (t) => [32 + 6 * wave(t, 1, 0.7), 0, 0] },
        { node: 'left_foot', fn: (t) => [-10, 0, 0] },
        { node: 'right_foot', fn: (t) => [-14, 0, 0] },
        { node: 'left_arm', fn: (t) => [-22 + 5 * wave(t, 1, 0.1), 0, 0] },
        { node: 'right_arm', fn: (t) => [-22 + 5 * wave(t, 1, 0.6), 0, 0] },
        { node: 'left_lower_arm', fn: (t) => [-34 + 6 * wave(t, 1, 0.3), 0, 0] },
        { node: 'right_lower_arm', fn: (t) => [-34 + 6 * wave(t, 1, 0.8), 0, 0] },
      ]);
      keys.push(...tailCycle(1, 10, { amp: 10, lift: 26, lag: 0.11, grow: 1.2, bob: 0.7 }));
      return keys;
    },
  });

  /* land — a hard impact with a deep absorb and a small rebound */
  ANIMATIONS.push({
    name: 'land',
    loop: 'once',
    length: 0.7,
    keys: () => {
      const keys = pose([
        [0, restOf({ body: [2, 0, 0], neck_01: [2, 0, 0], head: [2, 0, 0], left_leg: [-8, 0, 0], right_leg: [-8, 0, 0], left_shin: [14, 0, 0], right_shin: [14, 0, 0], left_foot: [-12, 0, 0], right_foot: [-12, 0, 0] }, { body: [0, 0.8, 0] })],
        // Contact: legs collapse, head drops, jaw clacks shut.
        [0.14, restOf({ body: [14, 0, 0], chest: [5, 0, 0], neck_01: [11, 0, 0], neck_02: [8, 0, 0], neck_03: [6, 0, 0], head: [8, 0, 0], lower_jaw: [12, 0, 0], left_leg: [-24, 0, 0], right_leg: [-24, 0, 0], left_shin: [44, 0, 0], right_shin: [44, 0, 0], left_foot: [20, 0, 0], right_foot: [20, 0, 0], left_toes: [-12, 0, 0], right_toes: [-12, 0, 0] }, { body: [0, -6.4, -0.6] }, 'linear')],
        // Rebound, then a settle overshoot.
        [0.36, restOf({ body: [-2, 0, 0], chest: [-1, 0, 0], neck_01: [-4, 0, 0], head: [-3, 0, 0], lower_jaw: [4, 0, 0], left_leg: [-5, 0, 0], right_leg: [-5, 0, 0], left_shin: [10, 0, 0], right_shin: [10, 0, 0], left_foot: [2, 0, 0], right_foot: [2, 0, 0] }, { body: [0, 1.4, 0.2] })],
        [0.52, restOf({ body: [2, 0, 0], neck_01: [2, 0, 0], head: [1, 0, 0], left_shin: [7, 0, 0], right_shin: [7, 0, 0] }, { body: [0, -0.5, 0] })],
        [0.7, restOf(), { body: [0, 0, 0] }],
      ]);
      keys.push(...tailPose([[0, 0.02], [0.14, 0.02], [0.36, 0.04], [0.55, 0.04], [0.7, 0.04]], (i, t) => {
        const slap = -10 * bump(t, 0.02, 0.16, 0.45);
        const up = 16 * bump(t, 0.12, 0.4, 0.7);
        return [4 + i * 1.3 + slap + up, (4 + i * 2) * Math.sin(t * 8), 0];
      }));
      return keys;
    },
  });

  /* look — a looping scan with a blink-like jaw tick and a counter-swaying tail */
  ANIMATIONS.push({
    name: 'look',
    loop: 'loop',
    length: 2.4,
    keys: () => [
      ...sample(2.4, 16, [
        { node: 'head', fn: (t) => [-2 + 2 * wave(t, 2, 0.1), 26 * wave(t, 1, 0.02), 2.5 * wave(t, 1, 0.25)] },
        { node: 'neck_03', fn: (t) => [-1.5 * wave(t, 1, 0.2), 9 * wave(t, 1, 0.06), 0] },
        { node: 'neck_02', fn: (t) => [-1.2 * wave(t, 2), 6 * wave(t, 1, 0.1), 0] },
        { node: 'neck_01', fn: (t) => [-1.8 * wave(t, 2, 0.1), 4 * wave(t, 1, 0.14), 0] },
        { node: 'chest', fn: (t) => [0, 2 * wave(t, 1, 0.16), 0] },
        { node: 'body', fn: (t) => [0, 2.2 * wave(t, 1, 0.18), 1.6 * wave(t, 1)] },
        { node: 'lower_jaw', fn: (t) => [1.5 + 1.5 * wave(t, 1), 0, 0] },
        { node: 'left_leg', fn: (t) => [0.8 * wave(t, 1), 0, 0] },
        { node: 'right_leg', fn: (t) => [-0.8 * wave(t, 1), 0, 0] },
      ]),
      ...tailCycle(2.4, 16, { amp: 4, lift: 3, lag: 0.09, grow: 1.24, bob: 0.4 }),
    ],
  });

  /* look_left / look_right — the head leads, the body barely follows, the tail counters */
  for (const [name, dir] of [['look_left', 1], ['look_right', -1]]) {
    ANIMATIONS.push({
      name,
      loop: 'once',
      length: 0.9,
      keys: () => {
        const keys = pose([
          [0, restOf()],
          [0.14, restOf({ head: [-3, 9 * dir, 2 * dir], neck_03: [0, 3 * dir, 0], neck_02: [0, 2 * dir, 0], chest: [0, 1.5 * dir, 0] })],
          [0.42, restOf({ head: [-4, 31 * dir, 4 * dir], neck_03: [0, 11 * dir, 0], neck_02: [0, 9 * dir, 0], neck_01: [0, 6 * dir, 0], chest: [0, 4 * dir, 0], body: [0, 3 * dir, 1.5 * dir], left_leg: [0, 2 * dir, 0], right_leg: [0, 2 * dir, 0] })],
          // A tiny settle: the head overshoots by a couple of degrees and comes back.
          [0.66, restOf({ head: [-3, 27 * dir, 3 * dir], neck_03: [0, 9 * dir, 0], neck_02: [0, 8 * dir, 0], neck_01: [0, 5 * dir, 0], chest: [0, 3.5 * dir, 0], body: [0, 2.6 * dir, 1.2 * dir] })],
          [0.9, restOf({ head: [-3, 29 * dir, 3 * dir], neck_03: [0, 10 * dir, 0], neck_02: [0, 8 * dir, 0], neck_01: [0, 5 * dir, 0], chest: [0, 3.5 * dir, 0], body: [0, 2.8 * dir, 1.3 * dir] })],
        ]);
        keys.push(...tailPose([[0.14, 0.03], [0.42, 0.04], [0.9, 0.05]], (i, t) => [3, -(5 + i * 2.6) * dir * clamp(t / 0.45, 0, 1), 0]));
        return keys;
      },
    });
  }

  /* angry_idle — head low, jaw working, tail lashing on a hard beat */
  ANIMATIONS.push({
    name: 'angry_idle',
    loop: 'loop',
    length: 2.6,
    keys: () => [
      ...sample(2.6, 18, [
        { node: 'chest', channel: 'scale', fn: (t) => 1 + 0.05 * Math.abs(wave(t, 2, 0.05)) },
        { node: 'body', fn: (t) => [3.5 + 1.5 * wave(t, 2, 0.1), 2.5 * wave(t, 1, 0.5), 2.2 * wave(t, 1)] },
        { node: 'body', channel: 'position', fn: (t) => [0, -0.6 + 0.5 * wave(t, 2, 0.2), 0] },
        { node: 'chest', fn: (t) => [-2.5 + 2 * wave(t, 2), -2 * wave(t, 1, 0.45), 0] },
        // The head sits low and forward, twitching in short bursts.
        { node: 'neck_01', fn: (t) => [7 + 3 * wave(t, 2, 0.05), 2.5 * wave(t, 1, 0.4), 0] },
        { node: 'neck_02', fn: (t) => [5 + 2.5 * wave(t, 2, 0.1), 2 * wave(t, 1, 0.45), 0] },
        { node: 'neck_03', fn: (t) => [4 + 2 * wave(t, 2, 0.15), 1.5 * wave(t, 1, 0.5), 0] },
        { node: 'head', fn: (t) => [5 + 3 * wave(t, 3, 0.1), 7 * wave(t, 2, 0.2), 3 * wave(t, 2, 0.35)] },
        // Jaw working: fast open/close, held slightly open.
        { node: 'lower_jaw', fn: (t) => [9 + 11 * Math.abs(wave(t, 3, 0.08)), 0, 0] },
        { node: 'left_leg', fn: (t) => [-1.6 * wave(t, 1), 1.4 * wave(t, 1, 0.3), 0] },
        { node: 'right_leg', fn: (t) => [1.6 * wave(t, 1), 1.4 * wave(t, 1, 0.3), 0] },
        { node: 'left_shin', fn: (t) => [5 + 1.5 * wave(t, 1, 0.1), 0, 0] },
        { node: 'right_shin', fn: (t) => [5 - 1.5 * wave(t, 1, 0.1), 0, 0] },
        { node: 'left_arm', fn: (t) => [-6 + 3 * wave(t, 2, 0.2), 0, 0] },
        { node: 'right_arm', fn: (t) => [-6 - 3 * wave(t, 2, 0.2), 0, 0] },
        { node: 'left_lower_arm', fn: (t) => [-24 + 4 * wave(t, 2, 0.3), 0, 0] },
        { node: 'right_lower_arm', fn: (t) => [-24 - 4 * wave(t, 2, 0.3), 0, 0] },
      ]),
      // A sharp, twice-per-loop lash rather than a smooth sway.
      ...tailCycle(2.6, 18, { amp: 13, lift: 9, lag: 0.1, grow: 1.28, bob: 0.75 }),
    ],
  });

  /* eating — head down, pushing food, jaw chewing */
  ANIMATIONS.push({
    name: 'eating',
    loop: 'loop',
    length: 2.4,
    keys: () => [
      ...sample(2.4, 16, [
        { node: 'body', fn: (t) => [9 + 2.5 * wave(t, 1, 0.1), 1.5 * wave(t, 1, 0.4), 1.8 * wave(t, 1)] },
        { node: 'body', channel: 'position', fn: (t) => [0, -2.4 + 0.6 * wave(t, 2, 0.15), 0] },
        { node: 'chest', fn: (t) => [4 + 2 * wave(t, 2), -1.5 * wave(t, 1, 0.4), 0] },
        // The neck reaches down and forward, shoving with each chew.
        { node: 'neck_01', fn: (t) => [13 + 4 * wave(t, 2, 0.05), 0, 0] },
        { node: 'neck_02', fn: (t) => [11 + 3 * wave(t, 2, 0.1), 0, 0] },
        { node: 'neck_03', fn: (t) => [8 + 3 * wave(t, 2, 0.15), 0, 0] },
        { node: 'head', fn: (t) => [6 + 5 * Math.abs(wave(t, 3, 0.1)), 4 * wave(t, 2, 0.2), 0] },
        // Chewing: a fast irregular jaw cycle.
        { node: 'lower_jaw', fn: (t) => [10 + 13 * Math.abs(wave(t, 4, 0.05)), 0, 0] },
        { node: 'left_leg', fn: (t) => [-4 + 1.5 * wave(t, 1), 0, 0] },
        { node: 'right_leg', fn: (t) => [-4 + 1.5 * wave(t, 1, 0.5), 0, 0] },
        { node: 'left_shin', fn: (t) => [9 + 2 * wave(t, 1, 0.2), 0, 0] },
        { node: 'right_shin', fn: (t) => [9 + 2 * wave(t, 1, 0.7), 0, 0] },
        { node: 'left_arm', fn: (t) => [-8 + 4 * wave(t, 2, 0.2), 0, 0] },
        { node: 'right_arm', fn: (t) => [-8 - 4 * wave(t, 2, 0.2), 0, 0] },
      ]),
      // Tail up and slightly stiff: it balances the lowered front.
      ...tailCycle(2.4, 16, { amp: 6, lift: 17, lag: 0.09, grow: 1.22, bob: 0.35 }),
    ],
  });

  /* sniff — short, quick head pulses close to the ground */
  ANIMATIONS.push({
    name: 'sniff',
    loop: 'once',
    length: 1.8,
    keys: () => {
      const keys = sample(1.8, 18, [
        { node: 'body', fn: (t) => [7 - 2 * bump(t, 0.05, 0.5, 1.7), 1.2 * wave(t, 2), 0] },
        { node: 'body', channel: 'position', fn: (t) => [0, -1.8 * bump(t, 0.05, 0.4, 1.75), 0] },
        { node: 'chest', fn: (t) => [3, 0, 0] },
        { node: 'neck_01', fn: (t) => [11 - 3 * bump(t, 0.05, 0.5, 1.7) + 1.5 * wave(t, 6), 0, 0] },
        { node: 'neck_02', fn: (t) => [9 + 1.2 * wave(t, 6, 0.1), 0, 0] },
        { node: 'neck_03', fn: (t) => [7 + 1 * wave(t, 6, 0.15), 0, 0] },
        // Sniffs: small fast puffs of the jaw plus a fidgeting head.
        { node: 'head', fn: (t) => [5 + 2.5 * wave(t, 6, 0.1), 6 * wave(t, 3, 0.1), 1.5 * wave(t, 3, 0.3)] },
        { node: 'lower_jaw', fn: (t) => [4 + 6 * Math.abs(wave(t, 6, 0.05)), 0, 0] },
        { node: 'left_leg', fn: (t) => [-3, 0, 0] },
        { node: 'right_leg', fn: (t) => [-3, 0, 0] },
        { node: 'left_shin', fn: (t) => [8, 0, 0] },
        { node: 'right_shin', fn: (t) => [8, 0, 0] },
      ]);
      keys.push(...tailPose([[0, 0.02], [0.5, 0.05], [1.8, 0.05]], (i, t) => [4 + i * 1.5 + 11 * bump(t, 0.05, 0.5, 1.75), (3 + i * 2) * Math.sin(t * 4), 0]));
      return keys;
    },
  });

  /* threaten — rise, chest out, jaw open, a short warning thrust */
  ANIMATIONS.push({
    name: 'threaten',
    loop: 'once',
    length: 1.6,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        [0.3, restOf({ body: [5, 0, 0], chest: [2, 0, 0], neck_01: [8, 0, 0], neck_02: [6, 0, 0], head: [5, 0, 0], lower_jaw: [6, 0, 0], left_shin: [11, 0, 0], right_shin: [11, 0, 0] }, { body: [0, -1.2, -0.6] })],
        // Rear up: the body tilts back, the neck stretches tall, the jaw opens wide.
        [0.62, restOf({ body: [-11, 0, 0], chest: [-7, 0, 0], neck_01: [-19, 0, 0], neck_02: [-15, 0, 0], neck_03: [-11, 0, 0], head: [-10, 0, 0], lower_jaw: [44, 0, 0], left_leg: [-6, 0, 0], right_leg: [-6, 0, 0], left_arm: [-14, 0, 0], right_arm: [-14, 0, 0] }, { body: [0, 2.4, -1.2] })],
        // A short thrust forward, then a hold.
        [0.92, restOf({ body: [4, 0, 0], chest: [1, 0, 0], neck_01: [6, 0, 0], neck_02: [5, 0, 0], neck_03: [4, 0, 0], head: [2, 0, 0], lower_jaw: [34, 0, 0] }, { body: [0, 0.4, 1.4] })],
        [1.14, restOf({ body: [-6, 0, 0], chest: [-4, 0, 0], neck_01: [-12, 0, 0], neck_02: [-10, 0, 0], neck_03: [-7, 0, 0], head: [-7, 0, 0], lower_jaw: [30, 0, 0] }, { body: [0, 1.5, -0.6] })],
        [1.6, restOf({ body: [-2, 0, 0], neck_01: [-4, 0, 0], head: [-3, 0, 0], lower_jaw: [10, 0, 0] }, { body: [0, 0.5, -0.2] }, 'linear')],
      ]);
      keys.push(...tailPose([[0.3, 0.03], [0.62, 0.02], [0.92, 0.03], [1.14, 0.04], [1.6, 0.04]], (i, t) => [5 + i * 1.6 + 20 * bump(t, 0.2, 0.65, 1.5), (6 + i * 2.6) * Math.sin(t * 4.5), 0]));
      keys.push(...sample(1.6, 10, [{ node: 'chest', channel: 'scale', fn: (t) => 1 + 0.09 * bump(t, 0.2, 0.62, 1.4) }]));
      return keys;
    },
  });

  for (const [name, dir] of [['turn_left', 1], ['turn_right', -1]]) {
    ANIMATIONS.push({ name, loop: 'once', length: 1, keys: () => turn(dir, 1) });
  }

  /* tail_whip — a body counter-rotation driving a crack down the tail */
  ANIMATIONS.push({
    name: 'tail_whip',
    loop: 'once',
    length: 0.8,
    keys: () => {
      const keys = pose([
        [0, restOf()],
        // Coil: the body twists one way so the tail can snap the other.
        [0.16, restOf({ body: [-2, -13, -4], chest: [0, -7, 0], neck_01: [3, 5, 0], neck_02: [2, 4, 0], head: [2, 9, 0], left_leg: [-4, 0, 0], right_leg: [2, 0, 0] }, { body: [0, -0.6, 0] })],
        // Crack: the whole trunk whips through, the head follows.
        [0.36, restOf({ body: [2, 18, 5], chest: [0, 10, 0], neck_01: [-2, -8, 0], neck_02: [-2, -6, 0], neck_03: [-1, -5, 0], head: [-1, -14, 0], lower_jaw: [14, 0, 0], left_leg: [3, 0, 0], right_leg: [-5, 0, 0] }, { body: [0, 0.5, 0] }, 'linear')],
        [0.52, restOf({ body: [1, 9, 3], chest: [0, 5, 0], head: [-1, -7, 0], lower_jaw: [8, 0, 0] }, { body: [0, 0.2, 0] })],
        [0.8, restOf({ body: [0, 2.5, 0.8], chest: [0, 1.5, 0], head: [0, -2, 0], lower_jaw: [3, 0, 0] })],
      ]);
      // The tail whips hardest at the tip and reaches late.
      keys.push(...tailPose([[0.14, 0.02], [0.3, 0.035], [0.4, 0.04], [0.55, 0.045], [0.8, 0.05]], (i, t) => {
        const back = -(8 + i * 5) * Math.min(1, t / 0.16);
        const forward = (26 + i * 13) * bump(t, 0.14, 0.42, 0.75);
        return [4 + i * 1.4 + 10 * bump(t, 0.12, 0.4, 0.7), back + forward, 0];
      }));
      return keys;
    },
  });

  return ANIMATIONS;
}

/* ------------------------------------------------------------------ the pass */

export async function run(call, log, warn, { kf }) {
  const specs = build(kf);
  const existing = await call('inspect_animations', { include_animators: false });
  const present = new Map(
    (existing?.animations ?? []).map((a) => [a.name, { length: a.length, loop: a.loop, keys: a.keyframe_count ?? 0 }]),
  );
  log(`${present.size} animations already declared, ${specs.length} authored here`);

  let created = 0;
  for (const spec of specs) {
    if (present.has(spec.name)) continue;
    await call('create_animation', { name: spec.name, loop: spec.loop, length: spec.length, select: false });
    created += 1;
  }
  if (created) log(`created ${created} missing animations`);

  let total = 0;
  for (const spec of specs) {
    const keys = spec.keys();
    if (!keys.length) {
      warn(`${spec.name}: the generator produced no keyframes`);
      continue;
    }
    const bad = keys.filter((k) => typeof k.interpolation !== 'string' || !Number.isFinite(k.time));
    if (bad.length) throw new Error(`${spec.name}: ${bad.length} malformed keyframes`);
    await call('bulk_create_keyframes', { animation: spec.name, keyframes: keys, set_length: false });
    total += keys.length;
    log(`${spec.name.padEnd(16)} ${String(spec.length).padStart(5)}s ${spec.loop.padEnd(4)} ${String(keys.length).padStart(4)} keyframes`);
  }
  log(`wrote ${total} keyframes across ${specs.length} animations`);

  // Read it back rather than trusting the writes.
  const after = await call('inspect_animations', { include_animators: false });
  const list = after?.animations ?? [];
  const empty = list.filter((a) => !(a.keyframe_count > 0));
  log(`${list.length} animations in the project, ${empty.length} still empty`);
  for (const a of empty) warn(`empty animation: ${a.name}`);
  return { total, animations: list.length, empty: empty.map((a) => a.name) };
}
