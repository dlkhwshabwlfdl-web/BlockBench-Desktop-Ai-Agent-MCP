/**
 * Bridge configuration.
 *
 * Precedence: CLI flags > environment > `ai_context/bridge.json` > defaults.
 *
 * Secrets (the LLM API key, the plugin session token) are only ever read into
 * memory and are never echoed: `describeForLog()` is the only place that renders
 * config, and it redacts them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from '../shared/protocol.js';
import { redact } from './log.js';

export type ProviderKind = 'openai-compatible' | 'ollama' | 'none';

export interface BridgeConfig {
  /** Workspace root: where `references/`, `ai_context/` and the `.bbmodel` live. */
  workspace: string;
  host: string;
  port: number;
  /** Session token the plugin must present. Generated when absent. */
  token: string;
  /** When true the bridge accepts unauthenticated connections (loopback only). */
  allowAnonymous: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFile: string | null;

  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Extra headers sent with every LLM request. */
  extraHeaders: Record<string, string>;
  maxTokens: number;
  temperature: number;
  /** Maximum tool-calling round trips per task. */
  maxSteps: number;
  /** Request timeout for a single LLM call, in milliseconds. */
  requestTimeoutMs: number;
  /** Whether to attach viewport screenshots to the model's context. */
  enableVision: boolean;
  /** Serve REST on the same port as the WebSocket. */
  enableHttp: boolean;
  /** Run an MCP server on stdio. */
  enableMcp: boolean;
  /** Absolute path of the installed Blockbench plugins folder (for --install-plugin). */
  blockbenchPluginDir: string | null;
}

export interface CliFlags {
  serve: boolean;
  mcp: boolean;
  doctor: boolean;
  installPlugin: boolean;
  task: string | null;
  tool: string | null;
  toolArgs: string | null;
  help: boolean;
  workspace: string | null;
  port: number | null;
  host: string | null;
  model: string | null;
  baseUrl: string | null;
  provider: string | null;
  token: string | null;
  logLevel: string | null;
  noAuth: boolean;
  noVision: boolean;
  maxSteps: number | null;
}

export const HELP_TEXT = `blockbench-ai-agent bridge

Usage:
  node dist/agent-bridge.js [command] [options]

Commands:
  --serve                 Run the WebSocket + REST bridge (default)
  --mcp                   Run an MCP server on stdio instead
  --task "<prompt>"       Run one autonomous agent task, then exit
  --tool <name>           Invoke a single tool directly, then exit
  --args '<json>'         Arguments for --tool
  --doctor                Check the environment and print a report
  --install-plugin        Copy the built plugin into Blockbench's plugins folder
  --help                  Show this help

Options:
  --workspace <dir>       Project folder holding the .bbmodel (default: cwd)
  --host <host>           Bridge bind address (default: ${DEFAULT_BRIDGE_HOST})
  --port <port>           Bridge port (default: ${DEFAULT_BRIDGE_PORT})
  --token <token>         Session token the plugin must present
  --no-auth               Accept unauthenticated loopback connections
  --model <name>          LLM model name
  --base-url <url>        OpenAI compatible endpoint base URL
  --provider <kind>       openai-compatible | ollama | none
  --no-vision             Do not send viewport screenshots to the model
  --max-steps <n>         Maximum tool round trips per task
  --log-level <level>     debug | info | warn | error

Environment:
  AI_AGENT_WORKSPACE, AI_AGENT_PORT, AI_AGENT_HOST, AI_AGENT_TOKEN, AI_AGENT_PROVIDER
  AI_AGENT_BASE_URL, AI_AGENT_MODEL, AI_AGENT_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
  AI_AGENT_LOG_LEVEL, BLOCKBENCH_DIR
`;

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    serve: false,
    mcp: false,
    doctor: false,
    installPlugin: false,
    task: null,
    tool: null,
    toolArgs: null,
    help: false,
    workspace: null,
    port: null,
    host: null,
    model: null,
    baseUrl: null,
    provider: null,
    token: null,
    logLevel: null,
    noAuth: false,
    noVision: false,
    maxSteps: null,
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift()!;
    const take = (): string | null => {
      const next = args.shift();
      return next === undefined ? null : next;
    };
    switch (arg) {
      case '--serve':
        flags.serve = true;
        break;
      case '--mcp':
        flags.mcp = true;
        break;
      case '--doctor':
        flags.doctor = true;
        break;
      case '--install-plugin':
      case '--install':
        flags.installPlugin = true;
        break;
      case '--task':
        flags.task = take();
        break;
      case '--tool':
        flags.tool = take();
        break;
      case '--args':
      case '--tool-args':
        flags.toolArgs = take();
        break;
      case '--workspace':
        flags.workspace = take();
        break;
      case '--port':
        flags.port = Number(take());
        break;
      case '--host':
        flags.host = take();
        break;
      case '--model':
        flags.model = take();
        break;
      case '--base-url':
        flags.baseUrl = take();
        break;
      case '--provider':
        flags.provider = take();
        break;
      case '--token':
        flags.token = take();
        break;
      case '--log-level':
        flags.logLevel = take();
        break;
      case '--no-auth':
        flags.noAuth = true;
        break;
      case '--no-vision':
        flags.noVision = true;
        break;
      case '--max-steps':
        flags.maxSteps = Number(take());
        break;
      case '--help':
      case '-h':
      case 'help':
        flags.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag "${arg}". Run with --help for usage.`);
        }
    }
  }
  return flags;
}

function envValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

interface FileConfig {
  workspace?: string;
  host?: string;
  port?: number;
  token?: string;
  provider?: ProviderKind;
  base_url?: string;
  model?: string;
  extra_headers?: Record<string, string>;
  max_tokens?: number;
  temperature?: number;
  max_steps?: number;
  enable_vision?: boolean;
}

function readFileConfig(workspace: string): FileConfig {
  const candidates = [
    path.join(workspace, 'ai_context', 'bridge.json'),
    path.join(workspace, 'bridge.json'),
    path.join(os.homedir(), '.blockbench-ai-agent.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as FileConfig;
      }
    } catch {
      /* ignore malformed config */
    }
  }
  return {};
}

function defaultPluginDir(): string | null {
  if (process.env.BLOCKBENCH_PLUGIN_DIR) return process.env.BLOCKBENCH_PLUGIN_DIR;
  if (process.env.BLOCKBENCH_DIR) {
    return null; // caller falls back to locating the asar
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'Blockbench', 'plugins');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Blockbench', 'plugins');
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    return path.join(xdg, 'Blockbench', 'plugins');
  }
  return null;
}

export function resolveConfig(argv: string[] = process.argv.slice(2)): { config: BridgeConfig; flags: CliFlags } {
  const flags = parseArgs(argv);
  const workspace = path.resolve(flags.workspace ?? envValue('AI_AGENT_WORKSPACE') ?? process.cwd());
  const file = readFileConfig(workspace);

  const provider = (flags.provider ?? envValue('AI_AGENT_PROVIDER') ?? file.provider ?? 'openai-compatible') as ProviderKind;
  const isOllama = provider === 'ollama';
  const baseUrl =
    flags.baseUrl ??
    envValue('AI_AGENT_BASE_URL', 'OPENAI_BASE_URL') ??
    file.base_url ??
    (isOllama ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1');
  const model = flags.model ?? envValue('AI_AGENT_MODEL', 'OPENAI_MODEL') ?? file.model ?? (isOllama ? 'llama3.1' : 'gpt-4o-mini');

  const explicitToken = flags.token ?? envValue('AI_AGENT_TOKEN') ?? file.token ?? null;
  // Anonymous by default: the bridge only listens on loopback, `Origin` is checked on
  // every HTTP request and on the plugin upgrade, and a generated token nobody could see
  // produced a bridge the plugin could never authenticate against — the panel sat on
  // "rejected/disconnected" forever. Pass `--token` to require one.
  const allowAnonymous = flags.noAuth || explicitToken === null;
  const token = explicitToken ?? (allowAnonymous ? '' : crypto.randomBytes(24).toString('base64url'));

  const config: BridgeConfig = {
    workspace,
    host: flags.host ?? envValue('AI_AGENT_HOST') ?? file.host ?? DEFAULT_BRIDGE_HOST,
    port: flags.port ?? Number(envValue('AI_AGENT_PORT') ?? file.port ?? DEFAULT_BRIDGE_PORT),
    token,
    allowAnonymous,
    logLevel: (flags.logLevel ?? envValue('AI_AGENT_LOG_LEVEL') ?? 'info') as BridgeConfig['logLevel'],
    logFile: path.join(workspace, 'ai_context', 'bridge.log'),

    provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: envValue('AI_AGENT_API_KEY', 'OPENAI_API_KEY') ?? '',
    extraHeaders: file.extra_headers ?? {},
    maxTokens: Number(envValue('AI_AGENT_MAX_TOKENS') ?? file.max_tokens ?? 8192),
    temperature: Number(envValue('AI_AGENT_TEMPERATURE') ?? file.temperature ?? 0.4),
    maxSteps: flags.maxSteps ?? Number(envValue('AI_AGENT_MAX_STEPS') ?? file.max_steps ?? 60),
    requestTimeoutMs: Number(envValue('AI_AGENT_TIMEOUT_MS') ?? 180000),
    enableVision: !flags.noVision && file.enable_vision !== false,
    enableHttp: true,
    enableMcp: flags.mcp,
    blockbenchPluginDir: defaultPluginDir(),
  };
  return { config, flags };
}

/** The only sanctioned way to render config, and it masks secrets. */
export function describeForLog(config: BridgeConfig): Record<string, unknown> {
  const token = config.token ?? '';
  const auth = config.allowAnonymous
    ? 'anonymous (loopback only)'
    : token.length > 4
      ? `token ${token.slice(0, 4)}*** (${token.length} chars)`
      : 'token (not set — the plugin cannot authenticate until one is configured)';
  return {
    workspace: config.workspace,
    endpoint: `${config.host}:${config.port}`,
    auth,
    provider: config.provider,
    model: config.model,
    base_url: config.baseUrl,
    // Named so that it cannot be mistaken for a value: the key itself is masked by
    // `redact`, and the field name must not look like a secret of its own.
    api_key_state: config.apiKey ? redact(`api_key=${config.apiKey}`) : 'not configured',
    vision: config.enableVision,
    max_steps: config.maxSteps,
    plugin_dir: config.blockbenchPluginDir,
  };
}

export interface WorkspacePaths {
  root: string;
  references: string;
  context: string;
  checkpoints: string;
  viewport: string;
  textures: string;
}

export function workspacePaths(config: BridgeConfig): WorkspacePaths {
  const root = config.workspace;
  return {
    root,
    references: path.join(root, 'references'),
    context: path.join(root, 'ai_context'),
    checkpoints: path.join(root, 'ai_context', 'checkpoints'),
    viewport: path.join(root, 'ai_context', 'viewport'),
    textures: path.join(root, 'ai_context', 'textures'),
  };
}

export function ensureWorkspace(config: BridgeConfig): WorkspacePaths {
  const paths = workspacePaths(config);
  for (const dir of [paths.references, paths.context, paths.checkpoints, paths.viewport, paths.textures]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Finds the `.bbmodel` in the workspace, so the bridge knows what it is driving. */
export function findProjectFile(workspace: string): string | null {
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true });
    const models = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.bbmodel'));
    if (!models.length) return null;
    if (models.length === 1) return path.join(workspace, models[0].name);
    // Prefer the most recently modified one.
    const withTime = models.map((entry) => {
      const full = path.join(workspace, entry.name);
      return { full, time: fs.statSync(full).mtimeMs };
    });
    withTime.sort((a, b) => b.time - a.time);
    return withTime[0].full;
  } catch {
    return null;
  }
}
