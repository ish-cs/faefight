import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { v3 } from '../../src/sim/vec';

// bot-measure ffa8-mixed seed 14 (116 s): a PRO stood on two of its own stacked sandbags beside its vault, "depositing"
// every 1.2 s. In 2D it was at the vault; the sim wants a depositor within 2 m of the vault's height, and it stood 2 m
// up. It steps off and banks.
describe('banking from up on a stack', () => {
  test('a PRO on two stacked sandbags at its vault steps down and deposits', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const v = m.def.islands[0].vault;
    const at = v3(v.x + 0.9, v.y, v.z);
    m.debugPlacePiece('sandbags', at, 0, 1);
    m.debugPlacePiece('sandbags', v3(at.x, at.y + 1, at.z), 0, 1);
    m.debugTeleport(1, v3(at.x, at.y + 2.05, at.z));
    m.debugGive(1, { cash: 600 });
    m.debugSetTime(5 * 60);
    let vault0: number | null = null, banked = 0;
    for (let i = 0; i < 30 * 30; i++) {
      const s = m.tick(new Map());
      const p = s.players.find((q) => q.id === 1)!;
      vault0 ??= p.vault.cash;
      banked = Math.max(banked, p.vault.cash - vault0);
    }
    m.dispose();
    expect(banked).toBeGreaterThan(0);
  }, 60_000);
});
