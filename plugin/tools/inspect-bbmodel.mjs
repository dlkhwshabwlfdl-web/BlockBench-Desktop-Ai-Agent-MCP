#!/usr/bin/env node
/**
 * Offline audit of a .bbmodel file.
 *
 *   node tools/inspect-bbmodel.mjs [path] [--json]
 *
 * Prints: hierarchy (with resolved group names + pivots), geometry anomalies
 * (zero/negative/thin cubes, duplicates, gaps), UV coverage + overlaps,
 * texture palette summary and per-animation keyframe statistics including
 * dead channels (channels whose keys never produce motion).
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv.find((a) => a && !a.startsWith('--')) && process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.resolve(process.cwd(), '../trex.bbmodel');
const asJson = process.argv.includes('--json');

const model = JSON.parse(fs.readFileSync(file, 'utf8'));

const groups = new Map();
for (const g of model.groups || []) if (g && g.uuid) groups.set(g.uuid, g);
const elements = new Map();
for (const e of model.elements || []) if (e && e.uuid) elements.set(e.uuid, e);

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const size = (e) => [round(e.to[0] - e.from[0]), round(e.to[1] - e.from[1]), round(e.to[2] - e.from[2])];
const vol = (e) => { const s = size(e); return s[0] * s[1] * s[2]; };
const centre = (e) => [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2, (e.from[2] + e.to[2]) / 2];

/** Flatten the outliner into {group, depth, cubes[]} rows. */
const rows = [];
const cubeOwner = new Map();
function walk(nodes, depth, parentName) {
  for (const node of nodes || []) {
    if (typeof node === 'string') {
      const e = elements.get(node);
      if (!e) { rows.push({ kind: 'missing', id: node, depth, parentName }); continue; }
      cubeOwner.set(node, parentName);
      rows.push({ kind: 'cube', cube: e, depth, parentName });
      continue;
    }
    const g = groups.get(node.uuid);
    const name = g ? g.name : '(unknown group)';
    rows.push({ kind: 'group', group: g || { uuid: node.uuid, name }, depth, parentName });
    walk(node.children || [], depth + 1, name);
  }
}
walk(model.outliner || [], 0, null);

const allCubes = rows.filter((r) => r.kind === 'cube').map((r) => r.cube);
const nameCount = new Map();
for (const c of allCubes) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);

// ---------------------------------------------------------------- geometry
const geo = { zero: [], negative: [], thin: [], duplicateNames: [], missingOrigin: [], hidden: [], big: [] };
for (const c of allCubes) {
  const s = size(c);
  if (s.some((v) => v === 0)) geo.zero.push({ name: c.name, size: s });
  if (s.some((v) => v < 0)) geo.negative.push({ name: c.name, size: s });
  if (s.some((v) => v > 0 && v < 0.5)) geo.thin.push({ name: c.name, size: s });
  if (!c.origin) geo.missingOrigin.push(c.name);
  if (c.visibility === false) geo.hidden.push(c.name);
  if (vol(c) > 500) geo.big.push({ name: c.name, size: s });
}
for (const [n, count] of nameCount) if (count > 1) geo.duplicateNames.push({ name: n, count });

// symmetry check: mirror every cube across x=0 and look for a partner
const mir = new Map();
for (const c of allCubes) {
  const key = `${size(c).join(',')}|${round(Math.abs(centre(c)[0]))},${round(centre(c)[1])},${round(centre(c)[2])}`;
  mir.set(key, (mir.get(key) || 0) + 1);
}
const asymmetric = [];
for (const c of allCubes) {
  if (Math.abs(centre(c)[0]) < 0.01) continue;
  const key = `${size(c).join(',')}|${round(Math.abs(centre(c)[0]))},${round(centre(c)[1])},${round(centre(c)[2])}`;
  if ((mir.get(key) || 0) < 2) asymmetric.push(c.name);
}

// intersections between sibling-pairs is expensive; report bounding boxes only
const modelBounds = allCubes.length
  ? {
    min: [0, 1, 2].map((i) => round(Math.min(...allCubes.map((c) => c.from[i])))),
    max: [0, 1, 2].map((i) => round(Math.max(...allCubes.map((c) => c.to[i])))),
  }
  : null;

// ------------------------------------------------------------------- UV
const tex = (model.textures || [])[0] || null;
const TW = (tex && tex.width) || (model.resolution || {}).width || 64;
const TH = (tex && tex.height) || (model.resolution || {}).height || 64;
const uvRects = [];
let autouvCount = 0;
for (const c of allCubes) {
  if (c.autouv) autouvCount++;
  for (const [face, f] of Object.entries(c.faces || {})) {
    if (!f || !f.uv) continue;
    uvRects.push({ name: c.name, face, u1: Math.min(f.uv[0], f.uv[2]), v1: Math.min(f.uv[1], f.uv[3]), u2: Math.max(f.uv[0], f.uv[2]), v2: Math.max(f.uv[1], f.uv[3]) });
  }
}
const inBounds = uvRects.filter((r) => r.u1 >= -0.01 && r.v1 >= -0.01 && r.u2 <= TW + 0.01 && r.v2 <= TH + 0.01);
const covered = new Set();
for (const r of inBounds) {
  for (let u = Math.floor(r.u1); u < Math.ceil(r.u2); u++) {
    for (let v = Math.floor(r.v1); v < Math.ceil(r.v2); v++) covered.add(`${u},${v}`);
  }
}
const uvStats = {
  textureSize: `${TW}x${TH}`,
  texturedFaces: uvRects.length,
  outOfBounds: uvRects.length - inBounds.length,
  autouvFaces: autouvCount,
  coveragePct: round((covered.size / (TW * TH)) * 100),
  zeroArea: uvRects.filter((r) => r.u1 === r.u2 || r.v1 === r.v2).map((r) => `${r.name}.${r.face}`),
};

// ---------------------------------------------------------------- texture
let texture = null;
if (tex && tex.source) {
  const b64 = String(tex.source).replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  texture = { name: tex.name, width: tex.width, height: tex.height, bytes: buf.length, dataUrlPrefix: String(tex.source).slice(0, 22) };
}

// ------------------------------------------------------------- animations

/**
 * Group an animator's keyframes by channel.
 *
 * Blockbench 4 stored `keyframes` as `{channel: [keys]}`; 5.x stores a flat array of
 * `{channel, data_points, time, interpolation}`. Older audits only understood the first
 * shape and silently reported "0 keys" against 5.x files, so both are accepted here.
 */
function channelBuckets(animator) {
  const raw = animator && animator.keyframes;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const byChannel = new Map();
    for (const k of raw) {
      const ch = k && k.channel ? k.channel : 'rotation';
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(k);
    }
    return [...byChannel.entries()];
  }
  return Object.entries(raw).filter(([, list]) => Array.isArray(list));
}

/**
 * Smallest total range that still reads on screen, per channel kind.
 *
 * A single number cannot work for all three: 0.15 is a visible 3px of travel for a
 * position channel, an invisible 0.15deg for a rotation, and an enormous 15% for a
 * scale. Judged against the model's own size so this holds for any asset.
 */
const modelHeight = (() => {
  const ys = (model.elements || []).map((e) => e.to[1]);
  return ys.length ? Math.max(...ys) : 24;
})();
const DEAD_THRESHOLD = {
  position: Math.max(0.05, modelHeight * 0.006),
  rotation: 0.5,
  scale: 0.025,
};

const anims = [];
for (const a of model.animations || []) {
  const animators = a.animators || {};
  const channels = [];
  let keys = 0;
  const bones = [];
  for (const [uuid, an] of Object.entries(animators)) {
    const g = groups.get(uuid);
    const boneName = (g && g.name) || (an && an.name) || uuid.slice(0, 8);
    bones.push(boneName);
    for (const [ch, list] of channelBuckets(an)) {
      const n = list.length;
      keys += n;
      if (n === 0) continue;
      // does the channel actually move? compare the last data point on each axis
      const pts = list.map((k) => (k.data_points || [k])[0] || k);
      const spread = ['x', 'y', 'z'].map((axis) => {
        const v = pts.map((p) => Number(p[axis]) || 0);
        return Math.max(...v) - Math.min(...v);
      });
      const moved = Math.max(...spread);
      channels.push({ bone: boneName, channel: ch, keys: n, range: round(moved) });
    }
  }
  const dead = channels.filter((c) => c.range < DEAD_THRESHOLD[c.channel]);
  const interps = new Set();
  for (const an of Object.values(animators)) {
    for (const [, list] of channelBuckets(an)) {
      for (const k of list) interps.add(k.interpolation || 'linear');
    }
  }
  anims.push({
    name: a.name,
    length: a.length,
    loop: a.loop,
    bones: bones.length,
    keys,
    channels: channels.length,
    deadChannels: dead.map((c) => `${c.bone}.${c.channel}`),
    interpolation: [...interps].join('/'),
  });
}

// -------------------------------------------------------------- hierarchy
const groupRows = rows.filter((r) => r.kind === 'group' && r.group);
const hierarchyWarnings = [];
for (const r of groupRows) {
  const kids = rows.filter((x) => x.parentName === r.group.name);
  if (kids.length === 0) hierarchyWarnings.push(`empty group: ${r.group.name}`);
}
const seen = new Set();
for (const r of groupRows) {
  if (seen.has(r.group.name)) hierarchyWarnings.push(`duplicate group name: ${r.group.name}`);
  seen.add(r.group.name);
}

const report = {
  file: path.basename(file),
  name: model.name,
  resolution: model.resolution,
  groups: groupRows.length,
  cubes: allCubes.length,
  unparentedCubes: allCubes.filter((c) => !cubeOwner.has(c.uuid)).length,
  modelBounds,
  geometry: geo,
  asymmetric,
  uv: uvStats,
  texture,
  animations: anims,
  hierarchyWarnings,
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

// --------------------------------------------------------------- printing
const line = (s = '') => console.log(s);
line(`══ ${report.file} — "${report.name}"  ${TW}x${TH}  ${report.groups} bones / ${report.cubes} cubes`);
line('');
line('HIERARCHY');
for (const r of rows) {
  const pad = '  '.repeat(r.depth);
  if (r.kind === 'group') {
    const g = r.group;
    const o = g.origin || [0, 0, 0];
    line(`${pad}▸ ${g.name}  pivot(${o.map(round).join(', ')})`);
  } else if (r.kind === 'cube') {
    const c = r.cube;
    const s = size(c);
    line(`${pad}· ${c.name}  from[${c.from.map(round)}] to[${c.to.map(round)}] sz[${s}]`);
  } else {
    line(`${pad}· MISSING ${r.id}`);
  }
}
line('');
line('GEOMETRY');
line(`  bounds min[${modelBounds ? modelBounds.min : '-'}] max[${modelBounds ? modelBounds.max : '-'}]`);
line(`  zero-size: ${geo.zero.length}${geo.zero.length ? ' → ' + geo.zero.map((z) => z.name).join(', ') : ''}`);
line(`  negative:  ${geo.negative.length}${geo.negative.length ? ' → ' + geo.negative.map((z) => z.name).join(', ') : ''}`);
line(`  sub-0.5u:  ${geo.thin.length}${geo.thin.length ? ' → ' + geo.thin.map((z) => z.name).join(', ') : ''}`);
line(`  duplicate names: ${geo.duplicateNames.length}${geo.duplicateNames.length ? ' → ' + geo.duplicateNames.map((z) => z.name + 'x' + z.count).join(', ') : ''}`);
line(`  missing pivot: ${geo.missingOrigin.length}${geo.missingOrigin.length ? ' → ' + geo.missingOrigin.join(', ') : ''}`);
line(`  hidden: ${geo.hidden.length}${geo.hidden.length ? ' → ' + geo.hidden.join(', ') : ''}`);
line(`  asymmetric cubes: ${asymmetric.length}${asymmetric.length ? ' → ' + asymmetric.join(', ') : ''}`);
line('');
line('UV');
line(`  textured faces ${uvStats.texturedFaces} · out of bounds ${uvStats.outOfBounds} · coverage ${uvStats.coveragePct}%`);
line(`  zero-area faces: ${uvStats.zeroArea.length}${uvStats.zeroArea.length ? ' → ' + uvStats.zeroArea.slice(0, 12).join(', ') : ''}`);
line('');
line('TEXTURE');
line(texture ? `  ${texture.name} ${texture.width}x${texture.height} · ${texture.bytes} bytes` : '  (none embedded)');
line('');
line('ANIMATIONS');
for (const a of anims) {
  line(`  ${a.name.padEnd(16)} ${String(a.length).padStart(6)}s ${a.loop.padEnd(5)} bones=${String(a.bones).padStart(3)} keys=${String(a.keys).padStart(4)} ch=${String(a.channels).padStart(3)} interp=${a.interpolation}`);
  if (a.deadChannels.length) line(`      dead channels (no motion): ${a.deadChannels.join(', ')}`);
  if (a.keys === 0) line('      !! NO KEYFRAMES');
}
line('');
line('HIERARCHY WARNINGS');
line(hierarchyWarnings.length ? hierarchyWarnings.map((w) => '  ' + w).join('\n') : '  none');
