/**
 * Image helpers.
 *
 * The bridge keeps images in two forms: PNG buffers on disk, and base64 data URLs on
 * the wire (that is what Blockbench's screenshot API returns). This module converts
 * between them and composites multi-angle captures into one contact sheet, which is
 * both cheaper for the model and easier to reason about than six separate images.
 *
 * `pngjs` is pure JavaScript, so there is no native build step.
 */

import { PNG } from 'pngjs';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row major. */
  data: Buffer;
}

export function decodePng(buffer: Buffer): RasterImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(image: RasterImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

export function decodeDataUrl(dataUrl: string): RasterImage {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('not a data URL');
  const header = dataUrl.slice(0, comma);
  if (!header.includes('base64')) throw new Error('only base64 data URLs are supported');
  const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  return decodePng(buffer);
}

export function encodeDataUrl(image: RasterImage): string {
  return `data:image/png;base64,${encodePng(image).toString('base64')}`;
}

export function createImage(width: number, height: number, rgba: [number, number, number, number] = [24, 26, 32, 255]): RasterImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

export function blit(source: RasterImage, target: RasterImage, offsetX: number, offsetY: number): void {
  for (let y = 0; y < source.height; y++) {
    const ty = y + offsetY;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < source.width; x++) {
      const tx = x + offsetX;
      if (tx < 0 || tx >= target.width) continue;
      const si = (y * source.width + x) * 4;
      const ti = (ty * target.width + tx) * 4;
      const alpha = source.data[si + 3] / 255;
      if (alpha === 0) continue;
      target.data[ti] = Math.round(source.data[si] * alpha + target.data[ti] * (1 - alpha));
      target.data[ti + 1] = Math.round(source.data[si + 1] * alpha + target.data[ti + 1] * (1 - alpha));
      target.data[ti + 2] = Math.round(source.data[si + 2] * alpha + target.data[ti + 2] * (1 - alpha));
      target.data[ti + 3] = Math.max(target.data[ti + 3], source.data[si + 3]);
    }
  }
}

/**
 * Nearest-neighbour resize. Deliberately not a smoothing filter: Blockbench renders
 * pixel art at integer scale, and blurring hides exactly the aliasing and UV seams
 * the agent needs to notice.
 */
export function resizeNearest(source: RasterImage, width: number, height: number): RasterImage {
  const out = createImage(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), [0, 0, 0, 0]);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(source.height - 1, Math.floor((y / out.height) * source.height));
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x / out.width) * source.width));
      const si = (sy * source.width + sx) * 4;
      const ti = (y * out.width + x) * 4;
      out.data[ti] = source.data[si];
      out.data[ti + 1] = source.data[si + 1];
      out.data[ti + 2] = source.data[si + 2];
      out.data[ti + 3] = source.data[si + 3];
    }
  }
  return out;
}

/** Scales an image to fit inside a box, preserving aspect ratio, then centres it. */
export function fitInto(source: RasterImage, boxWidth: number, boxHeight: number): RasterImage {
  const scale = Math.min(boxWidth / source.width, boxHeight / source.height);
  return resizeNearest(source, Math.max(1, Math.floor(source.width * scale)), Math.max(1, Math.floor(source.height * scale)));
}

export interface ContactSheetCell {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContactSheet {
  /** One PNG containing every input image on a shared dark background. */
  png: Buffer;
  dataUrl: string;
  width: number;
  height: number;
  /** Where each input landed, so the caller can describe the layout to the model. */
  cells: ContactSheetCell[];
}

export interface ContactSheetOptions {
  columns?: number;
  cellSize?: number;
  background?: [number, number, number, number];
  gap?: number;
}

export function composeContactSheet(images: Array<{ label: string; image: RasterImage }>, options: ContactSheetOptions = {}): ContactSheet {
  if (!images.length) throw new Error('composeContactSheet needs at least one image');
  const gap = options.gap ?? 4;
  const columns = Math.max(1, Math.min(options.columns ?? Math.ceil(Math.sqrt(images.length)), images.length));
  const rows = Math.ceil(images.length / columns);
  const cellSize = options.cellSize ?? Math.min(...images.map((entry) => Math.max(entry.image.width, entry.image.height)));
  const width = columns * cellSize + (columns + 1) * gap;
  const height = rows * cellSize + (rows + 1) * gap;
  const sheet = createImage(width, height, options.background ?? [18, 20, 24, 255]);
  const cells: ContactSheetCell[] = [];

  images.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = gap + column * (cellSize + gap);
    const cellY = gap + row * (cellSize + gap);
    const fitted = fitInto(entry.image, cellSize, cellSize);
    const offsetX = cellX + Math.floor((cellSize - fitted.width) / 2);
    const offsetY = cellY + Math.floor((cellSize - fitted.height) / 2);
    blit(fitted, sheet, offsetX, offsetY);
    cells.push({ label: entry.label, x: offsetX, y: offsetY, width: fitted.width, height: fitted.height });
    // 1px separator so adjacent frames do not visually merge.
    for (let i = 0; i < cellSize; i++) {
      const borderX = gap + column * (cellSize + gap) - 1;
      const borderY = gap + row * (cellSize + gap) - 1;
      if (borderX >= 0) {
        const ti = ((cellY + i) * width + borderX) * 4;
        sheet.data[ti] = 60;
        sheet.data[ti + 1] = 64;
        sheet.data[ti + 2] = 72;
        sheet.data[ti + 3] = 255;
      }
      if (borderY >= 0) {
        const ti = (borderY * width + cellX + i) * 4;
        sheet.data[ti] = 60;
        sheet.data[ti + 1] = 64;
        sheet.data[ti + 2] = 72;
        sheet.data[ti + 3] = 255;
      }
    }
  });

  return {
    png: encodePng(sheet),
    dataUrl: encodeDataUrl(sheet),
    width,
    height,
    cells,
  };
}

/** Downscales an already composited sheet so it fits an API payload budget. */
export function clampDataUrl(dataUrl: string, maxDimension: number): { dataUrl: string; width: number; height: number; downscaled: boolean } {
  const image = decodeDataUrl(dataUrl);
  if (image.width <= maxDimension && image.height <= maxDimension) {
    return { dataUrl, width: image.width, height: image.height, downscaled: false };
  }
  const scale = maxDimension / Math.max(image.width, image.height);
  const resized = resizeNearest(image, image.width * scale, image.height * scale);
  return { dataUrl: encodeDataUrl(resized), width: resized.width, height: resized.height, downscaled: true };
}

/** Writes a simple colour histogram, used to sanity check generated textures. */
export function colourHistogram(image: RasterImage, maxEntries = 12): Array<{ hex: string; share: number }> {
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue;
    const key = `#${[image.data[i], image.data[i + 1], image.data[i + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .map(([hex, count]) => ({ hex, share: total ? Math.round((count / total) * 1000) / 1000 : 0 }));
}
