/**
 * Bridge logging.
 *
 * Requirement #9 says API keys must never reach the logs. That is enforced here
 * rather than by convention: every line goes through `redact()` before it is
 * written anywhere, so a key can only leak if someone bypasses this module.
 */

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  at: number;
  level: LogLevel;
  message: string;
  data?: unknown;
}

const RING_SIZE = 500;

/** Patterns that must never appear in output. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, // OpenAI style
  /\b(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, // Anthropic
  /\b(AIza[0-9A-Za-z_-]{6})[0-9A-Za-z_-]+/g, // Google
  /\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
  /(["']?(?:api[_-]?key|apikey|token|authorization|password|secret)["']?\s*[:=]\s*["'])([^"']{6,})(["'])/gi,
];

export function redact(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match: string, ...rest: unknown[]) => {
      // `String.replace` appends (offset, whole string) to the capture groups.
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      if (groups.length >= 3) {
        // key/value form: keep the key and the quote, mask the secret.
        return `${groups[0] ?? ''}${String(groups[1] ?? '').slice(0, 3)}***redacted***${groups[2] ?? ''}`;
      }
      if (groups.length >= 1 && groups[0] !== undefined) {
        // prefix form: the captured prefix is safe to keep (it is a scheme like
        // "Bearer " or a recognisable key header), the rest never is.
        return `${groups[0]}***redacted***`;
      }
      // No capture groups at all: the whole match is the secret.
      void match;
      return '***redacted***';
    });
  }
  return output;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/key|token|secret|password|authorization/i.test(key)) {
        out[key] = typeof entry === 'string' && entry ? `${entry.slice(0, 3)}***redacted***` : '***redacted***';
      } else {
        out[key] = redactValue(entry);
      }
    }
    return out;
  }
  return value;
}

export class Logger {
  private readonly ring: LogRecord[] = [];
  private fileStream: fs.WriteStream | null = null;
  private minLevel: LogLevel = 'info';

  constructor(private readonly context: string = 'bridge') {}

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** Mirror everything into a file so the panel's "Console log" has a durable twin. */
  attachFile(filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch {
      this.fileStream = null;
    }
  }

  child(context: string): Logger {
    const childLogger = new Logger(`${this.context}:${context}`);
    childLogger.minLevel = this.minLevel;
    childLogger.fileStream = this.fileStream;
    return childLogger;
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    const record: LogRecord = {
      at: Date.now(),
      level,
      message: redact(message),
      data: data === undefined ? undefined : redactValue(data),
    };
    this.ring.push(record);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]) {
      const stamp = new Date(record.at).toISOString().slice(11, 23);
      const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${this.context}] ${record.message}${data === undefined ? '' : ` ${safeJson(record.data)}`}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    if (this.fileStream) {
      this.fileStream.write(`${JSON.stringify(record)}\n`);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  recent(limit = 100): LogRecord[] {
    return this.ring.slice(-limit);
  }

  close(): void {
    this.fileStream?.end();
    this.fileStream = null;
  }
}

export const log = new Logger('bridge');

function safeJson(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return '[unserialisable]';
  }
}
