#!/usr/bin/env node

// src/bridge/index.ts
import path7 from "node:path";
import process2 from "node:process";

// src/bridge/config.ts
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import crypto from "node:crypto";

// src/shared/protocol.ts
var PROTOCOL_VERSION = 1;
var DEFAULT_BRIDGE_PORT = 47311;
var DEFAULT_BRIDGE_HOST = "127.0.0.1";
var PLUGIN_SOCKET_PATH = "/plugin";
var tool = {
  string(description, extra = {}) {
    return { type: "string", description, ...extra };
  },
  number(description, extra = {}) {
    return { type: "number", description, ...extra };
  },
  integer(description, extra = {}) {
    return { type: "integer", description, ...extra };
  },
  boolean(description, extra = {}) {
    return { type: "boolean", description, ...extra };
  },
  array(description, items, extra = {}) {
    return { type: "array", description, items, ...extra };
  },
  object(description, properties, extra = {}) {
    return { type: "object", description, properties, ...extra };
  },
  /**
   * An object whose shape is not known ahead of time, e.g. a whole parsed
   * .bbmodel document. Unlike `object()` this accepts arbitrary keys, which is
   * what the argument validator requires before it will pass one through.
   */
  freeObject(description, extra = {}) {
    return { type: "object", description, additionalProperties: true, ...extra };
  },
  enum(description, values, extra = {}) {
    return { type: "string", description, enum: values, ...extra };
  },
  vec3(description, extra = {}) {
    return {
      type: "array",
      description: `${description} (three numbers: [x, y, z])`,
      items: { type: "number" },
      minItems: 3,
      maxItems: 3,
      ...extra
    };
  },
  vec2(description, extra = {}) {
    return {
      type: "array",
      description: `${description} (two numbers: [u, v])`,
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
      ...extra
    };
  }
};

// src/bridge/log.ts
import fs from "node:fs";
import path from "node:path";
var LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
var RING_SIZE = 500;
var SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g,
  // OpenAI style
  /\b(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g,
  // Anthropic
  /\b(AIza[0-9A-Za-z_-]{6})[0-9A-Za-z_-]+/g,
  // Google
  /\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
  /(["']?(?:api[_-]?key|apikey|token|authorization|password|secret)["']?\s*[:=]\s*["'])([^"']{6,})(["'])/gi
];
function redact(input) {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...rest) => {
      const groups = rest.slice(0, -2);
      if (groups.length >= 3) {
        return `${groups[0] ?? ""}${String(groups[1] ?? "").slice(0, 3)}***redacted***${groups[2] ?? ""}`;
      }
      if (groups.length >= 1 && groups[0] !== void 0) {
        return `${groups[0]}***redacted***`;
      }
      return "***redacted***";
    });
  }
  return output;
}
function redactValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/key|token|secret|password|authorization/i.test(key)) {
        out[key] = typeof entry === "string" && entry ? `${entry.slice(0, 3)}***redacted***` : "***redacted***";
      } else {
        out[key] = redactValue(entry);
      }
    }
    return out;
  }
  return value;
}
var Logger = class _Logger {
  constructor(context = "bridge") {
    this.context = context;
    this.ring = [];
    this.fileStream = null;
    this.minLevel = "info";
  }
  setLevel(level) {
    this.minLevel = level;
  }
  /** Mirror everything into a file so the panel's "Console log" has a durable twin. */
  attachFile(filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fileStream = fs.createWriteStream(filePath, { flags: "a" });
    } catch {
      this.fileStream = null;
    }
  }
  child(context) {
    const childLogger = new _Logger(`${this.context}:${context}`);
    childLogger.minLevel = this.minLevel;
    childLogger.fileStream = this.fileStream;
    return childLogger;
  }
  log(level, message, data) {
    const record = {
      at: Date.now(),
      level,
      message: redact(message),
      data: data === void 0 ? void 0 : redactValue(data)
    };
    this.ring.push(record);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) {
      const stamp = new Date(record.at).toISOString().slice(11, 23);
      const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${this.context}] ${record.message}${data === void 0 ? "" : ` ${safeJson(record.data)}`}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
    if (this.fileStream) {
      this.fileStream.write(`${JSON.stringify(record)}
`);
    }
  }
  debug(message, data) {
    this.log("debug", message, data);
  }
  info(message, data) {
    this.log("info", message, data);
  }
  warn(message, data) {
    this.log("warn", message, data);
  }
  error(message, data) {
    this.log("error", message, data);
  }
  recent(limit = 100) {
    return this.ring.slice(-limit);
  }
  close() {
    this.fileStream?.end();
    this.fileStream = null;
  }
};
var log = new Logger("bridge");
function safeJson(value) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 800 ? `${text.slice(0, 800)}\u2026` : text;
  } catch {
    return "[unserialisable]";
  }
}

// src/bridge/config.ts
var HELP_TEXT = `blockbench-ai-agent bridge

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
function parseArgs(argv) {
  const flags = {
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
    maxSteps: null
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    const take = () => {
      const next = args.shift();
      return next === void 0 ? null : next;
    };
    switch (arg) {
      case "--serve":
        flags.serve = true;
        break;
      case "--mcp":
        flags.mcp = true;
        break;
      case "--doctor":
        flags.doctor = true;
        break;
      case "--install-plugin":
      case "--install":
        flags.installPlugin = true;
        break;
      case "--task":
        flags.task = take();
        break;
      case "--tool":
        flags.tool = take();
        break;
      case "--args":
      case "--tool-args":
        flags.toolArgs = take();
        break;
      case "--workspace":
        flags.workspace = take();
        break;
      case "--port":
        flags.port = Number(take());
        break;
      case "--host":
        flags.host = take();
        break;
      case "--model":
        flags.model = take();
        break;
      case "--base-url":
        flags.baseUrl = take();
        break;
      case "--provider":
        flags.provider = take();
        break;
      case "--token":
        flags.token = take();
        break;
      case "--log-level":
        flags.logLevel = take();
        break;
      case "--no-auth":
        flags.noAuth = true;
        break;
      case "--no-vision":
        flags.noVision = true;
        break;
      case "--max-steps":
        flags.maxSteps = Number(take());
        break;
      case "--help":
      case "-h":
      case "help":
        flags.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag "${arg}". Run with --help for usage.`);
        }
    }
  }
  return flags;
}
function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== void 0 && value !== "") return value;
  }
  return null;
}
function readFileConfig(workspace) {
  const candidates = [
    path2.join(workspace, "ai_context", "bridge.json"),
    path2.join(workspace, "bridge.json"),
    path2.join(os.homedir(), ".blockbench-ai-agent.json")
  ];
  for (const candidate of candidates) {
    try {
      if (fs2.existsSync(candidate)) {
        return JSON.parse(fs2.readFileSync(candidate, "utf8"));
      }
    } catch {
    }
  }
  return {};
}
function defaultPluginDir() {
  if (process.env.BLOCKBENCH_PLUGIN_DIR) return process.env.BLOCKBENCH_PLUGIN_DIR;
  if (process.env.BLOCKBENCH_DIR) {
    return null;
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return path2.join(appData, "Blockbench", "plugins");
  } else if (process.platform === "darwin") {
    return path2.join(os.homedir(), "Library", "Application Support", "Blockbench", "plugins");
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? path2.join(os.homedir(), ".config");
    return path2.join(xdg, "Blockbench", "plugins");
  }
  return null;
}
function resolveConfig(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspace = path2.resolve(flags.workspace ?? envValue("AI_AGENT_WORKSPACE") ?? process.cwd());
  const file = readFileConfig(workspace);
  const provider = flags.provider ?? envValue("AI_AGENT_PROVIDER") ?? file.provider ?? "openai-compatible";
  const isOllama = provider === "ollama";
  const baseUrl = flags.baseUrl ?? envValue("AI_AGENT_BASE_URL", "OPENAI_BASE_URL") ?? file.base_url ?? (isOllama ? "http://127.0.0.1:11434/v1" : "https://api.openai.com/v1");
  const model = flags.model ?? envValue("AI_AGENT_MODEL", "OPENAI_MODEL") ?? file.model ?? (isOllama ? "llama3.1" : "gpt-4o-mini");
  const explicitToken = flags.token ?? envValue("AI_AGENT_TOKEN") ?? file.token ?? null;
  const allowAnonymous = flags.noAuth || explicitToken === null;
  const token = explicitToken ?? (allowAnonymous ? "" : crypto.randomBytes(24).toString("base64url"));
  const config = {
    workspace,
    host: flags.host ?? envValue("AI_AGENT_HOST") ?? file.host ?? DEFAULT_BRIDGE_HOST,
    port: flags.port ?? Number(envValue("AI_AGENT_PORT") ?? file.port ?? DEFAULT_BRIDGE_PORT),
    token,
    allowAnonymous,
    logLevel: flags.logLevel ?? envValue("AI_AGENT_LOG_LEVEL") ?? "info",
    logFile: path2.join(workspace, "ai_context", "bridge.log"),
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    apiKey: envValue("AI_AGENT_API_KEY", "OPENAI_API_KEY") ?? "",
    extraHeaders: file.extra_headers ?? {},
    maxTokens: Number(envValue("AI_AGENT_MAX_TOKENS") ?? file.max_tokens ?? 8192),
    temperature: Number(envValue("AI_AGENT_TEMPERATURE") ?? file.temperature ?? 0.4),
    maxSteps: flags.maxSteps ?? Number(envValue("AI_AGENT_MAX_STEPS") ?? file.max_steps ?? 60),
    requestTimeoutMs: Number(envValue("AI_AGENT_TIMEOUT_MS") ?? 18e4),
    enableVision: !flags.noVision && file.enable_vision !== false,
    enableHttp: true,
    enableMcp: flags.mcp,
    blockbenchPluginDir: defaultPluginDir()
  };
  return { config, flags };
}
function describeForLog(config) {
  const token = config.token ?? "";
  const auth = config.allowAnonymous ? "anonymous (loopback only)" : token.length > 4 ? `token ${token.slice(0, 4)}*** (${token.length} chars)` : "token (not set \u2014 the plugin cannot authenticate until one is configured)";
  return {
    workspace: config.workspace,
    endpoint: `${config.host}:${config.port}`,
    auth,
    provider: config.provider,
    model: config.model,
    base_url: config.baseUrl,
    // Named so that it cannot be mistaken for a value: the key itself is masked by
    // `redact`, and the field name must not look like a secret of its own.
    api_key_state: config.apiKey ? redact(`api_key=${config.apiKey}`) : "not configured",
    vision: config.enableVision,
    max_steps: config.maxSteps,
    plugin_dir: config.blockbenchPluginDir
  };
}
function workspacePaths(config) {
  const root = config.workspace;
  return {
    root,
    references: path2.join(root, "references"),
    context: path2.join(root, "ai_context"),
    checkpoints: path2.join(root, "ai_context", "checkpoints"),
    viewport: path2.join(root, "ai_context", "viewport"),
    textures: path2.join(root, "ai_context", "textures")
  };
}
function ensureWorkspace(config) {
  const paths = workspacePaths(config);
  for (const dir of [paths.references, paths.context, paths.checkpoints, paths.viewport, paths.textures]) {
    fs2.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
function findProjectFile(workspace) {
  try {
    const entries = fs2.readdirSync(workspace, { withFileTypes: true });
    const models = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".bbmodel"));
    if (!models.length) return null;
    if (models.length === 1) return path2.join(workspace, models[0].name);
    const withTime = models.map((entry) => {
      const full = path2.join(workspace, entry.name);
      return { full, time: fs2.statSync(full).mtimeMs };
    });
    withTime.sort((a, b) => b.time - a.time);
    return withTime[0].full;
  } catch {
    return null;
  }
}

// src/bridge/memory.ts
import fs3 from "node:fs";
import path3 from "node:path";
var MAX_HISTORY = 800;
var IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
function now() {
  return Date.now();
}
function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function readJson(file, fallback) {
  try {
    if (!fs3.existsSync(file)) return fallback;
    const raw = fs3.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs3.mkdirSync(path3.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs3.writeFileSync(temp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs3.renameSync(temp, file);
}
var MemoryStore = class {
  constructor(paths, logger) {
    this.paths = paths;
    this.logger = logger;
    this.project = readJson(this.file("project.json"), {
      goal: null,
      target_format: null,
      scale: null,
      naming_conventions: [],
      notes: [],
      known_issues: [],
      created_at: now(),
      updated_at: now(),
      blockbench_version: null
    });
    this.decisions = readJson(this.file("decisions.json"), []);
    this.tasks = readJson(this.file("tasks.json"), []);
    this.history = readJson(this.file("history.json"), []);
  }
  file(name) {
    return path3.join(this.paths.context, name);
  }
  snapshot() {
    return {
      project: { ...this.project },
      decisions: [...this.decisions],
      tasks: [...this.tasks],
      history: [...this.history]
    };
  }
  /* ---------------------------------------------------------------- project */
  updateProject(patch) {
    this.project = {
      ...this.project,
      ...patch,
      naming_conventions: patch.naming_conventions ?? this.project.naming_conventions,
      notes: patch.notes ?? this.project.notes,
      known_issues: patch.known_issues ?? this.project.known_issues,
      updated_at: now()
    };
    writeJson(this.file("project.json"), this.project);
    this.logger.debug("project memory updated", { keys: Object.keys(patch) });
    return this.project;
  }
  addNote(note) {
    if (!note || this.project.notes.includes(note)) return;
    this.project.notes = [...this.project.notes.slice(-40), note];
    this.updateProject({});
  }
  addKnownIssue(issue) {
    if (!issue || this.project.known_issues.includes(issue)) return;
    this.project.known_issues = [...this.project.known_issues.slice(-40), issue];
    this.updateProject({});
  }
  /* -------------------------------------------------------------- decisions */
  addDecision(input) {
    const decision = {
      id: input.id ?? uid("dec"),
      at: now(),
      topic: input.topic,
      decision: input.decision,
      rationale: input.rationale,
      source: input.source ?? null
    };
    this.decisions.push(decision);
    writeJson(this.file("decisions.json"), this.decisions);
    return decision;
  }
  /* ------------------------------------------------------------------ tasks */
  upsertTask(input) {
    const existing = input.id ? this.tasks.find((task2) => task2.id === input.id) : this.tasks.find((task2) => task2.title === input.title);
    if (existing) {
      existing.status = input.status ?? existing.status;
      if (input.detail !== void 0) existing.detail = input.detail;
      if (input.note) {
        existing.notes = [...existing.notes.slice(-20), input.note];
        existing.attempts += 1;
      }
      existing.updated_at = now();
      writeJson(this.file("tasks.json"), this.tasks);
      return existing;
    }
    const task = {
      id: input.id ?? uid("task"),
      title: input.title,
      status: input.status ?? "pending",
      detail: input.detail ?? null,
      created_at: now(),
      updated_at: now(),
      attempts: 1,
      notes: input.note ? [input.note] : []
    };
    this.tasks.push(task);
    writeJson(this.file("tasks.json"), this.tasks);
    return task;
  }
  openTasks() {
    return this.tasks.filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked");
  }
  /* ---------------------------------------------------------------- history */
  appendHistory(entry) {
    this.history.push({
      at: entry.at ?? now(),
      kind: entry.kind,
      summary: entry.summary,
      tool: entry.tool ?? null,
      ok: entry.ok ?? null,
      duration_ms: entry.duration_ms ?? null,
      detail: entry.detail
    });
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    writeJson(this.file("history.json"), this.history);
  }
  recentHistory(limit = 20) {
    return this.history.slice(-limit);
  }
  /* ------------------------------------------------------------ checkpoints */
  writeCheckpoint(record, model) {
    const file = path3.join(this.paths.checkpoints, `${record.checkpoint_id}.json`);
    writeJson(file, {
      meta: { ...record, file: void 0 },
      model
    });
    const summary = { ...record, file };
    writeJson(path3.join(this.paths.checkpoints, "index.json"), this.listCheckpoints().concat([summary]));
    this.logger.info(`checkpoint stored: ${record.label} (${file})`);
    return summary;
  }
  listCheckpoints() {
    const indexFile = path3.join(this.paths.checkpoints, "index.json");
    const list = readJson(indexFile, []);
    return list.filter((entry) => entry && entry.checkpoint_id);
  }
  readCheckpoint(checkpointId) {
    const file = path3.join(this.paths.checkpoints, `${checkpointId}.json`);
    if (!fs3.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs3.readFileSync(file, "utf8"));
      return { meta: { ...parsed.meta, file }, model: parsed.model ?? null };
    } catch (error) {
      this.logger.warn(`could not read checkpoint ${checkpointId}: ${error.message}`);
      return null;
    }
  }
  /* -------------------------------------------------------------- artifacts */
  writeBinary(dir, name, data) {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
    const file = path3.join(dir, safe);
    fs3.mkdirSync(dir, { recursive: true });
    if (typeof data === "string") fs3.writeFileSync(file, data, "utf8");
    else fs3.writeFileSync(file, data);
    return file;
  }
  saveTexture(name, png) {
    return this.writeBinary(this.paths.textures, name.endsWith(".png") ? name : `${name}.png`, png);
  }
  saveViewport(name, png) {
    return this.writeBinary(this.paths.viewport, name.endsWith(".png") ? name : `${name}.png`, png);
  }
  saveProjectDocument(name, json2) {
    const file = path3.join(this.paths.root, name.endsWith(".bbmodel") ? name : `${name}.bbmodel`);
    fs3.mkdirSync(path3.dirname(file), { recursive: true });
    fs3.writeFileSync(file, json2, "utf8");
    return file;
  }
  saveProjectBackup(name, json2) {
    return this.writeBinary(this.paths.checkpoints, `${name}.bbmodel`, json2);
  }
  readProjectDocument(file) {
    const raw = fs3.readFileSync(file, "utf8");
    return JSON.parse(raw);
  }
  /* ------------------------------------------------------------- references */
  listReferences() {
    const dir = this.paths.references;
    if (!fs3.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs3.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path3.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      const file = path3.join(dir, entry.name);
      try {
        const buffer = fs3.readFileSync(file);
        out.push({
          name: entry.name,
          file,
          mime: ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/png",
          bytes: buffer.length,
          base64: buffer.toString("base64")
        });
      } catch (error) {
        this.logger.warn(`could not read reference ${entry.name}: ${error.message}`);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  /* ------------------------------------------------------------------ digest */
  /** Compact memory digest inserted into the agent prompt. */
  digest(maxHistory = 12) {
    const lines = [];
    lines.push(`- goal: ${this.project.goal ?? "(not set)"}`);
    lines.push(`- target format: ${this.project.target_format ?? "(not set)"}`);
    lines.push(`- scale: ${this.project.scale ?? "(not set)"}`);
    if (this.project.naming_conventions.length) lines.push(`- naming: ${this.project.naming_conventions.join("; ")}`);
    if (this.project.known_issues.length) lines.push(`- known issues: ${this.project.known_issues.join("; ")}`);
    if (this.decisions.length) {
      lines.push(`- decisions: ${this.decisions.slice(-8).map((d) => `${d.topic} \u2192 ${d.decision}`).join(" | ")}`);
    }
    const open = this.openTasks();
    if (open.length) {
      lines.push(`- open tasks: ${open.map((task) => `${task.title} [${task.status}]`).join(" | ")}`);
    }
    const recent = this.recentHistory(maxHistory);
    if (recent.length) {
      lines.push(`- recent actions: ${recent.map((entry) => `[${entry.kind}] ${entry.summary}`).join(" | ")}`);
    }
    return lines.join("\n");
  }
};

// src/bridge/session.ts
import { EventEmitter } from "node:events";
import crypto2 from "node:crypto";
import { WebSocketServer } from "ws";

// src/bridge/origin.ts
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function isTrustedOrigin(origin) {
  const raw = Array.isArray(origin) ? origin[0] : origin;
  const value = (raw ?? "").trim();
  if (!value || value === "null") return true;
  if (value === "file://" || value === "file:") return true;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return true;
  return LOCAL_HOSTNAMES.has(parsed.hostname);
}
function describeOrigin(origin) {
  const raw = Array.isArray(origin) ? origin[0] : origin;
  return raw ? String(raw) : "(none)";
}

// src/bridge/session.ts
var SESSION_EVENTS = {
  status: "status",
  state: "state",
  event: "event",
  progress: "progress",
  log: "log",
  task: "task",
  taskResult: "taskResult",
  taskStop: "taskStop"
};
var PluginSession = class extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.socket = null;
    this.pending = /* @__PURE__ */ new Map();
    this.inflight = /* @__PURE__ */ new Map();
    this.heartbeat = null;
    this.lastPong = 0;
    this.capabilitiesCache = null;
    this.toolsCache = [];
    this.stateCache = null;
    this.stateRevision = 0;
    this.setMaxListeners(50);
  }
  get connected() {
    return this.socket?.readyState === 1;
  }
  get capabilities() {
    return this.capabilitiesCache;
  }
  get state() {
    return this.stateCache;
  }
  get revision() {
    return this.stateRevision;
  }
  cachedTools() {
    return this.toolsCache;
  }
  /* ------------------------------------------------------------- lifecycle */
  attach(server) {
    this.server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on("upgrade", (request, socket, head) => {
      const pathname = (request.url ?? "").split("?")[0].replace(/\/+$/, "") || "/";
      if (pathname !== "/" && pathname !== PLUGIN_SOCKET_PATH) {
        this.logger.debug(`refusing upgrade on ${pathname}`);
        socket.destroy();
        return;
      }
      if (!isTrustedOrigin(request.headers.origin)) {
        this.logger.warn(`refusing plugin upgrade from origin ${describeOrigin(request.headers.origin)}`);
        socket.destroy();
        return;
      }
      this.server?.handleUpgrade(request, socket, head, (client) => {
        this.server?.emit("connection", client, request);
      });
    });
    this.server.on("connection", (client) => this.handleConnection(client));
  }
  stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error("bridge is shutting down"));
      this.pending.delete(id);
    }
    try {
      this.socket?.close(1001, "bridge shutting down");
    } catch {
    }
    this.socket = null;
    this.server?.close();
    this.server = null;
  }
  handleConnection(client) {
    this.logger.info("plugin socket opened, awaiting handshake");
    let authenticated = false;
    client.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        this.logger.warn(`dropping unparseable message: ${error.message}`);
        return;
      }
      if (!message || typeof message.type !== "string") {
        this.logger.warn("dropping message without a type");
        return;
      }
      if (!authenticated) {
        if (message.type !== "hello") {
          this.logger.warn(`rejecting ${message.type} before handshake`);
          try {
            client.close(4001, "handshake required");
          } catch {
          }
          return;
        }
        const accepted = this.checkToken(message.token ?? "");
        client.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            id: message.id,
            type: "welcome",
            accepted,
            reason: accepted ? void 0 : "invalid session token",
            server: { name: "blockbench-ai-agent-bridge", version: PROTOCOL_VERSION.toString() }
          })
        );
        if (!accepted) {
          this.logger.warn("rejected a plugin connection: bad token");
          try {
            client.close(4001, "invalid token");
          } catch {
          }
          return;
        }
        authenticated = true;
        this.socket = client;
        this.capabilitiesCache = message.capabilities ?? null;
        this.lastPong = Date.now();
        this.startHeartbeat();
        this.emit(SESSION_EVENTS.status, { status: "connected", capabilities: this.capabilitiesCache });
        this.logger.info(
          `plugin connected: Blockbench ${this.capabilitiesCache?.blockbench_version ?? "?"} \xB7 format ${this.capabilitiesCache?.active_format ?? "none"}`
        );
        void this.listTools(true).catch((error) => this.logger.warn(`initial list_tools failed: ${error.message}`));
        return;
      }
      this.dispatch(message);
    });
    client.on("close", (code, reason) => {
      if (this.socket === client) {
        this.socket = null;
        this.capabilitiesCache = null;
        this.emit(SESSION_EVENTS.status, { status: "disconnected", code, reason: String(reason) });
        this.logger.info(`plugin disconnected (${code})`);
      }
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error(`plugin disconnected while waiting for ${request.tool ?? request.kind}`));
        this.pending.delete(id);
      }
    });
    client.on("error", (error) => {
      this.logger.warn(`socket error: ${error.message}`);
    });
  }
  checkToken(presented) {
    if (this.config.allowAnonymous) return true;
    const expected = Buffer.from(this.config.token);
    const actual = Buffer.from(presented ?? "");
    if (expected.length !== actual.length) return false;
    return crypto2.timingSafeEqual(expected, actual);
  }
  startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > 25e3) {
        this.logger.warn("plugin stopped answering heartbeats");
        try {
          this.socket?.close(4e3, "heartbeat timeout");
        } catch {
        }
        return;
      }
      this.send({ v: PROTOCOL_VERSION, id: `ping-${Date.now()}`, type: "ping", t: Date.now() });
    }, 7e3);
  }
  dispatch(message) {
    switch (message.type) {
      case "pong":
        this.lastPong = Date.now();
        return;
      case "ping":
        this.send({ v: PROTOCOL_VERSION, id: message.id, type: "pong", t: Date.now() });
        return;
      case "tools": {
        this.toolsCache = message.tools ?? [];
        this.logger.info(`tool catalogue refreshed: ${this.toolsCache.length} tools`);
        this.settle(message.id, message);
        return;
      }
      case "tool_result": {
        this.emit(SESSION_EVENTS.progress, { request_id: message.request_id, done: true, tool: message.tool });
        this.settle(message.request_id, message);
        return;
      }
      case "capabilities": {
        const previous = this.capabilitiesCache;
        this.capabilitiesCache = message.report;
        const gained = message.report.features.filter((feature) => {
          const before = previous?.features.find((entry) => entry.id === feature.id);
          return feature.available && before && !before.available;
        });
        const lost = message.report.features.filter((feature) => {
          const before = previous?.features.find((entry) => entry.id === feature.id);
          return !feature.available && before && before.available;
        });
        this.logger.info(
          `capabilities updated (${message.reason}): format ${message.report.active_format ?? "none"}${gained.length ? ` \xB7 now available: ${gained.map((entry) => entry.id).join(", ")}` : ""}${lost.length ? ` \xB7 lost: ${lost.map((entry) => entry.id).join(", ")}` : ""}`
        );
        this.emit(SESSION_EVENTS.status, { status: "connected", capabilities: this.capabilitiesCache });
        return;
      }
      case "state_update": {
        this.stateCache = message.state;
        this.stateRevision = message.revision;
        this.emit(SESSION_EVENTS.state, { state: message.state, changed: message.changed });
        return;
      }
      case "event": {
        this.emit(SESSION_EVENTS.event, { name: message.name, data: message.data, at: message.at });
        return;
      }
      case "progress": {
        this.emit(SESSION_EVENTS.progress, {
          task_id: message.task_id,
          step: message.step,
          total: message.total,
          label: message.label
        });
        return;
      }
      case "log": {
        this.logger.log(message.level === "debug" ? "debug" : message.level, `[plugin] ${message.message}`);
        this.emit(SESSION_EVENTS.log, { level: message.level, message: message.message });
        return;
      }
      case "agent_task": {
        this.emit(SESSION_EVENTS.task, { request_id: message.request_id, prompt: message.prompt, context: message.context });
        return;
      }
      case "agent_stop": {
        this.emit(SESSION_EVENTS.taskStop, { request_id: message.request_id, reason: message.reason });
        return;
      }
      case "error": {
        this.logger.error(`plugin reported an error: ${message.error.message}`);
        return;
      }
      default:
        this.logger.debug(`unhandled message type ${message.type}`);
    }
  }
  settle(correlationId, message) {
    const pending = this.pending.get(correlationId);
    if (!pending) {
      this.logger.debug(`no pending request for ${correlationId}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    pending.resolve(message);
  }
  send(message) {
    if (!this.connected) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.warn(`send failed: ${error.message}`);
      return false;
    }
  }
  request(build, correlationId, kind, timeoutMs, tool2) {
    if (!this.connected) {
      return Promise.reject(new Error("The Blockbench plugin is not connected. Open Blockbench with the AI Agent plugin enabled and press Connect."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`${tool2 ?? kind} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer, kind, tool: tool2 });
      const ok = this.send(build(correlationId));
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        reject(new Error("failed to send the request to the plugin"));
      }
    });
  }
  /* ------------------------------------------------------------ operations */
  async listTools(force = false) {
    if (!force && this.toolsCache.length) return this.toolsCache;
    const id = `tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const message = await this.request(
      (requestId) => ({ v: PROTOCOL_VERSION, id: requestId, type: "list_tools" }),
      id,
      "tools",
      15e3
    );
    if (message.type !== "tools") throw new Error(`unexpected reply ${message.type} to list_tools`);
    this.toolsCache = message.tools ?? [];
    return this.toolsCache;
  }
  async callTool(name, args, options = {}) {
    const requestId = options.taskId ? `${options.taskId}:${name}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` : `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const timeoutMs = options.timeoutMs ?? 12e4;
    if (options.signal?.aborted) {
      return { ok: false, data: null, duration_ms: 0, error: { code: "cancelled", message: "cancelled before dispatch" } };
    }
    const onAbort = () => this.cancel(requestId, "aborted by caller");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.inflight.set(requestId, name);
    this.emit(SESSION_EVENTS.progress, { task_id: options.taskId, tool: name, started: true, args });
    try {
      const message = await this.request(
        (id) => ({
          v: PROTOCOL_VERSION,
          id,
          type: "tool_call",
          request_id: requestId,
          tool: name,
          args,
          timeout_ms: timeoutMs
        }),
        requestId,
        "tool",
        timeoutMs + 2e3,
        name
      );
      if (message.type !== "tool_result") throw new Error(`unexpected reply ${message.type} to tool_call`);
      const result = message;
      return {
        ok: result.ok,
        data: result.data ?? null,
        error: result.error,
        warnings: result.warnings,
        verified: result.verified,
        duration_ms: result.duration_ms
      };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.inflight.delete(requestId);
      this.emit(SESSION_EVENTS.progress, { task_id: options.taskId, tool: name, done: true });
    }
  }
  async checkpoint(label, includeSnapshot = true, timeoutMs = 6e4) {
    const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const message = await this.request(
      (requestId) => ({
        v: PROTOCOL_VERSION,
        id: requestId,
        type: "checkpoint",
        request_id: requestId,
        label,
        include_snapshot: includeSnapshot
      }),
      id,
      "checkpoint",
      timeoutMs,
      "checkpoint"
    );
    if (message.type !== "tool_result") throw new Error(`unexpected reply ${message.type} to checkpoint`);
    if (!message.ok) throw new Error(`checkpoint failed: ${message.error?.message ?? "unknown error"}`);
    return message.data;
  }
  async rollback(checkpointId, timeoutMs = 12e4) {
    const id = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const message = await this.request(
      (requestId) => ({
        v: PROTOCOL_VERSION,
        id: requestId,
        type: "rollback",
        request_id: requestId,
        checkpoint_id: checkpointId
      }),
      id,
      "rollback",
      timeoutMs,
      "rollback"
    );
    if (message.type !== "tool_result") throw new Error(`unexpected reply ${message.type} to rollback`);
    return {
      ok: message.ok,
      data: message.data ?? null,
      error: message.error,
      warnings: message.warnings,
      verified: message.verified,
      duration_ms: message.duration_ms
    };
  }
  cancel(requestId, reason = "cancelled") {
    if (!requestId) {
      for (const id of this.inflight.keys()) this.cancel(id, reason);
      return;
    }
    this.send({ v: PROTOCOL_VERSION, id: `cancel-${Date.now().toString(36)}`, type: "cancel", request_id: requestId, reason });
    this.logger.info(`cancel sent for ${requestId}`);
  }
  /** Push an agent run state change into the panel. */
  notifyAgentStatus(status) {
    this.send({ v: PROTOCOL_VERSION, id: `status-${Date.now().toString(36)}`, type: "agent_status", ...status });
  }
  /** Answer an `agent_task` coming from the panel. */
  notifyAgentResult(payload) {
    this.send({ v: PROTOCOL_VERSION, id: `result-${Date.now().toString(36)}`, type: "agent_task_result", ...payload });
  }
};

// src/bridge/llm.ts
var LlmError = class extends Error {
  constructor(message, status = null, retryable = false, detail) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
    this.name = "LlmError";
  }
};
var RETRY_STATUSES = /* @__PURE__ */ new Set([408, 409, 425, 429, 500, 502, 503, 504]);
function textify(content) {
  if (content === null || content === void 0) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : `[image ${part.image_url.url.slice(0, 32)}\u2026]`).join("\n");
}
var LlmClient = class {
  constructor(options) {
    this.options = options;
    this.logger = options.logger.child("llm");
  }
  get model() {
    return this.options.model;
  }
  get endpoint() {
    return `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }
  async chat(messages, tools = [], toolChoice = "auto") {
    const body = {
      model: this.options.model,
      messages,
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature,
      stream: false
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    const headers = {
      "content-type": "application/json",
      ...this.options.extraHeaders
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.post(body, headers);
        const reply = this.parse(response);
        if (reply.usage) {
          this.logger.debug(
            `usage prompt=${reply.usage.prompt_tokens ?? "?"} completion=${reply.usage.completion_tokens ?? "?"} finish=${reply.finishReason ?? "?"}`
          );
        }
        return reply;
      } catch (error) {
        const llmError = error instanceof LlmError ? error : new LlmError(error.message);
        lastError = llmError;
        if (!llmError.retryable || attempt === 3) break;
        const delay = 700 * attempt + Math.floor(Math.random() * 300);
        this.logger.warn(`${llmError.message} \u2014 retrying in ${delay}ms (attempt ${attempt}/3)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError ?? new LlmError("the model request failed");
  }
  async post(body, headers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const onAbort = () => controller.abort();
    this.options.signal?.addEventListener("abort", onAbort, { once: true });
    const payload = JSON.stringify(body);
    this.logger.debug(`POST ${this.endpoint} (${Math.round(payload.length / 1024)} KB, ${body.messages?.length ?? 0} messages)`);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = RETRY_STATUSES.has(response.status);
        throw new LlmError(
          `model endpoint returned HTTP ${response.status}: ${summarise(text)}`,
          response.status,
          retryable,
          text.slice(0, 2e3)
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError(`model endpoint returned non-JSON payload: ${summarise(text)}`, response.status, true);
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const err = error;
      if (err.name === "AbortError") {
        if (this.options.signal?.aborted) throw new LlmError("model request cancelled", null, false);
        throw new LlmError(`model request timed out after ${this.options.timeoutMs}ms`, null, true);
      }
      const cause = err.cause;
      const hint = cause?.code === "ECONNREFUSED" ? ` \u2014 nothing is listening at ${this.options.baseUrl}. Start the model server or fix --base-url.` : "";
      throw new LlmError(`${err.message}${hint}`, null, true);
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener("abort", onAbort);
    }
  }
  parse(raw) {
    const payload = raw;
    if (payload.error) {
      throw new LlmError(`model endpoint reported an error: ${payload.error.message ?? "unknown"}`, null, false);
    }
    const choice = payload.choices?.[0];
    if (!choice) throw new LlmError("model endpoint returned no choices", null, true);
    const message = choice.message ?? { role: "assistant", content: "" };
    if (Array.isArray(message.content)) {
      const parts = message.content;
      if (parts.every((part) => part && part.type === "text")) {
        message.content = parts.map((part) => part.text).join("");
      }
    }
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.map((call, index) => ({
        id: call?.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: {
          name: String(call?.function?.name ?? ""),
          arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {})
        }
      }));
      if (message.content === void 0) message.content = null;
    }
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: payload.usage ?? null
    };
  }
};
function summarise(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}\u2026` : trimmed;
}
function parseToolArguments(raw) {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed };
    }
    return { ok: false, error: `expected a JSON object but received ${Array.isArray(parsed) ? "an array" : typeof parsed}` };
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { ok: true, value: parsed };
      } catch {
      }
    }
    return { ok: false, error: `arguments are not valid JSON: ${error.message}` };
  }
}

// src/bridge/local-tools.ts
import fs4 from "node:fs";
import path4 from "node:path";

// src/bridge/image.ts
import { PNG } from "pngjs";
function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}
function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}
function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("not a data URL");
  const header = dataUrl.slice(0, comma);
  if (!header.includes("base64")) throw new Error("only base64 data URLs are supported");
  const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
  return decodePng(buffer);
}
function encodeDataUrl(image) {
  return `data:image/png;base64,${encodePng(image).toString("base64")}`;
}
function createImage(width, height, rgba = [24, 26, 32, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}
function blit(source, target, offsetX, offsetY) {
  for (let y = 0; y < source.height; y++) {
    const ty = y + offsetY;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < source.width; x++) {
      const tx = x + offsetX;
      if (tx < 0 || tx >= target.width) continue;
      const si = (y * source.width + x) * 4;
      const ti = (ty * target.width + tx) * 4;
      const alpha = source.data[si + 3] / 255;
      if (alpha === 0) continue;
      target.data[ti] = Math.round(source.data[si] * alpha + target.data[ti] * (1 - alpha));
      target.data[ti + 1] = Math.round(source.data[si + 1] * alpha + target.data[ti + 1] * (1 - alpha));
      target.data[ti + 2] = Math.round(source.data[si + 2] * alpha + target.data[ti + 2] * (1 - alpha));
      target.data[ti + 3] = Math.max(target.data[ti + 3], source.data[si + 3]);
    }
  }
}
function resizeNearest(source, width, height) {
  const out = createImage(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), [0, 0, 0, 0]);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(source.height - 1, Math.floor(y / out.height * source.height));
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(source.width - 1, Math.floor(x / out.width * source.width));
      const si = (sy * source.width + sx) * 4;
      const ti = (y * out.width + x) * 4;
      out.data[ti] = source.data[si];
      out.data[ti + 1] = source.data[si + 1];
      out.data[ti + 2] = source.data[si + 2];
      out.data[ti + 3] = source.data[si + 3];
    }
  }
  return out;
}
function fitInto(source, boxWidth, boxHeight) {
  const scale = Math.min(boxWidth / source.width, boxHeight / source.height);
  return resizeNearest(source, Math.max(1, Math.floor(source.width * scale)), Math.max(1, Math.floor(source.height * scale)));
}
function composeContactSheet(images, options = {}) {
  if (!images.length) throw new Error("composeContactSheet needs at least one image");
  const gap = options.gap ?? 4;
  const columns = Math.max(1, Math.min(options.columns ?? Math.ceil(Math.sqrt(images.length)), images.length));
  const rows = Math.ceil(images.length / columns);
  const cellSize = options.cellSize ?? Math.min(...images.map((entry) => Math.max(entry.image.width, entry.image.height)));
  const width = columns * cellSize + (columns + 1) * gap;
  const height = rows * cellSize + (rows + 1) * gap;
  const sheet = createImage(width, height, options.background ?? [18, 20, 24, 255]);
  const cells = [];
  images.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = gap + column * (cellSize + gap);
    const cellY = gap + row * (cellSize + gap);
    const fitted = fitInto(entry.image, cellSize, cellSize);
    const offsetX = cellX + Math.floor((cellSize - fitted.width) / 2);
    const offsetY = cellY + Math.floor((cellSize - fitted.height) / 2);
    blit(fitted, sheet, offsetX, offsetY);
    cells.push({ label: entry.label, x: offsetX, y: offsetY, width: fitted.width, height: fitted.height });
    for (let i = 0; i < cellSize; i++) {
      const borderX = gap + column * (cellSize + gap) - 1;
      const borderY = gap + row * (cellSize + gap) - 1;
      if (borderX >= 0) {
        const ti = ((cellY + i) * width + borderX) * 4;
        sheet.data[ti] = 60;
        sheet.data[ti + 1] = 64;
        sheet.data[ti + 2] = 72;
        sheet.data[ti + 3] = 255;
      }
      if (borderY >= 0) {
        const ti = (borderY * width + cellX + i) * 4;
        sheet.data[ti] = 60;
        sheet.data[ti + 1] = 64;
        sheet.data[ti + 2] = 72;
        sheet.data[ti + 3] = 255;
      }
    }
  });
  return {
    png: encodePng(sheet),
    dataUrl: encodeDataUrl(sheet),
    width,
    height,
    cells
  };
}

// src/bridge/textures.ts
function normaliseHex(input, fallback = "#7a7a7a") {
  const value = (input ?? fallback).trim().replace(/^#/, "");
  const hex = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return `#${hex.toLowerCase()}`;
}
function hexToRgb(hex) {
  const clean = normaliseHex(hex).slice(1);
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}
function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}
function shift(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  if (amount >= 0) {
    const t2 = amount;
    return rgbToHex([r + (255 - r) * t2, g + (255 - g) * t2, b + (255 - b) * t2]);
  }
  const t = 1 + amount;
  return rgbToHex([r * t, g * t, b * t]);
}
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function buildRamp(base, steps = 5, spread = 0.34) {
  const ramp = [];
  for (let i = 0; i < steps; i++) {
    const position = steps === 1 ? 0.5 : i / (steps - 1);
    ramp.push(shift(base, (position - 0.5) * 2 * spread));
  }
  return ramp;
}
function makeWriter(image) {
  return {
    set(x, y, hex, alpha = 255) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
      const [r, g, b] = hexToRgb(hex);
      const index = (y * image.width + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    },
    get(x, y) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return "#000000";
      const index = (y * image.width + x) * 4;
      return rgbToHex([image.data[index], image.data[index + 1], image.data[index + 2]]);
    }
  };
}
function shadeFactor(shading, x, y, width, height) {
  const nx = width <= 1 ? 0.5 : x / (width - 1);
  const ny = height <= 1 ? 0.5 : y / (height - 1);
  switch (shading) {
    case "top":
      return (0.5 - ny) * 0.36;
    case "bottom":
      return (ny - 0.5) * 0.36;
    case "vertical":
      return (0.5 - ny) * 0.22;
    case "radial": {
      const dx = nx - 0.5;
      const dy = ny - 0.42;
      const distance = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.7);
      return (0.5 - distance) * 0.4;
    }
    default:
      return 0;
  }
}
function quantise(ramp, factor) {
  if (ramp.length === 1) return ramp[0];
  const normalised = Math.max(0, Math.min(1, factor + 0.5));
  const index = Math.min(ramp.length - 1, Math.floor(normalised * ramp.length));
  return ramp[index];
}
function generateTexture(spec) {
  const width = Math.max(1, Math.min(256, Math.round(spec.width ?? 32)));
  const height = Math.max(1, Math.min(256, Math.round(spec.height ?? width)));
  const base = normaliseHex(spec.base, "#6b8e4e");
  const seed = spec.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = makeRandom(seed);
  const shading = spec.shading ?? "top";
  const pattern = spec.pattern ?? "noise";
  const density = Math.max(0, Math.min(1, spec.density ?? 0.35));
  const scale = Math.max(1, Math.round(spec.scale ?? Math.max(2, Math.round(Math.min(width, height) / 8))));
  const palette = (spec.palette?.length ? spec.palette : buildRamp(base, 5)).map((color) => normaliseHex(color));
  const ramp = palette.length >= 2 ? palette.slice().sort((a, b) => luminance(a) - luminance(b)) : [base];
  const image = createImage(width, height, [0, 0, 0, 0]);
  const writer = makeWriter(image);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const factor = shadeFactor(shading, x, y, width, height) + patternFactor(pattern, x, y, height, scale, density, random, seed);
      writer.set(x, y, quantise(ramp, factor));
    }
  }
  if (spec.split && spec.split.at > 0 && spec.split.at < 1) {
    const splitY = Math.round(height * spec.split.at);
    const splitColor = normaliseHex(spec.split.color);
    for (let y = splitY; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const jitter = (random() - 0.5) * 0.16;
        writer.set(x, y, shift(splitColor, shadeFactor("top", x, y - splitY, width, Math.max(1, height - splitY)) + jitter));
      }
    }
    for (let x = 0; x < width; x++) {
      if (random() < 0.5) writer.set(x, splitY - 1, shift(base, -0.18));
    }
  }
  if (spec.border) {
    const borderColor = normaliseHex(spec.border);
    for (let x = 0; x < width; x++) {
      writer.set(x, 0, borderColor);
      writer.set(x, height - 1, borderColor);
    }
    for (let y = 0; y < height; y++) {
      writer.set(0, y, borderColor);
      writer.set(width - 1, y, borderColor);
    }
  }
  const histogram = histogramOf(image);
  const name = spec.name ?? `texture_${width}x${height}_${seed.toString(36)}`;
  return {
    name,
    width,
    height,
    png: encodePng(image),
    dataUrl: encodeDataUrl(image),
    palette: ramp,
    histogram,
    seed
  };
}
function patternFactor(pattern, x, y, height, scale, density, random, seed) {
  switch (pattern) {
    case "flat":
      return 0;
    case "gradient":
      return (0.5 - (height <= 1 ? 0.5 : y / (height - 1))) * 0.5;
    case "stripes": {
      const index = Math.floor((x + y * 0.35) / scale);
      return index % 2 === 0 ? 0.12 : -0.12;
    }
    case "checker": {
      const cell = Math.floor(x / scale) + Math.floor(y / scale);
      return cell % 2 === 0 ? 0.1 : -0.1;
    }
    case "scales": {
      const row = Math.floor(y / scale);
      const offset = row % 2 === 0 ? 0 : Math.floor(scale / 2);
      const cellX = (x + offset) % (scale * 2);
      const cellY = y % scale;
      const edge = cellY === 0 || cellX === 0;
      const highlight = cellY === Math.max(1, Math.floor(scale / 2)) && cellX === Math.floor(scale / 2);
      return edge ? -0.2 : highlight ? 0.16 : 0.03;
    }
    case "spots": {
      const blob = hash2(x, y, scale, seed);
      const edge = random() < 0.12 ? (random() - 0.5) * 0.14 : 0;
      return (blob < density ? -0.18 : 0) + edge;
    }
    case "noise":
    default: {
      const value = random();
      if (value < density * 0.5) return -0.16;
      if (value > 1 - density * 0.5) return 0.14;
      return (value - 0.5) * 0.12;
    }
  }
}
function hash2(x, y, scale, seed) {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function histogramOf(image) {
  const counts = /* @__PURE__ */ new Map();
  let total = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue;
    const key = rgbToHex([image.data[i], image.data[i + 1], image.data[i + 2]]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex, count]) => ({ hex, share: total ? Math.round(count / total * 1e3) / 1e3 : 0 }));
}
function creaturePalette(primary, secondary, accents = []) {
  const out = [...buildRamp(normaliseHex(primary), 5)];
  if (secondary) out.push(...buildRamp(normaliseHex(secondary), 3, 0.26));
  out.push(...accents.map((accent) => normaliseHex(accent)));
  out.push(shift(normaliseHex(primary), -0.45));
  const unique = [...new Set(out)];
  return unique;
}

// src/bridge/local-tools.ts
var LOCAL_TOOL_PREFIX = "bridge_";
function storeCheckpoint(memory, outcome) {
  const model = outcome.snapshot?.model ?? null;
  const elements = model && Array.isArray(model.elements) ? model.elements.length : null;
  return memory.writeCheckpoint(
    {
      checkpoint_id: outcome.checkpoint_id,
      label: outcome.label,
      created_at: outcome.created_at ?? Date.now(),
      project_name: outcome.snapshot?.project_name ?? null,
      format_id: outcome.snapshot?.format_id ?? null,
      undo_index: outcome.undo_index ?? 0,
      undo_length: outcome.undo_length ?? 0,
      counts: elements === null ? null : { elements },
      file: ""
    },
    model
  );
}
var ANGLE_PRESETS = ["view", "north", "south", "east", "west", "top", "bottom", "isometric_right", "isometric_left", "isometric", "initial"];
function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function localTools(deps) {
  const { session, memory, logger } = deps;
  const def = (name, title, description, group, danger, needsCheckpoint, properties, required, returns) => ({
    name: `${LOCAL_TOOL_PREFIX}${name}`,
    title,
    description,
    group,
    danger,
    needs_checkpoint: needsCheckpoint,
    schema: { type: "object", properties, required, additionalProperties: false },
    returns
  });
  return [
    {
      definition: def(
        "look",
        "Look at the model",
        `Render the model from several camera angles and return them as ONE contact sheet image. This is the primary way to see what you have built. The result lists each angle with its pixel region in the sheet. Use it after every meaningful batch of edits, and always before claiming a model looks right.`,
        "bridge",
        "safe",
        false,
        {
          angles: tool.array("Camera presets to include (default: the standard five-angle set)", tool.string("Preset id"), { maxItems: 8 }),
          resolution: tool.integer("Resolution per angle in pixels", { default: 448, minimum: 192, maximum: 1024 }),
          columns: tool.integer("Contact sheet columns", { default: 3, minimum: 1, maximum: 4 }),
          annotation: tool.string('What you are checking, e.g. "silhouette after adding the tail"')
        },
        void 0,
        "{ data_url, width, height, cells[], missing[], saved_to }"
      ),
      handler: async (args, ctx) => {
        const requested = Array.isArray(args.angles) && args.angles.length ? args.angles : deps.defaultAngles;
        const resolution = num(args.resolution) ?? 448;
        const outcome = await session.callTool(
          "get_model_snapshot",
          { angles: requested, resolution, shading: true },
          ctx.options
        );
        if (!outcome.ok) {
          return { data: null, warnings: [`render failed: ${outcome.error?.message ?? "unknown error"}`], verified: false };
        }
        const payload = outcome.data;
        const images = payload?.images ?? [];
        const usable = images.filter((image) => typeof image.data_url === "string");
        if (!usable.length) {
          return {
            data: { images: 0, requested, available_presets: payload?.available_presets ?? ANGLE_PRESETS },
            warnings: ["Blockbench returned no pixels; the screenshot API may be unavailable in this build."],
            verified: false
          };
        }
        const sheet = composeContactSheet(
          usable.map((image) => ({ label: String(image.angle ?? "view"), image: decodeDataUrl(image.data_url) })),
          { columns: num(args.columns) ?? 3, gap: 6 }
        );
        const missing = requested.filter((angle) => !usable.some((image) => image.angle === angle));
        const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const savedTo = memory.saveViewport(`look-${stamp}.png`, sheet.png);
        const label = str(args.annotation);
        if (label) logger.debug(`contact sheet for "${label}"`);
        return {
          data: {
            wait_for_image: true,
            width: sheet.width,
            height: sheet.height,
            angles: sheet.cells.map((cell) => cell.label),
            cells: sheet.cells,
            missing,
            saved_to: savedTo,
            note: label ? `captured to check: ${label}` : void 0
          },
          images: [{ label: `contact sheet (${sheet.cells.map((cell) => cell.label).join(", ")})`, dataUrl: sheet.dataUrl }],
          verified: true
        };
      }
    },
    {
      definition: def(
        "generate_texture",
        "Generate a texture",
        "Generate a pixel-art texture procedurally and return it as a PNG data URL ready for create_texture or import_texture. Use this for organic, repetitive parts of a skin (scale patterns, dithered shading, scattered spots, stripes). Use paint_texture inside Blockbench for deliberate details such as eyes, teeth and claws. Deterministic: the same seed regenerates the same texture. The result includes the colour histogram so you can judge contrast.",
        "bridge",
        "safe",
        false,
        {
          name: tool.string('File and texture name, e.g. "trex_body"'),
          width: tool.integer("Width in texels", { default: 32, minimum: 1, maximum: 256 }),
          height: tool.integer("Height in texels", { minimum: 1, maximum: 256 }),
          base: tool.string('Base colour as hex, e.g. "#5c7a3a"'),
          palette: tool.array("Explicit shade ramp, darkest first", tool.string("Hex colour"), { maxItems: 12 }),
          pattern: tool.enum("Pattern", ["flat", "noise", "scales", "stripes", "spots", "gradient", "checker"]),
          scale: tool.integer("Feature size in texels", { minimum: 1, maximum: 64 }),
          density: tool.number("Coverage 0-1 for noise and spots", { minimum: 0, maximum: 1 }),
          shading: tool.enum("Lighting model", ["none", "top", "bottom", "radial", "vertical"]),
          seed: tool.integer("Random seed (reuse to reproduce a texture)"),
          border: tool.string('Colour for a 1px border that hides cube seams, e.g. "#2b2b2b"'),
          split_color: tool.string("Secondary colour applied below split_at"),
          split_at: tool.number("Fraction of the height where split_color starts (0-1)"),
          also_create: tool.boolean("Create the texture inside Blockbench immediately as well", { default: false })
        },
        ["name"],
        "{ name, width, height, data_url, palette, histogram, seed, saved_to, created_in_blockbench }"
      ),
      handler: async (args, ctx) => {
        const base = str(args.base, "#6b8e4e");
        const spec = {
          name: str(args.name, "texture"),
          width: num(args.width) ?? 32,
          height: num(args.height),
          base,
          palette: Array.isArray(args.palette) && args.palette.length ? args.palette : creaturePalette(base),
          pattern: str(args.pattern, "noise") ?? "noise",
          scale: num(args.scale),
          density: num(args.density),
          shading: str(args.shading, "top") ?? "top",
          seed: num(args.seed),
          border: args.border === null ? null : typeof args.border === "string" ? args.border : null,
          split: typeof args.split_color === "string" ? { at: num(args.split_at) ?? 0.62, color: args.split_color } : null
        };
        const texture = generateTexture(spec);
        const savedTo = memory.saveTexture(`${texture.name}-${texture.seed.toString(36)}.png`, texture.png);
        const warnings = [];
        let createdInBlockbench = false;
        if (args.also_create === true) {
          const created = await session.callTool(
            "create_texture",
            { name: texture.name, data_url: texture.dataUrl },
            ctx.options
          );
          if (created.ok) createdInBlockbench = true;
          else warnings.push(`created the PNG but Blockbench refused the texture: ${created.error?.message ?? "unknown error"}`);
        }
        return {
          data: {
            name: texture.name,
            width: texture.width,
            height: texture.height,
            data_url: texture.dataUrl,
            palette: texture.palette,
            histogram: texture.histogram,
            seed: texture.seed,
            saved_to: savedTo,
            created_in_blockbench: createdInBlockbench
          },
          warnings: warnings.length ? warnings : void 0,
          verified: texture.width > 0
        };
      }
    },
    {
      definition: def(
        "save",
        "Save the project",
        `Compile the project and actually write the .bbmodel to disk, then clear the unsaved marker in Blockbench. Use this rather than the plugin's save_project: the plugin can only compile the document (it has no filesystem access), so the file is written here, next to the project's existing path when there is one and into the workspace otherwise.`,
        "bridge",
        "safe",
        false,
        {
          file_name: tool.string("Override the file name, without extension"),
          directory: tool.string("Absolute directory to write into (defaults to the project path or the workspace)")
        },
        void 0,
        "{ saved_to, bytes, counts, format_id, verified }"
      ),
      handler: async (args, ctx) => {
        const outcome = await session.callTool("save_project", {}, ctx.options);
        if (!outcome.ok) {
          return { data: null, warnings: [`the plugin could not compile the project: ${outcome.error?.message ?? "unknown error"}`], verified: false };
        }
        const payload = outcome.data ?? {};
        if (!payload.model) {
          return { data: null, warnings: ["the plugin returned no model document"], verified: false };
        }
        const extension = (payload.extension ?? "bbmodel").replace(/^\./, "");
        const baseName = str(args.file_name) || payload.name || "project";
        const directory = str(args.directory) || (payload.save_path ? path4.dirname(payload.save_path) : deps.workspaceRoot);
        const target = path4.join(directory, `${baseName}.${extension}`);
        let bytes = 0;
        try {
          fs4.mkdirSync(directory, { recursive: true });
          const json2 = JSON.stringify(payload.model, null, 2);
          const temp = `${target}.tmp-${Date.now()}`;
          fs4.writeFileSync(temp, `${json2}
`, "utf8");
          fs4.renameSync(temp, target);
          bytes = Buffer.byteLength(json2);
        } catch (error) {
          return { data: null, warnings: [`could not write ${target}: ${error.message}`], verified: false };
        }
        const marked = await session.callTool("mark_project_saved", { save_path: target }, ctx.options);
        const warnings = [];
        if (!marked.ok) warnings.push(`the project was written but Blockbench still shows unsaved changes: ${marked.error?.message ?? "unknown error"}`);
        memory.appendHistory({ kind: "save", summary: `saved ${target} (${bytes} bytes)`, tool: "bridge_save", ok: true, duration_ms: null });
        return {
          data: {
            saved_to: target,
            bytes,
            counts: payload.counts ?? null,
            format_id: payload.format_id ?? null,
            marked_saved: marked.ok
          },
          warnings: warnings.length ? warnings : void 0,
          verified: bytes > 0 && marked.ok
        };
      }
    },
    {
      definition: def(
        "checkpoint",
        "Create checkpoint",
        "Record a restorable checkpoint of the current project (geometry, hierarchy, UVs, textures and animations). Call this before a large restructure so you can roll back instead of repairing. Blockbench also checkpoints automatically before destructive tools.",
        "bridge",
        "safe",
        false,
        {
          label: tool.string('Short description of the state, e.g. "before adding the tail"')
        },
        ["label"],
        "CheckpointOutcome"
      ),
      handler: async (args) => {
        const record = await session.checkpoint(str(args.label, "agent checkpoint"), true);
        storeCheckpoint(memory, record);
        memory.appendHistory({ kind: "checkpoint", summary: `checkpoint: ${record.label}`, tool: "bridge_checkpoint", ok: true, duration_ms: null });
        return { data: record, verified: true };
      }
    },
    {
      definition: def(
        "rollback",
        "Roll back",
        "Restore a checkpoint by id. Use it when a change went badly wrong; it is cheaper and safer than trying to undo a large restructure by hand. Calling it with no id restores the most recent checkpoint.",
        "bridge",
        "destructive",
        false,
        {
          checkpoint_id: tool.string("Checkpoint id (defaults to the latest)"),
          reason: tool.string("Why the rollback is needed")
        },
        void 0,
        "{ checkpoint_id, label, restored, verified }"
      ),
      handler: async (args) => {
        const checkpoints = memory.listCheckpoints();
        const target = str(args.checkpoint_id) || checkpoints[checkpoints.length - 1]?.checkpoint_id || "";
        if (!target) return { data: null, warnings: ["No checkpoints exist yet."], verified: false };
        const outcome = await session.rollback(target);
        memory.appendHistory({
          kind: "rollback",
          summary: `rollback to ${target}${args.reason ? ` \u2014 ${String(args.reason)}` : ""}`,
          tool: "bridge_rollback",
          ok: outcome.ok,
          duration_ms: outcome.duration_ms
        });
        if (!outcome.ok) {
          return { data: outcome.data, warnings: [outcome.error?.message ?? "rollback failed"], verified: false };
        }
        return { data: outcome.data, verified: outcome.verified ?? true };
      }
    },
    {
      definition: def(
        "remember",
        "Remember",
        "Persist project context so a future run does not have to rediscover it: the goal, the target format, the scale convention, a design decision with its rationale, a note, or a known issue. Use it whenever you make a judgement call the user would want explained later.",
        "bridge",
        "safe",
        false,
        {
          goal: tool.string("Overall project goal"),
          target_format: tool.string('Target Blockbench format id, e.g. "java_block"'),
          scale: tool.string('Scale convention, e.g. "1 cube = 1/16 block"'),
          naming: tool.array("Naming conventions to follow", tool.string("Convention"), { maxItems: 12 }),
          note: tool.string("Free-form note"),
          known_issue: tool.string("Something wrong that is known and accepted"),
          decision: tool.object("A design decision to record", {
            topic: tool.string('What the decision is about, e.g. "leg length"'),
            decision: tool.string("What you decided"),
            rationale: tool.string("Why"),
            source: tool.string('Where the evidence came from, e.g. "reference 2"')
          }, { required: ["topic", "decision", "rationale"] })
        },
        void 0,
        "{ project, decision?, stored_at }"
      ),
      handler: async (args) => {
        const patch = {};
        if (typeof args.goal === "string") patch.goal = args.goal;
        if (typeof args.target_format === "string") patch.target_format = args.target_format;
        if (typeof args.scale === "string") patch.scale = args.scale;
        if (Array.isArray(args.naming)) patch.naming_conventions = args.naming;
        const project = memory.updateProject(patch);
        if (typeof args.note === "string") memory.addNote(args.note);
        if (typeof args.known_issue === "string") memory.addKnownIssue(args.known_issue);
        let decision = null;
        if (args.decision && typeof args.decision === "object") {
          const record = args.decision;
          decision = memory.addDecision({
            topic: str(record.topic, "general"),
            decision: str(record.decision, ""),
            rationale: str(record.rationale, ""),
            source: typeof record.source === "string" ? record.source : null
          });
        }
        memory.appendHistory({ kind: "note", summary: decision ? `decision: ${decision.topic}` : "memory updated", tool: "bridge_remember", ok: true, duration_ms: null });
        return {
          data: { project: { goal: project.goal, target_format: project.target_format, scale: project.scale }, decision, notes: project.notes.length },
          verified: true
        };
      }
    },
    {
      definition: def(
        "plan",
        "Plan tasks",
        "Write down the subtasks of a long build so progress survives the end of the run and so you can check yourself against the plan. Call it once after OBSERVE, then keep it current with plan_update.",
        "bridge",
        "safe",
        false,
        {
          tasks: tool.array(
            "Subtasks in order",
            tool.object("A subtask", {
              title: tool.string('Short title, e.g. "legs and claws"'),
              detail: tool.string('What "done" means'),
              status: tool.enum("Status", ["pending", "in_progress", "done", "failed", "blocked"])
            }, { required: ["title"] }),
            { minItems: 1, maxItems: 40 }
          )
        },
        ["tasks"],
        "{ tasks: TaskRecord[] }"
      ),
      handler: async (args) => {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        const records = tasks.map(
          (task) => memory.upsertTask({
            title: str(task.title, "untitled"),
            detail: typeof task.detail === "string" ? task.detail : null,
            status: task.status ?? "pending"
          })
        );
        memory.appendHistory({ kind: "note", summary: `plan with ${records.length} steps`, tool: "bridge_plan", ok: true, duration_ms: null });
        return { data: { tasks: records }, verified: true };
      }
    },
    {
      definition: def(
        "plan_update",
        "Update a plan step",
        'Mark a subtask done or failed and attach what you learned. Keep the plan honest: a step is only "done" once you have inspected the result.',
        "bridge",
        "safe",
        false,
        {
          title: tool.string("Task title to update"),
          id: tool.string("Task id, if you have it"),
          status: tool.enum("New status", ["pending", "in_progress", "done", "failed", "blocked"]),
          note: tool.string('What happened, e.g. "tail pivots were 2px off, fixed"')
        },
        void 0,
        "TaskRecord"
      ),
      handler: async (args) => {
        const title = str(args.title);
        const id = str(args.id);
        const existing = memory.snapshot().tasks.find((task) => id && task.id === id || title && task.title === title);
        if (!existing && !title) return { data: null, warnings: ["Provide either id or title."], verified: false };
        const record = memory.upsertTask({
          id: existing?.id,
          title: title || existing?.title || "untitled",
          status: args.status ?? existing?.status ?? "pending",
          note: typeof args.note === "string" ? args.note : void 0
        });
        return { data: record, verified: true };
      }
    },
    {
      definition: def(
        "references",
        "Re-read the reference images",
        "Re-attach the reference images from ./references to the conversation when you need to re-examine proportions, colours or markings. They are also attached at the start of the task.",
        "bridge",
        "safe",
        false,
        {
          names: tool.array("Reference file names to re-read (default: all)", tool.string("File name")),
          note: tool.string('What you are looking for, e.g. "leg thickness relative to the body"')
        },
        void 0,
        "{ attached, references: {name, mime, bytes}[] }"
      ),
      handler: async (args) => {
        const all = memory.listReferences();
        const wanted = Array.isArray(args.names) && args.names.length ? args.names : all.map((reference) => reference.name);
        const selected = all.filter((reference) => wanted.includes(reference.name));
        if (!selected.length) return { data: { attached: 0 }, warnings: ["No matching reference images found."], verified: true };
        return {
          data: {
            attached: selected.length,
            note: typeof args.note === "string" ? args.note : void 0,
            references: selected.map((reference) => ({ name: reference.name, mime: reference.mime, bytes: reference.bytes }))
          },
          images: selected.map((reference) => ({ label: `reference: ${reference.name}`, dataUrl: `data:${reference.mime};base64,${reference.base64}` })),
          verified: true
        };
      }
    },
    {
      definition: def(
        "finish",
        "Finish the task",
        "End the task and report the result to the user. Call it ONLY after you have inspected the rendered model and, when the task asked for a saved file, saved the project. Set verified true only if you personally confirmed the result with a visual check and validate_model.",
        "bridge",
        "safe",
        false,
        {
          summary: tool.string("What you built, what you verified, and anything still weak"),
          verified: tool.boolean("True only if the final state was inspected and matches the request"),
          saved: tool.boolean("True if the project was saved"),
          remaining: tool.string("Anything still to do, if the task is not fully complete")
        },
        ["summary"],
        "{ finished: true }"
      ),
      handler: async (args) => {
        const summary = str(args.summary, "done");
        const verified = args.verified !== false;
        memory.appendHistory({ kind: "agent", summary: `finished: ${summary.slice(0, 200)}`, tool: "bridge_finish", ok: verified, duration_ms: null });
        for (const task of memory.openTasks()) {
          if (task.status === "in_progress") memory.upsertTask({ id: task.id, title: task.title, status: verified ? "done" : "blocked", note: "closed by bridge_finish" });
        }
        return { data: { finished: true, remaining: typeof args.remaining === "string" ? args.remaining : null }, verified, finish: { summary, verified } };
      }
    }
  ];
}

// src/bridge/prompts.ts
var WORKFLOW = `OBSERVE \u2192 PLAN \u2192 EXECUTE \u2192 INSPECT \u2192 REFINE \u2192 VERIFY \u2192 SAVE

1. OBSERVE  Inspect before you touch anything: the project, the model, the hierarchy,
            the selection, the textures and the viewport. Look at the pixels.
2. PLAN     Decide the format, the proportions, the bone hierarchy, the cube budget
            and the texture layout. Record the decisions you make.
3. EXECUTE  Build in batches (bulk_create_cubes) rather than one cube per step.
4. INSPECT  Re-read the state after every batch. Compare against your own plan.
5. REFINE   Fix what does not match: proportions, pivots, hierarchy, UVs, palette.
6. VERIFY   validate_model, then look at the rendered result and confirm the render
            matches the intent. Never claim success you have not seen.
7. SAVE     bridge_save writes the .bbmodel to disk and clears Blockbench's unsaved
            marker. Note what was done, then call bridge_finish.`;
var DESIGN_RULES = `MINECRAFT ASSET DESIGN RULES
- Silhouette first. A player must recognise the creature from an untextured black
  render. Build the outline before the detail.
- Cubic construction. Cubes and box UVs, no decoration that a cube cannot carry.
- Proportions from the reference images, not from your imagination: measure features
  in head-lengths and reproduce those ratios.
- Hierarchy that matches anatomy: root \u2192 body \u2192 neck \u2192 head, limbs off the body. Name
  bones like ${"`"}trex.leg_front.left${"`"} so the names are self-documenting.
- Pivots belong at joints (shoulder, hip, base of the neck), never at cube centres by
  accident. Use set_pivot deliberately.
- Geometry budget: a Minecraft mob is 30-80 cubes. Only add a cube when the silhouette
  or a joint genuinely needs it.
- Textures are 16x16, 32x32 or 64x64 texels. Author real pixels with paint_texture:
  base fill, then shade_rect for form, then pixel-level markings for eyes, claws,
  stripes and teeth. Flat single-colour cubes are a failure.
- Every cube face that a player can see needs a UV region that shows something
  intentional. Call auto_uv, then fix the regions that matter (face, eyes, belly).
- Animations must read at a glance: idle breathing, walk cycle with opposite-phase
  legs, attack with anticipation \u2192 impact \u2192 recovery. Two to six keyframes per
  channel is professional. Set the loop mode.

PIXEL ART RULES
- Limit the palette: 6-12 colours per model. Pick the reference's dominant hues.
- Shade in steps of roughly 12-18% brightness, top-lit.
- Darken seams where limbs meet the body so joints read.
- Never leave a face flat where a two-tone gradient would imply volume.`;
var RULES = `HARD RULES
- Never invent a tool. If you are unsure what exists, call list_capabilities or reuse
  the catalogue below. An unknown tool name is rejected by the registry.
- Never invent Blockbench APIs either: everything you can do must go through a tool.
- Never report success without evidence. Tools return a \`verified\` flag; a mutating
  tool with verified:false must be followed by an inspection that confirms the change.
- Work in the project's own format. Inspect the project first and match its format.
- Prefer few, large, verifiable steps over many tiny ones.
- If a tool fails, read the error: the registry returns the exact validation problem or
  the list of valid names. Fix the arguments and retry; do not repeat the same call.
- Destructive operations (deleting, replacing a hierarchy, rolling back) are
  checkpointed automatically. If you get badly off track, call rollback.
- Do not ask the user for cube coordinates, pivots, UV numbers or keyframe times. Make
  those decisions yourself and state them in your decisions.
- Keep the ending short: say what you built, what you verified, and what is weak.`;
function describeCapabilities(capabilities) {
  if (!capabilities) {
    return "The plugin has not reported its capabilities yet. Call list_capabilities before relying on anything optional.";
  }
  const available = capabilities.features.filter((feature) => feature.available);
  const missing = capabilities.features.filter((feature) => !feature.available);
  const lines = [
    `Blockbench ${capabilities.blockbench_version} (plugin ${capabilities.plugin_version}, protocol ${capabilities.protocol_version})`,
    `platform: ${capabilities.operating_system} \xB7 ${capabilities.blockbench_is_app ? "desktop app" : "web"}`,
    `active format: ${capabilities.active_format ?? "(none)"} \xB7 mode: ${capabilities.mode ?? "(unknown)"} \xB7 ${capabilities.format_count} formats registered`,
    `available: ${available.map((feature) => feature.id).join(", ") || "(none reported)"}`
  ];
  if (missing.length) lines.push(`UNAVAILABLE \u2014 plan around these: ${missing.map((feature) => `${feature.id} (${feature.note ?? "no detail"})`).join("; ")}`);
  if (capabilities.limitations.length) lines.push(`limitations: ${capabilities.limitations.join("; ")}`);
  return lines.join("\n");
}
function describeTools(tools) {
  if (!tools.length) return "No tools are available: the plugin has not sent its catalogue yet.";
  const groups = /* @__PURE__ */ new Map();
  for (const definition of tools) {
    const list = groups.get(definition.group) ?? [];
    list.push(definition);
    groups.set(definition.group, list);
  }
  const lines = [];
  for (const [group, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`[${group}]`);
    for (const definition of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const firstLine = definition.description.split("\n")[0].trim();
      const flags = [definition.danger === "safe" ? "" : definition.danger, definition.needs_checkpoint ? "checkpointed" : ""].filter(Boolean).join(", ");
      lines.push(`  ${definition.name}(${Object.keys(definition.schema.properties ?? {}).join(", ")})${flags ? ` [${flags}]` : ""} \u2014 ${firstLine}`);
    }
  }
  lines.push("Use the JSON schemas supplied with the function definitions for exact parameters.");
  return lines.join("\n");
}
function describeReferences(references) {
  if (!references.length) {
    return "No reference images are present. Rely on your own knowledge of the subject and say so in your end-of-task summary.";
  }
  const lines = references.map(
    (reference, index) => `  ${index + 1}. ${reference.name} (${reference.mime}, ${Math.round(reference.bytes / 1024)} KB) \u2014 attached to this message as image ${index + 1}`
  );
  return ["Reference images found in ./references:", ...lines, "Extract proportions, silhouette, palette and markings from them. Do not copy them literally."].join("\n");
}
function buildSystemPrompt(context) {
  const sections = [];
  sections.push(
    `You are the reasoning core of a Blockbench AI Agent. You are not a chatbot: you
operate a real Blockbench session through a tool registry that is live on the user's
machine, and your job is to leave a better model behind than you found.

You have both STRUCTURED STATE (inspection tools) and VISUAL STATE (${context.visionEnabled ? "real screenshots from the viewport" : "DISABLED for this run \u2014 reason from structured state and say when that limits you"}). Use both.`
  );
  sections.push(`BLOCKBENCH ENVIRONMENT
${describeCapabilities(context.capabilities)}`);
  sections.push(`TOOL CATALOGUE (${context.tools.length} tools)
${describeTools(context.tools)}`);
  sections.push(`WORKFLOW
${WORKFLOW}`);
  sections.push(RULES);
  sections.push(DESIGN_RULES);
  sections.push(`REFERENCE IMAGES
${describeReferences(context.references)}`);
  sections.push(`PROJECT MEMORY (reload this before changing direction)
${context.memory.digest()}`);
  sections.push(
    `WORKSPACE
Workspace folder: ${context.workspace}
Keep generated textures and screenshots inside it via the plugin's save/texture tools.`
  );
  if (context.visionEnabled) {
    sections.push(
      `IMAGE READING
Screenshots arrive as one contact sheet containing several camera angles. The tool
result lists the layout (label, x, y, width, height) for each angle; use it to tell them
apart. Read the render critically: silhouette, floating or intersecting cubes, wrong
pivots (limbs detached at the joint), stretched or mirrored UVs, muddy texture contrast.`
    );
  }
  sections.push(
    `FINISHING
End every task by: (1) validate_model, (2) one final look at the viewport, (3) bridge_save,
(4) recording the decisions you made, and (5) a short prose summary of what you built,
what you verified and what is still weak.`
  );
  return sections.join("\n\n");
}
function buildTaskMessage(brief, references) {
  const lines = [`TASK
${brief.prompt}`];
  const known = [];
  if (brief.projectName) known.push(`project name: ${brief.projectName}`);
  if (brief.formatId) known.push(`format: ${brief.formatId}`);
  if (known.length) lines.push(`
The plugin already reports ${known.join(", ")}. Confirm it rather than assuming.`);
  lines.push(
    "\nStart with OBSERVE: inspect the project, the model, the hierarchy and the viewport, then state your plan before your first mutation."
  );
  return { text: lines.join("\n"), images: references };
}

// src/bridge/agent.ts
var Agent = class {
  constructor(session, memory, config, paths, llm, logger) {
    this.session = session;
    this.memory = memory;
    this.config = config;
    this.logger = logger.child("agent");
    this.llm = new LlmClient({ ...llm, logger: this.logger });
    this.locals = new Map(
      localTools({
        session,
        memory,
        logger: this.logger,
        workspaceRoot: config.workspace,
        viewportDir: paths.viewport,
        textureDir: paths.textures,
        defaultAngles: config.defaultAngles
      }).map((local) => [local.definition.name, local])
    );
  }
  get model() {
    return this.llm.model;
  }
  /** Bridge tools, for catalogue endpoints (HTTP/MCP) that must list everything. */
  localDefinitions() {
    return [...this.locals.values()].map((local) => local.definition);
  }
  async run(options) {
    const started = Date.now();
    const toolLog = [];
    const checkpoints = [];
    let toolCalls = 0;
    let steps = 0;
    let finalSummary = "";
    let verified = false;
    let saved = false;
    let finishRequested = false;
    const fail = (error) => ({
      ok: false,
      summary: finalSummary,
      verified,
      saved,
      steps,
      tool_calls: toolCalls,
      started_at: started,
      finished_at: Date.now(),
      checkpoints,
      tool_log: toolLog,
      error
    });
    const pluginTools = await this.session.listTools();
    if (!pluginTools.length) {
      return fail({
        code: "no_tools",
        message: "The plugin reported no tools. Update the plugin or reload it, then try again."
      });
    }
    const definitions = new Map(pluginTools.map((definition) => [definition.name, definition]));
    for (const local of this.locals.values()) definitions.set(local.definition.name, local.definition);
    const systemPrompt = buildSystemPrompt({
      capabilities: this.session.capabilities,
      tools: [...definitions.values()],
      memory: this.memory,
      references: this.memory.listReferences(),
      visionEnabled: this.config.enableVision,
      workspace: this.config.workspace
    });
    const references = this.memory.listReferences();
    const brief = buildTaskMessage(options.brief, references);
    const snapshot = this.session.state;
    const contextLines = [];
    if (snapshot?.project) {
      const project = snapshot.project;
      contextLines.push(
        `Current project at task start: "${project.project_name ?? "(unsaved)"}" \xB7 format ${project.format_id} \xB7 ${project.element_count} cubes in ${project.group_count} groups \xB7 ${project.texture_count} textures \xB7 ${project.animation_count} animations \xB7 resolution ${project.resolution.width}x${project.resolution.height}`
      );
    }
    if (snapshot?.selection && (snapshot.selection.elements.length || snapshot.selection.groups.length)) {
      contextLines.push(`Current selection: ${[...snapshot.selection.groups, ...snapshot.selection.elements].slice(0, 12).join(", ")}`);
    }
    const firstMessage = {
      role: "user",
      content: [
        { type: "text", text: [brief.text, contextLines.join("\n")].filter(Boolean).join("\n\n") },
        ...brief.images.map((reference) => ({
          type: "image_url",
          image_url: { url: `data:${reference.mime};base64,${reference.base64}`, detail: "high" }
        }))
      ]
    };
    const messages = [{ role: "system", content: systemPrompt }, firstMessage];
    const toolSchemas = [...definitions.values()].map((definition) => ({
      type: "function",
      function: {
        name: definition.name,
        description: `${definition.description}

Returns: ${definition.returns}${definition.needs_checkpoint ? "\n(Blockbench takes a checkpoint before this runs.)" : ""}`,
        parameters: definition.schema
      }
    }));
    this.logger.info(`task started with ${toolSchemas.length} tools available (${pluginTools.length} from the plugin)`);
    this.session.notifyAgentStatus({ state: "running", task_id: options.taskId, step: 0, total: this.config.maxSteps, label: "observing" });
    const throwIfAborted = () => {
      if (options.signal?.aborted) {
        throw new LlmError("task cancelled", null, false);
      }
    };
    let nudges = 0;
    let visionNudged = false;
    try {
      for (steps = 1; steps <= this.config.maxSteps; steps++) {
        throwIfAborted();
        options.onProgress?.({ step: steps, total: this.config.maxSteps, label: `thinking (step ${steps}/${this.config.maxSteps})` });
        this.session.notifyAgentStatus({
          state: "running",
          task_id: options.taskId,
          step: steps,
          total: this.config.maxSteps,
          label: "thinking"
        });
        const reply = await this.llm.chat(messages, toolSchemas, "auto");
        const assistant = reply.message;
        const text = textify(assistant.content).trim();
        if (text) finalSummary = text;
        messages.push({
          role: "assistant",
          content: assistant.content ?? (assistant.tool_calls?.length ? null : ""),
          tool_calls: assistant.tool_calls
        });
        const calls = assistant.tool_calls ?? [];
        if (!calls.length) {
          if (finishRequested) break;
          if (nudges < 1) {
            nudges += 1;
            const wantsVision = this.config.enableVision && !visionNudged;
            messages.push({
              role: "user",
              content: `You stopped without calling ${LOCAL_TOOL_PREFIX}finish.
` + (wantsVision ? `Before finishing: call ${LOCAL_TOOL_PREFIX}look to actually see the model, run validate_model, fix anything the render shows, then call ${LOCAL_TOOL_PREFIX}finish.` : `Before finishing: run validate_model and confirm the state with an inspection tool, then call ${LOCAL_TOOL_PREFIX}finish.`)
            });
            if (wantsVision) visionNudged = true;
            continue;
          }
          break;
        }
        const images = [];
        for (const call of calls) {
          throwIfAborted();
          toolCalls += 1;
          const name = call.function.name;
          const definition = definitions.get(name);
          const parsed = parseToolArguments(call.function.arguments);
          const callOptions = { taskId: options.taskId, signal: options.signal };
          if (!definition) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `ERROR unknown_tool: "${name}" does not exist. Available tools: ${[...definitions.keys()].sort().join(", ")}`
            });
            toolLog.push({ step: steps, tool: name, ok: false, summary: "unknown tool", duration_ms: 0 });
            continue;
          }
          if (!parsed.ok) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `ERROR invalid_arguments: ${parsed.error}
Expected JSON matching this schema: ${JSON.stringify(definition.schema).slice(0, 1200)}`
            });
            toolLog.push({ step: steps, tool: name, ok: false, summary: "bad arguments", duration_ms: 0 });
            continue;
          }
          options.onToolCall?.({ tool: name, args: parsed.value, step: steps });
          options.onProgress?.({ step: steps, total: this.config.maxSteps, label: `${name} ${summariseArgs(parsed.value)}`.trim() });
          let content = "";
          let ok = false;
          let durationMs = 0;
          let summary = "";
          const local = this.locals.get(name);
          if (local) {
            const began = Date.now();
            try {
              const result = await local.handler(parsed.value, { taskId: options.taskId, signal: options.signal, options: callOptions });
              durationMs = Date.now() - began;
              ok = true;
              if (result.finish) {
                finishRequested = true;
                finalSummary = result.finish.summary;
                verified = result.finish.verified;
                saved = parsed.value.saved === true ? true : saved;
              }
              if (result.images?.length) images.push(...result.images);
              const created = result.data?.checkpoint_id;
              if (name === `${LOCAL_TOOL_PREFIX}checkpoint` && created) checkpoints.push(created);
              const rendered = renderResult(result.data, this.config.maxToolResultChars);
              summary = rendered.summary;
              content = [
                rendered.text,
                result.warnings?.length ? `WARNINGS: ${result.warnings.join(" | ")}` : "",
                result.images?.length ? `[${result.images.length} image(s) attached in the next message]` : ""
              ].filter(Boolean).join("\n");
            } catch (error) {
              durationMs = Date.now() - began;
              content = `ERROR local_tool_failed: ${error.message}`;
              summary = error.message;
            }
          } else {
            if (definition.needs_checkpoint) {
              try {
                const record = await this.session.checkpoint(`before ${name}`);
                checkpoints.push(record.checkpoint_id);
                storeCheckpoint(this.memory, record);
                this.logger.debug(`checkpoint ${record.checkpoint_id} taken before ${name}`);
              } catch (error) {
                this.logger.warn(`could not checkpoint before ${name}: ${error.message}`);
              }
            }
            const outcome = await this.session.callTool(name, parsed.value, callOptions);
            durationMs = outcome.duration_ms;
            ok = outcome.ok;
            summary = ok ? "ok" : outcome.error?.message ?? "failed";
            if (ok) {
              const rendered = renderResult(outcome.data, this.config.maxToolResultChars);
              summary = rendered.summary;
              content = [rendered.text, outcome.warnings?.length ? `WARNINGS: ${outcome.warnings.join(" | ")}` : ""].filter(Boolean).join("\n");
              for (const image of collectImages(outcome.data)) images.push(image);
            } else {
              content = `ERROR ${outcome.error?.code ?? "failed"}: ${outcome.error?.message ?? "unknown error"}${outcome.error?.detail ? `
${JSON.stringify(outcome.error.detail).slice(0, 800)}` : ""}`;
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: content || (ok ? "ok" : "failed") });
          toolLog.push({ step: steps, tool: name, ok, summary: summary.slice(0, 200), duration_ms: durationMs });
          if (definition.danger !== "safe") {
            this.memory.appendHistory({ kind: "tool", summary: `${name}: ${summary}`.slice(0, 300), tool: name, ok, duration_ms: durationMs });
          }
          this.logger.debug(`${name} \u2192 ${ok ? "ok" : "error"} (${durationMs}ms)${summary && ok ? ` \xB7 ${summary.slice(0, 120)}` : ""}`);
        }
        if (images.length) {
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `${images.length === 1 ? "An image" : `${images.length} images`} captured by the tool ${images.length === 1 ? "call" : "calls"} above. Read ${images.length === 1 ? "it" : "them"} critically and continue.`
              },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: image.dataUrl, detail: "high" }
              }))
            ]
          });
        }
        if (finishRequested) break;
      }
      if (steps > this.config.maxSteps && !finishRequested) {
        finalSummary = finalSummary || "Stopped after reaching the step limit.";
        return fail({
          code: "step_limit",
          message: `The agent hit its ${this.config.maxSteps} step limit before finishing. Raise --max-steps or split the task.`
        });
      }
      if (!finalSummary) finalSummary = "Task finished.";
      this.session.notifyAgentStatus({ state: "idle", task_id: options.taskId, label: "done" });
      return {
        ok: true,
        summary: finalSummary,
        verified,
        saved,
        steps,
        tool_calls: toolCalls,
        started_at: started,
        finished_at: Date.now(),
        checkpoints,
        tool_log: toolLog
      };
    } catch (error) {
      const aborted = options.signal?.aborted === true || error?.message === "task cancelled";
      if (aborted) {
        this.session.cancel(void 0, "task aborted");
        this.session.notifyAgentStatus({ state: "idle", task_id: options.taskId, message: "cancelled" });
        return fail({ code: "cancelled", message: "Task cancelled." });
      }
      const message = error.message ?? String(error);
      this.logger.error(`agent run failed: ${message}`);
      this.memory.appendHistory({ kind: "error", summary: message.slice(0, 300), tool: null, ok: false, duration_ms: null });
      this.session.notifyAgentStatus({ state: "error", task_id: options.taskId, message });
      return fail({ code: error instanceof LlmError ? "model_error" : "agent_error", message });
    }
  }
};
function renderResult(data, maxChars) {
  let summary = "";
  const cleaned = stripImageData(data, (note) => {
    summary = summary || note;
  });
  let text;
  try {
    text = JSON.stringify(cleaned, null, 1) ?? "null";
  } catch {
    text = String(cleaned);
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}
\u2026[result truncated at ${maxChars} characters; call an inspection tool with a narrower scope if you need the rest]`;
  }
  if (!summary) summary = describeShape(cleaned);
  return { text, summary };
}
function looksLikeBase64(value) {
  if (/\s/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return new Set(value.slice(0, 1024)).size >= 16;
}
function stripImageData(value, note, key = "") {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      note(`image (${Math.round(value.length / 1024)} KB)`);
      return `[image data: ${Math.round(value.length / 1024)} KB, attached separately]`;
    }
    if (key === "base64" || value.length > 4e3 && looksLikeBase64(value)) {
      note("binary payload");
      return `[${value.length} characters of base64 omitted]`;
    }
    if (value.length > 1200) return `${value.slice(0, 1200)}\u2026`;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 60) {
      return [...value.slice(0, 60).map((entry) => stripImageData(entry, note, key)), `\u2026${value.length - 60} more`];
    }
    return value.map((entry) => stripImageData(entry, note, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      if (entry === void 0) continue;
      out[entryKey] = stripImageData(entry, note, entryKey);
    }
    return out;
  }
  return value;
}
function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length ? `{${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", \u2026" : ""}}` : "empty object";
  }
  return String(value).slice(0, 120);
}
function collectImages(data, limit = 8) {
  const out = [];
  const visit = (value, hint) => {
    if (out.length >= limit || value === null || value === void 0) return;
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) out.push({ label: hint, dataUrl: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, hint || `image ${index + 1}`));
      return;
    }
    if (typeof value === "object") {
      const record = value;
      const label = typeof record.angle === "string" ? record.angle : typeof record.label === "string" ? record.label : typeof record.name === "string" ? record.name : hint;
      for (const [key, entry] of Object.entries(record)) visit(entry, label || key);
    }
  };
  visit(data, "");
  return out;
}
function summariseArgs(args) {
  const parts = [];
  for (const [key, value] of Object.entries(args).slice(0, 4)) {
    if (typeof value === "string") {
      parts.push(value.length > 34 ? `${key}=${value.slice(0, 34)}\u2026` : `${key}=${value}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}[${value.length}]`);
    } else if (value && typeof value === "object") {
      parts.push(`${key}{\u2026}`);
    }
  }
  return parts.join(" ").slice(0, 120);
}

// src/bridge/server.ts
import http from "node:http";
import crypto3 from "node:crypto";
import { URL as URL2 } from "node:url";
var MAX_BODY_BYTES = 32 * 1024 * 1024;
function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`body is not valid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}
async function startBridgeServer(deps) {
  const { config, paths, logger, session, memory, agent } = deps;
  const tasks = /* @__PURE__ */ new Map();
  const briefs = /* @__PURE__ */ new Map();
  const controllers = /* @__PURE__ */ new Map();
  const queue = [];
  let pumping = false;
  let runningTaskId = null;
  const httpServer = http.createServer();
  session.attach(httpServer);
  const isLoopback = (address2) => !address2 || address2 === "127.0.0.1" || address2 === "::1" || address2 === "::ffff:127.0.0.1";
  const authorised = (req, url) => {
    if (config.allowAnonymous) return true;
    const header = req.headers["x-agent-token"];
    const presented = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("token") ?? "";
    const expected = Buffer.from(config.token);
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length) return false;
    return crypto3.timingSafeEqual(expected, actual);
  };
  const briefFor = (projectName) => {
    const state = session.state;
    return {
      prompt: "",
      projectName: projectName ?? state?.project?.project_name ?? null,
      formatId: state?.project?.format_id ?? null,
      savePath: state?.project?.save_path ?? findProjectFile(config.workspace)
    };
  };
  const startTaskInternal = (prompt, provided = {}) => {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      id,
      prompt,
      state: "queued",
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      progress: null,
      tool_log: []
    };
    tasks.set(id, record);
    briefs.set(id, provided);
    queue.push(id);
    logger.info(`task queued: ${id} \u2014 ${prompt.slice(0, 120)}`);
    void pump();
    return record;
  };
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        const record = tasks.get(id);
        if (!record || record.state !== "queued") continue;
        runningTaskId = id;
        const controller = new AbortController();
        controllers.set(id, controller);
        record.state = "running";
        record.started_at = Date.now();
        session.notifyAgentStatus({ state: "running", task_id: id, label: "starting" });
        try {
          const brief = { ...briefFor(briefs.get(id)?.projectName ?? null), ...briefs.get(id), prompt: record.prompt };
          const result = await agent.run({
            brief,
            taskId: id,
            signal: controller.signal,
            onProgress: (progress) => {
              record.progress = progress;
              session.notifyAgentStatus({
                state: "running",
                task_id: id,
                step: progress.step,
                total: progress.total,
                label: progress.label
              });
            },
            onToolCall: ({ tool: tool2, step }) => {
              record.tool_log.push({ tool: tool2, ok: true, summary: `step ${step}` });
              if (record.tool_log.length > 200) record.tool_log.shift();
            }
          });
          record.result = result;
          record.state = result.ok ? "done" : result.error?.code === "cancelled" ? "cancelled" : "error";
          record.error = result.ok ? null : result.error?.message ?? null;
          session.notifyAgentResult({
            request_id: id,
            ok: result.ok,
            summary: result.summary,
            steps: result.steps,
            tool_calls: result.tool_calls,
            error: result.ok ? void 0 : { code: result.error?.code ?? "error", message: result.error?.message ?? "failed" }
          });
          session.notifyAgentStatus({ state: "idle", task_id: id, label: result.ok ? "done" : "failed" });
          logger.info(`task ${id} ${record.state} in ${result.steps} steps (${result.tool_calls} tool calls)`);
        } catch (error) {
          record.state = "error";
          record.error = error.message;
          session.notifyAgentStatus({ state: "error", task_id: id, message: record.error });
          logger.error(`task ${id} crashed: ${record.error}`);
        } finally {
          record.finished_at = Date.now();
          record.progress = null;
          controllers.delete(id);
          briefs.delete(id);
          runningTaskId = null;
        }
      }
    } finally {
      pumping = false;
    }
  };
  const describeTask = (record) => ({
    id: record.id,
    state: record.state,
    prompt: record.prompt,
    started_at: record.started_at,
    finished_at: record.finished_at,
    duration_ms: record.started_at && record.finished_at ? record.finished_at - record.started_at : null,
    progress: record.progress,
    summary: record.result?.summary ?? null,
    verified: record.result?.verified ?? null,
    saved: record.result?.saved ?? null,
    steps: record.result?.steps ?? null,
    tool_calls: record.result?.tool_calls ?? null,
    checkpoints: record.result?.checkpoints ?? [],
    tool_log: record.result?.tool_log ?? record.tool_log,
    error: record.error
  });
  session.on(
    SESSION_EVENTS.task,
    (payload) => {
      const record = startTaskInternal(payload.prompt, {
        projectName: payload.context?.project_name ?? null,
        formatId: payload.context?.format_id ?? null,
        savePath: payload.context?.save_path ?? null
      });
      logger.info(`task ${record.id} started from the Blockbench panel`);
    }
  );
  session.on(SESSION_EVENTS.taskStop, () => {
    if (runningTaskId) {
      controllers.get(runningTaskId)?.abort();
      logger.info(`task ${runningTaskId} cancelled from the panel`);
    }
  });
  httpServer.on("request", (req, res) => {
    void (async () => {
      const url = new URL2(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const path8 = url.pathname.replace(/\/+$/, "") || "/";
      const remote = req.socket.remoteAddress;
      if (!isLoopback(remote)) {
        json(res, 403, { error: "this bridge only serves loopback clients", remote });
        return;
      }
      if (!isTrustedOrigin(req.headers.origin)) {
        logger.warn(`refusing ${req.method} ${path8} from origin ${describeOrigin(req.headers.origin)}`);
        json(res, 403, { error: "origin not allowed", origin: describeOrigin(req.headers.origin) });
        return;
      }
      if (path8 === "/health" || path8 === "/") {
        json(res, 200, {
          service: "blockbench-ai-agent-bridge",
          protocol: PROTOCOL_VERSION,
          plugin_connected: session.connected,
          auth_required: !config.allowAnonymous,
          model: agent.model,
          state_revision: session.revision,
          running_task: runningTaskId,
          queued: queue.length,
          uptime_s: Math.round(process.uptime())
        });
        return;
      }
      if (!authorised(req, url)) {
        json(res, 401, { error: "missing or invalid token \u2014 send x-agent-token or ?token=" });
        return;
      }
      try {
        if (path8 === "/state" && req.method === "GET") {
          json(res, 200, { state: session.state, revision: session.revision, connected: session.connected });
          return;
        }
        if (path8 === "/capabilities" && req.method === "GET") {
          json(res, 200, { capabilities: session.capabilities, connected: session.connected });
          return;
        }
        if (path8 === "/tools" && req.method === "GET") {
          const pluginTools = session.cachedTools();
          const local = agent.localDefinitions();
          json(res, 200, {
            source: session.connected ? "live" : "cache",
            count: pluginTools.length + local.length,
            plugin: pluginTools,
            bridge: local
          });
          return;
        }
        if (path8 === "/memory" && req.method === "GET") {
          json(res, 200, memory.snapshot());
          return;
        }
        if (path8 === "/references" && req.method === "GET") {
          json(res, 200, {
            directory: paths.references,
            references: memory.listReferences().map(({ base64: _base64, ...rest }) => rest)
          });
          return;
        }
        if (path8 === "/checkpoints" && req.method === "GET") {
          json(res, 200, { checkpoints: memory.listCheckpoints() });
          return;
        }
        if (path8 === "/checkpoints" && req.method === "POST") {
          const body = await readBody(req);
          const record = await session.checkpoint(body.label ?? "checkpoint via REST", true);
          storeCheckpoint(memory, record);
          json(res, 200, record);
          return;
        }
        if (path8 === "/rollback" && req.method === "POST") {
          const body = await readBody(req);
          const list = memory.listCheckpoints();
          const target = body.checkpoint_id ?? list[list.length - 1]?.checkpoint_id;
          if (!target) {
            json(res, 400, { error: "no checkpoint to restore" });
            return;
          }
          const outcome = await session.rollback(target);
          json(res, outcome.ok ? 200 : 500, outcome);
          return;
        }
        if (path8 === "/logs" && req.method === "GET") {
          json(res, 200, { lines: logger.recent(Number(url.searchParams.get("limit") ?? 200)) });
          return;
        }
        if (path8.startsWith("/tool/")) {
          const name = decodeURIComponent(path8.slice("/tool/".length));
          const args = req.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : await readBody(req);
          const started = Date.now();
          const outcome = await session.callTool(name, args ?? {}, {
            taskId: "rest",
            timeoutMs: Number(url.searchParams.get("timeout") ?? 12e4)
          });
          json(res, outcome.ok ? 200 : 400, { ...outcome, tool: name, wall_ms: Date.now() - started });
          return;
        }
        if (path8 === "/task" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.prompt || !body.prompt.trim()) {
            json(res, 400, { error: "prompt is required" });
            return;
          }
          const wait = body.wait === true || body.wait === 1 || body.wait === "1" || url.searchParams.get("wait") === "1" || url.searchParams.get("wait") === "true";
          const record = startTaskInternal(body.prompt, {
            projectName: body.project_name ?? null,
            formatId: body.format_id ?? null,
            savePath: body.save_path ?? null
          });
          if (wait) {
            await new Promise((resolve) => {
              const timer = setInterval(() => {
                const current = tasks.get(record.id);
                if (!current || current.state === "done" || current.state === "error" || current.state === "cancelled") {
                  clearInterval(timer);
                  resolve();
                }
              }, 500);
              const budget = Number(url.searchParams.get("wait_ms") ?? body.wait_ms ?? 9e5);
              setTimeout(() => {
                clearInterval(timer);
                resolve();
              }, budget);
            });
            json(res, 200, describeTask(tasks.get(record.id)));
            return;
          }
          json(res, 202, describeTask(record));
          return;
        }
        if (path8.startsWith("/task/")) {
          const rest = path8.slice("/task/".length).split("/").filter(Boolean);
          const record = tasks.get(decodeURIComponent(rest[0]));
          if (!record) {
            json(res, 404, { error: `unknown task "${rest[0]}"` });
            return;
          }
          if (rest[1] === "stop" && req.method === "POST") {
            controllers.get(record.id)?.abort();
            json(res, 200, describeTask(record));
            return;
          }
          json(res, 200, describeTask(record));
          return;
        }
        if (path8 === "/tasks" && req.method === "GET") {
          json(res, 200, { tasks: [...tasks.values()].slice(-25).map(describeTask) });
          return;
        }
        json(res, 404, { error: `no route for ${req.method} ${path8}` });
      } catch (error) {
        const message = error.message;
        logger.warn(`REST ${req.method} ${path8} failed: ${message}`);
        json(res, statusFor(message), { error: message });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const port = address?.port ?? config.port;
  logger.info(`bridge listening on http://${config.host}:${port} (plugin socket: ws://${config.host}:${port}/plugin)`);
  logger.info(
    config.allowAnonymous ? "authentication: anonymous (loopback + Origin checked) \u2014 paste the URL above into the Blockbench panel" : "authentication: token required"
  );
  return {
    server: httpServer,
    port,
    url: `http://${config.host}:${port}`,
    tasks,
    async startTask(prompt, brief = {}) {
      return startTaskInternal(prompt, brief);
    },
    stopTask(taskId) {
      const target = taskId ?? runningTaskId;
      if (!target) return false;
      controllers.get(target)?.abort();
      return true;
    },
    close: () => new Promise((resolve) => {
      for (const controller of controllers.values()) controller.abort();
      session.stop();
      httpServer.close(() => resolve());
    })
  };
}
function statusFor(message) {
  if (/unknown tool|invalid|required|must be/i.test(message)) return 400;
  if (/not connected/i.test(message)) return 503;
  return 500;
}

// src/bridge/mcp.ts
var PROTOCOL_VERSION2 = "2024-11-05";
function toMcpTool(definition) {
  return {
    name: definition.name,
    description: `${definition.title} \u2014 ${definition.description}

Returns: ${definition.returns}`,
    inputSchema: definition.schema,
    annotations: {
      title: definition.title,
      readOnlyHint: definition.danger === "safe",
      destructiveHint: definition.danger === "destructive"
    }
  };
}
function startMcpServer(deps) {
  const { session, agent, logger } = deps;
  const options = deps.options ?? {};
  let initialised = false;
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}
`);
  };
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message, data) => write({ jsonrpc: "2.0", id, error: { code, message, data } });
  const catalog = () => {
    const tools = [...session.cachedTools(), ...agent.localDefinitions()];
    if (!options.readOnly) return tools;
    return tools.filter((definition) => definition.danger === "safe");
  };
  const bridge = {
    async handle(line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        fail(null, -32700, `parse error: ${error.message}`);
        return null;
      }
      if (request.id === void 0) {
        if (request.method === "notifications/initialized") initialised = true;
        return null;
      }
      switch (request.method) {
        case "initialize": {
          respond(request.id, {
            protocolVersion: PROTOCOL_VERSION2,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? "blockbench-ai-agent-bridge", version: "0.1.0" },
            instructions: session.connected ? `Connected to Blockbench ${session.capabilities?.blockbench_version ?? "?"} (format: ${session.capabilities?.active_format ?? "none"}). Call inspect_project first: it returns the live workspace state. Mutating tools take a checkpoint automatically where it matters.${options.readOnly ? " This server is in read-only mode: only safe tools are exposed." : ""}` : "The Blockbench plugin is NOT connected. Start Blockbench with the AI Agent plugin enabled and press Connect, then retry."
          });
          return null;
        }
        case "ping":
          respond(request.id, {});
          return null;
        case "tools/list":
          respond(request.id, { tools: catalog().map(toMcpTool) });
          return null;
        case "resources/list":
          respond(request.id, {
            resources: [
              {
                uri: "blockbench://state",
                name: "Blockbench workspace state",
                description: "Live project, hierarchy, animation and viewport state",
                mimeType: "application/json"
              }
            ]
          });
          return null;
        case "resources/read": {
          const uri = String(request.params?.uri ?? "");
          if (uri !== "blockbench://state") {
            fail(request.id, -32602, `unknown resource ${uri}`);
            return null;
          }
          respond(request.id, {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(session.state ?? { connected: false, reason: "plugin not connected" }, null, 2)
              }
            ]
          });
          return null;
        }
        case "tools/call": {
          const name = String(request.params?.name ?? "");
          const args = request.params?.arguments ?? {};
          const definition = catalog().find((tool2) => tool2.name === name);
          if (!definition) {
            respond(request.id, {
              isError: true,
              content: [{ type: "text", text: `Unknown tool "${name}". Available: ${catalog().map((tool2) => tool2.name).join(", ")}` }]
            });
            return null;
          }
          const local = agent.localDefinitions().some((tool2) => tool2.name === name);
          logger.debug(`MCP tools/call ${name}${local ? " (bridge tool)" : ""}`);
          if (local) {
            respond(request.id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `"${name}" is a bridge-internal tool (memory, contact sheets, task control). Use the bridge REST API (POST /task) or the Blockbench panel for those; MCP exposes the Blockbench tool registry.`
                }
              ]
            });
            return null;
          }
          const outcome = await session.callTool(name, args, { taskId: "mcp", timeoutMs: 18e4 });
          respond(request.id, {
            isError: !outcome.ok,
            content: [
              {
                type: "text",
                text: outcome.ok ? JSON.stringify(outcome.data, null, 2) : `ERROR ${outcome.error?.code ?? "failed"}: ${outcome.error?.message ?? "unknown error"}`
              },
              ...outcome.warnings?.length ? [{ type: "text", text: `WARNINGS: ${outcome.warnings.join(" | ")}` }] : []
            ],
            structuredContent: outcome.ok ? { data: outcome.data, verified: outcome.verified ?? false } : void 0
          });
          return null;
        }
        default:
          fail(request.id, -32601, `method not found: ${request.method}`);
          return null;
      }
    },
    stop() {
      logger.debug("MCP server stopping");
    }
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      void bridge.handle(line).catch((error) => logger.error(`MCP handler failed: ${error.message}`));
    }
  });
  process.stdin.on("end", () => bridge.stop());
  return bridge;
}

// src/bridge/installer.ts
import fs5 from "node:fs";
import os2 from "node:os";
import path5 from "node:path";
import crypto4 from "node:crypto";
var PLUGIN_BUNDLE_NAME = "blockbench-ai-agent.js";
function defaultPluginDir2() {
  if (process.env.BLOCKBENCH_PLUGIN_DIR) return process.env.BLOCKBENCH_PLUGIN_DIR;
  if (process.env.BLOCKBENCH_DIR) {
    const base = process.env.BLOCKBENCH_DIR;
    return /Blockbench$/.test(base) && path5.basename(path5.dirname(base)) === "Blockbench" ? path5.join(base, "plugins") : path5.join(base, "plugins");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path5.join(os2.homedir(), "AppData", "Roaming");
    return path5.join(appData, "Blockbench", "plugins");
  }
  if (process.platform === "darwin") {
    return path5.join(os2.homedir(), "Library", "Application Support", "Blockbench", "plugins");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path5.join(os2.homedir(), ".config");
  return path5.join(xdg, "Blockbench", "plugins");
}
function findBundle(explicit) {
  const candidates = [
    explicit,
    process.env.BLOCKBENCH_AI_PLUGIN_BUNDLE,
    path5.join(process.cwd(), "dist", PLUGIN_BUNDLE_NAME),
    path5.join(process.cwd(), "blockbench-ai-agent.js"),
    path5.join(path5.dirname(process.execPath), "dist", PLUGIN_BUNDLE_NAME)
  ].filter((entry) => typeof entry === "string" && entry.length > 0);
  for (const candidate of candidates) {
    try {
      if (fs5.existsSync(candidate) && fs5.statSync(candidate).size > 0) return candidate;
    } catch {
    }
  }
  return null;
}
function hashFile(file) {
  return crypto4.createHash("sha256").update(fs5.readFileSync(file)).digest("hex");
}
function installPlugin(config, logger, options = {}) {
  const pluginDir = options.dir ?? config.blockbenchPluginDir ?? defaultPluginDir2();
  const source = findBundle(options.bundle);
  const instructions = [
    `1. Open Blockbench.`,
    `2. File \u2192 Plugins\u2026 \u2192 "Load Plugin from File" and pick:`,
    `     ${path5.join(pluginDir, PLUGIN_BUNDLE_NAME)}`,
    `3. The plugin registers as "AI Agent" and stays installed permanently \u2014 Blockbench`,
    `   remembers the file path and re-loads it on every start.`,
    `4. Start the bridge:   npm run bridge      (or: node dist/agent-bridge.js --serve)`,
    `5. In the AI Agent panel, click Connect. If the bridge printed a token, paste the full`,
    `   ws:// URL including ?token=\u2026 into the Bridge URL field.`
  ];
  if (!source) {
    return {
      installed: false,
      pluginDir,
      target: null,
      source: "",
      bytes: 0,
      sha256: "",
      alreadyPresent: false,
      pluginDirExisted: fs5.existsSync(pluginDir),
      instructions,
      reason: `the plugin bundle was not found. Run "npm run build" first (expected dist/${PLUGIN_BUNDLE_NAME}).`
    };
  }
  const target = path5.join(pluginDir, PLUGIN_BUNDLE_NAME);
  const sha256 = hashFile(source);
  const bytes = fs5.statSync(source).size;
  let alreadyPresent = false;
  try {
    alreadyPresent = fs5.existsSync(target) && hashFile(target) === sha256;
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
      instructions
    };
  }
  try {
    fs5.mkdirSync(pluginDir, { recursive: true });
    const temp = `${target}.tmp-${Date.now()}`;
    fs5.copyFileSync(source, temp);
    fs5.renameSync(temp, target);
  } catch (error) {
    return {
      installed: false,
      pluginDir,
      target,
      source,
      bytes,
      sha256,
      alreadyPresent: false,
      pluginDirExisted: fs5.existsSync(pluginDir),
      instructions,
      reason: `could not write to ${pluginDir}: ${error.message}`
    };
  }
  logger.info(`plugin installed: ${target} (${Math.round(bytes / 1024)} KB, sha256 ${sha256.slice(0, 12)}\u2026)`);
  return {
    installed: true,
    pluginDir,
    target,
    source,
    bytes,
    sha256,
    alreadyPresent: false,
    pluginDirExisted: true,
    instructions
  };
}

// src/bridge/doctor.ts
import fs6 from "node:fs";
import net from "node:net";
import os3 from "node:os";
import path6 from "node:path";
import { createRequire } from "node:module";
function readAsarFile(asarPath, innerPath) {
  let fd = null;
  try {
    fd = fs6.openSync(asarPath, "r");
    const sizeBuf = Buffer.alloc(8);
    if (fs6.readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null;
    const headerSize = sizeBuf.readUInt32LE(4);
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) return null;
    const headerBuf = Buffer.alloc(headerSize);
    if (fs6.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null;
    const text = headerBuf.toString("utf8");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const header = JSON.parse(text.slice(start, end + 1));
    let entry = { files: header.files };
    for (const part of innerPath.split("/")) {
      entry = entry?.files?.[part];
      if (!entry) return null;
    }
    if (entry.size === void 0 || entry.offset === void 0) return null;
    const offset = 8 + headerSize + Number(entry.offset);
    const out = Buffer.alloc(Number(entry.size));
    fs6.readSync(fd, out, 0, out.length, offset);
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs6.closeSync(fd);
      } catch {
      }
    }
  }
}
function findBlockbenchInstall() {
  const candidates = [];
  if (process.env.BLOCKBENCH_DIR) {
    candidates.push(process.env.BLOCKBENCH_DIR);
    candidates.push(path6.join(process.env.BLOCKBENCH_DIR, "resources", "app.asar"));
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path6.join(os3.homedir(), "AppData", "Local");
    candidates.push(path6.join(local, "Programs", "Blockbench"));
    candidates.push(path6.join(local, "Blockbench"));
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(path6.join(programFiles, "Blockbench"));
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Blockbench.app/Contents/Resources");
    candidates.push(path6.join(os3.homedir(), "Applications", "Blockbench.app", "Contents", "Resources"));
  } else {
    candidates.push("/opt/Blockbench", "/usr/lib/blockbench", path6.join(os3.homedir(), "Blockbench"));
  }
  for (const candidate of candidates) {
    const asarPaths = [
      path6.join(candidate, "resources", "app.asar"),
      path6.join(candidate, "app.asar"),
      candidate.endsWith("app.asar") ? candidate : ""
    ].filter((entry) => entry.length > 0);
    for (const asar of asarPaths) {
      if (!fs6.existsSync(asar)) continue;
      const raw = readAsarFile(asar, "package.json");
      let version = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          version = parsed.version ?? null;
        } catch {
          version = null;
        }
      }
      const appDir = path6.basename(path6.dirname(asar)) === "resources" ? path6.dirname(path6.dirname(asar)) : path6.dirname(asar);
      return { appDir, asar, version, derivedFrom: candidate };
    }
  }
  return null;
}
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) return { name: "node runtime", status: "ok", detail: `Node ${process.versions.node} on ${os3.platform()}` };
  if (major >= 18) return { name: "node runtime", status: "warn", detail: `Node ${process.versions.node}`, hint: "Node 20 or newer is recommended (global fetch and modern ws)." };
  return { name: "node runtime", status: "fail", detail: `Node ${process.versions.node}`, hint: "Install Node 20 or newer." };
}
function checkDependencies(logger) {
  const require2 = createRequire(import.meta.url);
  const missing = [];
  for (const dependency of ["ws", "pngjs"]) {
    try {
      require2.resolve(dependency);
    } catch {
      missing.push(dependency);
    }
  }
  if (!missing.length) return { name: "dependencies", status: "ok", detail: "ws and pngjs resolve" };
  return {
    name: "dependencies",
    status: "fail",
    detail: `missing: ${missing.join(", ")}`,
    hint: 'Run "npm install" in the plugin folder before building the bridge.'
  };
}
function checkBundle() {
  const bundle = findBundle();
  if (!bundle) {
    return {
      name: "plugin bundle",
      status: "fail",
      detail: "dist/blockbench-ai-agent.js not found",
      hint: 'Run "npm run build".'
    };
  }
  const bytes = fs6.statSync(bundle).size;
  return { name: "plugin bundle", status: "ok", detail: `${bundle} (${Math.round(bytes / 1024)} KB, ${hashFile(bundle).slice(0, 12)}\u2026)` };
}
function checkBlockbench() {
  const install = findBlockbenchInstall();
  if (!install) {
    return {
      check: {
        name: "blockbench install",
        status: "warn",
        detail: "not found in the standard locations",
        hint: "Set BLOCKBENCH_DIR to the program folder if the app lives somewhere unusual. The bridge works regardless of where the app is installed."
      },
      install: null
    };
  }
  return {
    check: {
      name: "blockbench install",
      status: "ok",
      detail: `version ${install.version ?? "unknown"} \xB7 ${install.asar}`
    },
    install
  };
}
function checkPluginFolder(config, logger, forceReinstall) {
  const result = installPlugin(config, logger, { force: forceReinstall });
  if (!result.installed && result.reason) {
    return {
      name: "plugin folder",
      status: "fail",
      detail: `${result.pluginDir} \u2014 ${result.reason}`,
      hint: 'Run "npm run build" and then "npm run install-plugin".'
    };
  }
  if (result.alreadyPresent) {
    return { name: "plugin folder", status: "ok", detail: `${result.target} is current (sha256 ${result.sha256.slice(0, 12)}\u2026)` };
  }
  return {
    name: "plugin folder",
    status: "ok",
    detail: `copied ${Math.round(result.bytes / 1024)} KB to ${result.target}`,
    hint: 'Load it once in Blockbench via File \u2192 Plugins\u2026 \u2192 "Load Plugin from File"; it is permanent after that.'
  };
}
function checkPort(config) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve({
          name: "bridge port",
          status: "warn",
          detail: `${config.host}:${config.port} is already in use`,
          hint: "Another bridge is probably running. Stop it or pass --port."
        });
      } else {
        resolve({ name: "bridge port", status: "warn", detail: `${config.host}:${config.port} \u2014 ${error.message}` });
      }
    });
    server.once("listening", () => {
      server.close(() => resolve({ name: "bridge port", status: "ok", detail: `${config.host}:${config.port} is free` }));
    });
    server.listen(config.port, config.host);
  });
}
async function checkModel(config) {
  if (config.provider === "none") {
    return { name: "model endpoint", status: "warn", detail: 'provider is "none"', hint: "Set --provider, --base-url and --model (or the AI_AGENT_* / OPENAI_* variables) before asking the agent to build anything." };
  }
  if (!config.apiKey && /api\.openai\.com/.test(config.baseUrl)) {
    return {
      name: "model endpoint",
      status: "fail",
      detail: "OPENAI_API_KEY is not set",
      hint: "Export OPENAI_API_KEY, or point --base-url at a local server (Ollama, LM Studio, vLLM)."
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4e3);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: controller.signal
    });
    if (response.ok) {
      return { name: "model endpoint", status: "ok", detail: `${config.baseUrl} reachable \xB7 model ${config.model}` };
    }
    return {
      name: "model endpoint",
      status: "warn",
      detail: `${config.baseUrl} answered HTTP ${response.status}`,
      hint: "The endpoint answered but rejected the request \u2014 check the API key and that it is OpenAI compatible (/chat/completions)."
    };
  } catch (error) {
    const message = error.name === "AbortError" ? "timed out" : error.message;
    return {
      name: "model endpoint",
      status: "warn",
      detail: `${config.baseUrl} \u2014 ${message}`,
      hint: "The bridge still runs and still exposes tools; only autonomous tasks need the model."
    };
  } finally {
    clearTimeout(timer);
  }
}
function checkWorkspace(config, paths, memory) {
  const project = findProjectFile(config.workspace);
  const references = memory.listReferences();
  const parts = [`${references.length} reference image(s)`, project ? `project file ${path6.basename(project)}` : "no .bbmodel in the workspace yet"];
  return {
    name: "workspace",
    status: config.workspace && fs6.existsSync(paths.context) ? "ok" : "warn",
    detail: `${config.workspace} \xB7 ${parts.join(" \xB7 ")}`,
    hint: references.length ? void 0 : `Drop reference images into ${paths.references} to give the agent visual guidance.`
  };
}
function checkSession(session) {
  if (session.connected && session.capabilities) {
    const capabilities = session.capabilities;
    return {
      name: "plugin link",
      status: "ok",
      detail: `connected \xB7 Blockbench ${capabilities.blockbench_version} \xB7 format ${capabilities.active_format ?? "none"} \xB7 ${session.cachedTools().length} tools`
    };
  }
  return {
    name: "plugin link",
    status: "warn",
    detail: "no plugin connected right now",
    hint: "Start the bridge with --serve, open Blockbench, press Connect in the AI Agent panel."
  };
}
async function runDoctor(deps) {
  const { config, paths, logger } = deps;
  const install = checkBlockbench();
  const checks = [
    checkNode(),
    checkDependencies(logger),
    checkBundle(),
    install.check,
    checkPluginFolder(config, logger, deps.forceReinstall ?? false),
    await checkPort(config),
    await checkModel(config)
  ];
  if (deps.memory) checks.push(checkWorkspace(config, paths, deps.memory));
  if (deps.session) checks.push(checkSession(deps.session));
  const ok = checks.filter((entry) => entry.status === "ok").length;
  const warn = checks.filter((entry) => entry.status === "warn").length;
  const fail = checks.filter((entry) => entry.status === "fail").length;
  const verdict = fail > 0 ? "not ready \u2014 fix the failing checks below" : warn > 0 ? "usable, with caveats" : "ready";
  return { checks, summary: { ok, warn, fail, verdict }, workspace: paths };
}
function formatDoctorReport(report) {
  const icon = { ok: "\u2714", warn: "!", fail: "\u2716" };
  const lines = ["Blockbench AI Agent \u2014 doctor", ""];
  for (const check of report.checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.hint) lines.push(`    \u2192 ${check.hint}`);
  }
  lines.push("", `${report.summary.ok} ok \xB7 ${report.summary.warn} warnings \xB7 ${report.summary.fail} failures \u2014 ${report.summary.verdict}`);
  return lines.join("\n");
}

// src/bridge/index.ts
var DEFAULT_ANGLES = ["view", "north", "east", "top", "isometric_right"];
async function main() {
  let parsed;
  try {
    parsed = resolveConfig();
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const { config, flags } = parsed;
  if (flags.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  const logger = new Logger("bridge");
  logger.setLevel(config.logLevel);
  const paths = ensureWorkspace(config);
  logger.attachFile(config.logFile ?? path7.join(paths.context, "bridge.log"));
  logger.info("bridge starting", describeForLog(config));
  const memory = new MemoryStore(paths, logger);
  const session = new PluginSession(config, logger);
  const agent = new Agent(
    session,
    memory,
    {
      maxSteps: config.maxSteps,
      enableVision: config.enableVision,
      workspace: config.workspace,
      defaultAngles: DEFAULT_ANGLES,
      maxToolResultChars: 12e3
    },
    { viewport: paths.viewport, textures: paths.textures },
    {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      extraHeaders: config.extraHeaders,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs
    },
    logger
  );
  if (flags.installPlugin) {
    const result = installPlugin(config, logger);
    if (!result.installed) {
      console.error(`\u2716 ${result.reason}`);
      return 1;
    }
    console.log(`\u2714 plugin ${result.alreadyPresent ? "already current" : "installed"} at ${result.target}`);
    console.log(
      result.alreadyPresent ? `  It is already in Blockbench's plugins folder; if it is not loading, use File \u2192 Plugins\u2026 \u2192 "Load Plugin from File" once.` : '  Next: open Blockbench, then File \u2192 Plugins\u2026 \u2192 "Load Plugin from File" and pick that path. It stays installed after that.'
    );
    return 0;
  }
  if (flags.doctor) {
    const report = await runDoctor({ config, paths, logger, session, memory, forceReinstall: false });
    console.log(formatDoctorReport(report));
    const url2 = `ws://${config.host}:${config.port}/plugin${config.allowAnonymous ? "" : `?token=${config.token}`}`;
    console.log(`
Plugin Bridge URL: ${url2}`);
    return report.summary.fail > 0 ? 1 : 0;
  }
  if (flags.tool) {
    let args = {};
    if (flags.toolArgs) {
      try {
        args = JSON.parse(flags.toolArgs);
      } catch (error) {
        console.error(`--args must be JSON: ${error.message}`);
        return 2;
      }
    }
    const server2 = await startBridgeServer({ config, paths, logger, session, memory, agent });
    const connected = await waitForPlugin(session, 12e3);
    if (!connected) {
      console.error("The Blockbench plugin did not connect within 12s. Open Blockbench with the AI Agent plugin enabled, then try again.");
      await server2.close();
      return 1;
    }
    const outcome = await session.callTool(flags.tool, args, { taskId: "cli", timeoutMs: 18e4 });
    console.log(JSON.stringify(outcome, null, 2));
    await server2.close();
    return outcome.ok ? 0 : 1;
  }
  if (flags.task) {
    const server2 = await startBridgeServer({ config, paths, logger, session, memory, agent });
    const connected = await waitForPlugin(session, 2e4);
    if (!connected) {
      console.error("The Blockbench plugin did not connect within 20s. Start Blockbench first.");
      await server2.close();
      return 1;
    }
    console.log(`\u25B8 task: ${flags.task}`);
    const record = await server2.startTask(flags.task);
    const result = await waitForTask(server2.tasks, record.id, (label) => process2.stdout.write(`\r  ${label.padEnd(78).slice(0, 78)}`));
    process2.stdout.write("\n");
    if (result?.result) {
      console.log(`
${result.result.ok ? "\u2714" : "\u2716"} ${result.result.summary}`);
      console.log(
        `  ${result.result.steps} steps \xB7 ${result.result.tool_calls} tool calls \xB7 ${result.result.checkpoints.length} checkpoints \xB7 verified=${result.result.verified} \xB7 saved=${result.result.saved}`
      );
      if (result.error) console.error(`  error: ${result.error}`);
    } else {
      console.error(result?.error ?? "task produced no result");
    }
    await server2.close();
    return result?.state === "done" ? 0 : 1;
  }
  if (flags.mcp) {
    const serverless = new Logger("mcp");
    serverless.setLevel("warn");
    serverless.attachFile(config.logFile ?? path7.join(paths.context, "bridge.log"));
    startMcpServer({ session, agent, logger: serverless, options: { readOnly: false } });
    const server2 = await startBridgeServer({ config, paths, logger: serverless, session, memory, agent });
    serverless.warn(`MCP mode: waiting for the plugin on ws://${config.host}:${server2.port}/plugin`);
    process2.stdin.on("end", () => {
      void server2.close().then(() => process2.exit(0));
    });
    return await new Promise(() => {
    });
  }
  const server = await startBridgeServer({ config, paths, logger, session, memory, agent });
  const url = `ws://${config.host}:${server.port}/plugin${config.allowAnonymous ? "" : `?token=${config.token}`}`;
  session.on(SESSION_EVENTS.status, (payload) => {
    if (payload.status === "connected") logger.info("plugin link established \u2014 the agent can build now");
    if (payload.status === "disconnected") logger.warn("plugin link lost \u2014 the bridge keeps running and will reconnect");
  });
  console.log("");
  console.log("\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
  console.log("\u2502  Blockbench AI Agent \u2014 bridge is running                             \u2502");
  console.log("\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
  console.log(`  REST + state :  ${server.url}`);
  console.log(`  Plugin socket:  ${url}`);
  console.log(`  Workspace    :  ${config.workspace}`);
  console.log(`  Model        :  ${config.provider === "none" ? "(none configured \u2014 tools still work)" : `${config.model} via ${config.baseUrl}`}`);
  console.log(`  Vision       :  ${config.enableVision ? "on" : "off"}`);
  console.log("");
  console.log("  In Blockbench: AI Agent panel \u2192 paste the Plugin socket URL above into");
  console.log('  "Bridge URL" (it already includes the token) \u2192 press Connect.');
  console.log("");
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    await server.close();
    logger.close();
    process2.exit(0);
  };
  process2.on("SIGINT", () => void shutdown("SIGINT"));
  process2.on("SIGTERM", () => void shutdown("SIGTERM"));
  process2.on("unhandledRejection", (reason) => logger.error(`unhandled rejection: ${String(reason)}`));
  return await new Promise(() => {
  });
}
async function waitForPlugin(session, timeoutMs) {
  if (session.connected) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.off(SESSION_EVENTS.status, onStatus);
      resolve(false);
    }, timeoutMs);
    const onStatus = (payload) => {
      if (payload.status === "connected") {
        clearTimeout(timer);
        session.off(SESSION_EVENTS.status, onStatus);
        resolve(true);
      }
    };
    session.on(SESSION_EVENTS.status, onStatus);
  });
}
async function waitForTask(tasks, id, onTick) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const record = tasks.get(id);
      if (!record) return;
      if (record.progress) onTick(record.progress.label);
      if (record.state === "done" || record.state === "error" || record.state === "cancelled") {
        clearInterval(timer);
        resolve({
          state: record.state,
          result: record.result,
          error: record.error
        });
      }
    }, 250);
  });
}
main().then((code) => {
  if (code !== 0 && Number.isFinite(code)) process2.exitCode = code;
}).catch((error) => {
  console.error(`bridge crashed: ${error.stack ?? String(error)}`);
  process2.exitCode = 1;
});
