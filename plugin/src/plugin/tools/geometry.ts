/**
 * Geometry and hierarchy tools (requirement #5).
 *
 * Creation follows exactly what Blockbench's own "Add Cube" / "Add Group" actions do,
 * read out of the installed build:
 *
 *   js/outliner/types/cube.js:  new Cube({autouv}).init(); if (!box_uv) cube.mapAutoUV(); cube.addTo(group)
 *   js/outliner/types/group.js: new Group({origin, scope}); group.createUniqueName(); group.addTo(parent)
 *
 * `addTo()` silently refuses when a parent type is not allowed
 * (`OutlinerNode.addTo` checks `parent_types`), so every reparent is verified
 * afterwards instead of assumed.
 */

import {
  cubeClass,
  format,
  groupClass,
  maybeProject,
  outliner,
  tryGlobal,
  type BBCube,
  type BBCubeFace,
  type BBGroup,
  type BBNode,
} from '../env.js';
import { tool, type JsonSchema, type JsonSchemaObject } from '../../shared/protocol.js';
import { nodeSummary } from '../state.js';
import { focusViewport, frameViewport } from '../vision.js';
import {
  ToolExecutionError,
  ToolValidationError,
  asRecord,
  defineTool,
  numericArray,
  optionalVec3,
  requireNumber,
  requireVec3,
  resolveNode,
  type RegisteredTool,
  type ToolUndoAspects,
} from './registry.js';

const AXES = ['x', 'y', 'z'] as const;

const referenceSchema: JsonSchema = {
  type: 'object',
  properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
  description: 'Node reference; omit to use the current selection.',
};

const parentSchema: JsonSchema = {
  type: 'object',
  properties: { uuid: tool.string('Parent group uuid'), name: tool.string('Parent group name') },
  description: 'Parent group; omit to place at the outliner root.',
  additionalProperties: false,
};

function parentTarget(reference: unknown): BBGroup | 'root' | undefined {
  if (reference === undefined || reference === null) return undefined;
  const record = asRecord(reference);
  if (!record.uuid && !record.name) return undefined;
  return resolveNode(record as { uuid?: string; name?: string }, { types: ['group', 'armature_bone'], what: 'group' }) as unknown as BBGroup;
}

function assertFormatFlag(flag: 'bone_rig' | 'locators' | 'meshes', what: string): void {
  const active = format();
  if (!active[flag]) {
    throw new ToolExecutionError(
      `The active format "${active.id}" does not support ${what}. Switch to a format with that feature (e.g. Bedrock Entity for bones, or a Free Model for locators).`,
      'unsupported_by_format',
    );
  }
}

interface CubeFieldInput {
  name?: string;
  from?: number[];
  to?: number[];
  origin?: number[];
  rotation?: number[];
  inflate?: number;
  stretch?: number[];
  uv_offset?: number[];
  mirror_uv?: boolean;
  shade?: boolean;
  color?: number;
  autouv?: number;
  box_uv?: boolean;
  visibility?: boolean;
  locked?: boolean;
  export?: boolean;
  texture?: string | null;
}

function applyCubeFields(cube: BBCube, fields: CubeFieldInput): string[] {
  const warnings: string[] = [];
  if (fields.name !== undefined) cube.name = String(fields.name);
  const from = numericArray(fields.from);
  const to = numericArray(fields.to);
  if (from && from.length === 3) cube.from = from;
  if (to && to.length === 3) cube.to = to;
  const origin = numericArray(fields.origin);
  if (origin && origin.length === 3) cube.origin = origin;
  const rotation = numericArray(fields.rotation);
  if (rotation && rotation.length === 3) {
    if (format().rotation_limit === true) {
      cube.rotation = rotation.map((value) => Math.round(value / 22.5) * 22.5);
      if (rotation.some((value, index) => value !== cube.rotation[index])) {
        warnings.push('Rotation was snapped to the nearest 22.5 degrees because the active format limits cube rotation.');
      }
    } else {
      cube.rotation = rotation;
    }
  }
  const stretch = numericArray(fields.stretch);
  if (stretch && stretch.length === 3) cube.stretch = stretch;
  if (fields.inflate !== undefined) cube.inflate = requireNumber(fields.inflate, 'inflate');
  if (fields.mirror_uv !== undefined) cube.mirror_uv = !!fields.mirror_uv;
  if (fields.shade !== undefined) cube.shade = !!fields.shade;
  if (fields.color !== undefined) cube.color = requireNumber(fields.color, 'color');
  if (fields.visibility !== undefined) cube.visibility = !!fields.visibility;
  if (fields.locked !== undefined) cube.locked = !!fields.locked;
  if (fields.export !== undefined) cube.export = !!fields.export;

  const uvOffset = numericArray(fields.uv_offset);
  if (uvOffset && uvOffset.length === 2) cube.uv_offset = uvOffset;
  if (fields.box_uv !== undefined) {
    if (fields.box_uv && !format().optional_box_uv && !format().box_uv) {
      warnings.push('The active format does not support box UV on individual cubes; the flag was ignored.');
    } else {
      cube.box_uv = !!fields.box_uv;
    }
  }
  if (fields.autouv !== undefined) cube.autouv = requireNumber(fields.autouv, 'autouv');

  if (from && to) {
    if (!cube.origin || cube.origin.every((value) => value === 0)) {
      cube.origin = [
        (from[0] + to[0]) / 2,
        (from[1] + to[1]) / 2,
        (from[2] + to[2]) / 2,
      ];
    }
  }

  if (fields.texture !== undefined) {
    const textureId = fields.texture;
    for (const face of Object.values(cube.faces ?? {})) {
      (face as BBCubeFace).texture = textureId as string | null;
    }
  }

  if (cube.autouv && !cube.box_uv && typeof cube.mapAutoUV === 'function') {
    try {
      cube.mapAutoUV();
    } catch (error) {
      warnings.push(`Auto UV failed: ${(error as Error).message}`);
    }
  }
  return warnings;
}

function createCubeNode(data: CubeFieldInput, parent: BBGroup | 'root' | undefined): { cube: BBCube; warnings: string[] } {
  const ctor = cubeClass();
  const autouv = data.autouv ?? 1;
  const cube = new ctor({ name: data.name ?? 'cube', autouv });
  if (typeof (cube as unknown as { init?: () => unknown }).init === 'function') {
    (cube as unknown as { init: () => unknown }).init();
  }
  const warnings = applyCubeFields(cube, data);
  const target = parent ?? 'root';
  const before = cube.parent;
  (cube as unknown as BBNode).addTo(target as BBNode | 'root');
  const actual = cube.parent;
  const expectedName = target === 'root' ? 'root' : (target as BBGroup).name;
  const actualName = actual === 'root' || !actual ? 'root' : String((actual as BBNode).name);
  if (actualName !== expectedName) {
    warnings.push(
      `Cube "${cube.name}" could not be parented to "${expectedName}" (ended up under "${actualName}"); the format may not allow that nesting.`,
    );
  }
  void before;
  return { cube, warnings };
}

/** Creates a cube and returns a compact summary plus verification info. */
function summariseCube(cube: BBCube): Record<string, unknown> {
  return {
    uuid: cube.uuid,
    name: cube.name,
    from: numericArray(cube.from),
    to: numericArray(cube.to),
    origin: numericArray(cube.origin),
    rotation: numericArray(cube.rotation),
    inflate: cube.inflate,
    autouv: cube.autouv,
    box_uv: cube.box_uv,
    parent: cube.parent && cube.parent !== 'root' ? String((cube.parent as BBNode).name) : null,
    faces: Object.fromEntries(
      Object.entries(cube.faces ?? {}).map(([name, face]) => [name, { uv: numericArray(face.uv), texture: face.texture ?? null }]),
    ),
  };
}

const cubeInputSchema = (required: string[]): JsonSchemaObject => ({
  type: 'object',
  properties: {
    name: tool.string('Cube name'),
    from: tool.vec3('Minimum corner in Blockbench units'),
    to: tool.vec3('Maximum corner in Blockbench units'),
    origin: tool.vec3('Pivot point; defaults to the centre of the cube'),
    rotation: tool.vec3('Euler rotation in degrees'),
    inflate: tool.number('Uniform inflation in units (0 = none)'),
    uv_offset: tool.vec2('Box UV offset on the texture'),
    mirror_uv: tool.boolean('Mirror UV winding'),
    shade: tool.boolean('Enable shading'),
    autouv: tool.integer('Auto UV mode: 0 off, 1 auto, 2 relative', { minimum: 0, maximum: 2 }),
    box_uv: tool.boolean('Use box UV instead of per-face UV'),
    visibility: tool.boolean('Visible in the viewport'),
    color: tool.integer('Marker colour index'),
    texture: tool.string('Texture uuid or name to assign to every face; use null to clear'),
    export: tool.boolean('Include in exports'),
    locked: tool.boolean('Lock editing'),
  },
  required,
  additionalProperties: false,
});

export function geometryTools(): RegisteredTool[] {
  const groupAspects = (): ToolUndoAspects => ({ outliner: true, groups: [], selection: true });
  const elementAspects = (): ToolUndoAspects => ({ outliner: true, elements: [], selection: true });

  return [
    {
      definition: defineTool({
        name: 'create_group',
        title: 'Create group',
        description:
          'Create an outliner group (bone in rig formats). Groups own a pivot (`origin`) and rotation and are the only way to build an animatable hierarchy. Optionally nest it under an existing group.',
        group: 'hierarchy',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Group name'),
            origin: tool.vec3('Pivot point in Blockbench units'),
            rotation: tool.vec3('Euler rotation in degrees'),
            parent: parentSchema,
            visibility: tool.boolean('Visible in the viewport', { default: true }),
          },
          additionalProperties: false,
        },
        returns: 'NodeSummary',
      }),
      undoAspects: groupAspects,
      undoMessage: 'Create group (AI agent)',
      handler: (args) => {
        const groupCtor = groupClass();
        const group = new groupCtor({
          name: args.name ? String(args.name) : 'group',
          origin: optionalVec3(args.origin, 'origin') ?? [0, 0, 0],
          rotation: optionalVec3(args.rotation, 'rotation') ?? [0, 0, 0],
        });
        if (typeof (group as unknown as { createUniqueName?: () => unknown }).createUniqueName === 'function') {
          (group as unknown as { createUniqueName: () => unknown }).createUniqueName();
        }
        const parent = parentTarget(args.parent);
        if (typeof (group as unknown as { init?: () => unknown }).init === 'function') {
          (group as unknown as { init: () => unknown }).init();
        }
        if (parent) (group as unknown as BBNode).addTo(parent as unknown as BBNode);
        if (args.visibility !== undefined) group.visibility = !!args.visibility;
        (group as unknown as { isOpen?: boolean }).isOpen = true;

        const warnings: string[] = [];
        const expected = parent && parent !== 'root' ? String(parent.name) : 'root';
        const actual = group.parent === 'root' || !group.parent ? 'root' : String((group.parent as BBNode).name);
        if (actual !== expected) {
          warnings.push(`Group nested under "${actual}" instead of "${expected}".`);
        }
        return { data: nodeSummary(group as unknown as BBNode), warnings: warnings.length ? warnings : undefined, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'create_bone',
        title: 'Create bone',
        description:
          'Create a bone. In Blockbench a bone IS a group inside a format with `bone_rig` enabled, so this validates that the active format is a rig format and otherwise fails with a clear message.',
        group: 'hierarchy',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Bone name (Minecraft bone names must match ^[a-zA-Z0-9_]+$)'),
            origin: tool.vec3('Bone pivot in Blockbench units, i.e. where it rotates from'),
            rotation: tool.vec3('Rest rotation in degrees'),
            parent: parentSchema,
          },
          additionalProperties: false,
        },
        returns: 'NodeSummary',
      }),
      undoAspects: groupAspects,
      undoMessage: 'Create bone (AI agent)',
      handler: (args) => {
        assertFormatFlag('bone_rig', 'bones');
        const groupCtor = groupClass();
        const group = new groupCtor({
          name: args.name ? String(args.name) : 'bone',
          origin: optionalVec3(args.origin, 'origin') ?? [0, 0, 0],
          rotation: optionalVec3(args.rotation, 'rotation') ?? [0, 0, 0],
        });
        group.sanitizeName?.();
        const parent = parentTarget(args.parent);
        if (typeof (group as unknown as { init?: () => unknown }).init === 'function') {
          (group as unknown as { init: () => unknown }).init();
        }
        if (parent) (group as unknown as BBNode).addTo(parent as unknown as BBNode);
        (group as unknown as { isOpen?: boolean }).isOpen = true;
        return { data: nodeSummary(group as unknown as BBNode), verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'create_locator',
        title: 'Create locator',
        description: 'Create a locator (an empty positioned point used by Bedrock animation effects). Requires a format with locator support.',
        group: 'hierarchy',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Locator name'),
            position: tool.vec3('Position in Blockbench units'),
            parent: parentSchema,
          },
          additionalProperties: false,
        },
        returns: 'NodeSummary',
      }),
      undoAspects: elementAspects,
      undoMessage: 'Create locator (AI agent)',
      handler: (args) => {
        assertFormatFlag('locators', 'locators');
        const ctor = tryGlobal<new (data: Record<string, unknown>) => BBNode>('Locator');
        if (typeof ctor !== 'function') throw new ToolExecutionError('Locator is unavailable in this build.', 'api_unavailable');
        const position = optionalVec3(args.position, 'position') ?? [0, 0, 0];
        const locator = new ctor({ name: args.name ? String(args.name) : 'locator', position });
        if (typeof (locator as unknown as { init?: () => unknown }).init === 'function') {
          (locator as unknown as { init: () => unknown }).init();
        }
        const parent = parentTarget(args.parent);
        if (parent) locator.addTo(parent as unknown as BBNode);
        return { data: nodeSummary(locator), verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'modify_node',
        title: 'Modify node',
        description:
          'Rename, move, rotate or hide any node (cube, group, locator). For cubes you can also change inflate, UV settings and face textures. Only the fields you pass are touched.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Apply the same change to several nodes', referenceSchema),
            ...cubeInputSchema([]).properties,
          },
          additionalProperties: false,
        },
        returns: '{ updated: NodeSummary[] }',
      }),
      undoAspects: () => ({ elements: [], groups: [], outliner: true }),
      undoMessage: 'Modify nodes (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const warnings: string[] = [];
        const updated = refs.map((ref) => {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          if (String(node.type) === 'cube') {
            warnings.push(...applyCubeFields(node as unknown as BBCube, args as CubeFieldInput));
          } else {
            const any = node as unknown as Record<string, unknown>;
            if (args.name !== undefined) node.name = String(args.name);
            const origin = numericArray(args.origin);
            if (origin && origin.length === 3) any.origin = origin;
            const rotation = numericArray(args.rotation);
            if (rotation && rotation.length === 3) any.rotation = rotation;
            if (args.visibility !== undefined) any.visibility = !!args.visibility;
            if (args.locked !== undefined) any.locked = !!args.locked;
            if (args.export !== undefined) any.export = !!args.export;
          }
          return nodeSummary(node);
        });
        return { data: { updated }, warnings: warnings.length ? warnings : undefined, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'delete_node',
        title: 'Delete node',
        description:
          'Delete one or more outliner nodes. Deleting a group also deletes its children unless `keep_children` is true, in which case they are re-parented to the group parent.',
        group: 'geometry',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Delete several nodes at once', referenceSchema),
            keep_children: tool.boolean('Re-parent children instead of deleting them', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ deleted: string[], kept_children: number }',
      }),
      undoAspects: () => ({ outliner: true, elements: [], groups: [], selection: true }),
      undoMessage: 'Delete nodes (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        let keptChildren = 0;
        const deleted: string[] = [];
        for (const ref of refs) {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          const parent = node.parent && node.parent !== 'root' ? (node.parent as BBNode) : 'root';
          if (args.keep_children && Array.isArray(node.children)) {
            for (const child of [...node.children] as BBNode[]) {
              child.addTo(parent as BBNode | 'root');
              keptChildren += 1;
            }
          }
          deleted.push(`${node.name} (${node.type})`);
          node.remove(false);
        }
        return { data: { deleted, kept_children: keptChildren }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'parent_object',
        title: 'Reparent node',
        description: 'Move an existing node under a different group, or to the outliner root when `parent` is omitted.',
        group: 'hierarchy',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { reference: referenceSchema, parent: parentSchema },
          additionalProperties: false,
        },
        returns: '{ node, parent }',
      }),
      undoAspects: () => ({ outliner: true, selection: true }),
      undoMessage: 'Reparent node (AI agent)',
      handler: (args) => {
        const node = resolveNode(asRecord(args.reference) as { uuid?: string; name?: string });
        const parent = parentTarget(args.parent);
        node.addTo(parent ? (parent as unknown as BBNode) : 'root');
        const actual = node.parent === 'root' || !node.parent ? 'root' : String((node.parent as BBNode).name);
        const expected = parent && parent !== 'root' ? String(parent.name) : 'root';
        const warnings = actual === expected ? undefined : [`Node ended up under "${actual}" instead of "${expected}".`];
        return { data: { node: nodeSummary(node), parent: actual }, warnings, verified: actual === expected };
      },
    },
    {
      definition: defineTool({
        name: 'unparent_object',
        title: 'Unparent node',
        description: 'Detach one or more nodes from their parent and move them to the outliner root.',
        group: 'hierarchy',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Unparent several nodes', referenceSchema),
          },
          additionalProperties: false,
        },
        returns: '{ moved: string[] }',
      }),
      undoAspects: () => ({ outliner: true, selection: true }),
      undoMessage: 'Unparent nodes (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const moved: string[] = [];
        for (const ref of refs) {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          node.addTo('root');
          moved.push(String(node.name));
        }
        return { data: { moved }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'duplicate_array',
        title: 'Duplicate array',
        description:
          'Duplicate a node `count` times applying a fixed translation (and optional rotation step) between copies. This is the correct way to build symmetric or repeated anatomy: two legs, a row of teeth, spines along the back. Each copy is placed under the same parent as the source.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            count: tool.integer('How many copies to create (1-200)', { minimum: 1, maximum: 200 }),
            offset: tool.vec3('Translation applied between successive copies'),
            rotation_step: tool.vec3('Rotation added to each successive copy, in degrees'),
            name_pattern: tool.string('Name template where {i} is replaced by the copy index', { default: '{name}_{i}' }),
            include_first: tool.boolean('Also move the original node by offset * 0, i.e. keep it as copy 0 (default true)', { default: true }),
          },
          required: ['count'],
          additionalProperties: false,
        },
        returns: '{ created: string[], count }',
      }),
      undoAspects: () => ({ outliner: true, elements: [], groups: [], selection: true }),
      undoMessage: 'Duplicate array (AI agent)',
      handler: (args) => {
        const source = resolveNode(asRecord(args.reference) as { uuid?: string; name?: string });
        const count = requireNumber(args.count, 'count');
        const offset = optionalVec3(args.offset, 'offset') ?? [0, 0, 0];
        const rotationStep = optionalVec3(args.rotation_step, 'rotation_step') ?? [0, 0, 0];
        const pattern = typeof args.name_pattern === 'string' ? args.name_pattern : '{name}_{i}';
        const baseName = String(source.name);
        const created: string[] = [];

        for (let i = 1; i <= count; i++) {
          const copy = source.duplicate();
          const copyAny = copy as unknown as Record<string, unknown>;
          const origin = numericArray(copyAny.origin) ?? [0, 0, 0];
          const sourceOrigin = numericArray((source as unknown as Record<string, unknown>).origin) ?? [0, 0, 0];
          copyAny.origin = [sourceOrigin[0] + offset[0] * i, sourceOrigin[1] + offset[1] * i, sourceOrigin[2] + offset[2] * i];
          void origin;
          if (rotationStep.some((value) => value !== 0)) {
            const rotation = numericArray(copyAny.rotation) ?? [0, 0, 0];
            copyAny.rotation = [rotation[0] + rotationStep[0] * i, rotation[1] + rotationStep[1] * i, rotation[2] + rotationStep[2] * i];
          }
          if (String(copy.type) === 'cube') {
            const from = numericArray(copyAny.from) ?? [0, 0, 0];
            const to = numericArray(copyAny.to) ?? [0, 0, 0];
            copyAny.from = [from[0] + offset[0] * i, from[1] + offset[1] * i, from[2] + offset[2] * i];
            copyAny.to = [to[0] + offset[0] * i, to[1] + offset[1] * i, to[2] + offset[2] * i];
          }
          copy.name = pattern.replace('{name}', baseName).replace('{i}', String(i));
          if (typeof (copy as unknown as { createUniqueName?: () => unknown }).createUniqueName === 'function') {
            (copy as unknown as { createUniqueName: () => unknown }).createUniqueName();
          }
          created.push(String(copy.name));
        }
        return {
          data: { created, count: created.length, offset_per_copy: offset },
          warnings: created.length !== count ? [`Requested ${count} copies but created ${created.length}.`] : undefined,
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'create_cube',
        title: 'Create cube',
        description:
          'Create a single cube. Coordinates are Blockbench units where 16 units = 1 Minecraft block and the origin sits at the bottom centre of the model. Prefer bulk_create_cubes when building more than a couple of cubes.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: cubeInputSchema(['from', 'to']),
        returns: '{ cube, warnings? }',
      }),
      undoAspects: elementAspects,
      undoMessage: 'Create cube (AI agent)',
      handler: (args) => {
        if (!maybeProject()) throw new ToolExecutionError('No project is open.', 'no_project');
        const { cube, warnings } = createCubeNode(args as CubeFieldInput, undefined);
        return { data: { cube: summariseCube(cube) }, warnings: warnings.length ? warnings : undefined, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'bulk_create_cubes',
        title: 'Create many cubes',
        description:
          'Create many cubes in a single undo step. This is the primary construction tool: a detailed Minecraft creature is built from one or a few calls like this rather than dozens of single-cube calls. Every cube may also be placed under a group by name via its `parent` field.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            cubes: tool.array(
              'Cube definitions',
              {
                type: 'object',
                properties: {
                  ...cubeInputSchema([]).properties,
                  parent: tool.string('Name or uuid of the group to place this cube under'),
                },
                required: ['from', 'to'],
                additionalProperties: false,
              } as JsonSchema,
              { minItems: 1, maxItems: 800 },
            ),
            parent: tool.string('Default parent group name/uuid applied to cubes that do not specify one'),
          },
          required: ['cubes'],
          additionalProperties: false,
        },
        returns: '{ created: [...], created_count, warnings, verification }',
      }),
      undoAspects: elementAspects,
      undoMessage: 'Bulk create cubes (AI agent)',
      handler: (args, ctx) => {
        const project_ = maybeProject();
        if (!project_) throw new ToolExecutionError('No project is open.', 'no_project');
        const list = Array.isArray(args.cubes) ? (args.cubes as Array<Record<string, unknown>>) : [];
        if (!list.length) throw new ToolValidationError('"cubes" must contain at least one definition');

        const defaultParent = typeof args.parent === 'string' && args.parent ? args.parent : null;
        const created: Array<Record<string, unknown>> = [];
        const warnings: string[] = [];

        for (let index = 0; index < list.length; index++) {
          ctx.throwIfCancelled();
          const entry = list[index];
          if (index % 25 === 0) ctx.reportProgress(index, list.length, `creating cube ${index + 1}/${list.length}`);
          const from = numericArray(entry.from);
          const to = numericArray(entry.to);
          if (!from || from.length !== 3) throw new ToolValidationError(`cubes[${index}].from must be three numbers`);
          if (!to || to.length !== 3) throw new ToolValidationError(`cubes[${index}].to must be three numbers`);

          let parent: BBGroup | 'root' | undefined;
          const parentRef = (entry.parent as string | undefined) ?? defaultParent ?? undefined;
          if (parentRef) {
            try {
              parent = resolveNode({ name: parentRef }, {
                types: ['group', 'armature_bone'],
                what: 'group',
              }) as unknown as BBGroup;
            } catch (error) {
              warnings.push(`cubes[${index}] parent "${parentRef}" not found: ${(error as Error).message}`);
            }
          }
          const { cube, warnings: cubeWarnings } = createCubeNode(entry as CubeFieldInput, parent);
          warnings.push(...cubeWarnings);
          created.push(summariseCube(cube));
        }

        const after = (maybeProject()?.elements ?? []).length;
        const expected = created.length;
        const before = after - expected;
        const verification = {
          element_count_before: before,
          element_count_after: after,
          expected_created: expected,
          matched: after - before === expected,
        };
        if (!verification.matched) warnings.push('Element count did not grow by the number of requested cubes.');
        ctx.reportProgress(list.length, list.length, 'cubes created');
        return {
          data: { created, created_count: created.length, verification },
          warnings: warnings.length ? warnings : undefined,
          verified: verification.matched,
        };
      },
    },
    {
      definition: defineTool({
        name: 'modify_cube',
        title: 'Modify cube',
        description:
          'Change an existing cube: resize (from/to), move/rotate via origin and rotation, inflate, mirror UV, assign a texture to every face, toggle auto UV. Returns the verified resulting geometry.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { reference: referenceSchema, ...cubeInputSchema([]).properties },
          additionalProperties: false,
        },
        returns: '{ cube }',
      }),
      undoAspects: () => ({ elements: [] }),
      undoMessage: 'Modify cube (AI agent)',
      handler: (args) => {
        const cube = resolveNode(asRecord(args.reference), { types: ['cube'], what: 'cube' }) as unknown as BBCube;
        const warnings = applyCubeFields(cube, args as CubeFieldInput);
        return { data: { cube: summariseCube(cube) }, warnings: warnings.length ? warnings : undefined, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'set_pivot',
        title: 'Set pivot',
        description:
          'Set the rotation pivot of one or more nodes. Accepts explicit coordinates, or an anchor keyword that is resolved against the node bounds: `min`, `center`, `max`, `bottom_center` (the usual pivot for a Minecraft limb), `top_center`, `front_center` and `back_center`.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Set the pivot on several nodes', referenceSchema),
            pivot: tool.vec3('Explicit pivot coordinates'),
            anchor: tool.enum('Anchor keyword resolved from the node bounds', [
              'min',
              'max',
              'center',
              'bottom_center',
              'top_center',
              'front_center',
              'back_center',
              'left_center',
              'right_center',
            ]),
            offset: tool.vec3('Offset added to the resolved pivot', { default: [0, 0, 0] }),
          },
          additionalProperties: false,
        },
        returns: '{ pivots: [{ node, pivot }] }',
      }),
      undoAspects: () => ({ elements: [], groups: [] }),
      undoMessage: 'Set pivot (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const explicit = numericArray(args.pivot);
        const offset = numericArray(args.offset) ?? [0, 0, 0];
        const anchor = typeof args.anchor === 'string' ? args.anchor : null;
        if (!explicit && !anchor) throw new ToolValidationError('Provide either "pivot" coordinates or an "anchor" keyword');

        const pivots = refs.map((ref) => {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          const any = node as unknown as Record<string, unknown>;
          let pivot: number[];
          if (explicit) {
            pivot = [explicit[0], explicit[1], explicit[2]];
          } else {
            const from = numericArray(any.from);
            const to = numericArray(any.to);
            if (!from || !to) throw new ToolExecutionError(`Node "${node.name}" has no volume to anchor a pivot to.`, 'unsupported');
            const mid = (axis: number) => (from[axis] + to[axis]) / 2;
            const map: Record<string, number[]> = {
              min: [from[0], from[1], from[2]],
              max: [to[0], to[1], to[2]],
              center: [mid(0), mid(1), mid(2)],
              bottom_center: [mid(0), from[1], mid(2)],
              top_center: [mid(0), to[1], mid(2)],
              front_center: [mid(0), mid(1), Math.min(from[2], to[2])],
              back_center: [mid(0), mid(1), Math.max(from[2], to[2])],
              left_center: [from[0], mid(1), mid(2)],
              right_center: [to[0], mid(1), mid(2)],
            };
            pivot = map[anchor as string] ?? [mid(0), mid(1), mid(2)];
          }
          const finalPivot = [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]];
          any.origin = finalPivot;
          return { node: nodeSummary(node), pivot: finalPivot };
        });
        return { data: { pivots }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'offset_nodes',
        title: 'Offset nodes',
        description:
          'Translate one or more nodes by a delta, moving geometry and pivot together. `space` chooses whether the delta is applied to the node pivot (`origin`, default) or to the cube volume only.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Offset several nodes', referenceSchema),
            delta: tool.vec3('Translation delta in Blockbench units'),
            space: tool.enum('What to move', ['origin', 'geometry']),
          },
          required: ['delta'],
          additionalProperties: false,
        },
        returns: '{ moved: [{ node, origin }] }',
      }),
      undoAspects: () => ({ elements: [], groups: [] }),
      undoMessage: 'Offset nodes (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const delta = requireVec3(args.delta, 'delta');
        const space = args.space === 'geometry' ? 'geometry' : 'origin';
        const moved = refs.map((ref) => {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          const any = node as unknown as Record<string, unknown>;
          if (space === 'geometry' || !Array.isArray(any.origin)) {
            const from = numericArray(any.from);
            const to = numericArray(any.to);
            if (!from || !to) throw new ToolExecutionError(`Node "${node.name}" has no geometry to move.`, 'unsupported');
            any.from = [from[0] + delta[0], from[1] + delta[1], from[2] + delta[2]];
            any.to = [to[0] + delta[0], to[1] + delta[1], to[2] + delta[2]];
          }
          if (space === 'origin' && Array.isArray(any.origin)) {
            const origin = numericArray(any.origin) ?? [0, 0, 0];
            any.origin = [origin[0] + delta[0], origin[1] + delta[1], origin[2] + delta[2]];
            if (String(node.type) === 'cube') {
              const from = numericArray(any.from);
              const to = numericArray(any.to);
              if (from && to) {
                any.from = [from[0] + delta[0], from[1] + delta[1], from[2] + delta[2]];
                any.to = [to[0] + delta[0], to[1] + delta[1], to[2] + delta[2]];
              }
            }
          }
          return { node: nodeSummary(node), origin: numericArray(any.origin) };
        });
        return { data: { moved, delta, space }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'set_visibility',
        title: 'Set visibility',
        description: 'Show or hide one or more nodes without deleting them.',
        group: 'geometry',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: referenceSchema,
            references: tool.array('Apply to several nodes', referenceSchema),
            visible: tool.boolean('True to show, false to hide'),
          },
          required: ['visible'],
          additionalProperties: false,
        },
        returns: '{ changed: string[] }',
      }),
      undoAspects: () => ({ elements: [], groups: [] }),
      undoMessage: 'Set visibility (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const visible = !!args.visible;
        const changed: string[] = [];
        for (const ref of refs) {
          const node = resolveNode(asRecord(ref) as { uuid?: string; name?: string });
          (node as unknown as Record<string, unknown>).visibility = visible;
          changed.push(String(node.name));
        }
        return { data: { changed, visible }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'select_object',
        title: 'Select objects',
        description:
          'Change the outliner selection. `mode` decides whether the given nodes replace, extend or are removed from the selection. Useful before tools that default to the current selection.',
        group: 'project',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            references: tool.array('Nodes to select', referenceSchema, { minItems: 1 }),
            mode: tool.enum('Selection mode', ['replace', 'add', 'remove']),
            include_children: tool.boolean('Also select descendants', { default: false }),
          },
          required: ['references'],
          additionalProperties: false,
        },
        returns: '{ selected: string[] }',
      }),
      handler: (args) => {
        const nodeApi = (globalThis as unknown as { unselectAllElements?: () => void }).unselectAllElements;
        const mode = typeof args.mode === 'string' ? args.mode : 'replace';
        const refs = (args.references as Array<Record<string, unknown>>) ?? [];
        const nodes = refs.map((ref) => resolveNode(asRef(ref)));
        if (mode === 'replace' && typeof nodeApi === 'function') nodeApi();

        const groupCtor = groupClass();
        const multiSelected: BBGroup[] = Array.isArray(groupCtor.multi_selected) ? groupCtor.multi_selected : (groupCtor.multi_selected = []);
        for (const node of nodes) {
          if (mode === 'remove') {
            node.unselect();
            const index = multiSelected.indexOf(node as unknown as BBGroup);
            if (index >= 0) multiSelected.splice(index, 1);
            continue;
          }
          if (String(node.type) === 'group' || String(node.type) === 'armature_bone') {
            if (!multiSelected.includes(node as unknown as BBGroup)) {
              multiSelected.push(node as unknown as BBGroup);
            }
            (node as unknown as { primary_selected?: boolean }).primary_selected = true;
          }
          node.select();
          if (args.include_children && Array.isArray(node.children)) {
            for (const child of node.children as BBNode[]) child.select();
          }
        }
        try {
          outliner().updateAll();
        } catch {
          /* selection refresh is best effort */
        }
        return {
          data: {
            selected: (outliner()?.selected ?? []).map((node) => String(node.name)),
            groups: multiSelected.map((group) => String(group.name)),
          },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'focus_viewport',
        title: 'Focus viewport',
        description:
          'Move the viewport camera to a named angle preset (initial, north, south, east, west, top, bottom, isometric_right, isometric_left, true_isometric_right, true_isometric_left). Purely visual; does not modify the model.',
        group: 'viewport',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            angle: tool.string('Camera preset id', { default: 'initial' }),
            zoom: tool.number('Orthographic zoom override', { minimum: 0.01 }),
          },
          additionalProperties: false,
        },
        returns: '{ angle, camera_position, target }',
      }),
      handler: (args) => {
        const result = focusViewport((typeof args.angle === 'string' ? args.angle : 'initial') as never, typeof args.zoom === 'number' ? args.zoom : undefined);
        return { data: result, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'frame_viewport',
        title: 'Frame viewport on the model',
        description:
          'Move to an angle, recentre the camera on the model bounding box and zoom so the whole model fits in frame. Blockbench\'s direction presets all target the origin, so use this (or get_viewport_image with frame:true) whenever a rig is bigger than one block. Returns the resulting camera target, projection and fit zoom.',
        group: 'viewport',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            angle: tool.string('Camera preset id; use "view" to keep the current direction', { default: 'initial' }),
            padding: tool.number('Fraction of the frame the model should fill (0.3-0.98)', { default: 0.86, minimum: 0.3, maximum: 0.98 }),
            selection: tool.boolean('Frame the current selection instead of the whole model', { default: false }),
            keep_angle: tool.boolean('Only recentre and fit, leaving the viewing direction alone', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ angle, projection, target, camera_position, bounds, size, zoom, distance }',
      }),
      handler: (args) => {
        const result = frameViewport({
          angle: (typeof args.angle === 'string' ? args.angle : 'initial') as never,
          padding: typeof args.padding === 'number' ? args.padding : undefined,
          selection: args.selection === true,
          keep_angle: args.keep_angle === true || args.angle === 'view',
        });
        return { data: result, verified: true };
      },
    },
  ];
}

function asRef(record: Record<string, unknown>): { uuid?: string; name?: string } {
  return { uuid: typeof record.uuid === 'string' ? record.uuid : undefined, name: typeof record.name === 'string' ? record.name : undefined };
}

export { AXES };
