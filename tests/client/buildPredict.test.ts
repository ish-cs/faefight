import { describe, expect, test } from 'vitest';
import { BuildPredictor, FADE_MS, REJECT_MS } from '../../src/client/buildPredict';
import { Predictor } from '../../src/client/predict';
import { validatePlacement } from '../../src/sim/building';
import { PIECES } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type BuildRequest, type PieceState } from '../../src/sim/types';
import { add, forward, scale, v3 } from '../../src/sim/vec';

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };

/** Host match + the guest-side predictors, player 1 on open ground in front of their bunker. */
async function setup(pieces: number) {
  const m = await Match.create(humans);
  const isl = m.map[0];
  const yaw = isl.bunker.facingYaw;
  const stand = add(isl.center, scale(forward(yaw), 10));
  m.debugTeleport(1, v3(stand.x, isl.groundY, stand.z));
  if (pieces) m.debugGive(1, { pieces: { wood: pieces } });
  const s0 = m.tick(new Map());
  const pr = await Predictor.create(m.def, 1);
  pr.onSnapshot(s0);
  const spot = add(stand, scale(forward(yaw), 3));
  const req: BuildRequest = { kind: 'wood', pos: v3(spot.x, isl.groundY, spot.z), rotY: yaw, free: true };
  return { m, pr, req, s0, stand: v3(stand.x, isl.groundY, stand.z) };
}

const maxId = (ps: readonly PieceState[]) => ps.reduce((a, p) => Math.max(a, p.id), 0);

describe('BuildPredictor', () => {
  test('a placement shows at once, joins the local world, and is confirmed by the host piece', async () => {
    const { m, pr, req, s0, stand } = await setup(2);
    const b = new BuildPredictor();
    const piece = b.place(req.kind, req.pos, req.rotY, 1, 0, maxId(s0.pieces));
    // Same frame: drawn (pieces) and solid for the next ghost (the spot is now taken locally).
    expect(b.pieces).toEqual([piece]);
    expect(piece.id).toBeLessThan(0);
    pr.addLocalPiece(piece);
    expect(validatePlacement(pr.world, 'wood', req.pos, req.rotY, stand).ok).toBe(false);
    expect(b.unconfirmed(s0.pieces, 'wood')).toBe(1);
    // A snapshot from before the host placed it changes nothing.
    expect(b.reconcile(s0.pieces, 50)).toEqual({ confirmed: [], rejected: [] });
    // Host places it; its snapshot confirms the prediction (the real piece takes over).
    const s1 = m.tick(new Map([[1, { ...NO_INPUT, build: req }]]));
    expect(s1.pieces).toHaveLength(1);
    pr.onSnapshot(s1);
    expect(b.unconfirmed(s1.pieces, 'wood')).toBe(0);
    const r = b.reconcile(s1.pieces, 80);
    expect(r.confirmed.map((p) => p.id)).toEqual([piece.id]);
    expect(r.rejected).toEqual([]);
    expect(b.pieces).toEqual([]);
    expect(b.fades(80)).toEqual([]);
    pr.removeLocalPiece(piece.id);
    // Still solid locally: the real piece came in with the snapshot.
    expect(validatePlacement(pr.world, 'wood', req.pos, req.rotY, stand).ok).toBe(false);
    expect(b.stats).toEqual({ placed: 1, confirmed: 1, rejected: 0 });
  });

  test('a placement the host refuses is removed after REJECT_MS with a short fade; authoritative state untouched', async () => {
    const { m, pr, req, s0, stand } = await setup(0); // the host knows we have no wood
    const b = new BuildPredictor();
    const piece = b.place(req.kind, req.pos, req.rotY, 1, 0, maxId(s0.pieces));
    pr.addLocalPiece(piece);
    const s1 = m.tick(new Map([[1, { ...NO_INPUT, build: req }]]));
    expect(s1.pieces).toEqual([]); // the prediction never reaches the host's state
    expect(b.reconcile(s1.pieces, REJECT_MS - 1).rejected).toEqual([]);
    expect(b.pieces).toHaveLength(1);
    const r = b.reconcile(s1.pieces, REJECT_MS + 1);
    expect(r.rejected.map((p) => p.id)).toEqual([piece.id]);
    expect(b.pieces).toEqual([]);
    pr.removeLocalPiece(piece.id);
    expect(validatePlacement(pr.world, 'wood', req.pos, req.rotY, stand).ok).toBe(true);
    const f = b.fades(REJECT_MS + 1 + FADE_MS / 2);
    expect(f).toHaveLength(1);
    expect(f[0].opacity).toBeCloseTo(0.5, 1);
    expect(b.fades(REJECT_MS + 2 + FADE_MS)).toEqual([]);
  });

  test('paces placing at the piece placeSec', () => {
    const b = new BuildPredictor();
    expect(b.canPlace(0)).toBe(true);
    b.place('wood', v3(0, 0, 0), 0, 1, 1000, 0);
    expect(b.canPlace(1000 + PIECES.wood.placeSec * 1000 - 1)).toBe(false);
    expect(b.canPlace(1000 + PIECES.wood.placeSec * 1000)).toBe(true);
  });

  test('older pieces and pieces of others or elsewhere do not confirm a prediction', () => {
    const b = new BuildPredictor();
    b.place('wood', v3(10, 2, 10), 0, 1, 0, 40);
    const host = (id: number, owner: number, x: number, kind: PieceState['kind'] = 'wood'): PieceState =>
      ({ id, kind, owner, pos: v3(x, 2, 10), rotY: 0, hp: 200 });
    const r = b.reconcile([host(40, 1, 10), host(41, 2, 10), host(42, 1, 14), host(43, 1, 10, 'metal')], 10);
    expect(r.confirmed).toEqual([]);
    expect(b.reconcile([host(44, 1, 10.1)], 20).confirmed).toHaveLength(1);
  });
});
