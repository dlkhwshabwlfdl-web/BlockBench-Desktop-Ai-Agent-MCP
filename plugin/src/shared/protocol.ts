/**
 * Wire protocol shared by the Blockbench plugin and the Agent Bridge.
 *
 * Both sides compile this exact file, so the contract can never drift. Every
 * message carries a unique `id`; request/response pairs are correlated through
 * `request_id`. This file is intentionally dependency-free so it can be bundled
 * into the plugin IIFE without pulling anything into the Blockbench renderer.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 47311;
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';

/** The path the bridge upgrades to a plugin socket. */
export const PLUGIN_SOCKET_PATH = '/plugin';

/**
 * Normalises whatever the user typed into the Bridge URL setting.
 *
 * The bridge only upgrades `/plugin`, but the default value stored in Blockbench's
 * settings was `ws://127.0.0.1:47311` with no path — so the very first Connect attempt
 * was destroyed by the server and the panel showed "disconnected" forever. Both sides
 * are now tolerant: this appends the path, and the server also accepts `/`.
 *
 * A token may travel in the query string (`ws://host:port/plugin?token=…`), which is how
 * the bridge prints a ready-to-paste URL.
 */
export function normalizeBridgeUrl(input: string, fallback?: string): string {
  const raw = (input ?? '').trim() || (fallback ?? '') || `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `ws://${raw}`);
  } catch {
    return `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}${PLUGIN_SOCKET_PATH}`;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') url.protocol = 'ws:';
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/index.html' || path === '/ws') url.pathname = PLUGIN_SOCKET_PATH;
  // `url.toString()` already carries the query string; appending `url.search` again is
  // what produced `…?token=x?token=x`.
  url.pathname = url.pathname.replace(/\/+$/, '') || PLUGIN_SOCKET_PATH;
  return url.toString().replace(/([^:\/])\/$/, '$1');
}

export type MessageType =
  | 'hello'
  | 'welcome'
  | 'capabilities'
  | 'list_tools'
  | 'tools'
  | 'tool_call'
  | 'tool_result'
  | 'state_update'
  | 'event'
  | 'progress'
  | 'cancel'
  | 'checkpoint'
  | 'rollback'
  | 'ping'
  | 'pong'
  | 'log'
  | 'error'
  | 'agent_task'
  | 'agent_task_result'
  | 'agent_stop'
  | 'agent_status';

export interface BaseMessage {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: MessageType;
}

export interface HelloMessage extends BaseMessage {
  type: 'hello';
  role: 'plugin' | 'bridge';
  token: string;
  client: { name: string; version: string };
  capabilities?: CapabilityReport;
}

export interface WelcomeMessage extends BaseMessage {
  type: 'welcome';
  accepted: boolean;
  reason?: string;
  server: { name: string; version: string };
}

export interface ListToolsMessage extends BaseMessage {
  type: 'list_tools';
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Logical grouping used by the UI and by prompt construction. */
  group: string;
  /** How dangerous the tool is; drives automatic checkpoints. */
  danger: 'safe' | 'mutating' | 'destructive';
  /** Whether the bridge should create a checkpoint before the call. */
  needs_checkpoint: boolean;
  /** JSON Schema for the arguments object. */
  schema: JsonSchemaObject;
  /** Short human readable description of the returned payload. */
  returns: string;
}

export interface ToolsMessage extends BaseMessage {
  type: 'tools';
  tools: ToolDefinition[];
}

/**
 * A freshly re-probed capability report.
 *
 * The report cannot be a boot-time constant: several capabilities are format-dependent
 * (`group.bone_rig`, `mesh.support`, `project.compile`) and Blockbench reports no active
 * format until a project exists. Without this message the agent would be told at the
 * start of every session that features which are perfectly available are not.
 */
export interface CapabilitiesMessage extends BaseMessage {
  type: 'capabilities';
  report: CapabilityReport;
  /** What changed since the last report, so the bridge can log a useful line. */
  reason: 'connected' | 'project_opened' | 'format_changed' | 'requested' | 'periodic';
}

export interface ToolCallMessage extends BaseMessage {
  type: 'tool_call';
  request_id: string;
  tool: string;
  args: Record<string, unknown>;
  timeout_ms?: number;
}

export interface ToolResultMessage extends BaseMessage {
  type: 'tool_result';
  request_id: string;
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: ToolError;
  warnings?: string[];
  duration_ms: number;
  /** True when the handler verified its own effect against live Blockbench state. */
  verified?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  detail?: unknown;
  retryable?: boolean;
}

export interface CancelMessage extends BaseMessage {
  type: 'cancel';
  request_id: string;
  reason?: string;
}

export interface ProgressMessage extends BaseMessage {
  type: 'progress';
  task_id: string;
  step: number;
  total: number;
  label: string;
}

export interface LogMessage extends BaseMessage {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** Sent by the panel's "Ask Agent" button to start an autonomous task. */
export interface AgentTaskMessage extends BaseMessage {
  type: 'agent_task';
  request_id: string;
  prompt: string;
  /** Parameters the plugin already knows, so the agent does not have to re-probe. */
  context?: {
    project_name?: string | null;
    format_id?: string | null;
    save_path?: string | null;
    capabilities?: CapabilityReport;
  };
}

export interface AgentTaskResultMessage extends BaseMessage {
  type: 'agent_task_result';
  request_id: string;
  ok: boolean;
  summary?: string;
  steps?: number;
  tool_calls?: number;
  data?: unknown;
  error?: ToolError;
}

export interface AgentStopMessage extends BaseMessage {
  type: 'agent_stop';
  request_id?: string;
  reason?: string;
}

export interface AgentStatusMessage extends BaseMessage {
  type: 'agent_status';
  state: 'idle' | 'running' | 'error';
  task_id?: string;
  step?: number;
  total?: number;
  label?: string;
  message?: string;
}

export interface PingMessage extends BaseMessage {
  type: 'ping';
  t: number;
}

export interface PongMessage extends BaseMessage {
  type: 'pong';
  t: number;
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  error: ToolError;
}

export interface CheckpointRequestMessage extends BaseMessage {
  type: 'checkpoint';
  request_id: string;
  label: string;
  include_snapshot?: boolean;
}

export interface RollbackRequestMessage extends BaseMessage {
  type: 'rollback';
  request_id: string;
  checkpoint_id: string;
}

export interface StateUpdateMessage extends BaseMessage {
  type: 'state_update';
  revision: number;
  changed: string[];
  state: PluginStateSnapshot;
}

export interface EventMessage extends BaseMessage {
  type: 'event';
  name: string;
  at: number;
  data?: unknown;
}

export type AnyMessage =
  | HelloMessage
  | WelcomeMessage
  | CapabilitiesMessage
  | ListToolsMessage
  | ToolsMessage
  | ToolCallMessage
  | ToolResultMessage
  | CancelMessage
  | ProgressMessage
  | LogMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | CheckpointRequestMessage
  | RollbackRequestMessage
  | StateUpdateMessage
  | EventMessage
  | AgentTaskMessage
  | AgentTaskResultMessage
  | AgentStopMessage
  | AgentStatusMessage;

/* ------------------------------------------------------------------ payloads */

export interface NodeSummary {
  uuid: string;
  name: string;
  type: string;
  parent: string | null;
  children?: NodeSummary[];
  from?: number[];
  to?: number[];
  size?: number[];
  origin?: number[];
  rotation?: number[];
  visibility?: boolean;
  inflate?: number;
  mirror_uv?: boolean;
  box_uv?: boolean;
  autouv?: number;
  uv_offset?: number[];
  texture?: string | null;
  locked?: boolean;
  export?: boolean;
}

export interface ProjectSnapshot {
  blockbench_version: string;
  project_name: string | null;
  save_path: string | null;
  format_id: string;
  format_name: string;
  format_bone_rig: boolean;
  format_box_uv: boolean;
  format_animation_mode: boolean;
  format_rotation_limit: boolean | number;
  target_version?: string | null;
  resolution: { width: number; height: number };
  grid_size?: number;
  texture_size?: number[];
  saved: boolean;
  element_count: number;
  group_count: number;
  texture_count: number;
  animation_count: number;
}

export interface AnimationSummary {
  uuid: string;
  name: string;
  length: number;
  loop: string;
  playing: boolean;
  selected: boolean;
  snapping?: number;
  animator_count: number;
  keyframe_count: number;
  markers: string[];
  animators: AnimatorSummary[];
}

export interface AnimatorSummary {
  uuid: string;
  key: string;
  type: string;
  name: string;
  channels: string[];
  keyframe_count: number;
}

export interface KeyframeSummary {
  uuid: string;
  time: number;
  channel: string;
  interpolation: string;
  data_points: Array<Record<string, unknown>>;
  color?: number;
}

export interface TextureSummary {
  uuid: string;
  name: string;
  width: number | null;
  height: number | null;
  path: string | null;
  internal: boolean;
  selected: boolean;
  particle: boolean;
  render_mode: string | null;
  has_source: boolean;
  source_kind: 'data_url' | 'path' | 'empty';
}

export interface UVFaceSummary {
  face: string;
  uv: number[] | null;
  rotation: number;
  texture: string | null;
  enabled: boolean;
  tint: number;
  cullface: string | null;
}

export interface SelectionSummary {
  groups: NodeSummary[];
  elements: NodeSummary[];
  textures: TextureSummary[];
  animation: string | null;
  keyframes: KeyframeSummary[];
  mode: string;
}

export interface ViewportState {
  preview_id: string | null;
  view_mode: string | null;
  camera: { position: number[]; target: number[]; zoom: number; rotation: number[] } | null;
  shading: boolean;
  display_slot: string | null;
  visible_elements: number;
  hidden_elements: number;
}

export interface PluginStateSnapshot {
  connected: boolean;
  project: ProjectSnapshot | null;
  counts: { elements: number; groups: number; textures: number; animations: number; keyframes: number };
  animation: { name: string | null; time: number; length: number; playing: boolean } | null;
  selection: { groups: string[]; elements: string[]; textures: string[]; count: number };
  viewport: ViewportState | null;
  undo: { index: number; length: number } | null;
  revision: number;
  updated_at: number;
}

export interface CapabilityFeature {
  id: string;
  available: boolean;
  /** Where the capability was confirmed to exist in the installed build. */
  source: string;
  note?: string;
}

export interface CapabilityReport {
  plugin_version: string;
  protocol_version: number;
  blockbench_version: string;
  blockbench_is_app: boolean;
  platform: string;
  operating_system: string;
  browser: string;
  active_format: string | null;
  format_count: number;
  mode: string | null;
  features: CapabilityFeature[];
  permissions: string[];
  installed_plugins: Array<{ id: string; version: string; source: string }>;
  available_events: string[];
  limitations: string[];
}

/* ------------------------------------------------------------- json schemas */

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

export const tool = {
  string(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'string', description, ...extra };
  },
  number(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'number', description, ...extra };
  },
  integer(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'integer', description, ...extra };
  },
  boolean(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'boolean', description, ...extra };
  },
  array(description: string, items: JsonSchema, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'array', description, items, ...extra };
  },
  object(description: string, properties: Record<string, JsonSchema>, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'object', description, properties, ...extra };
  },
  /**
   * An object whose shape is not known ahead of time, e.g. a whole parsed
   * .bbmodel document. Unlike `object()` this accepts arbitrary keys, which is
   * what the argument validator requires before it will pass one through.
   */
  freeObject(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'object', description, additionalProperties: true, ...extra };
  },
  enum(description: string, values: unknown[], extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'string', description, enum: values, ...extra };
  },
  vec3(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return {
      type: 'array',
      description: `${description} (three numbers: [x, y, z])`,
      items: { type: 'number' },
      minItems: 3,
      maxItems: 3,
      ...extra,
    };
  },
  vec2(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return {
      type: 'array',
      description: `${description} (two numbers: [u, v])`,
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      ...extra,
    };
  },
};

/** Normalises the many ways a caller can reference a node into a plain lookup. */
export interface NodeReference {
  uuid?: string;
  name?: string;
}

export const FACE_NAMES = ['north', 'east', 'south', 'west', 'up', 'down'] as const;
export type FaceName = (typeof FACE_NAMES)[number];

export const ANIMATION_CHANNELS = ['rotation', 'position', 'scale'] as const;
export type AnimationChannel = (typeof ANIMATION_CHANNELS)[number];
