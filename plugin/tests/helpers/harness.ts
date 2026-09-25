/**
 * Shared wiring for integration tests.
 *
 * Starts a real HTTP server with a real `PluginSession` attached, connects a
 * `FakePlugin` to it, and builds an `Agent` with a scripted model. Everything the tests
 * assert on is therefore the production code path.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Agent } from '../../src/bridge/agent.js';
import { Logger } from '../../src/bridge/log.js';
import { MemoryStore } from '../../src/bridge/memory.js';
import { PluginSession } from '../../src/bridge/session.js';
import { ensureWorkspace, type BridgeConfig } from '../../src/bridge/config.js';
import { makeCapabilities, type FakePluginOptions } from './fake-plugin.js';

export interface Harness {
  session: PluginSession;
  memory: MemoryStore;
  agent: Agent;
  logger: Logger;
  config: BridgeConfig;
  workspace: string;
  paths: ReturnType<typeof ensureWorkspace>;
  wsUrl: string;
  httpUrl: string;
  stop(): Promise<void>;
}

export function makeConfig(workspace: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    workspace,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    allowAnonymous: false,
    logLevel: 'error',
    logFile: null,
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    apiKey: 'test-key-not-real',
    extraHeaders: {},
    maxTokens: 1024,
    temperature: 0,
    maxSteps: 12,
    requestTimeoutMs: 5000,
    enableVision: true,
    enableHttp: true,
    enableMcp: false,
    blockbenchPluginDir: null,
    ...overrides,
  };
}

export async function startHarness(overrides: Partial<BridgeConfig> = {}): Promise<Harness> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ai-agent-test-'));
  const config = makeConfig(workspace, overrides);
  const logger = new Logger('test');
  logger.setLevel('error');
  const paths = ensureWorkspace(config);
  const memory = new MemoryStore(paths, logger);
  const session = new PluginSession(config, logger);

  const server = http.createServer();
  session.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const agent = new Agent(
    session,
    memory,
    {
      maxSteps: config.maxSteps,
      enableVision: config.enableVision,
      workspace,
      defaultAngles: ['view', 'north', 'east', 'top'],
      maxToolResultChars: 8000,
    },
    { viewport: paths.viewport, textures: paths.textures },
    {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      maxTokens: config.maxTokens,
      temperature: 0,
      timeoutMs: 5000,
    },
    logger,
  );

  return {
    session,
    memory,
    agent,
    logger,
    config,
    workspace,
    paths,
    wsUrl: `ws://127.0.0.1:${port}/plugin`,
    httpUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      session.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

export { makeCapabilities };
export type { FakePluginOptions };
