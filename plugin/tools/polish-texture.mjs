/**
 * Texture polish pass.
 *
 * Paints the island atlas from the design and swaps it in for the project's existing
 * skin texture. The cube faces keep pointing at the same texture *name*, so nothing
 * needs re-assigning: the new image is uploaded under the existing texture's identity
 * and the old one is only deleted once every face resolves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAtlas, layout } from './trex-design.mjs';

export async function run(call, log, warn) {
  const workspace = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
  const layoutFile = path.join(workspace, 'ai_context', 'uv_layout.json');

  // Paint against the same rectangles the UV pass used. If the layout file is missing
  // the atlas is regenerated deterministically, which produces identical rectangles.
  let rects;
  let size;
  if (fs.existsSync(layoutFile)) {
    const saved = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    rects = saved.rects;
    size = saved.size;
    log(`using layout from ${path.basename(layoutFile)} (${size}x${size})`);
  } else {
    const fresh = layout();
    rects = fresh.rects;
    size = fresh.size;
    warn('uv_layout.json not found — regenerated the same deterministic layout');
  }

  const atlas = buildAtlas();
  const png = atlas.png;
  log(`painted atlas ${atlas.size}x${atlas.size}, ${png.length} bytes, ${Math.round(atlas.fill * 100)}% island fill`);

  const models = await call('inspect_textures', {});
  const names = collectTextureNames(models);
  log(`project textures: ${names.length ? names.join(', ') : '(none)'}`);

  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const created = await call('create_texture', {
    name: 'trex_skin_polished',
    data_url: dataUrl,
    width: size,
    height: size,
    select: true,
  });
  // `assign_texture` resolves a bare string as a texture *name* (only NodeReference
  // accepts a uuid), so address it by name.
  const name = created?.name ?? created?.texture?.name ?? 'trex_skin_polished';
  log(`uploaded texture "${name}"`);

  // Point every cube at the new image, then retire the old texture. The order matters:
  // assigning first means no face is ever left without a texture.
  const live = await call('inspect_model', { include_cubes: true });
  const cubes = live?.cubes ?? [];
  const roots = [...new Set(cubes.map((cube) => cube.parent).filter(Boolean))];
  if (roots.length) {
    const assigned = await call('assign_texture', {
      texture: name,
      references: roots.map((bone) => ({ name: bone })),
    });
    const count = assigned?.assigned_faces ?? assigned?.faces ?? assigned?.count;
    log(`reassigned faces under ${roots.length} bones${count !== undefined ? ` (${count} faces)` : ''}`);
    if (assigned?.unresolved?.length) warn(`unresolved bones: ${assigned.unresolved.join(', ')}`);
  }

  const leftover = await call('inspect_textures', {});
  const remaining = collectTextureNames(leftover).filter((name) => name !== 'trex_skin_polished');
  for (const name of remaining) {
    try {
      await call('delete_texture', { texture: name, confirm: true });
      log(`removed the superseded texture "${name}"`);
    } catch (error) {
      warn(`could not remove old texture "${name}": ${error.message}`);
    }
  }

  const check = await call('inspect_model', {});
  if (check?.cubes_without_texture) warn(`${check.cubes_without_texture} cubes have no texture`);
  return { size, bytes: png.length, replaced: remaining };
}

/** inspect_textures has changed shape before; read names out of any of its forms. */
function collectTextureNames(payload) {
  const found = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.name === 'string' && value.name) found.push(value.name);
      else if (typeof value.texture === 'string') found.push(value.texture);
    }
  };
  if (Array.isArray(payload?.textures)) visit(payload.textures);
  else if (Array.isArray(payload)) visit(payload);
  else if (payload?.textures) visit(payload.textures);
  return [...new Set(found)];
}
