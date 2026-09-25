/**
 * The agent loop: OBSERVE → PLAN → EXECUTE → INSPECT → REFINE → VERIFY → SAVE.
 *
 * This class owns the conversation with the model and the decision of what to do with
 * each tool call. It deliberately knows nothing about Blockbench: everything reaches
 * the app through `PluginSession.callTool`, so the loop is identical whether the tools
 * came from the plugin or from `local-tools.ts`.
 *
 * Two details make the difference between a demo and something usable:
 *
 *   1. Image results are lifted out of the tool-result channel. OpenAI-style tool
 *      messages are text-only, so a screenshot returned by `bridge_look` would be lost
 *      as a 900 KB base64 string. Instead the pixels are moved into a follow-up user
 *      message as real image parts, and the tool result keeps only the layout metadata.
 *   2. Every mutating call is logged to project memory, so a later run knows what the
 *      previous one actually did rather than what it claimed.
 */

import type { ToolDefinition } from '../shared/protocol.js';
import type { Logger } from './log.js';
import type { MemoryStore } from './memory.js';
import type { PluginSession, ToolCallOptions } from './session.js';
import { LlmClient, LlmError, messageText, parseToolArguments, type ChatMessage, type ToolSchema } from './llm.js';
import { LOCAL_TOOL_PREFIX, localTools, storeCheckpoint, type LocalTool } from './local-tools.js';
import { buildSystemPrompt, buildTaskMessage } from './prompts.js';

export interface AgentConfig {
  maxSteps: number;
  enableVision: boolean;
  workspace: string;
  defaultAngles: string[];
  /** Characters of a tool result that are forwarded to the model verbatim. */
  maxToolResultChars: number;
}

export interface AgentBrief {
  prompt: string;
  projectName: string | null;
  formatId: string | null;
  savePath: string | null;
}

export interface AgentProgress {
  step: number;
  total: number;
  label: string;
}

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  verified: boolean;
  saved: boolean;
  steps: number;
  tool_calls: number;
  started_at: number;
  finished_at: number;
  checkpoints: string[];
  tool_log: Array<{ step: number; tool: string; ok: boolean; summary: string; duration_ms: number }>;
  error?: { code: string; message: string };
}

export interface AgentRunOptions {
  brief: AgentBrief;
  taskId: string;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  onToolCall?: (event: { tool: string; args: Record<string, unknown>; step: number }) => void;
}

export class Agent {
  private readonly llm: LlmClient;
  private readonly locals: Map<string, LocalTool>;
  private readonly logger: Logger;

  constructor(
    private readonly session: PluginSession,
    readonly memory: MemoryStore,
    private readonly config: AgentConfig,
    paths: { viewport: string; textures: string },
    llm: { baseUrl: string; model: string; apiKey: string; extraHeaders?: Record<string, string>; maxTokens: number; temperature: number; timeoutMs: number },
    logger: Logger,
  ) {
    this.logger = logger.child('agent');
    this.llm = new LlmClient({ ...llm, logger: this.logger });
    this.locals = new Map(
      localTools({
        session,
        memory,
        logger: this.logger,
        workspaceRoot: config.workspace,
        viewportDir: paths.viewport,
        textureDir: paths.textures,
        defaultAngles: config.defaultAngles,
      }).map((local) => [local.definition.name, local]),
    );
  }

  get model(): string {
    return this.llm.model;
  }

  /** Bridge tools, for catalogue endpoints (HTTP/MCP) that must list everything. */
  localDefinitions(): ToolDefinition[] {
    return [...this.locals.values()].map((local) => local.definition);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const started = Date.now();
    const toolLog: AgentRunResult['tool_log'] = [];
    const checkpoints: string[] = [];
    let toolCalls = 0;
    let steps = 0;
    let finalSummary = '';
    let verified = false;
    let saved = false;
    let finishRequested = false;

    const fail = (error: { code: string; message: string }): AgentRunResult => ({
      ok: false,
      summary: finalSummary,
      verified,
      saved,
      steps,
      tool_calls: toolCalls,
      started_at: started,
      finished_at: Date.now(),
      checkpoints,
      tool_log: toolLog,
      error,
    });

    const pluginTools = await this.session.listTools();
    if (!pluginTools.length) {
      return fail({
        code: 'no_tools',
        message: 'The plugin reported no tools. Update the plugin or reload it, then try again.',
      });
    }
    const definitions = new Map<string, ToolDefinition>(pluginTools.map((definition) => [definition.name, definition]));
    for (const local of this.locals.values()) definitions.set(local.definition.name, local.definition);

    const systemPrompt = buildSystemPrompt({
      capabilities: this.session.capabilities,
      tools: [...definitions.values()],
      memory: this.memory,
      references: this.memory.listReferences(),
      visionEnabled: this.config.enableVision,
      workspace: this.config.workspace,
    });

    const references = this.memory.listReferences();
    const brief = buildTaskMessage(options.brief, references);
    const snapshot = this.session.state;
    const contextLines: string[] = [];
    if (snapshot?.project) {
      const project = snapshot.project;
      contextLines.push(
        `Current project at task start: "${project.project_name ?? '(unsaved)'}" · format ${project.format_id} · ${project.element_count} cubes in ${project.group_count} groups · ${project.texture_count} textures · ${project.animation_count} animations · resolution ${project.resolution.width}x${project.resolution.height}`,
      );
    }
    if (snapshot?.selection && (snapshot.selection.elements.length || snapshot.selection.groups.length)) {
      contextLines.push(`Current selection: ${[...snapshot.selection.groups, ...snapshot.selection.elements].slice(0, 12).join(', ')}`);
    }

    const firstMessage: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: [brief.text, contextLines.join('\n')].filter(Boolean).join('\n\n') },
        ...brief.images.map((reference) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${reference.mime};base64,${reference.base64}`, detail: 'high' as const },
        })),
      ],
    };

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, firstMessage];
    const toolSchemas: ToolSchema[] = [...definitions.values()].map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: `${definition.description}\n\nReturns: ${definition.returns}${definition.needs_checkpoint ? '\n(Blockbench takes a checkpoint before this runs.)' : ''}`,
        parameters: definition.schema as unknown as Record<string, unknown>,
      },
    }));

    this.logger.info(`task started with ${toolSchemas.length} tools available (${pluginTools.length} from the plugin)`);
    this.session.notifyAgentStatus({ state: 'running', task_id: options.taskId, step: 0, total: this.config.maxSteps, label: 'observing' });

    const throwIfAborted = (): void => {
      if (options.signal?.aborted) {
        throw new LlmError('task cancelled', null, false);
      }
    };

    let nudges = 0;
    let visionNudged = false;

    try {
      for (steps = 1; steps <= this.config.maxSteps; steps++) {
        throwIfAborted();
        options.onProgress?.({ step: steps, total: this.config.maxSteps, label: `thinking (step ${steps}/${this.config.maxSteps})` });
        this.session.notifyAgentStatus({
          state: 'running',
          task_id: options.taskId,
          step: steps,
          total: this.config.maxSteps,
          label: 'thinking',
        });

        const reply = await this.llm.chat(messages, toolSchemas, 'auto');
        const assistant = reply.message;
        const text = messageText(assistant.content).trim();
        if (text) finalSummary = text;
        messages.push({
          role: 'assistant',
          content: assistant.content ?? (assistant.tool_calls?.length ? null : ''),
          tool_calls: assistant.tool_calls,
        });

        const calls = assistant.tool_calls ?? [];
        if (!calls.length) {
          if (finishRequested) break;
          // The model stopped calling tools. Give it exactly one reminder to verify and
          // finish properly, because "I built it" without a check is the classic failure.
          if (nudges < 1) {
            nudges += 1;
            const wantsVision = this.config.enableVision && !visionNudged;
            messages.push({
              role: 'user',
              content:
                `You stopped without calling ${LOCAL_TOOL_PREFIX}finish.\n` +
                (wantsVision
                  ? `Before finishing: call ${LOCAL_TOOL_PREFIX}look to actually see the model, run validate_model, fix anything the render shows, then call ${LOCAL_TOOL_PREFIX}finish.`
                  : `Before finishing: run validate_model and confirm the state with an inspection tool, then call ${LOCAL_TOOL_PREFIX}finish.`),
            });
            if (wantsVision) visionNudged = true;
            continue;
          }
          break;
        }

        const images: Array<{ label: string; dataUrl: string }> = [];
        for (const call of calls) {
          throwIfAborted();
          toolCalls += 1;
          const name = call.function.name;
          const definition = definitions.get(name);
          const parsed = parseToolArguments(call.function.arguments);
          const callOptions: ToolCallOptions = { taskId: options.taskId, signal: options.signal };

          if (!definition) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `ERROR unknown_tool: "${name}" does not exist. Available tools: ${[...definitions.keys()].sort().join(', ')}`,
            });
            toolLog.push({ step: steps, tool: name, ok: false, summary: 'unknown tool', duration_ms: 0 });
            continue;
          }
          if (!parsed.ok) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `ERROR invalid_arguments: ${parsed.error}\nExpected JSON matching this schema: ${JSON.stringify(definition.schema).slice(0, 1200)}`,
            });
            toolLog.push({ step: steps, tool: name, ok: false, summary: 'bad arguments', duration_ms: 0 });
            continue;
          }

          options.onToolCall?.({ tool: name, args: parsed.value, step: steps });
          options.onProgress?.({ step: steps, total: this.config.maxSteps, label: `${name} ${summariseArgs(parsed.value)}`.trim() });

          let content = '';
          let ok = false;
          let durationMs = 0;
          let summary = '';

          const local = this.locals.get(name);
          if (local) {
            const began = Date.now();
            try {
              const result = await local.handler(parsed.value, { taskId: options.taskId, signal: options.signal, options: callOptions });
              durationMs = Date.now() - began;
              ok = true;
              if (result.finish) {
                finishRequested = true;
                finalSummary = result.finish.summary;
                verified = result.finish.verified;
                saved = parsed.value.saved === true ? true : saved;
              }
              if (result.images?.length) images.push(...result.images);
              // A checkpoint the agent asked for is just as real as one taken for it.
              const created = (result.data as { checkpoint_id?: string } | null)?.checkpoint_id;
              if (name === `${LOCAL_TOOL_PREFIX}checkpoint` && created) checkpoints.push(created);
              const rendered = renderResult(result.data, this.config.maxToolResultChars);
              summary = rendered.summary;
              content = [
                rendered.text,
                result.warnings?.length ? `WARNINGS: ${result.warnings.join(' | ')}` : '',
                result.images?.length ? `[${result.images.length} image(s) attached in the next message]` : '',
              ]
                .filter(Boolean)
                .join('\n');
            } catch (error) {
              durationMs = Date.now() - began;
              content = `ERROR local_tool_failed: ${(error as Error).message}`;
              summary = (error as Error).message;
            }
          } else {
            if (definition.needs_checkpoint) {
              try {
                const record = await this.session.checkpoint(`before ${name}`);
                checkpoints.push(record.checkpoint_id);
                storeCheckpoint(this.memory, record);
                this.logger.debug(`checkpoint ${record.checkpoint_id} taken before ${name}`);
              } catch (error) {
                this.logger.warn(`could not checkpoint before ${name}: ${(error as Error).message}`);
              }
            }
            const outcome = await this.session.callTool(name, parsed.value, callOptions);
            durationMs = outcome.duration_ms;
            ok = outcome.ok;
            summary = ok ? 'ok' : outcome.error?.message ?? 'failed';
            if (ok) {
              const rendered = renderResult(outcome.data, this.config.maxToolResultChars);
              summary = rendered.summary;
              content = [rendered.text, outcome.warnings?.length ? `WARNINGS: ${outcome.warnings.join(' | ')}` : '']
                .filter(Boolean)
                .join('\n');
              for (const image of collectImages(outcome.data)) images.push(image);
            } else {
              content = `ERROR ${outcome.error?.code ?? 'failed'}: ${outcome.error?.message ?? 'unknown error'}${
                outcome.error?.detail ? `\n${JSON.stringify(outcome.error.detail).slice(0, 800)}` : ''
              }`;
            }
          }

          messages.push({ role: 'tool', tool_call_id: call.id, content: content || (ok ? 'ok' : 'failed') });
          toolLog.push({ step: steps, tool: name, ok, summary: summary.slice(0, 200), duration_ms: durationMs });
          if (definition.danger !== 'safe') {
            this.memory.appendHistory({ kind: 'tool', summary: `${name}: ${summary}`.slice(0, 300), tool: name, ok, duration_ms: durationMs });
          }
          this.logger.debug(`${name} → ${ok ? 'ok' : 'error'} (${durationMs}ms)${summary && ok ? ` · ${summary.slice(0, 120)}` : ''}`);
        }

        if (images.length) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${images.length === 1 ? 'An image' : `${images.length} images`} captured by the tool ${images.length === 1 ? 'call' : 'calls'} above. Read ${images.length === 1 ? 'it' : 'them'} critically and continue.`,
              },
              ...images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: image.dataUrl, detail: 'high' as const },
              })),
            ],
          });
        }

        if (finishRequested) break;
      }

      if (steps > this.config.maxSteps && !finishRequested) {
        finalSummary = finalSummary || 'Stopped after reaching the step limit.';
        return fail({
          code: 'step_limit',
          message: `The agent hit its ${this.config.maxSteps} step limit before finishing. Raise --max-steps or split the task.`,
        });
      }

      if (!finalSummary) finalSummary = 'Task finished.';
      this.session.notifyAgentStatus({ state: 'idle', task_id: options.taskId, label: 'done' });
      return {
        ok: true,
        summary: finalSummary,
        verified,
        saved,
        steps,
        tool_calls: toolCalls,
        started_at: started,
        finished_at: Date.now(),
        checkpoints,
        tool_log: toolLog,
      };
    } catch (error) {
      const aborted = options.signal?.aborted === true || (error as Error)?.message === 'task cancelled';
      if (aborted) {
        this.session.cancel(undefined, 'task aborted');
        this.session.notifyAgentStatus({ state: 'idle', task_id: options.taskId, message: 'cancelled' });
        return fail({ code: 'cancelled', message: 'Task cancelled.' });
      }
      const message = (error as Error).message ?? String(error);
      this.logger.error(`agent run failed: ${message}`);
      this.memory.appendHistory({ kind: 'error', summary: message.slice(0, 300), tool: null, ok: false, duration_ms: null });
      this.session.notifyAgentStatus({ state: 'error', task_id: options.taskId, message });
      return fail({ code: error instanceof LlmError ? 'model_error' : 'agent_error', message });
    }
  }
}

/* ----------------------------------------------------------------- rendering */

interface Rendered {
  text: string;
  summary: string;
}

/**
 * Turns a tool payload into something a model can act on: JSON with the bulk stripped
 * out, plus a one line summary for the log. Base64 image data is removed here because
 * it travels in its own message (see `collectImages`).
 */
export function renderResult(data: unknown, maxChars: number): Rendered {
  let summary = '';
  const cleaned = stripImageData(data, (note) => {
    summary = summary || note;
  });
  let text: string;
  try {
    text = JSON.stringify(cleaned, null, 1) ?? 'null';
  } catch {
    text = String(cleaned);
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[result truncated at ${maxChars} characters; call an inspection tool with a narrower scope if you need the rest]`;
  }
  if (!summary) summary = describeShape(cleaned);
  return { text, summary };
}

/**
 * Distinguishes real base64 from a long sentence. Prose is clipped (and still readable);
 * a binary blob is dropped, because 8000 characters of packed pixels tells the model
 * nothing it can use.
 */
function looksLikeBase64(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return new Set(value.slice(0, 1024)).size >= 16;
}

/** Replaces embedded image payloads and long buffers with a short marker. */
function stripImageData(value: unknown, note: (text: string) => void, key = ''): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      note(`image (${Math.round(value.length / 1024)} KB)`);
      return `[image data: ${Math.round(value.length / 1024)} KB, attached separately]`;
    }
    if (key === 'base64' || (value.length > 4000 && looksLikeBase64(value))) {
      note('binary payload');
      return `[${value.length} characters of base64 omitted]`;
    }
    if (value.length > 1200) return `${value.slice(0, 1200)}…`;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 60) {
      return [...value.slice(0, 60).map((entry) => stripImageData(entry, note, key)), `…${value.length - 60} more`];
    }
    return value.map((entry) => stripImageData(entry, note, key));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[entryKey] = stripImageData(entry, note, entryKey);
    }
    return out;
  }
  return value;
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}` : 'empty object';
  }
  return String(value).slice(0, 120);
}

/** Finds image payloads anywhere in a tool result, keeping any nearby label. */
export function collectImages(data: unknown, limit = 8): Array<{ label: string; dataUrl: string }> {
  const out: Array<{ label: string; dataUrl: string }> = [];
  const visit = (value: unknown, hint: string): void => {
    if (out.length >= limit || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) out.push({ label: hint, dataUrl: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, hint || `image ${index + 1}`));
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const label = typeof record.angle === 'string' ? record.angle : typeof record.label === 'string' ? record.label : typeof record.name === 'string' ? record.name : hint;
      for (const [key, entry] of Object.entries(record)) visit(entry, label || key);
    }
  };
  visit(data, '');
  return out;
}

function summariseArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args).slice(0, 4)) {
    if (typeof value === 'string') {
      parts.push(value.length > 34 ? `${key}=${value.slice(0, 34)}…` : `${key}=${value}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}[${value.length}]`);
    } else if (value && typeof value === 'object') {
      parts.push(`${key}{…}`);
    }
  }
  return parts.join(' ').slice(0, 120);
}
