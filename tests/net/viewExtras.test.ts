import { describe, expect, test } from 'vitest';
import { sanitizeClientMsg, sanitizeInput, sanitizeView } from '../../src/net/sanitize';
import { NO_INPUT } from '../../src/sim/types';
import { Match } from '../../src/sim/match';
import { Bot } from '../../src/sim/bots/bot';

describe('camera mode rides on the input (spectators follow it)', () => {
  test('sanitized: 0/1 kept, anything else dropped', () => {
    expect(sanitizeInput({ ...NO_INPUT, view: 1 })?.view).toBe(1);
    expect(sanitizeInput({ ...NO_INPUT, view: 0 })?.view).toBe(0);
    expect(sanitizeInput({ ...NO_INPUT, view: 7 })?.view).toBeUndefined();
  });

  test('the sim carries it on the player (bots stay third person)', async () => {
    const m = await Match.create({ players: [{ name: 'A', isBot: false }, { name: 'B', isBot: true, difficulty: 'easy' }], seed: 2 },
      { makeBot: (id, d, rng) => new Bot(id, d, rng) });
    let s = m.tick(new Map([[1, { ...NO_INPUT, view: 1 as const }]]));
    expect(s.players.find((p) => p.id === 1)!.view).toBe(1);
    expect(s.players.find((p) => p.id === 2)!.view ?? 0).toBe(0);
    s = m.tick(new Map([[1, { ...NO_INPUT, view: 0 as const }]]));
    expect(s.players.find((p) => p.id === 1)!.view).toBe(0);
  });
});

describe('ViewExtras (build ghost, open panel) from a player', () => {
  const good = { ghost: { kind: 'wood', x: 1.5, y: 2, z: -3, rotY: 0.5, ok: true }, panel: 'shop', hover: 'rifle' };

  test('valid ones pass; bad fields are dropped or rejected', () => {
    expect(sanitizeView(good)).toEqual(good);
    expect(sanitizeView({ ghost: null, panel: 'vault', hover: null })).toEqual({ ghost: null, panel: 'vault', hover: null });
    expect(sanitizeView({ ...good, panel: 'admin', hover: 'nuke' })).toEqual({ ...good, panel: null, hover: null });
    expect(sanitizeView({ ...good, ghost: { ...good.ghost, kind: 'tank' } })).toBeNull();
    expect(sanitizeView({ ...good, ghost: { ...good.ghost, x: Infinity } })).toBeNull();
    expect(sanitizeView({ ...good, ghost: { ...good.ghost, y: 1e9 } })).toBeNull();
    expect(sanitizeClientMsg({ t: 'view', v: good })).toEqual({ t: 'view', v: good });
    expect(sanitizeClientMsg({ t: 'view', v: 'x' })).toBeNull();
  });

  test('a ghost + panel message stays tiny (~4 Hz)', () => {
    expect(JSON.stringify({ t: 'view', id: 3, v: good }).length).toBeLessThan(200);
  });
});
