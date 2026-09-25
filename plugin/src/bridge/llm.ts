/**
 * LLM client (OpenAI compatible chat completions).
 *
 * Deliberately hand written instead of pulling in an SDK: the bridge only needs one
 * endpoint (`POST {base}/chat/completions`), and the raw request makes it obvious
 * exactly what the agent sends — including that the API key never leaves the
 * `Authorization` header and never appears in a log line (see `log.ts`).
 *
 * Works against OpenAI, Azure-compatible gateways, OpenRouter, vLLM, LM Studio and
 * Ollama's `/v1` endpoint.
 */

import type { Logger } from './log.js';

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LlmReply {
  message: ChatMessage;
  finishReason: string | null;
  usage: LlmUsage | null;
  /** Provider-side error text when the response was a non-fatal 200 with an error body. */
  warning?: string;
}

export interface LlmOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logger: Logger;
  signal?: AbortSignal;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function textify(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `[image ${part.image_url.url.slice(0, 32)}…]`))
    .join('\n');
}

export { textify as messageText };

export class LlmClient {
  private readonly logger: Logger;

  constructor(private readonly options: LlmOptions) {
    this.logger = options.logger.child('llm');
  }

  get model(): string {
    return this.options.model;
  }

  get endpoint(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[] = [], toolChoice: 'auto' | 'none' = 'auto'): Promise<LlmReply> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature,
      stream: false,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.options.extraHeaders,
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

    let lastError: LlmError | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.post(body, headers);
        const reply = this.parse(response);
        if (reply.usage) {
          this.logger.debug(
            `usage prompt=${reply.usage.prompt_tokens ?? '?'} completion=${reply.usage.completion_tokens ?? '?'} finish=${reply.finishReason ?? '?'}`,
          );
        }
        return reply;
      } catch (error) {
        const llmError = error instanceof LlmError ? error : new LlmError((error as Error).message);
        lastError = llmError;
        if (!llmError.retryable || attempt === 3) break;
        const delay = 700 * attempt + Math.floor(Math.random() * 300);
        this.logger.warn(`${llmError.message} — retrying in ${delay}ms (attempt ${attempt}/3)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError ?? new LlmError('the model request failed');
  }

  private async post(body: Record<string, unknown>, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const onAbort = () => controller.abort();
    this.options.signal?.addEventListener('abort', onAbort, { once: true });
    const payload = JSON.stringify(body);
    this.logger.debug(`POST ${this.endpoint} (${Math.round(payload.length / 1024)} KB, ${(body.messages as unknown[])?.length ?? 0} messages)`);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = RETRY_STATUSES.has(response.status);
        throw new LlmError(
          `model endpoint returned HTTP ${response.status}: ${summarise(text)}`,
          response.status,
          retryable,
          text.slice(0, 2000),
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LlmError(`model endpoint returned non-JSON payload: ${summarise(text)}`, response.status, true);
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const err = error as Error;
      if (err.name === 'AbortError') {
        if (this.options.signal?.aborted) throw new LlmError('model request cancelled', null, false);
        throw new LlmError(`model request timed out after ${this.options.timeoutMs}ms`, null, true);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const hint = cause?.code === 'ECONNREFUSED'
        ? ` — nothing is listening at ${this.options.baseUrl}. Start the model server or fix --base-url.`
        : '';
      throw new LlmError(`${err.message}${hint}`, null, true);
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private parse(raw: unknown): LlmReply {
    const payload = raw as {
      choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
      error?: { message?: string };
      usage?: LlmUsage;
    };
    if (payload.error) {
      throw new LlmError(`model endpoint reported an error: ${payload.error.message ?? 'unknown'}`, null, false);
    }
    const choice = payload.choices?.[0];
    if (!choice) throw new LlmError('model endpoint returned no choices', null, true);
    const message = choice.message ?? ({ role: 'assistant', content: '' } as ChatMessage);
    // Some providers put the text under `content` as an array of parts; normalise it.
    if (Array.isArray(message.content)) {
      const parts = message.content as unknown as ChatContentPart[];
      if (parts.every((part) => part && part.type === 'text')) {
        message.content = parts.map((part) => (part as ChatTextPart).text).join('');
      }
    }
    // Ollama and a few gateways emit tool calls with empty ids, which breaks the
    // assistant/tool pairing; give each call a stable synthetic id.
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.map((call, index) => ({
        id: call?.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function' as const,
        function: {
          name: String(call?.function?.name ?? ''),
          arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {}),
        },
      }));
      if (message.content === undefined) message.content = null;
    }
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: payload.usage ?? null,
    };
  }
}

function summarise(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Parses tool-call arguments, tolerating the several shapes models produce. */
export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, error: `expected a JSON object but received ${Array.isArray(parsed) ? 'an array' : typeof parsed}` };
  } catch (error) {
    // A common failure is trailing prose or a fenced block around otherwise valid JSON.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        return { ok: true, value: parsed };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: `arguments are not valid JSON: ${(error as Error).message}` };
  }
}
