import { describe, expect, it } from 'vitest';
import { ConnectGraph, decodeMask, encodeMask, END_JOINT, END_MERGED, END_OPEN } from '../../src/client/world/connect';
import { PIECES } from '../../src/sim/constants';
import type { PieceKind, PieceState } from '../../src/sim/types';

let nid = 1;
const P = (kind: PieceKind, x: number, y: number, z: number, rotY = 0, id = nid++): PieceState =>
  ({ id, kind, owner: 0, pos: { x, y, z }, rotY, hp: PIECES[kind].hp });

/** A wall run along local +X at yaw `rot`, starting at (x0, z0). */
const run = (kinds: PieceKind[], rot = 0, x0 = 0, z0 = 0, y = 0) =>
  kinds.map((k, i) => P(k, x0 + Math.cos(rot) * 2 * i, y, z0 - Math.sin(rot) * 2 * i, rot));

describe('edge mask encoding', () => {
  it('round-trips and fits in 6 bits', () => {
    for (const e of [{ l: 2, r: 1, d: 1, u: 0 }, { l: 0, r: 2, d: 0, u: 1 }, { l: 2, r: 2, d: 1, u: 1 }]) {
      const m = encodeMask(e);
      expect(m).toBeLessThan(64);
      expect(decodeMask(m)).toEqual(e);
    }
  });
});

describe('ConnectGraph', () => {
  it('side-by-side same material merges the shared ends only', () => {
    const [a, b, c] = run(['steel', 'steel', 'steel']);
    const g = new ConnectGraph();
    g.update([a, b, c]);
    expect(g.edges(a.id)).toEqual({ l: END_OPEN, r: END_MERGED, d: 0, u: 0 });
    expect(g.edges(b.id)).toEqual({ l: END_MERGED, r: END_MERGED, d: 0, u: 0 });
    expect(g.edges(c.id)).toEqual({ l: END_MERGED, r: END_OPEN, d: 0, u: 0 });
  });

  it('works at any yaw (15° steps) and with the +0.05 beside-placement offset', () => {
    const rot = (75 * Math.PI) / 180;
    const [a, b] = run(['wood', 'wood'], rot, 10, -4);
    b.pos.y += 0.05;
    const g = new ConnectGraph();
    g.update([a, b]);
    expect(g.edges(a.id).r).toBe(END_MERGED);
    expect(g.edges(b.id).l).toBe(END_MERGED);
  });

  it('a gap leaves both ends open', () => {
    const a = P('metal', 0, 0, 0), b = P('metal', 2.6, 0, 0);
    const g = new ConnectGraph();
    g.update([a, b]);
    expect(g.edges(a.id).r).toBe(END_OPEN);
    expect(g.edges(b.id).l).toBe(END_OPEN);
  });

  it('stacked same material sets down/up, different material does not', () => {
    const h = PIECES.steel.h;
    const s0 = P('steel', 0, 0, 0), s1 = P('steel', 0, h + 0.05, 0), s2 = P('steel', 0, 2 * h + 0.1, 0);
    const w = P('wood', 5, 0, 0), m = P('metal', 5, PIECES.wood.h + 0.05, 0);
    const g = new ConnectGraph();
    g.update([s0, s1, s2, w, m]);
    expect(g.edges(s0.id)).toMatchObject({ d: 0, u: 1 });
    expect(g.edges(s1.id)).toMatchObject({ d: 1, u: 1 });
    expect(g.edges(s2.id)).toMatchObject({ d: 1, u: 0 });
    expect(g.edges(w.id)).toMatchObject({ d: 0, u: 0 });
    expect(g.edges(m.id)).toMatchObject({ d: 0, u: 0 });
    // stacked pieces are not side neighbours of each other
    expect(g.edges(s1.id)).toMatchObject({ l: END_OPEN, r: END_OPEN });
  });

  it('corner: perpendicular walls meeting at an end are joints, not merges', () => {
    const t = PIECES.steel.d;
    const a = P('steel', 0, 0, 0, 0);
    // b runs along world Z, its end flush with a's +X end
    const b = P('steel', 1 + t / 2, 0, -1 + t / 2, Math.PI / 2);
    const g = new ConnectGraph();
    g.update([a, b]);
    expect(g.edges(a.id).r).toBe(END_JOINT);
    expect(g.edges(a.id).l).toBe(END_OPEN);
    // b's end at local +X points to world -Z... whichever end touches a must be a joint
    const eb = g.edges(b.id);
    expect([eb.l, eb.r]).toContain(END_JOINT);
  });

  it('mixed materials in line are joints on both sides', () => {
    const [w, s, sb] = run(['wood', 'steel', 'sandbags']);
    const g = new ConnectGraph();
    g.update([w, s, sb]);
    expect(g.edges(w.id)).toMatchObject({ l: END_OPEN, r: END_JOINT });
    expect(g.edges(s.id)).toMatchObject({ l: END_JOINT, r: END_JOINT });
    expect(g.edges(sb.id)).toMatchObject({ l: END_JOINT, r: END_OPEN });
  });

  it('removal re-opens the neighbours, incrementally', () => {
    const pieces = run(['steel', 'steel', 'steel', 'steel']);
    const far = run(['wood', 'wood', 'wood'], 0, 60, 60);
    const g = new ConnectGraph();
    g.update([...pieces, ...far]);
    expect(g.edges(pieces[1].id).r).toBe(END_MERGED);
    const without = [...pieces.filter((p) => p !== pieces[2]), ...far];
    const changed = g.update(without);
    expect(g.edges(pieces[1].id)).toMatchObject({ l: END_MERGED, r: END_OPEN });
    expect(g.edges(pieces[3].id)).toMatchObject({ l: END_OPEN, r: END_OPEN });
    expect(changed).toEqual(new Set([pieces[1].id, pieces[3].id]));
    expect(g.lastRecomputed).toBeLessThan(without.length); // the far run was not touched
    expect(g.mask(pieces[2].id)).toBe(0);
    // no-op update recomputes nothing
    expect(g.update(without).size).toBe(0);
    expect(g.lastRecomputed).toBe(0);
    // re-adding merges again
    g.update([...pieces, ...far]);
    expect(g.edges(pieces[1].id).r).toBe(END_MERGED);
    expect(g.edges(pieces[3].id).l).toBe(END_MERGED);
  });

  it('scaffold bridges along Z and side by side along X', () => {
    const d = PIECES.scaffold.d;
    const a = P('scaffold', 0, 1, 0), b = P('scaffold', 0, 1, d), c = P('scaffold', 2, 1, 0);
    const g = new ConnectGraph();
    g.update([a, b, c]);
    expect(g.edges(a.id)).toMatchObject({ u: 1, d: 0, r: END_MERGED, l: END_OPEN });
    expect(g.edges(b.id)).toMatchObject({ d: 1, u: 0 });
    expect(g.edges(c.id)).toMatchObject({ l: END_MERGED });
  });

  it('ramp staircase: top runs into the next ramp / a container, bottom starts from a top surface', () => {
    const { h, d } = PIECES.ramp;
    const r1 = P('ramp', 0, 0, 0), r2 = P('ramp', 0, h, d);
    const box = P('container', 0, h, d + d / 2 + PIECES.container.d / 2 + 0.02, Math.PI / 2);
    const g = new ConnectGraph();
    g.update([r1, r2]);
    expect(g.edges(r1.id)).toMatchObject({ u: 1, d: 0 });
    expect(g.edges(r2.id)).toMatchObject({ d: 1, u: 0 });
    g.update([r1, r2, box]);
    expect(g.edges(r2.id)).toMatchObject({ d: 1, u: 1 });
    expect(g.edges(box.id)).toMatchObject({ u: 0, d: 0 });
  });

  it('100 pieces update in well under a millisecond-scale budget', () => {
    const many: PieceState[] = [];
    for (let i = 0; i < 120; i++) many.push(P((['steel', 'wood', 'sandbags'] as PieceKind[])[i % 3], (i % 20) * 2, Math.floor(i / 20) * 2.6, 0));
    const g = new ConnectGraph();
    const t0 = performance.now();
    g.update(many);
    for (let k = 0; k < 30; k++) g.update(many);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
