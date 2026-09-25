import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../../src/bridge/memory.js';
import { Logger } from '../../src/bridge/log.js';
import { ensureWorkspace } from '../../src/bridge/config.js';
import { makeConfig } from '../helpers/harness.js';
import { collectImages, renderResult } from '../../src/bridge/agent.js';

let workspace: string;
let memory: MemoryStore;
let paths: ReturnType<typeof ensureWorkspace>;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-memory-'));
  const logger = new Logger('test');
  logger.setLevel('error');
  const config = makeConfig(workspace);
  paths = ensureWorkspace(config);
  memory = new MemoryStore(paths, logger);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('project memory', () => {
  it('persists the goal and reloads it in a fresh instance', () => {
    memory.updateProject({ goal: 'a T-Rex that reads at 20 blocks', target_format: 'java_block', scale: '1 cube = 1/16 block' });
    const logger = new Logger('test');
    logger.setLevel('error');
    const reloaded = new MemoryStore(paths, logger);
    expect(reloaded.snapshot().project.goal).toBe('a T-Rex that reads at 20 blocks');
    expect(reloaded.snapshot().project.target_format).toBe('java_block');
  });

  it('records decisions with their rationale', () => {
    const decision = memory.addDecision({
      topic: 'leg length',
      decision: 'legs are 40% of body height',
      rationale: 'the reference silhouette has long shins',
      source: 'reference 2',
    });
    expect(decision.id).toMatch(/^dec-/);
    expect(memory.snapshot().decisions[0].rationale).toContain('shins');
  });

  it('upserts tasks by title and accumulates notes and attempts', () => {
    const first = memory.upsertTask({ title: 'build head', status: 'pending' });
    memory.upsertTask({ title: 'build head', status: 'in_progress', note: 'jaw hinge needs a pivot' });
    const same = memory.snapshot().tasks.filter((task) => task.title === 'build head');
    expect(same).toHaveLength(1);
    expect(same[0].id).toBe(first.id);
    expect(same[0].status).toBe('in_progress');
    expect(same[0].attempts).toBe(2);
    expect(same[0].notes).toContain('jaw hinge needs a pivot');
  });

  it('lists only unfinished tasks as open', () => {
    memory.upsertTask({ title: 'done thing', status: 'done' });
    memory.upsertTask({ title: 'pending thing', status: 'pending' });
    memory.upsertTask({ title: 'blocked thing', status: 'blocked' });
    expect(memory.openTasks().map((task) => task.title).sort()).toEqual(['blocked thing', 'pending thing']);
  });

  it('keeps history bounded and recent-first queryable', () => {
    for (let i = 0; i < 40; i++) {
      memory.appendHistory({ kind: 'tool', summary: `call ${i}`, tool: 'create_cube', ok: true, duration_ms: 1 });
    }
    expect(memory.recentHistory(5).map((entry) => entry.summary)).toEqual(['call 35', 'call 36', 'call 37', 'call 38', 'call 39']);
  });

  it('summarises itself into a digest that the prompt can embed', () => {
    memory.updateProject({ goal: 'build a T-Rex', known_issues: ['tail is stiff'] });
    memory.addDecision({ topic: 'scale', decision: '20 blocks', rationale: 'reads at distance', source: null });
    memory.upsertTask({ title: 'texture the belly', status: 'in_progress' });
    memory.appendHistory({ kind: 'save', summary: 'saved trex.bbmodel', tool: null, ok: true, duration_ms: null });
    const digest = memory.digest();
    expect(digest).toContain('build a T-Rex');
    expect(digest).toContain('scale → 20 blocks');
    expect(digest).toContain('texture the belly');
    expect(digest).toContain('tail is stiff');
  });

  it('stores and reads checkpoints with their compiled model', () => {
    const record = memory.writeCheckpoint(
      {
        checkpoint_id: 'cp-test',
        label: 'before tail',
        created_at: Date.now(),
        project_name: 'trex',
        format_id: 'java_block',
        undo_index: 3,
        undo_length: 10,
        counts: { elements: 12 },
        file: '',
      },
      { elements: [{ name: 'body' }] },
    );
    expect(record.file.endsWith('cp-test.json')).toBe(true);
    const read = memory.readCheckpoint('cp-test');
    expect(read?.meta.label).toBe('before tail');
    expect(read?.model).toEqual({ elements: [{ name: 'body' }] });
    expect(memory.listCheckpoints().map((entry) => entry.checkpoint_id)).toContain('cp-test');
  });

  it('lists reference images with their bytes but without leaking them into JSON', () => {
    fs.writeFileSync(path.join(paths.references, 'trex.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(paths.references, 'notes.txt'), 'ignored');
    const references = memory.listReferences();
    expect(references).toHaveLength(1);
    expect(references[0].name).toBe('trex.png');
    expect(references[0].mime).toBe('image/png');
    expect(references[0].base64.length).toBeGreaterThan(0);
  });

  it('writes textures and viewport captures into the workspace, not into the cwd', () => {
    const textureFile = memory.saveTexture('dino skin.png', Buffer.from('x'));
    const viewFile = memory.saveViewport('look.png', Buffer.from('x'));
    expect(textureFile.startsWith(paths.textures)).toBe(true);
    expect(viewFile.startsWith(paths.viewport)).toBe(true);
    expect(path.basename(textureFile)).toBe('dino_skin.png');
  });
});

describe('tool result rendering', () => {
  it('turns a large payload into something readable and keeps the important numbers', () => {
    const rendered = renderResult({ elements: Array.from({ length: 200 }, (_, i) => ({ name: `cube_${i}`, from: [0, 0, 0] })), count: 200 }, 5000);
    expect(rendered.text).toContain('cube_0');
    expect(rendered.text.length).toBeLessThanOrEqual(5000 + 200);
  });

  it('strips base64 image data out of the JSON so it cannot bloat the prompt', () => {
    const rendered = renderResult({ data_url: `data:image/png;base64,${'A'.repeat(5000)}`, width: 8, height: 8 }, 8000);
    expect(rendered.text).not.toContain('A'.repeat(200));
    expect(rendered.text).toContain('attached separately');
    expect(rendered.text).toContain('"width": 8');
  });

  it('clips a single enormous text field before the whole payload has a chance to explode', () => {
    const rendered = renderResult({ prose: 'lorem ipsum dolor sit amet '.repeat(2000) }, 10000);
    expect(rendered.text.length).toBeLessThan(3000);
    expect(rendered.text).toContain('…');
  });

  it('drops a base64 field entirely and reports only its size', () => {
    const rendered = renderResult({ base64: 'QUJD'.repeat(2000) }, 10000);
    expect(rendered.text).toContain('characters of base64 omitted');
    expect(rendered.text).not.toContain('QUJDQUJDQUJD');
  });

  it('does not mistake a long sentence for base64', () => {
    const rendered = renderResult({ prose: 'lorem ipsum dolor sit amet '.repeat(100) }, 10000);
    expect(rendered.text).toContain('lorem ipsum dolor');
    expect(rendered.text).not.toContain('base64 omitted');
  });

  it('truncates a result that is still too big and says what to do about it', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 200; i++) wide[`field_${i}`] = 'y'.repeat(900);
    const rendered = renderResult(wide, 1000);
    expect(rendered.text).toContain('result truncated at 1000 characters');
    expect(rendered.text).toContain('narrower scope');
  });

  it('finds images anywhere in a nested payload and labels them by angle', () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const images = collectImages({ images: [{ angle: 'north', data_url: dataUrl }, { angle: 'top', data_url: dataUrl }] });
    expect(images.map((image) => image.label)).toEqual(['north', 'top']);
    expect(images[0].dataUrl).toBe(dataUrl);
  });

  it('ignores payloads with no images', () => {
    expect(collectImages({ elements: [{ name: 'body' }] })).toEqual([]);
  });
});
