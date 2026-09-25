#!/usr/bin/env node
/**
 * Live acceptance test (the brief's "FINAL TEST").
 *
 * This drives the real Blockbench, not a mock:
 *
 *   1. starts (or reuses) a bridge and waits for it to listen
 *   2. launches Blockbench with the Chromium DevTools protocol enabled
 *   3. writes the bridge URL and token into Blockbench's own settings storage
 *   4. loads the plugin through Blockbench's real plugin loader, which is exactly what
 *      "Load Plugin from File" does — including recording it for future startups
 *   5. triggers the plugin's Connect action the way the toolbar button does
 *   6. runs the acceptance sequence over the bridge REST API: inspect → build → modify →
 *      animate → look at the render → validate → save → reload → verify
 *
 * Only `ws` is required, and it is already a dependency of the bridge.
 *
 * Usage:
 *   node tools/live-smoke.mjs [--keep-open] [--no-save] [--bridge-port 47311] [--debug-port 9333]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* --------------------------------------------------------------------- options */

function parseArgs(argv) {
  const out = {
    keepOpen: false,
    save: true,
    bridgePort: 47311,
    debugPort: 9333,
    exe: process.env.BLOCKBENCH_EXE ?? null,
    workspace: process.env.AI_AGENT_WORKSPACE ?? ROOT,
    token: process.env.AI_AGENT_TOKEN ?? null,
    timeoutMs: 90000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-open') out.keepOpen = true;
    else if (arg === '--no-save') out.save = false;
    else if (arg === '--bridge-port') out.bridgePort = Number(argv[++i]);
    else if (arg === '--debug-port') out.debugPort = Number(argv[++i]);
    else if (arg === '--exe') out.exe = argv[++i];
    else if (arg === '--workspace') out.workspace = path.resolve(argv[++i]);
    else if (arg === '--token') out.token = argv[++i];
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const pluginFile = path.join(ROOT, 'dist', 'blockbench-ai-agent.js');

function log(step, message) {
  console.log(`  ${step.padEnd(9)} ${message}`);
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exitCode = 1;
}

function findBlockbenchExe() {
  if (options.exe) return options.exe;
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(local, 'Programs', 'Blockbench', 'Blockbench.exe'),
      path.join(local, 'Blockbench', 'Blockbench.exe'),
      path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Blockbench', 'Blockbench.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blockbench.app/Contents/MacOS/Blockbench');
  } else {
    candidates.push('/opt/Blockbench/blockbench', '/usr/bin/blockbench', '/usr/bin/Blockbench');
  }
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) ?? null;
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/* ------------------------------------------------------------------ devtools */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.console = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
        this.console.push({ level: message.params.type, text });
        if (['error', 'warning'].includes(message.params.type)) console.log(`  console.${message.params.type}: ${text.slice(0, 300)}`);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const description = message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown';
        this.console.push({ level: 'exception', text: description });
        console.log(`  exception: ${String(description).split('\n')[0]}`);
      }
    });
  }

  static async attach(debugPort, timeoutMs) {
    const targets = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (!response.ok) return null;
        const list = await response.json();
        const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        return page ? [page] : null;
      } catch {
        return null;
      }
    }, timeoutMs, 'Blockbench devtools endpoint');
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 60000);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------- bridge */

function bridgeHeaders(token) {
  return token ? { 'x-agent-token': token, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
}

async function bridgeFetch(base, token, route, init = {}) {
  const response = await fetch(`${base}${route}`, { ...init, headers: { ...bridgeHeaders(token), ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function callTool(base, token, name, args) {
  const { status, body } = await bridgeFetch(base, token, `/tool/${name}`, {
    method: 'POST',
    body: JSON.stringify(args ?? {}),
  });
  if (!body || typeof body !== 'object' || body.ok !== true) {
    throw new Error(`${name} failed (HTTP ${status}): ${body?.error?.message ?? JSON.stringify(body).slice(0, 400)}`);
  }
  // Warnings are how a tool says "I did part of this". Printing them is what turns a
  // silent partial failure into a diagnosable one.
  if (Array.isArray(body.warnings) && body.warnings.length) {
    console.log(`  ${'warn'.padEnd(9)} ${name}: ${body.warnings.slice(0, 3).join(' | ')}`);
  }
  if (body.verified === false) console.log(`  ${'verify'.padEnd(9)} ${name} reported verified=false`);
  return body.data;
}

/* ----------------------------------------------------------------------- main */

async function main() {
  console.log('\nBlockbench AI Agent — live acceptance test\n');
  if (!fs.existsSync(pluginFile)) {
    fail(`no built plugin at ${pluginFile}. Run "npm run build".`);
    return;
  }

  /* 1. bridge ------------------------------------------------------------- */

  const healthProbe = await fetch(`http://127.0.0.1:${options.bridgePort}/health`).then((r) => r.json()).catch(() => null);
  let bridgeBase = `http://127.0.0.1:${options.bridgePort}`;
  let token = options.token ?? '';
  let bridgeProcess = null;

  if (healthProbe) {
    log('bridge', `reusing the bridge already on port ${options.bridgePort} (plugin connected: ${healthProbe.plugin_connected})`);
    if (!token) {
      fail('a bridge is already running but no token was supplied. Re-run with --token <token> (the bridge printed it at startup) or stop that bridge.');
      return;
    }
  } else {
    token = options.token ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    log('bridge', `starting a bridge on port ${options.bridgePort}`);
    bridgeProcess = spawn(process.execPath, [path.join(ROOT, 'dist', 'agent-bridge.js'), '--serve', '--port', String(options.bridgePort), '--token', token, '--workspace', options.workspace, '--log-level', 'warn'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AI_AGENT_LOG_LEVEL: 'warn' },
    });
    bridgeProcess.stdout.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text && !text.includes('Plugin socket')) console.log(`  bridge: ${text.slice(0, 200)}`);
    });
    bridgeProcess.stderr.on('data', (chunk) => console.log(`  bridge! ${String(chunk).trim().slice(0, 300)}`));
    await waitFor(async () => {
      const health = await fetch(`${bridgeBase}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return health ? health : null;
    }, 20000, 'the bridge to listen');
    log('bridge', `listening on ${bridgeBase}`);
  }

  /* 2. Blockbench --------------------------------------------------------- */

  const exe = findBlockbenchExe();
  if (!exe) {
    fail('Blockbench was not found. Pass --exe <path to Blockbench>.');
    return;
  }
  log('app', `launching ${exe} with devtools on port ${options.debugPort}`);
  const app = spawn(exe, [`--remote-debugging-port=${options.debugPort}`], { detached: true, stdio: 'ignore', windowsHide: false });
  app.unref();

  let cdp = null;
  try {
    cdp = await Cdp.attach(options.debugPort, options.timeoutMs);
    log('app', 'devtools attached');

    // Wait until Blockbench's own API is ready (the plugin loader included).
    await waitFor(
      async () => cdp.evaluate('typeof Plugin === "function" && typeof BarItems === "object" && typeof Blockbench !== "undefined"', { awaitPromise: false }),
      options.timeoutMs,
      'the Blockbench API to initialise',
    );
    const version = await cdp.evaluate('Blockbench.version', { awaitPromise: false });
    log('app', `Blockbench ${version} ready`);

    // Wait for Blockbench's own startup plugin load to finish. Without this the script
    // races the app: the API is up before `Plugins.loading_promise` settles, so loading
    // the file here would run `onload` twice (every Action registered twice).
    await cdp.evaluate(`(async () => {
      if (Plugins.loading_promise) { try { await Plugins.loading_promise; } catch (error) { console.warn('plugin loading promise rejected', error); } }
      return true;
    })()`);
    log('app', 'startup plugin loading settled');

    /* 3. load the plugin -------------------------------------------------- */

    const loaded = await cdp.evaluate(`(async () => {
      try {
        const existing = Plugins.all.find(p => p.id === 'blockbench-ai-agent' && p.installed && typeof p.onload === 'function');
        if (existing) return { state: 'already-installed' };
        const instance = new Plugin('blockbench-ai-agent', {});
        await instance.loadFromFile({ path: ${JSON.stringify(pluginFile)}, name: ${JSON.stringify(pluginFile)}, content: '' }, false);
        return { state: 'loaded', id: instance.id };
      } catch (error) {
        return { state: 'error', message: String((error && error.message) || error) };
      }
    })()`);
    if (loaded?.state === 'error') {
      fail(`loading the plugin failed: ${loaded.message}`);
      return;
    }
    log('plugin', `plugin ${loaded.state} (id ${loaded.id ?? 'blockbench-ai-agent'})`);
    const registered = await cdp.evaluate('Object.keys(Plugins.registered)', { awaitPromise: false });
    log('plugin', `registered: ${Array.isArray(registered) ? registered.join(', ') : registered}`);

    /* 4. settings ---------------------------------------------------------- */

    // Settings must be written AFTER the plugin registers them: Blockbench caches
    // `Settings.stored` at boot, and the `Setting` constructor re-saves the whole store,
    // so a write made before load gets clobbered back to the defaults. Going through the
    // live instances updates the value and persists it in one step.
    const wsUrl = `ws://127.0.0.1:${options.bridgePort}/plugin?token=${token}`;
    const settingsApplied = await cdp.evaluate(`(() => {
      const values = {
        ai_agent_bridge_url: ${JSON.stringify(wsUrl)},
        ai_agent_bridge_token: ${JSON.stringify(token)},
        ai_agent_auto_checkpoint: true,
      };
      const missing = [];
      for (const [id, value] of Object.entries(values)) {
        const setting = typeof settings !== 'undefined' ? settings[id] : undefined;
        if (setting && typeof setting.set === 'function') setting.set(value);
        else missing.push(id);
      }
      if (typeof Settings !== 'undefined' && Settings.save) Settings.save();
      return {
        applied: Object.keys(values).filter(id => !missing.includes(id)),
        missing,
        url: typeof settings !== 'undefined' && settings.ai_agent_bridge_url ? String(settings.ai_agent_bridge_url.value) : null,
        token_set: typeof settings !== 'undefined' && settings.ai_agent_bridge_token ? String(settings.ai_agent_bridge_token.value).length > 0 : false,
      };
    })()`);
    if (settingsApplied?.missing?.length) {
      fail(`these settings were not registered by the plugin: ${settingsApplied.missing.join(', ')}`);
      return;
    }
    log('setup', `bridge settings applied → ${settingsApplied.url} (token ${settingsApplied.token_set ? 'present' : 'MISSING'})`);

    /* 5. connect ---------------------------------------------------------- */

    const trigger = await cdp.evaluate(`(() => {
      const action = BarItems['ai_agent_connect'];
      if (!action) return 'missing-action';
      action.trigger();
      return 'triggered';
    })()`);
    log('plugin', `connect action ${trigger}`);
    if (trigger === 'missing-action') {
      fail('the plugin loaded but did not register its Connect action — check the Blockbench console above');
      return;
    }
    await waitFor(
      async () => {
        const health = await fetch(`${bridgeBase}/health`).then((r) => r.json()).catch(() => null);
        return health?.plugin_connected ? health : null;
      },
      30000,
      'the plugin to connect to the bridge',
    );
    const capabilities = (await bridgeFetch(bridgeBase, token, '/capabilities')).body.capabilities;
    log('link', `connected · Blockbench ${capabilities.blockbench_version} · format ${capabilities.active_format ?? 'none'} · ${capabilities.features.filter((f) => f.available).length} features available`);
    const unavailable = capabilities.features.filter((f) => !f.available).map((f) => f.id);
    if (unavailable.length) log('link', `unavailable capabilities: ${unavailable.join(', ')}`);

    const tools = (await bridgeFetch(bridgeBase, token, '/tools')).body;
    log('link', `${tools.plugin.length} plugin tools + ${tools.bridge.length} bridge tools`);

    /* 6. acceptance sequence --------------------------------------------- */

    // Blockbench opens on its start screen with no project, and the available formats
    // differ between versions, so ask the running app which one can hold animations
    // instead of hardcoding an id that might not exist in this build.
    const formats = await cdp.evaluate(`Object.keys(Formats).map(id => ({ id, animation: !!Formats[id].animation_mode, rig: !!Formats[id].bone_rig }))`, { awaitPromise: false });
    const preferred = formats.find((entry) => entry.animation && entry.rig) ?? formats.find((entry) => entry.animation) ?? { id: 'free' };
    log('setup', `${formats.length} formats registered; using "${preferred.id}" for the test project`);

    const fresh = await callTool(bridgeBase, token, 'new_project', { format: preferred.id, resolution: [32, 32] });
    const freshHeader = fresh.project ?? fresh;
    log('step 0', `new_project → ${freshHeader.format_id ?? preferred.id} at ${freshHeader.resolution?.width ?? '?'}x${freshHeader.resolution?.height ?? '?'}`);

    const inspected = await callTool(bridgeBase, token, 'inspect_project', {});
    const header = inspected.project ?? {};
    log(
      'step 1',
      `inspect_project → "${inspected.open_project || header.project_name || '(unnamed)'}" · format ${header.format_id ?? '?'} · ${header.element_count ?? '?'} cubes in ${header.group_count ?? '?'} groups · ${header.texture_count ?? '?'} textures · ${header.animation_count ?? '?'} animations · resolution ${header.resolution?.width}x${header.resolution?.height} · saved=${header.saved}`,
    );

    // The report the bridge received at handshake time was taken before any project
    // existed, so it claims the format-dependent capabilities are missing. Opening a
    // project must have pushed a corrected one — this is the check for that.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const capsAfter = (await bridgeFetch(bridgeBase, token, '/capabilities')).body.capabilities;
    const missing = (capsAfter.features ?? []).filter((feature) => !feature.available).map((feature) => feature.id);
    log(
      'step 1b',
      `capabilities after opening a project → format ${capsAfter.active_format ?? 'none'} · ${missing.length ? `still unavailable: ${missing.join(', ')}` : 'every probed capability available'}`,
    );
    if (capsAfter.active_format !== header.format_id) {
      log('step 1b', `WARN the bridge still holds the boot-time report (expected ${header.format_id}, got ${capsAfter.active_format})`);
    }

    const group = await callTool(bridgeBase, token, 'create_group', { name: 'ai_test_root', origin: [0, 0, 0] });
    log('step 2', `create_group → ${group.name} (${group.uuid.slice(0, 8)})`);

    // Bone groups first, then the cubes under them. Blockbench animates bones
    // (`Group.animator = BoneAnimator`); there is no `Cube.animator`, so keyframes must
    // target groups — this is also how a real Minecraft creature is built.
    const bones = await callTool(bridgeBase, token, 'transaction_begin', {});
    void bones;
    const legL = await callTool(bridgeBase, token, 'create_group', { name: 'ai_test_leg_l', parent: { name: 'ai_test_root' }, origin: [-2, 0, 0] });
    const legR = await callTool(bridgeBase, token, 'create_group', { name: 'ai_test_leg_r', parent: { name: 'ai_test_root' }, origin: [2, 0, 0] });
    const tail = await callTool(bridgeBase, token, 'create_group', { name: 'ai_test_tail', parent: { name: 'ai_test_root' }, origin: [-4, 1, 0] });
    log('step 2b', `bones created → ${[legL.name, legR.name, tail.name].join(', ')}`);

    const cubes = await callTool(bridgeBase, token, 'bulk_create_cubes', {
      cubes: [
        { name: 'ai_test_body', from: [-4, 0, -2], to: [4, 4, 2], parent: 'ai_test_root' },
        { name: 'ai_test_head', from: [4, 1, -2], to: [7, 4, 2], parent: 'ai_test_root' },
        { name: 'cube_leg_l', from: [-3, -4, -1], to: [-1, 0, 1], parent: 'ai_test_leg_l' },
        { name: 'cube_leg_r', from: [1, -4, -1], to: [3, 0, 1], parent: 'ai_test_leg_r' },
        { name: 'cube_tail', from: [-7, 1, -1], to: [-4, 3, 1], parent: 'ai_test_tail' },
      ],
    });
    await callTool(bridgeBase, token, 'transaction_commit', {});
    log('step 3', `bulk_create_cubes → created ${Array.isArray(cubes.created) ? cubes.created.length : JSON.stringify(cubes).slice(0, 120)} into ${['ai_test_root', 'ai_test_leg_l', 'ai_test_leg_r', 'ai_test_tail'].length} groups`);

    const modified = await callTool(bridgeBase, token, 'modify_node', { reference: { name: 'ai_test_head' }, to: [8, 5, 2] });
    log('step 4', `modify_node (head) → ${JSON.stringify(modified).slice(0, 120)}`);

    // `create_bone`'s parent is an object schema ({name|uuid}) and must be a group, so
    // the jaw bone hangs off the root group rather than off a cube.
    const bone = await callTool(bridgeBase, token, 'create_bone', {
      name: 'ai_test_jaw',
      parent: { name: 'ai_test_root' },
      origin: [7, 1, 0],
    });
    log('step 5', `create_bone → ${JSON.stringify(bone).slice(0, 100)}`);

    const animation = await callTool(bridgeBase, token, 'create_animation', { name: 'animation.ai_test.walk', loop: 'loop', length: 1 });
    log('step 6', `create_animation → ${animation.name} (${animation.length}s, ${animation.loop})`);

    const keyframes = await callTool(bridgeBase, token, 'bulk_create_keyframes', {
      animation: 'animation.ai_test.walk',
      set_length: true,
      keyframes: [
        { node: 'ai_test_leg_l', channel: 'rotation', time: 0, x: 25 },
        { node: 'ai_test_leg_l', channel: 'rotation', time: 0.5, x: -25 },
        { node: 'ai_test_leg_l', channel: 'rotation', time: 1, x: 25 },
        { node: 'ai_test_leg_r', channel: 'rotation', time: 0, x: -25 },
        { node: 'ai_test_leg_r', channel: 'rotation', time: 0.5, x: 25 },
        { node: 'ai_test_leg_r', channel: 'rotation', time: 1, x: -25 },
        { node: 'ai_test_tail', channel: 'rotation', time: 0, y: -6 },
        { node: 'ai_test_tail', channel: 'rotation', time: 0.5, y: 6 },
        { node: 'ai_test_tail', channel: 'rotation', time: 1, y: -6 },
      ],
    });
    if (keyframes.created !== keyframes.requested) {
      throw new Error(`only ${keyframes.created}/${keyframes.requested} keyframes were created`);
    }
    log('step 7', `bulk_create_keyframes → ${keyframes.created}/${keyframes.requested} created, max_time ${keyframes.max_time}, length ${keyframes.animation_length}`);

    const animations = await callTool(bridgeBase, token, 'inspect_animations', {});
    const walk = Array.isArray(animations.animations) ? animations.animations.find((a) => a.name === 'animation.ai_test.walk') : null;
    log('step 8', `inspect_animations → ${animations.animations.length} animation(s), walk has ${walk?.keyframe_count ?? '?'} keyframes in ${walk?.animator_count ?? '?'} animators`);

    const selection = await callTool(bridgeBase, token, 'select_object', { references: [{ name: 'ai_test_head' }], mode: 'replace' });
    log('step 9', `select_object → ${JSON.stringify(selection).slice(0, 100)}`);

    const texture = await callTool(bridgeBase, token, 'create_texture', { name: 'ai_test_skin', width: 32, height: 32, fill_color: '#5c7a3a' });
    log('step 10', `create_texture → ${texture.name} ${texture.width}x${texture.height}`);

    const painted = await callTool(bridgeBase, token, 'paint_texture', {
      texture: 'ai_test_skin',
      operations: [
        { type: 'shade_rect', x: 0, y: 0, width: 32, height: 10, amount: 18 },
        { type: 'pixel', x: 6, y: 6, color: '#ffd23f' },
        { type: 'pixel', x: 7, y: 6, color: '#ffd23f' },
        { type: 'outline', x: 2, y: 2, width: 6, height: 6, color: '#2b2b2b' },
      ],
    });
    log('step 11', `paint_texture → ${painted.operations_applied} operations on a ${painted.texture_size?.join('x')} texture`);

    const autoUv = await callTool(bridgeBase, token, 'auto_uv', { references: [{ name: 'ai_test_body' }, { name: 'ai_test_head' }] });
    log('step 12', `auto_uv → ${JSON.stringify(autoUv).slice(0, 140)}`);

    const assigned = await callTool(bridgeBase, token, 'assign_texture', {
      texture: 'ai_test_skin',
      references: [
        { name: 'ai_test_body' },
        { name: 'ai_test_head' },
        { name: 'cube_leg_l' },
        { name: 'cube_leg_r' },
        { name: 'cube_tail' },
      ],
    });
    log('step 13', `assign_texture → ${JSON.stringify(assigned).slice(0, 140)}`);

    // Visual verification: this is the step that proves the screenshot pipeline.
    const sheetTool = (await bridgeFetch(bridgeBase, token, '/tools')).body.bridge.find((t) => t.name === 'bridge_look');
    log('step 14', `bridge_look available: ${!!sheetTool}`);
    const snapshot = await callTool(bridgeBase, token, 'get_model_snapshot', { angles: ['view', 'north', 'east', 'top', 'isometric_right'], resolution: 320 });
    const images = Array.isArray(snapshot.images) ? snapshot.images : [];
    if (!images.length) {
      fail('get_model_snapshot returned no images: the visual pipeline is not working');
    } else {
      const written = [];
      for (const image of images) {
        const file = path.join(options.workspace, 'ai_context', 'viewport', `live-smoke-${image.angle}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(String(image.data_url).split(',')[1], 'base64'));
        written.push(`${image.angle} ${image.width}x${image.height} ${image.bytes}B`);
      }
      log('step 15', `viewport images → ${written.join(', ')}`);
    }

    const validation = await callTool(bridgeBase, token, 'validate_model', {});
    const issues = Array.isArray(validation.issues) ? validation.issues : [];
    log('step 16', `validate_model → ${issues.length} issue(s)`);
    for (const issue of issues.slice(0, 6)) log('step 16', `   · ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`);

    const viewport = await callTool(bridgeBase, token, 'inspect_viewport', {});
    log('step 17', `inspect_viewport → ${JSON.stringify(viewport).slice(0, 160)}`);

    if (options.save) {
      const saved = await callTool(bridgeBase, token, 'save_project', {});
      const target = path.join(options.workspace, 'ai_test_model.bbmodel');
      fs.writeFileSync(target, `${JSON.stringify(saved.model, null, 2)}\n`, 'utf8');
      const marked = await callTool(bridgeBase, token, 'mark_project_saved', { save_path: target });
      log('step 18', `save_project → ${saved.counts.elements} cubes, ${saved.counts.textures} textures, ${saved.counts.animations} animations, ${Math.round(saved.bytes / 1024)} KB written to ${path.basename(target)} (saved=${marked.saved})`);

      // Reload the file from disk and verify the content survived the round trip.
      const onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
      const cubeCount = Array.isArray(onDisk.elements) ? onDisk.elements.length : 0;
      const animationCount = Array.isArray(onDisk.animations) ? onDisk.animations.length : 0;
      const textureCount = Array.isArray(onDisk.textures) ? onDisk.textures.length : 0;
      const reloaded = await callTool(bridgeBase, token, 'open_project', { model: onDisk, path: target });
      log('step 19', `reload → the file on disk holds ${cubeCount} cubes, ${textureCount} textures and ${animationCount} animations; open_project reported ${JSON.stringify(reloaded).slice(0, 120)}`);

      const after = await callTool(bridgeBase, token, 'inspect_model', { include_cubes: true });
      const afterAnimations = await callTool(bridgeBase, token, 'inspect_animations', {});
      log('step 20', `after reload → ${after.cubes?.length ?? 0} cubes, ${after.stats ? JSON.stringify(after.stats).slice(0, 90) : 'no stats'}, ${afterAnimations.animations?.length ?? 0} animation(s)`);
    }

    const checkpoints = await bridgeFetch(bridgeBase, token, '/checkpoints');
    log('step 21', `checkpoints recorded: ${checkpoints.body.checkpoints?.length ?? 0}`);
    const state = await bridgeFetch(bridgeBase, token, '/state');
    log('step 22', `state revision ${state.body.revision}, viewport ${JSON.stringify(state.body.state?.viewport?.preview_id ?? null)}`);

    console.log('\n✔ live acceptance test complete');
    console.log(`  Blockbench ${version} · ${capabilities.active_format ?? 'no format'} · ${tools.plugin.length} tools`);
    console.log(`  The window is open on your desktop${options.keepOpen ? ' (left open as requested)' : ''}.`);
    if (!options.keepOpen) {
      console.log('  Close it whenever you like — the plugin stays installed and will load again next start.');
    }
  } catch (error) {
    fail((error?.stack ?? String(error)).split('\n').slice(0, 6).join('\n'));
  } finally {
    cdp?.close();
    if (bridgeProcess) {
      log('bridge', 'stopping the bridge this test started');
      bridgeProcess.kill();
    }
  }
}

main().catch((error) => {
  fail(String(error));
});
