#!/usr/bin/env node
/**
 * Legendary Crate build.
 *
 * Every model change goes through the bridge's tool registry — the same path an
 * LLM-driven agent run uses. No hand-editing of the live project.
 *
 * Phases:
 *
 *   preflight   health, wait for the plugin link
 *   export      write the design to a .bbmodel offline (audit + safety net)
 *   new         create the project: free format, 128x128
 *   groups      create the 24-bone hierarchy, parents first
 *   cubes       bulk-create all 100 cubes, each parented to its bone
 *   texture     import the painted atlas and assign it to every cube
 *   uv          per-face UV rectangles (explicit islands, never box UV)
 *   animations  create all 22 clips and bulk-create their keyframes
 *   shots       render the QA angles and build a contact sheet
 *   validate    validate_model + animation audit
 *   save        compile, write to disk, verify the round trip
 *
 * Usage:
 *   node tools/build-crate.mjs                       # everything
 *   node tools/build-crate.mjs --only export,audit    # offline only, no Blockbench
 *   node tools/build-crate.mjs --only preflight,new,groups,cubes
 *   node tools/build-crate.mjs --tag pass1
 *   node tools/build-crate.mjs --skip-save
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  GROUPS, CUBES, FACES, layout, uvFor, islandFor, buildAtlas, hash01,
} from './crate-design.mjs';
import { ANIMATIONS, validateAnimations } from './crate-animations.mjs';

const BASE = process.env.AI_AGENT_BRIDGE ?? 'http://127.0.0.1:47311';
const WORKSPACE = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
const CRATE_DIR = path.join(WORKSPACE, 'crate');
const VIEWPORT_DIR = path.join(WORKSPACE, 'ai_context', 'viewport');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : fallback;
  }
  const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
};
const ONLY = (() => {
  const hit = argv.find((a) => a.startsWith('--only'));
  if (!hit) return null;
  const raw = hit.includes('=') ? hit.split('=')[1] : argv[argv.indexOf(hit) + 1];
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();
const TAG = value('tag', 'crate');
const PROJECT = value('project', 'legendary_crate');
const PROJECT_FILE = path.join(CRATE_DIR, `${PROJECT}.bbmodel`);
const LABEL = value('label', `crate ${TAG}`);
const SKIP_SAVE = flag('skip-save');
const phase = (name) => !ONLY || ONLY.has(name);

/* ------------------------------------------------------------------ helpers */

const t0 = Date.now();
let stepName = 'init';
const log = (m) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${stepName.padEnd(10)} ${m}`);
const warn = (m) => console.log(`           ! ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    return await (await fetch(`${BASE}/health`)).json();
  } catch {
    return null;
  }
}

/** Blockbench drops its link (and occasionally exits), so wait rather than fail. */
async function waitForPlugin(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const h = await health();
    if (h?.plugin_connected) {
      if (announced) log('plugin reconnected');
      return h;
    }
    if (Date.now() > deadline) throw new Error(`Blockbench did not connect within ${timeoutMs / 1000}s`);
    if (!announced) {
      warn('waiting for Blockbench to connect…');
      announced = true;
    }
    await sleep(2000);
  }
}

/** Call a plugin tool, retrying across the link's periodic reconnects. */
async function call(tool, args = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await waitForPlugin();
    let body;
    try {
      const res = await fetch(`${BASE}/tool/${tool}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      body = await res.json();
    } catch (error) {
      lastError = error;
      await sleep(1500);
      continue;
    }
    if (body.ok) {
      for (const w of body.warnings ?? []) warn(`${tool}: ${w}`);
      return body.data;
    }
    const message = body.error?.message ?? JSON.stringify(body.error);
    lastError = new Error(`${tool}: ${message}`);
    if (!/not connected|closed|socket|timeout|disconnect/i.test(message)) {
      const failure = new Error(`${tool}: ${message}`);
      failure.payload = body;
      throw failure;
    }
    warn(`retry ${attempt} after: ${message}`);
    await sleep(2000);
  }
  throw lastError ?? new Error(`${tool}: unknown failure`);
}

/* ---------------------------------------------------------------- atlas / uv */

const atlas = layout(128);
const atlasPng = buildAtlas(128);
const ATLAS_DATA_URL = `data:image/png;base64,${atlasPng.png.toString('base64')}`;

/** The UV rectangle table, resolved once so export and the live build agree. */
function uvTable() {
  const table = {};
  for (const cube of CUBES) {
    table[cube.name] = {};
    for (const face of FACES) table[cube.name][face] = uvFor(cube, face, atlas.rects);
  }
  return table;
}
const UV = uvTable();

/* ------------------------------------------------------------ bbmodel writer */

const bbUid = (() => {
  const hex = '0123456789abcdef';
  return () => {
    // deterministic-ish uuid: unique within one document is all that is required
    let s = '';
    for (let i = 0; i < 32; i += 1) s += hex[Math.floor(Math.random() * 16)];
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
  };
})();

/**
 * Compile the design into a .bbmodel document.
 *
 * Written offline for two reasons: it is the audit artifact `inspect-bbmodel` can read
 * before anything touches Blockbench, and it survives a Blockbench crash during the
 * build. Indentation is intentionally 1 space — these documents get large.
 */
function compileModel() {
  const ids = new Map();
  const cubeUuids = new Map();
  for (const g of GROUPS) ids.set(g.name, bbUid());
  for (const c of CUBES) cubeUuids.set(c.name, bbUid());

  const elements = CUBES.map((c) => {
    const faces = {};
    for (const face of FACES) {
      faces[face] = { uv: UV[c.name][face], texture: 0 };
    }
    const el = {
      name: c.name,
      box_uv: false,
      rescale: false,
      locked: false,
      render_order: 'default',
      allow_mirror_modeling: true,
      from: c.from,
      to: c.to,
      autouv: 0,
      color: 0,
      origin: c.origin ?? [
        (c.from[0] + c.to[0]) / 2,
        (c.from[1] + c.to[1]) / 2,
        (c.from[2] + c.to[2]) / 2,
      ],
      faces,
      type: 'cube',
      uuid: cubeUuids.get(c.name),
    };
    if (c.rotation) el.rotation = c.rotation;
    return el;
  });

  const childrenOf = new Map();
  for (const g of GROUPS) {
    const list = childrenOf.get(g.name) ?? [];
    childrenOf.set(g.name, list);
  }
  const cubeChildren = new Map();
  const groupChildren = new Map();
  for (const g of GROUPS) {
    groupChildren.set(g.name, []);
    cubeChildren.set(g.name, []);
  }
  for (const g of GROUPS) {
    if (g.parent) groupChildren.get(g.parent).push(g.name);
  }
  for (const c of CUBES) cubeChildren.get(c.group).push(c.name);

  // The outliner carries structure only; names and origins live in a flat `groups`
  // array. Both are required — a document with just one of them loads as unnamed bones.
  const buildGroup = (name) => ({
    uuid: ids.get(name),
    isOpen: true,
    children: [
      ...cubeChildren.get(name).map((n) => cubeUuids.get(n)),
      ...groupChildren.get(name).map((n) => buildGroup(n)),
    ],
  });

  const flatGroups = GROUPS.map((g) => ({
    name: g.name,
    uuid: ids.get(g.name),
    export: true,
    locked: false,
    scope: 0,
    selected: false,
    visibility: true,
    _static: { properties: {}, temp_data: {} },
    origin: g.pivot,
    rotation: g.rotation ?? [0, 0, 0],
    color: 0,
    children: [],
    reset: false,
    shade: true,
    mirror_uv: false,
    autouv: 0,
    isOpen: true,
    primary_selected: false,
  }));

  const animators = () => {
    const map = {};
    for (const g of GROUPS) {
      map[ids.get(g.name)] = {
        name: g.name,
        type: 'bone',
        rotation_global: false,
        quaternion_interpolation: false,
        keyframes: [],
      };
    }
    return map;
  };

  const animations = ANIMATIONS.map((a) => {
    const anims = animators();
    for (const k of a.build()) {
      const uuid = ids.get(k.node);
      if (!uuid) continue;
      anims[uuid].keyframes.push({
        channel: k.channel,
        data_points: [{ x: k.x, y: k.y, z: k.z }],
        uuid: bbUid(),
        time: k.time,
        color: -1,
        interpolation: k.interpolation,
        bezier_left_time: [0, 0, 0],
        bezier_left_value: [0, 0, 0],
        bezier_right_time: [0, 0, 0],
        bezier_right_value: [0, 0, 0],
      });
    }
    return {
      uuid: bbUid(),
      name: a.name,
      loop: a.loop,
      override: false,
      length: a.length,
      snapping: Math.min(120, Math.max(1, Math.round((a.build().length - 1) / a.length))),
      selected: false,
      group_name: '',
      scope: 0,
      anim_time_update: '',
      blend_weight: '',
      start_delay: '',
      loop_delay: '',
      animators: anims,
    };
  });

  const roots = GROUPS.filter((g) => !g.parent).map((g) => buildGroup(g.name));

  return {
    meta: {
      format_version: '5.0',
      model_format: 'free',
      box_uv: false,
      name: PROJECT,
    },
    name: PROJECT,
    model_identifier: PROJECT,
    visible_box: [1, 1, 0],
    variable_placeholders: '',
    multi_file_ruleset: '',
    variable_placeholder_buttons: [],
    timeline_setups: [],
    unhandled_root_fields: {},
    resolution: { width: 128, height: 128 },
    elements,
    groups: flatGroups,
    outliner: roots,
    textures: [
      {
        name: 'crate_atlas',
        path: '',
        folder: '',
        namespace: '',
        id: '0',
        group: '',
        scope: 0,
        width: 128,
        height: 128,
        uv_width: 128,
        uv_height: 128,
        particle: false,
        use_as_default: false,
        layers_enabled: false,
        sync_to_project: false,
        render_mode: 'default',
        render_sides: 'auto',
        wrap_mode: 'clamp',
        pbr_channel: 'color',
        internal: true,
        saved: false,
        uuid: bbUid(),
        source: ATLAS_DATA_URL,
      },
    ],
    animations,
  };
}

/* ------------------------------------------------------------------- phases */

async function phasePreflight() {
  const h = await waitForPlugin();
  log(`bridge up (${h.uptime_s}s), Blockbench ${h.plugin_connected ? 'connected' : 'NOT connected'}`);
  const info = await call('inspect_project', {});
  log(`live project: ${info?.project ? info.project.project_name : 'none'}`);
}

function phaseExport() {
  fs.mkdirSync(CRATE_DIR, { recursive: true });
  const model = compileModel();
  const json = JSON.stringify(model);
  const pretty = JSON.stringify(model, null, 1);
  fs.writeFileSync(PROJECT_FILE, pretty, 'utf8');
  // the atlas lives next to the project so the texture can be inspected on its own
  fs.writeFileSync(path.join(CRATE_DIR, 'crate_atlas.png'), atlasPng.png);
  log(`offline export → ${PROJECT_FILE} (${(json.length / 1024).toFixed(0)} KB minified, ${(pretty.length / 1024).toFixed(0)} KB on disk)`);
  log(`atlas → ${path.join(CRATE_DIR, 'crate_atlas.png')} (fill ${atlas.fill}, used height ${atlasPng.used_height}/128)`);
  return model;
}

async function phaseNew() {
  await call('new_project', { format: 'free', resolution: [128, 128] });
  await call('set_project_settings', { name: PROJECT });
  const info = await call('inspect_project', {});
  log(`created "${info?.project?.project_name}" ${info?.project?.resolution?.width}x${info?.project?.resolution?.height}`);
}

async function phaseGroups() {
  for (const g of GROUPS) {
    const args = { name: g.name, origin: g.pivot };
    if (g.parent) args.parent = { name: g.parent };
    await call('create_group', args);
  }
  const info = await call('inspect_project', {});
  log(`hierarchy: ${info?.project?.group_count} groups, ${info?.project?.element_count} elements`);
}

async function phaseCubes() {
  const cubes = CUBES.map((c) => {
    const def = {
      name: c.name,
      from: c.from,
      to: c.to,
      parent: c.group,
      autouv: 0,
      origin: c.origin ?? [
        (c.from[0] + c.to[0]) / 2,
        (c.from[1] + c.to[1]) / 2,
        (c.from[2] + c.to[2]) / 2,
      ],
    };
    if (c.rotation) def.rotation = c.rotation;
    return def;
  });
  await call('bulk_create_cubes', { cubes });
  const info = await call('inspect_model', {});
  log(`cubes: ${info?.cube_count} (expected ${CUBES.length}), cubes_without_texture ${info?.cubes_without_texture}`);
}

async function phaseTexture() {
  await call('import_texture', {
    name: 'crate_atlas',
    data_url: ATLAS_DATA_URL,
    assign_to: CUBES.map((c) => ({ name: c.name })),
  });
  const tex = await call('inspect_textures', {});
  const t = tex?.textures?.[0];
  log(`texture: ${t?.name} ${t?.width}x${t?.height} internal=${t?.internal}`);
}

async function phaseUv() {
  for (const cube of CUBES) {
    await call('set_uv', { reference: { name: cube.name }, faces: UV[cube.name], autouv: 0, box_uv: false });
  }
  log(`uv: applied explicit islands to ${CUBES.length} cubes (${CUBES.length * 6} faces)`);
}

/** bulk_create_keyframes refuses more than 2000 items, so long clips are sent in parts. */
const KEYFRAME_CHUNK = 1500;

async function phaseAnimations() {
  // idempotent: re-running the phase must not trip over animations that already exist
  const existing = (await call('inspect_animations', {}))?.animations ?? [];
  const wanted = new Set(ANIMATIONS.map((a) => a.name));
  const stale = existing.filter((a) => wanted.has(a.name));
  for (const a of stale) await call('delete_animation', { name: a.name, confirm: true });
  if (stale.length) log(`cleared ${stale.length} existing clip(s) before rebuilding`);

  for (const anim of ANIMATIONS) {
    const keys = anim.build();
    await call('create_animation', {
      name: anim.name,
      loop: anim.loop,
      length: anim.length,
      snapping: Math.max(1, Math.min(120, Math.round((keys.length - 1) / anim.length))),
    });
    for (let i = 0; i < keys.length; i += KEYFRAME_CHUNK) {
      const part = keys.slice(i, i + KEYFRAME_CHUNK);
      await call('bulk_create_keyframes', {
        animation: anim.name,
        keyframes: part,
        set_length: true,
      });
    }
    log(`  ${anim.name.padEnd(16)} ${keys.length} keys in ${Math.ceil(keys.length / KEYFRAME_CHUNK)} part(s)`);
  }
  const audit = await call('inspect_animations', {});
  const list = audit?.animations ?? [];
  const empty = list.filter((a) => !(a.keyframe_count ?? a.keys));
  log(`animations: ${list.length} created, ${empty.length} empty`);
  for (const a of list) log(`  ${String(a.name).padEnd(16)} ${String(a.length).padStart(5)}s ${String(a.loop).padEnd(5)} keys=${a.keyframe_count ?? a.keys}`);
}

/* --------------------------------------------------------------- screenshots */

const ANGLES = [
  ['front', 'south'],
  ['back', 'north'],
  ['left', 'east'],
  ['right', 'west'],
  ['top', 'top'],
  ['iso_right', 'isometric_right'],
  ['iso_left', 'isometric_left'],
];

async function shot(key, preset, resolution = 700) {
  fs.mkdirSync(VIEWPORT_DIR, { recursive: true });
  // Frame explicitly first. `frame: true` on the capture alone is not enough: the very
  // first capture of a session solves the ortho zoom against a viewport that has not been
  // framed yet, which silently crops the model to its own bounding box edges.
  await call('frame_viewport', { angle: preset, padding: 0.85 });
  const image = await call('get_viewport_image', {
    angle: preset,
    resolution,
    anti_aliasing: 'msaa',
    shading: true,
    frame: true,
    padding: 0.85,
  });
  const buffer = Buffer.from(image.data_url.split(',')[1], 'base64');
  const file = path.join(VIEWPORT_DIR, `${TAG}_${key}.png`);
  fs.writeFileSync(file, buffer);
  return { file, buffer };
}

const isBackground = (r, g, b, a) => a < 16 || (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 200);

function analyse(buffer) {
  const png = PNG.sync.read(buffer);
  let minX = png.width;
  let maxX = -1;
  let minY = png.height;
  let maxY = -1;
  let ink = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      if (isBackground(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3])) continue;
      ink += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { empty: true };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return {
    empty: false,
    w,
    h,
    aspect: Math.round((w / h) * 100) / 100,
    fill: Math.round((ink / (png.width * png.height)) * 1000) / 1000,
    cx: Math.round(((minX + maxX) / 2 / png.width) * 1000) / 1000,
    cy: Math.round(((minY + maxY) / 2 / png.height) * 1000) / 1000,
  };
}

/** Crop to the model, then render as text — the display this agent can always read. */
function ascii(buffer, cols = 96) {
  const full = PNG.sync.read(buffer);
  let minX = full.width;
  let maxX = -1;
  let minY = full.height;
  let maxY = -1;
  for (let y = 0; y < full.height; y += 1) {
    for (let x = 0; x < full.width; x += 1) {
      const i = (y * full.width + x) * 4;
      if (isBackground(full.data[i], full.data[i + 1], full.data[i + 2], full.data[i + 3])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return '(empty)';
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(full.width - 1, maxX + pad);
  maxY = Math.min(full.height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  // terminal cells are ~2:1, so halve the rows
  let rows = Math.round((cols * h) / w / 2);
  if (rows > 48) {
    rows = 48;
    cols = Math.max(16, Math.round((rows * 2 * w) / h));
  }
  rows = Math.max(6, rows);
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.floor(minX + (c * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(minX + ((c + 1) * w) / cols));
      const y0 = Math.floor(minY + (r * h) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(minY + ((r + 1) * h) / rows));
      let ink = 0;
      let luma = 0;
      let total = 0;
      for (let y = y0; y < y1 && y <= maxY; y += 1) {
        for (let x = x0; x < x1 && x <= maxX; x += 1) {
          const i = (y * full.width + x) * 4;
          total += 1;
          if (isBackground(full.data[i], full.data[i + 1], full.data[i + 2], full.data[i + 3])) continue;
          ink += 1;
          luma += 0.299 * full.data[i] + 0.587 * full.data[i + 1] + 0.114 * full.data[i + 2];
        }
      }
      if (!total || ink / total < 0.15) {
        line += ' ';
        continue;
      }
      const shade = ink > 0 ? luma / ink / 255 : 0;
      line += ramp[Math.max(1, Math.min(ramp.length - 1, Math.round(shade * (ramp.length - 1))))];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

function contactSheet(rows, title) {
  const cells = rows.map(([key, preset, file]) => {
    const b64 = fs.readFileSync(file).toString('base64');
    return `<figure><img src="data:image/png;base64,${b64}" alt="${key}"><figcaption>${key} <span>${preset}</span></figcaption></figure>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{margin:0;background:#12101a;color:#eceaf4;font:13px/1.4 system-ui,sans-serif}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}
 figure{margin:0;background:#1c1926;border:1px solid #322c44;border-radius:6px;overflow:hidden}
 img{display:block;width:100%;background:#1c1926}
 figcaption{padding:5px 8px;font-weight:600}
 figcaption span{color:#8b84a1;font-weight:400}
</style>
<div class="grid">${cells}</div>`;
  const out = path.join(VIEWPORT_DIR, `${TAG}_sheet.html`);
  fs.writeFileSync(out, html, 'utf8');
  log(`contact sheet → ${out} (${Math.round(html.length / 1024)} KB)`);
  return out;
}

async function phaseShots() {
  const wanted = value('views', '');
  const selected = wanted ? ANGLES.filter(([k]) => wanted.split(',').includes(k)) : ANGLES;
  const rows = [];
  const metrics = {};
  for (const [key, preset] of selected) {
    const { file, buffer } = await shot(key, preset, Number(value('res', '700')));
    metrics[key] = analyse(buffer);
    rows.push([key, preset, file]);
  }
  for (const [key, m] of Object.entries(metrics)) {
    log(`${key.padEnd(9)} ${m.empty ? 'EMPTY!' : `w${m.w} h${m.h} aspect ${m.aspect} fill ${m.fill} cx ${m.cx} cy ${m.cy}`}`);
  }
  if (flag('ascii')) {
    for (const [key, , file] of rows) {
      console.log(`\n─── ${TAG} · ${key} ${'─'.repeat(40)}`);
      console.log(ascii(fs.readFileSync(file), Number(value('w', '96'))));
    }
  }
  fs.writeFileSync(path.join(VIEWPORT_DIR, `${TAG}_metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  const sheet = contactSheet(rows, `${TAG} crate QA`);
  console.log(`\nSHEET ${sheet}\n`);
  return metrics;
}

async function phaseValidate() {
  const report = await call('validate_model', { max_issues: 120 });
  const issues = report?.issues ?? [];
  const bySeverity = {};
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  log(`validate_model: ${issues.length} issues ${JSON.stringify(bySeverity)}`);
  for (const issue of issues.slice(0, 30)) warn(`[${issue.severity}] ${issue.message ?? issue.code}`);

  const hier = await call('inspect_hierarchy', { max_depth: 4 });
  const model = await call('inspect_model', {});
  log(`model: ${model?.cube_count} cubes, bounds ${JSON.stringify(model?.size)}, no-texture ${model?.cubes_without_texture}`);
  const audit = await call('inspect_animations', {});
  const list = audit?.animations ?? [];
  const empty = list.filter((a) => !(a.keyframe_count ?? a.keys));
  log(`animations: ${list.length}, empty: ${empty.length}${empty.length ? ` (${empty.map((a) => a.name).join(', ')})` : ''}`);
  fs.writeFileSync(
    path.join(CRATE_DIR, `${TAG}_validate.json`),
    `${JSON.stringify({ report, model, hierarchy: hier, animations: list }, null, 2)}\n`,
  );
  return { report, list };
}

/**
 * Reload the offline export into the live session in a single tool call.
 *
 * Authoring 16k keyframes takes eight separate calls, and Blockbench has a habit of
 * exiting between any two of them; this collapses recovery to one round trip.
 */
async function phaseRestore() {
  if (!fs.existsSync(PROJECT_FILE)) throw new Error(`nothing to restore: ${PROJECT_FILE} does not exist`);
  const model = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
  const res = await call('open_project', { model, path: PROJECT_FILE.replace(/\\/g, '/') });
  const info = await call('inspect_project', {});
  const im = await call('inspect_model', {});
  log(`restored ${info?.project?.project_name} — ${im?.cube_count} cubes (expected ${CUBES.length}), ${info?.project?.animation_count ?? '?'} animations`);
  const tex = await call('inspect_textures', {});
  const t = tex?.textures?.[0];
  log(`texture: ${t?.name} ${t?.width}x${t?.height}`);
  return res;
}

/** Record a restorable checkpoint, including a compiled model snapshot. */
async function phaseCheckpoint() {
  const res = await fetch(`${BASE}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: LABEL }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`checkpoint failed: ${res.status} ${JSON.stringify(body)}`);
  log(`checkpoint ${body.checkpoint_id ?? '?'} — "${body.label ?? LABEL}"`);
  return body;
}

async function phaseSave() {
  const payload = await call('save_project', {});
  fs.mkdirSync(CRATE_DIR, { recursive: true });
  const json = JSON.stringify(payload?.model ?? payload);
  const temp = `${PROJECT_FILE}.tmp-${Date.now()}`;
  fs.writeFileSync(temp, json, 'utf8');
  fs.renameSync(temp, PROJECT_FILE);
  await call('mark_project_saved', { save_path: PROJECT_FILE.replace(/\\/g, '/') });
  const onDisk = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
  const keyed = (onDisk.animations ?? []).filter((a) =>
    Object.values(a.animators ?? {}).some((an) =>
      (an.keyframes ?? []).some((k) => (k.data_points ?? []).length),
    ),
  ).length;
  log(`saved → ${PROJECT_FILE} (${(json.length / 1024).toFixed(0)} KB)`);
  log(`round trip: ${(onDisk.elements ?? []).length} cubes, ${(onDisk.animations ?? []).length} animations (${keyed} keyed), ${(onDisk.textures ?? []).length} texture(s)`);
  return { file: PROJECT_FILE, bytes: json.length, cubes: (onDisk.elements ?? []).length, animations: (onDisk.animations ?? []).length, keyed };
}

/* --------------------------------------------------------------------- main */

const PHASES = [
  ['preflight', phasePreflight],
  ['export', phaseExport],
  ['audit', () => {
    const v = validateAnimations();
    log(`animation validation: ${v.ok ? 'clean' : `${v.problems.length} problems`} · ${v.total_keyframes} keyframes`);
    for (const p of [...new Set(v.problems)].slice(0, 20)) warn(p);
    return v;
  }],
  ['new', phaseNew],
  ['groups', phaseGroups],
  ['cubes', phaseCubes],
  ['texture', phaseTexture],
  ['uv', phaseUv],
  ['animations', phaseAnimations],
  ['restore', phaseRestore],
  ['checkpoint', phaseCheckpoint],
  ['shots', phaseShots],
  ['validate', phaseValidate],
  ['save', SKIP_SAVE ? async () => log('save skipped') : phaseSave],
];

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('phases: ' + PHASES.map(([n]) => n).join(', '));
    return;
  }
  for (const [name, fn] of PHASES) {
    if (!phase(name)) continue;
    stepName = name;
    await fn();
  }
  log('done');
}

main().catch((error) => {
  console.error(`\nFAILED in phase "${stepName}": ${error.message}`);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2).slice(0, 3000));
  process.exitCode = 1;
});
