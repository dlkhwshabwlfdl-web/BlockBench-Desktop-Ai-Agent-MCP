/**
 * Single source of truth for the polished T-Rex: the final cube table, the UV island
 * atlas and the texture art.
 *
 * `polish-geometry.mjs` applies CUBES, `polish-uv.mjs` assigns the island rectangles
 * from `layout()` and `polish-texture.mjs` paints the same rectangles, so the geometry,
 * the UVs and the texture can never drift apart.
 *
 * Coordinate frame (verified against the geometry, not assumed): the model faces +Z,
 * Y is up, the ground plane is y = 0 and the model's own LEFT is +X.
 *
 * UV policy: the atlas is a set of named islands, one per *material*, and every face
 * samples its island at full rectangle. Faces deliberately share islands — that is how
 * Minecraft models are textured — but no two islands overlap, which is what the
 * previous layout got wrong (it placed each skin face at a hash-derived offset, so
 * hundreds of faces sampled the same few pixels and the model read as one flat colour).
 * Side-facing islands carry the vertical light-to-dark gradient because a vertical
 * gradient in the atlas maps to vertical on a side face; the `up` islands are painted
 * flat and light instead, because on an `up` face the atlas' vertical axis runs
 * front-to-back and a gradient there would paint a stripe across the animal's back.
 */
import { PNG } from 'pngjs';

/* ------------------------------------------------------------------- islands */

/** Requested island sizes. Bigger islands carry more painted detail. */
export const ISLAND_DEFS = {
  skin_top: { w: 18, h: 18 },
  skin_side: { w: 18, h: 18 },
  skin_belly: { w: 18, h: 12 },
  leg: { w: 16, h: 16 },
  head_top: { w: 16, h: 16 },
  head_side: { w: 16, h: 16 },
  neck: { w: 14, h: 14 },
  jaw: { w: 14, h: 10 },
  tail_top: { w: 16, h: 16 },
  tail_side: { w: 16, h: 16 },
  scute: { w: 10, h: 10 },
  stripe: { w: 10, h: 10 },
  toe: { w: 10, h: 10 },
  arm: { w: 10, h: 10 },
  teeth: { w: 10, h: 10 },
  mouth: { w: 12, h: 10 },
  tongue: { w: 10, h: 8 },
  eye: { w: 8, h: 8 },
  claw: { w: 8, h: 8 },
  nostril: { w: 6, h: 6 },
};

/**
 * Shelf-pack the islands into a square atlas. Returns null when they do not fit, which
 * is what lets `layout()` grow the resolution instead of silently overlapping.
 */
const scaleDefs = (defs, k) =>
  Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [
      name,
      { w: Math.max(4, Math.round(def.w * k)), h: Math.max(4, Math.round(def.h * k)) },
    ]),
  );

function pack(size, defs) {
  const items = Object.entries(defs)
    .map(([name, def]) => ({ name, w: def.w, h: def.h }))
    .sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  const rects = {};
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const item of items) {
    if (x + item.w > size) {
      x = 0;
      y += shelf + 1;
      shelf = 0;
    }
    if (y + item.h > size) return null;
    rects[item.name] = [x, y, x + item.w, y + item.h];
    x += item.w + 1;
    if (item.h > shelf) shelf = item.h;
  }
  return { rects, size, used_height: y + shelf };
}

/**
 * The largest shrink of ISLAND_DEFS that a 64px sheet can hold.
 *
 * Fitting against a fixed 64px reference and *then* scaling the whole set by
 * `target / 64` is what lets the same layout come out at any resolution: fitting and
 * scaling are separate steps, so doubling the sheet doubles every island (real detail)
 * instead of re-running the same fit and landing on the same relative result.
 */
function fitAt64() {
  for (let s = 1; s >= 0.4; s -= 0.05) {
    const defs = scaleDefs(ISLAND_DEFS, s);
    const packed = pack(64, defs);
    if (packed) return { defs, shrink: Math.round(s * 100) / 100, packed };
  }
  throw new Error('ISLAND_DEFS cannot be fit into a 64px sheet — reduce the island sizes');
}

export const SHEET = 128;

/** The island rectangles for the final sheet, plus how tight the packing is. */
export function layout(target = SHEET) {
  const fit = fitAt64();
  const k = target / 64;
  const defs = scaleDefs(fit.defs, k);
  const packed = pack(target, defs);
  if (!packed) throw new Error(`island set does not fit in ${target}x${target}`);
  const area = Object.values(defs).reduce((sum, d) => sum + d.w * d.h, 0);
  return {
    rects: packed.rects,
    size: target,
    used_height: packed.used_height,
    shrink: fit.shrink,
    fill: Math.round((area / (target * target)) * 1000) / 1000,
  };
}

/** Which atlas island a cube face samples. */
export function islandFor(name, face) {
  if (/^tooth_/.test(name)) return 'teeth';
  if (/^nostril_/.test(name)) return 'nostril';
  if (name === 'tongue') return 'tongue';
  if (name === 'eye_left' || name === 'eye_right') {
    return face === 'east' || face === 'west' ? 'eye' : 'scute';
  }
  if (name === 'lower_jaw_cube') {
    if (face === 'up') return 'mouth';
    if (face === 'down') return 'skin_belly';
    return 'jaw';
  }
  if (/^jaw_back_/.test(name)) return 'jaw';
  if ((name === 'snout' || name === 'nose_tip') && face === 'down') return 'mouth';
  if (/^(skull|brow|brow_horn_|cheek_|snout|nose_tip)$/.test(name) || /^(brow_horn|cheek)_(left|right)$/.test(name)) {
    if (face === 'up') return 'head_top';
    if (face === 'down') return 'skin_belly';
    return 'head_side';
  }
  if (/^ridge_tail_/.test(name)) return 'scute';
  if (/^ridge_/.test(name)) return 'scute';
  if (/^toeclaw_/.test(name)) return 'claw';
  if (/(^|_)claw_[12]$/.test(name)) return 'claw';
  if (/^toe_/.test(name)) return 'toe';
  if (/^neck_cube_/.test(name)) {
    if (face === 'up') return 'skin_top';
    if (face === 'down') return 'skin_belly';
    return 'neck';
  }
  if (/^tail_cube_/.test(name)) {
    if (face === 'up') return 'tail_top';
    if (face === 'down') return 'skin_belly';
    return 'tail_side';
  }
  if (/^(left|right)_(thigh|knee|shin_cube|foot_cube)$/.test(name)) {
    return face === 'down' ? 'skin_belly' : 'leg';
  }
  if (/^(left|right)_(upper_arm|lower_arm)$/.test(name)) return 'arm';
  // torso, belly, pelvis, hips, chest
  if (face === 'up') return 'skin_top';
  if (face === 'down') return 'skin_belly';
  return 'skin_side';
}

/* ---------------------------------------------------------------- cube table */

/** Mirror a positive-x cube definition onto the right-hand side. */
function mirror(def) {
  const [x1, y1, z1] = def.from;
  const [x2, y2, z2] = def.to;
  return {
    ...def,
    name: def.name.replace(/^left_/, 'right_'),
    from: [-x2, y1, z1],
    to: [-x1, y2, z2],
    parent: def.parent.replace(/^left_/, 'right_'),
    origin: def.origin ? [-def.origin[0], def.origin[1], def.origin[2]] : undefined,
  };
}

/** Both sides of a pair, left first. */
function pair(def) {
  return [def, mirror(def)];
}

/**
 * A row of teeth on both sides. Names follow the `tooth_<jaw>_<side>_<index>` shape the
 * original build used, with the side spelled out per cube.
 */
function teeth(jaw, parent, count, rows) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const [from, to] = rows[i];
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? 1 : -1;
      const x1 = sign * from[0];
      const x2 = sign * to[0];
      out.push({
        name: `tooth_${jaw}_${side}_${i}`,
        from: [Math.min(x1, x2), from[1], from[2]],
        to: [Math.max(x1, x2), to[1], to[2]],
        parent,
      });
    }
  }
  return out;
}

/**
 * Hip height, in model units.
 *
 * The first version stood 20 units off the ground on a 106-unit-long body, so the legs
 * were 20% of the length where a T-Rex is closer to 29%. Everything above the hips is
 * lifted by LIFT and the leg chain is stretched to meet the ground, which moves the
 * model from a long, low lizard to a hip-forward, head-high theropod without touching
 * the overall length or the tail.
 */
const LIFT = 9;

/**
 * Cubes that must stay on the ground. Toes and the foot itself do not lift, and the
 * three leg cubes are replaced wholesale below rather than translated, because a longer
 * leg needs different proportions, not the same boxes moved up.
 */
const GROUNDED = /^(left|right)_(foot_cube|toe_|toeclaw_)/;

/** The stretched leg, keyed by name. Values are absolute model coordinates. */
const LEG_REPLACEMENTS = {
  left_thigh: { from: [3.0, 12.6, -8.4], to: [9.4, 29.4, 4.0], origin: [6.2, 29, -3] },
  right_thigh: { from: [-9.4, 12.6, -8.4], to: [-3.0, 29.4, 4.0], origin: [-6.2, 29, -3] },
  left_knee: { from: [4.2, 12.0, -1.2], to: [8.6, 17.6, 5.4] },
  right_knee: { from: [-8.6, 12.0, -1.2], to: [-4.2, 17.6, 5.4] },
  left_shin_cube: { from: [4.4, 5.0, -2.8], to: [7.8, 14.2, 2.4] },
  right_shin_cube: { from: [-7.8, 5.0, -2.8], to: [-4.4, 14.2, 2.4] },
  left_foot_cube: { from: [4.2, 0.4, -2.0], to: [8.6, 5.4, 6.8] },
  right_foot_cube: { from: [-8.6, 0.4, -2.0], to: [-4.2, 5.4, 6.8] },
};

const RAW_CUBES = [
  /* body ------------------------------------------------------------------ */
  // Seams overlap by several units on purpose. A torso split across two bones (body and
  // chest) otherwise opens a visible hole the moment the chest rotates or its scale
  // animation runs — the torso reaches to z=6 and the chest starts at z=2 so a 4-unit
  // sleeve hides the joint. Same reasoning for the neck: the chest now runs to z=15 and
  // neck_cube_01 reaches back to z=9, because the neck swings up to 24 degrees and a 2-unit
  // overlap simply cannot cover that.
  { name: 'torso', from: [-7, 17, -9], to: [7, 29, 6], parent: 'body' },
  { name: 'belly', from: [-5.6, 14.6, -8], to: [5.6, 19, 1.6], parent: 'body' },
  { name: 'pelvis', from: [-5.8, 28.4, -9.5], to: [5.8, 31, 2.5], parent: 'body' },
  { name: 'chest_block', from: [-6, 18, 2], to: [6, 30, 15], parent: 'chest' },
  { name: 'ridge_01', from: [-1.6, 29, -7], to: [1.6, 30.6, -3], parent: 'body' },
  { name: 'ridge_02', from: [-1.6, 29, -2], to: [1.6, 30.6, 2], parent: 'body' },
  { name: 'ridge_03', from: [-1.6, 30, 4], to: [1.6, 31.6, 8], parent: 'chest' },
  { name: 'ridge_04', from: [-1.4, 30, 9], to: [1.4, 31.6, 12], parent: 'chest' },
  ...pair({ name: 'left_hip', from: [6.6, 18.4, -8.6], to: [7.8, 26.4, 0.6], parent: 'body' }),

  /* neck ------------------------------------------------------------------ */
  { name: 'neck_cube_01', from: [-4.6, 23.6, 9], to: [4.6, 31, 17.6], parent: 'neck_01' },
  { name: 'neck_cube_02', from: [-4.4, 25.4, 15.6], to: [4.4, 33.2, 20.4], parent: 'neck_02' },
  { name: 'neck_cube_03', from: [-4.2, 26, 18.8], to: [4.2, 33.8, 23.4], parent: 'neck_03' },

  /* head ------------------------------------------------------------------ */
  { name: 'skull', from: [-5.4, 28.6, 19], to: [5.4, 38.2, 30], parent: 'head' },
  ...pair({ name: 'left_cheek', from: [5, 29.4, 21.6], to: [6.4, 34.6, 28.6], parent: 'head' }),
  { name: 'brow', from: [-4.8, 34.2, 26.4], to: [4.8, 37.8, 33], parent: 'head' },
  ...pair({ name: 'left_brow_horn', from: [4.4, 34.6, 27.4], to: [5.8, 37.4, 31.4], parent: 'head' }),
  { name: 'eye_left', from: [4.5, 33.4, 27.8], to: [5.7, 36.2, 30.4], parent: 'eyes' },
  { name: 'eye_right', from: [-5.7, 33.4, 27.8], to: [-4.5, 36.2, 30.4], parent: 'eyes' },

  /* upper jaw ------------------------------------------------------------- */
  { name: 'snout', from: [-4, 31, 30], to: [4, 37.2, 42], parent: 'upper_jaw' },
  { name: 'nose_tip', from: [-2.6, 32, 40], to: [2.6, 37.4, 44.4], parent: 'upper_jaw' },
  ...pair({ name: 'left_nostril', from: [1.2, 35.4, 40.4], to: [2.4, 36.8, 41.6], parent: 'upper_jaw' }),
  // Teeth carry explicit side names: `pair()` only renames cubes whose name starts with
  // `left_`, so a paired tooth would have been emitted twice under the left-hand name and
  // the original right-hand cubes would have been left unreshaped.
  ...teeth('upper', 'upper_jaw', 4, [
    [[2.9, 29, 32.3], [4, 31.2, 33.9]],
    [[2.9, 29, 35.2], [4, 31.2, 36.8]],
    [[2.9, 29, 38.0], [4, 31.2, 39.6]],
    [[2.6, 29.4, 40.6], [3.7, 32.0, 41.9]],
  ]),
  { name: 'tooth_upper_front_l', from: [1.0, 29.2, 41.2], to: [2.1, 31.6, 42.5], parent: 'upper_jaw' },
  { name: 'tooth_upper_front_r', from: [-2.1, 29.2, 41.2], to: [-1.0, 31.6, 42.5], parent: 'upper_jaw' },

  /* lower jaw ------------------------------------------------------------- */
  { name: 'lower_jaw_cube', from: [-4, 26.6, 27], to: [4, 30.6, 39.6], parent: 'lower_jaw' },
  ...pair({ name: 'left_jaw_back', from: [3.2, 27, 27], to: [4.6, 32, 31.2], parent: 'lower_jaw' }),
  { name: 'tongue', from: [-2.2, 29.6, 30], to: [2.2, 31, 38.4], parent: 'lower_jaw' },
  ...teeth('lower', 'lower_jaw', 2, [
    [[2.0, 30.4, 33.6], [3.0, 31.9, 35.1]],
    [[2.0, 30.4, 36.6], [3.0, 31.9, 38.1]],
  ]),
  { name: 'tooth_lower_front_l', from: [0.6, 30.4, 38.0], to: [1.7, 31.9, 39.3], parent: 'lower_jaw' },
  { name: 'tooth_lower_front_r', from: [-1.7, 30.4, 38.0], to: [-0.6, 31.9, 39.3], parent: 'lower_jaw' },

  /* arms ------------------------------------------------------------------ */
  ...pair({ name: 'left_upper_arm', from: [6.2, 23, 6.4], to: [8.4, 25.8, 9.6], parent: 'left_arm' }),
  // Named `forearm` rather than `lower_arm`: the original build called the bone and the
  // cube `left_lower_arm`, which makes every name-based tool call ambiguous.
  ...pair({ name: 'left_forearm', from: [6.4, 20.4, 6.8], to: [8.2, 23.2, 9.4], parent: 'left_lower_arm' }),
  ...pair({ name: 'left_claw_1', from: [6.3, 18.8, 7.0], to: [7.2, 20.6, 8.8], parent: 'left_claws' }),
  ...pair({ name: 'left_claw_2', from: [7.3, 18.8, 7.0], to: [8.1, 20.6, 8.8], parent: 'left_claws' }),

  /* legs ------------------------------------------------------------------ */
  ...pair({
    name: 'left_thigh',
    from: [3.0, 8.8, -8.4],
    to: [9.4, 20.4, 4.0],
    parent: 'left_leg',
    origin: [6.2, 20, -3],
    rotation: [-8, 0, 0],
  }),
  ...pair({ name: 'left_knee', from: [4.2, 8.0, -1.2], to: [8.6, 11.8, 5.4], parent: 'left_shin' }),
  ...pair({ name: 'left_shin_cube', from: [4.4, 3.2, -2.8], to: [7.8, 9.6, 2.4], parent: 'left_shin' }),
  ...pair({ name: 'left_foot_cube', from: [4.2, 0.4, -2.0], to: [8.6, 4.2, 6.8], parent: 'left_foot' }),
  ...pair({ name: 'left_toe_1', from: [4.5, 0, 6.4], to: [5.7, 2.8, 9.8], parent: 'left_toes' }),
  ...pair({ name: 'left_toe_2', from: [5.8, 0, 6.4], to: [7.0, 2.8, 10.4], parent: 'left_toes' }),
  ...pair({ name: 'left_toe_3', from: [7.1, 0, 6.4], to: [8.3, 2.8, 9.8], parent: 'left_toes' }),
  ...pair({ name: 'left_toeclaw_1', from: [4.6, 0, 9.6], to: [5.6, 1.7, 11.3], parent: 'left_toes' }),
  ...pair({ name: 'left_toeclaw_2', from: [5.9, 0, 10.2], to: [6.9, 1.7, 11.9], parent: 'left_toes' }),
  ...pair({ name: 'left_toeclaw_3', from: [7.2, 0, 9.6], to: [8.2, 1.7, 11.3], parent: 'left_toes' }),

  /* tail ------------------------------------------------------------------ */
  { name: 'tail_cube_1', from: [-5.6, 17.6, -17], to: [5.6, 27.4, -9], parent: 'tail_01' },
  { name: 'tail_cube_2', from: [-4.8, 18.6, -25], to: [4.8, 26.6, -17], parent: 'tail_02' },
  { name: 'tail_cube_3', from: [-4.0, 19.6, -33], to: [4.0, 25.8, -25], parent: 'tail_03' },
  { name: 'tail_cube_4', from: [-3.2, 20.4, -41], to: [3.2, 25.2, -33], parent: 'tail_04' },
  { name: 'tail_cube_5', from: [-2.4, 21.2, -49], to: [2.4, 24.8, -41], parent: 'tail_05' },
  { name: 'tail_cube_6', from: [-1.7, 21.8, -56], to: [1.7, 24.4, -49], parent: 'tail_06' },
  { name: 'tail_cube_7', from: [-1.1, 22.0, -62], to: [1.1, 24.6, -55.5], parent: 'tail_07' },
  { name: 'ridge_tail_01', from: [-1.4, 27.2, -16], to: [1.4, 28.6, -11], parent: 'tail_01' },
  { name: 'ridge_tail_02', from: [-1.2, 26.4, -24], to: [1.2, 27.8, -19], parent: 'tail_02' },
];

/** Translate a cube up by LIFT, unless it belongs on the ground. */
function lift(def) {
  if (GROUNDED.test(def.name)) return def;
  const shift = (point) => [point[0], point[1] + LIFT, point[2]];
  return {
    ...def,
    from: shift(def.from),
    to: shift(def.to),
    ...(def.origin ? { origin: shift(def.origin) } : {}),
  };
}

/** Rebuild a long leg from the hip down to a foot that is still on the floor. */
function stretchLeg(def) {
  const replacement = LEG_REPLACEMENTS[def.name];
  if (!replacement) return def;
  return { ...def, ...replacement, rotation: def.rotation ?? [0, 0, 0] };
}

export const CUBES = RAW_CUBES.map(lift).map(stretchLeg);

/**
 * Cubes that must be renamed before the rest of the table is applied. The original build
 * gave a bone and a cube the same name, so `modify_node {name: "left_lower_arm"}`
 * matched two nodes and every such call failed with "ambiguous".
 */
export const RENAMES = {
  left_lower_arm: 'left_forearm',
  right_lower_arm: 'right_forearm',
  left_foot: 'left_foot_cube',
  right_foot: 'right_foot_cube',
};

/** Groups to create if they do not exist yet, with their pivots. */
export const NEW_GROUPS = [
  ['neck_03', [0, 32 + LIFT, 19.4], 'neck_02'],
];

/** Bone pivots. The leg chain is stated outright; everything else rises with the body. */
const RAW_PIVOTS = {
  body: [0, 22.4, -4],
  chest: [0, 24, 4],
  neck_01: [0, 27, 12],
  neck_02: [0, 30, 17],
  neck_03: [0, 32, 19.4],
  head: [0, 33.6, 23.0],
  upper_jaw: [0, 33.4, 31.0],
  lower_jaw: [0, 30.6, 27.6],
  eyes: [0, 35, 31.4],
  left_leg: [6.2, 29, -3],
  left_shin: [6.2, 14.5, 1.6],
  left_foot: [6.2, 5.2, -1.0],
  left_toes: [6.2, 2.6, 6.6],
  right_leg: [-6.2, 29, -3],
  right_shin: [-6.2, 14.5, 1.6],
  right_foot: [-6.2, 5.2, -1.0],
  right_toes: [-6.2, 2.6, 6.6],
  left_arm: [6.5, 25.4, 7],
  left_lower_arm: [7.2, 23.2, 7.6],
  left_claws: [7.2, 20.6, 7.6],
  right_arm: [-6.5, 25.4, 7],
  right_lower_arm: [-7.2, 23.2, 7.6],
  right_claws: [-7.2, 20.6, 7.6],
  tail_01: [0, 22.4, -9],
  tail_02: [0, 22.4, -17],
  tail_03: [0, 22.4, -25],
  tail_04: [0, 22.4, -33],
  tail_05: [0, 22.4, -41],
  tail_06: [0, 22.4, -49],
  tail_07: [0, 22.4, -56],
};

/** The leg pivots are absolute; every other bone rides up with the body. */
const GROUNDED_BONES = /^(left|right)_(leg|shin|foot|toes)$/;

export const PIVOTS = Object.fromEntries(
  Object.entries(RAW_PIVOTS).map(([name, pivot]) => [
    name,
    GROUNDED_BONES.test(name) ? pivot : [pivot[0], pivot[1] + LIFT, pivot[2]],
  ]),
);

/* ------------------------------------------------------------------- texture */

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

function hash01(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Paint the atlas.
 *
 * Every island is painted as a material, in atlas space, so the art is
 * scale-invariant: a face can be any size and still sample a sensible patch.
 */
export function paintAtlas(rects, size) {
  const png = new PNG({ width: size, height: size });
  const px = png.data;
  const set = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = clamp255(colour[0]);
    px[i + 1] = clamp255(colour[1]);
    px[i + 2] = clamp255(colour[2]);
    px[i + 3] = 255;
  };
  const rect = (name) => rects[name];
  const inside = (r, x, y) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

  /** Iterate every pixel of an island with normalised coordinates and an edge flag. */
  const each = (name, fn) => {
    const r = rect(name);
    if (!r) return;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    for (let y = r[1]; y < r[3]; y += 1) {
      for (let x = r[0]; x < r[2]; x += 1) {
        const u = (x - r[0] + 0.5) / w;
        const v = (y - r[1] + 0.5) / h;
        fn(x, y, u, v, u < 0.08 || u > 0.92 || v < 0.08 || v > 0.92);
      }
    }
  };

  /** Fine noise plus soft blotches — the "skin grain" every Minecraft texture needs. */
  const grain = (x, y, seed, amount) =>
    (hash01(`${seed}:${x}:${y}`) - 0.5) * amount + (hash01(`${seed}:${x >> 1}:${y >> 1}`) - 0.5) * amount * 0.7;

  const SKIN = {
    light: hex('#a8bf72'),
    mid: hex('#6d8544'),
    dark: hex('#3c4a26'),
    belly: hex('#b3bb8e'),
    bellyDark: hex('#8f9a6c'),
    scute: hex('#4b5a2b'),
    stripe: hex('#41502a'),
    claw: hex('#cbc4ad'),
    clawDark: hex('#4a4438'),
    tooth: hex('#f2eddc'),
    toothRoot: hex('#c9c0a0'),
  };

  /* -- skin: side faces get the vertical gradient ------------------------- */
  const gradedSkin = (name, top, bottom, seed, options = {}) =>
    each(name, (x, y, u, v, edge) => {
      const t = Math.pow(v, 0.92) * (options.rush ?? 1);
      let colour = mix(top, bottom, Math.min(1, t));
      // vertical dorsal stripes, strongest at the top
      if (options.stripes) {
        const band = Math.sin(u * Math.PI * 2 * options.stripes + (options.phase ?? 0));
        if (band > 0.55) colour = mix(colour, SKIN.stripe, 0.45 * (1 - v * 0.5));
      }
      if (options.muscle) {
        const fibre = Math.abs(Math.sin(u * Math.PI * options.muscle));
        colour = mix(colour, mix(colour, SKIN.light, 0.35), fibre * 0.5);
      }
      if (edge) colour = mix(colour, SKIN.dark, 0.3);
      set(x, y, colour.map((c) => c + grain(x, y, seed, options.grit ?? 20)));
    });

  /** Flat, light islands for `up` faces: mild mottling plus scute rows. */
  const dorsalSkin = (name, base, seed, rows = 3, grit = 20) =>
    each(name, (x, y, u, v, edge) => {
      let colour = base;
      for (let i = 1; i <= rows; i += 1) {
        const line = i / (rows + 1);
        if (Math.abs(v - line) < 0.045) colour = mix(colour, SKIN.scute, 0.5);
        else if (Math.abs(v - line) < 0.1) colour = mix(colour, SKIN.scute, 0.18);
      }
      colour = mix(colour, SKIN.light, (1 - v) * 0.16);
      if (edge) colour = mix(colour, SKIN.dark, 0.28);
      set(x, y, colour.map((c) => c + grain(x, y, seed, grit)));
    });

  gradedSkin('skin_side', SKIN.light, SKIN.dark, 'side', { stripes: 3, grit: 22 });
  dorsalSkin('skin_top', hex('#93ab63'), 'top', 4);
  gradedSkin('skin_belly', SKIN.belly, SKIN.bellyDark, 'belly', { grit: 14 });
  gradedSkin('leg', hex('#8ba257'), hex('#3f4c25'), 'leg', { muscle: 3, grit: 20 });
  dorsalSkin('head_top', hex('#879f57'), 'headtop', 2, 24);
  gradedSkin('head_side', hex('#9cb46a'), hex('#4a5a2c'), 'headside', { grit: 22 });
  gradedSkin('neck', hex('#a2b96d'), hex('#46542a'), 'neck', { stripes: 2, grit: 20 });
  gradedSkin('jaw', hex('#93aa62'), hex('#55663a'), 'jaw', { grit: 18 });
  dorsalSkin('tail_top', hex('#8fa75f'), 'tailtop', 5, 22);
  gradedSkin('tail_side', hex('#9ab167'), hex('#414f27'), 'tailside', { stripes: 4, grit: 22 });
  gradedSkin('toe', hex('#7f9350'), hex('#4d5a2f'), 'toe', { muscle: 2, grit: 18 });
  gradedSkin('arm', hex('#89a054'), hex('#42502a'), 'arm', { muscle: 2, grit: 18 });

  /* -- scutes and stripes -------------------------------------------------- */
  each('scute', (x, y, u, v, edge) => {
    let colour = mix(SKIN.scute, SKIN.mid, 0.25);
    if (Math.abs(u - 0.5) < 0.12) colour = mix(colour, SKIN.dark, 0.3);
    if (edge) colour = mix(colour, SKIN.dark, 0.45);
    set(x, y, colour.map((c) => c + grain(x, y, 'scute', 16)));
  });
  each('stripe', (x, y, u, v, edge) => {
    let colour = mix(SKIN.stripe, SKIN.mid, 0.2);
    if (Math.abs(u - 0.5) < 0.16) colour = mix(colour, SKIN.light, 0.18);
    if (edge) colour = mix(colour, SKIN.dark, 0.4);
    set(x, y, colour.map((c) => c + grain(x, y, 'stripe', 14)));
  });

  /* -- teeth: cream crown, darker root ------------------------------------- */
  each('teeth', (x, y, u, v, edge) => {
    let colour = mix(SKIN.tooth, SKIN.toothRoot, Math.pow(v, 1.6));
    if (v < 0.16) colour = mix(colour, [255, 255, 250], 0.5);
    if (edge) colour = mix(colour, SKIN.toothRoot, 0.5);
    if (u > 0.42 && u < 0.58 && v > 0.35) colour = mix(colour, SKIN.toothRoot, 0.6);
    set(x, y, colour.map((c) => c + grain(x, y, 'teeth', 8)));
  });

  /* -- claws: dark base to bone tip ---------------------------------------- */
  each('claw', (x, y, u, v, edge) => {
    let colour = mix(SKIN.clawDark, SKIN.claw, Math.pow(1 - v, 1.35));
    if (colour[0] < 40 && colour[1] < 40) {
      colour = SKIN.clawDark;
      set(x, y, colour);
      return;
    }
    if (edge) colour = mix(colour, SKIN.clawDark, 0.4);
    set(x, y, colour.map((c) => c + grain(x, y, 'claw', 12)));
  });

  /* -- eye: dark socket, amber iris, black pupil, glint -------------------- */
  each('eye', (x, y, u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy);
    let colour = hex('#141210');
    if (r < 0.42) colour = hex('#e2a63b');
    if (r < 0.3) colour = hex('#b07a1e');
    if (r < 0.19) colour = hex('#0c0b09');
    if (Math.hypot(u - 0.42, v - 0.4) < 0.09) colour = hex('#f8f4e4');
    set(x, y, colour.map((c) => c + grain(x, y, 'eye', 10)));
  });

  /* -- mouth interior, tongue, nostril ------------------------------------- */
  each('mouth', (x, y, u, v, edge) => {
    let colour = mix(hex('#8a3742'), hex('#4d1b23'), Math.pow(v, 1.2));
    if (edge) colour = mix(colour, hex('#ab5a63'), 0.5);
    set(x, y, colour.map((c) => c + grain(x, y, 'mouth', 16)));
  });
  each('tongue', (x, y, u, v, edge) => {
    let colour = mix(hex('#c0626d'), hex('#7c323a'), Math.pow(v, 1.4));
    if (Math.abs(u - 0.5) < 0.1) colour = mix(colour, hex('#6d2830'), 0.5);
    if (edge) colour = mix(colour, hex('#8d424c'), 0.4);
    set(x, y, colour.map((c) => c + grain(x, y, 'tongue', 14)));
  });
  each('nostril', (x, y, u, v) => {
    const d = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
    let colour = mix(hex('#33402a'), hex('#0f150b'), 1 - d * 2);
    set(x, y, colour.map((c) => c + grain(x, y, 'nostril', 10)));
  });

  // Any pixel not written by an island stays transparent; fill it with the flank
  // colour so a stray UV lands on skin rather than on a hole.
  const flank = hex('#6d8544');
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (px[i + 3] === 0) {
        px[i] = flank[0] + grain(x, y, 'void', 14);
        px[i + 1] = flank[1] + grain(x, y, 'void', 14);
        px[i + 2] = flank[2] + grain(x, y, 'void', 14);
        px[i + 3] = 255;
      }
    }
  }
  void inside;

  return PNG.sync.write(png);
}

/** Convenience: the atlas PNG plus the rectangle table used to paint it. */
export function buildAtlas() {
  const { rects, size, fill } = layout();
  return { rects, size, fill, png: paintAtlas(rects, size) };
}
