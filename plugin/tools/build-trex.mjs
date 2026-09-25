#!/usr/bin/env node
/**
 * Autonomous T-Rex build.
 *
 * This is the agent side of the loop: every model change below goes through the
 * bridge's tool registry exactly the way an LLM-driven run would call it — no direct
 * DOM access, no hand-editing of the .bbmodel. Phases:
 *
 *   OBSERVE  preflight (health, project, checkpoint, reference images)
 *   PLAN     the skeleton, cube table, UV policy and animation set are declared here
 *   BUILD    settings → texture → groups → cubes → UV
 *   ANIMATE  25 animations authored as pose functions
 *   INSPECT  six viewport angles + programmatic silhouette metrics
 *   VERIFY   validate_model, then save, then reload from disk and re-inspect
 *
 * Usage:
 *   node tools/build-trex.mjs                 # everything
 *   node tools/build-trex.mjs --only uv,shots # a subset
 *   node tools/build-trex.mjs --skip-save
 *
 * Requires the bridge on 127.0.0.1:47311 with Blockbench connected.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
const BASE = process.env.AI_AGENT_BRIDGE ?? 'http://127.0.0.1:47311';
const PROJECT_FILE = path.join(WORKSPACE, 'trex.bbmodel');
const VIEWPORT_DIR = path.join(WORKSPACE, 'ai_context', 'viewport');
const TEXTURE_SIZE = 64;

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf('--only');
const ONLY = onlyIndex === -1 ? null : new Set(argv[onlyIndex + 1].split(','));
const SKIP_SAVE = argv.includes('--skip-save');

const run = (phase) => !ONLY || ONLY.has(phase);

/* ------------------------------------------------------------------ helpers */

const t0 = Date.now();
function log(step, message) {
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${step.padEnd(9)} ${message}`);
}
function warn(message) {
  console.log(`           ! ${message}`);
}

async function call(tool, args = {}) {
  const response = await fetch(`${BASE}/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!body.ok) {
    const message = body.error?.message ?? JSON.stringify(body.error ?? body);
    const failure = new Error(`${tool} failed: ${message}`);
    failure.tool = tool;
    failure.payload = body;
    throw failure;
  }
  for (const line of body.warnings ?? []) warn(`${tool}: ${line}`);
  return body.data;
}

async function health() {
  const response = await fetch(`${BASE}/health`);
  return response.json();
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function kf(node, channel, time, x, y, z, interpolation = 'catmullrom') {
  return { node, channel, time: round3(time), x: round3(x), y: round3(y), z: round3(z), interpolation };
}
const rot = (node, time, x, y, z, interpolation) => kf(node, 'rotation', time, x, y, z, interpolation);
const pos = (node, time, x, y, z, interpolation) => kf(node, 'position', time, x, y, z, interpolation);
const scale = (node, time, x, y, z, interpolation) => kf(node, 'scale', time, x, y, z, interpolation);
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/* --------------------------------------------------------------- the plan */
/*
 * Coordinate frame (verified against the geometry, not assumed): the model faces +Z,
 * Y is up, ground plane y = 0, and the model's LEFT is +X. Rotation signs used by the
 * pose functions below follow from that:
 *   -X rotation swings a limb below its pivot forward (+Z)
 *   +X rotation drops whatever sits in front of the pivot (nod, jaw open)
 *   +Y rotation turns toward the model's left
 *   +X rotation on the tail (behind its pivot) lifts it
 */

const GROUPS = [
  // name,          pivot,                 parent
  ['root', [0, 0, 0], null],
  ['body', [0, 22, -4], 'root'],
  ['chest', [0, 24, 4], 'body'],
  ['neck_01', [0, 27, 12], 'chest'],
  ['neck_02', [0, 30, 17], 'neck_01'],
  ['head', [0, 32, 20], 'neck_02'],
  ['upper_jaw', [0, 33, 30], 'head'],
  ['lower_jaw', [0, 30.5, 27.5], 'head'],
  ['eyes', [0, 35, 31], 'head'],
  ['left_arm', [6.5, 25, 7], 'chest'],
  ['left_lower_arm', [7, 22, 7.5], 'left_arm'],
  ['left_claws', [7, 20, 7.5], 'left_lower_arm'],
  ['right_arm', [-6.5, 25, 7], 'chest'],
  ['right_lower_arm', [-7, 22, 7.5], 'right_arm'],
  ['right_claws', [-7, 20, 7.5], 'right_lower_arm'],
  ['left_leg', [6, 19, -2], 'body'],
  ['left_shin', [6, 9.5, -1], 'left_leg'],
  ['left_foot', [6, 4, 0], 'left_shin'],
  ['left_toes', [6, 3, 7], 'left_foot'],
  ['right_leg', [-6, 19, -2], 'body'],
  ['right_shin', [-6, 9.5, -1], 'right_leg'],
  ['right_foot', [-6, 4, 0], 'right_shin'],
  ['right_toes', [-6, 3, 7], 'right_foot'],
  ['tail_01', [0, 22, -9], 'body'],
  ['tail_02', [0, 22, -17], 'tail_01'],
  ['tail_03', [0, 22, -25], 'tail_02'],
  ['tail_04', [0, 22, -33], 'tail_03'],
  ['tail_05', [0, 22, -41], 'tail_04'],
  ['tail_06', [0, 22, -49], 'tail_05'],
  ['tail_07', [0, 22, -56], 'tail_06'],
];

const cube = (name, from, to, parent) => ({ name, from, to, parent });

const CUBES = [
  // torso
  cube('torso', [-7, 17, -9], [7, 29, 3], 'body'),
  cube('chest_block', [-6, 18, 3], [6, 30, 13], 'chest'),
  cube('ridge_01', [-1.6, 29, -7], [1.6, 31.5, -3], 'body'),
  cube('ridge_02', [-1.6, 29, -2], [1.6, 31.5, 2], 'body'),
  cube('ridge_03', [-1.6, 30, 4], [1.6, 32.5, 8], 'chest'),
  cube('ridge_04', [-1.4, 30, 9], [1.4, 32.5, 12], 'chest'),
  // neck
  cube('neck_cube_01', [-4.5, 24, 11], [4.5, 31, 17], 'neck_01'),
  cube('neck_cube_02', [-4, 26, 16], [4, 34, 22], 'neck_02'),
  // head
  cube('skull', [-5, 29, 20], [5, 38, 30], 'head'),
  cube('brow', [-4.6, 34, 27], [4.6, 37.5, 33], 'head'),
  cube('snout', [-4, 31, 30], [4, 37, 42], 'upper_jaw'),
  cube('nose_tip', [-3, 32, 40], [3, 37.5, 44], 'upper_jaw'),
  cube('lower_jaw_cube', [-3, 26.5, 27], [3, 30.5, 39], 'lower_jaw'),
  cube('tongue', [-2, 29.6, 30], [2, 30.9, 38], 'lower_jaw'),
];

// Teeth: upper teeth hang from the snout and sit proud of the narrower jaw so a toothy
// line stays visible with the mouth closed; lower teeth only show when it opens.
for (const side of [1, -1]) {
  const tag = side > 0 ? 'left' : 'right';
  [33, 36, 39].forEach((z, index) => {
    const x1 = side * 2.8;
    const x2 = side * 4.0;
    CUBES.push(
      cube(
        `tooth_upper_${tag}_${index}`,
        [Math.min(x1, x2), 29, z - 0.7],
        [Math.max(x1, x2), 31, z + 0.7],
        'upper_jaw',
      ),
    );
  });
  [34.5, 37.5].forEach((z, index) => {
    const x1 = side * 1.9;
    const x2 = side * 2.9;
    CUBES.push(
      cube(
        `tooth_lower_${tag}_${index}`,
        [Math.min(x1, x2), 30.5, z - 0.6],
        [Math.max(x1, x2), 31.9, z + 0.6],
        'lower_jaw',
      ),
    );
  });
}
// front teeth
CUBES.push(
  cube('tooth_upper_front_l', [1, 29, 40.4], [2.2, 31, 41.6], 'upper_jaw'),
  cube('tooth_upper_front_r', [-2.2, 29, 40.4], [-1, 31, 41.6], 'upper_jaw'),
  cube('tooth_lower_front_l', [0.6, 30.5, 38.2], [1.7, 31.9, 39.2], 'lower_jaw'),
  cube('tooth_lower_front_r', [-1.7, 30.5, 38.2], [-0.6, 31.9, 39.2], 'lower_jaw'),
);

// eyes
CUBES.push(
  cube('eye_left', [4.2, 33.6, 28], [5.6, 36.6, 30.6], 'eyes'),
  cube('eye_right', [-5.6, 33.6, 28], [-4.2, 36.6, 30.6], 'eyes'),
);

// arms (tiny)
for (const side of [1, -1]) {
  const tag = side > 0 ? 'left' : 'right';
  const box = (x1, x2) => [Math.min(side * x1, side * x2), Math.max(side * x1, side * x2)];
  const [a1, a2] = box(6.2, 8.2);
  CUBES.push(cube(`${tag}_upper_arm`, [a1, 23, 6.6], [a2, 25.6, 9.4], `${tag}_arm`));
  const [b1, b2] = box(6.4, 8.0);
  CUBES.push(cube(`${tag}_lower_arm`, [b1, 20.6, 6.9], [b2, 23, 9.2], `${tag}_lower_arm`));
  const [c1, c2] = box(6.4, 7.3);
  const [d1, d2] = box(7.3, 8.0);
  CUBES.push(
    cube(`${tag}_claw_1`, [c1, 19, 7.2], [c2, 20.6, 8.8], `${tag}_claws`),
    cube(`${tag}_claw_2`, [d1, 19, 7.2], [d2, 20.6, 8.8], `${tag}_claws`),
  );
}

// legs (powerful, digitigrade) + three-claw feet
for (const side of [1, -1]) {
  const tag = side > 0 ? 'left' : 'right';
  const box = (x1, x2) => [Math.min(side * x1, side * x2), Math.max(side * x1, side * x2)];
  const [t1, t2] = box(3.4, 8.8);
  const [s1, s2] = box(4.6, 7.9);
  const [f1, f2] = box(4.4, 8.4);
  CUBES.push(
    cube(`${tag}_thigh`, [t1, 9, -7], [t2, 19.6, 3], `${tag}_leg`),
    cube(`${tag}_shin_cube`, [s1, 3.6, -2.4], [s2, 9.6, 2.6], `${tag}_shin`),
    cube(`${tag}_foot`, [f1, 0.4, -1.4], [f2, 4, 6.8], `${tag}_foot`),
    cube(`${tag}_toe_1`, ...(() => { const [a, b] = box(4.5, 5.7); return [[a, 0, 6.4], [b, 2.8, 9.6]]; })(), `${tag}_toes`),
    cube(`${tag}_toe_2`, ...(() => { const [a, b] = box(5.8, 7.0); return [[a, 0, 6.4], [b, 2.8, 10.2]]; })(), `${tag}_toes`),
    cube(`${tag}_toe_3`, ...(() => { const [a, b] = box(7.1, 8.3); return [[a, 0, 6.4], [b, 2.8, 9.6]]; })(), `${tag}_toes`),
  );
}

// tail: seven tapering segments
const TAIL = [
  [-5.4, 18, -17, 5.4, 27, -9],
  [-4.9, 18.5, -25, 4.9, 26, -17],
  [-4.3, 19, -33, 4.3, 25, -25],
  [-3.6, 19.5, -41, 3.6, 24.5, -33],
  [-2.9, 20, -49, 2.9, 24, -41],
  [-2.1, 20.5, -56, 2.1, 23.5, -49],
  [-1.3, 21, -62, 1.3, 23, -56],
];
TAIL.forEach((entry, index) => {
  const [x1, y1, z1, x2, y2, z2] = entry;
  CUBES.push(cube(`tail_cube_${index + 1}`, [x1, y1, z1], [x2, y2, z2], `tail_0${index + 1}`));
});

const TAIL_BONES = ['tail_01', 'tail_02', 'tail_03', 'tail_04', 'tail_05', 'tail_06', 'tail_07'];

/* ---------------------------------------------------------------- texture */

const PALETTE = {
  teeth: [0, 0, 4, 4],
  claw: [4, 0, 8, 4],
  eye_black: [8, 0, 12, 4],
  eye_right: [12, 0, 16, 4],
  mouth: [0, 4, 4, 8],
  tongue: [4, 4, 8, 8],
  eye_left: [8, 4, 12, 8],
  nostril: [12, 4, 16, 8],
  belly: [0, 8, 4, 12],
  scute: [4, 8, 8, 12],
  stripe: [8, 8, 12, 12],
  gum: [12, 8, 16, 12],
  mid: [0, 12, 4, 16],
  shadow: [4, 12, 8, 16],
  light: [8, 12, 12, 16],
  spare: [12, 12, 16, 16],
};

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const SKIN_LIGHT = hex('#b0c775'); // sun-lit back
const SKIN_DARK = hex('#3a4726'); // shadowed underside

function noise2(x, y, periodX) {
  const wrap = (value) => {
    if (!periodX) return value;
    return ((value % periodX) + periodX) % periodX;
  };
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (ix, iy) => {
    const h = hashString(`${wrap(ix)}:${iy}`);
    return (h % 100000) / 100000;
  };
  const top = lerp(sample(x0, y0), sample(x0 + 1, y0), smooth(fx));
  const bottom = lerp(sample(x0, y0 + 1), sample(x0 + 1, y0 + 1), smooth(fx));
  return lerp(top, bottom, smooth(fy));
}

function fillRect(pixels, rect, color, jitter = 0, seed = 0) {
  const [x1, y1, x2, y2] = rect;
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const offset = jitter ? (noise2(x * 0.7 + seed, y * 0.7, 0) - 0.5) * jitter : 0;
      setPixel(pixels, x, y, [
        clamp(Math.round(color[0] + offset), 0, 255),
        clamp(Math.round(color[1] + offset), 0, 255),
        clamp(Math.round(color[2] + offset), 0, 255),
        255,
      ]);
    }
  }
}

function setPixel(pixels, x, y, rgba) {
  const index = (y * TEXTURE_SIZE + x) * 4;
  pixels[index] = rgba[0];
  pixels[index + 1] = rgba[1];
  pixels[index + 2] = rgba[2];
  pixels[index + 3] = rgba[3];
}

function drawEye(pixels, rect, mirror) {
  const [x1, y1, x2, y2] = rect;
  fillRect(pixels, rect, hex('#e8a33d'), 10, 7);
  const cx = Math.round((x1 + x2) / 2);
  const cy = Math.round((y1 + y2) / 2);
  const pupilX = mirror ? cx - 1 : cx;
  for (let y = cy - 1; y < cy + 1; y += 1) {
    for (let x = pupilX - 1; x < pupilX + 1; x += 1) setPixel(pixels, x, y, [13, 13, 13, 255]);
  }
  // brow shadow along the top edge
  for (let x = x1; x < x2; x += 1) setPixel(pixels, x, y1, [92, 66, 24, 255]);
}

function buildTexture() {
  const png = new PNG({ width: TEXTURE_SIZE, height: TEXTURE_SIZE });
  const pixels = png.data;

  // skin field: u ∈ [16, 64), v ∈ [0, 64) — light at the top, dark at the bottom
  for (let v = 0; v < TEXTURE_SIZE; v += 1) {
    const t = Math.pow((v + 0.5) / TEXTURE_SIZE, 1.08);
    for (let u = 16; u < TEXTURE_SIZE; u += 1) {
      const mottle = (noise2(u / 6, v / 4, 8) - 0.5) * 0.2;
      const blotch = noise2(u / 14 + 5, v / 10 + 3, 3.4) > 0.62 ? -0.07 : 0;
      const grain = (noise2(u * 1.7, v * 1.7, 0) - 0.5) * 0.06;
      const shade = clamp(t + mottle + blotch + grain, 0, 1);
      setPixel(pixels, u, v, [
        Math.round(lerp(SKIN_LIGHT[0], SKIN_DARK[0], shade)),
        Math.round(lerp(SKIN_LIGHT[1], SKIN_DARK[1], shade)),
        Math.round(lerp(SKIN_LIGHT[2], SKIN_DARK[2], shade)),
        255,
      ]);
    }
  }

  // palette islands
  fillRect(pixels, PALETTE.teeth, hex('#f4efd8'), 8, 1);
  fillRect(pixels, PALETTE.claw, hex('#2e2b26'), 8, 2);
  fillRect(pixels, PALETTE.eye_black, hex('#0d0d0d'), 4, 3);
  drawEye(pixels, PALETTE.eye_right, true);
  drawEye(pixels, PALETTE.eye_left, false);
  fillRect(pixels, PALETTE.mouth, hex('#7e3040'), 12, 4);
  fillRect(pixels, PALETTE.tongue, hex('#c46a78'), 10, 5);
  fillRect(pixels, PALETTE.nostril, hex('#3b4726'), 8, 6);
  fillRect(pixels, PALETTE.belly, hex('#3e4a28'), 10, 8);
  fillRect(pixels, PALETTE.scute, hex('#55692f'), 12, 9);
  fillRect(pixels, PALETTE.stripe, hex('#5e7435'), 12, 10);
  fillRect(pixels, PALETTE.gum, hex('#9a4a55'), 10, 11);
  fillRect(pixels, PALETTE.mid, hex('#6e8745'), 10, 12);
  fillRect(pixels, PALETTE.shadow, hex('#455231'), 10, 13);
  fillRect(pixels, PALETTE.light, hex('#93ae63'), 10, 14);
  fillRect(pixels, PALETTE.spare, hex('#6e8745'), 10, 15);

  return PNG.sync.write(png);
}

/* --------------------------------------------------------------------- UV */
/*
 * Policy: every face samples the skin field, anchored by the cube's height in the
 * model, so the gradient alone produces "lighter upper surfaces, darker underside"
 * with no painted-on shading. Small parts that must read as material rather than skin
 * (teeth, claws, eyes, mouth interior, tongue) get dedicated palette islands. Faces
 * deliberately share skin regions — that is how Minecraft models are textured — but no
 * two rectangles disagree about where they point, so the layout stays predictable.
 */

function faceSize(definition, face) {
  const [x1, y1, z1] = definition.from;
  const [x2, y2, z2] = definition.to;
  const width = x2 - x1;
  const height = y2 - y1;
  const depth = z2 - z1;
  if (face === 'north' || face === 'south') return [width, height];
  if (face === 'east' || face === 'west') return [depth, height];
  return [width, depth];
}

const FACES = ['north', 'south', 'east', 'west', 'up', 'down'];

function paletteFor(name, face) {
  if (name.startsWith('tooth_')) return PALETTE.teeth;
  if (name.startsWith('toe_')) return PALETTE.claw;
  if (name.endsWith('_claw_1') || name.endsWith('_claw_2')) return PALETTE.claw;
  if (name === 'tongue') return PALETTE.tongue;
  if (name === 'eye_left') return face === 'east' ? PALETTE.eye_left : PALETTE.eye_black;
  if (name === 'eye_right') return face === 'west' ? PALETTE.eye_right : PALETTE.eye_black;
  if (name === 'lower_jaw_cube' && face === 'up') return PALETTE.mouth;
  if ((name === 'snout' || name === 'nose_tip') && face === 'down') return PALETTE.mouth;
  if (name === 'lower_jaw_cube' && face === 'down') return PALETTE.belly;
  if (name === 'torso' && face === 'down') return PALETTE.belly;
  if (name === 'chest_block' && face === 'down') return PALETTE.belly;
  if (name.startsWith('ridge_')) return PALETTE.scute;
  if (name.startsWith('neck_cube') && face === 'down') return PALETTE.belly;
  return null;
}

function uvForFace(definition, face) {
  const palette = paletteFor(definition.name, face);
  if (palette) return palette;
  const [width, height] = faceSize(definition, face);
  const w = clamp(Math.round(width), 1, 48);
  const h = clamp(Math.round(height), 1, 62);
  const centerY = (definition.from[1] + definition.to[1]) / 2;
  let v = 20 + (1 - clamp(centerY / 38, 0, 1)) * 38;
  if (face === 'up') v -= 7;
  else if (face === 'down') v += 6;
  v = Math.round(clamp(v, 1, TEXTURE_SIZE - h - 1));
  const span = 48 - w;
  const u = 16 + (span > 0 ? hashString(`${definition.name}|${face}`) % span : 0);
  return [u, v, u + w, v + h];
}

/* -------------------------------------------------------------- animations */

const ANIMATIONS = [];
function animation(spec) {
  ANIMATIONS.push(spec);
}

/** Sample a 0..1 cycle and emit a channel from a function of normalised time. */
function cycle(node, channel, length, samples, fn, interpolation = 'catmullrom') {
  const out = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const value = fn(t);
    if (value === null) continue;
    const time = t * length;
    if (Array.isArray(value)) out.push(kf(node, channel, time, value[0], value[1], value[2], interpolation));
    else out.push(kf(node, channel, time, value, value, value, interpolation));
  }
  return out;
}

const sinCycle = (phase, frequency = 1) => (t) => Math.sin(2 * Math.PI * (t - phase) * frequency);
const cosCycle = (phase, frequency = 1) => (t) => Math.cos(2 * Math.PI * (t - phase) * frequency);

/**
 * Locomotion generator. Phase `p` walks the leg cycle; the knee flexes while the leg
 * swings, the foot counter-rotates to stay near the ground and the toes grip on the
 * push-off, which is what stops a cube leg cycle from reading as a wind-up toy.
 */
function locomotion({ length, stride, knee, bob, lean, tailLift, armSwing, headDrop, samples }) {
  const keys = [];
  const legs = [
    { tag: 'left', phase: 0 },
    { tag: 'right', phase: 0.5 },
  ];
  for (const leg of legs) {
    const thigh = cycle(`${leg.tag}_leg`, 'rotation', length, samples, (t) => -stride * Math.cos(2 * Math.PI * (t - leg.phase)));
    const shin = cycle(`${leg.tag}_shin`, 'rotation', length, samples, (t) => {
      const swing = Math.sin(2 * Math.PI * (t - leg.phase - 0.12));
      return knee * clamp(swing * 1.4, 0, 1) + 4;
    });
    const foot = cycle(`${leg.tag}_foot`, 'rotation', length, samples, (t) => {
      const thighValue = -stride * Math.cos(2 * Math.PI * (t - leg.phase));
      const kneeValue = knee * clamp(Math.sin(2 * Math.PI * (t - leg.phase - 0.12)) * 1.4, 0, 1) + 4;
      return -(thighValue + kneeValue) * 0.5 + 6 * Math.sin(2 * Math.PI * (t - leg.phase + 0.15));
    });
    const toes = cycle(`${leg.tag}_toes`, 'rotation', length, samples, (t) =>
      -14 * Math.max(0, Math.sin(2 * Math.PI * (t - leg.phase + 0.3))),
    );
    keys.push(...thigh, ...shin, ...foot, ...toes);
  }

  // vertical bob at twice the stride frequency, roll sway once per cycle
  keys.push(...cycle('body', 'position', length, samples, (t) => [0, bob * Math.cos(4 * Math.PI * t) - bob * 0.5, 0]));
  keys.push(...cycle('body', 'rotation', length, samples, (t) => [lean, 0, 3 * Math.sin(2 * Math.PI * t)]));
  keys.push(...cycle('chest', 'rotation', length, samples, (t) => [0, -4 * Math.sin(2 * Math.PI * t), 0]));
  keys.push(...cycle('head', 'rotation', length, samples, (t) => [headDrop + 1.6 * Math.sin(4 * Math.PI * t), 4 * Math.sin(2 * Math.PI * t + 0.7), 0]));
  keys.push(...cycle('neck_01', 'rotation', length, samples, (t) => [-2 * Math.sin(4 * Math.PI * t + 0.4), 2 * Math.sin(2 * Math.PI * t + 0.4), 0]));

  // arms swing against the legs
  keys.push(...cycle('left_arm', 'rotation', length, samples, (t) => [armSwing * Math.sin(2 * Math.PI * t), 0, 0]));
  keys.push(...cycle('right_arm', 'rotation', length, samples, (t) => [-armSwing * Math.sin(2 * Math.PI * t), 0, 0]));
  keys.push(...cycle('left_lower_arm', 'rotation', length, samples, (t) => [-16 + 6 * Math.sin(2 * Math.PI * t - 0.5), 0, 0]));
  keys.push(...cycle('right_lower_arm', 'rotation', length, samples, (t) => [-16 - 6 * Math.sin(2 * Math.PI * t - 0.5), 0, 0]));

  // tail: each segment lags the one in front of it
  TAIL_BONES.forEach((bone, index) => {
    const lag = index * 0.075;
    const sway = 4 + index * 1.9;
    const lift = tailLift + index * 0.8;
    keys.push(...cycle(bone, 'rotation', length, samples, (t) => [
      lift * Math.cos(4 * Math.PI * (t - lag)) * 0.35 + lift * 0.65,
      sway * Math.sin(2 * Math.PI * (t - lag)),
      0,
    ]));
  });
  return keys;
}

/* -- one-shot pose helpers ------------------------------------------------ */

function pose(entries) {
  // entries: [time, { bone: [x, y, z] }, interpolation?]
  const keys = [];
  for (const entry of entries) {
    const [time, values, interpolation = 'catmullrom'] = entry;
    for (const [bone, value] of Object.entries(values)) {
      keys.push(kf(bone, 'rotation', time, value[0], value[1], value[2], interpolation));
    }
  }
  return keys;
}

function poseWithPositions(entries) {
  const keys = [];
  for (const entry of entries) {
    const [time, rotations, positions, interpolation = 'catmullrom'] = entry;
    for (const [bone, value] of Object.entries(rotations ?? {})) {
      keys.push(kf(bone, 'rotation', time, value[0], value[1], value[2], interpolation));
    }
    for (const [bone, value] of Object.entries(positions ?? {})) {
      keys.push(kf(bone, 'position', time, value[0], value[1], value[2], interpolation));
    }
  }
  return keys;
}

function tailKeys(times, fn, interpolation = 'catmullrom') {
  const keys = [];
  TAIL_BONES.forEach((bone, index) => {
    for (const [time, offset] of times) {
      const value = fn(index, time, offset);
      keys.push(kf(bone, 'rotation', time + offset * index, value[0], value[1], value[2], interpolation));
    }
  });
  return keys;
}

/* -- the set -------------------------------------------------------------- */

const NEUTRAL = {
  body: [0, 0, 0], chest: [0, 0, 0], neck_01: [0, 0, 0], neck_02: [0, 0, 0], head: [0, 0, 0],
  lower_jaw: [0, 0, 0], left_arm: [0, 0, 0], right_arm: [0, 0, 0],
  left_lower_arm: [-16, 0, 0], right_lower_arm: [-16, 0, 0],
  left_leg: [0, 0, 0], right_leg: [0, 0, 0], left_shin: [4, 0, 0], right_shin: [4, 0, 0],
  left_foot: [0, 0, 0], right_foot: [0, 0, 0],
};

animation({
  name: 'idle',
  loop: 'loop',
  length: 4,
  keys: [
    ...poseWithPositions([
      [0, { ...NEUTRAL }, {}, 'linear'],
      [1, { body: [0, 0, 0.8], chest: [-1.2, 0, 0], neck_01: [-1.5, 0, 0], head: [1, 2, 0], lower_jaw: [0, 0, 0] }, { body: [0, -0.45, 0] }],
      [2, { body: [0, 0, -0.8], chest: [0, 0, 0], neck_01: [0, 0, 0], head: [-1, -2, 0] }, { body: [0.2, 0, 0] }],
      [3, { body: [0, 0, 0.5], chest: [-1, 0, 0], neck_01: [-1.2, 0, 0], head: [-1.5, 3, 0], lower_jaw: [2, 0, 0] }, { body: [-0.1, -0.35, 0] }],
      [4, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
    ]),
    // breathing
    ...cycle('chest', 'scale', 4, 8, (t) => 1 + 0.028 * Math.sin(Math.PI * 2 * t)),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 4, 8, (t) => {
        const lag = index * 0.14;
        const sway = (3 + index * 1.7) * Math.sin(2 * Math.PI * (t - lag));
        const lift = (0.8 + index * 0.4) * Math.sin(2 * Math.PI * (t - lag) * 2);
        return [lift, sway, 0];
      }),
    ),
    // weight shifts through the feet
    ...cycle('left_leg', 'rotation', 4, 8, (t) => [-1 * Math.sin(2 * Math.PI * t), 0, 0]),
    ...cycle('right_leg', 'rotation', 4, 8, (t) => [1 * Math.sin(2 * Math.PI * t), 0, 0]),
    ...cycle('left_arm', 'rotation', 4, 8, (t) => [1.5 * Math.sin(2 * Math.PI * t), 0, 0]),
    ...cycle('right_arm', 'rotation', 4, 8, (t) => [-1.5 * Math.sin(2 * Math.PI * t), 0, 0]),
  ],
});

animation({
  name: 'breathe',
  loop: 'loop',
  length: 3,
  keys: [
    ...cycle('chest', 'scale', 3, 6, (t) => 1 + 0.04 * Math.sin(Math.PI * 2 * t)),
    ...cycle('chest', 'rotation', 3, 6, (t) => [-2.2 * Math.sin(Math.PI * 2 * t), 0, 0]),
    ...cycle('neck_01', 'rotation', 3, 6, (t) => [-2.4 * Math.sin(Math.PI * 2 * t), 0, 0]),
    ...cycle('neck_02', 'rotation', 3, 6, (t) => [-1.6 * Math.sin(Math.PI * 2 * t), 0, 0]),
    ...cycle('head', 'rotation', 3, 6, (t) => [1.4 * Math.sin(Math.PI * 2 * t), 0, 0]),
    ...cycle('body', 'position', 3, 6, (t) => [0, -0.3 - 0.3 * Math.sin(Math.PI * 2 * t), 0]),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 3, 6, (t) => [0.7 + index * 0.3, (1.5 + index) * Math.sin(2 * Math.PI * (t - index * 0.12)), 0]),
    ),
  ],
});

animation({
  name: 'tail_sway',
  loop: 'loop',
  length: 3,
  keys: [
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 3, 9, (t) => {
        const lag = index * 0.11;
        return [
          (1 + index * 0.5) * Math.sin(2 * Math.PI * (t - lag) * 2),
          (6 + index * 2.6) * Math.sin(2 * Math.PI * (t - lag)),
          0,
        ];
      }),
    ),
    ...cycle('body', 'rotation', 3, 9, (t) => [0, 1.5 * Math.sin(2 * Math.PI * t), 1.4 * Math.sin(2 * Math.PI * t)]),
    ...cycle('head', 'rotation', 3, 9, (t) => [0, -2.5 * Math.sin(2 * Math.PI * t), 0]),
  ],
});

animation({
  name: 'walk',
  loop: 'loop',
  length: 1,
  keys: locomotion({ length: 1, stride: 22, knee: 30, bob: 0.7, lean: 2, tailLift: 2, armSwing: 14, headDrop: -1, samples: 8 }),
});

animation({
  name: 'run',
  loop: 'loop',
  length: 0.72,
  keys: locomotion({ length: 0.72, stride: 36, knee: 48, bob: 1.2, lean: 7, tailLift: 6, armSwing: 28, headDrop: -3, samples: 8 }),
});

animation({
  name: 'sprint',
  loop: 'loop',
  length: 0.55,
  keys: [
    ...locomotion({ length: 0.55, stride: 44, knee: 56, bob: 1.5, lean: 12, tailLift: 9, armSwing: 34, headDrop: -5, samples: 8 }),
    ...cycle('neck_01', 'rotation', 0.55, 8, () => [7, 0, 0]),
    ...cycle('head', 'rotation', 0.55, 8, () => [-8, 0, 0]),
  ],
});

animation({
  name: 'attack',
  loop: 'once',
  length: 0.95,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.18, { body: [-10, 0, 0], neck_01: [16, 0, 0], neck_02: [10, 0, 0], head: [6, 0, 0], lower_jaw: [8, 0, 0], left_leg: [-8, 0, 0], right_leg: [6, 0, 0], left_shin: [16, 0, 0], right_shin: [8, 0, 0] }, { body: [0, -1, -1] }],
    [0.34, { body: [12, 0, 0], neck_01: [-18, 0, 0], neck_02: [-12, 0, 0], head: [-6, 0, 0], lower_jaw: [16, 0, 0], left_leg: [-14, 0, 0], right_leg: [12, 0, 0], left_shin: [6, 0, 0], right_shin: [4, 0, 0] }, { body: [0, 0.4, 1.4], chest: [0, 0, 3] }],
    [0.46, { body: [15, 0, 0], neck_01: [-20, 0, 0], neck_02: [-14, 0, 0], head: [-8, 0, 0], lower_jaw: [40, 0, 0], left_leg: [-16, 0, 0], right_leg: [14, 0, 0] }, { body: [0, 0, 1.8], chest: [0, 0, 3.5] }, 'linear'],
    [0.52, { lower_jaw: [0, 0, 0], neck_01: [-16, 0, 0], neck_02: [-10, 0, 0], head: [-4, 0, 0] }, { chest: [0, 0, 3.5] }, 'linear'],
    [0.7, { body: [4, 0, 0], neck_01: [4, 0, 0], neck_02: [2, 0, 0], head: [2, 0, 0] }, { body: [0, 0, 0.4], chest: [0, 0, 1] }],
    [0.95, { ...NEUTRAL }, { body: [0, 0, 0], chest: [0, 0, 0] }, 'linear'],
  ]),
  extra: [
    ...cycle('chest', 'scale', 0.95, 6, (t) => 1 + 0.03 * Math.max(0, Math.sin(Math.PI * (t + 0.1))),
    ),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 0.95, 8, (t) => {
        const whip = Math.sin(Math.PI * clamp(t * 1.3 - index * 0.05, 0, 1));
        return [4 + index * 0.6, (10 + index * 2) * whip * Math.sin(t * 9), 0];
      }),
    ),
  ],
});

animation({
  name: 'bite',
  loop: 'once',
  length: 0.62,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.15, { neck_01: [10, 0, 0], neck_02: [7, 0, 0], head: [5, 0, 0], body: [-5, 0, 0] }, { body: [0, 0, -0.8] }],
    [0.24, { lower_jaw: [34, 0, 0], neck_01: [8, 0, 0], neck_02: [6, 0, 0], head: [4, 0, 0] }, { body: [0, 0, -0.6] }],
    [0.36, { body: [8, 0, 0], neck_01: [-16, 0, 0], neck_02: [-10, 0, 0], head: [-6, 0, 0], lower_jaw: [40, 0, 0] }, { body: [0, 0.3, 1.2], chest: [0, 0, 2.6] }],
    [0.44, { lower_jaw: [0, 0, 0] }, { chest: [0, 0, 2.6] }, 'linear'],
    [0.62, { ...NEUTRAL }, { body: [0, 0, 0], chest: [0, 0, 0] }, 'linear'],
  ]),
});

animation({
  name: 'roar',
  loop: 'once',
  length: 1.7,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.4, { body: [-5, 0, 0], chest: [-3, 0, 0], neck_01: [-14, 0, 0], neck_02: [-10, 0, 0], head: [-8, 0, 0], lower_jaw: [10, 0, 0] }, { body: [0, 0.6, -0.4] }],
    [0.7, { body: [-7, 0, 0], chest: [-4, 0, 0], neck_01: [-19, 0, 0], neck_02: [-14, 0, 0], head: [-11, 0, 0], lower_jaw: [42, 0, 0] }, { body: [0, 1, -0.6] }],
    [1.0, { neck_01: [-17, 0, 1.5], neck_02: [-13, 0, -1], head: [-10, 1.5, 0], lower_jaw: [45, 0, 0] }, { body: [0, 1, -0.6] }],
    [1.15, { lower_jaw: [41, 0, 0], neck_01: [-19, 0, -1], head: [-11, -1, 0] }, {}],
    [1.45, { body: [-2, 0, 0], chest: [-1, 0, 0], neck_01: [-8, 0, 0], neck_02: [-5, 0, 0], head: [-4, 0, 0], lower_jaw: [8, 0, 0] }, { body: [0, 0.3, 0] }],
    [1.7, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
  ]),
  extra: [
    ...cycle('chest', 'scale', 1.7, 8, (t) => (t < 0.45 ? 1 + 0.07 * (t / 0.45) : t < 1.2 ? 1.07 - 0.02 * ((t - 0.45) / 0.75) : 1.05 - 0.05 * ((t - 1.2) / 0.5))),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 1.7, 8, (t) => [5 + index, (7 + index * 2.2) * Math.sin(2 * Math.PI * (t - index * 0.08)), 0]),
    ),
    ...cycle('left_leg', 'rotation', 1.7, 6, (t) => (t < 0.7 ? -4 - 4 * Math.sin(Math.PI * t / 0.7) : 0)),
    ...cycle('right_leg', 'rotation', 1.7, 6, (t) => (t < 0.7 ? 4 + 4 * Math.sin(Math.PI * t / 0.7) : 0)),
  ],
});

animation({
  name: 'roar_aggressive',
  loop: 'once',
  length: 2,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.25, { body: [-9, 0, 0], neck_01: [12, 0, 0], neck_02: [8, 0, 0], head: [6, 0, 0], lower_jaw: [6, 0, 0], left_shin: [14, 0, 0], right_shin: [10, 0, 0], left_leg: [-8, 0, 0], right_leg: [-6, 0, 0] }, { body: [0, -1.4, -1.4] }],
    [0.5, { body: [10, 0, 0], chest: [-5, 0, 0], neck_01: [-24, 0, 0], neck_02: [-17, 0, 0], head: [-13, 0, 0], lower_jaw: [48, 0, 0], left_leg: [-16, 0, 0], right_leg: [10, 0, 0], left_shin: [6, 0, 0], right_shin: [4, 0, 0] }, { body: [0, 1.6, 2], chest: [0, 0, 2] }],
    [0.8, { body: [8, 0, 0], chest: [-4, 0, 0], neck_01: [-22, 2, 0], neck_02: [-16, -2, 0], head: [-12, 2, 0], lower_jaw: [51, 0, 0] }, { body: [0, 1.4, 1.8], chest: [0, 0, 2] }],
    [1.15, { chest: [-4, 0, 0], neck_01: [-24, -2, 0], head: [-13, -2, 0], lower_jaw: [46, 0, 0] }, { chest: [0, 0, 1.6] }],
    [1.3, { lower_jaw: [4, 0, 0] }, {}, 'linear'],
    [1.55, { body: [6, 0, 0], neck_01: [-14, 0, 0], neck_02: [-9, 0, 0], head: [-7, 0, 0], lower_jaw: [22, 0, 0] }, { body: [0, 0.6, 1] }],
    [1.7, { lower_jaw: [0, 0, 0] }, {}, 'linear'],
    [2, { ...NEUTRAL }, { body: [0, 0, 0], chest: [0, 0, 0] }, 'linear'],
  ]),
  extra: [
    ...cycle('chest', 'scale', 2, 8, (t) => 1 + 0.08 * clamp(Math.sin(Math.PI * t * 1.4), 0, 1)),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 2, 10, (t) => [6 + index, (12 + index * 2.6) * Math.sin(2 * Math.PI * (t * 1.5 - index * 0.07)), 0]),
    ),
  ],
});

animation({
  name: 'hurt',
  loop: 'once',
  length: 0.5,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.07, { body: [-16, 6, 0], chest: [-6, 4, 0], neck_01: [14, 6, 0], neck_02: [9, 4, 0], head: [12, 8, 0], lower_jaw: [14, 0, 0], left_leg: [-12, 0, 0], right_leg: [8, 0, 0], left_shin: [18, 0, 0] }, { body: [0, 0.6, -2.2] }, 'linear'],
    [0.2, { body: [6, -2, 0], neck_01: [-6, -2, 0], neck_02: [-4, -1, 0], head: [-5, -3, 0], lower_jaw: [4, 0, 0], left_leg: [4, 0, 0], right_leg: [-2, 0, 0], left_shin: [6, 0, 0] }, { body: [0, -0.2, 0.6] }],
    [0.5, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
  ]),
});

animation({
  name: 'death',
  loop: 'once',
  length: 3.4,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.45, { body: [-7, 9, 0], chest: [-4, 5, 0], neck_01: [10, 6, 0], neck_02: [7, 4, 0], head: [9, 6, 0], lower_jaw: [10, 0, 0], left_leg: [-10, 0, 0], right_leg: [12, 0, 0], left_shin: [16, 0, 0], right_shin: [10, 0, 0] }, { body: [0, 0.4, -1] }],
    [1.0, { body: [6, 16, 9], chest: [-3, 6, 4], neck_01: [18, 8, 0], neck_02: [12, 5, 0], head: [14, 6, 0], lower_jaw: [16, 0, 0], left_leg: [16, 0, 0], right_leg: [26, 0, 0], left_shin: [42, 0, 0], right_shin: [34, 0, 0], left_foot: [-16, 0, 0], right_foot: [-12, 0, 0] }, { body: [0, -2.6, -1.4] }],
    [1.7, { body: [12, 26, 22], chest: [-2, 8, 8], neck_01: [30, 10, 4], neck_02: [20, 6, 2], head: [24, 7, 0], lower_jaw: [24, 0, 0], left_leg: [34, 0, 0], right_leg: [44, 0, 0], left_shin: [58, 0, 0], right_shin: [52, 0, 0], left_foot: [-26, 0, 0], right_foot: [-22, 0, 0], left_toes: [-10, 0, 0], right_toes: [-8, 0, 0] }, { body: [0, -6, -2] }],
    [2.3, { body: [15, 33, 30], chest: [0, 8, 10], neck_01: [38, 10, 5], neck_02: [26, 7, 3], head: [30, 7, 2], lower_jaw: [27, 0, 0], left_leg: [46, 0, 0], right_leg: [56, 0, 0], left_shin: [72, 0, 0], right_shin: [68, 0, 0], left_foot: [-34, 0, 0], right_foot: [-30, 0, 0], left_toes: [-14, 0, 0], right_toes: [-12, 0, 0] }, { body: [0, -9, -2.4] }, 'linear'],
    [2.75, { body: [14, 34, 31], neck_01: [40, 10, 5], head: [32, 6, 2], lower_jaw: [24, 0, 0] }, { body: [0, -9.6, -2.5] }],
    [3.0, { lower_jaw: [26, 0, 0], head: [31, 7, 2] }, {}],
    [3.4, { body: [14, 34, 31], neck_01: [40, 10, 5], neck_02: [27, 7, 3], head: [32, 6, 2], lower_jaw: [23, 0, 0] }, { body: [0, -9.8, -2.5] }, 'linear'],
  ]),
  extra: tailKeys(
    [[0.9, 0], [1.6, 0.03], [2.3, 0.06], [2.9, 0.08], [3.4, 0.09]],
    (index, time, offset) => {
      const drop = time < 1.2 ? 2 + index : time < 2.3 ? -4 - index * 0.5 : -7 - index * 0.6;
      const yaw = time < 1.6 ? (5 + index) * Math.sin(time * 3) : (3 + index) * Math.sin(time * 2 + index);
      return [drop, yaw, 0];
    },
    'linear',
  ),
});

animation({
  name: 'jump',
  loop: 'once',
  length: 1.15,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.18, { body: [-4, 0, 0], neck_01: [8, 0, 0], neck_02: [5, 0, 0], head: [6, 0, 0], left_leg: [-30, 0, 0], right_leg: [-28, 0, 0], left_shin: [56, 0, 0], right_shin: [54, 0, 0], left_foot: [-22, 0, 0], right_foot: [-22, 0, 0], left_toes: [14, 0, 0], right_toes: [14, 0, 0], left_arm: [30, 0, 0], right_arm: [30, 0, 0] }, { body: [0, -3.6, -0.6] }, 'linear'],
    [0.3, { body: [4, 0, 0], neck_01: [-8, 0, 0], neck_02: [-5, 0, 0], head: [-6, 0, 0], left_leg: [26, 0, 0], right_leg: [28, 0, 0], left_shin: [2, 0, 0], right_shin: [2, 0, 0], left_foot: [16, 0, 0], right_foot: [16, 0, 0], left_toes: [-16, 0, 0], right_toes: [-16, 0, 0], left_arm: [-46, 0, 0], right_arm: [-46, 0, 0] }, { body: [0, 4.4, 0] }],
    [0.5, { body: [2, 0, 0], neck_01: [-4, 0, 0], head: [-4, 0, 0], left_leg: [-18, 0, 0], right_leg: [-10, 0, 0], left_shin: [38, 0, 0], right_shin: [28, 0, 0], left_foot: [8, 0, 0], right_foot: [6, 0, 0], left_arm: [-58, 0, 0], right_arm: [-54, 0, 0] }, { body: [0, 6, 0] }],
    [0.75, { left_leg: [-14, 0, 0], right_leg: [-6, 0, 0], left_shin: [34, 0, 0], right_shin: [24, 0, 0], left_arm: [-52, 0, 0], right_arm: [-48, 0, 0] }, { body: [0, 4.4, 0] }],
    [0.94, { body: [3, 0, 0], neck_01: [4, 0, 0], head: [4, 0, 0], left_leg: [6, 0, 0], right_leg: [10, 0, 0], left_shin: [12, 0, 0], right_shin: [10, 0, 0], left_arm: [-20, 0, 0], right_arm: [-18, 0, 0] }, { body: [0, 0.4, 0] }],
    [1.02, { body: [8, 0, 0], neck_01: [6, 0, 0], head: [5, 0, 0], left_leg: [-16, 0, 0], right_leg: [-14, 0, 0], left_shin: [40, 0, 0], right_shin: [38, 0, 0], left_foot: [-14, 0, 0], right_foot: [-14, 0, 0], left_arm: [18, 0, 0], right_arm: [18, 0, 0] }, { body: [0, -3, 0] }, 'linear'],
    [1.15, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
  ]),
  extra: TAIL_BONES.flatMap((bone, index) =>
    cycle(bone, 'rotation', 1.15, 8, (t) => {
      const arc = Math.sin(Math.PI * clamp((t - 0.15) / 0.8, 0, 1));
      return [(8 + index * 1.5) * arc + (t > 0.95 ? -2 : 0), (4 + index) * Math.sin(t * 8 - index * 0.4) * arc, 0];
    }),
  ),
});

animation({
  name: 'fall',
  loop: 'loop',
  length: 1,
  keys: [
    ...pose([
      [0, { body: [3, 0, 0], neck_01: [-6, 0, 0], neck_02: [-4, 0, 0], head: [-5, 2, 0], left_leg: [-14, 0, 0], right_leg: [-7, 0, 0], left_shin: [32, 0, 0], right_shin: [23, 0, 0], left_foot: [8, 0, 0], right_foot: [5, 0, 0], left_arm: [-24, 0, 0], right_arm: [-20, 0, 0], left_lower_arm: [-30, 0, 0], right_lower_arm: [-26, 0, 0] }, 'linear'],
    ]),
    ...cycle('body', 'position', 1, 6, (t) => [0, 4.2 + 0.7 * Math.sin(2 * Math.PI * t), 0]),
    ...cycle('body', 'rotation', 1, 6, (t) => [3 + 2 * Math.sin(2 * Math.PI * t), 0, 2.5 * Math.sin(2 * Math.PI * t)]),
    ...cycle('left_arm', 'rotation', 1, 6, (t) => [-24 - 7 * Math.sin(2 * Math.PI * t), 0, 0]),
    ...cycle('right_arm', 'rotation', 1, 6, (t) => [-20 + 7 * Math.sin(2 * Math.PI * t), 0, 0]),
    ...cycle('head', 'rotation', 1, 6, (t) => [-5, 2 + 4 * Math.sin(2 * Math.PI * t), 0]),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 1, 6, (t) => {
        const arc = 9 - index * 0.4;
        return [arc + 3 * Math.sin(2 * Math.PI * (t - index * 0.08)), (5 + index * 1.4) * Math.sin(2 * Math.PI * (t - index * 0.09)), 0];
      }),
    ),
  ],
});

animation({
  name: 'land',
  loop: 'once',
  length: 0.7,
  keys: poseWithPositions([
    [0, { body: [2, 0, 0], neck_01: [-4, 0, 0], head: [-3, 0, 0], left_leg: [-8, 0, 0], right_leg: [-6, 0, 0], left_shin: [18, 0, 0], right_shin: [16, 0, 0], left_arm: [-22, 0, 0], right_arm: [-20, 0, 0] }, { body: [0, 2, 0] }, 'linear'],
    [0.12, { body: [11, 0, 0], neck_01: [10, 0, 0], neck_02: [6, 0, 0], head: [9, 0, 0], left_leg: [-24, 0, 0], right_leg: [-22, 0, 0], left_shin: [46, 0, 0], right_shin: [44, 0, 0], left_foot: [-16, 0, 0], right_foot: [-16, 0, 0], left_toes: [-12, 0, 0], right_toes: [-12, 0, 0], left_arm: [24, 0, 0], right_arm: [22, 0, 0], lower_jaw: [12, 0, 0] }, { body: [0, -3.2, 0] }, 'linear'],
    [0.3, { body: [-3, 0, 0], neck_01: [-4, 0, 0], head: [-4, 0, 0], left_leg: [6, 0, 0], right_leg: [5, 0, 0], left_shin: [8, 0, 0], right_shin: [7, 0, 0], lower_jaw: [3, 0, 0] }, { body: [0, 0.5, 0] }],
    [0.7, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
  ]),
});

animation({
  name: 'look',
  loop: 'loop',
  length: 2.4,
  keys: [
    ...cycle('head', 'rotation', 2.4, 8, (t) => [1.5 * Math.sin(4 * Math.PI * t), 8 * Math.sin(2 * Math.PI * t), 2 * Math.sin(2 * Math.PI * t)]),
    ...cycle('neck_01', 'rotation', 2.4, 8, (t) => [0, 5 * Math.sin(2 * Math.PI * t - 0.3), 0]),
    ...cycle('neck_02', 'rotation', 2.4, 8, (t) => [-1 * Math.sin(4 * Math.PI * t), 4 * Math.sin(2 * Math.PI * t - 0.2), 0]),
    ...cycle('body', 'rotation', 2.4, 8, (t) => [0, 2 * Math.sin(2 * Math.PI * t - 0.5), 0]),
    ...TAIL_BONES.flatMap((bone, index) => cycle(bone, 'rotation', 2.4, 8, (t) => [0.6 + index * 0.3, (2 + index) * Math.sin(2 * Math.PI * (t - index * 0.1)), 0])),
  ],
});

function headTurn(name, direction, length = 0.9) {
  const s = direction;
  animation({
    name,
    loop: 'once',
    length,
    keys: pose([
      [0, { ...NEUTRAL }, 'linear'],
      [length * 0.3, { neck_01: [0, 14 * s, 0], neck_02: [0, 13 * s, 0], head: [-3, 20 * s, 4 * s], body: [0, 5 * s, 0] }],
      [length * 0.55, { neck_01: [0, 15 * s, 0], neck_02: [0, 14 * s, 0], head: [-4, 22 * s, 5 * s], body: [0, 6 * s, 0] }],
      [length * 0.8, { neck_01: [0, 8 * s, 0], neck_02: [0, 7 * s, 0], head: [-1, 12 * s, 2 * s], body: [0, 3 * s, 0] }],
      [length, { ...NEUTRAL }, 'linear'],
    ]),
    extra: TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', length, 6, (t) => [0.5, -3 * s * (1 - t) * (1 + index * 0.4), 0]),
    ),
  });
}
headTurn('look_left', 1);
headTurn('look_right', -1);

animation({
  name: 'angry_idle',
  loop: 'loop',
  length: 2.6,
  keys: [
    ...pose([
      [0, { body: [3, 0, 0], chest: [-2, 0, 0], neck_01: [9, 0, 0], neck_02: [6, 0, 0], head: [7, -3, 0], lower_jaw: [6, 0, 0], left_arm: [8, 0, 0], right_arm: [-6, 0, 0], left_lower_arm: [-24, 0, 0], right_lower_arm: [-22, 0, 0] }, 'linear'],
      [0.6, { body: [3, 0, 3], chest: [-2, -3, 0], neck_01: [9, 4, 0], head: [7, 3, -3], lower_jaw: [20, 0, 0] }, { body: [0, -0.9, 0] }],
      [0.8, { lower_jaw: [4, 0, 0] }, {}, 'linear'],
      [1.4, { body: [4, 0, -3], chest: [-2, 3, 0], neck_01: [10, -4, 0], head: [8, -4, 3], lower_jaw: [9, 0, 0] }, { body: [0.3, -1.3, 0] }],
      [1.75, { lower_jaw: [26, 0, 0] }, {}, 'linear'],
      [1.95, { lower_jaw: [5, 0, 0] }, {}, 'linear'],
      [2.6, { body: [3, 0, 0], chest: [-2, 0, 0], neck_01: [9, 0, 0], neck_02: [6, 0, 0], head: [7, -3, 0], lower_jaw: [6, 0, 0], left_arm: [8, 0, 0], right_arm: [-6, 0, 0], left_lower_arm: [-24, 0, 0], right_lower_arm: [-22, 0, 0] }, { body: [0, -0.6, 0] }, 'linear'],
    ]),
    ...cycle('chest', 'scale', 2.6, 8, (t) => 1 + 0.035 * Math.sin(2 * Math.PI * t * 2)),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 2.6, 10, (t) => [4 + index * 0.8, (9 + index * 2.4) * Math.sin(2 * Math.PI * (t * 1.4 - index * 0.07)), 0]),
    ),
    ...cycle('left_leg', 'rotation', 2.6, 6, (t) => -2 + 2 * Math.sin(2 * Math.PI * t)),
    ...cycle('right_leg', 'rotation', 2.6, 6, (t) => 2 - 2 * Math.sin(2 * Math.PI * t)),
  ],
});

animation({
  name: 'eating',
  loop: 'loop',
  length: 1.8,
  keys: pose([
    [0, { body: [4, 0, 0], neck_01: [24, 0, 0], neck_02: [15, 0, 0], head: [10, 0, 0], lower_jaw: [4, 0, 0] }, 'linear'],
    [0.3, { body: [5, 0, 0], neck_01: [30, 4, 0], neck_02: [18, 3, 0], head: [13, 3, 0], lower_jaw: [10, 0, 0] }, { body: [0, -0.6, 0.6] }],
    [0.5, { lower_jaw: [34, 0, 0], head: [14, 4, 0] }, {}, 'linear'],
    [0.7, { lower_jaw: [2, 0, 0], head: [12, -3, 0] }, {}, 'linear'],
    [1.0, { lower_jaw: [30, 0, 0], head: [13, 5, 0], neck_01: [29, -4, 0] }, {}, 'linear'],
    [1.2, { lower_jaw: [3, 0, 0], head: [11, -4, 0] }, {}, 'linear'],
    [1.45, { neck_01: [26, 6, 0], neck_02: [16, 4, 0], head: [11, 6, 0], lower_jaw: [8, 0, 0], body: [4, 0, 0] }, {}],
    [1.8, { body: [4, 0, 0], neck_01: [24, 0, 0], neck_02: [15, 0, 0], head: [10, 0, 0], lower_jaw: [4, 0, 0] }, { body: [0, -0.4, 0.4] }, 'linear'],
  ]),
  extra: [
    ...cycle('chest', 'scale', 1.8, 6, (t) => 1 + 0.02 * Math.sin(2 * Math.PI * t)),
    ...TAIL_BONES.flatMap((bone, index) => cycle(bone, 'rotation', 1.8, 6, (t) => [1, (4 + index * 1.6) * Math.sin(2 * Math.PI * (t - index * 0.1)), 0])),
  ],
});

animation({
  name: 'sniff',
  loop: 'once',
  length: 1,
  keys: pose([
    [0, { ...NEUTRAL }, 'linear'],
    [0.2, { neck_01: [-14, 0, 0], neck_02: [-10, 0, 0], head: [-9, 0, 0], body: [-3, 0, 0] }, { body: [0, 0.4, 0] }],
    [0.34, { lower_jaw: [10, 0, 0], head: [-10, 4, 0] }, {}, 'linear'],
    [0.42, { lower_jaw: [2, 0, 0] }, {}, 'linear'],
    [0.5, { lower_jaw: [13, 0, 0], head: [-10, -3, 0] }, {}, 'linear'],
    [0.57, { lower_jaw: [3, 0, 0] }, {}, 'linear'],
    [0.75, { neck_01: [-12, -12, 0], neck_02: [-9, -10, 0], head: [-8, -14, 0] }, {}],
    [0.88, { neck_01: [-12, 10, 0], neck_02: [-9, 9, 0], head: [-8, 13, 0] }, {}],
    [1, { ...NEUTRAL }, 'linear'],
  ]),
  extra: TAIL_BONES.flatMap((bone, index) => cycle(bone, 'rotation', 1, 5, (t) => [3 + index * 0.6, (5 + index) * Math.sin(2 * Math.PI * t), 0])),
});

animation({
  name: 'threaten',
  loop: 'once',
  length: 1.5,
  keys: poseWithPositions([
    [0, { ...NEUTRAL }, {}, 'linear'],
    [0.3, { body: [-8, 0, 0], chest: [-5, 0, 0], neck_01: [-21, 0, 0], neck_02: [-15, 0, 0], head: [-12, 0, 0], lower_jaw: [18, 0, 0], left_arm: [-26, 0, 0], right_arm: [-26, 0, 0], left_lower_arm: [-40, 0, 0], right_lower_arm: [-40, 0, 0], left_leg: [-7, 0, 0], right_leg: [7, 0, 0], left_shin: [12, 0, 0], right_shin: [8, 0, 0] }, { body: [0, 1.8, -1] }],
    [0.45, { neck_01: [-23, 0, 0], neck_02: [-16, 0, 0], head: [-13, 0, 0], lower_jaw: [46, 0, 0] }, { body: [0, 2, -1] }],
    [0.95, { neck_01: [-22, 3, 0], neck_02: [-16, -3, 0], head: [-13, 3, 0], lower_jaw: [49, 0, 0] }, { body: [0, 2, -1] }],
    [1.12, { body: [10, 0, 0], chest: [4, 0, 0], neck_01: [16, 0, 0], neck_02: [10, 0, 0], head: [9, 0, 0], lower_jaw: [6, 0, 0], left_arm: [10, 0, 0], right_arm: [10, 0, 0] }, { body: [0, -0.5, 1.6], chest: [0, 0, 2.4] }, 'linear'],
    [1.2, { lower_jaw: [0, 0, 0] }, {}, 'linear'],
    [1.5, { ...NEUTRAL }, { body: [0, 0, 0], chest: [0, 0, 0] }, 'linear'],
  ]),
  extra: [
    ...cycle('chest', 'scale', 1.5, 6, (t) => 1 + 0.06 * clamp(Math.sin(Math.PI * t * 1.2), 0, 1)),
    ...TAIL_BONES.flatMap((bone, index) => cycle(bone, 'rotation', 1.5, 8, (t) => [10 - index * 0.5, (8 + index * 2) * Math.sin(2 * Math.PI * t * 1.3 - index * 0.08), 0])),
  ],
});

function turn(name, direction) {
  const s = direction;
  const length = 1.3;
  animation({
    name,
    loop: 'once',
    length,
    keys: [
      ...pose([
        [0, { ...NEUTRAL }, 'linear'],
        [0.25, { body: [0, 14 * s, 0], neck_01: [0, 8 * s, 0], head: [-2, 16 * s, 0], left_leg: [-20 * s, 0, 0], right_leg: [14 * s, 0, 0], left_shin: [26, 0, 0], right_shin: [6, 0, 0], left_foot: [-8, 0, 0], right_foot: [4, 0, 0] }, { body: [0, -0.6, 0] }],
        [0.55, { body: [0, 30 * s, 0], neck_01: [0, 9 * s, 0], head: [-3, 18 * s, 0], left_leg: [12 * s, 0, 0], right_leg: [-18 * s, 0, 0], left_shin: [6, 0, 0], right_shin: [24, 0, 0], left_foot: [3, 0, 0], right_foot: [-7, 0, 0] }, { body: [0, 0.4, 0] }],
        [0.85, { body: [0, 38 * s, 0], neck_01: [0, 6 * s, 0], head: [-2, 12 * s, 0], left_leg: [-14 * s, 0, 0], right_leg: [10 * s, 0, 0], left_shin: [18, 0, 0], right_shin: [6, 0, 0] }, { body: [0, -0.4, 0] }],
        [1.1, { body: [0, 40 * s, 0], neck_01: [0, 2 * s, 0], head: [0, 4 * s, 0], left_leg: [-4 * s, 0, 0], right_leg: [3 * s, 0, 0], left_shin: [8, 0, 0], right_shin: [5, 0, 0] }, {}],
        [length, { body: [0, 40 * s, 0], neck_01: [0, 0, 0], head: [0, 0, 0], left_leg: [0, 0, 0], right_leg: [0, 0, 0], left_shin: [4, 0, 0], right_shin: [4, 0, 0] }, {}, 'linear'],
      ]),
      // the tail is left behind, then catches up
      ...TAIL_BONES.flatMap((bone, index) =>
        cycle(bone, 'rotation', length, 8, (t) => {
          const lag = index * 0.055;
          const yaw = (7 + index * 2.6) * s * Math.sin(Math.PI * clamp((t - lag) / 0.8, 0, 1)) - 9 * s * Math.exp(-8 * Math.max(0, t - 0.12 - lag));
          return [1 + index * 0.4, yaw, 0];
        }),
      ),
      ...cycle('chest', 'rotation', length, 6, (t) => [0, -5 * s * Math.sin(Math.PI * t), 0]),
      ...cycle('head', 'rotation', length, 6, (t) => [0, 4 * s * Math.sin(Math.PI * t * 1.4), 0]),
    ],
  });
}
turn('turn_left', 1);
turn('turn_right', -1);

animation({
  name: 'tail_whip',
  loop: 'once',
  length: 0.9,
  keys: [
    ...pose([
      [0, { ...NEUTRAL }, 'linear'],
      [0.22, { body: [0, -8, -6], chest: [0, -6, 0], neck_01: [0, -8, 0], head: [0, -10, 0], left_leg: [-6, 0, 0], right_leg: [8, 0, 0] }, { body: [0, -0.5, -0.8] }],
      [0.44, { body: [0, 10, 7], chest: [0, 8, 0], neck_01: [0, 10, 0], head: [0, 12, 0], left_leg: [8, 0, 0], right_leg: [-6, 0, 0], lower_jaw: [16, 0, 0] }, { body: [0, 0.3, 0.8] }, 'linear'],
      [0.6, { body: [0, 6, 3], lower_jaw: [4, 0, 0] }, {}],
      [0.9, { ...NEUTRAL }, { body: [0, 0, 0] }, 'linear'],
    ]),
    ...TAIL_BONES.flatMap((bone, index) =>
      cycle(bone, 'rotation', 0.9, 9, (t) => {
        const lag = index * 0.045;
        const tt = clamp(t - lag, 0, 1);
        const coil = -26 * Math.exp(-Math.pow((tt - 0.24) / 0.13, 2));
        const whip = 42 * Math.exp(-Math.pow((tt - 0.48) / 0.11, 2));
        const settle = -8 * Math.exp(-Math.pow((tt - 0.66) / 0.1, 2));
        return [3 + index * 0.7, coil + whip + settle, 0];
      }, 'linear'),
    ),
  ],
});

/* ------------------------------------------------------------------ phases */

async function phasePreflight() {
  const status = await health();
  if (!status.plugin_connected) throw new Error('the Blockbench plugin is not connected — open Blockbench and press Connect');
  const state = (await (await fetch(`${BASE}/state`)).json()).state;
  log('observe', `Blockbench project: ${state?.project?.project_name ?? 'none'} · format ${state?.project?.format_id ?? '?'} · ${state?.project?.element_count ?? 0} cubes`);
  const references = path.join(WORKSPACE, 'references');
  const refs = fs.existsSync(references) ? fs.readdirSync(references).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)) : [];
  log('observe', refs.length ? `reference images: ${refs.join(', ')}` : 'reference images: none supplied — proportions taken from T-Rex anatomy + Minecraft conventions');
  if (fs.existsSync(PROJECT_FILE)) {
    const backup = `${PROJECT_FILE}.bak-${Date.now()}`;
    fs.copyFileSync(PROJECT_FILE, backup);
    log('safety', `backed up ${path.basename(PROJECT_FILE)} → ${path.basename(backup)}`);
  }
  try {
    const checkpoint = await fetch(`${BASE}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'before T-Rex build' }),
    }).then((r) => r.json());
    log('safety', `checkpoint ${checkpoint.checkpoint_id ?? '(created)'} recorded`);
  } catch (error) {
    warn(`checkpoint unavailable: ${error.message}`);
  }
}

async function phaseSettings() {
  await call('set_project_settings', { name: 'trex', resolution: [TEXTURE_SIZE, TEXTURE_SIZE], box_uv: false, model_identifier: 'trex' });
  log('build', `project settings: ${TEXTURE_SIZE}×${TEXTURE_SIZE}, per-face UV`);
}

async function phaseTexture() {
  const png = buildTexture();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const texture = await call('create_texture', { name: 'trex_skin', data_url: dataUrl, select: true });
  log('build', `texture trex_skin created (${png.length} bytes, ${TEXTURE_SIZE}×${TEXTURE_SIZE}) uuid=${texture.uuid ?? texture.texture_uuid ?? '?'}`);
  return texture;
}

async function phaseGroups() {
  let created = 0;
  for (const [name, origin, parent] of GROUPS) {
    await call('create_group', { name, origin, parent: parent ? { name: parent } : undefined });
    created += 1;
  }
  log('build', `${created} bones created`);
}

async function phaseCubes() {
  await call('transaction_begin', { label: 'T-Rex geometry' });
  try {
    // one call, one undo step — the brief asks for bulk operations
    const result = await call('bulk_create_cubes', {
      cubes: CUBES.map((definition) => ({
        name: definition.name,
        from: definition.from,
        to: definition.to,
        parent: definition.parent,
        autouv: 0,
        texture: 'trex_skin',
      })),
    });
    await call('transaction_commit', {});
    log('build', `${CUBES.length} cubes created in one transaction (${result.created ?? CUBES.length} reported)`);
  } catch (error) {
    await call('transaction_abort', {}).catch(() => {});
    throw error;
  }
}

async function phaseUv() {
  await call('transaction_begin', { label: 'T-Rex UV' });
  try {
    for (const definition of CUBES) {
      const faces = {};
      for (const face of FACES) faces[face] = uvForFace(definition, face);
      await call('set_uv', { reference: { name: definition.name }, faces, autouv: 0 });
    }
    await call('transaction_commit', {});
    log('build', `UV laid out for ${CUBES.length} cubes`);
  } catch (error) {
    await call('transaction_abort', {}).catch(() => {});
    throw error;
  }
}

async function phaseAnimations() {
  await call('transaction_begin', { label: 'T-Rex animations' });
  let total = 0;
  try {
    for (const spec of ANIMATIONS) {
      await call('create_animation', { name: spec.name, loop: spec.loop, length: spec.length, select: true });
      const keys = [...(spec.keys ?? []), ...(spec.extra ?? [])];
      await call('bulk_create_keyframes', { animation: spec.name, keyframes: keys, set_length: false });
      total += keys.length;
    }
    await call('transaction_commit', {});
    log('animate', `${ANIMATIONS.length} animations, ${total} keyframes`);
  } catch (error) {
    await call('transaction_abort', {}).catch(() => {});
    throw error;
  }
}

const ANGLES = ['south', 'north', 'east', 'west', 'top', 'isometric_right'];

function analysePng(buffer) {
  const png = PNG.sync.read(buffer);
  let minX = png.width;
  let maxX = -1;
  let minY = png.height;
  let maxY = -1;
  let inked = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4;
      const alpha = png.data[index + 3];
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      const isBackground = alpha < 16 || (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r > 200);
      if (isBackground) continue;
      inked += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { empty: true };
  return {
    empty: false,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    ink_ratio: round3(inked / (png.width * png.height)),
    center_x: round3((minX + maxX) / 2 / png.width),
    center_y: round3((minY + maxY) / 2 / png.height),
  };
}

async function phaseShots() {
  fs.mkdirSync(VIEWPORT_DIR, { recursive: true });
  const report = {};
  for (const angle of ANGLES) {
    const image = await call('get_viewport_image', { angle, resolution: 768, anti_aliasing: 'off', shading: true });
    const buffer = Buffer.from(image.data_url.split(',')[1], 'base64');
    const file = path.join(VIEWPORT_DIR, `trex_${angle}.png`);
    fs.writeFileSync(file, buffer);
    const metrics = analysePng(buffer);
    report[angle] = metrics;
    log('inspect', `${angle.padEnd(16)} ${metrics.empty ? 'EMPTY' : `${metrics.width}×${metrics.height}px ink=${metrics.ink_ratio} at (${metrics.center_x},${metrics.center_y})`} → ${path.basename(file)}`);
  }
  return report;
}

async function phaseValidate() {
  const result = await call('validate_model', { max_issues: 100 });
  const issues = result.issues ?? [];
  const counts = {};
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  log('verify', `validate_model: ${issues.length} issues ${JSON.stringify(counts)}`);
  for (const issue of issues.slice(0, 25)) warn(`${issue.severity} ${issue.code ?? ''} ${issue.message ?? JSON.stringify(issue)}`);
  return result;
}

async function phaseSave() {
  const saved = await call('save_project', { minify: false });
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(saved.model));
  await call('mark_project_saved', {}).catch((error) => warn(`mark_project_saved: ${error.message}`));
  log('save', `${path.basename(PROJECT_FILE)} written (${(fs.statSync(PROJECT_FILE).size / 1024).toFixed(1)} KB)`);

  // VERIFY: reload straight from disk and count what survived
  const reloaded = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
  const summary = {
    elements: reloaded.elements?.length ?? 0,
    groups: reloaded.outliner?.length ?? 0,
    textures: reloaded.textures?.length ?? 0,
    animations: reloaded.animations?.length ?? 0,
    keyframes: (reloaded.animations ?? []).reduce(
      (total, animation) => total + Object.values(animation.animators ?? {}).reduce((sum, animator) => sum + (animator.keyframes?.length ?? 0), 0),
      0,
    ),
  };
  log('verify', `round-trip from disk: ${JSON.stringify(summary)}`);
  return { saved, summary };
}

async function main() {
  log('start', `bridge ${BASE} · workspace ${WORKSPACE}`);
  await phasePreflight();
  if (run('settings')) await phaseSettings();
  if (run('texture')) await phaseTexture();
  if (run('groups')) await phaseGroups();
  if (run('cubes')) await phaseCubes();
  if (run('uv')) await phaseUv();
  if (run('animations')) await phaseAnimations();
  let shots = null;
  if (run('shots')) shots = await phaseShots();
  if (run('validate')) await phaseValidate();
  let saved = null;
  if (!SKIP_SAVE && run('save')) saved = await phaseSave();

  const project = (await (await fetch(`${BASE}/state`)).json()).state?.project;
  log('done', `in-project: ${project?.element_count} cubes · ${project?.group_count} bones · ${project?.texture_count} textures · ${project?.animation_count} animations`);
  if (shots) fs.writeFileSync(path.join(VIEWPORT_DIR, 'metrics.json'), JSON.stringify(shots, null, 2));
  if (saved) console.log(JSON.stringify(saved.summary));
}

main().catch((error) => {
  console.error(`\n✖ build failed: ${error.message}`);
  if (error.payload) console.error(JSON.stringify(error.payload).slice(0, 1200));
  process.exitCode = 1;
});
