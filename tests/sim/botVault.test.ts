import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { VAULT_LEVELS } from '../../src/sim/constants';
import { DEFAULT_BOT_PARAMS } from '../../src/sim/bots/params';
import type { Difficulty, PlayerState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

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
    let banked = 0, paid = 0, restocked = 0, interest = 0;
    for (const g of games) {
      const u = await play(g.diffs, g.seed);
      lines.push(`seed ${g.seed}: deposits ${u.deposits} ($${Math.round(u.banked)}), vault-paid buys ${u.vaultPaid}, restocks ${u.restocks}, upgrades ${u.upgrades}, interest $${u.interest}`);
      interest += u.interest;
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
    // Banked cash earns interest. Vault levels: the deterministic scenario below. Summing upgrades over these 3 seeds
    // was a lottery: 4 on main 979bb0c8, 0 on the bot-freeze branch, which buys a level in more games over 36 (19/36
    // vs main's 17/36).
    expect(interest).toBeGreaterThan(0);
  }, 600_000);

  // One fixed setup, no seed lottery: a bot standing next to its own vault (a medkit held, so no heal comes first), an
  // idle human on the far island. With the next level's price plus VaultParams.upgradeAt to spare it buys the level
  // (bank goal → vault action upgrade) within seconds; below the price it doesn't.
  async function vaultRun(d: Difficulty, cash: number) {
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: d }, { name: 'idle', isBot: false }], seed: 5 });
    const me = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(1)!;
    let snap: Snapshot = m.tick(new Map());
    const isl = m.map[0], vault = isl.vault;
    const k = 2.5 / Math.hypot(isl.center.x - vault.x, isl.center.z - vault.z); // 2.5 m from the vault, toward the island centre
    m.debugTeleport(1, v3(vault.x + (isl.center.x - vault.x) * k, isl.groundY + 0.05, vault.z + (isl.center.z - vault.z) * k));
    m.debugGive(1, { cash: cash - me.inv.cash, medkits: 1 });
    let at = -1;
    const t0 = snap.time;
    for (let i = 0; i < 15 * 30 && at < 0; i++) {
      snap = m.tick(new Map());
      if (snap.events.some((e) => e.type === 'vaultUpgrade' && e.data.player === 1)) at = snap.time - t0;
    }
    const r = { at, level: me.vaultLevel ?? 1 };
    m.dispose();
    return r;
  }
  for (const d of ['medium', 'hard', 'pro'] as Difficulty[]) {
    test(`${d}: rich next to its vault → buys the next vault level within 10 s; short of its price → doesn't`, async () => {
      const price = VAULT_LEVELS[1].price;
      const rich = await vaultRun(d, price + DEFAULT_BOT_PARAMS.vault.upgradeAt[d] + 100);
      console.log(d, 'rich', JSON.stringify(rich));
      expect(rich.at).toBeGreaterThanOrEqual(0);
      expect(rich.at).toBeLessThan(10);
      expect(rich.level).toBe(2);
      const poor = await vaultRun(d, price - 50);
      console.log(d, 'poor', JSON.stringify(poor));
      expect(poor.at).toBe(-1);
      expect(poor.level).toBe(1);
    }, 60_000);
  }
});
