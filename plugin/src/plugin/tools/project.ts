/**
 * Project lifecycle, undo, checkpoints and transactions.
 *
 * Saving is deliberately split: the plugin compiles the project exactly the way
 * Blockbench's own save does (`Codecs.project.compile()`), and the **bridge** writes
 * the bytes. That keeps the plugin free of any filesystem permission request, and it
 * means the agent can save without a native dialog appearing in the user's face.
 * `save_project_as` is the escape hatch that hands control back to Blockbench's real
 * export dialog.
 */

import { bb, codecs, maybeProject, project, tryGlobal, undo, type BBFormat } from '../env.js';
import { tool } from '../../shared/protocol.js';
import { captureProject, captureUndo, captureAnimations, captureTextures } from '../state.js';
import { compileSnapshot } from '../checkpoints.js';
import {
  ToolExecutionError,
  ToolValidationError,
  asRecord,
  defineTool,
  numericArray,
  type RegisteredTool,
} from './registry.js';

/** Tracks a bridge driven transaction so nested tools skip their own undo bracket. */
interface TransactionState {
  active: boolean;
  label: string;
  startedAt: number;
  steps: number;
}

const transaction: TransactionState = { active: false, label: '', startedAt: 0, steps: 0 };

export function isTransactionActive(): boolean {
  return transaction.active;
}

export function noteTransactionStep(): void {
  if (transaction.active) transaction.steps += 1;
}

export function projectTools(): RegisteredTool[] {
  const codec = () => codecs().project;

  return [
    /* ------------------------------------------------------------- saving */
    {
      definition: defineTool({
        name: 'save_project',
        title: 'Save project',
        description:
          'Compile the whole project to a .bbmodel document and hand it back to the bridge, which writes it next to the active project file. No dialog is shown. Call mark_project_saved afterwards once the file is on disk.',
        group: 'project',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            minify: tool.boolean('Produce a compact document', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ model, name, extension, save_path, counts, bytes }',
      }),
      handler: (args) => {
        const current = maybeProject();
        if (!current) throw new ToolExecutionError('No project is open.', 'no_project');
        const snapshot = compileSnapshot();
        const json = JSON.stringify(snapshot.model);
        return {
          data: {
            model: snapshot.model,
            name: snapshot.project_name ?? 'untitled',
            extension: typeof current.getFileExtension === 'function' ? String(current.getFileExtension()) : 'bbmodel',
            save_path: snapshot.save_path,
            format_id: snapshot.format_id,
            minify: args.minify === true,
            counts: {
              elements: current.elements?.length ?? 0,
              textures: captureTextures().length,
              animations: captureAnimations().length,
            },
            bytes: json.length,
          },
          verified: json.length > 20,
        };
      },
    },
    {
      definition: defineTool({
        name: 'mark_project_saved',
        title: 'Mark project saved',
        description: 'Clear the unsaved-changes marker in Blockbench after the bridge has written the file to disk.',
        group: 'project',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { save_path: tool.string('Absolute path the project was written to') },
          additionalProperties: false,
        },
        returns: '{ saved, save_path }',
      }),
      handler: (args) => {
        const current = project();
        if (typeof args.save_path === 'string' && args.save_path) {
          current.save_path = args.save_path;
        }
        current.saved = true;
        for (const texture of current.textures ?? []) {
          (texture as unknown as { saved?: boolean }).saved = true;
        }
        return { data: { saved: !!current.saved, save_path: current.save_path }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'save_project_as',
        title: 'Save project as',
        description:
          'Open Blockbench\'s native export dialog so the user chooses where to write the project. This is interactive and does not return a path; use save_project for headless saving.',
        group: 'project',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { format: tool.enum('Which codec to use', ['project', 'active']) },
          additionalProperties: false,
        },
        returns: '{ opened: true }',
      }),
      handler: (args) => {
        const target = args.format === 'active' ? ((bb().Format as BBFormat)?.id ?? '') : 'project';
        void target;
        codec().export();
        return {
          data: {
            opened: true,
            note: 'A native save dialog was opened. The user must confirm it; no path is returned.',
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'open_project',
        title: 'Open project',
        description:
          'Replace the current project with a .bbmodel document previously read by the bridge. Pass the parsed JSON document, not a path.',
        group: 'project',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            model: tool.freeObject('Parsed .bbmodel JSON document'),
            path: tool.string('Optional path used for naming and for relative texture paths'),
            merge: tool.boolean('Merge into the current project instead of replacing it', { default: false }),
          },
          required: ['model'],
          additionalProperties: false,
        },
        returns: '{ project, merged }',
      }),
      handler: (args) => {
        const model = asRecord(args.model);
        if (!model || !Object.keys(model).length) throw new ToolValidationError('"model" must be a parsed .bbmodel object');
        const path = typeof args.path === 'string' && args.path ? args.path : 'opened.bbmodel';
        const codecApi = codecs().project as unknown as {
          load?: (model: unknown, file: unknown) => unknown;
          merge?: (model: unknown, path: string) => unknown;
        };
        if (args.merge === true) {
          if (typeof codecApi.merge !== 'function') throw new ToolExecutionError('Codecs.project.merge is unavailable.', 'api_unavailable');
          codecApi.merge(model, path);
        } else {
          if (typeof codecApi.load !== 'function') throw new ToolExecutionError('Codecs.project.load is unavailable.', 'api_unavailable');
          codecApi.load(model, { path, no_file: true });
        }
        return { data: { project: captureProject(), merged: args.merge === true }, verified: !!maybeProject() };
      },
    },
    {
      definition: defineTool({
        name: 'new_project',
        title: 'New project',
        description:
          'Start a fresh empty project in the given model format. Use `free` for a generic project with no format restrictions, or a real format id such as `bedrock_entity`, `java_block`, `modded_entity` or `skin`.',
        group: 'project',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            format: tool.string('Model format id', { default: 'free' }),
            resolution: tool.array('Texture resolution [width, height]', tool.integer('Pixels'), { minItems: 2, maxItems: 2 }),
          },
          additionalProperties: false,
        },
        returns: '{ project, available_formats }',
      }),
      handler: (args) => {
        const newProjectFn = tryGlobal<(format: string) => boolean>('newProject');
        if (typeof newProjectFn !== 'function') throw new ToolExecutionError('newProject() is unavailable in this build.', 'api_unavailable');
        const formatId = typeof args.format === 'string' ? args.format : 'free';
        const formats = tryGlobal<Record<string, BBFormat>>('Formats');
        if (formats && !formats[formatId]) {
          throw new ToolValidationError(
            `Unknown format "${formatId}". Available: ${Object.keys(formats).slice(0, 40).join(', ')}`,
          );
        }
        newProjectFn(formatId);
        const created = maybeProject();
        const resolution = numericArray(args.resolution);
        if (created && resolution && resolution.length === 2) {
          applyResolution(created as unknown as { resolution: { width: number; height: number }; texture_width: number; texture_height: number }, resolution[0], resolution[1]);
        }
        return {
          data: {
            project: captureProject(),
            available_formats: formats ? Object.keys(formats) : [],
          },
          verified: !!created,
        };
      },
    },
    {
      definition: defineTool({
        name: 'set_project_settings',
        title: 'Set project settings',
        description:
          'Change project level settings: name, texture resolution, box UV mode. Resolution is what UV coordinates are measured against, so set it before laying out textures.',
        group: 'project',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Project name'),
            resolution: tool.array('Texture resolution [width, height]', tool.integer('Pixels'), { minItems: 2, maxItems: 2 }),
            box_uv: tool.boolean('Use box UV for the whole project'),
            model_identifier: tool.string('Model identifier (Bedrock geometry identifier)'),
          },
          additionalProperties: false,
        },
        returns: 'ProjectSnapshot',
      }),
      handler: (args) => {
        const current = project();
        if (typeof args.name === 'string') current.name = args.name;
        if (typeof args.model_identifier === 'string') {
          (current as unknown as { model_identifier?: string }).model_identifier = args.model_identifier;
        }
        const resolution = numericArray(args.resolution);
        if (resolution && resolution.length === 2) {
          applyResolution(current as never, resolution[0], resolution[1]);
        }
        if (args.box_uv !== undefined) {
          const optional = (current as unknown as { optional_box_uv?: boolean }).optional_box_uv;
          if (!optional && !!args.box_uv !== !!current.box_uv) {
            throw new ToolExecutionError(
              'The active format does not allow switching box UV (Format.optional_box_uv is false).',
              'unsupported_by_format',
            );
          }
          current.box_uv = !!args.box_uv;
        }
        return { data: captureProject(), verified: true };
      },
    },
    /* ---------------------------------------------------------- undo/redo */
    {
      definition: defineTool({
        name: 'undo',
        title: 'Undo',
        description: 'Step the project back one undo entry, optionally several times. Returns the undo stack position before and after.',
        group: 'recovery',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { steps: tool.integer('How many entries to undo (1-200)', { minimum: 1, maximum: 200 }) },
          additionalProperties: false,
        },
        returns: '{ before, after, steps_applied }',
      }),
      handler: (args) => {
        const steps = typeof args.steps === 'number' ? args.steps : 1;
        const before = captureUndo();
        let applied = 0;
        for (let i = 0; i < steps; i++) {
          const index = undo().index;
          undo().undo();
          if (undo().index === index) break;
          applied += 1;
        }
        return { data: { before, after: captureUndo(), steps_applied: applied }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'redo',
        title: 'Redo',
        description: 'Step the project forward one or more undo entries.',
        group: 'recovery',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { steps: tool.integer('How many entries to redo (1-200)', { minimum: 1, maximum: 200 }) },
          additionalProperties: false,
        },
        returns: '{ before, after, steps_applied }',
      }),
      handler: (args) => {
        const steps = typeof args.steps === 'number' ? args.steps : 1;
        const before = captureUndo();
        let applied = 0;
        for (let i = 0; i < steps; i++) {
          const index = undo().index;
          undo().redo();
          if (undo().index === index) break;
          applied += 1;
        }
        return { data: { before, after: captureUndo(), steps_applied: applied }, verified: true };
      },
    },
    /* -------------------------------------------------------- transactions */
    {
      definition: defineTool({
        name: 'transaction_begin',
        title: 'Begin transaction',
        description:
          'Open an undo bracket so every following agent tool call collapses into ONE undo step. Use it to wrap a whole build phase (for example "create the entire T-Rex skeleton") so the user can undo it with a single Ctrl+Z.',
        group: 'recovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { label: tool.string('Undo label shown in Blockbench history', { default: 'AI agent transaction' }) },
          additionalProperties: false,
        },
        returns: '{ active, label, undo_index }',
      }),
      handler: (args, ctx) => {
        if (transaction.active) {
          throw new ToolExecutionError(`A transaction ("${transaction.label}") is already open.`, 'invalid_state');
        }
        const label = typeof args.label === 'string' && args.label ? args.label : 'AI agent transaction';
        undo().initEdit({ outliner: true, elements: [], groups: [], textures: [], animations: [], selection: true });
        transaction.active = true;
        transaction.label = label;
        transaction.startedAt = Date.now();
        transaction.steps = 0;
        ctx.log('info', `transaction opened: ${label}`);
        return { data: { active: true, label, undo_index: undo().index }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'transaction_commit',
        title: 'Commit transaction',
        description: 'Close the open undo bracket and record it as a single undo entry.',
        group: 'recovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: '{ committed, label, steps, undo_index }',
      }),
      handler: (_args, ctx) => {
        if (!transaction.active) throw new ToolExecutionError('No transaction is open.', 'invalid_state');
        const label = transaction.label;
        const steps = transaction.steps;
        undo().finishEdit(label);
        transaction.active = false;
        ctx.log('info', `transaction committed: ${label} (${steps} steps)`);
        return { data: { committed: true, label, steps, undo_index: undo().index }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'transaction_abort',
        title: 'Abort transaction',
        description:
          'Close the open undo bracket and revert everything that happened inside it. This is the clean way to back out of a failed build phase.',
        group: 'recovery',
        danger: 'destructive',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: '{ aborted, undone_steps, project }',
      }),
      handler: (_args, ctx) => {
        if (!transaction.active) throw new ToolExecutionError('No transaction is open.', 'invalid_state');
        const label = transaction.label;
        undo().cancelEdit(true);
        transaction.active = false;
        ctx.log('info', `transaction aborted: ${label}`);
        return {
          data: { aborted: true, label, project: captureProject() },
          warnings: ['The transaction was cancelled; Blockbench reverted its edits.'],
          verified: true,
        };
      },
    },
    /* --------------------------------------------------------- checkpoints */
    {
      definition: defineTool({
        name: 'checkpoint',
        title: 'Create checkpoint',
        description:
          'Record a restorable point in the project history. It stores both the undo stack position and a full compiled snapshot, so it can be restored either by rewinding undo (instant) or by reloading the snapshot. Always available even where no native checkpoint API exists, because Blockbench has none.',
        group: 'recovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            label: tool.string('Human readable label', { default: 'checkpoint' }),
            include_snapshot: tool.boolean('Also store a full project snapshot on disk', { default: true }),
          },
          additionalProperties: false,
        },
        returns: 'CheckpointRecord (without the snapshot payload)',
      }),
      handler: (args, ctx) => {
        const label = typeof args.label === 'string' && args.label ? args.label : 'checkpoint';
        const record = ctx.checkpoints.create(label, args.include_snapshot !== false);
        const { snapshot: _snapshot, ...summary } = record;
        return {
          data: { ...summary, snapshot_bytes: _snapshot ? JSON.stringify(_snapshot.model).length : 0 },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'list_checkpoints',
        title: 'List checkpoints',
        description: 'List every checkpoint recorded in this session with its label, time and undo position.',
        group: 'recovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: 'CheckpointRecord[]',
      }),
      handler: (_args, ctx) => ({ data: { checkpoints: ctx.checkpoints.list(), current_undo: captureUndo() }, verified: true }),
    },
    {
      definition: defineTool({
        name: 'rollback',
        title: 'Rollback',
        description:
          'Restore the project to a checkpoint. Prefers rewinding the undo stack, which is exact and instant; falls back to reloading the stored snapshot when the history has been trimmed. Always re-reads the resulting project and reports whether the rollback verified.',
        group: 'recovery',
        danger: 'destructive',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            checkpoint_id: tool.string('Checkpoint id, or "last" for the most recent one'),
          },
          required: ['checkpoint_id'],
          additionalProperties: false,
        },
        returns: '{ strategy, undo_steps, verified, verification, warnings }',
      }),
      handler: (args, ctx) => {
        let id = String(args.checkpoint_id);
        if (id === 'last') {
          const list = ctx.checkpoints.list();
          if (!list.length) throw new ToolExecutionError('No checkpoints have been recorded yet.', 'not_found');
          id = list[list.length - 1].id;
        }
        const result = ctx.checkpoints.restore(id);
        return {
          data: result as unknown as Record<string, unknown>,
          warnings: result.warnings.length ? result.warnings : undefined,
          verified: result.verified,
        };
      },
    },
    {
      definition: defineTool({
        name: 'get_project_history',
        title: 'Get project history',
        description: 'Return the undo stack size and position plus the list of recent edits with labels and timestamps.',
        group: 'recovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { limit: tool.integer('How many entries to list (1-100)', { default: 20, minimum: 1, maximum: 100 }) },
          additionalProperties: false,
        },
        returns: '{ undo, entries: [{index, message, time}] }',
      }),
      handler: (args) => {
        const system = undo() as unknown as {
          history: Array<{ message?: string; time?: number }>;
          index: number;
        };
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const entries = (system.history ?? [])
          .slice(Math.max(0, (system.index ?? 0) - limit), system.index ?? 0)
          .map((entry, offset, all) => ({
            index: Math.max(0, (system.index ?? 0) - all.length) + offset,
            message: String(entry?.message ?? 'edit'),
            time: entry?.time ? new Date(entry.time).toISOString() : null,
          }))
          .reverse();
        return { data: { undo: captureUndo(), entries }, verified: true };
      },
    },
  ];
}

function applyResolution(
  current: { resolution: { width: number; height: number }; texture_width: number; texture_height: number },
  width: number,
  height: number,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new ToolValidationError('resolution must be two positive numbers');
  }
  current.texture_width = width;
  current.texture_height = height;
  if (current.resolution) {
    current.resolution.width = width;
    current.resolution.height = height;
  }
  const update = tryGlobal<() => void>('updateProjectResolution');
  if (typeof update === 'function') update();
}
