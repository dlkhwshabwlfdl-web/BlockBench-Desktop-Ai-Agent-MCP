/**
 * Tool registry (requirement #4).
 *
 * Every tool has a name, description, JSON Schema, validation, a handler and error
 * handling — and, critically, a `danger` level that decides whether the bridge takes
 * a checkpoint first. Handlers run inside the shared wrapper below, which:
 *
 *   1. validates arguments (strict: unknown keys are rejected)
 *   2. blocks unverified APIs before they can throw deep inside a handler
 *   3. brackets the mutation in `Undo.initEdit` / `Undo.finishEdit` when the tool
 *      declares undo aspects, so agent edits appear as single, undoable steps in
 *      Blockbench's own history
 *   4. reports progress and honours cancellation between steps
 *   5. re-reads the affected state afterwards so "verified" means verified
 */

import { groupClass, outliner, project, textureClass, undo, type BBGroup, type BBNode, type BBTexture } from '../env.js';
import type { CapabilityReport, NodeReference, ToolDefinition } from '../../shared/protocol.js';
import { formatIssues, validateArguments } from '../../shared/validate.js';
import type { CheckpointManager } from '../checkpoints.js';

export class ToolValidationError extends Error {
  readonly code = 'invalid_arguments';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, code = 'execution_failed', retryable = false) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ToolContext {
  requestId: string;
  capabilities: CapabilityReport;
  checkpoints: CheckpointManager;
  throwIfCancelled(): void;
  reportProgress(step: number, total: number, label: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Forces a realtime state refresh after a mutation. */
  refreshState(): void;
  /** Takes a checkpoint only when one is not already active for this request. */
  autoCheckpoint(label: string): string | null;
  /** Set to false while running inside a transaction. */
  undoEnabled: boolean;
}

export interface ToolOutput {
  data: unknown;
  warnings?: string[];
  verified?: boolean;
}

export interface ToolUndoAspects {
  elements?: unknown[];
  groups?: unknown[];
  textures?: unknown[];
  animations?: unknown[];
  keyframes?: unknown[];
  outliner?: boolean;
  selection?: boolean;
  uv_only?: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Aspects passed to Undo.initEdit; omit for read-only tools. */
  undoAspects?: ToolUndoAspects | (() => ToolUndoAspects);
  undoMessage?: string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool "${tool.definition.name}" is already registered`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition).sort((a, b) => a.name.localeCompare(b.name));
  }

  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolValidationError(`Unknown tool "${name}". Available: ${[...this.tools.keys()].sort().join(', ')}`);
    }
    const validation = validateArguments(tool.definition.schema, args ?? {});
    if (!validation.ok) {
      throw new ToolValidationError(`Invalid arguments for "${name}": ${formatIssues(validation.issues)}`);
    }
    const cleanArgs = validation.value as Record<string, unknown>;
    ctx.throwIfCancelled();

    const aspects = typeof tool.undoAspects === 'function' ? tool.undoAspects() : tool.undoAspects;
    if (aspects && ctx.undoEnabled) {
      undo().initEdit(aspects as Record<string, unknown>);
    }
    let finished = false;
    try {
      const result = await tool.handler(cleanArgs, ctx);
      if (aspects && ctx.undoEnabled) {
        undo().finishEdit(tool.undoMessage ?? tool.definition.title);
        finished = true;
      }
      ctx.refreshState();
      return result;
    } catch (error) {
      // Leaving a half-open undo edit would corrupt the user's history stack.
      if (aspects && ctx.undoEnabled && !finished) {
        try {
          undo().cancelEdit(false);
        } catch {
          /* best effort */
        }
      }
      throw error;
    }
  }
}

/* ------------------------------------------------------------ node resolving */

export interface ResolveOptions {
  /** Restrict to node types, e.g. ['cube'] or ['group','armature_bone']. */
  types?: string[];
  /** Human readable name used in error messages. */
  what?: string;
}

export function resolveNode(reference: NodeReference | string | undefined, options: ResolveOptions = {}): BBNode {
  const what = options.what ?? 'node';
  if ((reference === undefined || reference === null || reference === '') && options.types?.includes('group')) {
    const first = groupClass().first_selected;
    if (first) return first as unknown as BBNode;
  }
  if (typeof reference === 'string') reference = { name: reference };
  if (!reference || (!reference.uuid && !reference.name)) {
    // Fall back to the current selection, which is what a human means by "it".
    const selected = outliner()?.selected?.[0];
    if (selected) return selected as BBNode;
    throw new ToolExecutionError(`No ${what} was specified and nothing is selected.`, 'not_found');
  }

  const pools: BBNode[] = [];
  const out = outliner();
  if (Array.isArray(out?.root)) pools.push(...(out.root as BBNode[]));
  if (Array.isArray(out?.elements)) pools.push(...(out.elements as BBNode[]));
  const groups = groupClass()?.all;
  if (Array.isArray(groups)) pools.push(...(groups as unknown as BBNode[]));

  // `Outliner.root` already contains every top-level node and `Group.all` contains every
  // group, so a root level group (and any cube left at the root) is present twice. Without
  // de-duplicating, a plain name lookup reports a single object as "ambiguous" and
  // bulk_create_cubes silently drops the cube at the root instead of under its parent.
  const deduped: BBNode[] = [];
  const seen = new Map<unknown, BBNode>();
  for (const node of pools) {
    if (!node) continue;
    // Key on uuid when there is one, otherwise on object identity. Two distinct nodes
    // that share a name are exactly the ambiguity we must keep reporting; the same node
    // reached through two pools is not.
    const key: unknown = typeof node.uuid === 'string' && node.uuid ? node.uuid : node;
    if (seen.has(key)) continue;
    seen.set(key, node);
    deduped.push(node);
  }

  const wantedType = (node: BBNode) =>
    !options.types || options.types.length === 0 || options.types.includes(String(node.type));

  const matches = deduped.filter((node) => {
    if (reference!.uuid) return String(node.uuid) === reference!.uuid && wantedType(node);
    return String(node.name).toLowerCase() === String(reference!.name).toLowerCase() && wantedType(node);
  });

  if (matches.length === 0) {
    throw new ToolExecutionError(
      `No ${what} matches ${reference.uuid ? `uuid "${reference.uuid}"` : `name "${reference.name}"`}.`,
      'not_found',
    );
  }
  if (matches.length > 1) {
    throw new ToolExecutionError(
      `${matches.length} ${what}s match "${reference.name}": ${matches.map((n) => n.uuid.slice(0, 8)).join(', ')}. Use the uuid instead.`,
      'ambiguous',
    );
  }
  return matches[0];
}

export function resolveGroup(reference: NodeReference | string | undefined): BBGroup {
  return resolveNode(reference, { types: ['group', 'armature_bone'], what: 'group' }) as unknown as BBGroup;
}

export function resolveTexture(reference: NodeReference | string | undefined): BBTexture {
  const current = project();
  const list = (current.textures ?? []) as BBTexture[];
  if (!reference || (typeof reference === 'object' && !reference.uuid && !reference.name)) {
    const selected = list.find((texture) => texture.selected);
    if (selected) return selected;
    if (list.length === 1) return list[0];
    throw new ToolExecutionError('No texture was specified and none is selected.', 'not_found');
  }
  const ref = typeof reference === 'string' ? { name: reference } : reference;
  const matches = list.filter((texture) =>
    ref.uuid ? String(texture.uuid) === ref.uuid : String(texture.name).toLowerCase() === String(ref.name).toLowerCase(),
  );
  if (matches.length === 0) throw new ToolExecutionError(`No texture matches "${ref.uuid ?? ref.name}".`, 'not_found');
  if (matches.length > 1) throw new ToolExecutionError(`${matches.length} textures match "${ref.name}".`, 'ambiguous');
  void textureClass();
  return matches[0];
}

/* -------------------------------------------------------------- tiny helpers */

export function requireNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ToolValidationError(`"${label}" must be a number (received ${JSON.stringify(value)})`);
}

export function requireVec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ToolValidationError(`"${label}" must be an array of three numbers`);
  }
  const out = value.map((entry, index) => requireNumber(entry, `${label}[${index}]`)) as [number, number, number];
  return out;
}

export function optionalVec3(value: unknown, label: string): [number, number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireVec3(value, label);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function numericArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((entry) => (typeof entry === 'number' ? entry : Number(entry)));
  return out.every((entry) => Number.isFinite(entry)) ? out : null;
}

/** Builds a definition quickly while keeping every field mandatory in the type. */
export function defineTool(definition: Omit<ToolDefinition, 'schema'> & { schema: ToolDefinition['schema'] }): ToolDefinition {
  return definition;
}
