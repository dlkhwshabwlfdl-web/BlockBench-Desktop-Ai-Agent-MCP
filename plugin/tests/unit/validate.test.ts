import { describe, expect, it } from 'vitest';
import { formatIssues, validateArguments } from '../../src/shared/validate.js';
import { tool, type JsonSchemaObject } from '../../src/shared/protocol.js';

const schema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: tool.string('Name'),
    size: tool.integer('Size', { minimum: 1, maximum: 64 }),
    position: tool.vec3('Position'),
    faces: tool.array('Faces', tool.string('Face'), { minItems: 1 }),
    mode: tool.enum('Mode', ['add', 'replace']),
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateArguments', () => {
  it('accepts a well formed call', () => {
    const result = validateArguments(schema, { name: 'leg', size: 4, position: [1, 2, 3], faces: ['north'], mode: 'add' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ name: 'leg', size: 4, position: [1, 2, 3], faces: ['north'], mode: 'add' });
  });

  it('reports a missing required argument by name', () => {
    const result = validateArguments(schema, { size: 4 });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toContain('name: is required');
  });

  it('rejects unknown arguments because a typo must not look like success', () => {
    const result = validateArguments(schema, { name: 'leg', sizee: 4 });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toMatch(/sizee: unknown argument \(allowed: .*size.*\)/);
  });

  it('coerces numeric strings, which models produce constantly', () => {
    const result = validateArguments(schema, { name: 'leg', size: '4' });
    expect(result.ok).toBe(true);
    expect((result.value as Record<string, unknown>).size).toBe(4);
  });

  it('rejects an out of range number', () => {
    const result = validateArguments(schema, { name: 'leg', size: 900 });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toContain('size: must be <= 64');
  });

  it('coerces a number or boolean into a string but refuses an incompatible type', () => {
    const coerced = validateArguments(schema, { name: 12 });
    expect(coerced.ok).toBe(true);
    expect((coerced.value as Record<string, unknown>).name).toBe('12');

    const rejected = validateArguments(schema, { name: 'leg', faces: 'north' });
    expect(rejected.ok).toBe(false);
    expect(formatIssues(rejected.issues)).toContain('faces: expected array but received string');
  });

  it('validates nested items and their length bounds', () => {
    const result = validateArguments(schema, { name: 'leg', faces: [], position: [1, 2, 'x'] });
    expect(result.ok).toBe(false);
    const issues = formatIssues(result.issues);
    expect(issues).toContain('faces: must contain at least 1 items');
    expect(issues).toMatch(/position\[2\]: expected number but received string/);
  });

  it('rejects a value outside an enum and lists the valid options', () => {
    const result = validateArguments(schema, { name: 'leg', mode: 'delete' });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toContain('expected one of "add", "replace"');
  });

  it('rejects a vector of the wrong length', () => {
    const result = validateArguments(schema, { name: 'leg', position: [1, 2] });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toContain('position: must contain at least 3 items');
  });

  it('passes a free-form object through untouched so whole documents can be sent', () => {
    // open_project hands Blockbench an entire parsed .bbmodel. Its shape is not
    // knowable in advance, so the schema must accept arbitrary keys.
    const free: JsonSchemaObject = {
      type: 'object',
      properties: { model: tool.freeObject('Parsed document'), path: tool.string('Path') },
      required: ['model'],
      additionalProperties: false,
    };
    const document = { meta: { format_id: 'free' }, elements: [{ name: 'torso' }], nested: { deep: [1, 2, 3] } };
    const result = validateArguments(free, { model: document, path: 'trex.bbmodel' });
    expect(result.ok).toBe(true);
    expect((result.value as Record<string, unknown>).model).toEqual(document);
  });

  it('still rejects unknown keys on a plain object schema', () => {
    const plain: JsonSchemaObject = {
      type: 'object',
      properties: { model: tool.object('Known shape', {}), path: tool.string('Path') },
      additionalProperties: false,
    };
    const result = validateArguments(plain, { model: { unexpected: 1 } });
    expect(result.ok).toBe(false);
    expect(formatIssues(result.issues)).toContain('model.unexpected: unknown argument (allowed: none)');
  });
});
