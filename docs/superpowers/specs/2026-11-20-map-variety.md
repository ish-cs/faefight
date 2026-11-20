# FAEFight — Map variety (design note, not scheduled)

Date: 2026-11-20 · Status: **phase 1 built** (see §8); later phases still design only.
Scope when built: `src/sim/map.ts`, `src/sim/physics.ts`, `src/sim/bots/{nav,bot}.ts`, `src/client/world/*`, `src/net/protocol.ts`, lobby UI.

## 1. Where we are today

- `buildMap(n)` puts n identical discs (radius 22, top y = 2) on a ring, edge-to-edge gap 36 m (`MAP.gap`). Bunker at the
  back (`r − 7` from centre, facing inward), generator / vault / shop at fixed local offsets. Water = global kill plane
  `waterY` (pos.y < waterY kills; sudden death raises it 0.05 m/s).
- Physics: one cylinder collider per island + bunker boxes + 3 prop boxes. Nothing else static.
- Seal check (`seal.ts`) only looks at bunker walls + placed pieces inside ±8 m (`SEAL.half`) of the bunker.
- Bots (`nav.ts`) assume a **straight lane** between island centres, offset 3 m right (`LANE_OFFSET`), scanned with
  `groundAt`. `hop()` allows one intermediate island. `withinIsland()` only routes around the bunker. `bot.ts` hardcodes
  `sqrt(r² − 9)` (land edge along a lane) in two places.
- Client art: `buildIslands()` assumes one shared radius/groundY; backdrop is harbor scenery behind each island; water
  shader shades shallows from island discs. Clients run **no physics** and receive the full `IslandLayout[]` in the
  `start` message, so the host's map data is already the single source of truth.

## 2. Goals and constraints

| # | Constraint | Consequence for design |
|---|---|---|
| 1 | Fair for 2–8 players: every island equivalent | Maps are **C_n rotationally symmetric**: author one sector, rotate it n times. No per-island randomness. |
| 2 | Sealing/bunker rules unchanged | Bunker geometry, 3 doorways, `isSealed` untouched. **No static map geometry within 9 m of a bunker** (seal grid radius 8 + 1), so seal results can't depend on map statics. |
| 3 | Bots must still navigate | Every template ships nav data (dock anchors, links, obstacles). Fairness tests include reachability; bot-vs-bot soak per template. |
| 4 | $0 procedural art | Reuse the `props.ts` kit (containers, cranes, warehouses, palms, drums, pallets) + new low-poly procedural pieces; textures stay canvas/procedural or CC0. |
| 5 | 60 fps on base M1 Air | Static decor merged via `StaticBatch` (as now); budget ≤ +30 draw calls and ≤ +150k tris per theme; weather effects behind the existing quality toggle. |
| 6 | Water = death stays the core rule | Every hazard surface (sea, lava, drop) uses the existing `waterY` kill plane or a fall; no new death mechanic needed for v1. |

## 3. Concepts (all original settings)

Numbers: scaffold = 4 m deck, $20. Bridge cost ≈ gap / 4 × $20.

### 3.1 Harbor (current, baseline)
```
        [I2]
   [I1]      [I3]        ring, 36 m gaps, flat discs
        ~sea~            bridge ≈ 9–10 scaffolds ($200)
   [I0]      [I4]
```
Gameplay: reference. Visual: sunny tropical harbor (as built). Cheap variants with **zero gameplay change**:
*Harbor Dusk* (low warm sun, long shadows, lit masts) and *Storm Harbor* (see 3.6).

### 3.2 Container Yard Archipelago
```
     [▣ ▣ I1 ▣]          smaller islands (r 19), gap 26 m → ~7 scaffolds ($140)
  ▣▣                     2–3 symmetric container stacks per island (static, indestructible)
  [I0 ▣ ▣]  ~~  [▣ I2]   stacks 2.6 / 5.2 m high, climbable with a ramp piece
     ▣▣ = cover/high ground, kept ≥ 9 m from bunker
```
Gameplay: faster, cheaper rushes; natural cover and rooftop high ground (sniper archetype matters); line-of-sight broken
between islands. Visual: stacked containers in team-neutral colours, gantry cranes over gaps (decor only, out of reach),
reefer hum, forklifts. **Closest to existing art kit → cheapest real-gameplay variant.**

### 3.3 Caldera (volcanic islands, lava sea)
```
        [I1]
   [I0]   ( N )   [I2]     N = neutral centre islet (r 10) with BONUS generator
        [I3]               player gaps 40 m; player→N gap 30 m
       ~~lava~~            lava = waterY kill plane, emissive shader
```
Gameplay: a contested objective. Neutral generator: anyone collects, e.g. $8/s, cap $300 (❓ rules below). Pulls fights
to the middle; whoever bridges to N first opens a road to everyone (bridge-to-N is a commitment). Sudden death:
"lava rises" = existing tide. Visual: black basalt discs (procedural noise displacement on the rim only, top stays flat),
orange emissive lava with crust noise, heat shimmer post (high quality only), ash particles, smoking cone backdrop.

### 3.4 Oil-Rig Platforms
```
   [P1]═══╗     ╔═══[P2]      P = steel deck at y 8 on legs, 2 tiers (deck + helipad at y 12 via static stairs)
          ╠═(H)═╣             ═ = pre-built catwalk to central hub H (narrow, 1.5 m, destructible? ❓)
   [P0]═══╝     ╚═══[P3]      gaps between player decks 34 m (bridge still needed rim-to-rim)
```
Gameplay: verticality (fall damage from tiers, shooting down), pre-built but exposed chokepoint routes to the hub vs.
safer self-built bridges. Water 8 m below: falling in still kills; tide takes ~160 s to reach decks → per-map
`tideRate` (e.g. 0.12). Visual: rusty steel grating (procedural texture), pipes, flare stack with flame, helipad markings,
grey-green open sea with swell.

### 3.5 Stilt Village in Fog
```
   (a)─(b)        each "island" = 3 stilt platforms (a,b,c) joined by fixed boardwalks
     \ /          platforms 9–11 m radius; gaps between villages 32 m
     (c)  ~~~ fog ~~~  (a')─(b') ...
```
Gameplay: home base is spread out (bunker on one platform, generator/shop on another) → defending costs movement;
fog limits sight to ~45 m (rifles weaker, ambush play). Bot `SIGHT_RANGE` must follow the fog (bots see what a human
sees). Visual: weathered wood planks, nets, lanterns, tin roofs, scene fog + muted palette (cheap: fog is free in three).

### 3.6 Night Storm Harbor
Same layout as Harbor (or Container Yard). Night lighting, rain streaks, wet-specular ground, lightning flashes that
light the whole map for ~0.3 s. Optional hazard (phase 4): every ~45 s lightning hits the **tallest player piece** on
the map (destroys it) — counters sudden-death sandbag towers. Gameplay otherwise unchanged; sight effectively shorter.

## 4. Procedural vs hand-authored

**Recommendation: hand-authored layout templates + seeded, symmetric variation + procedural $0 dressing.**

- Fully procedural layouts can't guarantee fairness, seal-zone clearance, or bot navigability without a validator as
  big as the generator. Templates are few, each validated by tests.
- A template defines one **sector** (island-local frame) and parameters with allowed ranges (gap, radius, cover set
  pick, prop angle offset). A seed picks values **once per match, applied identically to every sector**.
- Dressing (palms, clutter, backdrop, colour jitter) stays seeded per island, decorative only, no colliders.

### 4.1 Data format (sim-owned, plain JSON-able)

```ts
type MapDef = {
  template: 'harbor' | 'yard' | 'caldera' | 'rig' | 'stilts';
  theme: 'day' | 'dusk' | 'storm' | 'fog' | 'lava';   // client-only look; never affects sim
  seed: number;                                      // dressing rng + variation pick
  waterY: number; tideRate: number;                  // kill plane (sea or lava)
  islands: IslandLayout[];                           // existing type, + shape + home flag
  neutrals: { center: Vec3; radius: number; groundY: number; generator?: { pos: Vec3; rate: number; cap: number } }[];
  statics: { id: number; shape: 'box' | 'ramp'; center: Vec3; half: Vec3; rotY: number;
             role: 'cover' | 'walkway' | 'stairs' }[];   // colliders: physics + camera + nav obstacles
  links: { a: NavNodeRef; b: NavNodeRef; path: Vec3[]; width: number }[];   // pre-built walkable routes
  docks: { node: number; toward: number; at: Vec3 }[];  // where bots start a bridge toward another node
};
// IslandLayout gains: shape: { kind: 'disc'; radius } | { kind: 'platforms'; discs: {center; radius}[] }
```

Decorative props are **not** in `MapDef`; the client derives them from `template + theme + seed`.

### 4.2 Consumers

| Consumer | Change |
|---|---|
| `map.ts` | `buildMap(n)` → `buildMap(n, template = 'harbor', seed)` returning `MapDef`; `harbor` must reproduce today's output exactly. Ring radius = max(current formula, centre-island clearance). |
| `physics.ts` | `Physics.create(def)`: add one cylinder per disc (islands + neutrals + platforms), `addStaticBox` per static (`world` type). `support.ts` already treats `world` hits as ground → pieces can rest on statics, no change. |
| `seal.ts` | None (guarded by the 9 m clear-zone test). |
| `lifecycle.ts` / `match.ts` | `waterY`, `tideRate` from def; neutral generator reuses economy collect logic with no owner. |
| `bots/nav.ts` | See §5. |
| `client/world` | `buildIslands(def)`: per-template builder (shape + statics meshes = exact colliders, like bunkers today) + per-theme materials/sky/water shader params; `buildWater` takes all discs incl. neutrals; `sky.ts` gets theme presets (sun angle, fog, exposure). |
| `net/protocol.ts` | `start.map: MapDef` (was `IslandLayout[]`); `lobby` carries chosen template/theme; bump `NET_VERSION` 2 → 3. |

## 5. Impacts

**Bots**
- Replace "lane between centres" with a small **nav graph**: nodes = islands + neutrals + platforms; edges = `links`
  (pre-built, always walkable), finished bridges (detected by today's `frontier` scan, but started from template `docks`
  instead of centre + 3 m offset), and *buildable* edges with cost = scaffolds needed. `hop()` (1 intermediate) →
  Dijkstra over ≤ 9–27 nodes, cached per tick like `frontier`.
- `withinIsland()`: obstacles = bunker + `statics` on that island. Simplest: precompute a 0.5 m walk grid per island at
  match start (r 22 → 88 × 88 ≈ 7.7k cells, A* well under 1 ms) and keep the bunker doorway logic as is.
- `islandAt()` uses shape (multi-disc), and `bot.ts`'s two `sqrt(r² − 9)` copies move into a nav helper (`landEdge`).
- New utility goal **contest neutral** (bonus generator), weighted by greed/opportunism; Vulture camps it. Sniper
  values `statics` with role `cover` on high ground. Sight range comes from theme visibility, same for humans.

**Networking**
- Host already ships the whole map; ship `MapDef` instead (few KB once). Seed included so clients build identical
  dressing; no client physics, so no desync risk from colliders. Version bump rejects old clients cleanly.

**Tests** (Vitest, per template × n = 2..8 × 5 seeds)
- Symmetry: every island's POIs, statics, docks, links transformed into island-local frame are equal (1e-6).
- Distances: neighbour edge gaps equal; each island's distance to every neutral equal.
- Clearance: no static within 9 m of any bunker; POIs on solid ground (physics probe); POIs ≥ 3 m apart (existing test).
- Reachability: every node reaches every other in the nav graph via links + buildable edges; every link path is
  walkable (`groundAt` probe every 0.25 m, step-ups ≤ 0.35 m).
- `harbor` golden test: `buildMap(n, 'harbor')` deep-equals today's `buildMap(n)`.
- Bot soak (existing headless pattern): per template, bot-vs-bot matches finish, ≥ 1 seal happens, no bot stuck > 20 s.
- Visual: `tests/visual/lab.ts` screenshot per template/theme; frame-time check on low/high quality.

## 6. Phased plan

| Phase | Delivers | Effort |
|---|---|---|
| 0 | `MapDef` refactor + harbor golden test; physics/client/protocol consume it. No visible change. | 1 day |
| 1a | Theme presets on Harbor: Dusk + Night Storm (lighting, fog, rain, lightning flash; no hazard). Lobby picker. | 1–2 days |
| 1b | **Container Yard** template: smaller gaps, static cover + high ground, nav walk grid, fairness test suite. *Smallest step that changes how matches play.* | 3–4 days |
| 2 | **Caldera**: neutral centre + bonus generator, lava theme, nav graph (Dijkstra), contest-neutral bot goal. | 4–6 days |
| 3 | **Oil Rig** + **Stilt Village**: pre-built links, tiers/stairs, multi-disc islands, per-map tide rate, fog sight. | 6–8 days |
| 4 | Hazards (lightning on tallest piece), seeded variation knobs per template, "random map" rotation. | 2–3 days |

Recommended order: 0 → 1b → 1a → 2 → 3 → 4 (1a can run in parallel with 1b; different files).

## 7. Open questions for Ishaan

- ❓ Neutral bonus generator: anyone collects (proposed), or captured/owned until someone else stands on it?
- ❓ Map statics (container stacks, catwalks): indestructible (proposed, keeps nav simple), or breakable like pieces?
- ❓ Who picks the map: host in lobby (proposed), random each match, or both?
- ❓ Lightning hitting the tallest piece: fun counter to towers, or too random?

## 8. Phase 1 as built (2026-11-20)

Decisions (Ishaan): built-in cover unbreakable, cosmetic props breakable · host picks the map or Random · center island on
every map with bonus generators · potions sold by an NPC on the center island.

- [x] `MapDef` (`src/sim/map.ts`): `template`, `name`, `seed`, `waterY`, `tideRate`, `islands`, `center`, `statics`,
  `cosmetics`. `buildMapDef(n, template, seed)`; `buildMap(n)` = harbor islands, golden-tested against the original code.
  Host sends the MapDef in `start` (NET_VERSION 4); lobby message carries the map choice.
- [x] Neutral **center island** on every map, equally far from every island, no pre-built walkways. 3+ players: at the
  ring centre (radius 10–14, gap ≥ 8 m). 2 players: off to the side on the bisector, island→center gap = half the island
  gap, so it is a detour, not a cheap stepping stone on the direct route (on the axis it halved 1v1 bridging and
  flattened the bot skill ladder: PRO beat hard 11/20 instead of 15/20). Stations: **gold generator** (2× home rate, cap $1000, anyone collects, first come first served),
  **supply generator** (a free sandbag every 8 s up to 10, a steel plate every 60 s up to 2; collected with E; a new kind
  needs a free hotbar slot, what doesn't fit stays), **shield well** (stand in it: +4 shield/s up to 50), **potion seller
  NPC** (`match.potionShops` = `[center.potionShop]`). Three low concrete barriers as cover. All stop in sudden death.
- [x] **Cover vs cosmetics**: `statics` are solid `world` colliders (bullets/explosives can't touch them, pieces rest on
  them, camera/anti-ESP occluders, bot obstacles). `cosmetics` (barrels, crates, fences, palms, lamps, bollards) have
  sim-authoritative hp but **no colliders**: bullets pass through and damage them, explosions break them, the snapshot
  lists `broken` ids, `cosmeticBroken` events drive debris. They can never affect movement, seals or support.
- [x] **Container Yard** template: r 19 islands, 26 m gaps (the ring grows a few cm at n = 3 to keep the center gap), three
  container statics per island (1-high and 2-high flank stacks, a 1-high front wall), all ≥ 9 m from the bunker.
- [x] Map picking: lobby dropdown (Harbor / Container Yard / Random) for the host, read-only for joiners; vs-bot menu
  dropdown (remembered). Random never repeats the previous map of that host session (rematches included).
- [x] Bots: nav nodes = islands + center; Dijkstra over finished bridges; per-node 0.5 m walk grid + A* around cover
  (straight line when clear); walk to a bridge's start around cover first; `contest` goal (gold/supplies);
  greedy/opportunist bots bridge to the center first when it's not much further than their rival.
- [x] Tests: harbor golden, fairness per template × 2..8 players, 9 m bunker clearance, ground probes, walk-grid
  reachability, center stations, cover indestructible, cosmetics breakable, Random no-repeat, yard bot soaks.

- [x] **Bunker firing slits** (approved later the same day): a 0.6 × 0.18 m slit at 1.35–1.53 m in each door-wall
  segment and two in the back wall (8 per bunker). `bunkerWallBoxes(b)` splits the walls around them; slit plugs
  (`bunkerSlitBoxes`) block players, grenades and rockets, while bullets and bot/anti-ESP sight pass
  (`Physics.raycast(..., throughSlits)`). `isSealed` and the bot escape grid use whole walls (`bunkerWallBoxes(b, false)`),
  so seals are unchanged.

Left for later phases: more templates (Caldera, Rig, Stilts), themes (dusk/storm/fog), pre-built walkways/links,
seeded variation knobs, hazards.
