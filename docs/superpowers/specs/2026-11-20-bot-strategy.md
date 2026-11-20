# FAEFight — Bot game sense, strategy and personalities

Date: 2026-11-20 · Scope: `src/sim/bots/**`, `BotView` (+ `Match.botView`).
Ground rules from Ishaan: no bot-only rules, bots only know what a human could know from the screen/HUD,
difficulty = human skill (reaction, aim, decision speed, sloppiness), never artificial gates.

## 1. What wins this game

You win by being the last player not eliminated. Elimination needs two things: your bunker sealed **and** you dead.
Kills alone never end anything before sudden death, so a kill is only worth as much as what it sets up:

- **Kill + seal inside the 3 s respawn window** → the victim respawns trapped, with fists only. Fists do 7 dmg/hit to
  wood and 5 to sandbags (2 hits/s): clearing even one plug takes 15–18 s, longer than the 10 s breakout window.
  So a seal on a respawning player is in practice an elimination.
- **Seal while the owner is away** (out bridging, fighting someone else) → their next death is final. In an 8-player
  FFA owners are away a lot; an empty island with open doors is the best opportunity on the map.
- **Kill** → they drop everything they carried (loot bag) and come back unarmed. For ~20–40 s a freshly respawned
  player is the weakest thing on the map (needs to get to the vault/shop and rebuy).

## 2. Economy curve and openings

Generator: $5/s, cap $500 (full after 100 s, then wasted). Start $50. So ~$300/min.

| Item | Cost | Why |
|---|---|---|
| Pistol | 50 | first gun; fists can't hurt metal/steel |
| Bridge to a neighbour | ~10 scaffolds = $200 | adjacent islands have ~36 m of water; second neighbours ~100 m (~$560) |
| Seal kit | 3 wood $75 · 3 metal $180 · 3 steel $450 | wood (2.0 m) already seals; harder plugs survive bullets |
| Charge | 250 | the only practical way through metal/steel |
| SMG / rifle | 150 / 300 | win duels; rifle wins at range |

Openings that fall out of this:
- **Rush** (≈90–120 s): pistol → scaffolds → 3 wood. First to bridge picks the fight; a neighbour still shopping is easy.
- **Turtle/greed** (≈3–4 min): pistol → SMG/rifle → metal kit; let others bleed each other, collect, defend, then strike.
- **Economist**: bank cash in the vault and buy the best gear before leaving; slower but survives deaths.

## 3. Risk of leaving home

Leaving home = your generator fills (or is stolen: anyone can collect it), your bunker is unguarded (can be sealed),
and everything you carry is at risk. A bridge you finish is also a bridge **into** your island. Counter-play:
- bank carried cash in the vault before a trip or when danger is near (death drops everything carried);
- carry a full seal kit before finishing a bridge (otherwise you opened a road for nothing);
- watch the kill feed / seal states: "your bunker SEALED" means go home and clear it before you die.

## 4. FFA with up to 7 rivals: target choice and third-partying

Every rival is scored, not just the nearest:
reachability (finished bridges, including ones other players built, and how many scaffolds a new one needs) ·
distance · weakness (dead/respawning, just respawned unarmed, low HP when seen, bunker already sealed) ·
threat to me (bridge into my island, seen on my island) · revenge (who just shot me, decays) ·
the leader (most kills on the scoreboard) · busy (seen shooting at someone else → third party).
Commitment: the current target keeps a bonus that grows with patience, and is only dropped when another is clearly
better or its cost rises (it got sealed by someone else, it was eliminated, the bridge got cut).
Third-partying is the core FFA skill: two players fighting each other are both damaged and both looking the wrong way.

## 5. Defending vs attacking

Defend when: enemies are on my island or near my bunker, a bridge leads into my island, my bunker is sealed (clear it
while alive — after death it is too late), or I'm carrying a lot and danger is near (bank first).
Attack when: I have a gun, a kit for the doors that are open, and either the target is down or away from home.
Disengage when low HP or outgunned: there is no health regen, so a low-HP player who keeps fighting just donates a
loot bag. Back off toward home/cover, still shooting.
Use cover: the bunker (indestructible) and placed pieces; builders throw down a wall between themselves and a shooter.

## 6. Sudden death (15:00)

Generators stop, every bunker seals for good (no respawns), tide rises 0.05 m/s (land at y = 2 floods ~40 s later).
Get to high ground, kill the rest. Cash left in the vault is worthless now: spend it before.
A player can hop onto a 1 m sandbag, and a bag placed half on top of the previous one is supported, so ~$100 of
sandbags is a staircase tower: every metre buys 20 s against the tide. Bots buy 10–14 bags in the last 2.5 min
before 15:00, build in the open middle of the island they're on, and once up, stay up (stepping off = fall damage).

## 7. Personalities

Each bot rolls a personality at spawn from the match's seeded rng: an archetype preset plus jitter on continuous
traits (0..1): aggression, caution, greed, patience, vengeance, opportunism, builder, range.
Traits only shift utility weights and tactics; every bot can do everything.

| Archetype | Leans toward |
|---|---|
| Rusher | early bridge, nearest target, shotgun/SMG, fights through low HP |
| Turtle | guards home, banks, cuts incoming bridges, builds cover, strikes late with a metal kit |
| Vulture | third-parties, hunts the respawning/unarmed/sealed, steals generators, picks up loot |
| Economist | banks cash, saves for rifle + steel, late power spike |
| Sniper | rifle, long preferred range, keeps distance, high ground |

Names: bot seats with a placeholder name ("Bot (hard)", "") get a seeded, unique gamer nickname
(`src/sim/names.ts`, e.g. "Kestrel_77", "nobodyhome", "Wavy.Dan"). Archetype and difficulty stay out of the
visible name; `Bot.personality` exposes the archetype for debugging/tests.

## 8. What a bot may know (BotView)

Existing: own state, visible enemies (line of sight), others' public status, map, pieces, generator cash, seal states,
water/sudden death. Added (all on a human's screen): `hurt` (hits against me: who and how much — damage indicator +
kill cam), `shots` (tracers within sight range: who fired from where to where), `loot` (bags within sight range),
`kills` per player in `others` (scoreboard), `feed` (recent kill feed).

## 9. Skill ladder and the PRO pass

Difficulty is only human skill: reaction, aim, decision speed and decision mistakes. Every level runs the same game
sense below; better players just execute it faster and cleaner.

| | react | aim cone | tracking / flick cap | rethink every | hesitate | score noise | buy gap |
|---|---|---|---|---|---|---|---|
| Easy | 0.80 s | 14° | 4 / 6 rad/s | 1.6 s | 1.2 s | 0.30 | 3 s |
| Medium | 0.50 s | 8° | 6 / 8 | 1.0 s | 0.6 s | 0.15 | 1.5 s |
| Hard | 0.24 s | 3° | 11 / 11 | 0.5 s | 0.15 s | 0.08 | 0.6 s |
| PRO | 0.18 s | 1.5° (tightens to ~1°) | 16 / 12 (~690°/s) | 0.3 s | 0.05 s | 0.03 | 0.35 s |

PRO still misses at range (≈1° is ±0.5 m at 30 m) and can't flick faster than a hand. Hard and PRO also keep
**death insurance** ($75 in the vault: pistol + ammo) before leaving home, buy grenades/medkits when rich and a
steel seal kit when they can afford it. Easy never buys grenades; medium only when very rich.

Game sense (all levels):
- **Never linger in your own bunker.** Since the rule change, standing within 4 m of your own sealed bunker starts the
  10 s escape countdown. Bots walk out after respawning, disengage to *behind* the bunker (≥ 4.8 m out), guard and
  take cover from there, and never throw cover walls in front of their own doorways.
- **Escaping** (`bots/escape.ts`): an occupancy grid (seal.ts cells, walls and pieces grown by the player radius)
  gives a path around any wall inside or across a doorway. No path → break the piece that is cheapest to get through
  (hp ÷ material multiplier ÷ weapon dps; a charge counts as ~5 s for anything ≤ 1500 hp; doorway plugs preferred),
  facing it squarely from inside, charge planted then hide at the far side. Grenades are never used from inside
  (no spot in a 4×4 m room is outside the 4 m blast). The countdown makes this top priority.
- **Plugs in my own doorways** get cleared before going out (one plugged door is most of a seal); a hard plug with
  nothing to break it means: withdraw banked cash, buy a charge, blast it from outside the countdown radius.
- **Grenades**: thrown at a rival who ducked out of sight 0.3–2.5 s ago (6.5–22 m; high lob when one lands within the
  fuse, else the flat arc, which still bursts on the cover next to them), or flat through an open doorway at a rival
  inside their bunker. Throw error = the thrower's aim cone. `throwAngles` integrates the same per-tick physics.
- **Bridges**: routes chain over any number of other players' bridges (BFS). A rival out on a bridge toward my
  island → shoot the deck nearest my shore first (drop them in the water or strand them); an intruder I can't see →
  cut the bridge behind them.
- **Economy**: grab generator cash ≥ $40 before leaving and never let it reach the cap; bank excess; spend banked cash.
- **Healing**: medkit at ≤ 55 HP (hard/PRO; 45 medium, 35 easy) when nobody is close; low HP away from home without
  a medkit → go home and let regen work.
- **Snipers** take a sandbag tower 75 s before sudden death and shoot from it.
- **Respawn windows**: kill + seal as before; without a kit, wait at their door for the unarmed respawn.
- **No hurtful drops**: walking never steps off more than 3 m unless there's no other way.
- Unarmed bots back off only from guns close enough to matter (not a pistol across the water).

Measured (seeds alternate seats; 1v1s swing on one early kill, so 20 seeds):

| Series | Result |
|---|---|
| PRO vs Hard 1v1, seeds 1–20 | PRO 15/20 (before shields/potions landed: 16/20, seeds 1–30 23/30) |
| Hard vs Medium 1v1, seeds 1–20 | Hard 19/20 |
| 8 PRO FFA, seeds 1–3 | winners at 15.1 / 13.7 / 15.2 min · 49–72 kills · 6–9 seals · 5–7 pre-SD eliminations · 0.51–0.72 ms/tick |
| Mixed FFA (2 each), seeds 1–3 | draw / Hard / Medium at 15.7–15.8 min · 33–43 kills · 6–8 seals · 5–6 pre-SD eliminations · 0.50–0.59 ms/tick |

Open: with shields in, 8-PRO FFAs mostly end just after sudden death starts (last two or three standing), not before.

`MEASURE=1v1|ffa [A=pro B=hard SEEDS=1,2,3 TRACE=10] npx vitest run tests/sim/proMeasure.test.ts` reproduces these.
