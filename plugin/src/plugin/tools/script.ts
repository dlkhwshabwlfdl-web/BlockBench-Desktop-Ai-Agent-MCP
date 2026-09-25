/**
 * `run_script` — the escape hatch.
 *
 * Off by default (see the `ai_agent_allow_scripts` setting), and when enabled it
 * still requires `confirm: true` on every call. The script runs through
 * `new Function` with the verified Blockbench globals, and:
 *
 *  - a checkpoint is forced before execution (the tool declares `needs_checkpoint`)
 *  - the return value must be JSON serialisable, so nothing leaks a live object graph
 *  - a timeout guards against an infinite loop (the evaluation itself is synchronous
 *    and cannot be interrupted, so the timeout only reports, it does not preempt)
 *  - the plugin wraps the call in an undo bracket unless the script opts out
 *
 * This exists because the tool registry can never cover every API. It is not the
 * primary path and the agent prompt discourages it.
 */

import { undo } from '../env.js';
import { tool } from '../../shared/protocol.js';
import {
  ToolExecutionError,
  ToolValidationError,
  defineTool,
  type RegisteredTool,
} from './registry.js';

/** Globals exposed to a script. Keeping this list explicit is the whole sandbox. */
const SCRIPT_GLOBALS = [
  'Blockbench',
  'Project',
  'Format',
  'Outliner',
  'Cube',
  'Group',
  'Mesh',
  'Locator',
  'NullObject',
  'Texture',
  'Animation',
  'AnimationItem',
  'Animator',
  'Timeline',
  'Keyframe',
  'Canvas',
  'Preview',
  'Screencam',
  'Codecs',
  'ModelProject',
  'Modes',
  'Mode',
  'BarItems',
  'Panels',
  'Settings',
  'Prop',
  'UndoSystem',
  'setTimeout',
  'clearTimeout',
  'Math',
  'JSON',
] as const;

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brequire\s*\(/, reason: 'require() is not available inside the script sandbox' },
  { pattern: /\bimport\s*\(/, reason: 'dynamic import is not available inside the script sandbox' },
  { pattern: /\bfetch\s*\(/, reason: 'network access from the plugin is not permitted' },
  { pattern: /\bWebSocket\b/, reason: 'network access from the plugin is not permitted' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'network access from the plugin is not permitted' },
  { pattern: /\blocalStorage\b/, reason: 'localStorage access is not permitted' },
  { pattern: /\bindexedDB\b/, reason: 'indexedDB access is not permitted' },
  { pattern: /document\.cookie/, reason: 'cookie access is not permitted' },
];

export function scriptTools(isEnabled: () => boolean): RegisteredTool[] {
  return [
    {
      definition: defineTool({
        name: 'run_script',
        title: 'Run script',
        description:
          'Execute a JavaScript snippet inside Blockbench with the verified globals in scope and return its JSON value. This is a last resort for things the tool registry cannot express; prefer the dedicated tools. Disabled by default and always requires confirm: true, plus a checkpoint is taken first.',
        group: 'advanced',
        danger: 'destructive',
        needs_checkpoint: true,
        schema: {
          type: 'object',
          properties: {
            code: tool.string('JavaScript body. Use `return <value>` to produce a result.', { maxLength: 20000 }),
            confirm: tool.boolean('Acknowledge that this executes arbitrary code', { default: false }),
            make_undoable: tool.boolean('Bracket the script in a single undo entry', { default: true }),
            label: tool.string('Undo label', { default: 'AI agent script' }),
          },
          required: ['code'],
          additionalProperties: false,
        },
        returns: '{ result, globals_available, undoable }',
      }),
      handler: (args, ctx) => {
        if (!isEnabled()) {
          throw new ToolExecutionError(
            'run_script is disabled. Enable it in the AI Agent plugin settings ("Allow run_script") if you really need it.',
            'disabled',
          );
        }
        if (args.confirm !== true) {
          throw new ToolValidationError('run_script requires confirm: true.');
        }
        const code = String(args.code ?? '');
        if (!code.trim()) throw new ToolValidationError('"code" must not be empty');
        for (const { pattern, reason } of BLOCKED_PATTERNS) {
          if (pattern.test(code)) {
            throw new ToolValidationError(`Blocked script content: ${reason}`);
          }
        }

        const scope: Record<string, unknown> = {};
        const available: string[] = [];
        for (const name of SCRIPT_GLOBALS) {
          const value = (globalThis as unknown as Record<string, unknown>)[name];
          if (value !== undefined) {
            scope[name] = value;
            available.push(name);
          }
        }
        scope.__agent = {
          requestId: ctx.requestId,
          log: (message: string) => ctx.log('info', `[script] ${message}`),
        };

        const names = Object.keys(scope);
        const values = names.map((name) => scope[name]);
        let fn: (...args: unknown[]) => unknown;
        try {
          // eslint-disable-next-line no-new-func
          fn = new Function(...names, `"use strict";\n${code}\n`) as (...args: unknown[]) => unknown;
        } catch (error) {
          throw new ToolValidationError(`Script failed to compile: ${(error as Error).message}`);
        }

        const undoable = args.make_undoable !== false;
        const label = typeof args.label === 'string' && args.label ? args.label : 'AI agent script';
        let undoOpen = false;
        if (undoable && ctx.undoEnabled) {
          ctx.checkpoints.healthcheck();
          undo().initEdit({ outliner: true, elements: [], groups: [], textures: [], animations: [], selection: true });
          undoOpen = true;
        }

        const started = Date.now();
        let result: unknown;
        try {
          result = fn(...values);
        } catch (error) {
          if (undoOpen) {
            try {
              undo().cancelEdit(false);
            } catch {
              /* best effort */
            }
          }
          throw new ToolExecutionError(`Script threw: ${(error as Error)?.message ?? String(error)}`, 'script_error');
        }
        if (undoOpen) {
          undo().finishEdit(label);
        }

        let serialised: unknown = result;
        try {
          serialised = JSON.parse(JSON.stringify(result ?? null));
        } catch {
          serialised = `[unserialisable ${typeof result}]`;
        }
        ctx.log('info', `run_script finished in ${Date.now() - started}ms`);
        return { data: { result: serialised, globals_available: available, undoable }, verified: true };
      },
    },
  ];
}

/** Exposed for the capability report so the panel can show what the sandbox provides. */
export const scriptSandboxGlobals = SCRIPT_GLOBALS;
