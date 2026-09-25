/**
 * Bridge server: one loopback HTTP server that carries the plugin WebSocket, a REST
 * API, and the agent task queue.
 *
 * Why one port: the plugin connects over `upgrade` on `/plugin`, everything else is
 * plain JSON. That means a single `--port` to forward through a tunnel if someone ever
 * wants to drive Blockbench from another machine, and a single thing to audit.
 *
 * Task execution is serialised on purpose. Two agent runs writing to the same model
 * would interleave undo edits and produce a project neither of them planned.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { CapabilityReport, PluginStateSnapshot } from '../shared/protocol.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import type { BridgeConfig, WorkspacePaths } from './config.js';
import { findProjectFile } from './config.js';
import type { Logger } from './log.js';
import type { MemoryStore } from './memory.js';
import { PluginSession, SESSION_EVENTS } from './session.js';
import { describeOrigin, isTrustedOrigin } from './origin.js';
import { Agent, type AgentBrief, type AgentRunResult } from './agent.js';
import { storeCheckpoint } from './local-tools.js';

export interface TaskRecord {
  id: string;
  prompt: string;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'error';
  started_at: number | null;
  finished_at: number | null;
  result: AgentRunResult | null;
  error: string | null;
  progress: { step: number; total: number; label: string } | null;
  tool_log: Array<{ tool: string; ok: boolean; summary: string }>;
}

export interface ServerDeps {
  config: BridgeConfig;
  paths: WorkspacePaths;
  logger: Logger;
  session: PluginSession;
  memory: MemoryStore;
  agent: Agent;
}

export interface BridgeServer {
  server: http.Server;
  port: number;
  url: string;
  tasks: Map<string, TaskRecord>;
  startTask(prompt: string, brief?: Partial<AgentBrief>): Promise<TaskRecord>;
  stopTask(taskId?: string): boolean;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (error) {
        reject(new Error(`body is not valid JSON: ${(error as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

export async function startBridgeServer(deps: ServerDeps): Promise<BridgeServer> {
  const { config, paths, logger, session, memory, agent } = deps;
  const tasks = new Map<string, TaskRecord>();
  const briefs = new Map<string, Partial<AgentBrief>>();
  const controllers = new Map<string, AbortController>();
  const queue: string[] = [];
  let pumping = false;
  let runningTaskId: string | null = null;

  const httpServer = http.createServer();
  session.attach(httpServer);

  const isLoopback = (address: string | undefined): boolean =>
    !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

  const authorised = (req: http.IncomingMessage, url: URL): boolean => {
    if (config.allowAnonymous) return true;
    const header = req.headers['x-agent-token'];
    const presented = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
    const expected = Buffer.from(config.token);
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  };

  const briefFor = (projectName?: string | null): AgentBrief => {
    const state = session.state;
    return {
      prompt: '',
      projectName: projectName ?? state?.project?.project_name ?? null,
      formatId: state?.project?.format_id ?? null,
      savePath: state?.project?.save_path ?? findProjectFile(config.workspace),
    };
  };

  const startTaskInternal = (prompt: string, provided: Partial<AgentBrief> = {}): TaskRecord => {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const record: TaskRecord = {
      id,
      prompt,
      state: 'queued',
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      progress: null,
      tool_log: [],
    };
    tasks.set(id, record);
    briefs.set(id, provided);
    queue.push(id);
    logger.info(`task queued: ${id} — ${prompt.slice(0, 120)}`);
    void pump();
    return record;
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const id = queue.shift()!;
        const record = tasks.get(id);
        if (!record || record.state !== 'queued') continue;
        runningTaskId = id;
        const controller = new AbortController();
        controllers.set(id, controller);
        record.state = 'running';
        record.started_at = Date.now();
        session.notifyAgentStatus({ state: 'running', task_id: id, label: 'starting' });
        try {
          const brief = { ...briefFor(briefs.get(id)?.projectName ?? null), ...briefs.get(id), prompt: record.prompt } as AgentBrief;
          const result = await agent.run({
            brief,
            taskId: id,
            signal: controller.signal,
            onProgress: (progress) => {
              record.progress = progress;
              session.notifyAgentStatus({
                state: 'running',
                task_id: id,
                step: progress.step,
                total: progress.total,
                label: progress.label,
              });
            },
            onToolCall: ({ tool, step }) => {
              record.tool_log.push({ tool, ok: true, summary: `step ${step}` });
              if (record.tool_log.length > 200) record.tool_log.shift();
            },
          });
          record.result = result;
          record.state = result.ok ? 'done' : result.error?.code === 'cancelled' ? 'cancelled' : 'error';
          record.error = result.ok ? null : (result.error?.message ?? null);
          session.notifyAgentResult({
            request_id: id,
            ok: result.ok,
            summary: result.summary,
            steps: result.steps,
            tool_calls: result.tool_calls,
            error: result.ok ? undefined : { code: result.error?.code ?? 'error', message: result.error?.message ?? 'failed' },
          });
          session.notifyAgentStatus({ state: 'idle', task_id: id, label: result.ok ? 'done' : 'failed' });
          logger.info(`task ${id} ${record.state} in ${result.steps} steps (${result.tool_calls} tool calls)`);
        } catch (error) {
          record.state = 'error';
          record.error = (error as Error).message;
          session.notifyAgentStatus({ state: 'error', task_id: id, message: record.error });
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

  const describeTask = (record: TaskRecord): Record<string, unknown> => ({
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
    error: record.error,
  });

  /* ----------------------------------------------------------- plugin → agent */

  session.on(
    SESSION_EVENTS.task,
    (payload: {
      request_id: string;
      prompt: string;
      context?: { project_name?: string | null; format_id?: string | null; save_path?: string | null };
    }) => {
    const record = startTaskInternal(payload.prompt, {
      projectName: payload.context?.project_name ?? null,
      formatId: payload.context?.format_id ?? null,
      savePath: payload.context?.save_path ?? null,
    });
    logger.info(`task ${record.id} started from the Blockbench panel`);
    },
  );
  session.on(SESSION_EVENTS.taskStop, () => {
    if (runningTaskId) {
      controllers.get(runningTaskId)?.abort();
      logger.info(`task ${runningTaskId} cancelled from the panel`);
    }
  });

  /* ------------------------------------------------------------------ routing */

  httpServer.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const remote = req.socket.remoteAddress;

      if (!isLoopback(remote)) {
        json(res, 403, { error: 'this bridge only serves loopback clients', remote });
        return;
      }

      // A browser page is also "loopback" from the OS point of view, so reject anything
      // whose Origin is not a local one. Command line clients send no Origin and pass.
      if (!isTrustedOrigin(req.headers.origin)) {
        logger.warn(`refusing ${req.method} ${path} from origin ${describeOrigin(req.headers.origin)}`);
        json(res, 403, { error: 'origin not allowed', origin: describeOrigin(req.headers.origin) });
        return;
      }

      // Health is deliberately token-free so monitoring and the CLI can probe it.
      if (path === '/health' || path === '/') {
        json(res, 200, {
          service: 'blockbench-ai-agent-bridge',
          protocol: PROTOCOL_VERSION,
          plugin_connected: session.connected,
          auth_required: !config.allowAnonymous,
          model: agent.model,
          state_revision: session.revision,
          running_task: runningTaskId,
          queued: queue.length,
          uptime_s: Math.round(process.uptime()),
        });
        return;
      }

      if (!authorised(req, url)) {
        json(res, 401, { error: 'missing or invalid token — send x-agent-token or ?token=' });
        return;
      }

      try {
        if (path === '/state' && req.method === 'GET') {
          json(res, 200, { state: session.state as PluginStateSnapshot | null, revision: session.revision, connected: session.connected });
          return;
        }
        if (path === '/capabilities' && req.method === 'GET') {
          json(res, 200, { capabilities: session.capabilities as CapabilityReport | null, connected: session.connected });
          return;
        }
        if (path === '/tools' && req.method === 'GET') {
          const pluginTools = session.cachedTools();
          const local = agent.localDefinitions();
          json(res, 200, {
            source: session.connected ? 'live' : 'cache',
            count: pluginTools.length + local.length,
            plugin: pluginTools,
            bridge: local,
          });
          return;
        }
        if (path === '/memory' && req.method === 'GET') {
          json(res, 200, memory.snapshot());
          return;
        }
        if (path === '/references' && req.method === 'GET') {
          json(res, 200, {
            directory: paths.references,
            references: memory.listReferences().map(({ base64: _base64, ...rest }) => rest),
          });
          return;
        }
        if (path === '/checkpoints' && req.method === 'GET') {
          json(res, 200, { checkpoints: memory.listCheckpoints() });
          return;
        }
        if (path === '/checkpoints' && req.method === 'POST') {
          const body = (await readBody(req)) as { label?: string };
          const record = await session.checkpoint(body.label ?? 'checkpoint via REST', true);
          storeCheckpoint(memory, record);
          json(res, 200, record);
          return;
        }
        if (path === '/rollback' && req.method === 'POST') {
          const body = (await readBody(req)) as { checkpoint_id?: string };
          const list = memory.listCheckpoints();
          const target = body.checkpoint_id ?? list[list.length - 1]?.checkpoint_id;
          if (!target) {
            json(res, 400, { error: 'no checkpoint to restore' });
            return;
          }
          const outcome = await session.rollback(target);
          json(res, outcome.ok ? 200 : 500, outcome);
          return;
        }
        if (path === '/logs' && req.method === 'GET') {
          json(res, 200, { lines: logger.recent(Number(url.searchParams.get('limit') ?? 200)) });
          return;
        }
        if (path.startsWith('/tool/')) {
          // Accept a trailing name and JSON args, e.g. POST /tool/inspect_model {"name":"body"}
          const name = decodeURIComponent(path.slice('/tool/'.length));
          const args = req.method === 'GET'
            ? Object.fromEntries(url.searchParams.entries())
            : ((await readBody(req)) as Record<string, unknown>);
          const started = Date.now();
          const outcome = await session.callTool(name, args ?? {}, {
            taskId: 'rest',
            timeoutMs: Number(url.searchParams.get('timeout') ?? 120000),
          });
          json(res, outcome.ok ? 200 : 400, { ...outcome, tool: name, wall_ms: Date.now() - started });
          return;
        }
        if (path === '/task' && req.method === 'POST') {
          const body = (await readBody(req)) as {
            prompt?: string;
            wait?: boolean | number | string;
            wait_ms?: number;
            project_name?: string;
            format_id?: string;
            save_path?: string;
          };
          if (!body.prompt || !body.prompt.trim()) {
            json(res, 400, { error: 'prompt is required' });
            return;
          }
          // Accept `wait` from the body or the query string: a caller streaming curl
          // output naturally writes it as a query parameter.
          const wait =
            body.wait === true || body.wait === 1 || body.wait === '1' || url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true';
          const record = startTaskInternal(body.prompt, {
            projectName: body.project_name ?? null,
            formatId: body.format_id ?? null,
            savePath: body.save_path ?? null,
          });
          if (wait) {
            // Long-poll until the task leaves the queue; the plugin keeps the user
            // informed through progress messages while this waits.
            await new Promise<void>((resolve) => {
              const timer = setInterval(() => {
                const current = tasks.get(record.id);
                if (!current || current.state === 'done' || current.state === 'error' || current.state === 'cancelled') {
                  clearInterval(timer);
                  resolve();
                }
              }, 500);
              const budget = Number(url.searchParams.get('wait_ms') ?? body.wait_ms ?? 900000);
              setTimeout(() => {
                clearInterval(timer);
                resolve();
              }, budget);
            });
            json(res, 200, describeTask(tasks.get(record.id)!));
            return;
          }
          json(res, 202, describeTask(record));
          return;
        }
        if (path.startsWith('/task/')) {
          const rest = path.slice('/task/'.length).split('/').filter(Boolean);
          const record = tasks.get(decodeURIComponent(rest[0]));
          if (!record) {
            json(res, 404, { error: `unknown task "${rest[0]}"` });
            return;
          }
          if (rest[1] === 'stop' && req.method === 'POST') {
            controllers.get(record.id)?.abort();
            json(res, 200, describeTask(record));
            return;
          }
          json(res, 200, describeTask(record));
          return;
        }
        if (path === '/tasks' && req.method === 'GET') {
          json(res, 200, { tasks: [...tasks.values()].slice(-25).map(describeTask) });
          return;
        }
        json(res, 404, { error: `no route for ${req.method} ${path}` });
      } catch (error) {
        const message = (error as Error).message;
        logger.warn(`REST ${req.method} ${path} failed: ${message}`);
        json(res, statusFor(message), { error: message });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo | null;
  const port = address?.port ?? config.port;
  logger.info(`bridge listening on http://${config.host}:${port} (plugin socket: ws://${config.host}:${port}/plugin)`);
  logger.info(
    config.allowAnonymous
      ? 'authentication: anonymous (loopback + Origin checked) — paste the URL above into the Blockbench panel'
      : 'authentication: token required',
  );

  return {
    server: httpServer,
    port,
    url: `http://${config.host}:${port}`,
    tasks,
    async startTask(prompt: string, brief: Partial<AgentBrief> = {}) {
      void brief;
      return startTaskInternal(prompt, brief);
    },
    stopTask(taskId?: string) {
      const target = taskId ?? runningTaskId;
      if (!target) return false;
      controllers.get(target)?.abort();
      return true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const controller of controllers.values()) controller.abort();
        session.stop();
        httpServer.close(() => resolve());
      }),
  };
}

function statusFor(message: string): number {
  if (/unknown tool|invalid|required|must be/i.test(message)) return 400;
  if (/not connected/i.test(message)) return 503;
  return 500;
}

export { text as sendText };
