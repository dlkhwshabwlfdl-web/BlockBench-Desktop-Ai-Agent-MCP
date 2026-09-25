/**
 * Project memory (requirement #8).
 *
 * Everything the agent must remember between runs lives in `ai_context/`:
 *
 *   project.json      goal, target format, scale, naming conventions, known issues
 *   decisions.json    design decisions with rationale and source
 *   tasks.json        task list with status, so a long build can resume
 *   history.json      append-only audit log of what the agent actually did
 *   checkpoints/      compiled `.bbmodel` snapshots for rollback
 *   viewport/         every screenshot the agent looked at
 *   textures/         every texture the bridge generated
 *
 * The store is intentionally dumb and synchronous-ish: it owns files, nothing else.
 * The agent decides *what* to remember; this class decides *where* it goes.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WorkspacePaths } from './config.js';
import { Logger } from './log.js';

export interface ProjectMemory {
  goal: string | null;
  target_format: string | null;
  scale: string | null;
  naming_conventions: string[];
  notes: string[];
  known_issues: string[];
  created_at: number;
  updated_at: number;
  blockbench_version: string | null;
}

export interface Decision {
  id: string;
  at: number;
  topic: string;
  decision: string;
  rationale: string;
  source: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked';

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  detail: string | null;
  created_at: number;
  updated_at: number;
  attempts: number;
  notes: string[];
}

export interface HistoryEntry {
  at: number;
  kind: 'tool' | 'agent' | 'checkpoint' | 'rollback' | 'note' | 'error' | 'save';
  summary: string;
  tool: string | null;
  ok: boolean | null;
  duration_ms: number | null;
  detail?: unknown;
}

export interface StoredCheckpoint {
  checkpoint_id: string;
  label: string;
  created_at: number;
  project_name: string | null;
  format_id: string | null;
  undo_index: number;
  undo_length: number;
  counts: Record<string, number> | null;
  file: string;
}

export interface ReferenceImage {
  name: string;
  file: string;
  mime: string;
  bytes: number;
  base64: string;
}

const MAX_HISTORY = 800;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

function now(): number {
  return Date.now();
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export class MemoryStore {
  private project: ProjectMemory;
  private decisions: Decision[];
  private tasks: TaskRecord[];
  private history: HistoryEntry[];

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly logger: Logger,
  ) {
    this.project = readJson<ProjectMemory>(this.file('project.json'), {
      goal: null,
      target_format: null,
      scale: null,
      naming_conventions: [],
      notes: [],
      known_issues: [],
      created_at: now(),
      updated_at: now(),
      blockbench_version: null,
    });
    this.decisions = readJson<Decision[]>(this.file('decisions.json'), []);
    this.tasks = readJson<TaskRecord[]>(this.file('tasks.json'), []);
    this.history = readJson<HistoryEntry[]>(this.file('history.json'), []);
  }

  private file(name: string): string {
    return path.join(this.paths.context, name);
  }

  snapshot(): { project: ProjectMemory; decisions: Decision[]; tasks: TaskRecord[]; history: HistoryEntry[] } {
    return {
      project: { ...this.project },
      decisions: [...this.decisions],
      tasks: [...this.tasks],
      history: [...this.history],
    };
  }

  /* ---------------------------------------------------------------- project */

  updateProject(patch: Partial<ProjectMemory>): ProjectMemory {
    this.project = {
      ...this.project,
      ...patch,
      naming_conventions: patch.naming_conventions ?? this.project.naming_conventions,
      notes: patch.notes ?? this.project.notes,
      known_issues: patch.known_issues ?? this.project.known_issues,
      updated_at: now(),
    };
    writeJson(this.file('project.json'), this.project);
    this.logger.debug('project memory updated', { keys: Object.keys(patch) });
    return this.project;
  }

  addNote(note: string): void {
    if (!note || this.project.notes.includes(note)) return;
    this.project.notes = [...this.project.notes.slice(-40), note];
    this.updateProject({});
  }

  addKnownIssue(issue: string): void {
    if (!issue || this.project.known_issues.includes(issue)) return;
    this.project.known_issues = [...this.project.known_issues.slice(-40), issue];
    this.updateProject({});
  }

  /* -------------------------------------------------------------- decisions */

  addDecision(input: Omit<Decision, 'id' | 'at'> & { id?: string }): Decision {
    const decision: Decision = {
      id: input.id ?? uid('dec'),
      at: now(),
      topic: input.topic,
      decision: input.decision,
      rationale: input.rationale,
      source: input.source ?? null,
    };
    this.decisions.push(decision);
    writeJson(this.file('decisions.json'), this.decisions);
    return decision;
  }

  /* ------------------------------------------------------------------ tasks */

  upsertTask(input: { id?: string; title: string; status?: TaskStatus; detail?: string | null; note?: string }): TaskRecord {
    const existing = input.id ? this.tasks.find((task) => task.id === input.id) : this.tasks.find((task) => task.title === input.title);
    if (existing) {
      existing.status = input.status ?? existing.status;
      if (input.detail !== undefined) existing.detail = input.detail;
      if (input.note) {
        existing.notes = [...existing.notes.slice(-20), input.note];
        existing.attempts += 1;
      }
      existing.updated_at = now();
      writeJson(this.file('tasks.json'), this.tasks);
      return existing;
    }
    const task: TaskRecord = {
      id: input.id ?? uid('task'),
      title: input.title,
      status: input.status ?? 'pending',
      detail: input.detail ?? null,
      created_at: now(),
      updated_at: now(),
      attempts: 1,
      notes: input.note ? [input.note] : [],
    };
    this.tasks.push(task);
    writeJson(this.file('tasks.json'), this.tasks);
    return task;
  }

  openTasks(): TaskRecord[] {
    return this.tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked');
  }

  /* ---------------------------------------------------------------- history */

  appendHistory(entry: Omit<HistoryEntry, 'at'> & { at?: number }): void {
    this.history.push({
      at: entry.at ?? now(),
      kind: entry.kind,
      summary: entry.summary,
      tool: entry.tool ?? null,
      ok: entry.ok ?? null,
      duration_ms: entry.duration_ms ?? null,
      detail: entry.detail,
    });
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    writeJson(this.file('history.json'), this.history);
  }

  recentHistory(limit = 20): HistoryEntry[] {
    return this.history.slice(-limit);
  }

  /* ------------------------------------------------------------ checkpoints */

  writeCheckpoint(record: StoredCheckpoint, model: Record<string, unknown> | null): StoredCheckpoint {
    const file = path.join(this.paths.checkpoints, `${record.checkpoint_id}.json`);
    writeJson(file, {
      meta: { ...record, file: undefined },
      model,
    });
    const summary: StoredCheckpoint = { ...record, file };
    writeJson(path.join(this.paths.checkpoints, 'index.json'), this.listCheckpoints().concat([summary]));
    this.logger.info(`checkpoint stored: ${record.label} (${file})`);
    return summary;
  }

  listCheckpoints(): StoredCheckpoint[] {
    const indexFile = path.join(this.paths.checkpoints, 'index.json');
    const list = readJson<StoredCheckpoint[]>(indexFile, []);
    return list.filter((entry) => entry && entry.checkpoint_id);
  }

  readCheckpoint(checkpointId: string): { meta: StoredCheckpoint; model: Record<string, unknown> | null } | null {
    const file = path.join(this.paths.checkpoints, `${checkpointId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { meta: StoredCheckpoint; model: Record<string, unknown> | null };
      return { meta: { ...parsed.meta, file }, model: parsed.model ?? null };
    } catch (error) {
      this.logger.warn(`could not read checkpoint ${checkpointId}: ${(error as Error).message}`);
      return null;
    }
  }

  /* -------------------------------------------------------------- artifacts */

  private writeBinary(dir: string, name: string, data: Buffer | string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
    const file = path.join(dir, safe);
    fs.mkdirSync(dir, { recursive: true });
    if (typeof data === 'string') fs.writeFileSync(file, data, 'utf8');
    else fs.writeFileSync(file, data);
    return file;
  }

  saveTexture(name: string, png: Buffer): string {
    return this.writeBinary(this.paths.textures, name.endsWith('.png') ? name : `${name}.png`, png);
  }

  saveViewport(name: string, png: Buffer): string {
    return this.writeBinary(this.paths.viewport, name.endsWith('.png') ? name : `${name}.png`, png);
  }

  saveProjectDocument(name: string, json: string): string {
    const file = path.join(this.paths.root, name.endsWith('.bbmodel') ? name : `${name}.bbmodel`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json, 'utf8');
    return file;
  }

  saveProjectBackup(name: string, json: string): string {
    return this.writeBinary(this.paths.checkpoints, `${name}.bbmodel`, json);
  }

  readProjectDocument(file: string): Record<string, unknown> {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /* ------------------------------------------------------------- references */

  listReferences(): ReferenceImage[] {
    const dir = this.paths.references;
    if (!fs.existsSync(dir)) return [];
    const out: ReferenceImage[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      const file = path.join(dir, entry.name);
      try {
        const buffer = fs.readFileSync(file);
        out.push({
          name: entry.name,
          file,
          mime: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/png',
          bytes: buffer.length,
          base64: buffer.toString('base64'),
        });
      } catch (error) {
        this.logger.warn(`could not read reference ${entry.name}: ${(error as Error).message}`);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /* ------------------------------------------------------------------ digest */

  /** Compact memory digest inserted into the agent prompt. */
  digest(maxHistory = 12): string {
    const lines: string[] = [];
    lines.push(`- goal: ${this.project.goal ?? '(not set)'}`);
    lines.push(`- target format: ${this.project.target_format ?? '(not set)'}`);
    lines.push(`- scale: ${this.project.scale ?? '(not set)'}`);
    if (this.project.naming_conventions.length) lines.push(`- naming: ${this.project.naming_conventions.join('; ')}`);
    if (this.project.known_issues.length) lines.push(`- known issues: ${this.project.known_issues.join('; ')}`);
    if (this.decisions.length) {
      lines.push(`- decisions: ${this.decisions.slice(-8).map((d) => `${d.topic} → ${d.decision}`).join(' | ')}`);
    }
    const open = this.openTasks();
    if (open.length) {
      lines.push(`- open tasks: ${open.map((task) => `${task.title} [${task.status}]`).join(' | ')}`);
    }
    const recent = this.recentHistory(maxHistory);
    if (recent.length) {
      lines.push(`- recent actions: ${recent.map((entry) => `[${entry.kind}] ${entry.summary}`).join(' | ')}`);
    }
    return lines.join('\n');
  }
}
