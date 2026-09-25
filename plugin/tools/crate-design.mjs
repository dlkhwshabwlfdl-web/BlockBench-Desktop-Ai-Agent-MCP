/**
 * Legendary Crate — design source of truth.
 *
 * Coordinates follow the project's convention: the crate faces +Z, Y is up and
 * y=0 is the ground plane. The model's LEFT is +X.
 *
 * The look is an original design grown from the shared vocabulary of the reference
 * images (palette sampled straight off the JPGs): an obsidian / black-violet body with
 * vertical plank paneling, a heavy engraved gold frame with orange-tinted shading, a
 * large central gold lock plaque with a keyhole, gold cross strips over the lid, corner
 * brackets, and a dark plinth. The magical layer is the reference's signature violet
 * (#e657fe) carried by crystals, conduits and the interior core.
 *
 * Nothing here is a recoloured vanilla chest: the crate is hollow, ~21 units square so
 * it reads as bigger than a chest, framed by free-standing gold posts, and its interior
 * core is only revealed when the lid opens.
 */
import { PNG } from 'pngjs';

/* ------------------------------------------------------------------ palette */

/**
 * Colours sampled from the three reference JPGs (see ai_context/palette/refs.html).
 * `gold_base`, `gold_bright`, `gold_orange` and `magic_glow` are taken directly from the
 * references; the ramps around them are interpolated so shading stays in family.
 */
export const PALETTE = {
  // obsidian body — the reference's #23182c / #2e194b / #392556 / #482f50 / #553165
  obsidian_deep: '#120d1a',
  obsidian_dark: '#1b1425',
  obsidian_base: '#23182c',
  obsidian_mid: '#2e194b',
  obsidian_lit: '#392556',
  obsidian_high: '#482f50',
  violet_soft: '#553165',
  violet_rim: '#6b4a85',
  // gold — reference brights #f9d110 / #f0d12e / #fae548 / #f9ee8c, shades #ad722f / #8c522a
  gold_shadow: '#4a2b12',
  gold_deep: '#7a461a',
  gold_dark: '#ad722f',
  gold_mid: '#c78d37',
  gold_base: '#f0d12e',
  gold_bright: '#f9d110',
  gold_hot: '#fae548',
  gold_tip: '#f9ee8c',
  gold_orange: '#f6b64c',
  // magic — the reference's signature #e657fe with its own ramp
  magic_deep: '#4a1578',
  magic_mid: '#9730b3',
  magic_base: '#c24ce0',
  magic_glow: '#e657fe',
  magic_hot: '#f8d5ff',
  magic_white: '#fcf5fc',
  // recesses — reference #150c09 / #1d172b
  void_dark: '#150c09',
  void_purple: '#1d172b',
};

/* ----------------------------------------------------------------- geometry */

/**
 * The outliner. `pivot` is where each bone rotates from — picked so every animated part
 * turns about a physically sensible hinge (the lid about its back edge, the lock about
 * the face it sits on, crystals about their sockets).
 */
export const GROUPS = [
  { name: 'LegendaryCrate', parent: null, pivot: [0, 0, 0] },

  { name: 'Base', parent: 'LegendaryCrate', pivot: [0, 1.6, 0] },
  { name: 'BottomFrame', parent: 'LegendaryCrate', pivot: [0, 1.6, 0] },
  { name: 'Body', parent: 'LegendaryCrate', pivot: [0, 10.5, 0] },
  { name: 'CornerPosts', parent: 'LegendaryCrate', pivot: [0, 10.5, 0] },
  { name: 'FrontFrame', parent: 'LegendaryCrate', pivot: [0, 10.5, 10.5] },
  { name: 'BackFrame', parent: 'LegendaryCrate', pivot: [0, 10.5, -10.5] },
  { name: 'LeftFrame', parent: 'LegendaryCrate', pivot: [10.5, 10.5, 0] },
  { name: 'RightFrame', parent: 'LegendaryCrate', pivot: [-10.5, 10.5, 0] },

  { name: 'Lid', parent: 'LegendaryCrate', pivot: [0, 17, -11.5] },
  { name: 'LidMain', parent: 'Lid', pivot: [0, 17, -11.5] },
  { name: 'LidFrame', parent: 'Lid', pivot: [0, 17, -11.5] },
  { name: 'LidSeparator', parent: 'Lid', pivot: [0, 17, -11.5] },
  { name: 'LidDecoration', parent: 'Lid', pivot: [0, 17, -11.5] },

  { name: 'Lock', parent: 'LegendaryCrate', pivot: [0, 13.6, 11.8] },
  { name: 'LockFrame', parent: 'Lock', pivot: [0, 13.6, 11.8] },
  { name: 'LockCore', parent: 'Lock', pivot: [0, 13.6, 13.1] },
  { name: 'LockGlow', parent: 'Lock', pivot: [0, 13.6, 12.7] },

  { name: 'LeftCrystal', parent: 'LegendaryCrate', pivot: [12.1, 12.6, 4.4] },
  { name: 'RightCrystal', parent: 'LegendaryCrate', pivot: [-12.1, 12.6, 4.4] },
  // Mounted on the lid, not the crate: it sits on the lid's top face, so parenting it to
  // the root would leave it hanging in mid-air the moment the lid swung open.
  { name: 'TopCrystal', parent: 'Lid', pivot: [0, 19.4, 0] },

  { name: 'MagicCore', parent: 'LegendaryCrate', pivot: [0, 11, 0] },
  // The halos get their own bone so they can wind up while the core itself only pulses —
  // the difference between "a thing that spins" and "a machine that charges".
  { name: 'CoreHalo', parent: 'MagicCore', pivot: [0, 11, 0] },
  { name: 'EnergyDetails', parent: 'LegendaryCrate', pivot: [0, 11, 0] },
];

/** Every bone name, so animation tracks can be validated before they are sent. */
export const BONE_NAMES = GROUPS.map((g) => g.name);

/**
 * The cube table. `from`/`to` are Blockbench's min/max corners. `group` names the parent
 * bone. `material` is the atlas island the cube samples by default; `faceMaterials`
 * overrides individual faces (how the hollow interior gets its own dark lining).
 */
const RAW = [
  /* ---- Base: plinth + gold rim + feet ------------------------------------ */
  { name: 'base_plinth', group: 'Base', from: [-11.6, 1.6, -11.6], to: [11.6, 4.0, 11.6], material: 'darkmetal' },
  { name: 'base_rim_front', group: 'Base', from: [-11.6, 3.5, 11.1], to: [11.6, 4.4, 12.1], material: 'band' },
  { name: 'base_rim_back', group: 'Base', from: [-11.6, 3.5, -12.1], to: [11.6, 4.4, -11.1], material: 'band' },
  { name: 'base_rim_left', group: 'Base', from: [11.1, 3.5, -11.1], to: [12.1, 4.4, 11.1], material: 'band' },
  { name: 'base_rim_right', group: 'Base', from: [-12.1, 3.5, -11.1], to: [-11.1, 4.4, 11.1], material: 'band' },
  { name: 'foot_fl', group: 'Base', from: [7.9, 0.0, 7.9], to: [11.3, 1.6, 11.3], material: 'darkmetal' },
  { name: 'foot_fr', group: 'Base', from: [7.9, 0.0, -11.3], to: [11.3, 1.6, -7.9], material: 'darkmetal' },
  { name: 'foot_bl', group: 'Base', from: [-11.3, 0.0, 7.9], to: [-7.9, 1.6, 11.3], material: 'darkmetal' },
  { name: 'foot_br', group: 'Base', from: [-11.3, 0.0, -11.3], to: [-7.9, 1.6, -7.9], material: 'darkmetal' },

  /* ---- BottomFrame: the underside nobody expects to be interesting ------- */
  // `down` uses the inlaid-grid island: it is the one face a player sees from below.
  { name: 'bottom_boss', group: 'BottomFrame', from: [-4.2, 1.1, -4.2], to: [4.2, 1.75, 4.2], material: 'darkmetal', faceMaterials: { down: 'floor' } },
  { name: 'bottom_rib_x', group: 'BottomFrame', from: [-9.8, 1.2, -0.9], to: [9.8, 1.7, 0.9], material: 'band' },
  { name: 'bottom_rib_z', group: 'BottomFrame', from: [-0.9, 1.2, -9.8], to: [0.9, 1.7, 9.8], material: 'band' },
  { name: 'bottom_gem', group: 'BottomFrame', from: [-1.9, 0.95, -1.9], to: [1.9, 1.6, 1.9], material: 'gem' },

  /* ---- Body: hollow shell so the core is real, not painted --------------- */
  { name: 'body_front', group: 'Body', from: [-10.5, 4.0, 9.4], to: [10.5, 17.0, 10.5], material: 'wall', faceMaterials: { south: 'interior' } },
  { name: 'body_back', group: 'Body', from: [-10.5, 4.0, -10.5], to: [10.5, 17.0, -9.4], material: 'wall', faceMaterials: { north: 'interior' } },
  { name: 'body_left', group: 'Body', from: [9.4, 4.0, -9.4], to: [10.5, 17.0, 9.4], material: 'wall', faceMaterials: { west: 'interior' } },
  { name: 'body_right', group: 'Body', from: [-10.5, 4.0, -9.4], to: [-9.4, 17.0, 9.4], material: 'wall', faceMaterials: { east: 'interior' } },
  { name: 'body_floor', group: 'Body', from: [-9.4, 4.0, -9.4], to: [9.4, 5.7, 9.4], material: 'wall', faceMaterials: { up: 'interior' } },
  { name: 'body_shelf', group: 'Body', from: [-9.4, 5.7, -9.4], to: [9.4, 6.4, 9.4], material: 'interior' },
];

/** Vertical plank paneling on all four faces — the reference's signature body read. */
const PLANK_X = [-8.1, -2.7, 2.7, 8.1];
for (const [i, cx] of PLANK_X.entries()) {
  RAW.push({ name: `plank_front_${i}`, group: 'Body', from: [cx - 1.8, 5.0, 10.5], to: [cx + 1.8, 15.4, 11.3], material: 'plank' });
  RAW.push({ name: `plank_back_${i}`, group: 'Body', from: [cx - 1.8, 5.0, -11.3], to: [cx + 1.8, 15.4, -10.5], material: 'plank' });
  RAW.push({ name: `plank_left_${i}`, group: 'Body', from: [10.5, 5.0, cx - 1.8], to: [11.3, 15.4, cx + 1.8], material: 'plank' });
  RAW.push({ name: `plank_right_${i}`, group: 'Body', from: [-11.3, 5.0, cx - 1.8], to: [-10.5, 15.4, cx + 1.8], material: 'plank' });
}

/**
 * Side-face trim: gold mullions dropped into the gaps between planks, plus a raised
 * medallion. The front face is carried by the lock and the back by its plaque, so the
 * sides need a framed panel of their own. Measured on the first capture they were only
 * 4.7% gold against the front's 28.9% — the frame read as a bare dark slab.
 *
 * Mullion centres sit on the plank gaps (±5.4 between planks, 0 on the centre seam),
 * so they land as separators rather than covering the panelling.
 */
const SIDE_MULLIONS = [
  { z: 5.4, w: 1.4 },
  { z: 0.0, w: 1.6 },
  { z: -5.4, w: 1.4 },
];
// Every box is listed as an explicit [min, max] pair per side. Mirroring X by negating a
// single coordinate reads fine but silently produces an inverted or width-mismatched box
// on one side, so the two sides are spelled out instead of derived.
const SIDES = [
  { side: 'left', grp: 'LeftFrame', strap: [10.5, 11.5], plaque: [10.5, 11.7] },
  { side: 'right', grp: 'RightFrame', strap: [-11.5, -10.5], plaque: [-11.7, -10.5] },
];
for (const s of SIDES) {
  for (const [i, m] of SIDE_MULLIONS.entries()) {
    RAW.push({
      name: `strap_${s.side}_${i}`,
      group: s.grp,
      from: [s.strap[0], 4.6, m.z - m.w / 2],
      to: [s.strap[1], 16.5, m.z + m.w / 2],
      material: 'band',
    });
  }
  RAW.push({
    name: `plaque_${s.side}`,
    group: s.grp,
    from: [s.plaque[0], 9.4, -2.6],
    to: [s.plaque[1], 14.0, 2.6],
    material: 'engraved',
  });
}

RAW.push(
  /* ---- CornerPosts: free-standing gold bracing --------------------------- */
  { name: 'post_fl', group: 'CornerPosts', from: [7.9, 4.2, 7.9], to: [11.2, 17.0, 11.2], material: 'post' },
  { name: 'post_fr', group: 'CornerPosts', from: [7.9, 4.2, -11.2], to: [11.2, 17.0, -7.9], material: 'post' },
  { name: 'post_bl', group: 'CornerPosts', from: [-11.2, 4.2, 7.9], to: [-7.9, 17.0, 11.2], material: 'post' },
  { name: 'post_br', group: 'CornerPosts', from: [-11.2, 4.2, -11.2], to: [-7.9, 17.0, -7.9], material: 'post' },
  { name: 'plate_fl', group: 'CornerPosts', from: [8.1, 9.4, 8.1], to: [11.6, 12.6, 11.6], material: 'engraved' },
  { name: 'plate_fr', group: 'CornerPosts', from: [8.1, 9.4, -11.6], to: [11.6, 12.6, -8.1], material: 'engraved' },
  { name: 'plate_bl', group: 'CornerPosts', from: [-11.6, 9.4, 8.1], to: [-8.1, 12.6, 11.6], material: 'engraved' },
  { name: 'plate_br', group: 'CornerPosts', from: [-11.6, 9.4, -11.6], to: [-8.1, 12.6, -8.1], material: 'engraved' },

  /* ---- FrontFrame: gold bands + the dark plaque the lock sits on --------- */
  { name: 'frame_front_bottom', group: 'FrontFrame', from: [-8.0, 4.1, 10.5], to: [8.0, 5.0, 11.35], material: 'band' },
  { name: 'frame_front_top', group: 'FrontFrame', from: [-8.0, 15.4, 10.5], to: [8.0, 17.0, 11.35], material: 'band' },
  { name: 'front_plaque_dark', group: 'FrontFrame', from: [-6.6, 11.0, 11.35], to: [6.6, 16.5, 11.75], material: 'interior', faceMaterials: { north: 'interior' } },

  { name: 'frame_back_bottom', group: 'BackFrame', from: [-8.0, 4.1, -11.35], to: [8.0, 5.0, -10.5], material: 'band' },
  { name: 'frame_back_top', group: 'BackFrame', from: [-8.0, 15.4, -11.35], to: [8.0, 17.0, -10.5], material: 'band' },
  { name: 'frame_back_plaque', group: 'BackFrame', from: [-5.0, 9.4, -11.7], to: [5.0, 14.0, -11.35], material: 'engraved' },

  { name: 'frame_left_bottom', group: 'LeftFrame', from: [10.5, 4.1, -8.0], to: [11.35, 5.0, 8.0], material: 'band' },
  { name: 'frame_left_top', group: 'LeftFrame', from: [10.5, 15.4, -8.0], to: [11.35, 17.0, 8.0], material: 'band' },

  { name: 'frame_right_bottom', group: 'RightFrame', from: [-11.35, 4.1, -8.0], to: [-10.5, 5.0, 8.0], material: 'band' },
  { name: 'frame_right_top', group: 'RightFrame', from: [-11.35, 15.4, -8.0], to: [-10.5, 17.0, 8.0], material: 'band' },

  /* ---- Lid: hinged slab, gold bands, cross separator, emblem ------------- */
  // `darkmetal`, not `wall`: the lid's top face is the largest surface any 3/4 or top
  // view shows, and the wall's flat near-black reads as an empty void up there.
  { name: 'lid_core', group: 'LidMain', from: [-11.5, 17.0, -11.5], to: [11.5, 19.4, 11.5], material: 'darkmetal', faceMaterials: { down: 'interior' } },
  { name: 'lid_inset', group: 'LidMain', from: [-9.6, 16.6, -9.6], to: [9.6, 17.1, 9.6], material: 'interior' },

  { name: 'lid_band_front', group: 'LidFrame', from: [-11.5, 19.3, 10.2], to: [11.5, 20.0, 11.5], material: 'band' },
  { name: 'lid_band_back', group: 'LidFrame', from: [-11.5, 19.3, -11.5], to: [11.5, 20.0, -10.2], material: 'band' },
  { name: 'lid_band_left', group: 'LidFrame', from: [10.2, 19.3, -10.2], to: [11.5, 20.0, 10.2], material: 'band' },
  { name: 'lid_band_right', group: 'LidFrame', from: [-11.5, 19.3, -10.2], to: [-10.2, 20.0, 10.2], material: 'band' },

  // The cross stops short of the centre, leaving a socket the top crystal sits in.
  // Four pieces instead of two, because one bar across the lid would run straight
  // through that socket.
  { name: 'lid_separator_x_l', group: 'LidSeparator', from: [2.9, 19.35, -0.75], to: [11.5, 20.05, 0.75], material: 'band' },
  { name: 'lid_separator_x_r', group: 'LidSeparator', from: [-11.5, 19.35, -0.75], to: [-2.9, 20.05, 0.75], material: 'band' },
  { name: 'lid_separator_z_f', group: 'LidSeparator', from: [-0.75, 19.35, 2.9], to: [0.75, 20.05, 10.2], material: 'band' },
  { name: 'lid_separator_z_b', group: 'LidSeparator', from: [-0.75, 19.35, -10.2], to: [0.75, 20.05, -2.9], material: 'band' },

  // A diamond plaque on the lid's front quadrants, with a smaller diamond gem inset
  { name: 'lid_emblem', group: 'LidDecoration', from: [-3.4, 19.3, 4.1], to: [3.4, 20.15, 7.5], origin: [0, 19.72, 5.8], rotation: [0, 45, 0], material: 'engraved' },
  { name: 'lid_emblem_gem', group: 'LidDecoration', from: [-1.5, 20.15, 4.3], to: [1.5, 20.95, 7.3], origin: [0, 20.55, 5.8], rotation: [0, 45, 0], material: 'gem' },
  { name: 'lid_stud_fl', group: 'LidDecoration', from: [8.6, 19.4, 8.6], to: [10.6, 20.35, 10.6], material: 'stud' },
  { name: 'lid_stud_fr', group: 'LidDecoration', from: [8.6, 19.4, -10.6], to: [10.6, 20.35, -8.6], material: 'stud' },
  { name: 'lid_stud_bl', group: 'LidDecoration', from: [-10.6, 19.4, 8.6], to: [-8.6, 20.35, 10.6], material: 'stud' },
  { name: 'lid_stud_br', group: 'LidDecoration', from: [-10.6, 19.4, -10.6], to: [-8.6, 20.35, -8.6], material: 'stud' },

  /* ---- Lock: the big central gold plaque -------------------------------- */
  { name: 'lock_plate', group: 'LockFrame', from: [-5.2, 11.2, 11.6], to: [5.2, 16.2, 12.6], material: 'plate' },
  { name: 'lock_bezel_top', group: 'LockFrame', from: [-4.2, 15.4, 12.6], to: [4.2, 16.4, 13.15], material: 'band' },
  { name: 'lock_bezel_bottom', group: 'LockFrame', from: [-4.2, 11.0, 12.6], to: [4.2, 12.0, 13.15], material: 'band' },
  { name: 'lock_wing_l', group: 'LockFrame', from: [3.6, 12.4, 12.6], to: [5.4, 15.0, 13.0], material: 'engraved' },
  { name: 'lock_wing_r', group: 'LockFrame', from: [-5.4, 12.4, 12.6], to: [-3.6, 15.0, 13.0], material: 'engraved' },

  { name: 'lock_core', group: 'LockCore', from: [-2.8, 12.2, 12.6], to: [2.8, 15.2, 13.2], material: 'keyhole' },
  { name: 'lock_ring', group: 'LockCore', from: [-3.4, 12.0, 13.2], to: [3.4, 15.4, 13.5], material: 'keyhole' },
  { name: 'keyhole_slot', group: 'LockCore', from: [-0.75, 12.5, 13.5], to: [0.75, 14.1, 13.8], material: 'gem' },
  { name: 'keyhole_round', group: 'LockCore', from: [-1.35, 13.8, 13.5], to: [1.35, 14.9, 13.8], material: 'gem' },

  { name: 'lock_glow_bar', group: 'LockGlow', from: [-4.6, 10.6, 12.6], to: [4.6, 11.0, 12.9], material: 'conduit' },
  { name: 'lock_glow_l', group: 'LockGlow', from: [-6.2, 13.6, 12.2], to: [-5.4, 14.4, 12.7], material: 'gem' },
  { name: 'lock_glow_r', group: 'LockGlow', from: [5.4, 13.6, 12.2], to: [6.2, 14.4, 12.7], material: 'gem' },

  /* ---- Crystals: sockets mounted on the side frames --------------------- */
  { name: 'crystal_L_socket', group: 'LeftCrystal', from: [11.0, 11.0, 3.0], to: [12.9, 12.6, 5.8], material: 'post' },
  { name: 'crystal_L_shard_a', group: 'LeftCrystal', from: [11.4, 12.6, 3.6], to: [12.7, 16.4, 5.2], material: 'crystal' },
  { name: 'crystal_L_shard_b', group: 'LeftCrystal', from: [12.2, 12.4, 4.5], to: [13.2, 14.8, 5.9], material: 'crystal' },
  { name: 'crystal_R_socket', group: 'RightCrystal', from: [-12.9, 11.0, 3.0], to: [-11.0, 12.6, 5.8], material: 'post' },
  { name: 'crystal_R_shard_a', group: 'RightCrystal', from: [-12.7, 12.6, 3.6], to: [-11.4, 16.4, 5.2], material: 'crystal' },
  { name: 'crystal_R_shard_b', group: 'RightCrystal', from: [-13.2, 12.4, 4.5], to: [-12.2, 14.8, 5.9], material: 'crystal' },
  { name: 'crystal_T_socket', group: 'TopCrystal', from: [-2.3, 19.3, -2.3], to: [2.3, 20.6, 2.3], material: 'post' },
  { name: 'crystal_T_shard', group: 'TopCrystal', from: [-1.5, 20.6, -1.5], to: [1.5, 24.6, 1.5], material: 'crystal' },

  /* ---- MagicCore: floats in the cavity, only seen when the lid opens ----- */
  { name: 'core_gem', group: 'MagicCore', from: [-3.3, 7.6, -3.3], to: [3.3, 14.6, 3.3], material: 'core' },
  { name: 'core_halo_x', group: 'CoreHalo', from: [-4.9, 10.3, -0.55], to: [4.9, 11.7, 0.55], material: 'conduit' },
  { name: 'core_halo_z', group: 'CoreHalo', from: [-0.55, 10.3, -4.9], to: [0.55, 11.7, 4.9], material: 'conduit' },

  /* ---- EnergyDetails: conduits up the frame + drifting shards ----------- */
  { name: 'conduit_front_l', group: 'EnergyDetails', from: [5.2, 5.2, 11.35], to: [6.4, 15.2, 11.75], material: 'conduit' },
  { name: 'conduit_front_r', group: 'EnergyDetails', from: [-6.4, 5.2, 11.35], to: [-5.2, 15.2, 11.75], material: 'conduit' },
  { name: 'conduit_back_l', group: 'EnergyDetails', from: [5.2, 5.2, -11.75], to: [6.4, 15.2, -11.35], material: 'conduit' },
  { name: 'conduit_back_r', group: 'EnergyDetails', from: [-6.4, 5.2, -11.75], to: [-5.2, 15.2, -11.35], material: 'conduit' },
  // One either side of each side medallion, so the flanking spacing stays symmetric
  { name: 'conduit_left_f', group: 'EnergyDetails', from: [11.35, 8.4, 3.2], to: [11.75, 14.4, 4.4], material: 'conduit' },
  { name: 'conduit_left_b', group: 'EnergyDetails', from: [11.35, 8.4, -4.4], to: [11.75, 14.4, -3.2], material: 'conduit' },
  { name: 'conduit_right_f', group: 'EnergyDetails', from: [-11.75, 8.4, 3.2], to: [-11.35, 14.4, 4.4], material: 'conduit' },
  { name: 'conduit_right_b', group: 'EnergyDetails', from: [-11.75, 8.4, -4.4], to: [-11.35, 14.4, -3.2], material: 'conduit' },
  { name: 'node_l_hi', group: 'EnergyDetails', from: [12.5, 13.4, 7.0], to: [13.6, 14.8, 8.4], material: 'gem' },
  { name: 'node_l_lo', group: 'EnergyDetails', from: [12.5, 9.2, 1.0], to: [13.6, 10.6, 2.4], material: 'gem' },
  { name: 'node_r_hi', group: 'EnergyDetails', from: [-13.6, 13.4, 7.0], to: [-12.5, 14.8, 8.4], material: 'gem' },
  { name: 'node_r_lo', group: 'EnergyDetails', from: [-13.6, 9.2, 1.0], to: [-12.5, 10.6, 2.4], material: 'gem' },
);

export const CUBES = RAW;

/** Faces every cube gets, unless `faceMaterials` says otherwise. */
export const FACES = ['north', 'east', 'south', 'west', 'up', 'down'];

/* -------------------------------------------------------------------- atlas */

/**
 * Island sizes, in atlas pixels. Roughly proportional to the faces that sample them:
 * planks and posts are tall, gold bands are wide and short, the plate is the biggest
 * single feature because the lock is the crate's focal point.
 */
export const ISLAND_DEFS = {
  plank: { w: 16, h: 40 },
  post: { w: 16, h: 40 },
  band: { w: 44, h: 10 },
  plate: { w: 36, h: 22 },
  wall: { w: 32, h: 24 },
  floor: { w: 30, h: 30 },
  engraved: { w: 30, h: 30 },
  core: { w: 26, h: 26 },
  darkmetal: { w: 24, h: 24 },
  conduit: { w: 8, h: 30 },
  interior: { w: 20, h: 20 },
  crystal: { w: 18, h: 26 },
  keyhole: { w: 14, h: 20 },
  gem: { w: 12, h: 12 },
  stud: { w: 10, h: 10 },
};

/** Shelf-pack the islands. Sorted by height so shelves stay tight. */
export function layout(size = 128) {
  const items = Object.entries(ISLAND_DEFS)
    .map(([name, d]) => ({ name, w: d.w, h: d.h }))
    .sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  const rects = {};
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const item of items) {
    if (x + item.w > size) {
      x = 0;
      y += shelf + 1;
      shelf = 0;
    }
    if (y + item.h > size) throw new Error(`atlas islands do not fit in ${size}px (ran out at "${item.name}")`);
    rects[item.name] = [x, y, x + item.w, y + item.h];
    x += item.w + 1;
    if (item.h > shelf) shelf = item.h;
  }
  const area = items.reduce((sum, i) => sum + i.w * i.h, 0);
  return { rects, size, used_height: y + shelf, fill: Math.round((area / (size * size)) * 1000) / 1000 };
}

/** Faces that face the hollow inside get the dark lining instead of the material. */
export function islandFor(cube, face) {
  const override = cube.faceMaterials?.[face];
  if (override) return override;
  return cube.material ?? 'wall';
}

/** FNV-1a based 0..1 hash, so per-cube variation is stable between runs. */
export function hash01(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Pixel UV rectangle for one cube face.
 *
 * Each face stretches its island across the whole face, which is what gives a voxel
 * asset its clean readable materials. To stop same-material cubes from looking
 * copy-pasted, the window is nudged by a deterministic per-cube hash: up to three
 * pixels of vertical slide and a horizontal mirror for roughly half the cubes. The
 * bands and plates gain their rivet spacing from cube width that way.
 */
export function uvFor(cube, face, rects) {
  const island = islandFor(cube, face);
  const r = rects[island];
  if (!r) throw new Error(`no atlas rect for island "${island}" (cube ${cube.name}, face ${face})`);
  const h = hash01(`${cube.name}:${face}`);
  const slide = Math.floor(h * 4); // 0..3 px
  const [u1, v1, u2, v2] = r;
  const width = u2 - u1;
  const height = v2 - v1;
  if (face === 'up' || face === 'down' || width > height) {
    // wide faces: slide horizontally so rivets land differently per cube
    const shift = Math.min(slide, Math.max(0, width - 4));
    return [u1 + shift, v1, u2, Math.max(v1 + 2, v2 - shift)];
  }
  const usable = Math.max(2, height - slide);
  const mirrored = h > 0.5;
  return mirrored ? [u1, v1 + slide, u2, v1 + slide + usable] : [u1, v1, u2, v1 + usable];
}

/* ------------------------------------------------------------------ texture */

const rgb = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

const hexOf = (c) =>
  `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Paint the atlas. Every island is drawn as a material patch, in atlas space. */
export function paintAtlas(rects, size) {
  const png = new PNG({ width: size, height: size });
  const px = png.data;
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = Math.max(0, Math.min(255, Math.round(c[0])));
    px[i + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
    px[i + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
    px[i + 3] = 255;
  };

  /** Deterministic +/- noise, so the texture is grainy but never random. */
  const grain = (x, y, seed, amount) => {
    let h = 2166136261;
    const key = `${seed}:${x}:${y}`;
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const n = ((h >>> 0) % 2000) / 1000 - 1;
    return n * amount;
  };

  const each = (island, fn) => {
    const r = rects[island];
    if (!r) return;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    for (let y = r[1]; y < r[3]; y += 1) {
      for (let x = r[0]; x < r[2]; x += 1) {
        fn(x, y, (x - r[0] + 0.5) / w, (y - r[1] + 0.5) / h, r);
      }
    }
  };

  /* -- obsidian wall: quiet, slightly mottled, faint horizontal courses ---- */
  each('wall', (x, y, u, v) => {
    const mottle = Math.sin(u * 9.1) * Math.cos(v * 7.3) * 0.5 + 0.5;
    const course = Math.floor(v * 8) % 2 === 0 ? 0 : -4;
    // The wall is deliberately the darkest, flattest material in the palette: the planks
    // stand proud of it, so its only job is to be the shadow they read against. Mixing
    // deeper here (rather than simply darkening at the end) keeps it flat, not muddy.
    let c = mix(rgb(PALETTE.obsidian_deep), rgb(PALETTE.obsidian_base), 0.3 + mottle * 0.34);
    c = mix(c, rgb(PALETTE.void_dark), Math.max(0, v - 0.72) * 1.4);
    const edge = u < 0.05 || u > 0.95 || v < 0.04 || v > 0.96;
    c = edge ? mix(c, rgb(PALETTE.obsidian_deep), 0.45) : c;
    const n = grain(x, y, 'wall', 9) + course;
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- obsidian plank: vertical grain, cut edges, dark seam ---------------- */
  each('plank', (x, y, u, v) => {
    const seam = u < 0.09 || u > 0.91;
    const lip = u > 0.09 && u < 0.17;
    const grainWave = Math.sin(u * 21) * 0.06 + Math.sin(v * 3.4 + u * 5) * 0.08;
    // Lifted a full step above the wall so the vertical paneling survives at a distance,
    // where a subtler difference collapses into one flat slab of dark purple.
    let c = mix(rgb(PALETTE.obsidian_lit), rgb(PALETTE.violet_soft), 0.3 + grainWave * 1.2);
    c = mix(c, rgb(PALETTE.violet_rim), 0.22);
    if (lip) c = mix(c, rgb(PALETTE.violet_rim), 0.55);
    if (seam) c = mix(c, rgb(PALETTE.obsidian_deep), 0.68);
    // vertical light: brighter toward the top, like the reference's lit planks
    c = mix(c, rgb(PALETTE.violet_rim), Math.max(0, 0.35 - v) * 0.8);
    c = mix(c, rgb(PALETTE.obsidian_deep), Math.max(0, v - 0.7) * 1.1);
    const n = grain(x, y, 'plank', 10) + (seam ? -12 : 0);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- interior: near black with a violet breath, so the cavity reads deep - */
  each('interior', (x, y, u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    let c = mix(rgb(PALETTE.void_dark), rgb(PALETTE.void_purple), 0.35 + Math.max(0, 0.6 - d) * 0.5);
    c = mix(c, rgb(PALETTE.magic_deep), Math.max(0, 0.4 - d) * 0.45);
    const n = grain(x, y, 'interior', 5);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- floor: like wall but with a faint inlaid grid ---------------------- */
  each('floor', (x, y, u, v) => {
    let c = mix(rgb(PALETTE.obsidian_base), rgb(PALETTE.obsidian_lit), 0.3 + Math.sin(u * 12) * 0.06);
    const grid = u < 0.04 || u > 0.96 || v < 0.04 || v > 0.96 || Math.abs(u - 0.5) < 0.02 || Math.abs(v - 0.5) < 0.02;
    if (grid) c = mix(c, rgb(PALETTE.gold_shadow), 0.55);
    const n = grain(x, y, 'floor', 8);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- gold band: bright top edge, orange mid, dark underside, rivets ----- */
  each('band', (x, y, u, v, r) => {
    const w = r[2] - r[0];
    const height = r[3] - r[1];
    let c;
    if (v < 0.18) c = mix(rgb(PALETTE.gold_tip), rgb(PALETTE.gold_hot), v / 0.18);
    else if (v < 0.42) c = mix(rgb(PALETTE.gold_hot), rgb(PALETTE.gold_bright), (v - 0.18) / 0.24);
    else if (v < 0.68) c = mix(rgb(PALETTE.gold_base), rgb(PALETTE.gold_mid), (v - 0.42) / 0.26);
    else if (v < 0.86) c = mix(rgb(PALETTE.gold_dark), rgb(PALETTE.gold_orange), (v - 0.68) / 0.18 * 0.4);
    else c = mix(rgb(PALETTE.gold_deep), rgb(PALETTE.gold_shadow), (v - 0.86) / 0.14);
    // rivets: one per ~11px of band width
    const period = 11;
    const phase = ((x - r[0]) % period) / period;
    if (height >= 8 && v > 0.3 && v < 0.72 && phase > 0.36 && phase < 0.64) {
      c = mix(c, rgb(PALETTE.gold_tip), 0.62);
    }
    const n = grain(x, y, `band${w}`, 7);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- gold post: mirrored vertical ramp + rivets down the middle --------- */
  each('post', (x, y, u, v) => {
    const across = Math.abs(u - 0.5) * 2;
    let c = mix(rgb(PALETTE.gold_hot), rgb(PALETTE.gold_mid), Math.pow(across, 1.3));
    c = mix(c, rgb(PALETTE.gold_base), 0.25);
    if (across > 0.86) c = mix(c, rgb(PALETTE.gold_deep), 0.6);
    if (across < 0.16) c = mix(c, rgb(PALETTE.gold_tip), 0.5);
    // end caps read as cast metal
    if (v < 0.06) c = mix(c, rgb(PALETTE.gold_tip), 0.45);
    if (v > 0.94) c = mix(c, rgb(PALETTE.gold_shadow), 0.5);
    // rivets every ~10px down the post
    const period = 10;
    const py = Math.round(v * 40);
    if (across < 0.28 && py % period < 3 && v > 0.08 && v < 0.92) c = mix(c, rgb(PALETTE.gold_tip), 0.7);
    const n = grain(x, y, 'post', 7);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- gold plate: the lock. Vertical ramp, bevel, diagonal sheen --------- */
  each('plate', (x, y, u, v) => {
    let c = mix(rgb(PALETTE.gold_hot), rgb(PALETTE.gold_mid), Math.pow(v, 0.9));
    c = mix(c, rgb(PALETTE.gold_bright), Math.max(0, 0.35 - v) * 0.9);
    c = mix(c, rgb(PALETTE.gold_dark), Math.max(0, v - 0.68) * 1.5);
    const sheen = Math.max(0, 1 - Math.abs((u - v) - 0.05) * 5) * 0.28;
    c = mix(c, rgb(PALETTE.gold_tip), sheen);
    const border = u < 0.06 || u > 0.94 || v < 0.09 || v > 0.91;
    const inner = (u > 0.12 && u < 0.88) && (v > 0.2 && v < 0.82) && (u < 0.16 || u > 0.84 || v < 0.26 || v > 0.76);
    if (border) c = mix(c, rgb(PALETTE.gold_tip), 0.45);
    if (inner) c = mix(c, rgb(PALETTE.gold_deep), 0.55);
    const n = grain(x, y, 'plate', 7);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- gold engraved: concentric diamond, for plaques and the lid emblem -- */
  each('engraved', (x, y, u, v) => {
    let c = mix(rgb(PALETTE.gold_base), rgb(PALETTE.gold_mid), v * 0.7 + 0.15);
    c = mix(c, rgb(PALETTE.gold_hot), Math.max(0, 0.3 - v) * 0.7);
    c = mix(c, rgb(PALETTE.gold_dark), Math.max(0, v - 0.75) * 1.4);
    const d = Math.abs(u - 0.5) + Math.abs(v - 0.5); // diamond distance
    const ring = Math.abs(d - 0.34) < 0.035 || Math.abs(d - 0.2) < 0.03;
    const edge = u < 0.045 || u > 0.955 || v < 0.045 || v > 0.955;
    if (ring) c = mix(c, rgb(PALETTE.gold_shadow), 0.7);
    if (Math.abs(d - 0.27) < 0.03) c = mix(c, rgb(PALETTE.gold_tip), 0.35);
    if (edge) c = mix(c, rgb(PALETTE.gold_tip), 0.4);
    if (d < 0.09) c = mix(c, rgb(PALETTE.gold_orange), 0.5);
    const n = grain(x, y, 'engraved', 7);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- dark metal: the plinth and feet. Cold, heavy, faintly violet ------- */
  each('darkmetal', (x, y, u, v) => {
    // Obsidian-metal, not a void. This is the lid's top face as well as the base and
    // feet, so it is the largest surface in any 3/4 or top view and needs tonal range
    // of its own: on the first capture the lid came out 56% near-black with 3.6%
    // midtone, which read as a hole rather than a polished surface.
    const blotch = Math.sin(u * 13.7) * Math.cos(v * 11.1) * 0.5 + 0.5;
    let c = mix(rgb(PALETTE.void_purple), rgb(PALETTE.obsidian_base), 0.35 + blotch * 0.5);
    c = mix(c, rgb(PALETTE.obsidian_lit), Math.max(0, 0.3 - v) * 0.8);
    if (v < 0.1) c = mix(c, rgb(PALETTE.obsidian_high), 0.45); // lit top lip
    if (v > 0.9) c = mix(c, rgb(PALETTE.void_dark), 0.5);
    const n = grain(x, y, 'darkmetal', 6);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- magic core: hot centre falling off to deep violet ------------------ */
  each('core', (x, y, u, v) => {
    const d = Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2.15);
    let c = mix(rgb(PALETTE.magic_white), rgb(PALETTE.magic_glow), Math.min(1, d * 1.7));
    c = mix(c, rgb(PALETTE.magic_mid), Math.max(0, d - 0.45) * 1.6);
    c = mix(c, rgb(PALETTE.magic_deep), Math.max(0, d - 0.78) * 2.6);
    const spark = Math.sin(u * 17) * Math.sin(v * 19) > 0.86 ? 0.35 : 0;
    c = mix(c, rgb(PALETTE.magic_white), spark);
    const n = grain(x, y, 'core', 10);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- crystal: faceted violet with a bright facet and a dark base -------- */
  each('crystal', (x, y, u, v) => {
    const facet = Math.abs(u - 0.5) * 2;
    let c = mix(rgb(PALETTE.magic_glow), rgb(PALETTE.magic_mid), Math.pow(facet, 1.15));
    c = mix(c, rgb(PALETTE.magic_deep), Math.max(0, v - 0.55) * 1.9);
    if (v < 0.14) c = mix(c, rgb(PALETTE.magic_white), 0.55);
    if (Math.abs(u - 0.3) < 0.07) c = mix(c, rgb(PALETTE.magic_hot), 0.5);
    if (Math.abs(u - 0.78) < 0.05) c = mix(c, rgb(PALETTE.magic_deep), 0.4);
    const n = grain(x, y, 'crystal', 10);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- conduit: dark channel with one bright violet filament -------------- */
  each('conduit', (x, y, u, v) => {
    const fil = Math.abs(u - 0.5);
    let c = mix(rgb(PALETTE.void_purple), rgb(PALETTE.obsidian_base), 0.5);
    if (fil < 0.3) c = mix(c, rgb(PALETTE.magic_glow), 1 - fil / 0.3);
    if (fil < 0.09) c = mix(c, rgb(PALETTE.magic_white), 0.7);
    if (u < 0.1 || u > 0.9) c = mix(c, rgb(PALETTE.void_dark), 0.6);
    const n = grain(x, y, 'conduit', 8);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- keyhole: deeper than black, with a violet lip glint ---------------- */
  each('keyhole', (x, y, u, v) => {
    let c = mix(rgb(PALETTE.void_dark), rgb(PALETTE.void_purple), 0.3);
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    c = mix(c, [0, 0, 0], Math.max(0, 0.7 - d) * 0.6);
    if (d > 0.82) c = mix(c, rgb(PALETTE.magic_deep), 0.5);
    if (d > 0.93) c = mix(c, rgb(PALETTE.gold_deep), 0.35);
    const n = grain(x, y, 'keyhole', 5);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- gem: small emissive bead ------------------------------------------ */
  each('gem', (x, y, u, v) => {
    const d = Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2);
    let c = mix(rgb(PALETTE.magic_white), rgb(PALETTE.magic_glow), Math.min(1, d * 1.8));
    c = mix(c, rgb(PALETTE.magic_mid), Math.max(0, d - 0.55) * 2);
    c = mix(c, rgb(PALETTE.magic_deep), Math.max(0, d - 0.88) * 3);
    const n = grain(x, y, 'gem', 12);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* -- stud: gold boss, bright centre over a dark collar ----------------- */
  each('stud', (x, y, u, v) => {
    // Studs are the same physical trim as the bands, so they have to land at the same
    // brightness; the original falloff pushed most of the small island into
    // gold_shadow and averaged L=0.50 against the bands' 0.70.
    const d = Math.pow(Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2), 1.6);
    let c = mix(rgb(PALETTE.gold_hot), rgb(PALETTE.gold_base), d);
    if (d > 0.86) c = mix(c, rgb(PALETTE.gold_dark), 0.5);
    if (d < 0.3) c = mix(c, rgb(PALETTE.gold_tip), 0.75);
    const n = grain(x, y, 'stud', 6);
    put(x, y, [c[0] + n, c[1] + n, c[2] + n]);
  });

  /* Raw gutter: everything outside an island is painted flat magenta so any
   * accidental out-of-island UV shows up loudly instead of blending in. */
  const covered = (x, y) =>
    Object.values(rects).some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!covered(x, y)) put(x, y, [255, 0, 255]);
    }
  }

  return PNG.sync.write(png);
}

/** The atlas PNG plus the rectangle table it was painted from. */
export function buildAtlas(size = 128) {
  const { rects, fill, used_height } = layout(size);
  return { rects, size, fill, used_height, png: paintAtlas(rects, size) };
}

export { hexOf, rgb, mix };
