#!/usr/bin/env node
/**
 * Decode a Blockbench autosave backup into plain JSON.
 *
 * Blockbench writes `<lz>` + `LZUTF8.compress(json, {outputEncoding: 'StorageBinaryString'})`
 * (`js/formats/bbmodel.js` compile, `options.compressed`) into
 * `%APPDATA%/Blockbench/backups/backup_<date>_<name>.bbmodel`. Those files are not
 * plain JSON, so the offline audit tooling cannot read them until they are inflated —
 * which matters because an unsaved session is only ever recoverable from here.
 *
 * Uses the vendored LZUTF8 build (`tools/vendor/lzutf8.cjs`); the format is its own
 * 15-bits-per-UTF16-unit "StorageBinaryString" encoding, not LZString.
 *
 * Usage:
 *   node tools/decompress-backup.mjs <backup.bbmodel> [out.bbmodel] [--summary]
 *   node tools/decompress-backup.mjs --list <backupdir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LZUTF8 = require('./vendor/lzutf8.cjs');

const ENCODINGS = ['StorageBinaryString', 'BinaryString'];

/** Inflate a raw backup file. Accepts plain JSON as well as `<lz>` payloads. */
export function decodeBackup(raw) {
  const text = raw.toString('utf8');
  if (!text.startsWith('<lz>')) return JSON.parse(text);
  const body = text.slice(4);
  const failures = [];
  for (const inputEncoding of ENCODINGS) {
    try {
      const json = LZUTF8.decompress(body, { inputEncoding });
      if (!json) throw new Error('empty result');
      return JSON.parse(json);
    } catch (error) {
      failures.push(`${inputEncoding}: ${error.message}`);
    }
  }
  throw new Error(`could not decode backup (${failures.join('; ')})`);
}

/**
 * A bbmodel animator stores `keyframes` as an array of keyframe objects
 * (`{channel, time, data_points: [...]}`). Count a keyframe as real only when it
 * carries data points, since an empty shell still satisfies `Array.isArray`.
 */
export function countKeyframes(animator) {
  const list = animator?.keyframes;
  if (!Array.isArray(list)) return 0;
  return list.filter((k) => Array.isArray(k?.data_points) && k.data_points.length).length;
}

/** Compact description of a decoded project, for triage. */
export function describeProject(project) {
  const meta = project.meta ?? {};
  const animations = project.animations ?? [];
  const withKeys = animations.filter((a) =>
    Object.values(a.animators ?? {}).some((an) => countKeyframes(an) > 0),
  );
  const totalKeys = animations.reduce(
    (sum, a) => sum + Object.values(a.animators ?? {}).reduce((s, an) => s + countKeyframes(an), 0),
    0,
  );
  return {
    name: meta.name ?? '(unnamed)',
    format: meta.model_format ?? meta.format_id ?? null,
    resolution: [meta.resolution?.width ?? meta.texture_width, meta.resolution?.height ?? meta.texture_height],
    cubes: (project.elements ?? []).length,
    outliner_roots: (project.outliner ?? []).length,
    bones: JSON.stringify(project.outliner ?? []).match(/"type"\s*:\s*"group"/g)?.length ?? 0,
    animations: animations.length,
    animations_with_keyframes: withKeys.length,
    total_keyframes: totalKeys,
    textures: (project.textures ?? []).length,
    empty_animations: animations
      .filter((a) => !withKeys.includes(a))
      .map((a) => a.name),
  };
}

/* -------------------------------------------------------------------- cli */

const argv = process.argv.slice(2);

async function main() {
  if (argv.includes('--list')) {
    const dir = argv[argv.indexOf('--list') + 1];
    const entries = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.bbmodel'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(0, 12)) {
      try {
        const d = describeProject(decodeBackup(fs.readFileSync(path.join(dir, f))));
        console.log(`${f}  ${d.cubes} cubes · ${d.animations} anims (${d.animations_with_keyframes} keyed) · ${d.textures} tex · ${d.name}`);
      } catch (error) {
        console.log(`${f}  unreadable (${error.message})`);
      }
    }
    return;
  }

  const source = argv[0];
  if (!source) {
    console.error('usage: node tools/decompress-backup.mjs <backup.bbmodel> [out.bbmodel] [--summary]');
    console.error('       node tools/decompress-backup.mjs --list <backupdir>');
    process.exitCode = 2;
    return;
  }

  const project = decodeBackup(fs.readFileSync(source));
  if (argv.includes('--summary')) {
    console.log(JSON.stringify(describeProject(project), null, 2));
    return;
  }
  const outArg = argv.slice(1).find((a) => !a.startsWith('--'));
  const target = outArg ?? source.replace(/\.bbmodel$/, '.decoded.bbmodel');
  fs.writeFileSync(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  const d = describeProject(project);
  console.log(`${source}\n  → ${target}`);
  console.log(`  ${d.cubes} cubes · ${d.bones} bones · ${d.animations} animations (${d.animations_with_keyframes} keyed, ${d.total_keyframes} keyframes) · ${d.textures} textures`);
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
