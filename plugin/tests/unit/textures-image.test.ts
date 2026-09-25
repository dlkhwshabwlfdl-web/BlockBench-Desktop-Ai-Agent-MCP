import { describe, expect, it } from 'vitest';
import { generateTexture, creaturePalette, buildRamp, shift, hexToRgb, rgbToHex } from '../../src/bridge/textures.js';
import { composeContactSheet, createImage, decodeDataUrl, encodePng, fitInto, resizeNearest, colourHistogram } from '../../src/bridge/image.js';

describe('colour helpers', () => {
  it('round trips hex through rgb', () => {
    expect(rgbToHex(hexToRgb('#3a7bd5'))).toBe('#3a7bd5');
  });

  it('expands three digit shorthand', () => {
    expect(hexToRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('darkens and lightens predictably', () => {
    expect(shift('#808080', -0.5)).toBe('#404040');
    expect(shift('#808080', 0.5)).toBe('#c0c0c0');
  });

  it('builds a monotonically increasing ramp', () => {
    const ramp = buildRamp('#606060', 5);
    const values = ramp.map((hex) => hexToRgb(hex)[0]);
    expect(values).toHaveLength(5);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  });
});

describe('generateTexture', () => {
  it('is deterministic for a given seed', () => {
    const a = generateTexture({ width: 16, height: 16, base: '#4a7a3a', pattern: 'scales', seed: 1234 });
    const b = generateTexture({ width: 16, height: 16, base: '#4a7a3a', pattern: 'scales', seed: 1234 });
    expect(a.dataUrl).toBe(b.dataUrl);
  });

  it('produces different pixels for different seeds', () => {
    const a = generateTexture({ width: 16, height: 16, base: '#4a7a3a', pattern: 'spots', seed: 1 });
    const b = generateTexture({ width: 16, height: 16, base: '#4a7a3a', pattern: 'spots', seed: 2 });
    expect(a.dataUrl).not.toBe(b.dataUrl);
  });

  it('honours the requested size and returns a valid PNG', () => {
    const texture = generateTexture({ width: 32, height: 48, base: '#123456', pattern: 'flat' });
    const image = decodeDataUrl(texture.dataUrl);
    expect(image.width).toBe(32);
    expect(image.height).toBe(48);
    expect(texture.png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('clamps absurd sizes instead of allocating gigabytes', () => {
    const texture = generateTexture({ width: 100000, height: 100000, pattern: 'flat' });
    expect(texture.width).toBeLessThanOrEqual(256);
    expect(texture.height).toBeLessThanOrEqual(256);
  });

  it('reports a histogram that sums to roughly one', () => {
    const texture = generateTexture({ width: 24, height: 24, base: '#8b5a2b', pattern: 'noise', density: 0.5, seed: 7 });
    const total = texture.histogram.reduce((sum, entry) => sum + entry.share, 0);
    expect(total).toBeGreaterThan(0.5);
    expect(total).toBeLessThanOrEqual(1.0001);
    for (const entry of texture.histogram) expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('applies a border when asked, which is how seams get hidden', () => {
    const texture = generateTexture({ width: 8, height: 8, base: '#ffffff', pattern: 'flat', border: '#000000' });
    const image = decodeDataUrl(texture.dataUrl);
    expect(image.data[0]).toBe(0);
    expect(image.data[1]).toBe(0);
    expect(image.data[2]).toBe(0);
  });

  it('paints a split region below the split line', () => {
    const texture = generateTexture({ width: 8, height: 8, base: '#000000', pattern: 'flat', split: { at: 0.5, color: '#ffffff' } });
    const image = decodeDataUrl(texture.dataUrl);
    const top = image.data[(1 * image.width + 4) * 4];
    const bottom = image.data[(6 * image.width + 4) * 4];
    expect(bottom).toBeGreaterThan(top);
  });
});

describe('creaturePalette', () => {
  it('returns a deduplicated palette with a dark outline tone', () => {
    const palette = creaturePalette('#5c7a3a', '#c9b27a', ['#d94f4f']);
    expect(new Set(palette).size).toBe(palette.length);
    expect(palette).toContain('#d94f4f');
    const darkest = palette.map((hex) => hexToRgb(hex)[1]).reduce((min, value) => Math.min(min, value), 255);
    expect(darkest).toBeLessThan(hexToRgb('#5c7a3a')[1]);
  });
});

describe('image helpers', () => {
  it('round trips a PNG through encode and decode', () => {
    const image = createImage(6, 4, [10, 20, 30, 255]);
    const decoded = decodeFromBuffer(encodePng(image));
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(4);
    expect(decoded.data[0]).toBe(10);
    expect(decoded.data[3]).toBe(255);
  });

  it('resizes with nearest neighbour, preserving hard edges', () => {
    const source = createImage(2, 2, [0, 0, 0, 255]);
    source.data[0] = 255; // first pixel white
    const resized = resizeNearest(source, 4, 4);
    expect(resized.width).toBe(4);
    expect(resized.data[0]).toBe(255);
    // The far corner stays black: no averaging.
    const last = (3 * 4 + 3) * 4;
    expect(resized.data[last]).toBe(0);
  });

  it('fits an image inside a box without changing aspect ratio', () => {
    const wide = createImage(100, 50, [1, 2, 3, 255]);
    const fitted = fitInto(wide, 40, 40);
    expect(fitted.width).toBe(40);
    expect(fitted.height).toBe(20);
  });

  it('lays out a contact sheet with the same number of cells as inputs', () => {
    const sheet = composeContactSheet(
      [
        { label: 'north', image: createImage(16, 16, [1, 1, 1, 255]) },
        { label: 'east', image: createImage(16, 16, [2, 2, 2, 255]) },
        { label: 'top', image: createImage(16, 16, [3, 3, 3, 255]) },
      ],
      { columns: 3, cellSize: 16, gap: 2 },
    );
    expect(sheet.cells.map((cell) => cell.label)).toEqual(['north', 'east', 'top']);
    expect(sheet.width).toBe(3 * 16 + 4 * 2);
    for (const cell of sheet.cells) expect(cell.width).toBe(16);
    expect(sheet.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('refuses to composite nothing', () => {
    expect(() => composeContactSheet([])).toThrow(/at least one image/);
  });

  it('summarises the dominant colours of an image', () => {
    const image = createImage(4, 4, [255, 0, 0, 255]);
    const histogram = colourHistogram(image);
    expect(histogram[0]).toEqual({ hex: '#ff0000', share: 1 });
  });
});

function decodeFromBuffer(buffer: Buffer) {
  // `decodePng` is exercised through the data URL path above; here we only need the
  // round trip, so reuse the public entry point.
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return decodeDataUrl(dataUrl);
}
