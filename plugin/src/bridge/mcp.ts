/**
 * MCP server (stdio).
 *
 * Requirement #9 asked for a real-time bridge; MCP is how that bridge becomes useful to
 * hosts other than our own agent — Claude Desktop, Cursor, an IDE, a shell. The
 * protocol surface is small (JSON-RPC 2.0 over stdio with newline-delimited messages)
 * and the tools are not reimplemented: `tools/list` returns the catalogue the running
 * plugin actually reported, and `tools/call` forwards straight to it. Connected agents
 * therefore inherit the same validation and checkpoints as ours.
 *
 * Read-only tools are advertised, mutating ones are too — but honour `--read-only`,
 * because an MCP host that decides to "tidy up" a user's model unasked is a bad
 * neighbour.
 */

import type { ToolDefinition } from '../shared/protocol.js';
import type { Logger } from './log.js';
import type { PluginSession } from './session.js';
import type { Agent } from './agent.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

export interface McpOptions {
  readOnly?: boolean;
  /** Server name shown in the host's UI. */
  name?: string;
}

export interface McpBridge {
  handle(line: string): Promise<string | null>;
  stop(): void;
}

function toMcpTool(definition: ToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: `${definition.title} — ${definition.description}\n\nReturns: ${definition.returns}`,
    inputSchema: definition.schema,
    annotations: {
      title: definition.title,
      readOnlyHint: definition.danger === 'safe',
      destructiveHint: definition.danger === 'destructive',
    },
  };
}

export function startMcpServer(deps: { session: PluginSession; agent: Agent; logger: Logger; options?: McpOptions }): McpBridge {
  const { session, agent, logger } = deps;
  const options = deps.options ?? {};
  let initialised = false;

  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id: JsonRpcRequest['id'], result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): void =>
    write({ jsonrpc: '2.0', id, error: { code, message, data } });

  const catalog = (): ToolDefinition[] => {
    const tools = [...session.cachedTools(), ...agent.localDefinitions()];
    if (!options.readOnly) return tools;
    return tools.filter((definition) => definition.danger === 'safe');
  };

  const bridge: McpBridge = {
    async handle(line: string): Promise<string | null> {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (error) {
        fail(null, -32700, `parse error: ${(error as Error).message}`);
        return null;
      }
      if (request.id === undefined) {
        // Notification: no reply is allowed.
        if (request.method === 'notifications/initialized') initialised = true;
        return null;
      }

      switch (request.method) {
        case 'initialize': {
          respond(request.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? 'blockbench-ai-agent-bridge', version: '0.1.0' },
            instructions: session.connected
              ? `Connected to Blockbench ${session.capabilities?.blockbench_version ?? '?'} (format: ${session.capabilities?.active_format ?? 'none'}). Call inspect_project first: it returns the live workspace state. Mutating tools take a checkpoint automatically where it matters.${options.readOnly ? ' This server is in read-only mode: only safe tools are exposed.' : ''}`
              : 'The Blockbench plugin is NOT connected. Start Blockbench with the AI Agent plugin enabled and press Connect, then retry.',
          });
          return null;
        }
        case 'ping':
          respond(request.id, {});
          return null;
        case 'tools/list':
          respond(request.id, { tools: catalog().map(toMcpTool) });
          return null;
        case 'resources/list':
          respond(request.id, {
            resources: [
              {
                uri: 'blockbench://state',
                name: 'Blockbench workspace state',
                description: 'Live project, hierarchy, animation and viewport state',
                mimeType: 'application/json',
              },
            ],
          });
          return null;
        case 'resources/read': {
          const uri = String((request.params?.uri as string) ?? '');
          if (uri !== 'blockbench://state') {
            fail(request.id, -32602, `unknown resource ${uri}`);
            return null;
          }
          respond(request.id, {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(session.state ?? { connected: false, reason: 'plugin not connected' }, null, 2),
              },
            ],
          });
          return null;
        }
        case 'tools/call': {
          const name = String(request.params?.name ?? '');
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          const definition = catalog().find((tool) => tool.name === name);
          if (!definition) {
            respond(request.id, {
              isError: true,
              content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${catalog().map((tool) => tool.name).join(', ')}` }],
            });
            return null;
          }
          const local = agent.localDefinitions().some((tool) => tool.name === name);
          logger.debug(`MCP tools/call ${name}${local ? ' (bridge tool)' : ''}`);
          if (local) {
            // Bridge tools are only reachable through the agent loop; expose the subset
            // that makes sense standalone by routing through the plugin when possible.
            respond(request.id, {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `"${name}" is a bridge-internal tool (memory, contact sheets, task control). Use the bridge REST API (POST /task) or the Blockbench panel for those; MCP exposes the Blockbench tool registry.`,
                },
              ],
            });
            return null;
          }
          const outcome = await session.callTool(name, args, { taskId: 'mcp', timeoutMs: 180000 });
          respond(request.id, {
            isError: !outcome.ok,
            content: [
              {
                type: 'text',
                text: outcome.ok
                  ? JSON.stringify(outcome.data, null, 2)
                  : `ERROR ${outcome.error?.code ?? 'failed'}: ${outcome.error?.message ?? 'unknown error'}`,
              },
              ...(outcome.warnings?.length ? [{ type: 'text', text: `WARNINGS: ${outcome.warnings.join(' | ')}` }] : []),
            ],
            structuredContent: outcome.ok ? { data: outcome.data, verified: outcome.verified ?? false } : undefined,
          });
          return null;
        }
        default:
          fail(request.id, -32601, `method not found: ${request.method}`);
          return null;
      }
    },
    stop() {
      void initialised;
      logger.debug('MCP server stopping');
    },
  };

  /* ------------------------------------------------------------ stdio plumbing */

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      void bridge.handle(line).catch((error) => logger.error(`MCP handler failed: ${(error as Error).message}`));
    }
  });
  process.stdin.on('end', () => bridge.stop());

  return bridge;
}
