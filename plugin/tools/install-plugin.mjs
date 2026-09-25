#!/usr/bin/env node
/**
 * Copy the built plugin into Blockbench's plugins folder.
 *
 * Why this is not truly zero-click: Blockbench loads plugins from
 * `StateMemory.installed_plugins` (localStorage, inside its LevelDB store), not by
 * scanning the plugins folder — verified in `js/plugin_loader.ts` of the installed
 * build. Editing that store behind the app's back would be reckless, so this script
 * puts the file where Blockbench expects it and tells you the one click that makes the
 * install permanent ("Load Plugin from File" stores the absolute path and re-loads it
 * on every start).
 *
 * Usage:
 *   node tools/install-plugin.mjs [--dir <plugins folder>] [--bundle <file>] [--force]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUNDLE_NAME = 'blockbench-ai-agent.js';

function parseArgs(argv) {
  const out = { dir: null, bundle: null, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') out.dir = argv[++i] ?? null;
    else if (arg === '--bundle') out.bundle = argv[++i] ?? null;
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
  }
  return out;
}

export function defaultPluginDir() {
  if (process.env.BLOCKBENCH_PLUGIN_DIR) return process.env.BLOCKBENCH_PLUGIN_DIR;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Blockbench', 'plugins');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Blockbench', 'plugins');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'Blockbench', 'plugins');
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = args.bundle ?? path.join(ROOT, 'dist', BUNDLE_NAME);
  const dir = args.dir ?? defaultPluginDir();

  if (!fs.existsSync(bundle)) {
    console.error(`✖ no built plugin at ${bundle}\n  run "npm run build" first`);
    process.exitCode = 1;
    return;
  }
  const sourceHash = sha256(bundle);
  const bytes = fs.statSync(bundle).size;
  const target = path.join(dir, BUNDLE_NAME);

  let current = false;
  try {
    current = fs.existsSync(target) && sha256(target) === sourceHash;
  } catch {
    current = false;
  }

  if (!current || args.force) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${target}.tmp-${Date.now()}`;
    fs.copyFileSync(bundle, temp);
    fs.renameSync(temp, target);
  }

  const result = {
    installed: true,
    alreadyCurrent: current && !args.force,
    target,
    bundle,
    bytes,
    sha256: sourceHash,
    pluginDir: dir,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✔ plugin ${result.alreadyCurrent ? 'already current' : 'installed'} (${Math.round(bytes / 1024)} KB, sha256 ${sourceHash.slice(0, 12)}…)`);
  console.log(`  ${target}`);
  if (!result.alreadyCurrent) {
    console.log('');
    console.log('  One-time activation:');
    console.log('    1. Open Blockbench');
    console.log('    2. File → Plugins… → "Load Plugin from File"');
    console.log(`    3. Select ${target}`);
    console.log('  Blockbench remembers the path and re-loads the plugin on every start.');
  }
  console.log('');
  console.log('  Then run the bridge:  npm run bridge');
}

main();
