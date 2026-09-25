/**
 * Agent Bridge entry point.
 *
 * Commands:
 *   --serve              run the WebSocket + REST bridge (default)
 *   --task "<prompt>"    run one autonomous task and exit
 *   --tool <name>        call one tool directly and exit
 *   --doctor             environment report (also copies the plugin if it is stale)
 *   --install-plugin     copy the built plugin into Blockbench's plugins folder
 *   --mcp                speak MCP on stdio instead of serving HTTP
 *
 * The bridge never writes into the Blockbench installation folder. The only thing it
 * touches outside the workspace is the plugins folder inside Blockbench's *user data*
 * directory, and only when explicitly asked to install.
 */

import path from 'node:path';
import process from 'node:process';
import { HELP_TEXT, describeForLog, ensureWorkspace, resolveConfig } from './config.js';
import { Logger } from './log.js';
import { MemoryStore } from './memory.js';
import { PluginSession, SESSION_EVENTS } from './session.js';
import { Agent } from './agent.js';
import { startBridgeServer } from './server.js';
import { startMcpServer } from './mcp.js';
import { installPlugin } from './installer.js';
import { formatDoctorReport, runDoctor } from './doctor.js';

const DEFAULT_ANGLES = ['view', 'north', 'east', 'top', 'isometric_right'];

async function main(): Promise<number> {
  let parsed: ReturnType<typeof resolveConfig>;
  try {
    parsed = resolveConfig();
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const { config, flags } = parsed;

  if (flags.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const logger = new Logger('bridge');
  logger.setLevel(config.logLevel);
  const paths = ensureWorkspace(config);
  logger.attachFile(config.logFile ?? path.join(paths.context, 'bridge.log'));
  logger.info('bridge starting', describeForLog(config));

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
      maxToolResultChars: 12000,
    },
    { viewport: paths.viewport, textures: paths.textures },
    {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      extraHeaders: config.extraHeaders,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
    },
    logger,
  );

  /* -------------------------------------------------------------- one-shot commands */

  if (flags.installPlugin) {
    const result = installPlugin(config, logger);
    if (!result.installed) {
      console.error(`✖ ${result.reason}`);
      return 1;
    }
    console.log(`✔ plugin ${result.alreadyPresent ? 'already current' : 'installed'} at ${result.target}`);
    console.log(
      result.alreadyPresent
        ? '  It is already in Blockbench\'s plugins folder; if it is not loading, use File → Plugins… → "Load Plugin from File" once.'
        : '  Next: open Blockbench, then File → Plugins… → "Load Plugin from File" and pick that path. It stays installed after that.',
    );
    return 0;
  }

  if (flags.doctor) {
    const report = await runDoctor({ config, paths, logger, session, memory, forceReinstall: false });
    console.log(formatDoctorReport(report));
    const url = `ws://${config.host}:${config.port}/plugin${config.allowAnonymous ? '' : `?token=${config.token}`}`;
    console.log(`\nPlugin Bridge URL: ${url}`);
    return report.summary.fail > 0 ? 1 : 0;
  }

  if (flags.tool) {
    let args: Record<string, unknown> = {};
    if (flags.toolArgs) {
      try {
        args = JSON.parse(flags.toolArgs) as Record<string, unknown>;
      } catch (error) {
        console.error(`--args must be JSON: ${(error as Error).message}`);
        return 2;
      }
    }
    const server = await startBridgeServer({ config, paths, logger, session, memory, agent });
    const connected = await waitForPlugin(session, 12000);
    if (!connected) {
      console.error('The Blockbench plugin did not connect within 12s. Open Blockbench with the AI Agent plugin enabled, then try again.');
      await server.close();
      return 1;
    }
    const outcome = await session.callTool(flags.tool, args, { taskId: 'cli', timeoutMs: 180000 });
    console.log(JSON.stringify(outcome, null, 2));
    await server.close();
    return outcome.ok ? 0 : 1;
  }

  if (flags.task) {
    const server = await startBridgeServer({ config, paths, logger, session, memory, agent });
    const connected = await waitForPlugin(session, 20000);
    if (!connected) {
      console.error('The Blockbench plugin did not connect within 20s. Start Blockbench first.');
      await server.close();
      return 1;
    }
    console.log(`▸ task: ${flags.task}`);
    const record = await server.startTask(flags.task);
    const result = await waitForTask(server.tasks, record.id, (label) => process.stdout.write(`\r  ${label.padEnd(78).slice(0, 78)}`));
    process.stdout.write('\n');
    if (result?.result) {
      console.log(`\n${result.result.ok ? '✔' : '✖'} ${result.result.summary}`);
      console.log(
        `  ${result.result.steps} steps · ${result.result.tool_calls} tool calls · ${result.result.checkpoints.length} checkpoints · verified=${
          result.result.verified
        } · saved=${result.result.saved}`,
      );
      if (result.error) console.error(`  error: ${result.error}`);
    } else {
      console.error(result?.error ?? 'task produced no result');
    }
    await server.close();
    return result?.state === 'done' ? 0 : 1;
  }

  if (flags.mcp) {
    // MCP owns stdio, so nothing else may write to stdout. Logs go to the file only.
    const serverless = new Logger('mcp');
    serverless.setLevel('warn');
    serverless.attachFile(config.logFile ?? path.join(paths.context, 'bridge.log'));
    startMcpServer({ session, agent, logger: serverless, options: { readOnly: false } });
    // The plugin socket still needs a place to attach, and MCP hosts expect the bridge
    // to be reachable while they work, so serve on a random free port.
    const server = await startBridgeServer({ config, paths, logger: serverless, session, memory, agent });
    serverless.warn(`MCP mode: waiting for the plugin on ws://${config.host}:${server.port}/plugin`);
    process.stdin.on('end', () => {
      void server.close().then(() => process.exit(0));
    });
    return await new Promise<number>(() => {
      /* runs until stdin closes */
    });
  }

  /* ------------------------------------------------------------------ serve mode */

  const server = await startBridgeServer({ config, paths, logger, session, memory, agent });
  const url = `ws://${config.host}:${server.port}/plugin${config.allowAnonymous ? '' : `?token=${config.token}`}`;

  session.on(SESSION_EVENTS.status, (payload: { status: string }) => {
    if (payload.status === 'connected') logger.info('plugin link established — the agent can build now');
    if (payload.status === 'disconnected') logger.warn('plugin link lost — the bridge keeps running and will reconnect');
  });

  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────────────┐');
  console.log('│  Blockbench AI Agent — bridge is running                             │');
  console.log('└──────────────────────────────────────────────────────────────────────┘');
  console.log(`  REST + state :  ${server.url}`);
  console.log(`  Plugin socket:  ${url}`);
  console.log(`  Workspace    :  ${config.workspace}`);
  console.log(`  Model        :  ${config.provider === 'none' ? '(none configured — tools still work)' : `${config.model} via ${config.baseUrl}`}`);
  console.log(`  Vision       :  ${config.enableVision ? 'on' : 'off'}`);
  console.log('');
  console.log('  In Blockbench: AI Agent panel → paste the Plugin socket URL above into');
  console.log('  "Bridge URL" (it already includes the token) → press Connect.');
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    await server.close();
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error(`unhandled rejection: ${String(reason)}`));

  return await new Promise<number>(() => {
    /* serve forever */
  });
}

async function waitForPlugin(session: PluginSession, timeoutMs: number): Promise<boolean> {
  if (session.connected) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      session.off(SESSION_EVENTS.status, onStatus);
      resolve(false);
    }, timeoutMs);
    const onStatus = (payload: { status: string }): void => {
      if (payload.status === 'connected') {
        clearTimeout(timer);
        session.off(SESSION_EVENTS.status, onStatus);
        resolve(true);
      }
    };
    session.on(SESSION_EVENTS.status, onStatus);
  });
}

async function waitForTask(
  tasks: Map<string, { state: string; progress: { label: string } | null; result: unknown; error: string | null }>,
  id: string,
  onTick: (label: string) => void,
): Promise<{ state: string; result: { ok: boolean; summary: string; steps: number; tool_calls: number; checkpoints: string[]; verified: boolean; saved: boolean } | null; error: string | null } | null> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const record = tasks.get(id);
      if (!record) return;
      if (record.progress) onTick(record.progress.label);
      if (record.state === 'done' || record.state === 'error' || record.state === 'cancelled') {
        clearInterval(timer);
        resolve({
          state: record.state,
          result: record.result as { ok: boolean; summary: string; steps: number; tool_calls: number; checkpoints: string[]; verified: boolean; saved: boolean } | null,
          error: record.error,
        });
      }
    }, 250);
  });
}

main()
  .then((code) => {
    if (code !== 0 && Number.isFinite(code)) process.exitCode = code;
  })
  .catch((error) => {
    console.error(`bridge crashed: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 1;
  });

