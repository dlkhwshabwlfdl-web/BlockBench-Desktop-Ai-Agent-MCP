import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, redactValue, Logger } from '../../src/bridge/log.js';
import { describeForLog, parseArgs, resolveConfig, ensureWorkspace, findProjectFile, workspacePaths } from '../../src/bridge/config.js';

describe('secret redaction', () => {
  it('masks an OpenAI style key', () => {
    const text = redact('using sk-abcdefghijklmnopqrstuvwxyz0123456789 for requests');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).toContain('sk-abcdef');
    expect(text).toContain('***redacted***');
  });

  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toContain('***redacted***');
  });

  it('masks values of secret-looking keys in objects', () => {
    const value = redactValue({ api_key: 'sk-live-abcdefghijk', model: 'gpt-4o', nested: { token: 'abc123456789' } }) as Record<string, unknown>;
    expect(value.api_key).toMatch(/\*\*\*redacted\*\*\*/);
    expect(value.model).toBe('gpt-4o');
    expect((value.nested as Record<string, unknown>).token).toMatch(/\*\*\*redacted\*\*\*/);
  });

  it('never renders the api key through the config description', () => {
    const { config } = resolveConfigFrom(['--workspace', '.', '--token', 'supersecrettoken']);
    const described = JSON.stringify(describeForLog({ ...config, apiKey: 'sk-verysecretvalue123456' }));
    expect(described).not.toContain('sk-verysecretvalue123456');
    expect(described).not.toContain('supersecrettoken');
  });

  it('describes a config with no token at all instead of crashing the log line', () => {
    const { config } = resolveConfigFrom(['--workspace', '.']);
    const described = describeForLog({ ...config, token: undefined as unknown as string, allowAnonymous: false });
    expect(String(described.auth)).toContain('not set');
  });

  it('keeps the log ring readable after redaction', () => {
    const logger = new Logger('test');
    logger.setLevel('error');
    logger.info('noop');
    logger.error('failed with key sk-abcdefghijklmnop');
    const recent = logger.recent();
    expect(recent.some((record) => record.message.includes('***redacted***'))).toBe(true);
  });
});

describe('cli parsing', () => {
  it('parses the documented flags', () => {
    const flags = parseArgs([
      '--serve',
      '--workspace',
      '/tmp/ws',
      '--port',
      '5000',
      '--model',
      'qwen2.5',
      '--tool',
      'inspect_model',
      '--args',
      '{"name":"body"}',
      '--no-vision',
      '--max-steps',
      '7',
    ]);
    expect(flags.serve).toBe(true);
    expect(flags.workspace).toBe('/tmp/ws');
    expect(flags.port).toBe(5000);
    expect(flags.model).toBe('qwen2.5');
    expect(flags.tool).toBe('inspect_model');
    expect(flags.toolArgs).toBe('{"name":"body"}');
    expect(flags.noVision).toBe(true);
    expect(flags.maxSteps).toBe(7);
  });

  it('rejects an unknown flag loudly instead of ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/);
  });
});

describe('config resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_AGENT_PORT;
    delete process.env.AI_AGENT_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.AI_AGENT_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers an explicit flag over the environment', () => {
    process.env.AI_AGENT_PORT = '1111';
    const { config } = resolveConfigFrom(['--port', '2222']);
    expect(config.port).toBe(2222);
  });

  it('falls back to the environment when no flag is present', () => {
    process.env.AI_AGENT_PORT = '1111';
    process.env.AI_AGENT_MODEL = 'from-env';
    const { config } = resolveConfigFrom([]);
    expect(config.port).toBe(1111);
    expect(config.model).toBe('from-env');
  });

  it('reads ai_context/bridge.json from the workspace', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-config-'));
    fs.mkdirSync(path.join(workspace, 'ai_context'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ai_context', 'bridge.json'), JSON.stringify({ port: 3333, model: 'from-file' }));
    try {
      const { config } = resolveConfigFrom(['--workspace', workspace]);
      expect(config.port).toBe(3333);
      expect(config.model).toBe('from-file');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('generates a token when none is configured, and allows anonymous only when asked', () => {
    // Anonymous by default so Connect works with the printed URL out of the box.
    const generated = resolveConfigFrom([]).config;
    expect(generated.allowAnonymous).toBe(true);
    // …but an explicit token switches auth back on.
    const guarded = resolveConfigFrom(['--token', 'a-strong-session-token']).config;
    expect(guarded.allowAnonymous).toBe(false);
    expect(guarded.token).toBe('a-strong-session-token');

    const anonymous = resolveConfigFrom(['--no-auth']).config;
    expect(anonymous.allowAnonymous).toBe(true);
    expect(anonymous.token).toBe('');
  });

  it('derives an ollama default endpoint when that provider is selected', () => {
    const { config } = resolveConfigFrom(['--provider', 'ollama']);
    expect(config.baseUrl).toContain('11434');
  });

  it('resolves the workspace and creates the expected directories', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-paths-'));
    try {
      const { config } = resolveConfigFrom(['--workspace', workspace]);
      const paths = ensureWorkspace(config);
      for (const dir of [paths.context, paths.references, paths.checkpoints, paths.viewport, paths.textures]) {
        expect(fs.existsSync(dir)).toBe(true);
      }
      expect(paths.references).toBe(path.join(workspacePaths(config).root, 'references'));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('finds the project file, preferring the most recently modified', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-project-'));
    try {
      fs.writeFileSync(path.join(workspace, 'older.bbmodel'), '{}');
      const newer = path.join(workspace, 'newer.bbmodel');
      fs.writeFileSync(newer, '{}');
      const now = Date.now() / 1000;
      fs.utimesSync(path.join(workspace, 'older.bbmodel'), now - 1000, now - 1000);
      fs.utimesSync(newer, now, now);
      expect(findProjectFile(workspace)).toBe(newer);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

/** Helper: resolve config for a synthetic argv without touching the real process args. */
function resolveConfigFrom(argv: string[]) {
  return resolveConfig(argv);
}

