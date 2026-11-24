import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const LIMIT = 9 * 60 * 30;

type Use = { deposits: number; banked: number; vaultPaid: number; restocks: number; upgrades: number; interest: number; loadouts: Set<number> };

/** One bot match (capped at 9 min): deposits, $ banked, shop buys paid from the vault, respawn restocks. */
async function play(diffs: Difficulty[], seed: number) {
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const use: Use = { deposits: 0, banked: 0, vaultPaid: 0, restocks: 0, upgrades: 0, interest: 0, loadouts: new Set() };
  let snap: Snapshot = m.tick(new Map());
  const prev = new Map<number, { inv: number; vault: number }>();
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) { if (e.type === 'restock') use.restocks++; if (e.type === 'vaultUpgrade') use.upgrades++; }
    for (const p of snap.players) {
      if (p.loadout) use.loadouts.add(p.id);
      const b = prev.get(p.id);
      if (b) {
        const dv = p.vault.cash - b.vault, di = p.inv.cash - b.inv;
        if (dv > 0 && di < 0) { use.deposits++; use.banked += dv; }
        else if (dv > 0 && di === 0) use.interest += dv;
        // Vault cash spent without coming out into the pocket: a shop (or restock) paid from the vault.
        if (dv < 0 && di <= 0) use.vaultPaid++;
      }
      prev.set(p.id, { inv: p.inv.cash, vault: p.vault.cash });
    }
  }
  m.dispose();
  return use;
}

describe('bots and the vault', () => {
  test('bots bank, set restock loadouts, spend from the vault, restock on respawn and upgrade the vault', async () => {
    const games: { diffs: Difficulty[]; seed: number }[] = [
      { diffs: ['pro', 'hard', 'medium', 'easy'], seed: 1 },
      { diffs: ['hard', 'pro', 'hard', 'medium'], seed: 2 },
      { diffs: ['pro', 'hard'], seed: 3 },
    ];
    const lines: string[] = [];
    let banked = 0, paid = 0, restocked = 0, upgraded = 0, interest = 0;
    for (const g of games) {
      const u = await play(g.diffs, g.seed);
      lines.push(`seed ${g.seed}: deposits ${u.deposits} ($${Math.round(u.banked)}), vault-paid buys ${u.vaultPaid}, restocks ${u.restocks}, upgrades ${u.upgrades}, interest $${u.interest}`);
      upgraded += u.upgrades; interest += u.interest;
      // Every hard/PRO/medium bot sets its loadout (easy has none).
      g.diffs.forEach((d, i) => { if (d !== 'easy') expect(u.loadouts.has(i + 1), `seed ${g.seed} bot ${i + 1} (${d}) loadout`).toBe(true); });
      if (u.deposits > 0) banked++;
      if (u.vaultPaid > 0) paid++;
      if (u.restocks > 0) restocked++;
    }
    console.log(lines.join('\n'));
    expect(banked).toBe(games.length);
    expect(paid).toBeGreaterThanOrEqual(2);
    expect(restocked).toBeGreaterThanOrEqual(2);
    // Rich bots buy vault levels; banked cash earns interest.
    expect(upgraded).toBeGreaterThanOrEqual(1);
    expect(interest).toBeGreaterThan(0);
  }, 600_000);
});
