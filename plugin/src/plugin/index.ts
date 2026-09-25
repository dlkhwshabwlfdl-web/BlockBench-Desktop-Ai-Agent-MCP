/**
 * Blockbench AI Agent — plugin entry point.
 *
 * Registers the plugin, wires the tool registry, the realtime state publisher, the
 * checkpoint manager and the bridge link, and exposes the small UI the brief asked
 * for. This file is the only place that knows about all the pieces; everything it
 * imports is independently testable (see `tests/`).
 *
 * Loading note: Blockbench executes plugin code through
 * `new Function('requireNativeModule', 'require', code)`, so this file and its whole
 * bundle must be a single IIFE with no imports at runtime. That is why the build
 * targets `format: 'iife'` and why the plugin talks to `window` globals instead of
 * importing Blockbench modules.
 */

import {
  bb,
  format,
  maybeProject,
  panelsApi,
  tryGlobal,
  type BBAnimation,
} from './env.js';
import { PLUGIN_AUTHOR, PLUGIN_VERSION } from './meta.js';
import { probeCapabilities, summariseCapabilities } from './capabilities.js';
import { BridgeClient, type LinkStatus, type ToolHandlerContext } from './bridge-client.js';
import { StatePublisher, buildStateSnapshot } from './state.js';
import { CheckpointManager } from './checkpoints.js';
import { buildRegistry, type ToolRegistry } from './tools/index.js';
import type { ToolContext } from './tools/registry.js';
import { isTransactionActive } from './tools/project.js';
import { AgentPanel } from './ui/panel.js';
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, PLUGIN_SOCKET_PATH, PROTOCOL_VERSION, normalizeBridgeUrl, type CapabilityReport, type PluginStateSnapshot, type ToolDefinition } from '../shared/protocol.js';
import { PLUGIN_ID, PLUGIN_TITLE } from './meta.js';

const DEFAULT_BRIDGE_URL = `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}${PLUGIN_SOCKET_PATH}`;

interface RuntimeState {
  registry: ToolRegistry | null;
  publisher: StatePublisher | null;
  checkpoints: CheckpointManager | null;
  client: BridgeClient | null;
  panel: AgentPanel | null;
  actions: Array<{ delete(): void }>;
  toolbar: { delete?(): void } | null;
  settings: Record<string, { value: unknown; set?(value: unknown): void }>;
  lastCapabilities: CapabilityReport | null;
  currentTaskId: string | null;
  disposeHooks: Array<() => void>;
}

const runtime: RuntimeState = {
  registry: null,
  publisher: null,
  checkpoints: null,
  client: null,
  panel: null,
  actions: [],
  toolbar: null,
  settings: {},
  lastCapabilities: null,
  currentTaskId: null,
  disposeHooks: [],
};

/* ------------------------------------------------------------------ settings */

function registerSetting(id: string, data: Record<string, unknown>): void {
  const SettingCtor = tryGlobal<new (id: string, data: Record<string, unknown>) => { value: unknown; set?(v: unknown): void }>('Setting');
  if (typeof SettingCtor !== 'function') {
    console.warn('[ai-agent] Setting API unavailable; using defaults');
    return;
  }
  const setting = new SettingCtor(id, { plugin: PLUGIN_ID, ...data });
  runtime.settings[id] = setting;
}

function settingValue<T>(id: string, fallback: T): T {
  const setting = runtime.settings[id];
  const value = setting?.value;
  return (value === undefined ? fallback : (value as T)) ?? fallback;
}

function registerSettings(): void {
  registerSetting('ai_agent_auto_connect', {
    name: 'Connect on startup',
    description: 'Try to reach the bridge as soon as Blockbench opens',
    type: 'toggle',
    value: true,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_bridge_url', {
    name: 'Bridge URL',
    description: 'WebSocket address of the local Agent Bridge',
    type: 'text',
    value: DEFAULT_BRIDGE_URL,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_auto_connect', {
    name: 'Connect on startup',
    description: 'Try to reach the bridge as soon as Blockbench opens',
    type: 'toggle',
    value: true,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_bridge_token', {
    name: 'Bridge token',
    description: 'Session token printed by the bridge. Required when the bridge enforces authentication.',
    type: 'text',
    value: '',
    category: 'ai_agent',
  });
  registerSetting('ai_agent_realtime', {
    name: 'Realtime state',
    description: 'Continuously push project changes to the agent instead of only on request',
    type: 'toggle',
    value: true,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_state_interval', {
    name: 'State debounce (ms)',
    description: 'How long to coalesce Blockbench events before pushing a state update',
    type: 'number',
    value: 150,
    min: 0,
    max: 2000,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_auto_checkpoint', {
    name: 'Automatic checkpoints',
    description: 'Let destructive agent tools take a checkpoint before they run',
    type: 'toggle',
    value: true,
    category: 'ai_agent',
  });
  registerSetting('ai_agent_allow_scripts', {
    name: 'Allow run_script',
    description: 'Permit the agent to execute raw JavaScript inside Blockbench. Leave off unless you need it.',
    type: 'toggle',
    value: false,
    category: 'ai_agent',
  });
}

/* ------------------------------------------------------------ tool execution */

function makeToolContext(requestId: string): ToolContext {
  const checkpoints = runtime.checkpoints!;
  return {
    requestId,
    capabilities: runtime.lastCapabilities ?? probeCapabilities(),
    checkpoints,
    // Evaluated per request: a transaction can only be opened by a previous call, so
    // snapshotting it here is exactly right.
    undoEnabled: !isTransactionActive(),
    throwIfCancelled: () => {
      /* replaced by the bridge client for real requests */
    },
    reportProgress: () => {
      /* replaced by the bridge client for real requests */
    },
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
      runtime.panel?.log(level, message);
      console.log(`[ai-agent] ${level}: ${message}`);
    },
    refreshState: () => {
      runtime.publisher?.flush();
    },
    autoCheckpoint: (label: string) => {
      if (!settingValue('ai_agent_auto_checkpoint', true)) return null;
      try {
        const record = checkpoints.create(label, false);
        return record.id;
      } catch (error) {
        runtime.panel?.log('warn', `checkpoint failed: ${(error as Error).message}`);
        return null;
      }
    },
  };
}

function exposedTools(): ToolDefinition[] {
  const registry = runtime.registry;
  if (!registry) return [];
  return registry.list().map((definition) => {
    if (!settingValue('ai_agent_auto_checkpoint', true) && definition.needs_checkpoint) {
      return { ...definition, needs_checkpoint: false };
    }
    return definition;
  });
}

/* ------------------------------------------------------------------- actions */

function registerActions(): void {
  const ActionCtor = tryGlobal<new (id: string, data: Record<string, unknown>) => { delete(): void }>('Action');
  const MenuBar = tryGlobal<{ addAction(action: unknown, path?: string): void }>('MenuBar');
  if (typeof ActionCtor !== 'function') {
    console.warn('[ai-agent] Action API unavailable; skipping UI actions');
    return;
  }

  const add = (id: string, data: Record<string, unknown>) => {
    const action = new ActionCtor(id, data);
    runtime.actions.push(action);
    try {
      MenuBar?.addAction(action, 'tools.ai_agent');
    } catch {
      /* menu path is best effort */
    }
    return action;
  };

  add('ai_agent_observe', {
    name: 'AI Agent: Observe',
    description: 'Inspect the workspace and send the current state to the agent',
    icon: 'visibility',
    category: 'tools',
    click: () => observe(),
  });
  add('ai_agent_ask', {
    name: 'AI Agent: Ask',
    description: 'Send a prompt to the agent',
    icon: 'smart_toy',
    category: 'tools',
    click: () => askFromPrompt(),
  });
  add('ai_agent_stop', {
    name: 'AI Agent: Stop',
    description: 'Cancel the running agent task',
    icon: 'stop_circle',
    category: 'tools',
    click: () => stopTask(),
  });
  add('ai_agent_checkpoint', {
    name: 'AI Agent: Checkpoint',
    description: 'Record a restorable checkpoint of the current project',
    icon: 'bookmark_add',
    category: 'tools',
    click: () => takeCheckpoint(),
  });
  add('ai_agent_rollback', {
    name: 'AI Agent: Rollback',
    description: 'Roll back to the most recent checkpoint',
    icon: 'history',
    category: 'tools',
    click: () => rollbackLast(),
  });
  add('ai_agent_connect', {
    name: 'AI Agent: Connect',
    description: 'Connect or disconnect the bridge',
    icon: 'cable',
    category: 'tools',
    click: () => {
      if (runtime.client?.isConnected) {
        runtime.client.disconnect();
        runtime.panel?.log('info', 'disconnected');
      } else {
        connect();
      }
    },
  });
  add('ai_agent_capabilities', {
    name: 'AI Agent: Capabilities',
    description: 'Print the capability report to the console',
    icon: 'fact_check',
    category: 'tools',
    click: () => {
      const report = probeCapabilities();
      runtime.lastCapabilities = report;
      console.log('[ai-agent] capability report', report);
      bb().showQuickMessage?.('Capability report written to the console');
    },
  });
}

function registerToolbar(): void {
  const ToolbarCtor = tryGlobal<new (id: string, data: Record<string, unknown>) => unknown>('Toolbar');
  if (typeof ToolbarCtor !== 'function') return;
  try {
    runtime.toolbar = new ToolbarCtor('ai_agent', {
      name: 'AI Agent',
      children: ['ai_agent_observe', 'ai_agent_ask', 'ai_agent_stop', 'ai_agent_checkpoint', 'ai_agent_rollback', 'ai_agent_connect'],
      condition: () => true,
    }) as { delete?(): void };
  } catch (error) {
    console.warn('[ai-agent] toolbar unavailable', error);
  }
}

/* -------------------------------------------------------------------- bridge */

/**
 * Re-probe and push the capability report.
 *
 * The report is not a boot constant. Format-dependent capabilities — bone rigs, meshes,
 * locators, the project codec — read as "unavailable" while Blockbench is still on its
 * start screen, and an agent that believes those are missing will plan a worse model.
 * Probing is cheap (it only reads constructors and format flags), but it is debounced so
 * that opening a project, which fires several of these events in a burst, does one probe.
 */
let capabilityTimer: ReturnType<typeof setTimeout> | null = null;
let lastCapabilitySignature = '';

function republishCapabilities(reason: 'project_opened' | 'format_changed' | 'requested'): void {
  if (capabilityTimer !== null) clearTimeout(capabilityTimer);
  capabilityTimer = setTimeout(() => {
    capabilityTimer = null;
    if (!runtime.client?.isConnected) return;
    try {
      const report = probeCapabilities();
      const signature = JSON.stringify({
        format: report.active_format,
        mode: report.mode,
        features: report.features.map((feature) => `${feature.id}:${feature.available}`),
        limits: report.limitations,
      });
      runtime.lastCapabilities = report;
      // Only send when something actually changed, otherwise every click of Observe
      // would push a report identical to the last one.
      if (signature === lastCapabilitySignature && reason !== 'requested') return;
      lastCapabilitySignature = signature;
      runtime.client.publishCapabilities(report, reason);
      runtime.panel?.log('info', summariseCapabilities(report));
      for (const limitation of report.limitations) runtime.panel?.log('warn', limitation);
    } catch (error) {
      runtime.panel?.log('warn', `capability re-probe failed: ${(error as Error).message}`);
    }
  }, 120);
}

function currentBridgeConfig(): { url: string; token: string; realtime: boolean } {
  return {
    // Normalised: a stored value without a path (`ws://127.0.0.1:47311`) is corrected
    // before it ever reaches the socket, so upgrades cannot be dropped by the server.
    url: normalizeBridgeUrl(String(settingValue('ai_agent_bridge_url', '') ?? ''), DEFAULT_BRIDGE_URL),
    token: settingValue('ai_agent_bridge_token', '') || '',
    realtime: settingValue('ai_agent_realtime', true),
  };
}

function connect(): void {
  const { url, token } = currentBridgeConfig();
  runtime.panel?.setConnection(url, token, settingValue('ai_agent_realtime', true));
  runtime.panel?.log('info', `connecting to ${url}`);
  console.log(`[ai-agent] connecting to ${url}`);
  if (runtime.client) {
    runtime.client.configure(url, token);
    runtime.client.connect();
  }
}

function handleStatus(status: LinkStatus, detail = ''): void {
  runtime.panel?.setStatus(status, detail);
  runtime.publisher?.setConnected(status === 'connected');
  if (status === 'connected') {
    runtime.panel?.log('info', 'connected to the bridge');
    // The boot-time report was taken with no project open. Correct it immediately so the
    // agent never starts a task believing the wrong capabilities.
    republishCapabilities('project_opened');
  } else if (status === 'rejected') {
    runtime.panel?.log('error', `bridge rejected the session: ${detail}`);
  } else if (status === 'disconnected' && detail) {
    runtime.panel?.log('warn', `disconnected: ${detail}`);
  }
}

/* -------------------------------------------------------------- ui callbacks */

function observe(): void {
  try {
    runtime.publisher?.flush();
    const state = buildStateSnapshot(runtime.client?.isConnected ?? false);
    runtime.panel?.update(state);
    runtime.panel?.log('info', `state pushed (revision ${state.revision})`);
    if (runtime.client?.isConnected) {
      runtime.client.publishLog('info', 'workspace inspected from the Blockbench panel');
      // Observe means "tell me everything": the state and the capabilities are both part
      // of that, so refresh both.
      republishCapabilities('requested');
    }
  } catch (error) {
    runtime.panel?.log('error', `observe failed: ${(error as Error).message}`);
  }
}

function askFromPrompt(): void {
  const prompt = readPrompt();
  if (!prompt) {
    bb().showQuickMessage('Type a prompt in the AI Agent panel first');
    return;
  }
  void ask(prompt);
}

function readPrompt(): string {
  const panelRoot = (runtime.panel as unknown as { panel?: { node?: HTMLElement } })?.panel?.node;
  const textarea = panelRoot?.querySelector('textarea');
  return (textarea?.value ?? '').trim();
}

async function ask(prompt: string): Promise<void> {
  if (!runtime.client?.isConnected) {
    runtime.panel?.log('error', 'not connected to the bridge; press Connect first');
    bb().showQuickMessage('AI Agent: bridge not connected');
    return;
  }
  const taskId = `task-${Date.now().toString(36)}`;
  runtime.currentTaskId = taskId;
  runtime.panel?.log('info', `task started: ${prompt.slice(0, 120)}`);
  const project = maybeProject();
  runtime.client.send({
    v: PROTOCOL_VERSION,
    id: taskId,
    type: 'agent_task',
    request_id: taskId,
    prompt,
    context: {
      project_name: project ? String(project.name ?? '') : null,
      format_id: (() => {
        try {
          return format().id;
        } catch {
          return null;
        }
      })(),
      save_path: project ? (project.save_path ?? null) : null,
      capabilities: runtime.lastCapabilities ?? probeCapabilities(),
    },
  });
}

function stopTask(): void {
  if (!runtime.client?.isConnected) {
    runtime.panel?.log('warn', 'nothing to stop: bridge not connected');
    return;
  }
  runtime.client.send({
    v: PROTOCOL_VERSION,
    id: `stop-${Date.now().toString(36)}`,
    type: 'agent_stop',
    request_id: runtime.currentTaskId ?? undefined,
    reason: 'stopped from the Blockbench panel',
  });
  runtime.panel?.log('warn', 'stop requested');
}

function takeCheckpoint(): void {
  try {
    const record = runtime.checkpoints!.create('manual checkpoint (panel)', true);
    runtime.panel?.log('info', `checkpoint ${record.id} created (${record.counts.elements} cubes)`);
    bb().showQuickMessage?.(`Checkpoint saved: ${record.label}`);
  } catch (error) {
    runtime.panel?.log('error', `checkpoint failed: ${(error as Error).message}`);
  }
}

function rollbackLast(): void {
  try {
    const list = runtime.checkpoints!.list();
    if (!list.length) {
      bb().showQuickMessage('No checkpoints recorded yet');
      return;
    }
    const result = runtime.checkpoints!.restore(list[list.length - 1].id);
    runtime.panel?.log(
      result.verified ? 'info' : 'warn',
      `rollback via ${result.strategy} (${result.undo_steps} steps) — ${result.verified ? 'verified' : 'NOT verified'}`,
    );
    observe();
  } catch (error) {
    runtime.panel?.log('error', `rollback failed: ${(error as Error).message}`);
  }
}

function openLogs(): void {
  const openDevTools = tryGlobal<() => void>('openDevTools');
  if (typeof openDevTools === 'function') openDevTools();
  else runtime.panel?.log('info', 'DevTools are only available in the desktop app');
}

/* -------------------------------------------------------------------- wiring */

function buildRuntime(): void {
  registerSettings();

  runtime.checkpoints = new CheckpointManager(40, (step, total, label) => runtime.panel?.setProgress(step, total, label));
  runtime.registry = buildRegistry({ isScriptEnabled: () => settingValue('ai_agent_allow_scripts', false) });

  runtime.publisher = new StatePublisher(
    settingValue('ai_agent_state_interval', 150),
    (state: PluginStateSnapshot, changed: string[]) => {
      runtime.panel?.update(state);
      runtime.client?.publishState(state.revision, changed, state);
    },
    (name, data) => {
      // High signal events only; the state update already carries the rest.
      if (['add_cube', 'add_group', 'add_animation', 'select_animation', 'save_project'].includes(name)) {
        runtime.client?.publishEvent(name, typeof data === 'object' ? undefined : data);
      }
      // The capability report is format-dependent: nothing about bones, meshes, UV
      // storage or the project codec can be known before a project is open. Re-probe as
      // soon as that changes instead of letting a boot-time "unavailable" stand.
      if (name === 'select_project' || name === 'load_project' || name === 'setup_project' || name === 'new_project') {
        republishCapabilities('project_opened');
      } else if (name === 'select_format') {
        republishCapabilities('format_changed');
      }
    },
    (message) => runtime.panel?.log('warn', message),
  );
  runtime.publisher.setConnected(false);

  runtime.client = new BridgeClient(
    {
      getTools: () => exposedTools(),
      getCapabilities: () => runtime.lastCapabilities ?? probeCapabilities(),
      callTool: async (tool: string, args: Record<string, unknown>, ctx: ToolHandlerContext) => {
        const registry = runtime.registry;
        if (!registry) throw new Error('Tool registry is not initialised');
        const fullCtx = Object.assign(makeToolContext(ctx.requestId), {
          throwIfCancelled: ctx.throwIfCancelled,
          reportProgress: ctx.reportProgress,
        });
        const definition = registry.list().find((entry) => entry.name === tool);
        if (definition?.needs_checkpoint && settingValue('ai_agent_auto_checkpoint', true)) {
          fullCtx.autoCheckpoint(`before ${tool}`);
        }
        const result = await registry.dispatch(tool, args, fullCtx);
        return { data: result.data, warnings: result.warnings, verified: result.verified };
      },
      createCheckpoint: async (label, includeSnapshot) => {
        const record = runtime.checkpoints!.create(label, includeSnapshot);
        return {
          checkpoint_id: record.id,
          label: record.label,
          snapshot: record.snapshot ? { model: record.snapshot.model, project_name: record.snapshot.project_name, format_id: record.snapshot.format_id } : null,
          undo_index: record.undo_index,
          undo_length: record.undo_length,
          created_at: record.created_at,
        };
      },
      restoreCheckpoint: async (checkpointId) => {
        const result = runtime.checkpoints!.restore(checkpointId);
        return {
          checkpoint_id: result.checkpoint_id,
          label: result.label,
          snapshot: null,
          undo_index: result.verification.after ? 0 : 0,
          undo_length: result.undo_steps,
          created_at: Date.now(),
        };
      },
      onStatus: (status, detail) => handleStatus(status, detail),
      onLog: (level, message) => {
        runtime.panel?.log(level, message);
        if (level === 'error') console.warn(`[ai-agent] ${message}`);
      },
    },
    currentBridgeConfig().url,
    currentBridgeConfig().token,
  );

  // Actions must exist before a toolbar can reference them, and the toolbar before
  // the panel that docks it.
  registerActions();
  registerToolbar();

  runtime.panel = new AgentPanel(
    {
      observe,
      ask: (prompt) => void ask(prompt),
      stop: stopTask,
      checkpoint: takeCheckpoint,
      rollback: rollbackLast,
      reconnect: (url, token) => {
        runtime.settings['ai_agent_bridge_url']?.set?.(url);
        runtime.settings['ai_agent_bridge_token']?.set?.(token);
        connect();
      },
      disconnect: () => {
        runtime.client?.disconnect();
      },
      setRealtime: (enabled) => {
        runtime.settings['ai_agent_realtime']?.set?.(enabled);
        runtime.panel?.log('info', `realtime state ${enabled ? 'enabled' : 'disabled'}`);
      },
      openLogs,
    },
    runtime.toolbar ? [runtime.toolbar] : [],
  );
  runtime.panel.setConnection(currentBridgeConfig().url, currentBridgeConfig().token, settingValue('ai_agent_realtime', true));
  runtime.panel.log('info', 'AI Agent loaded; press Connect to reach the bridge');
}

function shutdown(): void {
  if (capabilityTimer !== null) {
    clearTimeout(capabilityTimer);
    capabilityTimer = null;
  }
  try {
    runtime.publisher?.stop();
  } catch {
    /* ignore */
  }
  try {
    runtime.client?.disconnect();
  } catch {
    /* ignore */
  }
  for (const hook of runtime.disposeHooks.splice(0)) {
    try {
      hook();
    } catch {
      /* ignore */
    }
  }
  for (const action of runtime.actions.splice(0)) {
    try {
      action.delete();
    } catch {
      /* ignore */
    }
  }
  try {
    runtime.toolbar?.delete?.();
  } catch {
    /* ignore */
  }
  try {
    runtime.panel?.delete();
  } catch {
    /* ignore */
  }
  runtime.registry = null;
  runtime.publisher = null;
  runtime.client = null;
  runtime.panel = null;
}

/* ------------------------------------------------------------- registration */

function registerPlugin(): void {
  const PluginCtor = tryGlobal<{ register(id: string, data: Record<string, unknown>): unknown }>('Plugin');
  const BBPlugin = tryGlobal<{ register(id: string, data: Record<string, unknown>): unknown }>('BBPlugin');
  const api = PluginCtor?.register ? PluginCtor : BBPlugin;
  if (!api?.register) {
    console.error('[ai-agent] Could not find Plugin.register; the plugin cannot start.');
    return;
  }
  void panelsApi();

  api.register(PLUGIN_ID, {
    title: PLUGIN_TITLE,
    author: PLUGIN_AUTHOR,
    description:
      'Lets an autonomous AI agent inspect the workspace, see the model and actually build geometry, UVs, textures and animations through a local Agent Bridge.',
    about:
      '## AI Agent\n\nThis plugin turns Blockbench into a target for an autonomous agent. It exposes a structured tool registry, real viewport screenshots, checkpoint/rollback and live state over a local WebSocket connection to the Agent Bridge.\n\nAll capabilities are probed against the running build at load time; nothing is assumed.',
    version: PLUGIN_VERSION,
    variant: 'both',
    icon: 'smart_toy',
    tags: ['AI', 'Automation'],
    min_version: '4.9.0',
    website: 'https://github.com/',
    onload() {
      try {
        runtime.lastCapabilities = probeCapabilities();
        buildRuntime();
        runtime.publisher?.start();
        if (settingValue('ai_agent_auto_connect', true)) {
          // Delayed: the bridge is usually started right after Blockbench, and two
          // retries keep the panel from sitting on "disconnected" after a cold start.
          let attempts = 0;
          const tryConnect = (): void => {
            if (runtime.client?.isConnected) return;
            attempts += 1;
            connect();
            if (attempts < 3) setTimeout(tryConnect, 2500);
          };
          setTimeout(tryConnect, 900);
        }
        if (settingValue('ai_agent_auto_connect', true)) {
          // Delayed: the bridge is usually started right after Blockbench, and a single
          // retry keeps the panel from sitting on "disconnected" after a cold start.
          let attempts = 0;
          const tryConnect = (): void => {
            if (runtime.client?.isConnected) return;
            attempts += 1;
            connect();
            if (attempts < 3) setTimeout(tryConnect, 2500);
          };
          setTimeout(tryConnect, 900);
        }
        runtime.panel?.log('info', summariseCapabilities(runtime.lastCapabilities));
        for (const limitation of runtime.lastCapabilities.limitations) {
          runtime.panel?.log('warn', limitation);
        }
        console.log('[ai-agent] capability report', runtime.lastCapabilities);
        if (settingValue('ai_agent_realtime', true)) runtime.publisher?.flush();
      } catch (error) {
        console.error('[ai-agent] load failed', error);
      }
    },
    onunload() {
      shutdown();
    },
    oninstall() {
      console.log('[ai-agent] installed');
    },
  });
}

try {
  registerPlugin();
} catch (error) {
  console.error('[ai-agent] fatal error during registration', error);
}

export { runtime as __runtime };
export type { BBAnimation };
