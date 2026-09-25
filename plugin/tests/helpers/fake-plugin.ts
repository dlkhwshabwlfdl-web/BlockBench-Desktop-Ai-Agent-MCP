/**
 * A fake Blockbench plugin.
 *
 * This is a real WebSocket client speaking the real protocol, not a stub of
 * `PluginSession`. That matters: it exercises the handshake, the token check, request
 * correlation, heartbeats and the tool-result shape end to end, which is exactly the
 * part of the system that unit tests cannot cover without a live Blockbench.
 *
 * Tool handlers are functions, so a test can assert on the arguments a tool received and
 * script what Blockbench "did" in response.
 */

import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type AnyMessage,
  type CapabilityReport,
  type ToolDefinition,
  type ToolResultMessage,
} from '../../src/shared/protocol.js';

export interface FakeToolHandler {
  (args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface FakePluginOptions {
  url: string;
  token?: string;
  tools?: ToolDefinition[];
  capabilities?: Partial<CapabilityReport>;
  /** Simulates a tool that throws, or Blockbench rejecting the call. */
  handlers?: Record<string, FakeToolHandler>;
  state?: unknown;
}

export function makeCapabilities(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    plugin_version: '0.1.0-test',
    protocol_version: PROTOCOL_VERSION,
    blockbench_version: '5.2.1',
    blockbench_is_app: true,
    platform: 'test',
    operating_system: 'win32',
    browser: 'chrome',
    active_format: 'java_block',
    format_count: 24,
    mode: 'edit',
    features: [
      { id: 'screenshot', available: true, source: 'js/preview/screenshot.js' },
      { id: 'skin_mode', available: false, source: 'js/formats/minecraft/skin.ts', note: 'not in this format' },
    ],
    permissions: [],
    installed_plugins: [],
    available_events: ['add_cube', 'select_animation'],
    limitations: [],
    ...overrides,
  };
}

export class FakePlugin {
  private socket: WebSocket | null = null;
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  readonly checkpoints: string[] = [];
  readonly rollbacks: string[] = [];
  welcomeAccepted = false;
  closed = false;
  /** When set, the next tool call returns this error instead of running a handler. */
  failNext: { code: string; message: string } | null = null;
  toolDelayMs = 0;

  constructor(private readonly options: FakePluginOptions) {}

  get tools(): ToolDefinition[] {
    return this.options.tools ?? [];
  }

  async connect(): Promise<void> {
    const url = this.options.token ? `${this.options.url}?token=${encodeURIComponent(this.options.token)}` : this.options.url;
    this.socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake plugin could not connect')), 5000);
      this.socket!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.socket.on('message', (raw) => void this.handle(JSON.parse(String(raw)) as AnyMessage));
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: 'hello-1',
        type: 'hello',
        role: 'plugin',
        token: this.options.token ?? '',
        client: { name: 'fake-plugin', version: '0.1.0-test' },
        capabilities: makeCapabilities(this.options.capabilities),
      }),
    );
    await this.waitFor(() => this.welcomeAccepted, 3000, 'welcome');
    if (this.options.state) this.pushState(this.options.state);
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  pushState(state: unknown, changed: string[] = ['model']): void {
    this.socket?.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `state-${Date.now()}`, type: 'state_update', revision: Date.now(), changed, state }));
  }

  emitEvent(name: string, data?: unknown): void {
    this.socket?.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `evt-${Date.now()}`, type: 'event', name, at: Date.now(), data }));
  }

  private async handle(message: AnyMessage): Promise<void> {
    switch (message.type) {
      case 'welcome':
        this.welcomeAccepted = message.accepted;
        return;
      case 'list_tools':
        this.socket?.send(JSON.stringify({ v: PROTOCOL_VERSION, id: message.id, type: 'tools', tools: this.tools }));
        return;
      case 'ping':
        this.socket?.send(JSON.stringify({ v: PROTOCOL_VERSION, id: message.id, type: 'pong', t: Date.now() }));
        return;
      case 'checkpoint': {
        this.checkpoints.push(message.label);
        const data = {
          checkpoint_id: `cp-${this.checkpoints.length}`,
          label: message.label,
          snapshot: null,
          undo_index: this.checkpoints.length,
          undo_length: this.checkpoints.length,
          created_at: Date.now(),
        };
        this.socket?.send(JSON.stringify(this.result(message.request_id, '__checkpoint__', true, data, 1)));
        return;
      }
      case 'rollback': {
        this.rollbacks.push(message.checkpoint_id);
        this.socket?.send(
          JSON.stringify(this.result(message.request_id, '__rollback__', true, { checkpoint_id: message.checkpoint_id, restored: true, verified: true }, 2)),
        );
        return;
      }
      case 'tool_call': {
        const requestId = message.request_id;
        this.calls.push({ tool: message.tool, args: message.args ?? {} });
        if (this.toolDelayMs) await new Promise((resolve) => setTimeout(resolve, this.toolDelayMs));
        if (this.failNext) {
          const failure = this.failNext;
          this.failNext = null;
          this.socket?.send(
            JSON.stringify({
              ...this.result(requestId, message.tool, false, undefined, 3),
              error: { code: failure.code, message: failure.message, retryable: false },
            } satisfies ToolResultMessage),
          );
          return;
        }
        const handler = this.options.handlers?.[message.tool];
        if (!handler) {
          this.socket?.send(
            JSON.stringify({
              ...this.result(requestId, message.tool, false, undefined, 4),
              error: { code: 'not_found', message: `the fake plugin has no handler for ${message.tool}` },
            } satisfies ToolResultMessage),
          );
          return;
        }
        try {
          const data = await handler(message.args ?? {});
          this.socket?.send(JSON.stringify(this.result(requestId, message.tool, true, data, 5, true)));
        } catch (error) {
          this.socket?.send(
            JSON.stringify({
              ...this.result(requestId, message.tool, false, undefined, 6),
              error: { code: 'execution_failed', message: (error as Error).message },
            } satisfies ToolResultMessage),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private result(requestId: string, tool: string, ok: boolean, data: unknown, id: number, verified = false): ToolResultMessage {
    return {
      v: PROTOCOL_VERSION,
      id: `res-${id}-${Date.now()}`,
      type: 'tool_result',
      request_id: requestId,
      tool,
      ok,
      data,
      verified,
      duration_ms: id,
    };
  }

  close(): void {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}
