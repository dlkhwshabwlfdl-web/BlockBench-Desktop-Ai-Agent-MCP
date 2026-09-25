/**
 * UV polish pass.
 *
 * Replaces the old layout. The previous one placed each skin face at
 * `hashString(name|face) % span` inside a 32-wide band, so roughly three hundred faces
 * sampled the same scattered few pixels — the model read as one flat colour and the
 * "46% coverage" figure was really heavy overlap. This pass gives every face the
 * rectangle of its material island instead: no two islands overlap, faces share islands
 * only where that is deliberate (all teeth, all claws, all flank skin), and the side
 * islands carry the vertical gradient so shading still comes for free.
 *
 * The resolved rectangles are written to ai_context/uv_layout.json so the texture pass
 * paints exactly the pixels the UVs point at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { islandFor, layout } from './trex-design.mjs';

const FACES = ['north', 'south', 'east', 'west', 'up', 'down'];

export async function run(call, log, warn) {
  const workspace = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
  const atlases = layout();
  log(`atlas ${atlases.size}x${atlases.size}, ${Object.keys(atlases.rects).length} islands, ${Math.round(atlases.fill * 100)}% fill`);

  const live = await call('inspect_model', { include_cubes: true });
  const cubes = live?.cubes ?? [];
  if (!cubes.length) throw new Error('no cubes to lay out');

  // The layout may not fit in the current sheet; grow the project resolution to match.
  const project = (await call('inspect_project', {}))?.project ?? {};
  if (project.resolution?.width !== atlases.size || project.resolution?.height !== atlases.size) {
    await call('set_project_settings', { resolution: [atlases.size, atlases.size] });
    log(`project resolution -> ${atlases.size}x${atlases.size}`);
  }

  // Every face of every cube gets its island rectangle.
  const plan = [];
  const usage = new Map();
  for (const cube of cubes) {
    const faces = {};
    for (const face of FACES) {
      const island = islandFor(cube.name, face);
      const rect = atlases.rects[island];
      if (!rect) {
        warn(`no island "${island}" for ${cube.name}.${face}`);
        continue;
      }
      faces[face] = rect;
      usage.set(island, (usage.get(island) ?? 0) + 1);
    }
    plan.push({ name: cube.name, uuid: cube.uuid, faces });
  }

  await call('transaction_begin', { label: 'T-Rex polish: UV layout' });
  try {
    let applied = 0;
    for (const entry of plan) {
      await call('set_uv', {
        reference: entry.uuid ? { uuid: entry.uuid } : { name: entry.name },
        faces: entry.faces,
        autouv: 0,
        box_uv: false,
      });
      applied += 1;
    }
    await call('transaction_commit', {});
    log(`laid out ${applied} cubes`);
  } catch (error) {
    await call('transaction_abort', {}).catch(() => {});
    throw error;
  }

  // Audit the result the same way an artist would: overlap is the thing to prove is gone.
  const audit = auditLayout(plan, atlases.size);
  log(`audit: ${audit.faces} faces · ${audit.distinct_rects} distinct rects · ${audit.islands_shared} shared · ${audit.outOfBounds} outside the texture · ${audit.overlapping} overlapping · ${audit.coveragePct}% atlas coverage`);
  for (const clash of audit.overlaps) warn(`overlap: ${clash}`);
  for (const [island, count] of [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    log(`  shared island ${island.padEnd(11)} used by ${count} faces`);
  }

  const out = path.join(workspace, 'ai_context', 'uv_layout.json');
  fs.writeFileSync(out, `${JSON.stringify({ size: atlases.size, rects: atlases.rects, islands: plan, audit }, null, 2)}\n`);
  log(`wrote ${out}`);
  return audit;
}

/**
 * Verify the layout the way an artist would: no island may overlap another, no UV may
 * fall outside the texture, and faces may only share space deliberately.
 *
 * Overlapping *islands* is a bug; many faces pointing at one island is the intended
 * Minecraft-style sharing. The check below distinguishes the two by testing the
 * rectangles for intersection rather than counting face pixels.
 */
function auditLayout(plan, size) {
  const rects = new Map();
  let faces = 0;
  let outOfBounds = 0;
  const used = new Set();

  for (const entry of plan) {
    for (const [face, rect] of Object.entries(entry.faces)) {
      faces += 1;
      if (rect[0] < 0 || rect[1] < 0 || rect[2] > size || rect[3] > size) outOfBounds += 1;
      rects.set(`${entry.name}.${face}`, rect);
      for (let u = rect[0]; u < rect[2]; u += 1) {
        for (let v = rect[1]; v < rect[3]; v += 1) used.add(`${u},${v}`);
      }
    }
  }

  // Distinct rectangles only: identical rectangles are the deliberate sharing.
  const distinct = new Map();
  for (const [key, rect] of rects) {
    const id = rect.join(',');
    if (!distinct.has(id)) distinct.set(id, { rect, users: [] });
    distinct.get(id).users.push(key);
  }

  const overlaps = [];
  const list = [...distinct.values()];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [ax1, ay1, ax2, ay2] = list[i].rect;
      const [bx1, by1, bx2, by2] = list[j].rect;
      if (ax1 < bx2 && bx1 < ax2 && ay1 < by2 && by1 < ay2) {
        overlaps.push(`${list[i].users[0]} ∩ ${list[j].users[0]}`);
      }
    }
  }

  const shared = list.filter((entry) => entry.users.length > 1).map((entry) => entry.users[0]);
  return {
    faces,
    distinct_rects: list.length,
    islands_shared: shared.length,
    outOfBounds,
    overlapping: overlaps.length,
    overlaps: overlaps.slice(0, 10),
    coveragePct: Math.round((used.size / (size * size)) * 1000) / 10,
  };
}
