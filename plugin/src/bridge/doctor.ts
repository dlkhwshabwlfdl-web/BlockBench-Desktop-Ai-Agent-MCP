/**
 * `--doctor`: a pre-flight report.
 *
 * Every check answers a question the user will otherwise discover the hard way, and
 * every check is honest about failure — a missed capability is reported as "not found",
 * never as "probably fine". The Blockbench version is read out of the installed
 * `app.asar` so the report works before Blockbench is even running.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BridgeConfig, WorkspacePaths } from './config.js';
import { findProjectFile } from './config.js';
import type { Logger } from './log.js';
import { findBundle, hashFile, installPlugin } from './installer.js';
import type { PluginSession } from './session.js';
import type { MemoryStore } from './memory.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; verdict: string };
  workspace: WorkspacePaths;
}

/* ------------------------------------------------------------- asar reading */

/**
 * Minimal reader for Electron's asar container.
 *
 * Format (from @electron/asar): an 8 byte pickle holding the size of the header, then a
 * pickle holding the JSON directory, then file data at `8 + headerSize + offset`.
 */
export function readAsarFile(asarPath: string, innerPath: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null;
    const headerSize = sizeBuf.readUInt32LE(4);
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) return null;
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null;
    // The header is a pickle whose payload is the JSON directory string; rather than
    // trusting its length prefixes (they differ subtly between asar versions) slice
    // between the outermost braces and parse that.
    const text = headerBuf.toString('utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const header = JSON.parse(text.slice(start, end + 1)) as { files?: Record<string, AsarEntry> };
    // The directory is a plain map at the root, wrapped so the walk below is uniform.
    let entry: AsarEntry | undefined = { files: header.files };
    for (const part of innerPath.split('/')) {
      entry = entry?.files?.[part];
      if (!entry) return null;
    }
    if (entry.size === undefined || entry.offset === undefined) return null;
    const offset = 8 + headerSize + Number(entry.offset);
    const out = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, out, 0, out.length, offset);
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

interface AsarEntry {
  size?: number;
  offset?: string | number;
  files?: Record<string, AsarEntry>;
}

export interface BlockbenchInstall {
  appDir: string;
  asar: string;
  /** Version reported by the installed app.asar, when readable. */
  version: string | null;
  derivedFrom: string;
}

/** Looks in the usual places for a Blockbench install without touching anything. */
export function findBlockbenchInstall(): BlockbenchInstall | null {
  const candidates: string[] = [];
  if (process.env.BLOCKBENCH_DIR) {
    candidates.push(process.env.BLOCKBENCH_DIR);
    candidates.push(path.join(process.env.BLOCKBENCH_DIR, 'resources', 'app.asar'));
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'Blockbench'));
    candidates.push(path.join(local, 'Blockbench'));
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(path.join(programFiles, 'Blockbench'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blockbench.app/Contents/Resources');
    candidates.push(path.join(os.homedir(), 'Applications', 'Blockbench.app', 'Contents', 'Resources'));
  } else {
    candidates.push('/opt/Blockbench', '/usr/lib/blockbench', path.join(os.homedir(), 'Blockbench'));
  }

  for (const candidate of candidates) {
    const asarPaths = [
      path.join(candidate, 'resources', 'app.asar'),
      path.join(candidate, 'app.asar'),
      candidate.endsWith('app.asar') ? candidate : '',
    ].filter((entry) => entry.length > 0);
    for (const asar of asarPaths) {
      if (!fs.existsSync(asar)) continue;
      const raw = readAsarFile(asar, 'package.json');
      let version: string | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as { version?: string; name?: string };
          version = parsed.version ?? null;
        } catch {
          version = null;
        }
      }
      // <app>/resources/app.asar → the app folder is two levels up.
      const appDir = path.basename(path.dirname(asar)) === 'resources' ? path.dirname(path.dirname(asar)) : path.dirname(asar);
      return { appDir, asar, version, derivedFrom: candidate };
    }
  }
  return null;
}

/* --------------------------------------------------------------------- checks */

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) return { name: 'node runtime', status: 'ok', detail: `Node ${process.versions.node} on ${os.platform()}` };
  if (major >= 18) return { name: 'node runtime', status: 'warn', detail: `Node ${process.versions.node}`, hint: 'Node 20 or newer is recommended (global fetch and modern ws).' };
  return { name: 'node runtime', status: 'fail', detail: `Node ${process.versions.node}`, hint: 'Install Node 20 or newer.' };
}

function checkDependencies(logger: Logger): Check {
  const require = createRequire(import.meta.url);
  const missing: string[] = [];
  for (const dependency of ['ws', 'pngjs']) {
    try {
      require.resolve(dependency);
    } catch {
      missing.push(dependency);
    }
  }
  void logger;
  if (!missing.length) return { name: 'dependencies', status: 'ok', detail: 'ws and pngjs resolve' };
  return {
    name: 'dependencies',
    status: 'fail',
    detail: `missing: ${missing.join(', ')}`,
    hint: 'Run "npm install" in the plugin folder before building the bridge.',
  };
}

function checkBundle(): Check {
  const bundle = findBundle();
  if (!bundle) {
    return {
      name: 'plugin bundle',
      status: 'fail',
      detail: 'dist/blockbench-ai-agent.js not found',
      hint: 'Run "npm run build".',
    };
  }
  const bytes = fs.statSync(bundle).size;
  return { name: 'plugin bundle', status: 'ok', detail: `${bundle} (${Math.round(bytes / 1024)} KB, ${hashFile(bundle).slice(0, 12)}…)` };
}

function checkBlockbench(): { check: Check; install: BlockbenchInstall | null } {
  const install = findBlockbenchInstall();
  if (!install) {
    return {
      check: {
        name: 'blockbench install',
        status: 'warn',
        detail: 'not found in the standard locations',
        hint: 'Set BLOCKBENCH_DIR to the program folder if the app lives somewhere unusual. The bridge works regardless of where the app is installed.',
      },
      install: null,
    };
  }
  return {
    check: {
      name: 'blockbench install',
      status: 'ok',
      detail: `version ${install.version ?? 'unknown'} · ${install.asar}`,
    },
    install,
  };
}

function checkPluginFolder(config: BridgeConfig, logger: Logger, forceReinstall: boolean): Check {
  const result = installPlugin(config, logger, { force: forceReinstall });
  if (!result.installed && result.reason) {
    return {
      name: 'plugin folder',
      status: 'fail',
      detail: `${result.pluginDir} — ${result.reason}`,
      hint: 'Run "npm run build" and then "npm run install-plugin".',
    };
  }
  if (result.alreadyPresent) {
    return { name: 'plugin folder', status: 'ok', detail: `${result.target} is current (sha256 ${result.sha256.slice(0, 12)}…)` };
  }
  return {
    name: 'plugin folder',
    status: 'ok',
    detail: `copied ${Math.round(result.bytes / 1024)} KB to ${result.target}`,
    hint: 'Load it once in Blockbench via File → Plugins… → "Load Plugin from File"; it is permanent after that.',
  };
}

function checkPort(config: BridgeConfig): Promise<Check> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve({
          name: 'bridge port',
          status: 'warn',
          detail: `${config.host}:${config.port} is already in use`,
          hint: 'Another bridge is probably running. Stop it or pass --port.',
        });
      } else {
        resolve({ name: 'bridge port', status: 'warn', detail: `${config.host}:${config.port} — ${error.message}` });
      }
    });
    server.once('listening', () => {
      server.close(() => resolve({ name: 'bridge port', status: 'ok', detail: `${config.host}:${config.port} is free` }));
    });
    server.listen(config.port, config.host);
  });
}

async function checkModel(config: BridgeConfig): Promise<Check> {
  if (config.provider === 'none') {
    return { name: 'model endpoint', status: 'warn', detail: 'provider is "none"', hint: 'Set --provider, --base-url and --model (or the AI_AGENT_* / OPENAI_* variables) before asking the agent to build anything.' };
  }
  if (!config.apiKey && /api\.openai\.com/.test(config.baseUrl)) {
    return {
      name: 'model endpoint',
      status: 'fail',
      detail: 'OPENAI_API_KEY is not set',
      hint: 'Export OPENAI_API_KEY, or point --base-url at a local server (Ollama, LM Studio, vLLM).',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: controller.signal,
    });
    if (response.ok) {
      return { name: 'model endpoint', status: 'ok', detail: `${config.baseUrl} reachable · model ${config.model}` };
    }
    return {
      name: 'model endpoint',
      status: 'warn',
      detail: `${config.baseUrl} answered HTTP ${response.status}`,
      hint: 'The endpoint answered but rejected the request — check the API key and that it is OpenAI compatible (/chat/completions).',
    };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    return {
      name: 'model endpoint',
      status: 'warn',
      detail: `${config.baseUrl} — ${message}`,
      hint: 'The bridge still runs and still exposes tools; only autonomous tasks need the model.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkWorkspace(config: BridgeConfig, paths: WorkspacePaths, memory: MemoryStore): Check {
  const project = findProjectFile(config.workspace);
  const references = memory.listReferences();
  const parts = [`${references.length} reference image(s)`, project ? `project file ${path.basename(project)}` : 'no .bbmodel in the workspace yet'];
  return {
    name: 'workspace',
    status: config.workspace && fs.existsSync(paths.context) ? 'ok' : 'warn',
    detail: `${config.workspace} · ${parts.join(' · ')}`,
    hint: references.length ? undefined : `Drop reference images into ${paths.references} to give the agent visual guidance.`,
  };
}

function checkSession(session: PluginSession): Check {
  if (session.connected && session.capabilities) {
    const capabilities = session.capabilities;
    return {
      name: 'plugin link',
      status: 'ok',
      detail: `connected · Blockbench ${capabilities.blockbench_version} · format ${capabilities.active_format ?? 'none'} · ${session.cachedTools().length} tools`,
    };
  }
  return {
    name: 'plugin link',
    status: 'warn',
    detail: 'no plugin connected right now',
    hint: 'Start the bridge with --serve, open Blockbench, press Connect in the AI Agent panel.',
  };
}

export async function runDoctor(deps: {
  config: BridgeConfig;
  paths: WorkspacePaths;
  logger: Logger;
  session?: PluginSession;
  memory?: MemoryStore;
  forceReinstall?: boolean;
}): Promise<DoctorReport> {
  const { config, paths, logger } = deps;
  const install = checkBlockbench();
  const checks: Check[] = [
    checkNode(),
    checkDependencies(logger),
    checkBundle(),
    install.check,
    checkPluginFolder(config, logger, deps.forceReinstall ?? false),
    await checkPort(config),
    await checkModel(config),
  ];
  if (deps.memory) checks.push(checkWorkspace(config, paths, deps.memory));
  if (deps.session) checks.push(checkSession(deps.session));

  const ok = checks.filter((entry) => entry.status === 'ok').length;
  const warn = checks.filter((entry) => entry.status === 'warn').length;
  const fail = checks.filter((entry) => entry.status === 'fail').length;
  const verdict =
    fail > 0
      ? 'not ready — fix the failing checks below'
      : warn > 0
        ? 'usable, with caveats'
        : 'ready';
  return { checks, summary: { ok, warn, fail, verdict }, workspace: paths };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: '✔', warn: '!', fail: '✖' } as const;
  const lines = ['Blockbench AI Agent — doctor', ''];
  for (const check of report.checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.hint) lines.push(`    → ${check.hint}`);
  }
  lines.push('', `${report.summary.ok} ok · ${report.summary.warn} warnings · ${report.summary.fail} failures — ${report.summary.verdict}`);
  return lines.join('\n');
}
