#!/usr/bin/env node
/**
 * Final validation for the Legendary Crate — the checklist from the brief, run against
 * the saved `.bbmodel` rather than the live session so the result is reproducible.
 *
 *   node tools/validate-crate.mjs [path/to/model.bbmodel]
 *
 * Beyond the structural checks, this measures two things the brief calls out but that a
 * plain "does it have keyframes" audit cannot prove:
 *
 *   1. Layered timing. The crate must not move like one rigid object, so for the opening
 *      sequences we find when the lock, the lid, the crystals and the energy each first
 *      move and assert the order is lock -> lid -> crystals -> energy.
 *   2. Crystal clipping. Crystals sit outside the body shell and ride rotating bones, so
 *      we forward-kinematics every bone chain across each animation and measure how far
 *      a crystal box penetrates the lid or body.
 *
 * Format notes, both learned the hard way:
 *   - `groups[].children` is always empty here; the tree lives in the nested `outliner`,
 *     and cubes appear there as bare uuid strings with no `parent` on the element itself.
 *   - `animations[].animators[uuid].keyframes` is a *flat* array of keyframes, each with
 *     its own `channel` and `data_points` — not a list of per-channel animator records.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE = 'F:/resourcepack/Trex/crate/legendary_crate.bbmodel';
const FILE = process.argv[2] ?? DEFAULT_FILE;

/** The hierarchy the brief asked for, plus the extras this design added. */
const REQUIRED_BONES = [
  'LegendaryCrate', 'Base', 'Body', 'LeftFrame', 'RightFrame', 'FrontFrame', 'BackFrame',
  'BottomFrame', 'Lid', 'LidMain', 'LidFrame', 'LidDecoration', 'Lock', 'LockFrame',
  'LockCore', 'LockGlow', 'LeftCrystal', 'RightCrystal', 'TopCrystal', 'MagicCore',
  'EnergyDetails',
];

/** All 18 animations the brief requires, in its own numbering. */
const REQUIRED_ANIMATIONS = [
  'idle', 'idle_magic', 'idle_glow', 'hover', 'shake', 'key_insert', 'unlock', 'open',
  'open_magic', 'open_legendary', 'close', 'close_magic', 'activation', 'reward_reveal',
  'reward_burst', 'pulse', 'celebration', 'shutdown',
];

/** Animations where the lid must visibly travel, and roughly how far (degrees). */
const LID_TRAVEL = {
  open: 55, open_magic: 55, open_legendary: 55, close: 55, close_magic: 55,
  reward_reveal: 40, activation: 20, shutdown: 15, shake: 2,
};

const LAYERS = [
  ['lock', ['LockCore', 'LockGlow', 'LockFrame', 'Lock']],
  ['lid', ['Lid', 'LidMain', 'LidFrame', 'LidDecoration']],
  ['crystals', ['TopCrystal', 'LeftCrystal', 'RightCrystal']],
  ['energy', ['MagicCore', 'CoreHalo', 'EnergyDetails']],
];

const CRYSTALS = ['LeftCrystal', 'RightCrystal', 'TopCrystal'];
const SHELL = ['Lid', 'LidMain', 'LidFrame', 'LidDecoration', 'Body', 'CornerPosts',
  'LeftFrame', 'RightFrame', 'FrontFrame', 'BackFrame'];

const problems = [];
const notes = [];
const ok = (label, detail) => notes.push(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
const deg = (v) => (v * 180) / Math.PI;
const round = (v, n = 2) => Number(v.toFixed(n));

/* ------------------------------------------------------------------- parsing */

if (!fs.existsSync(FILE)) {
  console.error(`model not found: ${FILE}`);
  process.exit(1);
}
const model = JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log(`══ ${path.basename(FILE)}  "${model.name}"  ${model.resolution?.width}x${model.resolution?.height}\n`);

const nameOf = new Map();
const origins = new Map();
const elementByUuid = new Map();
for (const g of model.groups ?? []) {
  nameOf.set(g.uuid, g.name);
  origins.set(g.name, g.origin ?? [0, 0, 0]);
}
for (const e of model.elements ?? []) elementByUuid.set(e.uuid, e);

const parents = new Map();
const cubeByGroup = new Map();
const walk = (nodes, parentName) => {
  for (const node of nodes ?? []) {
    if (typeof node === 'string') {
      // a bare uuid inside a group node is a cube
      const el = elementByUuid.get(node);
      if (!el) continue;
      const list = cubeByGroup.get(parentName) ?? [];
      list.push(el);
      cubeByGroup.set(parentName, list);
      continue;
    }
    if (!node || !node.uuid) continue;
    const name = nameOf.get(node.uuid);
    if (name) parents.set(name, parentName);
    walk(node.children, name ?? parentName);
  }
};
walk(model.outliner ?? [], null);

/* --------------------------------------------------------------- keyframe api */

/** Sampled track for one animator: channel -> [{time, point}]. */
function tracks(animator) {
  const byChannel = new Map();
  for (const kf of animator?.keyframes ?? []) {
    const pts = kf.data_points ?? [];
    if (!pts.length) continue;
    const list = byChannel.get(kf.channel) ?? [];
    list.push({ time: kf.time, p: pts[pts.length - 1] });
    byChannel.set(kf.channel, list);
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.time - b.time);
  return byChannel;
}

/**
 * Per-bone motion for one clip. `amplitude[channel]` is the travel from that channel's
 * own first value, so a clip that starts at 90 degrees and returns to 90 reads as 0
 * travel rather than 90. `onset` is the first time any channel has travelled enough to
 * be visible, which is what the layered-timing check compares.
 */
function profile(anim) {
  const out = new Map();
  for (const [uuid, animator] of Object.entries(anim.animators ?? {})) {
    const name = nameOf.get(uuid);
    if (!name) continue;
    const entry = { onset: null, peak: 0, channels: new Set(), amplitude: {} };
    for (const [channel, list] of tracks(animator)) {
      entry.channels.add(channel);
      const scale = channel === 'rotation' ? deg : (v) => v;
      const first = list[0].p;
      const threshold = channel === 'rotation' ? 2.5 : channel === 'position' ? 0.1 : 0.01;
      let span = 0;
      for (const { time, p } of list) {
        let dev = 0;
        for (const ax of ['x', 'y', 'z']) {
          const d = Math.abs(scale(p[ax]) - scale(first[ax]));
          if (Number.isFinite(d)) dev = Math.max(dev, d);
        }
        span = Math.max(span, dev);
        if (dev >= threshold && (entry.onset === null || time < entry.onset)) entry.onset = time;
      }
      entry.amplitude[channel] = span;
      entry.peak = Math.max(entry.peak, span);
    }
    out.set(name, entry);
  }
  return out;
}

function firstOnset(prof, names) {
  let best = null;
  for (const n of names) {
    const t = prof.get(n)?.onset;
    if (t === null || t === undefined) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

const profiles = new Map();
for (const anim of model.animations ?? []) profiles.set(anim.name, profile(anim));

/* ------------------------------------------------------- forward kinematics */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}
const matTranslate = (t) => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1];
const matScale = (s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];

/** XYZ euler order, radians. */
function matRotate(r) {
  const [x, y, z] = r;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  return matMul(
    matMul([1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1],
      [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1]),
    [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
}
const matApply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Product of T(position) * T(pivot) * R * S * T(-pivot) down the chain. */
function boneMatrix(boneName, ctx) {
  const chain = [];
  let cur = boneName;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = parents.get(cur) ?? null;
  }
  let m = IDENTITY;
  for (const link of chain) {
    const s = ctx.sample.get(link);
    const pos = s ? s('position') : [0, 0, 0];
    const rot = s ? s('rotation') : [0, 0, 0];
    const sc = s ? s('scale') : [1, 1, 1];
    const pivot = origins.get(link) ?? [0, 0, 0];
    let local = matMul(matTranslate(pos), matTranslate(pivot));
    local = matMul(local, matRotate(rot));
    local = matMul(local, matScale(sc));
    local = matMul(local, matTranslate(sub([0, 0, 0], pivot)));
    m = matMul(m, local);
  }
  return m;
}

function boundsOf(cubes, ctx) {
  const min = [1e9, 1e9, 1e9];
  const max = [-1e9, -1e9, -1e9];
  for (const e of cubes) {
    const m = boneMatrix(cubeOwner.get(e.uuid), ctx);
    const o = e.origin ?? [0, 0, 0];
    const cubeMat = matMul(matTranslate(o),
      matMul(matRotate((e.rotation ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180)),
        matTranslate(sub([0, 0, 0], o))));
    for (const x of [e.from[0], e.to[0]]) {
      for (const y of [e.from[1], e.to[1]]) {
        for (const z of [e.from[2], e.to[2]]) {
          const p = matApply(m, matApply(cubeMat, [x, y, z]));
          for (let i = 0; i < 3; i += 1) {
            min[i] = Math.min(min[i], p[i]);
            max[i] = Math.max(max[i], p[i]);
          }
        }
      }
    }
  }
  return { min, max };
}

function overlapDepth(a, b) {
  let best = 0;
  for (let i = 0; i < 3; i += 1) {
    const d = Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]);
    if (d <= 0) return 0;
    best = Math.max(best, d);
  }
  return best;
}

// uuid -> owning group name, needed by the FK pass
const cubeOwner = new Map();
for (const [group, cubes] of cubeByGroup) for (const c of cubes) cubeOwner.set(c.uuid, group);

/* -- 1. parts + hierarchy ------------------------------------------------- */

console.log('PARTS & HIERARCHY');
const boneNames = new Set(model.groups.map((g) => g.name));
const missingBones = REQUIRED_BONES.filter((b) => !boneNames.has(b));
if (missingBones.length) bad('missing bones', missingBones.join(', '));
else ok('all required bones present', `${REQUIRED_BONES.length} named, ${boneNames.size} total`);

const rootName = [...boneNames].find((n) => parents.get(n) === null);
const unresolved = model.groups.filter((g) => g.name !== rootName && !parents.get(g.name));
if (unresolved.length) bad('bones with no resolved parent', unresolved.map((g) => g.name).join(', '));
else ok('hierarchy fully linked', `root "${rootName}", depth ${Math.max(...[...boneNames].map((n) => {
  let d = 0; let c = n;
  while (parents.get(c)) { c = parents.get(c); d += 1; }
  return d;
}))}`);

const emptyBones = model.groups.filter((g) => !(cubeByGroup.get(g.name) ?? []).length).map((g) => g.name);
if (emptyBones.length) bad('bones with no cubes', emptyBones.join(', '));
else ok('every bone owns geometry', `${cubeByGroup.size} groups hold cubes`);

const overall = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
for (const e of model.elements ?? []) {
  for (let i = 0; i < 3; i += 1) {
    overall.min[i] = Math.min(overall.min[i], e.from[i]);
    overall.max[i] = Math.max(overall.max[i], e.to[i]);
  }
}
const badPivots = model.groups.filter((g) => (g.origin ?? [0, 0, 0]).some((v, i) => v < overall.min[i] - 8 || v > overall.max[i] + 8));
if (badPivots.length) bad('implausible pivots', badPivots.map((g) => g.name).join(', '));
else ok('pivots inside model bounds');

/* -- 2. geometry ---------------------------------------------------------- */

console.log('\nGEOMETRY');
const zero = model.elements.filter((e) => e.from.some((v, i) => e.to[i] - v <= 0));
if (zero.length) bad('zero/negative size cubes', zero.map((e) => e.name).join(', '));
else ok('no zero-size geometry', `${model.elements.length} cubes`);

const names = model.elements.map((e) => e.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) bad('duplicate cube names', [...new Set(dupes)].join(', '));
else ok('no duplicate cube names');

const noOrigin = model.elements.filter((e) => !Array.isArray(e.origin));
if (noOrigin.length) bad('cubes missing origin/pivot', noOrigin.map((e) => e.name).join(', '));
else ok('every cube has a pivot');

/* -- 3. texture + uv ------------------------------------------------------ */

console.log('\nTEXTURE & UV');
const tex = (model.textures ?? [])[0];
if (!tex) bad('no texture');
else if (!tex.source) bad('texture has no pixel data', tex.name);
else ok('texture present and embedded',
  `${tex.name} ${tex.width}x${tex.height}, ${Buffer.from(String(tex.source).split(',')[1] ?? '', 'base64').length} bytes`);

const res = model.resolution ?? {};
if (tex && (res.width !== tex.width || res.height !== tex.height)) {
  bad('project resolution does not match the texture', `${res.width}x${res.height} vs ${tex.width}x${tex.height}`);
} else ok('project resolution matches texture');

const faces = [];
for (const e of model.elements) {
  for (const [dir, face] of Object.entries(e.faces ?? {})) if (face?.uv) faces.push({ cube: e.name, dir, uv: face.uv });
}
const w = res.width ?? 128;
const h = res.height ?? 128;
const oob = faces.filter((f) => f.uv.some((v, i) => v < -0.001 || v > (i % 2 === 0 ? w : h) + 0.001));
if (oob.length) bad('UV outside the texture', `${oob.length} faces e.g. ${oob[0].cube}`);
else ok(`all UVs inside 0..${w}`, `${faces.length} textured faces`);

const degenerate = faces.filter((f) => f.uv[2] - f.uv[0] <= 0 || f.uv[3] - f.uv[1] <= 0);
if (degenerate.length) bad('zero-area UV faces', degenerate.map((f) => f.cube).join(', '));
else ok('no zero-area UV faces');

/* -- 4. animations -------------------------------------------------------- */

console.log('\nANIMATIONS');
const animNames = (model.animations ?? []).map((a) => a.name);
const missingAnim = REQUIRED_ANIMATIONS.filter((n) => !animNames.includes(n));
if (missingAnim.length) bad('missing required animations', missingAnim.join(', '));
else ok('all 18 required animations present', `${animNames.length} total`);

let brokenChannels = 0;
let totalKeys = 0;
const emptyAnims = [];
const resolveFailures = [];
for (const anim of model.animations ?? []) {
  let keys = 0;
  for (const [uuid, animator] of Object.entries(anim.animators ?? {})) {
    if (!nameOf.has(uuid)) resolveFailures.push(`${anim.name}:${uuid.slice(0, 8)}`);
    for (const kf of animator.keyframes ?? []) {
      if (!(kf.data_points ?? []).length) brokenChannels += 1;
      keys += (kf.data_points ?? []).length;
    }
  }
  totalKeys += keys;
  if (!keys) emptyAnims.push(anim.name);
}
if (brokenChannels) bad('keyframes with no data points', `${brokenChannels}`);
else ok('no broken animation channels', `${totalKeys} keyframes total`);
if (resolveFailures.length) bad('animators that do not resolve to a bone', resolveFailures.slice(0, 5).join(', '));
else ok('every animator resolves to a bone');
if (emptyAnims.length) bad('animations with no keyframes', emptyAnims.join(', '));
else ok('every animation has meaningful keyframes');

const thin = [];
for (const [name, prof] of profiles) {
  const moving = [...prof.values()].filter((e) => e.peak >= 1);
  const channels = new Set();
  for (const e of moving) for (const c of e.channels) channels.add(c);
  if (moving.length < 4 || channels.size < 2) thin.push(`${name} (${moving.length} bones / ${channels.size} channels)`);
}
if (thin.length) bad('animations with too little layered motion', thin.join(', '));
else ok('every animation drives 4+ bones across 2+ channel types');

/* -- 5. lid travel + lock reaction ---------------------------------------- */

console.log('\nMECHANICAL MOTION');
for (const [name, minDeg] of Object.entries(LID_TRAVEL)) {
  const rot = profiles.get(name)?.get('Lid')?.amplitude?.rotation;
  if (rot === undefined) { bad(`${name}: no lid channel`, 'missing'); continue; }
  if (rot < minDeg) bad(`${name}: lid barely moves`, `${round(rot, 1)}° < ${minDeg}°`);
  else ok(`${name}: lid travels`, `${round(rot, 1)}°`);
}
for (const name of ['key_insert', 'unlock', 'open_legendary', 'deny', 'activation']) {
  const prof = profiles.get(name);
  if (!prof) continue;
  const best = Math.max(...['Lock', 'LockFrame', 'LockCore', 'LockGlow']
    .map((b) => prof.get(b)?.amplitude?.rotation ?? 0));
  if (best < 3) bad(`${name}: lock does not react`, `${round(best, 1)}°`);
  else ok(`${name}: lock reacts`, `${round(best, 1)}°`);
}

/* -- 6. layered timing ---------------------------------------------------- */

console.log('\nLAYERED TIMING (lock -> lid -> crystals -> energy)');
for (const anim of ['unlock', 'open_magic', 'open_legendary', 'reward_reveal', 'activation']) {
  const prof = profiles.get(anim);
  if (!prof) continue;
  const onsets = LAYERS.map(([label, bones]) => [label, firstOnset(prof, bones)]);
  const shown = onsets.map(([l, t]) => `${l}=${t === null ? '—' : round(t)}`).join('  ');
  const unknown = onsets.filter(([, t]) => t === null);
  if (unknown.length) bad(`${anim}: layers that never move`, shown);
  else if (onsets.every(([, t], i) => i === 0 || t >= onsets[i - 1][1])) ok(`${anim}: layers fire in order`, shown);
  else bad(`${anim}: layers fire out of order`, shown);
}

/* -- 7. crystal clipping -------------------------------------------------- */

console.log('\nCRYSTAL CLIPPING');
const crystalCubes = CRYSTALS.flatMap((g) => cubeByGroup.get(g) ?? []);
const shellCubes = SHELL.flatMap((g) => cubeByGroup.get(g) ?? []);
let worstClip = { depth: 0, anim: '—', t: 0 };
let samples = 0;
for (const anim of model.animations ?? []) {
  const times = new Set();
  for (const animator of Object.values(anim.animators ?? {})) {
    for (const kf of animator.keyframes ?? []) times.add(kf.time);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(sorted.length / 12));
  for (let i = 0; i < sorted.length; i += step) {
    const t = sorted[i];
    samples += 1;
    const sample = new Map();
    for (const [uuid, animator] of Object.entries(anim.animators ?? {})) {
      const name = nameOf.get(uuid);
      if (!name) continue;
      const byChannel = tracks(animator);
      sample.set(name, (channel) => {
        const list = byChannel.get(channel);
        if (!list?.length) return channel === 'scale' ? [1, 1, 1] : [0, 0, 0];
        let prev = list[0];
        let next = list[list.length - 1];
        for (const k of list) {
          if (k.time <= t) prev = k;
          if (k.time >= t) { next = k; break; }
        }
        const span = next.time - prev.time;
        const f = span > 0 ? (t - prev.time) / span : 0;
        return ['x', 'y', 'z'].map((ax) => {
          const v = prev.p[ax] + (next.p[ax] - prev.p[ax]) * f;
          return channel === 'rotation' ? (v * Math.PI) / 180 : v;
        });
      });
    }
    const d = overlapDepth(boundsOf(crystalCubes, { sample }), boundsOf(shellCubes, { sample }));
    if (d > worstClip.depth) worstClip = { depth: d, anim: anim.name, t };
  }
}
// A rotating crystal sweeps an axis-aligned box larger than the crystal itself, so a
// small overlap is measurement slack rather than visible interpenetration. 1.5 units on
// a crate that is 27 units wide is the bar.
if (worstClip.depth > 1.5) {
  bad('crystals penetrate the shell', `${round(worstClip.depth)} units in ${worstClip.anim} @ t=${round(worstClip.t)}`);
} else {
  ok('crystals stay clear of the shell', `worst overlap ${round(worstClip.depth)} units over ${samples} poses`);
}

/* -- report --------------------------------------------------------------- */

console.log('\nRESULT');
for (const n of notes) console.log(n);
if (problems.length) {
  console.log(`\n  FAIL  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`        - ${p}`);
  process.exit(1);
}
console.log(`\n  PASS  all checks clean — ${model.elements.length} cubes, ${model.groups.length} bones, ${(model.animations ?? []).length} animations.`);
