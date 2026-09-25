/**
 * Animation tools.
 *
 * Everything here is built on the real 5.x animation model, read out of the
 * installed build before writing a line:
 *
 *   - `Animation` holds `animators` keyed by node uuid (js/animations/animation.js)
 *   - `Animation.prototype.getBoneAnimator(node)` creates the animator on demand
 *   - `BoneAnimator.prototype.channels` = rotation / position / scale
 *   - `Animator.prototype.createKeyframe(value, time, channel, undo, select)` is what
 *     Blockbench's own "add keyframe" button uses: it snaps the time
 *     (`Timeline.snapTime`), replaces overlapping keyframes on the same channel and
 *     extends the animation length. Reusing it means agent-authored animations
 *     behave exactly like hand-authored ones.
 *   - `Keyframe.interpolation` accepts linear / catmullrom / bezier / step
 *   - `Timeline.setTime(time)` scrubs the playhead
 */

import { animationClass, groupClass, timeline, tryGlobal, type BBAnimation, type BBAnimator, type BBGroup, type BBNode } from '../env.js';
import { tool, type JsonSchema } from '../../shared/protocol.js';
import { animationSummary, captureAnimations, keyframeSummary } from '../state.js';
import { ToolExecutionError, ToolValidationError, asRecord, defineTool, numericArray, resolveNode, type RegisteredTool } from './registry.js';

const INTERPOLATIONS = ['linear', 'catmullrom', 'bezier', 'step'] as const;
const CHANNELS = ['rotation', 'position', 'scale'] as const;

function allAnimations(): BBAnimation[] {
  const registry = tryGlobal<{ animations?: BBAnimation[] }>('Animator');
  return Array.isArray(registry?.animations) ? registry!.animations! : captureAnimations();
}

function findAnimation(name?: unknown, uuid?: unknown): BBAnimation {
  const animations = allAnimations();
  if (!animations.length) {
    throw new ToolExecutionError('The project has no animations yet. Create one with create_animation first.', 'not_found');
  }
  if (uuid) {
    const match = animations.find((animation) => String(animation.uuid) === uuid);
    if (match) return match;
  }
  if (name) {
    const match = animations.find((animation) => String(animation.name).toLowerCase() === String(name).toLowerCase());
    if (match) return match;
  }
  const selected = animations.find((animation) => animation.selected);
  if (selected) return selected;
  throw new ToolExecutionError(
    `No animation matches ${uuid ? `uuid "${uuid}"` : name ? `name "${name}"` : 'the current selection'}. Available: ${animations
      .map((animation) => animation.name)
      .join(', ')}`,
    'not_found',
  );
}

/**
 * Resolves the animator for a node.
 *
 * Bones are groups in Blockbench, so a group lookup is the primary path. Formats
 * without a rig (Bedrock effects, Java) also expose name-keyed effect/timeline
 * animators, which are matched by their `_name`.
 */
function resolveAnimator(animation: BBAnimation, reference: unknown): { animator: BBAnimator; label: string } {
  const record = asRecord(reference);
  const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;

  if (!uuid && !name) {
    const groupSelection = groupClass()?.multi_selected ?? [];
    const first = groupSelection[0] ?? (groupClass()?.first_selected as BBGroup | undefined);
    if (first) {
      const animator = animation.getBoneAnimator(first as unknown as BBNode);
      if (animator) return { animator, label: String(first.name) };
    }
    throw new ToolValidationError('A node is required: pass the group (bone) name or uuid that this keyframe animates.');
  }

  if (uuid) {
    const existing = animation.animators[uuid];
    if (existing) return { animator: existing, label: uuid };
    const node = resolveNode({ uuid }, { types: ['group', 'armature_bone'], what: 'group' });
    const animator = animation.getBoneAnimator(node);
    if (!animator) throw new ToolExecutionError(`Animation "${animation.name}" cannot animate "${node.name}" in this format.`, 'unsupported');
    return { animator, label: String(node.name) };
  }

  const groupMatch = (groupClass()?.all ?? []).find((group) => String(group.name).toLowerCase() === String(name).toLowerCase());
  if (groupMatch) {
    const animator = animation.getBoneAnimator(groupMatch as unknown as BBNode);
    if (!animator) throw new ToolExecutionError(`Animation "${animation.name}" cannot animate "${groupMatch.name}".`, 'unsupported');
    return { animator, label: String(groupMatch.name) };
  }

  const byName = Object.entries(animation.animators ?? {}).find(
    ([, animator]) => String((animator as unknown as { _name?: string })._name ?? '').toLowerCase() === String(name).toLowerCase(),
  );
  if (byName) return { animator: byName[1], label: String(name) };

  throw new ToolExecutionError(
    `No group or animator named "${name}" exists. Create the bone first with create_bone/create_group.`,
    'not_found',
  );
}

interface KeyframeInput {
  node?: unknown;
  channel: string;
  time: number;
  x?: number;
  y?: number;
  z?: number;
  uniform?: boolean;
  interpolation?: string;
}

function applyValues(animator: BBAnimator, input: KeyframeInput, ctx?: { throwIfCancelled(): void }): ReturnType<BBAnimator['addKeyframe']> {
  ctx?.throwIfCancelled();
  const channel = CHANNELS.includes(input.channel as never) ? input.channel : 'rotation';
  const channels = (animator as unknown as { channels?: Record<string, unknown> }).channels ?? {};
  if (!channels[channel]) {
    throw new ToolExecutionError(
      `Animator "${String((animator as unknown as { _name?: string })._name ?? animator.type)}" has no "${channel}" channel (available: ${Object.keys(channels).join(', ') || 'none'}).`,
      'unsupported',
    );
  }
  const values: Record<string, unknown> = {};
  if (typeof input.x === 'number') values.x = input.x;
  if (typeof input.y === 'number') values.y = input.y;
  if (typeof input.z === 'number') values.z = input.z;
  if (typeof input.uniform === 'boolean') values.uniform = input.uniform;

  const createKeyframe = (animator as unknown as {
    createKeyframe?: (value: unknown, time: number, channel: string, undo?: boolean, select?: boolean) => unknown;
  }).createKeyframe;
  if (typeof createKeyframe !== 'function') {
    throw new ToolExecutionError('Animator.createKeyframe is unavailable in this build.', 'api_unavailable');
  }
  const created = createKeyframe.call(animator, Object.keys(values).length ? values : undefined, input.time, channel, false, false) as
    | { interpolation?: string }
    | undefined;
  if (!created) throw new ToolExecutionError(`Could not create a "${channel}" keyframe.`, 'execution_failed');
  if (input.interpolation && INTERPOLATIONS.includes(input.interpolation as never)) {
    created.interpolation = input.interpolation;
  }
  return created as never;
}

export function animationTools(): RegisteredTool[] {
  const animationAspects = (): { animations: unknown[] } => ({ animations: [] });

  return [
    {
      definition: defineTool({
        name: 'create_animation',
        title: 'Create animation',
        description:
          'Create a new empty animation. `loop` is once / loop / hold. Length is in the format\'s native time unit (seconds for Bedrock and Java). Pass `select: true` to make it the active animation, which is required before its keyframes are shown in the timeline.',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Animation name, e.g. "animation.trex.walk"'),
            loop: tool.enum('Loop mode', ['once', 'loop', 'hold']),
            length: tool.number('Length in seconds', { minimum: 0 }),
            snapping: tool.number('Snap rate in keyframes per second (1-120)', { minimum: 1, maximum: 120 }),
            select: tool.boolean('Make this the active animation', { default: true }),
          },
          required: ['name'],
          additionalProperties: false,
        },
        returns: 'AnimationSummary',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Create animation (AI agent)',
      handler: (args) => {
        const ctor = animationClass();
        const animation = new ctor({
          name: String(args.name),
          loop: typeof args.loop === 'string' ? args.loop : 'once',
          length: typeof args.length === 'number' ? args.length : 1,
          snapping: typeof args.snapping === 'number' ? args.snapping : 20,
          saved: false,
        });
        animation.createUniqueName?.();
        if (args.length !== undefined) animation.setLength();
        animation.add(false);
        if (args.select !== false) {
          animation.select();
        }
        return { data: animationSummary(animation), verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'select_animation',
        title: 'Select animation',
        description: 'Make an animation the active one, which is required for timeline and keyframe operations to apply to it.',
        group: 'animation',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { name: tool.string('Animation name'), uuid: tool.string('Animation uuid') },
          additionalProperties: false,
        },
        returns: 'AnimationSummary',
      }),
      handler: (args) => {
        const animation = findAnimation(args.name, args.uuid);
        animation.select();
        const time = (() => {
          try {
            timeline().setTime(0);
            return 0;
          } catch {
            return null;
          }
        })();
        return { data: { ...animationSummary(animation), time }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'modify_animation',
        title: 'Modify animation',
        description: 'Rename an animation or change its length, loop mode and snapping rate.',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Current animation name'),
            uuid: tool.string('Current animation uuid'),
            new_name: tool.string('New animation name'),
            length: tool.number('New length in seconds', { minimum: 0 }),
            loop: tool.enum('Loop mode', ['once', 'loop', 'hold']),
            snapping: tool.number('Snap rate in keyframes per second', { minimum: 1, maximum: 120 }),
          },
          additionalProperties: false,
        },
        returns: 'AnimationSummary',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Modify animation (AI agent)',
      handler: (args) => {
        const animation = findAnimation(args.name, args.uuid);
        if (typeof args.new_name === 'string') animation.name = args.new_name;
        if (typeof args.length === 'number') {
          animation.length = args.length;
          animation.setLength();
        }
        if (typeof args.loop === 'string') animation.setLoop(args.loop);
        if (typeof args.snapping === 'number') animation.snapping = args.snapping;
        return { data: animationSummary(animation), verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'delete_animation',
        title: 'Delete animation',
        description: 'Permanently delete an animation and all of its keyframes.',
        group: 'animation',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Animation name'),
            uuid: tool.string('Animation uuid'),
            confirm: tool.boolean('Must be true to confirm deletion', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ deleted, remaining }',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Delete animation (AI agent)',
      handler: (args) => {
        const animation = findAnimation(args.name, args.uuid);
        if (args.confirm !== true) {
          throw new ToolValidationError(`Refusing to delete "${animation.name}" without confirm: true.`);
        }
        const label = String(animation.name);
        const uuid = String(animation.uuid);
        animation.remove(false, false);
        const remaining = allAnimations().map((entry) => String(entry.name));
        const stillThere = allAnimations().some((entry) => String(entry.uuid) === uuid);
        return {
          data: { deleted: label, remaining },
          warnings: stillThere ? ['The animation is still present after deletion; Blockbench may require a UI refresh.'] : undefined,
          verified: !stillThere,
        };
      },
    },
    {
      definition: defineTool({
        name: 'create_keyframe',
        title: 'Create keyframe',
        description:
          'Create one keyframe on a bone. `time` is in the animation\'s native unit (seconds). For rotation and position x/y/z are degrees and Blockbench units; for scale they are multipliers (1 = unchanged). The keyframe is snapped and any previous keyframe at the same time on the same channel is replaced, exactly like the UI.',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            animation: tool.string('Animation name (defaults to the active animation)'),
            node: tool.string('Bone/group name or uuid this keyframe animates'),
            node_reference: {
              type: 'object',
              properties: { uuid: tool.string('Bone uuid'), name: tool.string('Bone name') },
            } as JsonSchema,
            channel: tool.enum('Channel', [...CHANNELS]),
            time: tool.number('Keyframe time in seconds', { minimum: 0 }),
            x: tool.number('X value'),
            y: tool.number('Y value'),
            z: tool.number('Z value'),
            interpolation: tool.enum('Interpolation', [...INTERPOLATIONS]),
          },
          required: ['channel', 'time'],
          additionalProperties: false,
        },
        returns: 'KeyframeSummary',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Create keyframe (AI agent)',
      handler: (args, ctx) => {
        const animation = findAnimation(args.animation, undefined);
        animation.select();
        const reference = (args.node_reference as Record<string, unknown>) ?? (typeof args.node === 'string' ? { name: args.node } : {});
        const { animator, label } = resolveAnimator(animation, reference);
        const created = applyValues(
          animator,
          {
            channel: String(args.channel),
            time: typeof args.time === 'number' ? args.time : 0,
            x: args.x as number,
            y: args.y as number,
            z: args.z as number,
            interpolation: args.interpolation as string,
          },
          ctx,
        );
        return {
          data: {
            animation: String(animation.name),
            bone: label,
            keyframe: keyframeSummary(created as never),
            animation_length: animation.length,
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'bulk_create_keyframes',
        title: 'Create many keyframes',
        description:
          'Create many keyframes across any number of bones in one call and one undo step. This is how a walk cycle or attack animation should be authored: describe every pose in a single call instead of one keyframe at a time.',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            animation: tool.string('Animation name (defaults to the active animation)'),
            keyframes: tool.array(
              'Keyframe definitions',
              {
                type: 'object',
                properties: {
                  node: tool.string('Bone/group name or uuid'),
                  channel: tool.enum('Channel', [...CHANNELS]),
                  time: tool.number('Time in seconds', { minimum: 0 }),
                  x: tool.number('X value'),
                  y: tool.number('Y value'),
                  z: tool.number('Z value'),
                  interpolation: tool.enum('Interpolation', [...INTERPOLATIONS]),
                },
                required: ['node', 'channel', 'time'],
                additionalProperties: false,
              },
              { minItems: 1, maxItems: 2000 },
            ),
            set_length: tool.boolean('Extend the animation length to fit the last keyframe', { default: true }),
          },
          required: ['keyframes'],
          additionalProperties: false,
        },
        returns: '{ created, max_time, animation_length, warnings }',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Bulk create keyframes (AI agent)',
      handler: (args, ctx) => {
        const animation = findAnimation(args.animation, undefined);
        animation.select();
        const list = args.keyframes as Array<Record<string, unknown>>;
        const warnings: string[] = [];
        let maxTime = 0;
        let created = 0;

        for (let index = 0; index < list.length; index++) {
          const entry = list[index];
          ctx.throwIfCancelled();
          if (index % 20 === 0) ctx.reportProgress(index, list.length, `keyframe ${index + 1}/${list.length}`);
          try {
            const { animator } = resolveAnimator(animation, { name: String(entry.node) });
            const time = typeof entry.time === 'number' ? entry.time : 0;
            applyValues(
              animator,
              {
                channel: String(entry.channel),
                time,
                x: entry.x as number,
                y: entry.y as number,
                z: entry.z as number,
                interpolation: entry.interpolation as string,
              },
              ctx,
            );
            created += 1;
            maxTime = Math.max(maxTime, time);
          } catch (error) {
            warnings.push(`keyframes[${index}] "${String(entry.node)}" ${String(entry.channel)}@${String(entry.time)}: ${(error as Error).message}`);
          }
        }

        if (args.set_length !== false && maxTime > animation.length) {
          animation.length = maxTime;
          animation.setLength();
        }
        ctx.reportProgress(list.length, list.length, 'keyframes created');
        return {
          data: {
            created,
            requested: list.length,
            max_time: maxTime,
            animation: String(animation.name),
            animation_length: animation.length,
          },
          warnings: warnings.length ? warnings : undefined,
          verified: created === list.length,
        };
      },
    },
    {
      definition: defineTool({
        name: 'modify_keyframe',
        title: 'Modify keyframe',
        description:
          'Change an existing keyframe: move it in time or change its x/y/z values and interpolation. The keyframe is located by bone + channel + time (within half a snapping step).',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            animation: tool.string('Animation name (defaults to the active animation)'),
            node: tool.string('Bone/group name or uuid'),
            channel: tool.enum('Channel', [...CHANNELS]),
            time: tool.number('Time of the keyframe to change', { minimum: 0 }),
            new_time: tool.number('New time', { minimum: 0 }),
            x: tool.number('New X value'),
            y: tool.number('New Y value'),
            z: tool.number('New Z value'),
            interpolation: tool.enum('New interpolation', [...INTERPOLATIONS]),
          },
          required: ['node', 'channel', 'time'],
          additionalProperties: false,
        },
        returns: 'KeyframeSummary',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Modify keyframe (AI agent)',
      handler: (args) => {
        const animation = findAnimation(args.animation, undefined);
        const { animator, label } = resolveAnimator(animation, { name: String(args.node) });
        const frames = ((animator as unknown as Record<string, unknown>)[String(args.channel)] as Array<{ time: number }>) ?? [];
        if (!Array.isArray(frames)) throw new ToolExecutionError(`The animator has no "${String(args.channel)}" channel.`, 'unsupported');
        const targetTime = typeof args.time === 'number' ? args.time : 0;
        // Search tolerance: half a snapping step when the timeline exposes one.
        const epsilon = (() => {
          try {
            const api = timeline() as { getStep?: () => number };
            const step = typeof api.getStep === 'function' ? api.getStep() : 0;
            return step > 0 ? step / 2 : 0.05;
          } catch {
            return 0.05;
          }
        })();
        const frame = frames.find((entry) => Math.abs(Number(entry.time) - targetTime) <= epsilon) as
          | (Record<string, unknown> & { set(axis: string, value: unknown): void })
          | undefined;
        if (!frame) {
          throw new ToolExecutionError(
            `No "${String(args.channel)}" keyframe on "${label}" near t=${targetTime} (found ${frames.map((entry) => Number(entry.time)).join(', ') || 'none'}).`,
            'not_found',
          );
        }
        if (typeof args.new_time === 'number') frame.time = args.new_time;
        for (const axis of ['x', 'y', 'z'] as const) {
          const value = args[axis];
          if (typeof value === 'number') {
            if (typeof frame.set === 'function') frame.set(axis, value);
            else {
              const points = frame.data_points as Array<Record<string, unknown>> | undefined;
              if (points?.[0]) points[0][axis] = value;
            }
          }
        }
        if (typeof args.interpolation === 'string' && INTERPOLATIONS.includes(args.interpolation as never)) {
          frame.interpolation = args.interpolation;
        }
        return { data: { bone: label, keyframe: keyframeSummary(frame as never) }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'delete_keyframe',
        title: 'Delete keyframe',
        description: 'Delete a keyframe by bone + channel + time, or clear every keyframe of a bone/channel in a time range.',
        group: 'animation',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            animation: tool.string('Animation name (defaults to the active animation)'),
            node: tool.string('Bone/group name or uuid'),
            channel: tool.enum('Channel', [...CHANNELS]),
            time: tool.number('Time of the keyframe to delete'),
            from_time: tool.number('Delete keyframes at or after this time'),
            to_time: tool.number('Delete keyframes at or before this time'),
            delete_all: tool.boolean('Delete every keyframe on that bone/channel', { default: false }),
          },
          required: ['node', 'channel'],
          additionalProperties: false,
        },
        returns: '{ deleted: KeyframeSummary[], remaining }',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Delete keyframes (AI agent)',
      handler: (args, ctx) => {
        const animation = findAnimation(args.animation, undefined);
        const { animator, label } = resolveAnimator(animation, { name: String(args.node) });
        const frames = ((animator as unknown as Record<string, unknown>)[String(args.channel)] as Array<{
          time: number;
          remove(): void;
        }>) ?? [];
        if (!Array.isArray(frames)) throw new ToolExecutionError(`The animator has no "${String(args.channel)}" channel.`, 'unsupported');
        ctx.throwIfCancelled();

        const deleted: ReturnType<typeof keyframeSummary>[] = [];
        const from = typeof args.from_time === 'number' ? args.from_time : null;
        const to = typeof args.to_time === 'number' ? args.to_time : null;
        const at = typeof args.time === 'number' ? args.time : null;

        const victims = frames.filter((frame) => {
          const time = Number(frame.time);
          if (args.delete_all === true) return true;
          if (at !== null) return Math.abs(time - at) <= 0.05;
          if (from !== null && time < from) return false;
          if (to !== null && time > to) return false;
          return from !== null || to !== null;
        });
        for (const frame of [...victims]) {
          deleted.push(keyframeSummary(frame as never));
          frame.remove();
        }
        const remaining = (((animator as unknown as Record<string, unknown>)[String(args.channel)] as unknown[]) ?? []).length;
        return {
          data: { bone: label, channel: String(args.channel), deleted, remaining },
          warnings: victims.length === 0 ? ['No keyframes matched the given time criteria.'] : undefined,
          verified: deleted.length === victims.length,
        };
      },
    },
    {
      definition: defineTool({
        name: 'set_animation_time',
        title: 'Set timeline time',
        description:
          'Scrub the playhead to a time and optionally start or stop playback. Use this to inspect a specific pose with get_viewport_image.',
        group: 'animation',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            time: tool.number('Playhead time in seconds', { minimum: 0 }),
            playing: tool.boolean('Start or stop playback'),
          },
          additionalProperties: false,
        },
        returns: '{ time, playing }',
      }),
      handler: (args) => {
        const api = timeline();
        if (typeof args.time === 'number') api.setTime(args.time);
        const animation = allAnimations().find((entry) => entry.selected);
        if (typeof args.playing === 'boolean' && animation) {
          animation.playing = args.playing;
        }
        return {
          data: { time: Number(api.time ?? 0), playing: !!animation?.playing, animation: animation ? String(animation.name) : null },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'duplicate_animation',
        title: 'Duplicate animation',
        description:
          'Copy an existing animation, including all keyframes and animators, under a new name. The preferred way to build a family of animations (idle, walk, run) from one base pose set.',
        group: 'animation',
        danger: 'mutating',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Source animation name'),
            new_name: tool.string('Name for the copy'),
            select: tool.boolean('Select the copy afterwards', { default: false }),
          },
          required: ['name'],
          additionalProperties: false,
        },
        returns: 'AnimationSummary',
      }),
      undoAspects: animationAspects,
      undoMessage: 'Duplicate animation (AI agent)',
      handler: (args) => {
        const source = findAnimation(args.name, undefined);
        const undoCopy = (source as unknown as { getUndoCopy?: (options?: unknown, save?: unknown) => Record<string, unknown> }).getUndoCopy;
        const data = typeof undoCopy === 'function' ? undoCopy.call(source, {}, false) : { ...(source as unknown as Record<string, unknown>) };
        const ctor = animationClass();
        const copy = new ctor({ ...data, name: String(args.new_name ?? `${source.name}_copy`) });
        copy.createUniqueName?.();
        copy.saved = false;
        const registry = tryGlobal<{ animations?: BBAnimation[] }>('Animator');
        const list = registry?.animations;
        if (Array.isArray(list)) {
          const index = list.indexOf(source);
          list.splice(index >= 0 ? index + 1 : list.length, 0, copy);
        } else {
          copy.add(false);
        }
        if (args.select === true) copy.select();
        const keyframes = Object.values(copy.animators ?? {}).reduce(
          (total, animator) => total + (animator.keyframes?.length ?? 0),
          0,
        );
        void numericArray;
        return { data: { ...animationSummary(copy, true), keyframe_count: keyframes }, verified: true };
      },
    },
  ];
}
