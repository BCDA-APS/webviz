import { describe, it, expect } from 'vitest';
import { interpolateColor, COLORMAPS } from './colormap';

describe('interpolateColor', () => {
  it('returns the first color at t=0', () => {
    const palette = COLORMAPS.greys; // [[0,0,0],[255,255,255]]
    expect(interpolateColor(palette, 0)).toEqual([0, 0, 0]);
  });

  it('returns the last color at t=1', () => {
    const palette = COLORMAPS.greys;
    expect(interpolateColor(palette, 1)).toEqual([255, 255, 255]);
  });

  it('interpolates midpoint for a 2-stop palette', () => {
    const palette = COLORMAPS.greys;
    expect(interpolateColor(palette, 0.5)).toEqual([128, 128, 128]);
  });

  it('clamps t below 0', () => {
    const palette = COLORMAPS.greys;
    expect(interpolateColor(palette, -1)).toEqual([0, 0, 0]);
  });

  it('clamps t above 1', () => {
    const palette = COLORMAPS.greys;
    expect(interpolateColor(palette, 2)).toEqual([255, 255, 255]);
  });

  it('returns an RGB triple with values in [0, 255]', () => {
    const palette = COLORMAPS.viridis;
    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
      const [r, g, b] = interpolateColor(palette, t);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });
});

describe('COLORMAPS', () => {
  it('contains expected keys', () => {
    expect(Object.keys(COLORMAPS)).toContain('viridis');
    expect(Object.keys(COLORMAPS)).toContain('greys');
    expect(Object.keys(COLORMAPS)).toContain('hot');
  });

  it('each palette has at least 2 stops', () => {
    for (const [name, palette] of Object.entries(COLORMAPS)) {
      expect(palette.length, `${name} has too few stops`).toBeGreaterThanOrEqual(2);
    }
  });
});
