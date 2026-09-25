/**
 * Minimal JSON Schema validator.
 *
 * The plugin runs inside Blockbench's renderer through `new Function`, so every
 * dependency in the plugin bundle is dead weight shipped into the app. This is a
 * hand written validator for the small subset of JSON Schema that the tool
 * registry actually uses: `type`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum` and the numeric/length bounds.
 *
 * It is deliberately strict about unknown properties (unless the schema allows
 * them) and it reports precise, model-readable errors so a failed tool call can
 * be retried with corrected parameters instead of blindly repeated.
 */

import type { JsonSchema } from './protocol.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** The coerced value (numbers accepted as numeric strings, etc.). */
  value: unknown;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeOf(value) === 'object';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function coerceForType(value: unknown, expected: string): unknown {
  if (expected === 'number' || expected === 'integer') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  if (expected === 'array') {
    // Callers frequently pass a bare number where a vector is expected.
    if (typeof value === 'number') return [value, value, value];
  }
  if (expected === 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return value;
}

function validateInto(schema: JsonSchema, raw: unknown, path: string, issues: ValidationIssue[]): unknown {
  let value = raw;

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((t) => matchesType(value, t))) {
      // Try a safe coercion against the first declared type before failing.
      const coerced = coerceForType(value, expectedTypes[0]);
      if (expectedTypes.some((t) => matchesType(coerced, t))) {
        value = coerced;
      } else {
        issues.push({
          path,
          message: `expected ${expectedTypes.join(' | ')} but received ${typeOf(value)}`,
        });
        return value;
      }
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    issues.push({
      path,
      message: `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')} but received ${JSON.stringify(value)}`,
    });
    return value;
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value = value.map((item, index) => validateInto(schema.items as JsonSchema, item, `${path}[${index}]`, issues));
    }
    return value;
  }

  const isPlainObject = typeOf(value) === 'object' && !Array.isArray(value);
  if (isPlainObject) {
    const object = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (object[key] === undefined) {
        issues.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      if (object[key] === undefined) continue;
      out[key] = validateInto(propSchema, object[key], path ? `${path}.${key}` : key, issues);
    }

    for (const key of Object.keys(object)) {
      if (key in properties) continue;
      if (schema.additionalProperties === true) {
        out[key] = object[key];
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out[key] = validateInto(schema.additionalProperties, object[key], path ? `${path}.${key}` : key, issues);
      } else {
        // Unknown keys are rejected, whether the schema says `false` or says nothing.
        // Silently ignoring a typo in a tool call is how an agent ends up believing it
        // did something it did not do.
        issues.push({
          path: path ? `${path}.${key}` : key,
          message: `unknown argument (allowed: ${Object.keys(properties).join(', ') || 'none'})`,
        });
      }
    }
    return out;
  }

  return value;
}

export function validateArguments(schema: JsonSchema, args: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const value = validateInto(schema, args, '', issues);
  return { ok: issues.length === 0, issues, value };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
}

/** Narrow an arbitrary value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
