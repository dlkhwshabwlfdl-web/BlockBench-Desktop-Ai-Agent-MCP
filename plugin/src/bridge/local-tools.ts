/**
 * Bridge-side tools.
 *
 * Not everything the agent needs exists inside Blockbench. Remembering a decision,
 * generating a texture procedurally, compositing six angles into one contact sheet,
 * and ending the task cleanly are bridge concerns. They are exposed to the model as
 * ordinary tools with the same JSON-Schema shape as the plugin's, so the agent sees
 * one flat catalogue and never has to know which side of the socket a tool lives on.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../shared/protocol.js';
import { tool } from '../shared/protocol.js';
import type { Logger } from './log.js';
import type { MemoryStore, TaskStatus } from './memory.js';
import type { CheckpointOutcome, PluginSession, ToolCallOptions } from './session.js';
import { composeContactSheet, decodeDataUrl, type ContactSheetCell } from './image.js';
import { creaturePalette, generateTexture, type TextureSpec } from './textures.js';

export const LOCAL_TOOL_PREFIX = 'bridge_';

/**
 * Mirrors a plugin checkpoint into bridge memory.
 *
 * The plugin owns the checkpoint itself (undo index plus a compiled model snapshot) and
 * can restore it on its own. The bridge keeps this index for a different reason: so
 * `POST /rollback` with no id, and the `bridge_rollback` tool with no id, both know what
 * "the latest checkpoint" means without asking the plugin. Without this the two sides
 * disagree about history, which is exactly the kind of bug that surfaces mid-build.
 */
export function storeCheckpoint(memory: MemoryStore, outcome: CheckpointOutcome) {
  const model = (outcome.snapshot?.model ?? null) as Record<string, unknown> | null;
  const elements = model && Array.isArray(model.elements) ? (model.elements as unknown[]).length : null;
  return memory.writeCheckpoint(
    {
      checkpoint_id: outcome.checkpoint_id,
      label: outcome.label,
      created_at: outcome.created_at ?? Date.now(),
      project_name: outcome.snapshot?.project_name ?? null,
      format_id: outcome.snapshot?.format_id ?? null,
      undo_index: outcome.undo_index ?? 0,
      undo_length: outcome.undo_length ?? 0,
      counts: elements === null ? null : { elements },
      file: '',
    },
    model,
  );
}

export interface LocalToolDeps {
  session: PluginSession;
  memory: MemoryStore;
  logger: Logger;
  /** Absolute path for artefacts; from `workspacePaths`. */
  workspaceRoot: string;
  viewportDir: string;
  textureDir: string;
  /** Angles used by `bridge_look` when the caller does not specify any. */
  defaultAngles: string[];
}

export interface LocalToolResult {
  data: unknown;
  warnings?: string[];
  verified?: boolean;
  /** Set when the tool ends the task. */
  finish?: { summary: string; verified: boolean };
  /** Extra images to hand to the model outside the tool-result channel. */
  images?: Array<{ label: string; dataUrl: string }>;
}

export interface LocalTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: { taskId?: string; signal?: AbortSignal; options: ToolCallOptions }) => Promise<LocalToolResult>;
}

const ANGLE_PRESETS = ['view', 'north', 'south', 'east', 'west', 'top', 'bottom', 'isometric_right', 'isometric_left', 'isometric', 'initial'];

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface ViewportImage {
  angle?: string;
  data_url?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/** Pulls `{angle, data_url}` records out of whatever shape a visual tool returned. */
export function collectViewportImages(data: unknown): ViewportImage[] {
  const out: ViewportImage[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.data_url === 'string' && record.data_url.startsWith('data:image/')) {
      out.push({
        angle: typeof record.angle === 'string' ? record.angle : typeof record.label === 'string' ? record.label : undefined,
        data_url: record.data_url,
        width: num(record.width),
        height: num(record.height),
        bytes: num(record.bytes),
      });
      return;
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(data);
  return out;
}

export function localTools(deps: LocalToolDeps): LocalTool[] {
  const { session, memory, logger } = deps;

  const def = (
    name: string,
    title: string,
    description: string,
    group: string,
    danger: ToolDefinition['danger'],
    needsCheckpoint: boolean,
    properties: ToolDefinition['schema']['properties'],
    required: string[] | undefined,
    returns: string,
  ): ToolDefinition => ({
    name: `${LOCAL_TOOL_PREFIX}${name}`,
    title,
    description,
    group,
    danger,
    needs_checkpoint: needsCheckpoint,
    schema: { type: 'object', properties, required, additionalProperties: false },
    returns,
  });

  return [
    {
      definition: def(
        'look',
        'Look at the model',
        `Render the model from several camera angles and return them as ONE contact sheet image. This is the primary way to see what you have built. The result lists each angle with its pixel region in the sheet. Use it after every meaningful batch of edits, and always before claiming a model looks right.`,
        'bridge',
        'safe',
        false,
        {
          angles: tool.array('Camera presets to include (default: the standard five-angle set)', tool.string('Preset id'), { maxItems: 8 }),
          resolution: tool.integer('Resolution per angle in pixels', { default: 448, minimum: 192, maximum: 1024 }),
          columns: tool.integer('Contact sheet columns', { default: 3, minimum: 1, maximum: 4 }),
          annotation: tool.string('What you are checking, e.g. "silhouette after adding the tail"'),
        },
        undefined,
        '{ data_url, width, height, cells[], missing[], saved_to }',
      ),
      handler: async (args, ctx) => {
        const requested = Array.isArray(args.angles) && args.angles.length ? (args.angles as string[]) : deps.defaultAngles;
        const resolution = num(args.resolution) ?? 448;
        const outcome = await session.callTool(
          'get_model_snapshot',
          { angles: requested, resolution, shading: true },
          ctx.options,
        );
        if (!outcome.ok) {
          return { data: null, warnings: [`render failed: ${outcome.error?.message ?? 'unknown error'}`], verified: false };
        }
        const payload = outcome.data as { images?: ViewportImage[]; available_presets?: string[] } | null;
        const images = payload?.images ?? [];
        const usable = images.filter((image) => typeof image.data_url === 'string');
        if (!usable.length) {
          return {
            data: { images: 0, requested, available_presets: payload?.available_presets ?? ANGLE_PRESETS },
            warnings: ['Blockbench returned no pixels; the screenshot API may be unavailable in this build.'],
            verified: false,
          };
        }
        const sheet = composeContactSheet(
          usable.map((image) => ({ label: String(image.angle ?? 'view'), image: decodeDataUrl(image.data_url as string) })),
          { columns: num(args.columns) ?? 3, gap: 6 },
        );
        const missing = requested.filter((angle) => !usable.some((image) => image.angle === angle));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const savedTo = memory.saveViewport(`look-${stamp}.png`, sheet.png);
        const label = str(args.annotation);
        if (label) logger.debug(`contact sheet for "${label}"`);
        return {
          data: {
            wait_for_image: true,
            width: sheet.width,
            height: sheet.height,
            angles: sheet.cells.map((cell: ContactSheetCell) => cell.label),
            cells: sheet.cells,
            missing,
            saved_to: savedTo,
            note: label ? `captured to check: ${label}` : undefined,
          },
          images: [{ label: `contact sheet (${sheet.cells.map((cell) => cell.label).join(', ')})`, dataUrl: sheet.dataUrl }],
          verified: true,
        };
      },
    },
    {
      definition: def(
        'generate_texture',
        'Generate a texture',
        'Generate a pixel-art texture procedurally and return it as a PNG data URL ready for create_texture or import_texture. Use this for organic, repetitive parts of a skin (scale patterns, dithered shading, scattered spots, stripes). Use paint_texture inside Blockbench for deliberate details such as eyes, teeth and claws. Deterministic: the same seed regenerates the same texture. The result includes the colour histogram so you can judge contrast.',
        'bridge',
        'safe',
        false,
        {
          name: tool.string('File and texture name, e.g. "trex_body"'),
          width: tool.integer('Width in texels', { default: 32, minimum: 1, maximum: 256 }),
          height: tool.integer('Height in texels', { minimum: 1, maximum: 256 }),
          base: tool.string('Base colour as hex, e.g. "#5c7a3a"'),
          palette: tool.array('Explicit shade ramp, darkest first', tool.string('Hex colour'), { maxItems: 12 }),
          pattern: tool.enum('Pattern', ['flat', 'noise', 'scales', 'stripes', 'spots', 'gradient', 'checker']),
          scale: tool.integer('Feature size in texels', { minimum: 1, maximum: 64 }),
          density: tool.number('Coverage 0-1 for noise and spots', { minimum: 0, maximum: 1 }),
          shading: tool.enum('Lighting model', ['none', 'top', 'bottom', 'radial', 'vertical']),
          seed: tool.integer('Random seed (reuse to reproduce a texture)'),
          border: tool.string('Colour for a 1px border that hides cube seams, e.g. "#2b2b2b"'),
          split_color: tool.string('Secondary colour applied below split_at'),
          split_at: tool.number('Fraction of the height where split_color starts (0-1)'),
          also_create: tool.boolean('Create the texture inside Blockbench immediately as well', { default: false }),
        },
        ['name'],
        '{ name, width, height, data_url, palette, histogram, seed, saved_to, created_in_blockbench }',
      ),
      handler: async (args, ctx) => {
        const base = str(args.base, '#6b8e4e');
        const spec: TextureSpec = {
          name: str(args.name, 'texture'),
          width: num(args.width) ?? 32,
          height: num(args.height),
          base,
          palette: Array.isArray(args.palette) && args.palette.length ? (args.palette as string[]) : creaturePalette(base),
          pattern: (str(args.pattern, 'noise') as TextureSpec['pattern']) ?? 'noise',
          scale: num(args.scale),
          density: num(args.density),
          shading: (str(args.shading, 'top') as TextureSpec['shading']) ?? 'top',
          seed: num(args.seed),
          border: args.border === null ? null : typeof args.border === 'string' ? args.border : null,
          split:
            typeof args.split_color === 'string'
              ? { at: num(args.split_at) ?? 0.62, color: args.split_color }
              : null,
        };
        const texture = generateTexture(spec);
        const savedTo = memory.saveTexture(`${texture.name}-${texture.seed.toString(36)}.png`, texture.png);
        const warnings: string[] = [];
        let createdInBlockbench = false;
        if (args.also_create === true) {
          const created = await session.callTool(
            'create_texture',
            { name: texture.name, data_url: texture.dataUrl },
            ctx.options,
          );
          if (created.ok) createdInBlockbench = true;
          else warnings.push(`created the PNG but Blockbench refused the texture: ${created.error?.message ?? 'unknown error'}`);
        }
        return {
          data: {
            name: texture.name,
            width: texture.width,
            height: texture.height,
            data_url: texture.dataUrl,
            palette: texture.palette,
            histogram: texture.histogram,
            seed: texture.seed,
            saved_to: savedTo,
            created_in_blockbench: createdInBlockbench,
          },
          warnings: warnings.length ? warnings : undefined,
          verified: texture.width > 0,
        };
      },
    },
    {
      definition: def(
        'save',
        'Save the project',
        `Compile the project and actually write the .bbmodel to disk, then clear the unsaved marker in Blockbench. Use this rather than the plugin's save_project: the plugin can only compile the document (it has no filesystem access), so the file is written here, next to the project's existing path when there is one and into the workspace otherwise.`,
        'bridge',
        'safe',
        false,
        {
          file_name: tool.string('Override the file name, without extension'),
          directory: tool.string('Absolute directory to write into (defaults to the project path or the workspace)'),
        },
        undefined,
        '{ saved_to, bytes, counts, format_id, verified }',
      ),
      handler: async (args, ctx) => {
        const outcome = await session.callTool('save_project', {}, ctx.options);
        if (!outcome.ok) {
          return { data: null, warnings: [`the plugin could not compile the project: ${outcome.error?.message ?? 'unknown error'}`], verified: false };
        }
        const payload = (outcome.data ?? {}) as {
          model?: Record<string, unknown>;
          name?: string;
          extension?: string;
          save_path?: string | null;
          format_id?: string | null;
          counts?: Record<string, number>;
        };
        if (!payload.model) {
          return { data: null, warnings: ['the plugin returned no model document'], verified: false };
        }
        const extension = (payload.extension ?? 'bbmodel').replace(/^\./, '');
        const baseName = str(args.file_name) || payload.name || 'project';
        const directory = str(args.directory) || (payload.save_path ? path.dirname(payload.save_path) : deps.workspaceRoot);
        const target = path.join(directory, `${baseName}.${extension}`);
        let bytes = 0;
        try {
          fs.mkdirSync(directory, { recursive: true });
          const json = JSON.stringify(payload.model, null, 2);
          // Write via a temporary file so a crash cannot leave a truncated project that
          // Blockbench would then happily open.
          const temp = `${target}.tmp-${Date.now()}`;
          fs.writeFileSync(temp, `${json}\n`, 'utf8');
          fs.renameSync(temp, target);
          bytes = Buffer.byteLength(json);
        } catch (error) {
          return { data: null, warnings: [`could not write ${target}: ${(error as Error).message}`], verified: false };
        }
        const marked = await session.callTool('mark_project_saved', { save_path: target }, ctx.options);
        const warnings: string[] = [];
        if (!marked.ok) warnings.push(`the project was written but Blockbench still shows unsaved changes: ${marked.error?.message ?? 'unknown error'}`);
        memory.appendHistory({ kind: 'save', summary: `saved ${target} (${bytes} bytes)`, tool: 'bridge_save', ok: true, duration_ms: null });
        return {
          data: {
            saved_to: target,
            bytes,
            counts: payload.counts ?? null,
            format_id: payload.format_id ?? null,
            marked_saved: marked.ok,
          },
          warnings: warnings.length ? warnings : undefined,
          verified: bytes > 0 && marked.ok,
        };
      },
    },
    {
      definition: def(
        'checkpoint',
        'Create checkpoint',
        'Record a restorable checkpoint of the current project (geometry, hierarchy, UVs, textures and animations). Call this before a large restructure so you can roll back instead of repairing. Blockbench also checkpoints automatically before destructive tools.',
        'bridge',
        'safe',
        false,
        {
          label: tool.string('Short description of the state, e.g. "before adding the tail"'),
        },
        ['label'],
        'CheckpointOutcome',
      ),
      handler: async (args) => {
        const record = await session.checkpoint(str(args.label, 'agent checkpoint'), true);
        storeCheckpoint(memory, record);
        memory.appendHistory({ kind: 'checkpoint', summary: `checkpoint: ${record.label}`, tool: 'bridge_checkpoint', ok: true, duration_ms: null });
        return { data: record, verified: true };
      },
    },
    {
      definition: def(
        'rollback',
        'Roll back',
        'Restore a checkpoint by id. Use it when a change went badly wrong; it is cheaper and safer than trying to undo a large restructure by hand. Calling it with no id restores the most recent checkpoint.',
        'bridge',
        'destructive',
        false,
        {
          checkpoint_id: tool.string('Checkpoint id (defaults to the latest)'),
          reason: tool.string('Why the rollback is needed'),
        },
        undefined,
        '{ checkpoint_id, label, restored, verified }',
      ),
      handler: async (args) => {
        const checkpoints = memory.listCheckpoints();
        const target = str(args.checkpoint_id) || checkpoints[checkpoints.length - 1]?.checkpoint_id || '';
        if (!target) return { data: null, warnings: ['No checkpoints exist yet.'], verified: false };
        const outcome = await session.rollback(target);
        memory.appendHistory({
          kind: 'rollback',
          summary: `rollback to ${target}${args.reason ? ` — ${String(args.reason)}` : ''}`,
          tool: 'bridge_rollback',
          ok: outcome.ok,
          duration_ms: outcome.duration_ms,
        });
        if (!outcome.ok) {
          return { data: outcome.data, warnings: [outcome.error?.message ?? 'rollback failed'], verified: false };
        }
        return { data: outcome.data, verified: outcome.verified ?? true };
      },
    },
    {
      definition: def(
        'remember',
        'Remember',
        'Persist project context so a future run does not have to rediscover it: the goal, the target format, the scale convention, a design decision with its rationale, a note, or a known issue. Use it whenever you make a judgement call the user would want explained later.',
        'bridge',
        'safe',
        false,
        {
          goal: tool.string('Overall project goal'),
          target_format: tool.string('Target Blockbench format id, e.g. "java_block"'),
          scale: tool.string('Scale convention, e.g. "1 cube = 1/16 block"'),
          naming: tool.array('Naming conventions to follow', tool.string('Convention'), { maxItems: 12 }),
          note: tool.string('Free-form note'),
          known_issue: tool.string('Something wrong that is known and accepted'),
          decision: tool.object('A design decision to record', {
            topic: tool.string('What the decision is about, e.g. "leg length"'),
            decision: tool.string('What you decided'),
            rationale: tool.string('Why'),
            source: tool.string('Where the evidence came from, e.g. "reference 2"'),
          }, { required: ['topic', 'decision', 'rationale'] }),
        },
        undefined,
        '{ project, decision?, stored_at }',
      ),
      handler: async (args) => {
        const patch: Record<string, unknown> = {};
        if (typeof args.goal === 'string') patch.goal = args.goal;
        if (typeof args.target_format === 'string') patch.target_format = args.target_format;
        if (typeof args.scale === 'string') patch.scale = args.scale;
        if (Array.isArray(args.naming)) patch.naming_conventions = args.naming as string[];
        const project = memory.updateProject(patch);
        if (typeof args.note === 'string') memory.addNote(args.note);
        if (typeof args.known_issue === 'string') memory.addKnownIssue(args.known_issue);
        let decision = null;
        if (args.decision && typeof args.decision === 'object') {
          const record = args.decision as Record<string, unknown>;
          decision = memory.addDecision({
            topic: str(record.topic, 'general'),
            decision: str(record.decision, ''),
            rationale: str(record.rationale, ''),
            source: typeof record.source === 'string' ? record.source : null,
          });
        }
        memory.appendHistory({ kind: 'note', summary: decision ? `decision: ${decision.topic}` : 'memory updated', tool: 'bridge_remember', ok: true, duration_ms: null });
        return {
          data: { project: { goal: project.goal, target_format: project.target_format, scale: project.scale }, decision, notes: project.notes.length },
          verified: true,
        };
      },
    },
    {
      definition: def(
        'plan',
        'Plan tasks',
        'Write down the subtasks of a long build so progress survives the end of the run and so you can check yourself against the plan. Call it once after OBSERVE, then keep it current with plan_update.',
        'bridge',
        'safe',
        false,
        {
          tasks: tool.array(
            'Subtasks in order',
            tool.object('A subtask', {
              title: tool.string('Short title, e.g. "legs and claws"'),
              detail: tool.string('What "done" means'),
              status: tool.enum('Status', ['pending', 'in_progress', 'done', 'failed', 'blocked']),
            }, { required: ['title'] }),
            { minItems: 1, maxItems: 40 },
          ),
        },
        ['tasks'],
        '{ tasks: TaskRecord[] }',
      ),
      handler: async (args) => {
        const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];
        const records = tasks.map((task) =>
          memory.upsertTask({
            title: str(task.title, 'untitled'),
            detail: typeof task.detail === 'string' ? task.detail : null,
            status: (task.status as TaskStatus | undefined) ?? 'pending',
          }),
        );
        memory.appendHistory({ kind: 'note', summary: `plan with ${records.length} steps`, tool: 'bridge_plan', ok: true, duration_ms: null });
        return { data: { tasks: records }, verified: true };
      },
    },
    {
      definition: def(
        'plan_update',
        'Update a plan step',
        'Mark a subtask done or failed and attach what you learned. Keep the plan honest: a step is only "done" once you have inspected the result.',
        'bridge',
        'safe',
        false,
        {
          title: tool.string('Task title to update'),
          id: tool.string('Task id, if you have it'),
          status: tool.enum('New status', ['pending', 'in_progress', 'done', 'failed', 'blocked']),
          note: tool.string('What happened, e.g. "tail pivots were 2px off, fixed"'),
        },
        undefined,
        'TaskRecord',
      ),
      handler: async (args) => {
        const title = str(args.title);
        const id = str(args.id);
        const existing = memory.snapshot().tasks.find((task) => (id && task.id === id) || (title && task.title === title));
        if (!existing && !title) return { data: null, warnings: ['Provide either id or title.'], verified: false };
        const record = memory.upsertTask({
          id: existing?.id,
          title: title || existing?.title || 'untitled',
          status: (args.status as TaskStatus | undefined) ?? existing?.status ?? 'pending',
          note: typeof args.note === 'string' ? args.note : undefined,
        });
        return { data: record, verified: true };
      },
    },
    {
      definition: def(
        'references',
        'Re-read the reference images',
        'Re-attach the reference images from ./references to the conversation when you need to re-examine proportions, colours or markings. They are also attached at the start of the task.',
        'bridge',
        'safe',
        false,
        {
          names: tool.array('Reference file names to re-read (default: all)', tool.string('File name')),
          note: tool.string('What you are looking for, e.g. "leg thickness relative to the body"'),
        },
        undefined,
        '{ attached, references: {name, mime, bytes}[] }',
      ),
      handler: async (args) => {
        const all = memory.listReferences();
        const wanted = Array.isArray(args.names) && args.names.length ? (args.names as string[]) : all.map((reference) => reference.name);
        const selected = all.filter((reference) => wanted.includes(reference.name));
        if (!selected.length) return { data: { attached: 0 }, warnings: ['No matching reference images found.'], verified: true };
        return {
          data: {
            attached: selected.length,
            note: typeof args.note === 'string' ? args.note : undefined,
            references: selected.map((reference) => ({ name: reference.name, mime: reference.mime, bytes: reference.bytes })),
          },
          images: selected.map((reference) => ({ label: `reference: ${reference.name}`, dataUrl: `data:${reference.mime};base64,${reference.base64}` })),
          verified: true,
        };
      },
    },
    {
      definition: def(
        'finish',
        'Finish the task',
        'End the task and report the result to the user. Call it ONLY after you have inspected the rendered model and, when the task asked for a saved file, saved the project. Set verified true only if you personally confirmed the result with a visual check and validate_model.',
        'bridge',
        'safe',
        false,
        {
          summary: tool.string('What you built, what you verified, and anything still weak'),
          verified: tool.boolean('True only if the final state was inspected and matches the request'),
          saved: tool.boolean('True if the project was saved'),
          remaining: tool.string('Anything still to do, if the task is not fully complete'),
        },
        ['summary'],
        '{ finished: true }',
      ),
      handler: async (args) => {
        const summary = str(args.summary, 'done');
        const verified = args.verified !== false;
        memory.appendHistory({ kind: 'agent', summary: `finished: ${summary.slice(0, 200)}`, tool: 'bridge_finish', ok: verified, duration_ms: null });
        for (const task of memory.openTasks()) {
          if (task.status === 'in_progress') memory.upsertTask({ id: task.id, title: task.title, status: verified ? 'done' : 'blocked', note: 'closed by bridge_finish' });
        }
        return { data: { finished: true, remaining: typeof args.remaining === 'string' ? args.remaining : null }, verified, finish: { summary, verified } };
      },
    },
  ];
}
