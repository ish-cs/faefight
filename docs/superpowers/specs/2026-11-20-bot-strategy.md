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
