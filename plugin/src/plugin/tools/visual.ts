/**
 * Visual tools (requirement #3).
 *
 * Thin wrappers that expose `src/plugin/vision.ts` to the agent. Every one of them
 * returns real PNG data produced by Blockbench's own screenshot code, and reports
 * exactly which camera angle produced it. When a capability is missing the tool
 * fails loudly rather than returning a placeholder image.
 */

import { tool } from '../../shared/protocol.js';
import {
  captureAngle,
  captureAngles,
  captureLiveViewport,
  captureTextureEditor,
  DEFAULT_SNAPSHOT_ANGLES,
  availableAnglePresets,
  frameViewport,
} from '../vision.js';
import { defineTool, type RegisteredTool } from './registry.js';

export function visualTools(): RegisteredTool[] {
  return [
    {
      definition: defineTool({
        name: 'get_viewport_image',
        title: 'Get viewport image',
        description:
          'Render the model to a PNG and return it as a data URL. `angle` selects the camera: "view" keeps the user\'s current angle, otherwise use a preset id (north/south/east/west/top/bottom/isometric_right/isometric_left/isometric/initial). The capture happens offscreen, so it does not move the user\'s viewport.',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            angle: tool.string('Camera preset id or "view"', { default: 'view' }),
            resolution: tool.integer('Square resolution in pixels (128-2048)', { default: 640, minimum: 128, maximum: 2048 }),
            anti_aliasing: tool.enum('Anti aliasing mode', ['off', 'msaa', 'ssaa']),
            frame: tool.boolean(
              'Recentre and zoom the camera on the model before capturing. Blockbench\'s direction presets all target the origin, so without this a large rig is cropped.',
              { default: false },
            ),
            padding: tool.number('How much of the frame the model should fill when framing (0.3-0.98)', { default: 0.86, minimum: 0.3, maximum: 0.98 }),
            shading: tool.boolean('Render with shading', { default: true }),
          },
          additionalProperties: false,
        },
        returns: 'ViewportImage { angle, data_url, width, height, bytes }',
      }),
      handler: async (args, ctx) => {
        ctx.throwIfCancelled();
        const angle = (args.angle as string | undefined) ?? 'view';
        // Framing first means the shot is taken from a camera that actually contains
        // the model, and it is taken with "view" so the offscreen render is an exact
        // copy of the framed camera rather than a fresh preset lookup.
        if (args.frame === true) {
          frameViewport({
            angle: angle as never,
            padding: typeof args.padding === 'number' ? args.padding : undefined,
          });
        }
        const image = await captureAngle(args.frame === true ? 'view' : (angle as never), {
          resolution: typeof args.resolution === 'number' ? args.resolution : 640,
          anti_aliasing: args.anti_aliasing as never,
          shading: args.shading !== false,
        });
        return { data: image, verified: image.bytes > 0 };
      },
    },
    {
      definition: defineTool({
        name: 'get_model_snapshot',
        title: 'Get model snapshot',
        description:
          'Capture several camera angles of the model in one call — the main way to actually look at what was built. Defaults to the current view plus front, side, top and both isometric angles. Returns one PNG per angle so the caller can composite them.',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            angles: tool.array('Camera presets to capture', tool.string('Preset id'), { minItems: 1, maxItems: 8 }),
            resolution: tool.integer('Square resolution per angle (128-1024)', { default: 512, minimum: 128, maximum: 1024 }),
            anti_aliasing: tool.enum('Anti aliasing mode', ['off', 'msaa', 'ssaa']),
            shading: tool.boolean('Render with shading', { default: true }),
            frame: tool.boolean(
              'Recentre and zoom on the model for every angle. Presets alone target the origin, which crops anything that is not a single block at the origin.',
              { default: true },
            ),
            padding: tool.number('How much of the frame the model should fill when framing (0.3-0.98)', { default: 0.86, minimum: 0.3, maximum: 0.98 }),
          },
          additionalProperties: false,
        },
        returns: '{ images: ViewportImage[], available_presets: string[], framed: boolean }',
      }),
      handler: async (args, ctx) => {
        const angles = Array.isArray(args.angles) && args.angles.length ? (args.angles as string[]) : DEFAULT_SNAPSHOT_ANGLES;
        const resolution = typeof args.resolution === 'number' ? args.resolution : 512;
        const padding = typeof args.padding === 'number' ? args.padding : 0.86;
        const options = {
          resolution,
          anti_aliasing: args.anti_aliasing as never,
          shading: args.shading !== false,
        };
        const images = [];
        const warnings: string[] = [];
        if (args.frame === false) {
          images.push(...(await captureAngles(angles as never, options, (step, total, label) => ctx.reportProgress(step, total, label))));
        } else {
          // Frame per angle: each preset has its own direction, so each needs its own
          // recentre-and-fit pass before the offscreen copy is taken.
          for (let i = 0; i < angles.length; i++) {
            ctx.throwIfCancelled();
            ctx.reportProgress(i + 1, angles.length, `framing ${angles[i]}`);
            try {
              frameViewport({ angle: angles[i] as never, padding });
              images.push(await captureAngle('view', options));
            } catch (error) {
              warnings.push(`${angles[i]}: ${(error as Error).message}`);
            }
          }
        }
        if (images.length < angles.length) warnings.push(`Only ${images.length} of ${angles.length} requested angles were captured.`);
        return {
          data: {
            images,
            available_presets: availableAnglePresets(),
            requested: angles,
            framed: args.frame !== false,
          },
          warnings: warnings.length ? warnings : undefined,
          verified: images.length > 0 && images.every((image) => image.bytes > 0),
        };
      },
    },
    {
      definition: defineTool({
        name: 'get_texture_view',
        title: 'Get texture view',
        description:
          'Capture the 2D texture editor canvas, including the UV overlay, so you can see how faces are laid out over the texture as well as the texture itself.',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            width: tool.integer('Canvas width in pixels', { minimum: 64, maximum: 4096 }),
            height: tool.integer('Canvas height in pixels', { minimum: 64, maximum: 4096 }),
          },
          additionalProperties: false,
        },
        returns: 'ViewportImage',
      }),
      handler: async (args) => {
        const image = await captureTextureEditor({
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
        });
        return { data: image, verified: image.bytes > 0 };
      },
    },
    {
      definition: defineTool({
        name: 'get_uv_view',
        title: 'Get UV view',
        description:
          'Capture the UV editor so you can judge whether face UVs are packed sensibly, mirrored correctly and free of overlaps.',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            width: tool.integer('Canvas width in pixels', { minimum: 64, maximum: 4096 }),
            height: tool.integer('Canvas height in pixels', { minimum: 64, maximum: 4096 }),
          },
          additionalProperties: false,
        },
        returns: 'ViewportImage',
      }),
      handler: async (args) => {
        const image = await captureTextureEditor({
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
        });
        return { data: { ...image, angle: 'uv_editor' }, verified: image.bytes > 0 };
      },
    },
    {
      definition: defineTool({
        name: 'get_live_viewport',
        title: 'Get live viewport',
        description:
          'Crop exactly what the user currently sees in their viewport, including their camera angle and framing. Useful for answering "does this look right from where I am looking".',
        group: 'visual',
        danger: 'safe',
        needs_checkpoint: false,
        schema: {
          type: 'object',
          properties: {
            width: tool.integer('Output width in pixels', { default: 640, minimum: 64, maximum: 2048 }),
            height: tool.integer('Output height in pixels', { default: 640, minimum: 64, maximum: 2048 }),
          },
          additionalProperties: false,
        },
        returns: 'ViewportImage',
      }),
      handler: async (args) => {
        const image = await captureLiveViewport({
          width: typeof args.width === 'number' ? args.width : 640,
          height: typeof args.height === 'number' ? args.height : 640,
        });
        return { data: image, verified: image.bytes > 0 };
      },
    },
  ];
}
