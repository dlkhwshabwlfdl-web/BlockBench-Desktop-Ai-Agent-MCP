/**
 * Texture, UV and pixel tools.
 *
 * Verified against the installed build before use:
 *   js/texturing/textures.js:
 *     - `new Texture(data)` builds `texture.canvas` / `texture.ctx` and, once the
 *       image loads, resizes the canvas to the image and draws it in, so
 *       `texture.ctx` is a real, writable, full resolution bitmap.
 *     - `texture.fromDataURL(url)` accepts an embedded PNG.
 *     - `texture.updateSource(dataUrl)` pushes painted pixels back into the source,
 *       the texture image and the material.
 *     - `texture.add(false)` registers it with the project (and emits add_texture).
 *     - `texture.getDataURL()` returns the current pixels as a PNG data URL.
 *   js/outliner/types/cube.js: `cube.mapAutoUV()`, `cube.autouv`, `cube.box_uv` and
 *     the per-face `uuids` in `cube.faces[face].texture`.
 */

import {
  canvasApi,
  format,
  maybeProject,
  textureClass,
  tryGlobal,
  type BBCube,
  type BBTexture,
} from '../env.js';
import { tool, type JsonSchema } from '../../shared/protocol.js';
import { captureTextures } from '../state.js';
import { FACE_NAMES } from '../../shared/protocol.js';
import {
  ToolExecutionError,
  ToolValidationError,
  asRecord,
  defineTool,
  numericArray,
  resolveNode,
  resolveTexture,
  type RegisteredTool,
} from './registry.js';

const faceSchema: JsonSchema = {
  type: 'array',
  description: 'Faces to affect; omit for all six faces',
  items: { type: 'string', enum: [...FACE_NAMES] },
  minItems: 1,
};

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(input: unknown, fallback = { r: 255, g: 255, b: 255, a: 255 }): RGB {
  if (typeof input !== 'string') return fallback;
  const value = input.trim().replace(/^#/, '');
  const hex = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (hex.length !== 6 && hex.length !== 8) {
    throw new ToolValidationError(`Colour "${input}" must be a hex string like #RRGGBB or #RRGGBBAA`);
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  if ([r, g, b, a].some((channel) => Number.isNaN(channel))) {
    throw new ToolValidationError(`Colour "${input}" is not valid hex`);
  }
  return { r, g, b, a };
}

function cssColor(color: RGB): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${(color.a / 255).toFixed(3)})`;
}

function ensureCanvas(texture: BBTexture): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = texture.canvas as HTMLCanvasElement | undefined;
  const ctx = texture.ctx as CanvasRenderingContext2D | undefined;
  if (!canvas || !ctx) {
    throw new ToolExecutionError('This texture has no writable canvas in this Blockbench build.', 'api_unavailable');
  }
  const width = Number(texture.width) || 0;
  const height = Number(texture.height) || 0;
  if (!width || !height) {
    throw new ToolExecutionError(
      'The texture image has not finished loading yet, so its size is unknown. Retry in a moment.',
      'not_ready',
      true,
    );
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { canvas, ctx };
}

/** Waits for a texture image to decode so pixel work is deterministic. */
async function waitForLoad(texture: BBTexture, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (Number(texture.width) > 0 && Number(texture.height) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new ToolExecutionError(`Texture "${texture.name}" did not finish loading within ${timeoutMs}ms.`, 'timeout', true);
}

function flushTexture(texture: BBTexture): void {
  const canvas = texture.canvas as HTMLCanvasElement | undefined;
  if (!canvas || typeof texture.updateSource !== 'function') {
    throw new ToolExecutionError('Texture.updateSource is unavailable; cannot persist painted pixels.', 'api_unavailable');
  }
  texture.updateSource(canvas.toDataURL('image/png'));
  texture.saved = false;
}

interface PaintOp {
  type: string;
  [key: string]: unknown;
}

function applyPaintOp(ctx: CanvasRenderingContext2D, op: PaintOp, width: number, height: number): number {
  const num = (key: string, fallback = 0): number => {
    const value = op[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const color = () => parseColor(op.color);
  switch (op.type) {
    case 'fill': {
      const c = color();
      ctx.fillStyle = cssColor(c);
      ctx.fillRect(0, 0, width, height);
      return 1;
    }
    case 'clear': {
      ctx.clearRect(0, 0, width, height);
      return 1;
    }
    case 'clear_rect': {
      ctx.clearRect(num('x'), num('y'), num('width', 1), num('height', 1));
      return 1;
    }
    case 'rect': {
      ctx.fillStyle = cssColor(color());
      ctx.fillRect(num('x'), num('y'), num('width', 1), num('height', 1));
      return 1;
    }
    case 'outline': {
      ctx.strokeStyle = cssColor(color());
      ctx.lineWidth = num('line_width', 1);
      ctx.strokeRect(num('x') + 0.5, num('y') + 0.5, Math.max(0, num('width', 1) - 1), Math.max(0, num('height', 1) - 1));
      return 1;
    }
    case 'pixel': {
      const points = Array.isArray(op.pixels) ? (op.pixels as Array<[number, number]>) : null;
      if (points) {
        ctx.fillStyle = cssColor(color());
        for (const [px, py] of points) ctx.fillRect(px, py, 1, 1);
        return points.length;
      }
      ctx.fillStyle = cssColor(color());
      ctx.fillRect(num('x'), num('y'), 1, 1);
      return 1;
    }
    case 'line': {
      ctx.strokeStyle = cssColor(color());
      ctx.lineWidth = num('line_width', 1);
      ctx.beginPath();
      ctx.moveTo(num('x1') + 0.5, num('y1') + 0.5);
      ctx.lineTo(num('x2') + 0.5, num('y2') + 0.5);
      ctx.stroke();
      return 1;
    }
    case 'gradient_v': {
      const top = parseColor(op.color_top);
      const bottom = parseColor(op.color_bottom);
      const x = num('x');
      const y = num('y');
      const w = num('width', width);
      const h = num('height', height);
      const gradient = ctx.createLinearGradient(0, y, 0, y + h);
      gradient.addColorStop(0, cssColor(top));
      gradient.addColorStop(1, cssColor(bottom));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
      return h;
    }
    case 'shade_rect': {
      // Darken/lighten an existing region: the bread and butter of Minecraft shading.
      const amount = num('amount', -20);
      const x = num('x');
      const y = num('y');
      const w = num('width', 1);
      const h = num('height', 1);
      const image = ctx.getImageData(x, y, w, h);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = Math.max(0, Math.min(255, data[i] + amount));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + amount));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + amount));
      }
      ctx.putImageData(image, x, y);
      return 1;
    }
    case 'copy_region': {
      const sx = num('sx');
      const sy = num('sy');
      const w = num('width', 1);
      const h = num('height', 1);
      const dx = num('dx');
      const dy = num('dy');
      const snapshot = ctx.getImageData(sx, sy, w, h);
      ctx.putImageData(snapshot, dx, dy);
      return 1;
    }
    case 'mirror_region': {
      const x = num('x');
      const y = num('y');
      const w = num('width', 1);
      const h = num('height', 1);
      const axis = op.axis === 'y' ? 'y' : 'x';
      const snapshot = ctx.getImageData(x, y, w, h);
      const out = ctx.createImageData(w, h);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const srcX = axis === 'x' ? w - 1 - px : px;
          const srcY = axis === 'y' ? h - 1 - py : py;
          const src = (srcY * w + srcX) * 4;
          const dst = (py * w + px) * 4;
          out.data[dst] = snapshot.data[src];
          out.data[dst + 1] = snapshot.data[src + 1];
          out.data[dst + 2] = snapshot.data[src + 2];
          out.data[dst + 3] = snapshot.data[src + 3];
        }
      }
      ctx.putImageData(out, x, y);
      return 1;
    }
    case 'noise': {
      const palette = Array.isArray(op.colors) ? (op.colors as string[]) : ['#ffffff'];
      const density = Math.max(0, Math.min(1, num('density', 0.1)));
      const x = num('x');
      const y = num('y');
      const w = num('width', width);
      const h = num('height', height);
      const parsed = palette.map((entry) => parseColor(entry));
      let painted = 0;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          if (Math.random() > density) continue;
          const c = parsed[Math.floor(Math.random() * parsed.length)];
          ctx.fillStyle = cssColor(c);
          ctx.fillRect(x + px, y + py, 1, 1);
          painted += 1;
        }
      }
      return painted;
    }
    default:
      throw new ToolValidationError(`Unknown paint operation "${op.type}"`);
  }
}

function cubeFacesOf(node: unknown, faces: string[] | undefined): Array<{ cube: BBCube; face: string }> {
  const target = resolveNode(node as never);
  const out: Array<{ cube: BBCube; face: string }> = [];
  const collect = (element: unknown) => {
    const cube = element as BBCube;
    if (String((cube as unknown as { type?: string }).type) === 'cube' && cube.faces) {
      const names = faces?.length ? faces : Object.keys(cube.faces);
      for (const name of names) {
        if (cube.faces[name]) out.push({ cube, face: name });
      }
    }
    const children = (element as unknown as { children?: unknown[] })?.children;
    if (Array.isArray(children)) for (const child of children) collect(child);
  };
  collect(target);
  return out;
}

export function textureTools(): RegisteredTool[] {
  return [
    {
      definition: defineTool({
        name: 'create_texture',
        title: 'Create texture',
        description:
          'Create a new texture in the project, either from a base64 PNG data URL or as a solid colour of the given size. Returns the texture uuid which other tools use to assign it to cube faces.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Texture name, e.g. "trex_body"'),
            width: tool.integer('Width in pixels (ignored when data_url is given)', { minimum: 1, maximum: 4096 }),
            height: tool.integer('Height in pixels (ignored when data_url is given)', { minimum: 1, maximum: 4096 }),
            data_url: tool.string('Base64 PNG data URL, e.g. "data:image/png;base64,..."'),
            fill_color: tool.string('Colour used to fill a blank texture, e.g. "#4a7a3a"'),
            particle: tool.boolean('Mark as a particle texture', { default: false }),
            select: tool.boolean('Select the new texture', { default: true }),
          },
          required: ['name'],
          additionalProperties: false,
        },
        returns: 'TextureSummary',
      }),
      undoAspects: () => ({ textures: [] }),
      undoMessage: 'Create texture (AI agent)',
      handler: async (args, ctx) => {
        const project_ = maybeProject();
        if (!project_) throw new ToolExecutionError('No project is open.', 'no_project');
        const ctor = textureClass();
        const texture = new ctor({ name: String(args.name), particle: !!args.particle, internal: true });

        if (typeof args.data_url === 'string' && args.data_url.startsWith('data:image/')) {
          texture.fromDataURL(args.data_url);
          if (typeof texture.add === 'function') texture.add(false);
          await waitForLoad(texture);
        } else {
          const width = typeof args.width === 'number' ? args.width : project_.resolution?.width ?? 16;
          const height = typeof args.height === 'number' ? args.height : project_.resolution?.height ?? 16;
          const canvas = texture.canvas as HTMLCanvasElement;
          const context = texture.ctx as CanvasRenderingContext2D;
          canvas.width = width;
          canvas.height = height;
          context.clearRect(0, 0, width, height);
          if (typeof args.fill_color === 'string') {
            context.fillStyle = cssColor(parseColor(args.fill_color));
            context.fillRect(0, 0, width, height);
          }
          texture.width = width;
          texture.height = height;
          flushTexture(texture);
          if (typeof texture.add === 'function') texture.add(false);
        }
        if (args.select !== false && typeof texture.select === 'function') texture.select();
        ctx.log('info', `created texture "${texture.name}" (${texture.width}x${texture.height})`);
        return { data: textureSummaryOf(texture), verified: Number(texture.width) > 0 };
      },
    },
    {
      definition: defineTool({
        name: 'import_texture',
        title: 'Import texture',
        description:
          'Add a texture to the project from a base64 PNG data URL (typically generated by the bridge and stored in the project). Optionally assigns it to every face of the given cubes right away.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            name: tool.string('Texture name'),
            data_url: tool.string('Base64 PNG data URL'),
            assign_to: tool.array('Nodes whose cube faces should receive this texture', {
              type: 'object',
              properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
            }),
            faces: faceSchema,
          },
          required: ['name', 'data_url'],
          additionalProperties: false,
        },
        returns: '{ texture, assigned_faces }',
      }),
      undoAspects: () => ({ textures: [] }),
      undoMessage: 'Import texture (AI agent)',
      handler: async (args) => {
        if (typeof args.data_url !== 'string' || !args.data_url.startsWith('data:image/')) {
          throw new ToolValidationError('"data_url" must be a base64 data URL such as data:image/png;base64,...');
        }
        const ctor = textureClass();
        const texture = new ctor({ name: String(args.name), internal: true });
        texture.fromDataURL(args.data_url);
        if (typeof texture.add === 'function') texture.add(false);
        await waitForLoad(texture);

        let assigned = 0;
        const refs = Array.isArray(args.assign_to) ? (args.assign_to as Array<Record<string, unknown>>) : [];
        for (const ref of refs) {
          for (const { cube, face } of cubeFacesOf(ref, args.faces as string[] | undefined)) {
            cube.faces[face].texture = String(texture.uuid);
            assigned += 1;
          }
        }
        if (assigned) {
          try {
            canvasApi().updateAllFaces();
          } catch {
            /* best effort */
          }
        }
        return { data: { texture: textureSummaryOf(texture), assigned_faces: assigned }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'paint_texture',
        title: 'Paint texture',
        description:
          'Draw pixels onto a texture. Operations are applied in order and may include fill, rect, outline, pixel (or a list of pixels), line, gradient_v, shade_rect (darken/lighten an existing region: Minecraft shading), copy_region, mirror_region and noise. Coordinates are pixels with (0,0) at the top left. Use this to author real textures rather than flat fills.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            texture: tool.string('Texture name or uuid (defaults to the selected texture)'),
            operations: tool.array(
              'Paint operations applied in order',
              {
                type: 'object',
                properties: {
                  type: tool.enum('Operation', [
                    'fill',
                    'clear',
                    'clear_rect',
                    'rect',
                    'outline',
                    'pixel',
                    'line',
                    'gradient_v',
                    'shade_rect',
                    'copy_region',
                    'mirror_region',
                    'noise',
                  ]),
                  x: tool.number('X'), y: tool.number('Y'),
                  width: tool.number('Width'), height: tool.number('Height'),
                  x1: tool.number('Line start X'), y1: tool.number('Line start Y'),
                  x2: tool.number('Line end X'), y2: tool.number('Line end Y'),
                  sx: tool.number('Source X for copy_region'), sy: tool.number('Source Y for copy_region'),
                  dx: tool.number('Destination X for copy_region'), dy: tool.number('Destination Y for copy_region'),
                  color: tool.string('Hex colour #RRGGBB or #RRGGBBAA'),
                  color_top: tool.string('Top colour for gradient_v'),
                  color_bottom: tool.string('Bottom colour for gradient_v'),
                  colors: tool.array('Palette for noise', tool.string('Hex colour')),
                  density: tool.number('Noise density 0-1', { minimum: 0, maximum: 1 }),
                  amount: tool.number('Brightness delta for shade_rect, e.g. -20'),
                  axis: tool.enum('Mirror axis', ['x', 'y']),
                  line_width: tool.number('Line width'),
                  pixels: tool.array('Explicit pixel list for the pixel operation', tool.array('Pixel as [x, y]', tool.number('Coordinate'), { minItems: 2, maxItems: 2 })),
                },
                required: ['type'],
                additionalProperties: false,
              },
              { minItems: 1, maxItems: 500 },
            ),
          },
          required: ['operations'],
          additionalProperties: false,
        },
        returns: '{ texture, operations_applied, texture_size }',
      }),
      undoAspects: () => ({ textures: [] }),
      undoMessage: 'Paint texture (AI agent)',
      handler: async (args, ctx) => {
        const texture = resolveTexture(args.texture as string | undefined);
        await waitForLoad(texture);
        const { ctx: context } = ensureCanvas(texture);
        const width = Number(texture.width);
        const height = Number(texture.height);
        const ops = args.operations as PaintOp[];
        let applied = 0;
        for (let index = 0; index < ops.length; index++) {
          ctx.throwIfCancelled();
          applyPaintOp(context, ops[index], width, height);
          applied += 1;
          if (index % 20 === 0) ctx.reportProgress(index, ops.length, `paint op ${index + 1}`);
        }
        flushTexture(texture);
        try {
          canvasApi().updateAllFaces();
        } catch {
          /* best effort */
        }
        return { data: { texture: textureSummaryOf(texture), operations_applied: applied, texture_size: [width, height] }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'assign_texture',
        title: 'Assign texture',
        description:
          'Assign a texture to cube faces. Works on a single cube, several cubes, or a whole group (cubes are collected recursively). Omit `faces` to assign all six faces.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            texture: tool.string('Texture name or uuid'),
            reference: {
              type: 'object',
              properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
            },
            references: tool.array('Several nodes (groups are expanded to their cubes)', {
              type: 'object',
              properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
            }),
            faces: faceSchema,
          },
          required: ['texture'],
          additionalProperties: false,
        },
        returns: '{ assigned_faces, cubes }',
      }),
      undoAspects: () => ({ elements: [] }),
      undoMessage: 'Assign texture (AI agent)',
      handler: (args) => {
        const texture = resolveTexture(args.texture as string);
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        let assigned = 0;
        const cubes = new Set<string>();
        for (const ref of refs) {
          for (const { cube, face } of cubeFacesOf(asRecord(ref), args.faces as string[] | undefined)) {
            cube.faces[face].texture = String(texture.uuid);
            assigned += 1;
            cubes.add(String(cube.name));
          }
        }
        if (!assigned) throw new ToolExecutionError('No cube faces matched the given nodes.', 'not_found');
        try {
          canvasApi().updateAllFaces(texture);
        } catch {
          /* best effort */
        }
        return { data: { texture: texture.name, assigned_faces: assigned, cubes: [...cubes] }, verified: true };
      },
    },
    {
      definition: defineTool({
        name: 'set_uv',
        title: 'Set UV',
        description:
          'Set per-face UV rectangles on a cube. Each face needs a four number rectangle [u1, v1, u2, v2] in texture pixels. Also accepts cube level settings: uv_offset (box UV origin), rotation, autouv mode and box_uv. Set autouv to 0 when you want your explicit UVs to survive.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: {
              type: 'object',
              properties: { uuid: tool.string('Cube uuid'), name: tool.string('Cube name') },
            },
            faces: tool.object(
              'Per-face UV rectangles keyed by face name',
              Object.fromEntries(FACE_NAMES.map((face) => [face, tool.array(`${face} UV as [u1, v1, u2, v2]`, tool.number('Coordinate'), { minItems: 4, maxItems: 4 })])),
            ),
            uv_rotation: tool.object(
              'Optional per-face UV rotation in degrees',
              Object.fromEntries(FACE_NAMES.map((face) => [face, tool.number(`${face} rotation`)])),
            ),
            uv_offset: tool.vec2('Box UV offset on the texture'),
            autouv: tool.integer('Auto UV mode: 0 off, 1 auto, 2 relative', { minimum: 0, maximum: 2 }),
            box_uv: tool.boolean('Use box UV'),
          },
          required: ['reference'],
          additionalProperties: false,
        },
        returns: '{ cube, faces }',
      }),
      undoAspects: () => ({ elements: [] }),
      undoMessage: 'Set UV (AI agent)',
      handler: (args) => {
        const cube = resolveNode(asRecord(args.reference), { types: ['cube'], what: 'cube' }) as unknown as BBCube;
        if (args.autouv !== undefined) cube.autouv = Number(args.autouv);
        if (args.box_uv !== undefined) cube.box_uv = !!args.box_uv;
        const uvOffset = numericArray(args.uv_offset);
        if (uvOffset && uvOffset.length === 2) cube.uv_offset = uvOffset;

        const faces = asRecord(args.faces);
        const rotation = asRecord(args.uv_rotation);
        for (const [faceName, uvValue] of Object.entries(faces)) {
          const uv = numericArray(uvValue);
          if (!uv || uv.length !== 4) throw new ToolValidationError(`faces.${faceName} must be four numbers [u1, v1, u2, v2]`);
          const face = cube.faces[faceName];
          if (!face) throw new ToolValidationError(`"${faceName}" is not a valid face name (use ${FACE_NAMES.join(', ')})`);
          face.uv = uv;
        }
        for (const [faceName, value] of Object.entries(rotation)) {
          const face = cube.faces[faceName];
          if (face && typeof value === 'number') face.rotation = value;
        }
        try {
          canvasApi().updateAllUVs();
        } catch {
          /* best effort */
        }
        const result = Object.fromEntries(
          Object.entries(cube.faces ?? {}).map(([name, face]) => [name, { uv: numericArray(face.uv), rotation: face.rotation }]),
        );
        return {
          data: { cube: { uuid: cube.uuid, name: cube.name, autouv: cube.autouv, box_uv: cube.box_uv, uv_offset: numericArray(cube.uv_offset) }, faces: result },
          verified: true,
        };
      },
    },
    {
      definition: defineTool({
        name: 'auto_uv',
        title: 'Auto UV',
        description:
          'Recompute automatic UVs for one or more cubes with `Cube.mapAutoUV()`, which is exactly what the outliner auto-UV button calls. Use after resizing or repositioning cubes so their texture regions stay in sync.',
        group: 'texture',
        danger: 'mutating',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            reference: {
              type: 'object',
              properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
            },
            references: tool.array('Several nodes; groups are expanded recursively', {
              type: 'object',
              properties: { uuid: tool.string('Node uuid'), name: tool.string('Node name') },
            }),
          },
          additionalProperties: false,
        },
        returns: '{ updated: string[], skipped: string[] }',
      }),
      undoAspects: () => ({ elements: [] }),
      undoMessage: 'Auto UV (AI agent)',
      handler: (args) => {
        const refs = Array.isArray(args.references) && args.references.length ? args.references : [args.reference];
        const updated: string[] = [];
        const skipped: string[] = [];
        const seen = new Set<string>();
        for (const ref of refs) {
          for (const { cube } of cubeFacesOf(asRecord(ref), undefined)) {
            if (seen.has(String(cube.uuid))) continue;
            seen.add(String(cube.uuid));
            if (cube.box_uv) {
              skipped.push(String(cube.name));
              continue;
            }
            if (typeof cube.mapAutoUV === 'function') {
              cube.mapAutoUV();
              cube.autouv = cube.autouv || 1;
              updated.push(String(cube.name));
            } else {
              skipped.push(String(cube.name));
            }
          }
        }
        return {
          data: { updated, skipped },
          warnings: skipped.length ? [`${skipped.length} cubes use box UV or do not support auto UV.`] : undefined,
          verified: updated.length > 0,
        };
      },
    },
    {
      definition: defineTool({
        name: 'get_texture_image',
        title: 'Get texture image',
        description:
          'Return the actual pixels of a texture as a base64 PNG data URL so they can be looked at. Prefer this over get_texture_view when you want the texture itself rather than the editor around it.',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: { texture: tool.string('Texture name or uuid (defaults to the selected texture)') },
          additionalProperties: false,
        },
        returns: '{ texture, data_url, width, height }',
      }),
      handler: (args) => {
        const texture = resolveTexture(args.texture as string | undefined);
        if (typeof texture.getDataURL !== 'function') {
          throw new ToolExecutionError('Texture.getDataURL is unavailable in this build.', 'api_unavailable');
        }
        const dataUrl = texture.getDataURL() as string;
        return {
          data: {
            texture: textureSummaryOf(texture),
            data_url: dataUrl,
            width: Number(texture.width),
            height: Number(texture.height),
          },
          verified: typeof dataUrl === 'string' && dataUrl.startsWith('data:image/'),
        };
      },
    },
    {
      definition: defineTool({
        name: 'delete_texture',
        title: 'Delete texture',
        description: 'Remove a texture from the project. Cube faces that referenced it are cleared.',
        group: 'texture',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            texture: tool.string('Texture name or uuid'),
            confirm: tool.boolean('Must be true to confirm', { default: false }),
          },
          additionalProperties: false,
        },
        returns: '{ deleted, remaining_textures }',
      }),
      undoAspects: () => ({ textures: [] }),
      undoMessage: 'Delete texture (AI agent)',
      handler: (args) => {
        if (args.confirm !== true) throw new ToolValidationError('Refusing to delete a texture without confirm: true.');
        const texture = resolveTexture(args.texture as string);
        const uuid = String(texture.uuid);
        const removeFn = (texture as unknown as { remove?: (no_update?: boolean) => void }).remove;
        if (typeof removeFn !== 'function') throw new ToolExecutionError('Texture.remove is unavailable in this build.', 'api_unavailable');
        removeFn.call(texture, false);
        const remaining = captureTextures();
        return {
          data: { deleted: texture.name, remaining_textures: remaining.length },
          verified: !remaining.some((entry) => entry.uuid === uuid),
        };
      },
    },
  ];
}

function textureSummaryOf(texture: BBTexture): Record<string, unknown> {
  return {
    uuid: texture.uuid,
    name: texture.name,
    width: Number(texture.width) || null,
    height: Number(texture.height) || null,
    path: texture.path ?? null,
    internal: !!texture.internal,
    has_source: !!texture.source,
    render_mode: texture.render_mode ?? null,
    format_per_texture_uv_size: !!format().per_texture_uv_size,
    default_texture_exists: typeof (tryGlobal('Texture') as { getDefault?: () => unknown })?.getDefault === 'function',
  };
}
