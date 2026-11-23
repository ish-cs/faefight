import { describe, expect, it } from 'vitest';
import { ISLAND_COLORS, tagTextColor } from '../../src/client/colors';
import { displayOf, hdrFor } from '../../src/client/world/displayColor';

const rgb = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

describe('name tag colours survive tone mapping + grade', () => {
  it('every island colour comes out on screen as its HUD chip colour, at day and night exposure', () => {
    for (const exposure of [0.7, 1, 1.6]) for (const hex of ISLAND_COLORS) {
      const want = rgb(hex).map((v) => Math.min(v, 0.93)) as [number, number, number];
      const got = displayOf(hdrFor(want, exposure), exposure);
      // Teal sits just outside what ACES can output (its red would need negative light): off by ~13/255 in red.
      const tol = hex === 0x3dd0d0 ? 0.06 : 2 / 255;
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i])).toBeLessThan(tol);
    }
  });

  it('text is dark on light fills (yellow, white, green, teal) and white on dark ones (red, blue, purple, orange)', () => {
    const [red, blue, green, gold, purple, teal, orange, white] = ISLAND_COLORS;
    for (const c of [gold, white, green, teal]) expect(tagTextColor(c)).toBe('#10151c');
    for (const c of [red, blue, purple, orange]) expect(tagTextColor(c)).toBe('#ffffff');
  });
});
