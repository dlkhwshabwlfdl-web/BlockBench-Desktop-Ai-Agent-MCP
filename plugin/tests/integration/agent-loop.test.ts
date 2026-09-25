/**
 * The agent loop, end to end.
 *
 * A real `PluginSession` on a real socket, a real `FakePlugin` on the other end, and a
 * scripted model endpoint. This is the closest thing to the final acceptance test that
 * can run without Blockbench: it proves the handshake, the tool catalogue exchange, the
 * checkpoint-before-mutating-tool rule, the vision round trip and the finish protocol.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import { startHarness, type Harness } from '../helpers/harness.js';
import { FakePlugin } from '../helpers/fake-plugin.js';
import { scriptLlm } from '../helpers/fake-llm.js';
import { createImage, encodeDataUrl } from '../../src/bridge/image.js';
import type { ToolDefinition } from '../../src/shared/protocol.js';

let harness: Harness | null = null;
let plugin: FakePlugin | null = null;
let llm: ReturnType<typeof scriptLlm> | null = null;

afterEach(async () => {
  llm?.restore();
  plugin?.close();
  await harness?.stop();
  harness = null;
  plugin = null;
  llm = null;
});

const REQUIRED_TOOLS: ToolDefinition[] = [
  {
    name: 'inspect_model',
    title: 'Inspect model',
    description: 'Return every cube and its transform',
    group: 'inspect',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    returns: 'ModelSummary',
  },
  {
    name: 'create_cube',
    title: 'Create cube',
    description: 'Create a cube in the outliner',
    group: 'geometry',
    danger: 'mutating',
    needs_checkpoint: true,
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, from: { type: 'array', items: { type: 'number' } }, to: { type: 'array', items: { type: 'number' } } },
      required: ['name'],
      additionalProperties: false,
    },
    returns: 'NodeSummary',
  },
  {
    name: 'validate_model',
    title: 'Validate model',
    description: 'Check the model for problems',
    group: 'inspect',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    returns: '{ issues: string[] }',
  },
  {
    name: 'get_model_snapshot',
    title: 'Get model snapshot',
    description: 'Render several camera angles',
    group: 'visual',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: { angles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    returns: '{ images: ViewportImage[] }',
  },
  {
    name: 'save_project',
    title: 'Save project',
    description: 'Save the project',
    group: 'project',
    danger: 'safe',
    needs_checkpoint: false,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    returns: '{ saved: boolean }',
  },
];

function tinyPng(): string {
  return encodeDataUrl(createImage(12, 12, [90, 140, 60, 255]));
}

function snapshotPayload() {
  return {
    images: [
      { angle: 'view', data_url: tinyPng(), width: 12, height: 12, bytes: 120 },
      { angle: 'north', data_url: tinyPng(), width: 12, height: 12, bytes: 120 },
    ],
    available_presets: ['view', 'north', 'east', 'top'],
  };
}

async function setup(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  harness = await startHarness();
  plugin = new FakePlugin({ url: harness.wsUrl, token: 'test-token', tools: REQUIRED_TOOLS, handlers });
  await plugin.connect();
  await harness.session.listTools(true);
  return { harness, plugin };
}

describe('agent loop', () => {
  it('observes, mutates with a checkpoint, looks at the render, validates, saves and finishes', async () => {
    const handlerCalls: string[] = [];
    const { harness: h, plugin: fake } = await setup({
      inspect_model: () => {
        handlerCalls.push('inspect_model');
        return { elements: [{ name: 'body', from: [-4, 0, -4], to: [4, 8, 4] }], groups: [] };
      },
      create_cube: (args) => {
        handlerCalls.push(`create_cube:${String(args.name)}`);
        return { uuid: 'uuid-leg', name: args.name };
      },
      get_model_snapshot: () => {
        handlerCalls.push('get_model_snapshot');
        return snapshotPayload();
      },
      validate_model: () => {
        handlerCalls.push('validate_model');
        return { issues: [], cube_count: 2 };
      },
      save_project: () => {
        handlerCalls.push('save_project');
        return { saved: true, path: 'trex.bbmodel' };
      },
    });

    llm = scriptLlm([
      { tool_calls: [{ name: 'inspect_model', arguments: {} }] },
      {
        tool_calls: [
          { name: 'create_cube', arguments: { name: 'leg.left', from: [-2, -8, -1], to: [0, 0, 1] } },
          { name: 'bridge_plan', arguments: { tasks: [{ title: 'legs', status: 'in_progress' }, { title: 'texture the belly' }] } },
        ],
      },
      { tool_calls: [{ name: 'bridge_look', arguments: { annotation: 'checking the leg position', resolution: 192 } }] },
      { tool_calls: [{ name: 'validate_model', arguments: {} }, { name: 'save_project', arguments: {} }] },
      {
        tool_calls: [
          { name: 'bridge_remember', arguments: { decision: { topic: 'leg placement', decision: 'hips at y=0', rationale: 'reads as a biped' } } },
          { name: 'bridge_finish', arguments: { summary: 'Built a biped leg and verified it against the render.', verified: true, saved: true } },
        ],
      },
    ]);

    const progress: string[] = [];
    const result = await h.agent.run({
      brief: { prompt: 'Add a left leg to the body', projectName: 'trex', formatId: 'java_block', savePath: null },
      taskId: 'task-test',
      onProgress: (event) => progress.push(event.label),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.verified).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.summary).toContain('biped leg');

    // The plugin really received the calls, in order, through the socket.
    expect(handlerCalls).toEqual(['inspect_model', 'create_cube:leg.left', 'get_model_snapshot', 'validate_model', 'save_project']);

    // A mutating tool must have been preceded by a checkpoint.
    expect(fake.checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(fake.checkpoints[0]).toContain('create_cube');

    // bridge_look composited a contact sheet and wrote it to the workspace.
    const captures = fs.readdirSync(h.paths.viewport);
    expect(captures.length).toBe(1);
    expect(captures[0]).toMatch(/^look-.*\.png$/);

    // The plan and the decision landed in project memory.
    const snapshot = h.memory.snapshot();
    expect(snapshot.tasks.map((task) => task.title)).toContain('legs');
    expect(snapshot.decisions.some((decision) => decision.topic === 'leg placement')).toBe(true);

    // Progress was reported for the panel.
    expect(progress.some((label) => label.includes('create_cube'))).toBe(true);
    expect(result.tool_log.some((entry) => entry.tool === 'bridge_look' && entry.ok)).toBe(true);
  });

  it('sends the rendered pixels to the model as an image, not as base64 text', async () => {
    const { harness: h } = await setup({
      get_model_snapshot: () => snapshotPayload(),
    });
    // A reference image on disk must also arrive as a real image part.
    fs.writeFileSync(
      `${h.paths.references}/trex.png`,
      Buffer.from(tinyPng().split(',')[1], 'base64'),
    );
    llm = scriptLlm([
      { tool_calls: [{ name: 'bridge_look', arguments: {} }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'looked', verified: true } }] },
    ]);

    const result = await h.agent.run({
      brief: { prompt: 'look at the model', projectName: null, formatId: null, savePath: null },
      taskId: 'task-vision',
    });
    expect(result.ok).toBe(true);

    const secondRequest = llm.requests[1];
    const imageMessages = secondRequest.body.messages.filter(
      (message) => Array.isArray(message.content) && (message.content as Array<{ type: string }>).some((part) => part.type === 'image_url'),
    );
    // The opening brief carries the reference image, and the capture arrives as its own
    // follow-up message right after the tool results.
    expect(imageMessages.length).toBe(2);
    const capture = imageMessages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(capture.some((part) => part.type === 'image_url' && part.image_url?.url.startsWith('data:image/png;base64,'))).toBe(true);

    // And the tool result text must not carry the raw base64.
    const toolMessages = secondRequest.body.messages.filter((message) => message.role === 'tool');
    const serialised = JSON.stringify(toolMessages);
    expect(serialised).not.toContain(tinyPng().slice(30, 200));
    expect(serialised).toContain('attached in the next message');
  });

  it('reports an unknown tool back to the model with the list of valid names', async () => {
    const { harness: h } = await setup({ inspect_model: () => ({ elements: [] }) });
    llm = scriptLlm([
      { tool_calls: [{ name: 'create_dinosaur_magic', arguments: {} }] },
      { tool_calls: [{ name: 'inspect_model', arguments: {} }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'recovered', verified: false } }] },
    ]);

    const result = await h.agent.run({
      brief: { prompt: 'do the impossible', projectName: null, formatId: null, savePath: null },
      taskId: 'task-unknown',
    });
    expect(result.ok).toBe(true);
    const toolMessage = llm.requests[1].body.messages.find((message) => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('unknown_tool');
    expect(String(toolMessage?.content)).toContain('inspect_model');
  });

  it('recovers from a failed tool call by inspecting the error', async () => {
    const { harness: h, plugin: fake } = await setup({
      create_cube: (args) => ({ uuid: 'u', name: args.name }),
      inspect_model: () => ({ elements: [] }),
    });
    fake.failNext = { code: 'invalid_arguments', message: 'cube would have zero volume' };
    llm = scriptLlm([
      { tool_calls: [{ name: 'create_cube', arguments: { name: 'bad' } }] },
      { tool_calls: [{ name: 'create_cube', arguments: { name: 'good' } }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'fixed the volume', verified: true } }] },
    ]);

    const result = await h.agent.run({
      brief: { prompt: 'make a cube', projectName: null, formatId: null, savePath: null },
      taskId: 'task-retry',
    });
    expect(result.ok).toBe(true);
    const failureMessage = llm.requests[1].body.messages.find((message) => message.role === 'tool');
    expect(String(failureMessage?.content)).toContain('zero volume');
    expect(fake.calls.map((call) => call.tool)).toEqual(['create_cube', 'create_cube']);
  });

  it('nudges the model once when it tries to finish without verifying anything', async () => {
    const { harness: h } = await setup({
      get_model_snapshot: () => snapshotPayload(),
      validate_model: () => ({ issues: [] }),
    });
    llm = scriptLlm([
      { content: 'I built the whole dinosaur.' },
      { tool_calls: [{ name: 'bridge_look', arguments: {} }] },
      { tool_calls: [{ name: 'validate_model', arguments: {} }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'checked it', verified: true } }] },
    ]);

    const result = await h.agent.run({
      brief: { prompt: 'build it', projectName: null, formatId: null, savePath: null },
      taskId: 'task-nudge',
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('checked it');
    const nudge = llm.requests[1].body.messages[llm.requests[1].body.messages.length - 1];
    expect(nudge.role).toBe('user');
    expect(String(nudge.content)).toContain('bridge_finish');
  });

  it('stops at the step limit instead of looping forever', async () => {
    const { harness: h } = await setup({ inspect_model: () => ({ elements: [] }) });
    llm = scriptLlm([], { onExhausted: { tool_calls: [{ name: 'inspect_model', arguments: {} }] } });
    const result = await h.agent.run({
      brief: { prompt: 'loop forever', projectName: null, formatId: null, savePath: null },
      taskId: 'task-loop',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('step_limit');
    expect(result.steps).toBeGreaterThan(5);
  }, 20000);

  it('cancels promptly when the caller aborts', async () => {
    const { harness: h, plugin: fake } = await setup({
      inspect_model: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { elements: [] };
      },
    });
    fake.toolDelayMs = 0;
    llm = scriptLlm([], { onExhausted: { tool_calls: [{ name: 'inspect_model', arguments: {} }] } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const result = await h.agent.run({
      brief: { prompt: 'cancel me', projectName: null, formatId: null, savePath: null },
      taskId: 'task-cancel',
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cancelled');
  }, 20000);
});

describe('bridge tools', () => {
  it('generates a texture that can be handed straight to the plugin', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { harness: h } = await setup({
      create_texture: (args) => {
        received.push(args);
        return { uuid: 'tex-1', name: args.name };
      },
    });
    llm = scriptLlm([
      {
        tool_calls: [
          {
            name: 'bridge_generate_texture',
            arguments: {
              name: 'trex_body',
              width: 24,
              height: 24,
              base: '#5c7a3a',
              pattern: 'scales',
              seed: 42,
              also_create: true,
            },
          },
        ],
      },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'textured', verified: true } }] },
    ]);

    const result = await h.agent.run({
      brief: { prompt: 'texture the body', projectName: null, formatId: null, savePath: null },
      taskId: 'task-texture',
    });
    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(String(received[0].data_url)).toMatch(/^data:image\/png;base64,/);
    // create_texture received the full data URL, which is what makes the round trip real.
    expect(String(received[0].data_url).length).toBeGreaterThan(200);
    expect(fs.readdirSync(h.paths.textures)).toHaveLength(1);
  });

  it('rolls back to the latest checkpoint on request', async () => {
    const { harness: h, plugin: fake } = await setup({ inspect_model: () => ({ elements: [] }) });
    llm = scriptLlm([
      { tool_calls: [{ name: 'bridge_checkpoint', arguments: { label: 'before the mess' } }] },
      { tool_calls: [{ name: 'bridge_rollback', arguments: { reason: 'the mess happened' } }] },
      { tool_calls: [{ name: 'bridge_finish', arguments: { summary: 'reverted', verified: true } }] },
    ]);
    const result = await h.agent.run({
      brief: { prompt: 'screw it up then revert', projectName: null, formatId: null, savePath: null },
      taskId: 'task-rollback',
    });
    expect(result.ok).toBe(true);
    expect(fake.checkpoints).toContain('before the mess');
    expect(fake.rollbacks).toContain('cp-1');
    expect(result.checkpoints).toContain('cp-1');
    // The bridge's own index knows about it too, which is what lets rollback-without-an-id
    // work from the REST API.
    expect(h.memory.listCheckpoints().map((entry) => entry.checkpoint_id)).toContain('cp-1');
  });
});
