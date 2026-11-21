import { describe, expect, test } from 'vitest';
import { groundFootprints } from '../../src/client/world/groundAO';
import { buildMapDef, type MapTemplate } from '../../src/sim/map';

describe('ground AO footprints', () => {
  for (const template of ['harbor', 'yard'] as MapTemplate[]) {
    test(`${template}: every footprint rests on a ground level, covers walls, cover and stations`, () => {
      const def = buildMapDef(8, template);
      const fps = groundFootprints(def);
      const grounds = [def.center.groundY, ...def.islands.map((i) => i.groundY)];
      for (const f of fps) {
        expect(grounds.some((g) => Math.abs(f.y - g) < 0.15)).toBe(true);
        expect(f.hx).toBeGreaterThan(0);
        expect(f.hz).toBeGreaterThan(0);
        expect(f.margin).toBeGreaterThan(0);
        expect(f.margin).toBeLessThanOrEqual(1.1);
      }
      // per island: bunker walls + generator/vault/shop at least; plus all ground-resting cover
      expect(fps.length).toBeGreaterThanOrEqual(def.islands.length * 6 + def.statics.length);
    });
  }

  test('deterministic', () => {
    expect(groundFootprints(buildMapDef(4, 'harbor'))).toEqual(groundFootprints(buildMapDef(4, 'harbor')));
  });
});
