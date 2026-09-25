/**
 * Plugin installation.
 *
 * Read out of the installed build before writing this (`js/plugin_loader.ts`):
 *
 *   Plugins.path = app.getPath('userData') + '/plugins/'      // line 1115
 *   for (let installation of Plugins.installed) {              // line ~1230
 *     if (installation.source == 'file' && fs.existsSync(installation.path)) loadFromFile(...)
 *   }
 *   StateMemory.init('installed_plugins', 'array')             // localStorage
 *
 * Two consequences that decide what this module can honestly do:
 *
 *   1. Blockbench does NOT scan the plugins folder for `.js` files. Only entries in
 *      `installed_plugins` are loaded, and that list lives in the renderer's
 *      localStorage (a LevelDB store), not in a JSON file we could safely edit.
 *   2. A `source: 'file'` entry stores an absolute path and is re-loaded on every start.
 *
 * So the install is: copy the bundle into the plugins folder, then have the user press
 * "Load Plugin from File" once. After that single click the plugin is permanent. We do
 * not pretend to be able to skip it, and we do not touch Blockbench's internal state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BridgeConfig } from './config.js';
import type { Logger } from './log.js';

export const PLUGIN_BUNDLE_NAME = 'blockbench-ai-agent.js';

export interface InstallResult {
  installed: boolean;
  pluginDir: string;
  target: string | null;
  source: string;
  bytes: number;
  sha256: string;
  alreadyPresent: boolean;
  pluginDirExisted: boolean;
  instructions: string[];
  reason?: string;
}

export function defaultPluginDir(): string {
  if (process.env.BLOCKBENCH_PLUGIN_DIR) return process.env.BLOCKBENCH_PLUGIN_DIR;
  if (process.env.BLOCKBENCH_DIR) {
    // Accept either the app folder or the user data folder.
    const base = process.env.BLOCKBENCH_DIR;
    return /Blockbench$/.test(base) && path.basename(path.dirname(base)) === 'Blockbench'
      ? path.join(base, 'plugins')
      : path.join(base, 'plugins');
  }
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

/** Locates the built plugin bundle without assuming how the bridge was launched. */
export function findBundle(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.BLOCKBENCH_AI_PLUGIN_BUNDLE,
    path.join(process.cwd(), 'dist', PLUGIN_BUNDLE_NAME),
    path.join(process.cwd(), 'blockbench-ai-agent.js'),
    path.join(path.dirname(process.execPath), 'dist', PLUGIN_BUNDLE_NAME),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function installPlugin(config: BridgeConfig, logger: Logger, options: { bundle?: string; dir?: string; force?: boolean } = {}): InstallResult {
  const pluginDir = options.dir ?? config.blockbenchPluginDir ?? defaultPluginDir();
  const source = findBundle(options.bundle);
  const instructions = [
    `1. Open Blockbench.`,
    `2. File → Plugins… → "Load Plugin from File" and pick:`,
    `     ${path.join(pluginDir, PLUGIN_BUNDLE_NAME)}`,
    `3. The plugin registers as "AI Agent" and stays installed permanently — Blockbench`,
    `   remembers the file path and re-loads it on every start.`,
    `4. Start the bridge:   npm run bridge      (or: node dist/agent-bridge.js --serve)`,
    `5. In the AI Agent panel, click Connect. If the bridge printed a token, paste the full`,
    `   ws:// URL including ?token=… into the Bridge URL field.`,
  ];

  if (!source) {
    return {
      installed: false,
      pluginDir,
      target: null,
      source: '',
      bytes: 0,
      sha256: '',
      alreadyPresent: false,
      pluginDirExisted: fs.existsSync(pluginDir),
      instructions,
      reason: `the plugin bundle was not found. Run "npm run build" first (expected dist/${PLUGIN_BUNDLE_NAME}).`,
    };
  }

  const target = path.join(pluginDir, PLUGIN_BUNDLE_NAME);
  const sha256 = hashFile(source);
  const bytes = fs.statSync(source).size;

  let alreadyPresent = false;
  try {
    alreadyPresent = fs.existsSync(target) && hashFile(target) === sha256;
  } catch {
    alreadyPresent = false;
  }

  if (alreadyPresent && !options.force) {
    logger.info(`plugin already up to date at ${target}`);
    return {
      installed: true,
      pluginDir,
      target,
      source,
      bytes,
      sha256,
      alreadyPresent: true,
      pluginDirExisted: true,
      instructions,
    };
  }

  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    // Copy to a temporary name first so a failure cannot leave a half written plugin
    // that Blockbench would try to load.
    const temp = `${target}.tmp-${Date.now()}`;
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, target);
  } catch (error) {
    return {
      installed: false,
      pluginDir,
      target,
      source,
      bytes,
      sha256,
      alreadyPresent: false,
      pluginDirExisted: fs.existsSync(pluginDir),
      instructions,
      reason: `could not write to ${pluginDir}: ${(error as Error).message}`,
    };
  }

  logger.info(`plugin installed: ${target} (${Math.round(bytes / 1024)} KB, sha256 ${sha256.slice(0, 12)}…)`);
  return {
    installed: true,
    pluginDir,
    target,
    source,
    bytes,
    sha256,
    alreadyPresent: false,
    pluginDirExisted: true,
    instructions,
  };
}
