/**
 * The bridge's public surfaces: REST and MCP.
 *
 * Both run against the same live session and fake plugin as the agent tests, so what is
 * asserted here is the real routing, the real token check and the real task queue — not
 * a reimplementation of them.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBridgeServer, type BridgeServer } from '../../src/bridge/server.js';
import { PluginSession } from '../../src/bridge/session.js';
import { MemoryStore } from '../../src/bridge/memory.js';
import { Logger } from '../../src/bridge/log.js';
import { Agent } from '../../src/bridge/agent.js';
import { ensureWorkspace } from '../../src/bridge/config.js';
import { startMcpServer } from '../../src/bridge/mcp.js';
import { makeConfig } from '../helpers/harness.js';
import { FakePlugin } from '../helpers/fake-plugin.js';
import { scriptLlm } from '../helpers/fake-llm.js';
import { createImage, encodeDataUrl } from '../../src/bridge/image.js';
import type { ToolDefinition } from '../../src/shared/protocol.js';

let server: BridgeServer | null = null;
let plugin: FakePlugin | null = null;
let llm: ReturnType<typeof scriptLlm> | null = null;
let workspace: string | null = null;

afterEach(async () => {
  llm?.restore();
  plugin?.close();
  await server?.close();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  server = null;
  plugin = null;
  llm = null;
  workspace = null;
});

const TOOLS: ToolDefinition[] = [
  {
    name: 'inspect_model',
    title: 'Inspect model',
    description: 'Return every cube',
    group: 'inspect',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
    returns: 'ModelSummary',
  },
  {
    name: 'create_cube',
    title: 'Create cube',
    description: 'Create a cube',
    group: 'geometry',
    danger: 'mutating',
    needs_checkpoint: true,
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    returns: 'NodeSummary',
  },
  {
    name: 'validate_model',
    title: 'Validate model',
    description: 'Check the model',
    group: 'inspect',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    returns: '{ issues: string[] }',
  },
];

async function setup(options: { token?: string; allowAnonymous?: boolean } = {}) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-rest-'));
  const logger = new Logger('test');
  logger.setLevel('error');
  const config = makeConfig(workspace, {
    port: 0,
    token: options.token ?? 'secret-token',
    allowAnonymous: options.allowAnonymous ?? false,
    maxSteps: 8,
  });
  const paths = ensureWorkspace(config);
  const memory = new MemoryStore(paths, logger);
  const session = new PluginSession(config, logger);
  const agent = new Agent(
    session,
    memory,
    { maxSteps: config.maxSteps, enableVision: true, workspace, defaultAngles: ['view', 'north'], maxToolResultChars: 6000 },
    { viewport: paths.viewport, textures: paths.textures },
    { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, maxTokens: 1000, temperature: 0, timeoutMs: 4000 },
    logger,
  );

  server = await startBridgeServer({ config, paths, logger, session, memory, agent });
  plugin = new FakePlugin({
    url: `ws://127.0.0.1:${server.port}/plugin`,
    token: config.token,
    tools: TOOLS,
    handlers: {
      inspect_model: () => ({ elements: [{ name: 'body' }], count: 1 }),
      create_cube: (args) => ({ uuid: 'u-1', name: args.name }),
      validate_model: () => ({ issues: [] }),
      get_model_snapshot: () => ({ images: [{ angle: 'view', data_url: encodeDataUrl(createImage(8, 8, [10, 200, 10, 255])), width: 8, height: 8, bytes: 80 }] }),
    },
  });
  await plugin.connect();
  await session.listTools(true);

  return { base: server.url, token: config.token, session, memory, agent, plugin, paths };
}

function get(url: string, token?: string) {
  return fetch(url, { headers: token ? { 'x-agent-token': token } : {} });
}

function post(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-agent-token': token } : {}) },
    body: JSON.stringify(body),
  });
}

describe('REST API', () => {
  it('serves health without a token so monitoring works', async () => {
    const { base } = await setup();
    const response = await get(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.plugin_connected).toBe(true);
    expect(body.auth_required).toBe(true);
  });

  it('rejects a request with no token or a wrong token', async () => {
    const { base, token } = await setup();
    expect((await get(`${base}/tools`)).status).toBe(401);
    expect((await get(`${base}/tools`, 'wrong-token')).status).toBe(401);
    expect((await get(`${base}/tools`, token)).status).toBe(200);
  });

  it('accepts the token from the query string as well, for convenience tools', async () => {
    const { base, token } = await setup();
    const response = await get(`${base}/state?token=${token}`);
    expect(response.status).toBe(200);
  });

  it('lists both the plugin tools and the bridge tools', async () => {
    const { base, token } = await setup();
    const body = (await (await get(`${base}/tools`, token)).json()) as { plugin: ToolDefinition[]; bridge: ToolDefinition[]; count: number };
    expect(body.plugin.map((tool) => tool.name)).toContain('create_cube');
    expect(body.bridge.map((tool) => tool.name)).toContain('bridge_look');
    expect(body.count).toBe(body.plugin.length + body.bridge.length);
  });

  it('calls a tool through the plugin and reports validation failures as 400s', async () => {
    const { base, token, plugin: fake } = await setup();
    const ok = await post(`${base}/tool/inspect_model`, { name: 'body' }, token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, tool: 'inspect_model' });
    expect(fake.calls.at(-1)).toMatchObject({ tool: 'inspect_model', args: { name: 'body' } });

    // Unknown tool: the plugin answers with an error, so the REST layer must not claim success.
    const unknown = await post(`${base}/tool/does_not_exist`, {}, token);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ ok: false });
  });

  it('takes a checkpoint and rolls back to it', async () => {
    const { base, token, plugin: fake, memory } = await setup();
    const created = await post(`${base}/checkpoints`, { label: 'before the tail' }, token);
    expect(created.status).toBe(200);
    const record = (await created.json()) as { checkpoint_id: string };
    expect(record.checkpoint_id).toBeTruthy();

    const listed = (await (await get(`${base}/checkpoints`, token)).json()) as { checkpoints: Array<{ checkpoint_id: string }> };
    expect(listed.checkpoints.map((entry) => entry.checkpoint_id)).toContain(record.checkpoint_id);
    expect(memory.listCheckpoints().length).toBe(1);

    const rolled = await post(`${base}/rollback`, {}, token);
    expect(rolled.status).toBe(200);
    expect(fake.rollbacks).toEqual([record.checkpoint_id]);
  });

  it('runs an agent task to completion over REST and reports the outcome', async () => {
    const { base, token, plugin: fake, memory } = await setup();
    llm = scriptLlm([
      { tool_calls: [{ name: 'inspect_model', arguments: {} }] },
      { tool_calls: [{ name: 'create_cube', arguments: { name: 'leg' } }] },
      { tool_calls: [{ name: 'bridge_look', arguments: {} }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'built a leg', verified: true } }] },
    ]);

    const response = await post(`${base}/task?wait=1&wait_ms=20000`, { prompt: 'add a leg' }, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; state: string; summary: string; verified: boolean; steps: number };
    expect(body.state).toBe('done');
    expect(body.summary).toContain('leg');
    expect(body.verified).toBe(true);
    expect(body.steps).toBeGreaterThan(0);

    const described = (await (await get(`${base}/task/${body.id}`, token)).json()) as { state: string };
    expect(described.state).toBe('done');

    // The task is auditable afterwards: the mutating call is in the history, the
    // checkpoint it took is indexed, and the capture was written next to the project.
    const memoryView = (await (await get(`${base}/memory`, token)).json()) as { history: Array<{ summary: string }> };
    expect(memoryView.history.some((entry) => entry.summary.includes('create_cube'))).toBe(true);
    expect(memory.listCheckpoints().length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.map((call) => call.tool)).toEqual(['inspect_model', 'create_cube', 'get_model_snapshot']);
  }, 30000);

  it('answers 404 with the offending path for an unknown route', async () => {
    const { base, token } = await setup();
    const response = await get(`${base}/nope`, token);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('no route');
  });

  it('lists references and logs', async () => {
    const { base, token, paths } = await setup();
    fs.writeFileSync(path.join(paths.references, 'ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const references = (await (await get(`${base}/references`, token)).json()) as { references: Array<{ name: string; base64?: string }> };
    expect(references.references.map((entry) => entry.name)).toEqual(['ref.png']);
    // The REST view must not ship megabytes of base64 back to a caller.
    expect(references.references[0].base64).toBeUndefined();
    const logs = (await (await get(`${base}/logs`, token)).json()) as { lines: unknown[] };
    expect(Array.isArray(logs.lines)).toBe(true);
  });
});

describe('MCP surface', () => {
  async function mcpHarness() {
    const context = await setup();
    const out: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const bridge = startMcpServer({ session: context.session, agent: context.agent, logger: new Logger('mcp-test') });
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;
    return {
      ...context,
      out,
      bridge,
      async ask(message: unknown): Promise<Record<string, unknown> | null> {
        const before = out.length;
        await bridge.handle(JSON.stringify(message));
        for (let i = before; i < out.length; i++) {
          const line = out[i].trim();
          if (line) return JSON.parse(line) as Record<string, unknown>;
        }
        return null;
      },
      restore() {
        (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
      },
    };
  }

  it('answers initialize with the live Blockbench version and the connection state', async () => {
    const mcp = await mcpHarness();
    try {
      const response = await mcp.ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      const result = response?.result as { serverInfo: { name: string }; instructions: string };
      expect(result.serverInfo.name).toContain('blockbench');
      expect(result.instructions).toContain('5.2.1');
    } finally {
      mcp.restore();
    }
  });

  it('lists the same tools the plugin reported, with their schemas', async () => {
    const mcp = await mcpHarness();
    try {
      const response = await mcp.ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['create_cube', 'inspect_model', 'bridge_look']));
      const createCube = tools.find((tool) => tool.name === 'create_cube');
      expect(createCube?.inputSchema.type).toBe('object');
    } finally {
      mcp.restore();
    }
  });

  it('forwards tools/call to the plugin and reports errors as isError', async () => {
    const mcp = await mcpHarness();
    try {
      const ok = await mcp.ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_model', arguments: {} } });
      expect((ok?.result as { isError: boolean }).isError).toBe(false);
      expect(JSON.stringify(ok?.result)).toContain('body');

      const missing = await mcp.ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } });
      expect((missing?.result as { isError: boolean }).isError).toBe(true);
      expect(JSON.stringify(missing?.result)).toMatch(/unknown tool/i);
    } finally {
      mcp.restore();
    }
  });

  it('exposes the live state as a readable MCP resource', async () => {
    const mcp = await mcpHarness();
    try {
      mcp.session.state ?? null;
      const response = await mcp.ask({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'blockbench://state' } });
      const contents = (response?.result as { contents: Array<{ text: string }> }).contents;
      expect(contents[0].text).toContain('connected');
    } finally {
      mcp.restore();
    }
  });

  it('answers an unknown method with the JSON-RPC method-not-found error', async () => {
    const mcp = await mcpHarness();
    try {
      const response = await mcp.ask({ jsonrpc: '2.0', id: 9, method: 'prompts/list' });
      expect((response?.error as { code: number }).code).toBe(-32601);
    } finally {
      mcp.restore();
    }
  });
});
