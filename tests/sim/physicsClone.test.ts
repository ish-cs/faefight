import { describe, expect, it } from 'vitest';
import { harborCraneBoxes, buildMapDef } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';

describe('Physics.clone', () => {
  it('keeps no-build zones, crane anchors and piece base heights (support / no-build checks match the original)', async () => {
    const def = buildMapDef(2, 'harbor', 1);
    const ph = await Physics.create(def);
    const c = ph.clone();
    expect(c.noBuildZones()).toEqual(ph.noBuildZones());
    expect(c.noBuildZones().length).toBeGreaterThan(0);
    const leg = harborCraneBoxes(def.islands)[0];
    expect(ph.touchesAnchor(leg.center, leg.half, leg.rotY)).toBe(true);
    expect(c.touchesAnchor(leg.center, leg.half, leg.rotY)).toBe(true);
    // Independent: changing the copy's zones leaves the original alone.
    c.setNoBuildZones('islands', []);
    expect(ph.noBuildZones().length).toBeGreaterThan(c.noBuildZones().length);
    ph.dispose(); c.dispose();
  });
});
