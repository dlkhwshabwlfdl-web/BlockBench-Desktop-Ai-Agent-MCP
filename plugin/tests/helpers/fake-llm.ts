/**
 * Scripted model endpoint.
 *
 * The bridge talks to any OpenAI-compatible `/chat/completions`. Instead of mocking the
 * `LlmClient`, this replaces `globalThis.fetch` and answers with real HTTP shapes, so
 * the client's parsing, retry and tool-call normalisation are all under test too.
 */

export interface ScriptedTurn {
  content?: string | null;
  tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> | string; id?: string }>;
  finish_reason?: string;
}

export interface RecordedRequest {
  url: string;
  body: {
    messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
    tools?: Array<{ function: { name: string } }>;
    model?: string;
  };
  headers: Record<string, string>;
}

export interface FakeLlm {
  requests: RecordedRequest[];
  remaining(): number;
  restore(): void;
}

export function scriptLlm(turns: ScriptedTurn[], options: { onExhausted?: ScriptedTurn } = {}): FakeLlm {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  let index = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes('/chat/completions')) {
      return original(input as RequestInfo, init);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as RecordedRequest['body'];
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = String(value);
    requests.push({ url, body, headers });

    const turn = turns[index] ?? options.onExhausted ?? { content: 'done', finish_reason: 'stop' };
    index += 1;
    const message: Record<string, unknown> = { role: 'assistant', content: turn.content ?? (turn.tool_calls ? null : '') };
    if (turn.tool_calls?.length) {
      message.tool_calls = turn.tool_calls.map((call, callIndex) => ({
        id: call.id ?? `call_${index}_${callIndex}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      }));
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, message, finish_reason: turn.finish_reason ?? (turn.tool_calls?.length ? 'tool_calls' : 'stop') }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  return {
    requests,
    remaining: () => Math.max(0, turns.length - index),
    restore() {
      globalThis.fetch = original;
    },
  };
}
