#!/usr/bin/env node
/**
 * T-Rex professional polish pass.
 *
 * Every model change goes through the bridge's tool registry — the same path an
 * LLM-driven agent run uses. No hand-editing of the .bbmodel, no DOM access.
 *
 * Phases (run in this order):
 *
 *   preflight   health, project identity, baseline audit
 *   open        load trex.bbmodel into the live Blockbench session
 *   checkpoint  store a named bridge checkpoint
 *   geometry    silhouette / anatomy / pivot refinement (modify_node + additions)
 *   texture     repaint the skin: shading, pattern, face detail
 *   uv          re-lay the UVs and re-anchor the palette
 *   animations  author all 25 animations
 *   shots       render the QA angles and build a contact sheet
 *   validate    validate_model + animation audit
 *   save        compile, write to disk, verify the round trip
 *
 * Usage:
 *   node tools/polish-trex.mjs                      # all phases
 *   node tools/polish-trex.mjs --only open,shots     # a subset
 *   node tools/polish-trex.mjs --skip-save
 *   node tools/polish-trex.mjs --tag pass2           # names the output files
 *
 * Requires the bridge on 127.0.0.1:47311 with Blockbench connected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const BASE = process.env.AI_AGENT_BRIDGE ?? 'http://127.0.0.1:47311';
const WORKSPACE = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
const VIEWPORT_DIR = path.join(WORKSPACE, 'ai_context', 'viewport');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
/** Reads `--name=value` or `--name value`. */
const value = (name, fallback) => {
  const exact = argv.indexOf(`--${name}`);
  if (exact >= 0) {
    const next = argv[exact + 1];
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
const PROJECT_NAME = value('project', 'trex');
const PROJECT_FILE = path.join(WORKSPACE, `${PROJECT_NAME}.bbmodel`);
const TAG = value('tag', 'polish');
const SKIP_SAVE = flag('skip-save');
const phase = (name) => !ONLY || ONLY.has(name);

/* ------------------------------------------------------------------ helpers */

const t0 = Date.now();
let stepName = 'init';
function log(message) {
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${stepName.padEnd(10)} ${message}`);
}
// eslint-disable-next-line no-console
const warn = (message) => console.log(`           ! ${message}`);

async function call(tool, args = {}) {
  const response = await fetch(`${BASE}/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!body.ok) {
    const message = body.error?.message ?? JSON.stringify(body.error ?? body);
    const failure = new Error(`${tool}: ${message}`);
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

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* --------------------------------------------------------------- keyframes */

/**
 * A keyframe. `interpolation` is coerced to a legal string here, once, so a
 * malformed call site can never poison a whole bulk_create_keyframes payload.
 */
const INTERPOLATIONS = new Set(['linear', 'catmullrom', 'bezier', 'step']);
function kf(node, channel, time, x, y, z, interpolation = 'catmullrom') {
  const interp = typeof interpolation === 'string' && INTERPOLATIONS.has(interpolation) ? interpolation : 'catmullrom';
  const num = (v) => (Number.isFinite(Number(v)) ? round3(Number(v)) : 0);
  return {
    node: String(node),
    channel: INTERPOLATIONS.has(channel) ? channel : channel === 'rotation' || channel === 'position' || channel === 'scale' ? channel : 'rotation',
    time: round3(time),
    x: num(x),
    y: num(y),
    z: num(z),
    interpolation: interp,
  };
}

/** Sample a normalised 0..1 cycle, emitting one keyframe per sample. */
function cyc(node, channel, length, samples, fn, interpolation = 'catmullrom') {
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

/**
 * Explicitly posed frames.
 * entries: [time, rotations, positions?, interpolation?] — positions and
 * interpolation are both optional and the order does not matter as long as
 * interpolation is a string.
 */
function pose(entries) {
  const keys = [];
  for (const entry of entries) {
    const time = entry[0];
    let interpolation = 'catmullrom';
    const objects = [];
    for (const item of entry.slice(1)) {
      if (typeof item === 'string') interpolation = item;
      else if (item && typeof item === 'object') objects.push(item);
    }
    for (const [bone, v] of Object.entries(objects[0] ?? {})) {
      keys.push(kf(bone, 'rotation', time, v[0], v[1], v[2], interpolation));
    }
    for (const [bone, v] of Object.entries(objects[1] ?? {})) {
      keys.push(kf(bone, 'position', time, v[0], v[1], v[2], interpolation));
    }
  }
  return keys;
}

/* --------------------------------------------------------------- the model */

const BONES = {
  root: [0, 0, 0],
  body: [0, 22, -4],
  chest: [0, 24, 4],
  neck_01: [0, 27, 12],
  neck_02: [0, 30, 17],
  neck_03: [0, 32.5, 21],
  head: [0, 34, 25],
  upper_jaw: [0, 34, 31],
  lower_jaw: [0, 30.5, 27.5],
  eyes: [0, 35.5, 31.5],
  left_arm: [6.5, 25, 7],
  left_lower_arm: [7, 22, 7.5],
  left_claws: [7, 20, 7.5],
  right_arm: [-6.5, 25, 7],
  right_lower_arm: [-7, 22, 7.5],
  right_claws: [-7, 20, 7.5],
  left_leg: [6.2, 19.5, -2],
  left_shin: [6.2, 9.5, -1],
  left_foot: [6.2, 4, 0],
  left_toes: [6.2, 3, 7],
  right_leg: [-6.2, 19.5, -2],
  right_shin: [-6.2, 9.5, -1],
  right_foot: [-6.2, 4, 0],
  right_toes: [-6.2, 3, 7],
  tail_01: [0, 22, -9],
  tail_02: [0, 22, -17],
  tail_03: [0, 22, -25],
  tail_04: [0, 22, -33],
  tail_05: [0, 22, -41],
  tail_06: [0, 22, -49],
  tail_07: [0, 22, -56],
};
const TAIL = ['tail_01', 'tail_02', 'tail_03', 'tail_04', 'tail_05', 'tail_06', 'tail_07'];

/* -------------------------------------------------------------- basic tools */

async function checkpoint(label) {
  const result = await call('checkpoint', { label, include_snapshot: true });
  const id = result?.checkpoint?.id ?? result?.id ?? '?';
  log(`checkpoint "${label}" → ${id}`);
  return id;
}

async function projectState() {
  const result = await call('inspect_project', {});
  return result.project ?? {};
}

function describe(p) {
  return `${p.project_name ?? '?'} (${p.format_id ?? '?'}) · ${p.element_count ?? 0} cubes · ${p.group_count ?? 0} bones · ${p.texture_count ?? 0} textures · ${p.animation_count ?? 0} animations · ${p.resolution?.width}x${p.resolution?.height}`;
}

async function openProject() {
  const model = JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8'));
  await call('open_project', { model, path: PROJECT_FILE.replace(/\\/g, '/') });
  const state = await projectState();
  log(`opened ${path.basename(PROJECT_FILE)} — ${describe(state)}`);
  return state;
}

const ANGLES = [
  ['front', 'south'],
  ['back', 'north'],
  ['left', 'east'],
  ['right', 'west'],
  ['top', 'top'],
  ['iso_right', 'isometric_right'],
  ['iso_left', 'isometric_left'],
];

async function shot(angleKey, preset, resolution = 640) {
  fs.mkdirSync(VIEWPORT_DIR, { recursive: true });
  // frame:true recentres on the model bounds and solves the ortho zoom, so a rig that
  // is 106 units long is not cropped by presets written for a 16-unit block.
  const image = await call('get_viewport_image', {
    angle: preset,
    resolution,
    anti_aliasing: 'msaa',
    shading: true,
    frame: true,
    padding: 0.8,
  });
  const buffer = Buffer.from(image.data_url.split(',')[1], 'base64');
  const file = path.join(VIEWPORT_DIR, `${TAG}_${angleKey}.png`);
  fs.writeFileSync(file, buffer);
  return { file, buffer, width: image.width, height: image.height };
}

/** Silhouette metrics: how much of the frame the model fills and where it sits. */
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
      const [r, g, b, a] = [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
      if (a < 16) continue;
      if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 200) continue; // grid/background
      ink += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { empty: true };
  return {
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    aspect: round3((maxX - minX + 1) / (maxY - minY + 1)),
    fill: round3(ink / (png.width * png.height)),
    cx: round3((minX + maxX) / 2 / png.width),
    cy: round3((minY + maxY) / 2 / png.height),
  };
}

/**
 * A contact sheet with the PNGs inlined as data URLs, so the file is fully
 * self-contained and renders identically wherever it is served from.
 */
/**
 * Render a PNG as an ASCII picture.
 *
 * A terminal is the one display this agent can always read back, so the QA views are
 * also printed as text: shape (a glyph per cell), brightness shading, and the frame
 * border so proportions are measurable by eye.
 */
/** Trim the empty frame around the model so a text render is all model. */
function cropToInk(full) {
  let minX = full.width;
  let maxX = -1;
  let minY = full.height;
  let maxY = -1;
  for (let y = 0; y < full.height; y += 1) {
    for (let x = 0; x < full.width; x += 1) {
      const i = (y * full.width + x) * 4;
      const [r, g, b, a] = [full.data[i], full.data[i + 1], full.data[i + 2], full.data[i + 3]];
      if (a < 16) continue;
      if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 200) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return full;
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(full.width - 1, maxX + pad);
  maxY = Math.min(full.height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = ((y + minY) * full.width + (x + minX)) * 4;
      const dst = (y * w + x) * 4;
      out.data[dst] = full.data[src];
      out.data[dst + 1] = full.data[src + 1];
      out.data[dst + 2] = full.data[src + 2];
      out.data[dst + 3] = full.data[src + 3];
    }
  }
  return out;
}

function ascii(buffer, cols = 108, rows = 0) {
  const png = cropToInk(PNG.sync.read(buffer));
  // Terminal cells are about twice as tall as they are wide, so halve the rows.
  const maxRows = 56;
  if (!rows) {
    rows = Math.round((cols * png.height) / png.width / 2);
    if (rows > maxRows) {
      rows = maxRows;
      cols = Math.max(12, Math.round((rows * 2 * png.width) / png.height));
    }
    rows = Math.max(6, rows);
  }
  const lines = [];
  const ramp = ' .:-=+*#%@';
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.floor((c * png.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * png.width) / cols));
      const y0 = Math.floor((r * png.height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * png.height) / rows));
      let ink = 0;
      let luma = 0;
      let total = 0;
      for (let y = y0; y < y1 && y < png.height; y += 1) {
        for (let x = x0; x < x1 && x < png.width; x += 1) {
          const i = (y * png.width + x) * 4;
          const [rr, gg, bb, aa] = [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
          total += 1;
          if (aa < 16) continue;
          if (Math.abs(rr - gg) < 8 && Math.abs(gg - bb) < 8 && rr > 200) continue;
          ink += 1;
          luma += 0.299 * rr + 0.587 * gg + 0.114 * bb;
        }
      }
      const coverage = total ? ink / total : 0;
      if (coverage < 0.12) { line += ' '; continue; }
      const mean = ink ? luma / ink / 255 : 0;
      // Darkness carries the shape: the ramp is inverted so solid mass reads as dense.
      const idx = Math.min(ramp.length - 1, Math.max(1, Math.round((0.35 + (1 - mean) * 0.65) * (ramp.length - 1) * Math.min(1, coverage * 1.6))));
      line += ramp[idx];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

function printAscii(label, file, cols, rows) {
  const buffer = fs.readFileSync(file);
  console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  console.log(ascii(buffer, cols, rows));
}

function contactSheet(rows) {
  const cols = Number(value('cols', '3'));
  const cells = rows
    .map(([key, preset, file]) => {
      const b64 = fs.readFileSync(file).toString('base64');
      return `<figure><img src="data:image/png;base64,${b64}" alt="${key}"><figcaption>${key} <span>${preset}</span></figcaption></figure>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${TAG} T-Rex QA</title>
<style>
 body{margin:0;background:#14161a;color:#e8e8ea;font:13px/1.4 system-ui,sans-serif}
 .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;padding:8px}
 figure{margin:0;background:#1d2026;border:1px solid #2c313a;border-radius:6px;overflow:hidden}
 img{display:block;width:100%;image-rendering:auto;background:#20242b}
 figcaption{padding:5px 8px;font-weight:600;letter-spacing:.02em}
 figcaption span{color:#8b93a1;font-weight:400}
</style>
<div class="grid">${cells}</div>`;
  const out = path.join(VIEWPORT_DIR, `${TAG}_sheet.html`);
  fs.writeFileSync(out, html, 'utf8');
  log(`contact sheet → ${out} (${Math.round(html.length / 1024)} KB)`);
  return out;
}

/* ------------------------------------------------------------------ phases */

/**
 * Blockbench drops its link now and then (and exits outright occasionally), so every run
 * waits for it rather than failing a long phase half way through.
 */
async function waitForPlugin(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      const h = await health();
      if (h.plugin_connected) {
        if (announced) log('plugin reconnected');
        return h;
      }
    } catch {
      /* bridge may still be starting */
    }
    if (Date.now() > deadline) throw new Error('Blockbench did not connect to the bridge within ' + timeoutMs / 1000 + 's');
    if (!announced) {
      warn('waiting for Blockbench to connect…');
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function phasePreflight() {
  const h = await waitForPlugin();
  log(`bridge up (${h.uptime_s}s), Blockbench connected`);
  const pre = await projectState();
  log(`live project: ${describe(pre)}`);
  return pre;
}

async function phaseOpen() {
  return openProject();
}

async function phaseShots() {
  const rows = [];
  const metrics = {};
  const wanted = value('views', '');
  const selected = wanted ? ANGLES.filter(([key]) => wanted.split(',').includes(key)) : ANGLES;
  for (const [key, preset] of selected) {
    const { file, buffer } = await shot(key, preset, Number(value('res', '700')));
    metrics[key] = analyse(buffer);
    rows.push([key, preset, file]);
  }
  for (const [key, m] of Object.entries(metrics)) {
    log(`${key.padEnd(9)} ${m.empty ? 'EMPTY!' : `w${m.w} h${m.h} aspect ${m.aspect} fill ${m.fill} cx ${m.cx} cy ${m.cy}`}`);
  }
  if (flag('ascii')) {
    for (const [key, , file] of rows) printAscii(`${TAG} · ${key}`, file, Number(value('w', '100')), Number(value('h', '0')));
  }
  fs.writeFileSync(path.join(VIEWPORT_DIR, `${TAG}_metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  const sheet = contactSheet(rows);
  console.log(`
SHEET ${sheet}
`);
  return metrics;
}

async function phaseValidate() {
  const report = await call('validate_model', { max_issues: 80 });
  const issues = report?.issues ?? [];
  const bySeverity = {};
  for (const issue of issues) bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  log(`validate_model: ${issues.length} issues ${JSON.stringify(bySeverity)}`);
  for (const issue of issues.slice(0, 25)) warn(`[${issue.severity}] ${issue.message ?? issue.code}`);
  const anims = await call('inspect_animations', { include_animators: false });
  const list = anims?.animations ?? [];
  log(`animations present: ${list.length}`);
  for (const a of list) {
    const keys = a.keyframe_count ?? a.keys ?? '?';
    log(`  ${String(a.name).padEnd(16)} ${String(a.length).padStart(6)}s ${a.loop ?? ''} keys=${keys}`);
  }
  return { report, list };
}

async function phaseSave() {
  // The plugin has no filesystem access, so it compiles the document and this script
  // writes it — the same split the bridge's own `save` tool uses. Written via a temp file
  // so a crash cannot leave a truncated project that Blockbench would happily open.
  const payload = await call('save_project', {});
  const target = path.join(WORKSPACE, `${value('save-as', PROJECT_NAME)}.bbmodel`);
  const json = JSON.stringify(payload?.model ?? payload, null, 2);
  const temp = `${target}.tmp-${Date.now()}`;
  fs.writeFileSync(temp, `${json}\n`, 'utf8');
  fs.renameSync(temp, target);
  await call('mark_project_saved', { save_path: target.replace(/\\/g, '/') });
  const result = { saved_to: target, bytes: Buffer.byteLength(json) };
  log(`saved → ${result.saved_to} (${result.bytes} bytes)`);
  const onDisk = JSON.parse(fs.readFileSync(result.saved_to, 'utf8'));
  const animsWithKeys = (onDisk.animations ?? []).filter((a) =>
    Object.values(a.animators ?? {}).some((an) => Object.values(an.keyframes ?? {}).some((l) => Array.isArray(l) && l.length)),
  ).length;
  log(`round trip: ${(onDisk.elements ?? []).length} cubes, ${(onDisk.groups ?? []).length} bones, ${(onDisk.animations ?? []).length} animations (${animsWithKeys} carrying keyframes), ${(onDisk.textures ?? []).length} textures`);
  return result;
}

const PHASES = [
  ['preflight', phasePreflight],
  ['open', phaseOpen],
  ['cp-before', async () => checkpoint(`before ${TAG} polish pass`)],
  ['cp-after', async () => checkpoint(`after ${TAG} polish pass`)],
  ['geometry', async () => { const m = await import('./polish-geometry.mjs'); return m.run(call, log, warn); }],
  // UV before texture: the texture pass paints the rectangles the UV pass recorded.
  ['uv', async () => { const m = await import('./polish-uv.mjs'); return m.run(call, log, warn); }],
  ['texture', async () => { const m = await import('./polish-texture.mjs'); return m.run(call, log, warn); }],
  ['animations', async () => { const m = await import('./polish-animations.mjs'); return m.run(call, log, warn, { kf, cyc, pose, TAIL, BONES }); }],
  ['shots', phaseShots],
  ['validate', phaseValidate],
  ['save', SKIP_SAVE ? async () => log('save skipped') : phaseSave],
];

async function main() {
  for (const [name, fn] of PHASES) {
    if (!phase(name)) continue;
    stepName = name;
    // Cheap insurance: a phase is a sequence of tool calls, and losing the link part way
    // through leaves a half-applied transaction.
    await waitForPlugin(45_000);
    await fn();
  }
}

main().catch((error) => {
  console.error(`\nFAILED in phase "${stepName}": ${error.message}`);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2).slice(0, 3000));
  process.exitCode = 1;
});
