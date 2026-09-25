/**
 * Checkpoints and error recovery (requirement #11).
 *
 * Blockbench has **no** checkpoint/rollback API — this was verified by reading
 * `js/undo.js` and searching the extracted sources for a `checkpoint` symbol, which
 * does not exist. So the plugin builds one on top of two real primitives:
 *
 *  1. **Rewind the undo stack** (cheap). `UndoSystem` keeps `history` and `index`
 *     (`js/undo.js`), and `UndoSystem.undo()` walks `index` backwards restoring each
 *     save. If the history is still intact we simply undo until `index` matches the
 *     value recorded at checkpoint time. This is exact, instant and preserves the
 *     user's ability to redo.
 *  2. **Reload a compiled snapshot** (safe). `Codecs.project.compile()` serialises the
 *     entire project — geometry, UVs, animations and texture sources — and
 *     `Codecs.project.parse()` loads it back into a freshly created project via
 *     `setupProject()`. That path is used when the undo history was truncated
 *     (Blockbench trims it at `settings.undo_limit`), or when the project changed.
 *
 * A rollback never claims success without re-reading the resulting project state.
 */

import { codecs, maybeProject, project, tryGlobal, undo, type BBModelProject } from './env.js';
import { captureProject } from './state.js';
import type { ProjectSnapshot } from '../shared/protocol.js';

export interface SnapshotPayload {
  /** The compiled `.bbmodel` JSON as produced by Blockbench itself. */
  model: Record<string, unknown>;
  project_name: string | null;
  save_path: string | null;
  format_id: string;
}

export interface CheckpointRecord {
  id: string;
  label: string;
  created_at: number;
  project_uuid: string;
  undo_index: number;
  undo_length: number;
  project: ProjectSnapshot | null;
  counts: { elements: number; groups: number; textures: number; animations: number; keyframes: number };
  snapshot: SnapshotPayload | null;
  /** Set once a rollback rewinds past this point, so stale checkpoints are not reused. */
  consumed?: boolean;
}

export interface RestoreResult {
  checkpoint_id: string;
  label: string;
  strategy: 'undo_stack' | 'snapshot_reload';
  undo_steps: number;
  verified: boolean;
  verification: {
    before: ProjectSnapshot | null;
    after: ProjectSnapshot | null;
    revision_after: number;
  };
  warnings: string[];
}

let counter = 0;

function checkpointId(): string {
  counter += 1;
  return `cp-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function currentCounts(): CheckpointRecord['counts'] {
  const current = maybeProject();
  const elements = (current?.elements ?? []) as unknown[];
  const textures = (current?.textures ?? []) as unknown[];
  const groups = tryGlobal<{ all?: unknown[] }>('Group')?.all ?? [];
  const animations = tryGlobal<{ animations?: Array<{ animators?: Record<string, { keyframes?: unknown[] }> }> }>('Animator')?.animations ?? [];
  const keyframes = animations.reduce(
    (total, animation) =>
      total +
      Object.values(animation.animators ?? {}).reduce((sum, animator) => sum + (animator?.keyframes?.length ?? 0), 0),
    0,
  );
  return { elements: elements.length, groups: groups.length, textures: textures.length, animations: animations.length, keyframes };
}

/** Compiles the entire project the same way "Save" does, without touching the disk. */
export function compileSnapshot(): SnapshotPayload {
  const current = project();
  const codec = codecs().project;
  if (typeof codec?.compile !== 'function') {
    throw new Error('Codecs.project.compile is unavailable; cannot take a project snapshot in this build.');
  }
  // `compile()` returns a *string* by default (it runs the JSON serializer and the
  // minifier). Ask for the raw object instead; fall back to parsing the string for
  // builds that do not honour `raw`, because a string here would otherwise be rejected
  // as "no data" and every checkpoint, save and rollback would fail.
  let model: unknown = codec.compile({ raw: true } as Record<string, unknown>);
  if (typeof model === 'string') {
    try {
      model = JSON.parse(model);
    } catch {
      throw new Error('Codecs.project.compile returned a string that is not valid JSON');
    }
  }
  if (!model || typeof model !== 'object') {
    throw new Error('Codecs.project.compile returned no data');
  }
  const document = model as Record<string, unknown>;
  return {
    model: document,
    project_name: current.name ? String(current.name) : null,
    save_path: current.save_path ? String(current.save_path) : null,
    format_id: current.format?.id ? String(current.format.id) : (document.meta as { model_format?: string } | undefined)?.model_format ?? 'unknown',
  };
}

export class CheckpointManager {
  private readonly records = new Map<string, CheckpointRecord>();
  private readonly order: string[] = [];
  private readonly maxRecords: number;

  /** Optional hook so the UI or bridge can follow long restores. */
  constructor(maxRecords = 40, private readonly onProgress?: (step: number, total: number, label: string) => void) {
    this.maxRecords = maxRecords;
  }

  list(): Array<Omit<CheckpointRecord, 'snapshot'>> {
    return this.order.map((id) => {
      const record = this.records.get(id)!;
      const { snapshot: _snapshot, ...rest } = record;
      return rest;
    });
  }

  get(id: string): CheckpointRecord | undefined {
    return this.records.get(id);
  }

  create(label: string, includeSnapshot = true): CheckpointRecord {
    const current = maybeProject();
    const undoSystem = current?.undo;
    const snapshot = includeSnapshot ? compileSnapshot() : null;
    const record: CheckpointRecord = {
      id: checkpointId(),
      label: label || 'checkpoint',
      created_at: Date.now(),
      project_uuid: String(current?.uuid ?? 'none'),
      undo_index: typeof undoSystem?.index === 'number' ? undoSystem.index : 0,
      undo_length: Array.isArray(undoSystem?.history) ? undoSystem.history.length : 0,
      project: captureProject(),
      counts: currentCounts(),
      snapshot,
    };
    this.records.set(record.id, record);
    this.order.push(record.id);
    while (this.order.length > this.maxRecords) {
      const dropped = this.order.shift();
      if (dropped) this.records.delete(dropped);
    }
    return record;
  }

  /** Drops snapshots for old records to bound memory in long sessions. */
  pruneSnapshots(keep: number): number {
    let dropped = 0;
    for (const id of this.order.slice(0, Math.max(0, this.order.length - keep))) {
      const record = this.records.get(id);
      if (record?.snapshot) {
        record.snapshot = null;
        dropped += 1;
      }
    }
    return dropped;
  }

  restore(id: string): RestoreResult {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown checkpoint "${id}". Known checkpoints: ${this.order.join(', ') || 'none'}`);
    }
    const before = captureProject();
    const warnings: string[] = [];

    // ---------------------------------------------------------------- fast path
    const current = maybeProject();
    const undoSystem = current?.undo;
    const sameProject = !!current && String(current.uuid) === record.project_uuid;
    const historyIntact = Array.isArray(undoSystem?.history) && undoSystem!.history.length >= record.undo_length;
    const indexNow = typeof undoSystem?.index === 'number' ? undoSystem.index : 0;

    if (sameProject && historyIntact && indexNow > record.undo_index && typeof undoSystem?.undo === 'function') {
      let steps = 0;
      const target = record.undo_index;
      const guard = indexNow - target + 8;
      while (steps < guard) {
        const index = typeof undoSystem.index === 'number' ? undoSystem.index : 0;
        if (index <= target) break;
        undoSystem.undo();
        steps += 1;
      }        const finalIndex = typeof undoSystem.index === 'number' ? undoSystem.index : 0;
      if (finalIndex <= target) {
        this.onProgress?.(steps, steps, `rewound ${steps} undo steps`);
        const after = captureProject();
        return {
          checkpoint_id: record.id,
          label: record.label,
          strategy: 'undo_stack',
          undo_steps: steps,
          verified: this.verify(record, after, warnings),
          verification: { before, after, revision_after: Date.now() },
          warnings,
        };
      }
      warnings.push(
        `Undo rewind stopped at index ${finalIndex} instead of ${target}; falling back to a snapshot reload.`,
      );
    }

    // -------------------------------------------------------------- safe path
    if (!record.snapshot) {
      throw new Error(
        `Checkpoint "${record.label}" cannot be restored: its project snapshot was pruned and the undo history no longer covers it.`,
      );
    }
    const steps = this.reloadSnapshot(record.snapshot, warnings);
    const after = captureProject();
    return {
      checkpoint_id: record.id,
      label: record.label,
      strategy: 'snapshot_reload',
      undo_steps: steps,
      verified: this.verify(record, after, warnings),
      verification: { before, after, revision_after: Date.now() },
      warnings,
    };
  }

  /**
   * Replaces the active project with the snapshot.
   *
   * `setupProject()` (js/io/project.ts) constructs a brand new `ModelProject` from the
   * snapshot's format, then `Codecs.project.parse()` (js/formats/bbmodel.js) fills it
   * in — the exact sequence Blockbench's own file loader uses.
   */
  private reloadSnapshot(snapshot: SnapshotPayload, warnings: string[]): number {
    const model = snapshot.model;
    const meta = (model.meta ?? {}) as { model_format?: string };
    const formatId = meta.model_format ?? snapshot.format_id;
    const setupProjectFn = tryGlobal<(format: string, uuid?: string) => boolean>('setupProject');
    if (typeof setupProjectFn !== 'function') {
      throw new Error('setupProject() is unavailable; cannot reload a snapshot in this build.');
    }
    const codec = codecs().project;
    if (typeof codec?.parse !== 'function') {
      throw new Error('Codecs.project.parse is unavailable; cannot reload a snapshot in this build.');
    }
    setupProjectFn(formatId);
    const parsed = codec.parse(model, snapshot.save_path ?? undefined);
    const current = maybeProject();
    if (current && snapshot.project_name) {
      try {
        current.name = snapshot.project_name;
      } catch {
        warnings.push('Could not restore the project name after reload.');
      }
    }
    if (current) {
      // Any restored snapshot is by definition not what is on disk yet.
      (current as unknown as { saved: boolean }).saved = false;
    }
    void parsed;
    return 1;
  }

  private verify(record: CheckpointRecord, after: ProjectSnapshot | null, warnings: string[]): boolean {
    if (!after) {
      warnings.push('Rollback ran but no project is open afterwards.');
      return false;
    }
    if (record.project) {
      const expected = record.project;
      const mismatches: string[] = [];
      if (expected.element_count !== after.element_count) {
        mismatches.push(`elements ${after.element_count} != ${expected.element_count}`);
      }
      if (expected.group_count !== after.group_count) {
        mismatches.push(`groups ${after.group_count} != ${expected.group_count}`);
      }
      if (expected.texture_count !== after.texture_count) {
        mismatches.push(`textures ${after.texture_count} != ${expected.texture_count}`);
      }
      if (expected.animation_count !== after.animation_count) {
        mismatches.push(`animations ${after.animation_count} != ${expected.animation_count}`);
      }
      if (mismatches.length) {
        warnings.push(`Rollback verification found differences: ${mismatches.join(', ')}. The project may have changed format.`);
        return false;
      }
    }
    return true;
  }

  /** Used by tool handlers to assert the undo stack is healthy before a big edit. */
  healthcheck(): { index: number; length: number } {
    const undoSystem = project().undo;
    if (!undoSystem) throw new Error('The active project exposes no undo system.');
    return {
      index: typeof undoSystem.index === 'number' ? undoSystem.index : 0,
      length: Array.isArray(undoSystem.history) ? undoSystem.history.length : 0,
    };
  }
}

/** Existing snapshot helper used by `save_project` (bridge writes the bytes). */
export function snapshotForSave(): { model: Record<string, unknown>; name: string; extension: string } {
  const current: BBModelProject = project();
  const snapshot = compileSnapshot();
  return {
    model: snapshot.model,
    name: current.name ? String(current.name) : 'untitled',
    extension: typeof current.getFileExtension === 'function' ? String(current.getFileExtension()) : 'bbmodel',
  };
}

export { undo };
