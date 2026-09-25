/**
 * The bridge side of the plugin link.
 *
 * Owns:
 *  - the WebSocket server (shared with the REST server through one HTTP upgrade)
 *  - the session token handshake
 *  - request/response correlation with timeouts, so a tool call can never hang forever
 *  - a cache of the latest capability report, tool catalogue and state snapshot
 *  - cancellation, so the panel's Stop button reaches an in-flight call
 *  - an event bus the rest of the bridge (agent, HTTP, MCP) subscribes to
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  PLUGIN_SOCKET_PATH,
  type AnyMessage,
  type CapabilityReport,
  type PluginStateSnapshot,
  type ToolDefinition,
  type ToolError,
  type ToolResultMessage,
} from '../shared/protocol.js';
import type { BridgeConfig } from './config.js';
import { Logger } from './log.js';
import { describeOrigin, isTrustedOrigin } from './origin.js';

export interface ToolCallOptions {
  timeoutMs?: number;
  /** Reported through the event bus while the call runs. */
  taskId?: string;
  signal?: AbortSignal;
}

export interface ToolCallOutcome {
  ok: boolean;
  data: unknown;
  error?: ToolError;
  warnings?: string[];
  verified?: boolean;
  duration_ms: number;
}

export interface CheckpointOutcome {
  checkpoint_id: string;
  label: string;
  snapshot?: { model: Record<string, unknown>; project_name: string | null; format_id: string } | null;
  undo_index: number;
  undo_length: number;
  created_at: number;
}

interface PendingRequest {
  resolve(message: AnyMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  kind: 'tool' | 'tools' | 'checkpoint' | 'rollback';
  tool?: string;
}

export const SESSION_EVENTS = {
  status: 'status',
  state: 'state',
  event: 'event',
  progress: 'progress',
  log: 'log',
  task: 'task',
  taskResult: 'taskResult',
  taskStop: 'taskStop',
} as const;

export class PluginSession extends EventEmitter {
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inflight = new Map<string, string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPong = 0;

  private capabilitiesCache: CapabilityReport | null = null;
  private toolsCache: ToolDefinition[] = [];
  private stateCache: PluginStateSnapshot | null = null;
  private stateRevision = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.setMaxListeners(50);
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  get capabilities(): CapabilityReport | null {
    return this.capabilitiesCache;
  }

  get state(): PluginStateSnapshot | null {
    return this.stateCache;
  }

  get revision(): number {
    return this.stateRevision;
  }

  cachedTools(): ToolDefinition[] {
    return this.toolsCache;
  }

  /* ------------------------------------------------------------- lifecycle */

  attach(server: http.Server): void {
    this.server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      // Accept `/plugin` (what the bridge prints) as well as `/` — the plugin's
      // default Bridge URL in older builds carried no path, and destroying that
      // upgrade is what made the panel read "disconnected" forever.
      const pathname = (request.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
      if (pathname !== '/' && pathname !== PLUGIN_SOCKET_PATH) {
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
        this.server?.emit('connection', client, request);
      });
    });
    this.server.on('connection', (client) => this.handleConnection(client));
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error('bridge is shutting down'));
      this.pending.delete(id);
    }
    try {
      this.socket?.close(1001, 'bridge shutting down');
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  private handleConnection(client: WebSocket): void {
    this.logger.info('plugin socket opened, awaiting handshake');
    let authenticated = false;

    client.on('message', (raw) => {
      let message: AnyMessage;
      try {
        message = JSON.parse(String(raw)) as AnyMessage;
      } catch (error) {
        this.logger.warn(`dropping unparseable message: ${(error as Error).message}`);
        return;
      }
      if (!message || typeof message.type !== 'string') {
        this.logger.warn('dropping message without a type');
        return;
      }

      if (!authenticated) {
        if (message.type !== 'hello') {
          this.logger.warn(`rejecting ${message.type} before handshake`);
          try {
            client.close(4001, 'handshake required');
          } catch {
            /* ignore */
          }
          return;
        }
        const accepted = this.checkToken(message.token ?? '');
        client.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            id: message.id,
            type: 'welcome',
            accepted,
            reason: accepted ? undefined : 'invalid session token',
            server: { name: 'blockbench-ai-agent-bridge', version: PROTOCOL_VERSION.toString() },
          }),
        );
        if (!accepted) {
          this.logger.warn('rejected a plugin connection: bad token');
          try {
            client.close(4001, 'invalid token');
          } catch {
            /* ignore */
          }
          return;
        }
        authenticated = true;
        this.socket = client;
        this.capabilitiesCache = message.capabilities ?? null;
        this.lastPong = Date.now();
        this.startHeartbeat();
        this.emit(SESSION_EVENTS.status, { status: 'connected', capabilities: this.capabilitiesCache });
        this.logger.info(
          `plugin connected: Blockbench ${this.capabilitiesCache?.blockbench_version ?? '?'} · format ${this.capabilitiesCache?.active_format ?? 'none'}`,
        );
        // Refresh the catalogue immediately so the agent does not have to ask.
        void this.listTools(true).catch((error) => this.logger.warn(`initial list_tools failed: ${error.message}`));
        return;
      }

      this.dispatch(message);
    });

    client.on('close', (code, reason) => {
      if (this.socket === client) {
        this.socket = null;
        this.capabilitiesCache = null;
        this.emit(SESSION_EVENTS.status, { status: 'disconnected', code, reason: String(reason) });
        this.logger.info(`plugin disconnected (${code})`);
      }
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error(`plugin disconnected while waiting for ${request.tool ?? request.kind}`));
        this.pending.delete(id);
      }
    });

    client.on('error', (error) => {
      this.logger.warn(`socket error: ${(error as Error).message}`);
    });
  }

  private checkToken(presented: string): boolean {
    if (this.config.allowAnonymous) return true;
    const expected = Buffer.from(this.config.token);
    const actual = Buffer.from(presented ?? '');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > 25000) {
        this.logger.warn('plugin stopped answering heartbeats');
        try {
          this.socket?.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ v: PROTOCOL_VERSION, id: `ping-${Date.now()}`, type: 'ping', t: Date.now() });
    }, 7000);
  }

  private dispatch(message: AnyMessage): void {
    switch (message.type) {
      case 'pong':
        this.lastPong = Date.now();
        return;
      case 'ping':
        this.send({ v: PROTOCOL_VERSION, id: message.id, type: 'pong', t: Date.now() });
        return;
      case 'tools': {
        this.toolsCache = message.tools ?? [];
        this.logger.info(`tool catalogue refreshed: ${this.toolsCache.length} tools`);
        this.settle(message.id, message);
        return;
      }
      case 'tool_result': {
        this.emit(SESSION_EVENTS.progress, { request_id: message.request_id, done: true, tool: message.tool });
        this.settle(message.request_id, message);
        return;
      }
      case 'capabilities': {
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
          `capabilities updated (${message.reason}): format ${message.report.active_format ?? 'none'}` +
            `${gained.length ? ` · now available: ${gained.map((entry) => entry.id).join(', ')}` : ''}` +
            `${lost.length ? ` · lost: ${lost.map((entry) => entry.id).join(', ')}` : ''}`,
        );
        this.emit(SESSION_EVENTS.status, { status: 'connected', capabilities: this.capabilitiesCache });
        return;
      }
      case 'state_update': {
        this.stateCache = message.state;
        this.stateRevision = message.revision;
        this.emit(SESSION_EVENTS.state, { state: message.state, changed: message.changed });
        return;
      }
      case 'event': {
        this.emit(SESSION_EVENTS.event, { name: message.name, data: message.data, at: message.at });
        return;
      }
      case 'progress': {
        this.emit(SESSION_EVENTS.progress, {
          task_id: message.task_id,
          step: message.step,
          total: message.total,
          label: message.label,
        });
        return;
      }
      case 'log': {
        this.logger.log(message.level === 'debug' ? 'debug' : message.level, `[plugin] ${message.message}`);
        this.emit(SESSION_EVENTS.log, { level: message.level, message: message.message });
        return;
      }
      case 'agent_task': {
        this.emit(SESSION_EVENTS.task, { request_id: message.request_id, prompt: message.prompt, context: message.context });
        return;
      }
      case 'agent_stop': {
        this.emit(SESSION_EVENTS.taskStop, { request_id: message.request_id, reason: message.reason });
        return;
      }
      case 'error': {
        this.logger.error(`plugin reported an error: ${message.error.message}`);
        return;
      }
      default:
        this.logger.debug(`unhandled message type ${message.type}`);
    }
  }

  private settle(correlationId: string, message: AnyMessage): void {
    const pending = this.pending.get(correlationId);
    if (!pending) {
      this.logger.debug(`no pending request for ${correlationId}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    pending.resolve(message);
  }

  private send(message: AnyMessage): boolean {
    if (!this.connected) return false;
    try {
      this.socket!.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.warn(`send failed: ${(error as Error).message}`);
      return false;
    }
  }

  private request(
    build: (id: string) => AnyMessage,
    correlationId: string,
    kind: PendingRequest['kind'],
    timeoutMs: number,
    tool?: string,
  ): Promise<AnyMessage> {
    if (!this.connected) {
      return Promise.reject(new Error('The Blockbench plugin is not connected. Open Blockbench with the AI Agent plugin enabled and press Connect.'));
    }
    return new Promise<AnyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`${tool ?? kind} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer, kind, tool });
      const ok = this.send(build(correlationId));
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        reject(new Error('failed to send the request to the plugin'));
      }
    });
  }

  /* ------------------------------------------------------------ operations */

  async listTools(force = false): Promise<ToolDefinition[]> {
    if (!force && this.toolsCache.length) return this.toolsCache;
    const id = `tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const message = await this.request(
      (requestId) => ({ v: PROTOCOL_VERSION, id: requestId, type: 'list_tools' }),
      id,
      'tools',
      15000,
    );
    if (message.type !== 'tools') throw new Error(`unexpected reply ${message.type} to list_tools`);
    this.toolsCache = message.tools ?? [];
    return this.toolsCache;
  }

  async callTool(name: string, args: Record<string, unknown>, options: ToolCallOptions = {}): Promise<ToolCallOutcome> {
    const requestId = options.taskId
      ? `${options.taskId}:${name}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      : `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const timeoutMs = options.timeoutMs ?? 120000;
    if (options.signal?.aborted) {
      return { ok: false, data: null, duration_ms: 0, error: { code: 'cancelled', message: 'cancelled before dispatch' } };
    }
    const onAbort = () => this.cancel(requestId, 'aborted by caller');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    this.inflight.set(requestId, name);
    this.emit(SESSION_EVENTS.progress, { task_id: options.taskId, tool: name, started: true, args });
    try {
      const message = await this.request(
        (id) => ({
          v: PROTOCOL_VERSION,
          id,
          type: 'tool_call',
          request_id: requestId,
          tool: name,
          args,
          timeout_ms: timeoutMs,
        }),
        requestId,
        'tool',
        timeoutMs + 2000,
        name,
      );
      if (message.type !== 'tool_result') throw new Error(`unexpected reply ${message.type} to tool_call`);
      const result = message as ToolResultMessage;
      return {
        ok: result.ok,
        data: result.data ?? null,
        error: result.error,
        warnings: result.warnings,
        verified: result.verified,
        duration_ms: result.duration_ms,
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(requestId);
      this.emit(SESSION_EVENTS.progress, { task_id: options.taskId, tool: name, done: true });
    }
  }

  async checkpoint(label: string, includeSnapshot = true, timeoutMs = 60000): Promise<CheckpointOutcome> {
    const id = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const message = await this.request(
      (requestId) => ({
        v: PROTOCOL_VERSION,
        id: requestId,
        type: 'checkpoint',
        request_id: requestId,
        label,
        include_snapshot: includeSnapshot,
      }),
      id,
      'checkpoint',
      timeoutMs,
      'checkpoint',
    );
    if (message.type !== 'tool_result') throw new Error(`unexpected reply ${message.type} to checkpoint`);
    if (!message.ok) throw new Error(`checkpoint failed: ${message.error?.message ?? 'unknown error'}`);
    return message.data as CheckpointOutcome;
  }

  async rollback(checkpointId: string, timeoutMs = 120000): Promise<ToolCallOutcome> {
    const id = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const message = await this.request(
      (requestId) => ({
        v: PROTOCOL_VERSION,
        id: requestId,
        type: 'rollback',
        request_id: requestId,
        checkpoint_id: checkpointId,
      }),
      id,
      'rollback',
      timeoutMs,
      'rollback',
    );
    if (message.type !== 'tool_result') throw new Error(`unexpected reply ${message.type} to rollback`);
    return {
      ok: message.ok,
      data: message.data ?? null,
      error: message.error,
      warnings: message.warnings,
      verified: message.verified,
      duration_ms: message.duration_ms,
    };
  }

  cancel(requestId: string | undefined, reason = 'cancelled'): void {
    if (!requestId) {
      for (const id of this.inflight.keys()) this.cancel(id, reason);
      return;
    }
    this.send({ v: PROTOCOL_VERSION, id: `cancel-${Date.now().toString(36)}`, type: 'cancel', request_id: requestId, reason });
    this.logger.info(`cancel sent for ${requestId}`);
  }

  /** Push an agent run state change into the panel. */
  notifyAgentStatus(status: {
    state: 'idle' | 'running' | 'error';
    task_id?: string;
    step?: number;
    total?: number;
    label?: string;
    message?: string;
  }): void {
    this.send({ v: PROTOCOL_VERSION, id: `status-${Date.now().toString(36)}`, type: 'agent_status', ...status });
  }

  /** Answer an `agent_task` coming from the panel. */
  notifyAgentResult(payload: {
    request_id: string;
    ok: boolean;
    summary?: string;
    steps?: number;
    tool_calls?: number;
    data?: unknown;
    error?: ToolError;
  }): void {
    this.send({ v: PROTOCOL_VERSION, id: `result-${Date.now().toString(36)}`, type: 'agent_task_result', ...payload });
  }
}
