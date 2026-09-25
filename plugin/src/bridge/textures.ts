/**
 * Procedural pixel-art texture generation.
 *
 * The plugin can paint pixels one operation at a time, which is right for deliberate
 * work like an eye or a belly plate. It is the wrong tool for the repetitive, organic
 * parts of a skin: scale patterns, dithered gradients, scattered spots. Those are
 * cheap to compute here and expensive to specify as hundreds of paint operations.
 *
 * Everything is seeded, so the same spec always yields the same PNG and the agent can
 * reproduce a texture it liked.
 *
 * The output deliberately avoids smoothing of any kind: Minecraft textures are
 * quantised pixel art, so every generator step works on integer texels and a bounded
 * palette derived from the requested colours.
 */

import { createImage, encodeDataUrl, encodePng, type RasterImage } from './image.js';

export type TexturePattern = 'flat' | 'noise' | 'scales' | 'stripes' | 'spots' | 'gradient' | 'checker';
export type TextureShading = 'none' | 'top' | 'bottom' | 'radial' | 'vertical';

export interface TextureSpec {
  name?: string;
  width?: number;
  height?: number;
  /** Base colour, hex. */
  base?: string;
  /** Ordered shade ramp; the generator interpolates between these. */
  palette?: string[];
  pattern?: TexturePattern;
  /** Feature size in texels for scales/stripes/spots. */
  scale?: number;
  /** 0-1 coverage for noise/spots. */
  density?: number;
  shading?: TextureShading;
  /** Random seed; identical seeds give identical output. */
  seed?: number;
  /** Adds a 1 texel darker border, which hides seams between adjacent cube faces. */
  border?: string | null;
  /** Vertical two-tone split at this fraction (0-1), e.g. a lighter belly. */
  split?: { at: number; color: string } | null;
}

export interface GeneratedTexture {
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  png: Buffer;
  palette: string[];
  /** Share of each colour, so the agent can judge contrast without opening the PNG. */
  histogram: Array<{ hex: string; share: number }>;
  seed: number;
}

export function normaliseHex(input: string | undefined, fallback = '#7a7a7a'): string {
  const value = (input ?? fallback).trim().replace(/^#/, '');
  const hex = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return `#${hex.toLowerCase()}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = normaliseHex(hex).slice(1);
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

/** Moves a colour toward black (amount < 0) or white (amount > 0). */
export function shift(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (amount >= 0) {
    const t = amount;
    return rgbToHex([r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t]);
  }
  const t = 1 + amount;
  return rgbToHex([r * t, g * t, b * t]);
}

/** Deterministic 32-bit PRNG (mulberry32). */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRamp(base: string, steps = 5, spread = 0.34): string[] {
  const ramp: string[] = [];
  for (let i = 0; i < steps; i++) {
    const position = steps === 1 ? 0.5 : i / (steps - 1);
    ramp.push(shift(base, (position - 0.5) * 2 * spread));
  }
  return ramp;
}

interface PixelWriter {
  set(x: number, y: number, hex: string, alpha?: number): void;
  get(x: number, y: number): string;
}

function makeWriter(image: RasterImage): PixelWriter {
  return {
    set(x, y, hex, alpha = 255) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
      const [r, g, b] = hexToRgb(hex);
      const index = (y * image.width + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    },
    get(x, y) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) return '#000000';
      const index = (y * image.width + x) * 4;
      return rgbToHex([image.data[index], image.data[index + 1], image.data[index + 2]]);
    },
  };
}

function shadeFactor(shading: TextureShading, x: number, y: number, width: number, height: number): number {
  const nx = width <= 1 ? 0.5 : x / (width - 1);
  const ny = height <= 1 ? 0.5 : y / (height - 1);
  switch (shading) {
    case 'top':
      return (0.5 - ny) * 0.36;
    case 'bottom':
      return (ny - 0.5) * 0.36;
    case 'vertical':
      return (0.5 - ny) * 0.22;
    case 'radial': {
      const dx = nx - 0.5;
      const dy = ny - 0.42;
      const distance = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.7);
      return (0.5 - distance) * 0.4;
    }
    default:
      return 0;
  }
}

/** Quantises a shade factor onto the ramp, which is what keeps pixel art from washing out. */
function quantise(ramp: string[], factor: number): string {
  if (ramp.length === 1) return ramp[0];
  const normalised = Math.max(0, Math.min(1, factor + 0.5));
  const index = Math.min(ramp.length - 1, Math.floor(normalised * ramp.length));
  return ramp[index];
}

export function generateTexture(spec: TextureSpec): GeneratedTexture {
  const width = Math.max(1, Math.min(256, Math.round(spec.width ?? 32)));
  const height = Math.max(1, Math.min(256, Math.round(spec.height ?? width)));
  const base = normaliseHex(spec.base, '#6b8e4e');
  const seed = spec.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = makeRandom(seed);
  const shading: TextureShading = spec.shading ?? 'top';
  const pattern: TexturePattern = spec.pattern ?? 'noise';
  const density = Math.max(0, Math.min(1, spec.density ?? 0.35));
  const scale = Math.max(1, Math.round(spec.scale ?? Math.max(2, Math.round(Math.min(width, height) / 8))));
  const palette = (spec.palette?.length ? spec.palette : buildRamp(base, 5)).map((color) => normaliseHex(color));
  const ramp = palette.length >= 2 ? palette.slice().sort((a, b) => luminance(a) - luminance(b)) : [base];

  const image = createImage(width, height, [0, 0, 0, 0]);
  const writer = makeWriter(image);

  // 1. base pass: shading + pattern
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const factor = shadeFactor(shading, x, y, width, height) + patternFactor(pattern, x, y, height, scale, density, random, seed);
      writer.set(x, y, quantise(ramp, factor));
    }
  }

  // 2. optional belly/split region
  if (spec.split && spec.split.at > 0 && spec.split.at < 1) {
    const splitY = Math.round(height * spec.split.at);
    const splitColor = normaliseHex(spec.split.color);
    for (let y = splitY; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const jitter = (random() - 0.5) * 0.16;
        writer.set(x, y, shift(splitColor, shadeFactor('top', x, y - splitY, width, Math.max(1, height - splitY)) + jitter));
      }
    }
    // Dither the boundary so the split does not read as a hard drawn line.
    for (let x = 0; x < width; x++) {
      if (random() < 0.5) writer.set(x, splitY - 1, shift(base, -0.18));
    }
  }

  // 3. optional seam-hiding border
  if (spec.border) {
    const borderColor = normaliseHex(spec.border);
    for (let x = 0; x < width; x++) {
      writer.set(x, 0, borderColor);
      writer.set(x, height - 1, borderColor);
    }
    for (let y = 0; y < height; y++) {
      writer.set(0, y, borderColor);
      writer.set(width - 1, y, borderColor);
    }
  }

  const histogram = histogramOf(image);
  const name = spec.name ?? `texture_${width}x${height}_${seed.toString(36)}`;
  return {
    name,
    width,
    height,
    png: encodePng(image),
    dataUrl: encodeDataUrl(image),
    palette: ramp,
    histogram,
    seed,
  };
}

function patternFactor(
  pattern: TexturePattern,
  x: number,
  y: number,
  height: number,
  scale: number,
  density: number,
  random: () => number,
  seed: number,
): number {
  switch (pattern) {
    case 'flat':
      return 0;
    case 'gradient':
      return (0.5 - (height <= 1 ? 0.5 : y / (height - 1))) * 0.5;
    case 'stripes': {
      const index = Math.floor((x + y * 0.35) / scale);
      return index % 2 === 0 ? 0.12 : -0.12;
    }
    case 'checker': {
      const cell = Math.floor(x / scale) + Math.floor(y / scale);
      return cell % 2 === 0 ? 0.1 : -0.1;
    }
    case 'scales': {
      const row = Math.floor(y / scale);
      const offset = row % 2 === 0 ? 0 : Math.floor(scale / 2);
      const cellX = (x + offset) % (scale * 2);
      const cellY = y % scale;
      const edge = cellY === 0 || cellX === 0;
      const highlight = cellY === Math.max(1, Math.floor(scale / 2)) && cellX === Math.floor(scale / 2);
      return edge ? -0.2 : highlight ? 0.16 : 0.03;
    }
    case 'spots': {
      // Seeded, so two runs of "spots on a green body" are the same animal — and two
      // different seeds are visibly different animals.
      const blob = hash2(x, y, scale, seed);
      const edge = random() < 0.12 ? (random() - 0.5) * 0.14 : 0;
      return (blob < density ? -0.18 : 0) + edge;
    }
    case 'noise':
    default: {
      const value = random();
      if (value < density * 0.5) return -0.16;
      if (value > 1 - density * 0.5) return 0.14;
      return (value - 0.5) * 0.12;
    }
  }
}

/** Coherent-ish value noise in texel space, used for spot placement. */
function hash2(x: number, y: number, scale: number, seed: number): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function histogramOf(image: RasterImage): Array<{ hex: string; share: number }> {
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue;
    const key = rgbToHex([image.data[i], image.data[i + 1], image.data[i + 2]]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([hex, count]) => ({ hex, share: total ? Math.round((count / total) * 1000) / 1000 : 0 }));
}

/**
 * A palette suitable for a creature: one ramp per requested hue plus a shared dark
 * outline tone. Used by the agent when it has a reference image but no explicit palette.
 */
export function creaturePalette(primary: string, secondary?: string, accents: string[] = []): string[] {
  const out = [...buildRamp(normaliseHex(primary), 5)];
  if (secondary) out.push(...buildRamp(normaliseHex(secondary), 3, 0.26));
  out.push(...accents.map((accent) => normaliseHex(accent)));
  out.push(shift(normaliseHex(primary), -0.45));
  const unique = [...new Set(out)];
  return unique;
}
