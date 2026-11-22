import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { propSolidHit } from '../../src/client/world/gameProps';
import { hazardSolidHit } from '../../src/client/world/hazards';
import { isPropOwner, ownHazard, ownProp } from '../../src/client/world/surfaces';
import { HAZARD } from '../../src/sim/constants';
import { buildMapDef } from '../../src/sim/map';
import { v3 } from '../../src/sim/vec';

/** Shots ending on gameplay props / hazards: which one, its face normal, and an owner so marks follow or go with it. */
describe('dynamic solids for bullet marks', () => {
  const def = buildMapDef(4, 'harbor');

  test('a gameplay prop: top face hit, owned by it; at another pose the old spot misses', () => {
    const sp = def.props!.find((p) => p.kind === 'crate')!;
    const pos = new THREE.Vector3(sp.pos.x, sp.pos.y, sp.pos.z), rot = new THREE.Quaternion(...sp.rot);
    const top = v3(sp.pos.x, sp.pos.y + 0.45, sp.pos.z);
    const h = propSolidHit('crate', sp.id, pos, rot, top, 0.12)!;
    expect(h.owner).toBe(ownProp(sp.id));
    expect(isPropOwner(h.owner!)).toBe(true);
    expect(h.surface).toBe('wood');
    expect(h.normal.y).toBeGreaterThan(0.5);
    const moved = pos.clone().add(new THREE.Vector3(5, 0, 0));
    expect(propSolidHit('crate', sp.id, moved, rot, top, 0.12)).toBeNull();
    // a drum (cylinder): side hit gets a radial normal
    const side = propSolidHit('drum', 2, new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), v3(0.3, 0.1, 0), 0.12)!;
    expect(side.normal.x).toBeCloseTo(1, 5);
  });

  test('a hazard: side hit owned by it; far away misses', () => {
    const hz = def.hazards!.find((h) => h.kind === 'barrel')!;
    const h = hazardSolidHit(hz, v3(hz.pos.x + HAZARD.barrel.r, hz.pos.y + 0.5, hz.pos.z), 0.1)!;
    expect(h.owner).toBe(ownHazard(hz.id));
    expect(h.normal.x).toBeCloseTo(1, 5);
    expect(hazardSolidHit(hz, v3(hz.pos.x + 3, hz.pos.y + 0.5, hz.pos.z), 0.1)).toBeNull();
  });
});
