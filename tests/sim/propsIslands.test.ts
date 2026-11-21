import { describe, expect, test } from 'vitest';
import { buildMapDef } from '../../src/sim/map';
import { ISLAND_LANES, laneGap, PROP_KINDS } from '../../src/sim/props';
import { rotateY, v3 } from '../../src/sim/vec';
import { ISLAND_DECOR } from '../../src/client/world/decor';

describe('tier-A props dress the playable islands', () => {
  test('sim lanes match the client gravel paths', () => {
    expect(ISLAND_LANES).toEqual(ISLAND_DECOR.gravelPaths);
  });

  for (const [template, n] of [['harbor', 8], ['yard', 8], ['harbor', 2], ['yard', 4]] as const) {
    test(`${template} ×${n}: every island gets edge clusters, none on lanes or in doorway approaches`, () => {
      const def = buildMapDef(n, template, 5);
      const props = def.props ?? [];
      for (const isl of def.islands) {
        const mine = props.filter((p) => p.island === isl.index);
        expect(mine.length, `island ${isl.index}`).toBeGreaterThanOrEqual(7);
        for (const p of mine) {
          const e = PROP_KINDS[p.kind].ext, r = Math.hypot(e.x, e.z);
          const l = rotateY(v3(p.pos.x - isl.center.x, 0, p.pos.z - isl.center.z), -isl.bunker.facingYaw);
          expect(laneGap(l.x, l.z)).toBeGreaterThan(r);
          for (const d of isl.bunker.doorways) expect(Math.hypot(p.pos.x - d.center.x, p.pos.z - d.center.z)).toBeGreaterThan(2.5);
          expect(Math.hypot(l.x, l.z)).toBeLessThan(isl.radius - r - 0.9);
          // build room: the open middle (radius 7 around the island centre) stays prop-free
          expect(Math.hypot(l.x, l.z)).toBeGreaterThan(5);
        }
      }
      expect(props.filter((p) => p.island === -1).length).toBeGreaterThanOrEqual(4);
    });
  }
});
