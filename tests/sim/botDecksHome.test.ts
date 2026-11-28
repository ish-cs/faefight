import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { v3 } from '../../src/sim/vec';

// bot-measure ffa8-mixed seed 22 (NET 42 r3): a Hard bot off a rival's island with no decks and no walk home stood
// 322 s: 'bridge' needs decks, and 'shop' read a short list ($124: a few decks) as "saving up" (score 0). Decks to
// get home are an urgent buy, like a gun or a charge.
describe('stranded off home with no decks', () => {
  test("a Hard bot on a rival island scores the shop trip for decks as urgent, not 'saving up'", async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'hard' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const far = m.def.islands[1];
    m.debugTeleport(2, v3(m.def.islands[0].center.x, m.def.islands[0].groundY + 0.1, m.def.islands[0].center.z));
    m.debugTeleport(1, v3(far.center.x, far.groundY + 0.1, far.center.z));
    m.debugGive(1, { cash: 30 });
    const br = m.botBrain(1) as unknown as { watch(on: boolean): void; debugBrain(): { scores?: [string, number, number, [string, number][], string?][] } };
    br.watch(true);
    const whys = new Set<string>();
    let urgent = 0;
    for (let i = 0; i < 30 * 40; i++) {
      m.tick(new Map());
      if (i % 30) continue;
      const shop = br.debugBrain().scores?.find((r) => r[0] === 'shop');
      if (!shop) continue;
      whys.add(shop[4] ?? shop[3].map(([k]) => k).join('+'));
      if (shop[3].some(([k]) => k === 'urgent buy')) urgent++;
    }
    if (process.env.DH_TRACE) console.log('whys', [...whys].join(' | '), 'urgent', urgent);
    m.dispose();
    expect(urgent).toBeGreaterThan(5);
  }, 120_000);
});
