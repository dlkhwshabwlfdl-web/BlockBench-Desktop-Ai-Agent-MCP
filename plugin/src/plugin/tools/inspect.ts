/**
 * Inspection tools (requirement #2).
 *
 * These are how the agent understands the workspace: structured, complete state
 * rather than raw `.bbmodel` parsing. Read-only, so none of them declare undo
 * aspects and none of them can damage a project.
 */

import {
  bb,
  canvasApi,
  format,
  groupClass,
  maybeProject,
  outliner,
  previewApi,
  timeline,
  tryGlobal,
  type BBAnimation,
  type BBCube,
} from '../env.js';
import {
  animationSummary,
  captureAnimations,
  captureNodeTree,
  captureProject,
  captureSelection,
  captureTextures,
  captureUndo,
  captureViewport,
  keyframeSummary,
  nodeSummary,
} from '../state.js';
import { probeCapabilities, summariseCapabilities } from '../capabilities.js';
import { tool, type JsonSchema } from '../../shared/protocol.js';
import type { NodeReference } from '../../shared/protocol.js';
import { ToolExecutionError, asRecord, defineTool, numericArray, resolveNode, type RegisteredTool, type ToolContext } from './registry.js';

const referenceSchema: JsonSchema = {
  type: 'object',
  description: 'Reference to an outliner node. Supply uuid or name; omit both to use the current selection.',
  properties: {
    uuid: tool.string('Exact node uuid'),
    name: tool.string('Node name (case insensitive; must be unique)'),
  },
};

function projectArg(reference: unknown): NodeReference {
  return (asRecord(reference) as NodeReference) ?? {};
}

function cubeStats(cube: BBCube): Record<string, unknown> {
  const from = numericArray(cube.from) ?? [0, 0, 0];
  const to = numericArray(cube.to) ?? [0, 0, 0];
  const size = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return {
    uuid: cube.uuid,
    name: cube.name,
    from,
    to,
    size,
    volume: Math.abs(size[0] * size[1] * size[2]),
    origin: numericArray(cube.origin),
    rotation: numericArray(cube.rotation),
    inflate: cube.inflate,
    mirror_uv: cube.mirror_uv,
    box_uv: cube.box_uv,
    autouv: cube.autouv,
    uv_offset: numericArray(cube.uv_offset),
    visible: cube.visibility !== false,
    locked: !!cube.locked,
    parent: cube.parent && cube.parent !== 'root' ? (cube.parent as { name?: string }).name ?? null : null,
  };
}

export function inspectTools(): RegisteredTool[] {
  return [
    {
      definition: defineTool({
        name: 'list_capabilities',
        title: 'List capabilities',
        description:
          'Report the running Blockbench build: version, platform, active format, which APIs were verified to exist, installed plugins, known limitations and the full list of real event names. Call this first when you need to know what the environment can do.',
        group: 'discovery',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false, description: 'No arguments.' },
        returns: 'CapabilityReport',
      }),
      handler: (_args, ctx) => {
        const report = probeCapabilities();
        ctx.log('info', summariseCapabilities(report));
        return { data: report, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_project',
        title: 'Inspect project',
        description:
          'Full project header: Blockbench version, project name and path, active model format and its capabilities (bone rig, box UV, animation mode, rotation limit), target version, resolution, saved state and element/group/texture/animation counts.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: '{ project: ProjectSnapshot | null, undo: {index,length} | null }',
      }),
      handler: () => {
        const current = maybeProject();
        return {
          data: {
            project: captureProject(),
            undo: captureUndo(),
            open_projects: (tryGlobal<{ all?: unknown[] }>('ModelProject')?.all ?? []).length,
            open_project: current ? String(current.name ?? '') : null,
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_model',
        title: 'Inspect model',
        description:
          'Model level geometry statistics: total cubes, bounding box and overall size in Blockbench units, combined volume, per-axis histogram of element sizes, hidden and locked element counts, and how many cubes still have no texture assigned.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            include_cubes: tool.boolean('Include the full per-cube list (can be large)', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ bounding_box, size, stats, cubes? }',
      }),
      handler: (args) => {
        const current = maybeProject();
        if (!current) throw new ToolExecutionError('No project is open.', 'no_project');
        const cubes = ((current.elements ?? []) as BBCube[]).filter((element) => String(element.type) === 'cube');
        const boxes = cubes.map((cube) => ({ from: numericArray(cube.from) ?? [0, 0, 0], to: numericArray(cube.to) ?? [0, 0, 0] }));
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        let volume = 0;
        let untagged = 0;
        for (let i = 0; i < boxes.length; i++) {
          const { from, to } = boxes[i];
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], from[axis]);
            max[axis] = Math.max(max[axis], to[axis]);
          }
          volume += Math.abs((to[0] - from[0]) * (to[1] - from[1]) * (to[2] - from[2]));
          const faces = (cubes[i] as unknown as { faces?: Record<string, { texture?: unknown }> }).faces ?? {};
          if (!Object.values(faces).some((face) => !!face?.texture)) untagged += 1;
        }
        const finite = (value: number) => (Number.isFinite(value) ? value : 0);
        let canvasSize: number[] | null = null;
        try {
          canvasSize = canvasApi().getModelSize();
        } catch {
          canvasSize = null;
        }
        const result: Record<string, unknown> = {
          cube_count: cubes.length,
          element_count: (current.elements ?? []).length,
          bounding_box: boxes.length ? { min: min.map(finite), max: max.map(finite) } : null,
          size: boxes.length ? [finite(max[0] - min[0]), finite(max[1] - min[1]), finite(max[2] - min[2])] : null,
          canvas_model_size: canvasSize,
          total_volume: Math.round(volume * 100) / 100,
          cube_height_distribution: (() => {
            const buckets: Record<string, number> = {};
            for (const box of boxes) {
              const height = Math.abs(box.to[1] - box.from[1]);
              const key = height <= 1 ? '1' : height <= 2 ? '2' : height <= 4 ? '3-4' : height <= 8 ? '5-8' : '9+';
              buckets[key] = (buckets[key] ?? 0) + 1;
            }
            return buckets;
          })(),
          hidden_elements: ((current.elements ?? []) as BBCube[]).filter((cube) => cube.visibility === false).length,
          locked_elements: ((current.elements ?? []) as BBCube[]).filter((cube) => !!cube.locked).length,
          cubes_without_texture: untagged,
          mesh_count: ((current.elements ?? []) as Array<{ type?: string }>).filter((element) => element.type === 'mesh').length,
        };
        if (args.include_cubes) result.cubes = cubes.map(cubeStats);
        return { data: result, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_hierarchy',
        title: 'Inspect hierarchy',
        description:
          'The outliner tree: groups and their children with pivots, rotations, visibility and, for cubes, from/to/size. Use `max_depth` to keep the payload small and `root` to inspect only a subtree.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            max_depth: tool.integer('How deep to descend (1-32)', { default: 12, minimum: 1, maximum: 32 }),
            root: referenceSchema,
          },
          additionalProperties: false,
        },
        returns: 'NodeSummary[]',
      }),
      handler: (args) => {
        if (args.root && Object.keys(asRecord(args.root)).length) {
          const node = resolveNode(projectArg(args.root));
          return {
            data: [nodeSummary(node, true)],
            warnings: ['max_depth is not applied when an explicit root is given'],
            verified: true,
          };
        }
        const depth = typeof args.max_depth === 'number' ? args.max_depth : 12;
        const tree = captureNodeTree(depth);
        return {
          data: {
            tree,
            group_count: groupClass()?.all?.length ?? 0,
            element_count: outliner()?.elements?.length ?? 0,
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_node',
        title: 'Inspect node',
        description:
          'Everything about a single node: full geometry, pivot, rotation, UV settings, per-face texture/UV/cullface, and its direct children.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { ...referenceSchema.properties, reference: referenceSchema, uuid: tool.string('Node uuid'), name: tool.string('Node name') },
          additionalProperties: false,
        },
        returns: '{ node, faces?, children }',
      }),
      handler: (args) => {
        const node = resolveNode((args.reference as NodeReference) ?? { uuid: args.uuid as string, name: args.name as string });
        const cube = node as unknown as BBCube;
        const faces = cube.faces
          ? Object.fromEntries(
              Object.entries(cube.faces).map(([name, face]) => [
                name,
                {
                  uv: numericArray(face.uv),
                  rotation: face.rotation,
                  texture: typeof face.texture === 'string' ? face.texture : null,
                  enabled: face.enabled !== false,
                  tint: face.tint,
                  cullface: face.cullface ?? null,
                },
              ]),
            )
          : undefined;
        return {
          data: {
            node: nodeSummary(node, false),
            geometry: String(node.type) === 'cube' ? cubeStats(cube) : null,
            faces,
            children: (node.children ?? []).map((child) => nodeSummary(child as never, false)),
            parent: node.parent && node.parent !== 'root' ? nodeSummary(node.parent as never, false) : null,
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_selection',
        title: 'Inspect selection',
        description: 'What the user currently has selected: groups, elements, textures, animation, keyframes and active mode.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: 'SelectionSummary',
      }),
      handler: () => ({ data: captureSelection(), verified: true }),
    },
    {
      definition: defineTool({
        name: 'inspect_animations',
        title: 'Inspect animations',
        description:
          'Every animation in the project with its length, loop mode, snapping, marker names, animator count and total keyframe count.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { include_animators: tool.boolean('Include per-animator channel breakdown', { default: true }) },
          additionalProperties: false,
        },
        returns: 'AnimationSummary[]',
      }),
      handler: (args) => {
        const animations = captureAnimations();
        return {
          data: {
            animations: animations.map((animation) => animationSummary(animation, args.include_animators !== false)),
            selected: (() => {
              try {
                return timeline() ? String((tryGlobal<{ selected?: { name?: string } }>('AnimationItem')?.selected?.name ?? '')) : null;
              } catch {
                return null;
              }
            })(),
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_animation',
        title: 'Inspect animation',
        description:
          'One animation in full: its animators and, for each animator and channel, the keyframes with time, interpolation and data point values.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Animation name'),
            uuid: tool.string('Animation uuid'),
            include_keyframes: tool.boolean('Include keyframe values (default true)', { default: true }),
          },
          additionalProperties: false,
        },
        returns: '{ animation, animators: [{ node, channels: { channel: KeyframeSummary[] } }] }',
      }),
      handler: (args) => {
        const animations = captureAnimations();
        if (!animations.length) throw new ToolExecutionError('The project has no animations.', 'not_found');
        const wanted = animations.filter((animation) =>
          args.uuid ? String(animation.uuid) === args.uuid : args.name ? String(animation.name).toLowerCase() === String(args.name).toLowerCase() : true,
        );
        const animation = wanted[0] ?? animations[0];
        const includeKeyframes = args.include_keyframes !== false;
        const animators = Object.entries(animation.animators ?? {}).map(([key, animator]) => {
          const node = (() => {
            try {
              return [...(groupClass()?.all ?? [])].find((group) => String(group.uuid) === key);
            } catch {
              return undefined;
            }
          })();
          return {
            uuid: key,
            type: String(animator.type ?? ''),
            name: String((animator as unknown as { _name?: string })._name ?? node?.name ?? ''),
            muted: !!animator.muted,
            channels: (() => {
              const record: Record<string, unknown> = {};
              for (const channel of ['rotation', 'position', 'scale']) {
                const frames = (animator as unknown as Record<string, unknown>)[channel];
                if (!Array.isArray(frames)) continue;
                record[channel] = includeKeyframes
                  ? (frames as BBKeyframeLike[]).map((frame) => keyframeSummary(frame as never))
                  : { keyframe_count: frames.length };
              }
              return record;
            })(),
          };
        });
        return {
          data: { animation: animationSummary(animation, false), animators },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_textures',
        title: 'Inspect textures',
        description:
          'Every texture in the project: name, pixel dimensions, file path, whether it is embedded, how its source is stored (data URL, path or empty), render mode and selection.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: 'TextureSummary[]',
      }),
      handler: () => {
        const current = maybeProject();
        return {
          data: {
            textures: captureTextures(),
            resolution: current ? { width: current.resolution?.width, height: current.resolution?.height } : null,
            per_texture_uv_size: !!format().per_texture_uv_size,
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_uv',
        title: 'Inspect UV',
        description:
          'UV mapping of one or more cubes: per-face UV rectangles, rotation, assigned texture, cullface; plus the cube-level uv_offset, autouv mode and box_uv flag. Also reports whether every UV rectangle fits inside the texture.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            include_all_cubes: tool.boolean('Inspect every cube instead of a single node', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ cubes: [...], out_of_bounds: [...] }',
      }),
      handler: (args) => {
        const current = maybeProject();
        if (!current) throw new ToolExecutionError('No project is open.', 'no_project');
        const cubes: BBCube[] = args.include_all_cubes
          ? (((current.elements ?? []) as BBCube[]).filter((element) => String(element.type) === 'cube') as BBCube[])
          : [resolveNode(projectArg(args.reference), { types: ['cube'], what: 'cube' }) as unknown as BBCube];

        const width = current.resolution?.width ?? 16;
        const height = current.resolution?.height ?? 16;
        const outOfBounds: Array<Record<string, unknown>> = [];
        const mapped = cubes.map((cube) => {
          const faces = Object.fromEntries(
            Object.entries(cube.faces ?? {}).map(([name, face]) => {
              const uv = numericArray(face.uv);
              if (uv && uv.length === 4) {
                const exceeds = uv[0] < 0 || uv[1] < 0 || uv[2] > width || uv[3] > height;
                if (exceeds) outOfBounds.push({ cube: cube.name, uuid: cube.uuid, face: name, uv, texture_bounds: [width, height] });
              }
              return [
                name,
                { uv, rotation: face.rotation, texture: face.texture ?? null, enabled: face.enabled !== false, cullface: face.cullface ?? null },
              ];
            }),
          );
          return { uuid: cube.uuid, name: cube.name, uv_offset: numericArray(cube.uv_offset), autouv: cube.autouv, box_uv: cube.box_uv, faces };
        });
        return {
          data: { texture_bounds: [width, height], cubes: mapped, out_of_bounds: outOfBounds },
          warnings: outOfBounds.length ? [`${outOfBounds.length} UV rectangles fall outside the texture bounds.`] : undefined,
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'inspect_viewport',
        title: 'Inspect viewport',
        description:
          'Viewport state: active preview, camera position and target, orthographic zoom, view mode, shading, display slot and how many elements are currently visible versus hidden. Use get_viewport_image afterwards for actual pixels.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: { type: 'object', properties: {}, additionalProperties: false },
        returns: '{ viewport, previews, angle_presets }',
      }),
      handler: () => {
        let previewIds: string[] = [];
        try {
          previewIds = (previewApi()?.all ?? []).map((preview) => String(preview.id));
        } catch {
          previewIds = [];
        }
        return {
          data: {
            viewport: captureViewport(),
            previews: previewIds,
            angle_presets: (tryGlobal<Array<{ id: string }>>('DefaultCameraPresets') ?? []).map((preset) => String(preset.id)),
            mode: (() => {
              try {
                return String((tryGlobal<{ id?: string }>('Modes')?.id ?? '')) || null;
              } catch {
                return null;
              }
            })(),
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'validate_model',
        title: 'Validate model',
        description:
          'Self-check the project and return concrete defects with severity: zero or negative size cubes, duplicate names, elements without textures, UV rectangles outside the texture, empty groups, animations without keyframes, missing pivots and unreferenced textures. Run this after building and before saving.',
        group: 'inspect',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            max_issues: tool.integer('Cap the number of reported issues', { default: 60, minimum: 1, maximum: 500 }),
          },
          additionalProperties: false,
        },
        returns: '{ issues: [{severity, code, message, node?}], summary, ok }',
      }),
      handler: (args, ctx: ToolContext) => {
        const current = maybeProject();
        if (!current) throw new ToolExecutionError('No project is open.', 'no_project');
        const max = typeof args.max_issues === 'number' ? args.max_issues : 60;
        interface Issue {
          severity: 'error' | 'warning' | 'info';
          code: string;
          message: string;
          node?: { uuid: string; name: string };
        }
        const issues: Issue[] = [];
        const push = (issue: Issue) => {
          if (issues.length < max) issues.push(issue);
        };

        const cubes = (((current.elements ?? []) as BBCube[]).filter((element) => String(element.type) === 'cube') as BBCube[]);
        const groups = groupClass()?.all ?? [];
        const textureIds = new Set(captureTextures().map((texture) => texture.uuid));
        const nameCounts = new Map<string, number>();
        const width = current.resolution?.width ?? 16;
        const height = current.resolution?.height ?? 16;

        for (const cube of cubes) {
          const node = { uuid: String(cube.uuid), name: String(cube.name) };
          nameCounts.set(String(cube.name).toLowerCase(), (nameCounts.get(String(cube.name).toLowerCase()) ?? 0) + 1);
          const from = numericArray(cube.from) ?? [0, 0, 0];
          const to = numericArray(cube.to) ?? [0, 0, 0];
          const size = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
          if (size.some((value) => Math.abs(value) < 0.05)) {
            push({ severity: 'error', code: 'zero_size_cube', message: `Cube "${cube.name}" is degenerate (size ${size.join(' x ')}).`, node });
          }
          if (size.some((value) => value < 0)) {
            push({
              severity: 'warning',
              code: 'negative_size_cube',
              message: `Cube "${cube.name}" has from > to on some axis (${size.join(' x ')}); Blockbench will render it inverted.`,
              node,
            });
          }
          const faces = Object.entries(cube.faces ?? {});
          const textured = faces.filter(([, face]) => !!face.texture);
          if (textured.length === 0) {
            push({ severity: 'warning', code: 'untextured_cube', message: `Cube "${cube.name}" has no texture assigned on any face.`, node });
          }
          for (const [faceName, face] of faces) {
            if (typeof face.texture === 'string' && !textureIds.has(face.texture)) {
              push({
                severity: 'error',
                code: 'dangling_texture',
                message: `Cube "${cube.name}" face ${faceName} references texture ${face.texture} which is not in the project.`,
                node,
              });
            }
            const uv = numericArray(face.uv);
            if (uv && uv.length === 4 && (uv[0] < 0 || uv[1] < 0 || uv[2] > width || uv[3] > height)) {
              push({
                severity: 'warning',
                code: 'uv_out_of_bounds',
                message: `Cube "${cube.name}" face ${faceName} UV [${uv.join(', ')}] exceeds the ${width}x${height} texture.`,
                node,
              });
            }
          }
          const origin = numericArray(cube.origin) ?? [0, 0, 0];
          const outside =
            origin[0] < Math.min(from[0], to[0]) - 0.001 ||
            origin[0] > Math.max(from[0], to[0]) + 0.001 ||
            origin[1] < Math.min(from[1], to[1]) - 0.001 ||
            origin[1] > Math.max(from[1], to[1]) + 0.001 ||
            origin[2] < Math.min(from[2], to[2]) - 0.001 ||
            origin[2] > Math.max(from[2], to[2]) + 0.001;
          if (outside) {
            push({
              severity: 'info',
              code: 'pivot_outside_cube',
              message: `Cube "${cube.name}" pivot [${origin.join(', ')}] sits outside its volume; rotations will orbit away from the cube.`,
              node,
            });
          }
        }

        for (const [name, count] of nameCounts) {
          if (count > 1) push({ severity: 'info', code: 'duplicate_cube_name', message: `${count} cubes share the name "${name}".` });
        }
        for (const group of groups) {
          if (!group.children || group.children.length === 0) {
            push({
              severity: 'warning',
              code: 'empty_group',
              message: `Group "${group.name}" has no children; it will export as an empty bone.`,
              node: { uuid: String(group.uuid), name: String(group.name) },
            });
          }
        }
        const usedTextures = new Set<string>();
        for (const cube of cubes) {
          for (const face of Object.values(cube.faces ?? {})) {
            if (typeof face.texture === 'string') usedTextures.add(face.texture);
          }
        }
        for (const texture of captureTextures()) {
          if (!usedTextures.has(texture.uuid) && texture.particle === false) {
            push({ severity: 'info', code: 'unused_texture', message: `Texture "${texture.name}" is not assigned to any face.` });
          }
        }
        for (const animation of captureAnimations()) {
          const frames = Object.values(animation.animators ?? {}).reduce(
            (total, animator) => total + ((animator.keyframes?.length as number) ?? 0),
            0,
          );
          if (!frames) {
            push({
              severity: 'warning',
              code: 'empty_animation',
              message: `Animation "${animation.name}" has no keyframes.`,
            });
          }
          if (!animation.length) {
            push({ severity: 'info', code: 'zero_length_animation', message: `Animation "${animation.name}" has length 0.` });
          }
        }

        const errors = issues.filter((issue) => issue.severity === 'error').length;
        const warnings = issues.filter((issue) => issue.severity === 'warning').length;
        ctx.log('info', `validate_model: ${errors} errors, ${warnings} warnings`);
        return {
          data: {
            ok: errors === 0,
            summary: { errors, warnings, info: issues.length - errors - warnings, total: issues.length, truncated: issues.length >= max },
            issues,
            counts: { cubes: cubes.length, groups: groups.length, textures: textureIds.size, animations: captureAnimations().length },
          },
          verified: true,
        };
      },
    },
  ];
}

interface BBKeyframeLike {
  uuid: string;
  time: number;
  channel: string;
  interpolation: string;
  data_points: unknown[];
}

/** Re-exported so other tool modules can reuse the animation inspectors. */
export { animationSummary };
export type { BBAnimation };
export { bb };
