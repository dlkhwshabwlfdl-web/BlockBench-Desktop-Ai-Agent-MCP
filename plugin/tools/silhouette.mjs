#!/usr/bin/env node
/**
 * Print a viewport PNG as an ASCII silhouette.
 *
 * QA views are rendered by Blockbench and analysed by numbers, but a silhouette is the
 * fastest way to actually judge a shape. Coverage drives the glyph and brightness is
 * ignored on purpose: the texture changes between passes, and a brightness-shaded
 * render makes "darker skin" look like "different outline".
 *
 *   node tools/silhouette.mjs ai_context/viewport/before_left.png [width]
 *   node tools/silhouette.mjs --compare before_left.png pass1_left.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const WORKSPACE = process.env.AI_AGENT_WORKSPACE ?? 'F:/resourcepack/Trex';
const VIEWPORT = path.join(WORKSPACE, 'ai_context', 'viewport');
const argv = process.argv.slice(2);

function resolve(file) {
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  const candidates = [file, path.join(VIEWPORT, file), path.join(WORKSPACE, file)];
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hit) throw new Error(`no such image: ${file}`);
  return hit;
}

/** Trim the empty frame so the text block is all model. */
function cropToInk(full) {
  let minX = full.width;
  let maxX = -1;
  let minY = full.height;
  let maxY = -1;
  for (let y = 0; y < full.height; y += 1) {
    for (let x = 0; x < full.width; x += 1) {
      const i = (y * full.width + x) * 4;
      const [r, g, b, a] = [full.data[i], full.data[i + 1], full.data[i + 2], full.data[i + 3]];
      if (a < 16) continue;
      if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r > 195) continue; // grid / background
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { png: full, empty: true };
  const pad = 1;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(full.width - 1, maxX + pad);
  maxY = Math.min(full.height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = ((y + minY) * full.width + (x + minX)) * 4;
      const dst = (y * w + x) * 4;
      out.data[dst] = full.data[src];
      out.data[dst + 1] = full.data[src + 1];
      out.data[dst + 2] = full.data[src + 2];
      out.data[dst + 3] = full.data[src + 3];
    }
  }
  return { png: out, empty: false };
}

function isInk(data, width, x, y) {
  const i = (y * width + x) * 4;
  const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
  if (a < 16) return false;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r > 195) return false;
  return true;
}

/** One glyph per cell, chosen purely from how much of the cell the model covers. */
export function silhouette(file, width = 118, maxRows = 40) {
  const { png, empty } = cropToInk(PNG.sync.read(fs.readFileSync(resolve(file))));
  if (empty) return '(empty render — no model pixels found)';
  const ramp = ' .:-=+*oO0#@';
  let cols = width;
  let rows = Math.round((cols * png.height) / png.width / 2);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(16, Math.round((rows * 2 * png.width) / png.height));
  }
  rows = Math.max(5, rows);
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.floor((c * png.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * png.width) / cols));
      const y0 = Math.floor((r * png.height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * png.height) / rows));
      let ink = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += 1;
          if (isInk(png.data, png.width, x, y)) ink += 1;
        }
      }
      const coverage = total ? ink / total : 0;
      line += ramp[Math.min(ramp.length - 1, Math.round(coverage * (ramp.length - 1)))];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  const aspect = Math.round(((png.width / png.height) * 100)) / 100;
  return `[${path.basename(file)}] ${png.width}x${png.height} aspect ${aspect}\n${lines.join('\n')}`;
}

/** Column-by-column top/bottom profile — the numbers behind the picture. */
export function profile(file, samples = 24) {
  const { png } = cropToInk(PNG.sync.read(fs.readFileSync(resolve(file))));
  const out = [];
  for (let s = 0; s < samples; s += 1) {
    const x0 = Math.floor((s * png.width) / samples);
    const x1 = Math.max(x0 + 1, Math.floor(((s + 1) * png.width) / samples));
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < png.height; y += 1) {
      let any = false;
      for (let x = x0; x < x1; x += 1) if (isInk(png.data, png.width, x, y)) { any = true; break; }
      if (any) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    out.push({
      at: Math.round(((s + 0.5) / samples) * 100) / 100,
      top: top < 0 ? null : Math.round((1 - top / png.height) * 1000) / 1000,
      bottom: bottom < 0 ? null : Math.round((1 - bottom / png.height) * 1000) / 1000,
      thickness: top < 0 ? null : Math.round(((bottom - top + 1) / png.height) * 1000) / 1000,
    });
  }
  return out;
}

function main() {
  if (argv.includes('--compare')) {
    const [a, b] = argv.filter((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));
    console.log(silhouette(a));
    console.log(`\n${'─'.repeat(60)}\n`);
    console.log(silhouette(b));
    return;
  }
  const file = argv.find((arg) => !arg.startsWith('--'));
  const width = Number(argv.find((arg) => /^\d+$/.test(arg))) || 118;
  if (!file) {
    console.error('usage: node tools/silhouette.mjs <image> [width] | --compare <a> <b>');
    process.exitCode = 1;
    return;
  }
  console.log(silhouette(file, width));
  if (argv.includes('--profile')) console.log(JSON.stringify(profile(file), null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
