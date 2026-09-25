/**
 * Geometry polish pass.
 *
 * Applies the design's cube table to the live project: existing cubes are reshaped in
 * place (so uuids and animation references survive), missing ones are created, the new
 * neck segment is wired into the hierarchy and every moving pivot is re-asserted.
 *
 * Every reference is a uuid. The original build gave several bones and cubes the same
 * name (`left_lower_arm`, `left_foot`), so a name lookup matches two nodes and the tool
 * refuses with "ambiguous" — resolving by uuid sidesteps that entirely, and the design's
 * RENAMES table then removes the collisions from the asset itself.
 *
 * The anatomical intent behind the numbers:
 *   - hips and a pelvis crest, so the hind legs read as hanging off a powerful pelvis
 *     instead of a uniform tube;
 *   - a deeper, wider thigh with the femur tilted about its own hip, plus a knee block,
 *     which is what makes a cube leg read as a digitigrade limb rather than a column;
 *   - a belly and groin mass so the front view no longer shows a void between the legs;
 *   - a cheek and brow-horn mass on the skull, a wider mandible and more teeth, because
 *     the head is what makes the silhouette unmistakably a T-Rex;
 *   - a faster tail taper that ends taller than it is wide, the way a theropod tail is
 *     laterally compressed toward the tip;
 *   - claw tips on the toes;
 *   - a continuous dorsal ridge running from the hips onto the tail.
 */
import { CUBES, NEW_GROUPS, PIVOTS, RENAMES } from './trex-design.mjs';

export async function run(call, log, warn) {
  const bones = boneIndex(await call('inspect_hierarchy', {}));
  log(`live hierarchy: ${bones.size} bones`);

  // Resolve the ambiguous names first, otherwise every later lookup on them fails. The
  // rename has to go through the uuid, because the name being replaced is the ambiguous
  // one — and the bone keeps it, so the cube is the node that moves aside.
  const first = await call('inspect_model', { include_cubes: true });
  const cubesByName = new Map((first?.cubes ?? []).map((cube) => [cube.name, cube]));
  for (const [from, to] of Object.entries(RENAMES)) {
    const cube = cubesByName.get(from);
    if (!cube || cubesByName.has(to)) continue;
    await call('modify_node', { reference: { uuid: cube.uuid }, name: to });
    log(`renamed ${from} -> ${to} (a bone already owns that name)`);
  }

  const live = await call('inspect_model', { include_cubes: true });
  const existing = new Map((live?.cubes ?? []).map((cube) => [cube.name, cube]));
  log(`live model: ${existing.size} cubes`);

  const reshape = CUBES.filter((cube) => existing.has(cube.name));
  const create = CUBES.filter((cube) => !existing.has(cube.name));
  const describe = new Set(CUBES.map((cube) => cube.name));
  const stale = [...existing.keys()].filter((name) => !describe.has(name));
  if (stale.length) warn(`cubes the design does not describe are left untouched: ${stale.join(', ')}`);

  await call('transaction_begin', { label: 'T-Rex polish: geometry' });
  try {
    for (const [name, pivot, parent] of NEW_GROUPS) {
      if (bones.has(name)) continue;
      await call('create_group', { name, origin: pivot, parent: { name: parent } });
      log(`created bone ${name}`);
    }

    // `modify_node` applies one set of values to every reference, so reshaping each cube
    // to its own dimensions has to be a loop.
    let reshaped = 0;
    for (const cube of reshape) {
      const before = existing.get(cube.name);
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (
        same(before.from, cube.from) &&
        same(before.to, cube.to) &&
        same(before.origin, cube.origin) &&
        same(before.rotation, cube.rotation)
      ) {
        continue;
      }
      await call('modify_node', {
        reference: { uuid: before.uuid },
        from: cube.from,
        to: cube.to,
        ...(cube.origin ? { origin: cube.origin } : {}),
        ...(cube.rotation ? { rotation: cube.rotation } : { rotation: [0, 0, 0] }),
      });
      reshaped += 1;
    }
    log(`reshaped ${reshaped} cubes`);

    if (create.length) {
      const payload = create.map((cube) => ({
        name: cube.name,
        from: cube.from,
        to: cube.to,
        // bulk_create_cubes takes the parent as a plain group name.
        parent: cube.parent,
        ...(cube.origin ? { origin: cube.origin } : {}),
        ...(cube.rotation ? { rotation: cube.rotation } : {}),
      }));
      await call('bulk_create_cubes', { cubes: payload });
      log(`asked for ${payload.length} new cubes`);
    }

    // The new neck segment has to carry the head, otherwise it is decoration.
    const head = bones.get('head');
    const neck03 = bones.get('neck_03') ?? boneIndex(await call('inspect_hierarchy', {})).get('neck_03');
    if (head && neck03) {
      const parented = await call('parent_object', { reference: { uuid: head }, parent: { uuid: neck03 } });
      if (parented?.parent !== 'neck_03') warn(`head ended up under "${parented?.parent}" instead of neck_03`);
      else log('reparented head under the new neck_03 segment');
    }

    const refreshed = boneIndex(await call('inspect_hierarchy', {}));
    let pivots = 0;
    for (const [name, pivot] of Object.entries(PIVOTS)) {
      const uuid = refreshed.get(name);
      if (!uuid) {
        warn(`no bone named ${name} — pivot skipped`);
        continue;
      }
      await call('set_pivot', { reference: { uuid }, pivot });
      pivots += 1;
    }
    log(`set ${pivots} pivots`);

    await call('transaction_commit', {});
  } catch (error) {
    await call('transaction_abort', {}).catch(() => {});
    throw error;
  }

  const after = await call('inspect_model', { include_cubes: true });
  const bounds = after?.bounding_box;
  const names = (after?.cubes ?? []).map((cube) => cube.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) warn(`duplicate cube names after the pass: ${[...new Set(duplicates)].join(', ')}`);
  const missing = CUBES.filter((cube) => !names.includes(cube.name)).map((cube) => cube.name);
  if (missing.length) warn(`design cubes missing from the project: ${missing.join(', ')}`);
  log(
    `now ${after?.cube_count} cubes (asked for ${CUBES.length}), volume ${after?.total_volume}, ` +
      `bounds ${bounds ? `min[${bounds.min}] max[${bounds.max}]` : '?'}`,
  );
  return { before: existing.size, after: after?.cube_count, duplicates, missing };
}

/** name -> uuid for every group in an inspect_hierarchy response. */
function boneIndex(hierarchy) {
  const index = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'group' && typeof node.name === 'string') index.set(node.name, node.uuid);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(hierarchy);
  return index;
}
