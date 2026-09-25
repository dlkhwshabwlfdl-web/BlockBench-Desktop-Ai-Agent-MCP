/**
 * Plugin side of the Agent Bridge link.
 *
 * Transport is a plain WebSocket to 127.0.0.1. The plugin runs inside Blockbench's
 * Chromium renderer, so `WebSocket` is a built-in browser global: no native module,
 * no permission prompt, and no Content-Security-Policy in the app to fight with
 * (verified: `resources/app.asar/index.html` declares no CSP).
 *
 * Responsibilities:
 *  - handshake with the session token
 *  - answer `tool_call` / `list_tools` / `checkpoint` / `rollback`
 *  - push `state_update`, `event`, `progress`, `log`
 *  - heartbeat, and reconnection with exponential backoff
 *  - cancellation bookkeeping shared with the tool dispatcher
 */

import {
  PROTOCOL_VERSION,
  type AnyMessage,
  type CapabilityReport,
  type ToolDefinition,
  type ToolResultMessage,
  type ToolError,
} from '../shared/protocol.js';
import { BRIDGE_CLIENT_NAME, PLUGIN_VERSION } from './meta.js';

export type LinkStatus = 'disconnected' | 'connecting' | 'connected' | 'rejected';

export interface CheckpointOutcome {
  checkpoint_id: string;
  label: string;
  snapshot?: Record<string, unknown> | null;
  undo_index: number;
  undo_length: number;
  created_at: number;
}

export interface ToolHandlerContext {
  requestId: string;
  /** Throws when the bridge has cancelled this request. */
  throwIfCancelled(): void;
  reportProgress(step: number, total: number, label: string): void;
}

export interface ToolHandlerResult {
  data: unknown;
  warnings?: string[];
  /** Set true only when the handler actually re-read Blockbench state to confirm the effect. */
  verified?: boolean;
}

export interface BridgeClientHost {
  getTools(): ToolDefinition[];
  getCapabilities(): CapabilityReport;
  callTool(tool: string, args: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolHandlerResult>;
  createCheckpoint(label: string, includeSnapshot: boolean): Promise<CheckpointOutcome>;
  restoreCheckpoint(checkpointId: string): Promise<CheckpointOutcome>;
}

export interface BridgeClientOptions extends BridgeClientHost {
  onStatus(status: LinkStatus, detail?: string): void;
  onLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;

function uid(prefix = 'p'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function errorToToolError(error: unknown): ToolError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const source = error as Record<string, unknown>;
    // Copy out of the Error object rather than returning it: `message` and `stack` are
    // non-enumerable, so JSON.stringify(Error) silently drops them and the agent would
    // receive a failure code with no explanation.
    const out: ToolError = {
      code: typeof source.code === 'string' ? source.code : 'internal',
      message: typeof source.message === 'string' ? source.message : String(error),
      retryable: typeof source.retryable === 'boolean' ? source.retryable : undefined,
    };
    if (Array.isArray(source.detail)) out.detail = source.detail;
    else if (typeof source.detail === 'string') out.detail = source.detail;
    return out;
  }
  const err = error as Error;
  const name = err?.name ?? 'Error';
  return {
    code: name === 'ValidationError' ? 'invalid_arguments' : name === 'MissingApiError' ? 'api_unavailable' : 'internal',
    message: err?.message ?? String(error),
    detail: err?.stack ? String(err.stack).split('\n').slice(0, 6) : undefined,
    retryable: name === 'NeedProjectError' ? false : undefined,
  };
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private status: LinkStatus = 'disconnected';
  private statusDetail = '';
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastPong = 0;
  private readonly cancelled = new Set<string>();
  private readonly inflight = new Set<string>();

  private url: string;
  private token: string;

  constructor(private readonly options: BridgeClientOptions, url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  get isConnected(): boolean {
    return this.status === 'connected' && this.socket?.readyState === 1;
  }

  getStatus(): { status: LinkStatus; detail: string; url: string } {
    return { status: this.status, detail: this.statusDetail, url: this.url };
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  configure(url: string, token: string): void {
    this.url = url;
    this.token = token;
    if (this.isConnected) {
      this.disconnect();
      this.connect();
    }
  }

  connect(): void {
    this.manuallyClosed = false;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;

    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.setStatus('disconnected', (error as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.lastPong = Date.now();
      this.send({
        v: PROTOCOL_VERSION,
        id: uid('hello'),
        type: 'hello',
        role: 'plugin',
        token: this.token,
        client: { name: BRIDGE_CLIENT_NAME, version: PLUGIN_VERSION },
        capabilities: this.safeCapabilities(),
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      void this.handleRawMessage(event.data);
    };

    socket.onerror = () => {
      // The browser does not expose the error detail for security reasons; the close
      // handler always fires afterwards and carries the actionable information.
      this.setStatus('disconnected', 'socket error');
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      this.stopHeartbeat();
      if (event.code === 4001) {
        this.setStatus('rejected', event.reason || 'bridge rejected the session token');
        return;
      }
      this.setStatus('disconnected', `closed (${event.code})`);
      if (!this.manuallyClosed) this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    try {
      this.socket?.close(1000, 'client disconnect');
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.setStatus('disconnected', 'disconnected by user');
  }

  /* --------------------------------------------------------------- outbound */

  private safeCapabilities(): CapabilityReport | undefined {
    try {
      return this.options.getCapabilities();
    } catch {
      return undefined;
    }
  }

  send(message: AnyMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      const payload = JSON.stringify(message);
      if (payload.length > MAX_MESSAGE_BYTES) {
        this.options.onLog('error', `refusing to send ${payload.length} byte message`);
        return false;
      }
      socket.send(payload);
      return true;
    } catch (error) {
      this.options.onLog('error', `failed to send ${message.type}: ${(error as Error).message}`);
      return false;
    }
  }

  publishState(revision: number, changed: string[], state: unknown): void {
    this.send({ v: PROTOCOL_VERSION, id: uid('state'), type: 'state_update', revision, changed, state } as AnyMessage);
  }

  publishEvent(name: string, data?: unknown): void {
    this.send({ v: PROTOCOL_VERSION, id: uid('evt'), type: 'event', name, at: Date.now(), data } as AnyMessage);
  }

  publishLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.send({ v: PROTOCOL_VERSION, id: uid('log'), type: 'log', level, message });
  }

  /**
   * Push a freshly probed capability report. Required because the boot-time report is
   * taken before any project exists, so every format-dependent capability reads as
   * unavailable until this corrects it.
   */
  publishCapabilities(report: CapabilityReport, reason: 'connected' | 'project_opened' | 'format_changed' | 'requested' | 'periodic'): void {
    this.send({ v: PROTOCOL_VERSION, id: uid('caps'), type: 'capabilities', report, reason });
  }

  /* ---------------------------------------------------------------- inbound */

  private async handleRawMessage(raw: unknown): Promise<void> {
    let message: AnyMessage;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      message = JSON.parse(text) as AnyMessage;
    } catch (error) {
      this.options.onLog('warn', `ignoring unparseable message: ${(error as Error).message}`);
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this.options.onLog('warn', 'ignoring message without a type');
      return;
    }

    switch (message.type) {
      case 'welcome': {
        if (!message.accepted) {
          this.setStatus('rejected', message.reason || 'rejected');
          try {
            this.socket?.close(4001, message.reason || 'rejected');
          } catch {
            /* ignore */
          }
          return;
        }
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        this.startHeartbeat();
        return;
      }
      case 'list_tools': {
        // Echo the request id so the bridge can correlate this reply.
        this.send({ v: PROTOCOL_VERSION, id: message.id, type: 'tools', tools: this.options.getTools() });
        return;
      }
      case 'tool_call': {
        await this.runToolCall(message);
        return;
      }
      case 'checkpoint': {
        await this.runCheckpoint(message);
        return;
      }
      case 'rollback': {
        await this.runRollback(message);
        return;
      }
      case 'cancel': {
        this.cancelled.add(message.request_id);
        this.options.onLog('info', `cancellation requested for ${message.request_id}`);
        return;
      }
      case 'ping': {
        this.send({ v: PROTOCOL_VERSION, id: message.id, type: 'pong', t: Date.now() });
        return;
      }
      case 'pong': {
        this.lastPong = Date.now();
        return;
      }
      default:
        this.options.onLog('debug', `unhandled message type ${message.type}`);
    }
  }

  private async runToolCall(message: Extract<AnyMessage, { type: 'tool_call' }>): Promise<void> {
    const started = Date.now();
    const requestId = message.request_id || message.id;
    this.inflight.add(requestId);
    const base: Omit<ToolResultMessage, 'ok' | 'duration_ms'> = {
      v: PROTOCOL_VERSION,
      id: uid('res'),
      type: 'tool_result',
      request_id: requestId,
      tool: message.tool,
    } as Omit<ToolResultMessage, 'ok' | 'duration_ms'>;

    if (this.cancelled.has(requestId)) {
      this.cancelled.delete(requestId);
      this.inflight.delete(requestId);
      this.send({ ...base, ok: false, duration_ms: 0, error: { code: 'cancelled', message: 'cancelled before execution' } } as ToolResultMessage);
      return;
    }

    const ctx: ToolHandlerContext = {
      requestId,
      throwIfCancelled: () => {
        if (this.cancelled.has(requestId)) {
          this.cancelled.delete(requestId);
          const err = new Error('Tool call cancelled by the agent');
          err.name = 'CancelledError';
          throw err;
        }
      },
      reportProgress: (step: number, total: number, label: string) => {
        this.send({ v: PROTOCOL_VERSION, id: uid('prg'), type: 'progress', task_id: requestId, step, total, label });
      },
    };

    try {
      const result = await this.options.callTool(message.tool, message.args ?? {}, ctx);
      this.send({
        ...base,
        ok: true,
        data: result.data,
        warnings: result.warnings,
        verified: result.verified,
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    } catch (error) {
      const toolError = errorToToolError(error);
      if ((error as Error)?.name === 'CancelledError') toolError.code = 'cancelled';
      this.send({
        ...base,
        ok: false,
        error: toolError,
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    } finally {
      this.inflight.delete(requestId);
      this.cancelled.delete(requestId);
    }
  }

  private async runCheckpoint(message: Extract<AnyMessage, { type: 'checkpoint' }>): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await this.options.createCheckpoint(message.label, message.include_snapshot !== false);
      this.send({
        v: PROTOCOL_VERSION,
        id: uid('res'),
        type: 'tool_result',
        request_id: message.request_id,
        tool: '__checkpoint__',
        ok: true,
        data: outcome,
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    } catch (error) {
      this.send({
        v: PROTOCOL_VERSION,
        id: uid('res'),
        type: 'tool_result',
        request_id: message.request_id,
        tool: '__checkpoint__',
        ok: false,
        error: errorToToolError(error),
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    }
  }

  private async runRollback(message: Extract<AnyMessage, { type: 'rollback' }>): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await this.options.restoreCheckpoint(message.checkpoint_id);
      this.send({
        v: PROTOCOL_VERSION,
        id: uid('res'),
        type: 'tool_result',
        request_id: message.request_id,
        tool: '__rollback__',
        ok: true,
        data: outcome,
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    } catch (error) {
      this.send({
        v: PROTOCOL_VERSION,
        id: uid('res'),
        type: 'tool_result',
        request_id: message.request_id,
        tool: '__rollback__',
        ok: false,
        error: errorToToolError(error),
        duration_ms: Date.now() - started,
      } as ToolResultMessage);
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      if (Date.now() - this.lastPong > 20000) {
        this.options.onLog('warn', 'bridge stopped responding to heartbeats, reconnecting');
        try {
          this.socket?.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ v: PROTOCOL_VERSION, id: uid('ping'), type: 'ping', t: Date.now() });
    }, 5000) as unknown as number;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const base = Math.min(15000, 500 * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
    const delay = base + Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay) as unknown as number;
  }

  private setStatus(status: LinkStatus, detail = ''): void {
    this.status = status;
    this.statusDetail = detail;
    this.options.onStatus(status, detail);
  }
}

export function createMessageId(prefix?: string): string {
  return uid(prefix);
}
