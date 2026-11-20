# FAEFight Stage 1 (Offline vs Bots) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playable 1v1 browser match against a bot: islands, generator, vault, shop, building, shooting, spawn sealing, elimination, sudden-death tide. Placeholder art at final dimensions.

**Architecture:** Pure-TS simulation (`src/sim/`) with Rapier physics, fixed 30 Hz tick, no DOM. It runs in a Web Worker (`src/client/worker.ts`); the main thread renders snapshots with Three.js and sends inputs. Bots live inside the sim and produce the same `PlayerInput` a human does. This is the seam stage 2 reuses for networking.

**Tech Stack:** TypeScript, Vite 8, Three.js 0.187 (`three/webgpu` WebGPURenderer, WebGL2 fallback), @dimforge/rapier3d-compat 0.21, Vitest 5, @playwright/test 1.65, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-19-faefight-design.md`

## Global Constraints

- $0: no paid services, no paid assets.
- Target MacBooks (Apple Silicon), Chrome + Safari, 60 fps on base M1 Air.
- Keyboard + mouse or trackpad (pointer lock, adjustable sensitivity).
- Third-person over-shoulder camera.
- Placeholder art must use final dimensions (from `constants.ts`). No voxel/cube building aesthetic in final art (stage 3).
- Sim never imports `three` or DOM APIs.
- Commit messages: plain, no AI attribution.

## Review Focus

1. Sealing with low pieces: sandbags (1.0 m) alone are jumpable and must NOT seal; stacked sandbags (2.0 m) must. → Task 5 test `low pieces do not seal, stacked do`.
2. Owner clears own doorway while alive → respawn works again (live check at respawn moment). → Task 8 test `unsealing before respawn restores respawn`.
3. Player dies in water → drop is lost (not floating loot); dies on land → loot bag anyone can grab. → Task 8 test `death in water loses drop`.
4. Buying with insufficient carried cash (vault cash doesn't count) → rejected, no state change. → Task 3 test `cannot spend vault cash`.
5. Bot gets stuck (e.g. at island edge or own walls) → must still make progress; bot-vs-bot match must end within sudden-death bounds. → Task 10 test `bot vs bot match ends`.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, playwright.config.ts, index.html
src/sim/constants.ts     all tunable numbers (pieces, weapons, economy, timings)
src/sim/types.ts         shared state + input types
src/sim/map.ts           island layout for N players
src/sim/physics.ts       Rapier wrapper: static world, piece colliders, character controller, raycast
src/sim/economy.ts       generator, collect, vault, shop purchases
src/sim/building.ts      snap, validity, place, damage pieces
src/sim/seal.ts          flood-fill seal detection
src/sim/combat.ts        weapons, fire/reload, hitscan, explosives
src/sim/lifecycle.ts     death drop, loot pickup, respawn, invuln, elimination, win, tide
src/sim/match.ts         Match class: owns state, tick(inputs), snapshot()
src/sim/bots/bot.ts      utility brain → PlayerInput
src/client/main.ts       menu, boot worker, game loop
src/client/worker.ts     runs Match at 30 Hz, posts snapshots
src/client/input.ts      keyboard/mouse → PlayerInput
src/client/render.ts     scene, placeholders, snapshot sync, interpolation
src/client/camera.ts     third-person camera
src/client/hud.ts        HUD, shop/vault panels, build ghost, banners
tests/sim/*.test.ts      unit tests per sim module
tests/e2e/smoke.spec.ts  browser smoke
```

## Key numbers (constants.ts, copy exactly)

- `TICK_HZ = 30`; player: `HP 100`, radius 0.35, height 1.8, walk 5 m/s, sprint 7.5, jump velocity 4.6 (≈1.1 m), gravity 9.81.
- Map 1v1: island centers (±40, 0, 0), radius 22, ground top y = 2, water y = 0 → 36 m gap edge-to-edge.
- Bunker: interior 4×4 m, concrete walls 0.3 m thick, 2.6 m tall, indestructible; 3 doorways 1.6 m wide × 2.2 m tall on the sides facing N, E/W toward island interior (not toward the back edge). Spawn pad at bunker center.
- Pieces `{w, h, d, hp, price, placeSec}`:
  sandbags 2×1.0×0.8, 150, $10, 0.5 · wood 2×2.0×0.2, 250, $25, 0.8 · metal 2×2.5×0.1, 500, $60, 1.2 · steel 2×2.5×0.15, 1200, $150, 2.0 · scaffold 2×0.2×4 (walkable deck), 200, $20, 0.6 · ramp 2 wide, 1.5 rise, 3 long, 200, $30, 0.8 · container 6×2.6×2.4, 2500, $300, 3.0.
- Snap: position 0.5 m grid, rotation 15° steps; free-place flag disables snap. Reach 5 m. Pieces may stack (supported by ground, scaffold, or another piece top). Scaffold may extend over water if its near end touches ground/scaffold.
- Weapons `{price, dmg, rps, mag, reloadSec, range}`: fists 0, 10, 2, ∞, 0, 2 · pistol $50, 20, 3, 12, 1.2, 60 · smg $150, 12, 10, 30, 1.8, 40 · shotgun $200, 8×10 pellets, 1.2, 6, 2.5, 20 · rifle $300, 30, 5, 25, 2.2, 120. Buying a gun includes 3 spare mags; ammo box $20 = 2 mags of current gun. Grenade $100: 100 dmg r=4, fuse 2.5 s. Breach charge $250: 1500 dmg to pieces r=2, 0 to players beyond 1 m, placed + 3 s fuse.
- Damage multipliers vs pieces: bullets/fists → sandbags 0.5, wood 0.7, metal 0.3, steel 0.1, scaffold 0.5, ramp 0.5, container 0.1; fists deal 0 to metal/steel/container. Explosives 1.0 everything.
- Economy: generator +5 cash/s, stored cap 500; start carried cash 50. Interact radius 2.5 m. Shop + vault owner-only; generator collect by anyone. Vault deposit/withdraw takes 1 s (interaction lock).
- Lifecycle: respawn 3 s, invuln 3 s, sudden death at 900 s: generators stop, all bunker doorways get indestructible seal plates, tide rises 0.15 m/s from y=0 (anything below water dies).
- Seal: grid cell 0.25 m over a 16×16 m square around bunker; a piece blocks a cell if its height above ground ≥ 1.3 m and its footprint (expanded by player radius) covers the cell; bunker walls block; exit = any free cell farther than 4 m from bunker center.

---

### Task 1: Project scaffold + shared types

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts` (vitest config inline, `test.environment = 'node'`), `playwright.config.ts`, `index.html`, `src/sim/constants.ts`, `src/sim/types.ts`, `src/client/main.ts` (renders "FAEFight" title), `tests/sim/constants.test.ts`, `.gitignore`.

**Interfaces — Produces (`types.ts`):**
```ts
type Vec3 = { x: number; y: number; z: number };
type PieceKind = 'sandbags'|'wood'|'metal'|'steel'|'scaffold'|'ramp'|'container';
type WeaponKind = 'fists'|'pistol'|'smg'|'shotgun'|'rifle';
type Inventory = { cash: number; weapons: Partial<Record<WeaponKind,{mag:number;spare:number}>>; pieces: Partial<Record<PieceKind,number>>; grenades: number; charges: number };
type PlayerInput = { moveX:number; moveZ:number; yaw:number; pitch:number; jump:boolean; sprint:boolean; fire:boolean; reload:boolean; interact:boolean; slot: WeaponKind|null; build: { kind: PieceKind; pos: Vec3; rotY: number; free: boolean } | null; throwGrenade:boolean; placeCharge:boolean; shop: ShopAction|null; vault: VaultAction|null };
type ShopAction = { buy: PieceKind|WeaponKind|'ammo'|'grenade'|'charge' };
type VaultAction = { deposit?: Partial<Inventory>; withdraw?: Partial<Inventory> };
type PlayerState = { id:number; name:string; isBot:boolean; island:number; pos:Vec3; vel:Vec3; yaw:number; pitch:number; hp:number; alive:boolean; eliminated:boolean; respawnAt:number|null; invulnUntil:number; inv:Inventory; vault:Inventory; equipped:WeaponKind; reloadUntil:number; nextFireAt:number; busyUntil:number };
type PieceState = { id:number; kind:PieceKind; owner:number; pos:Vec3; rotY:number; hp:number };
type LootBag = { id:number; pos:Vec3; inv:Inventory };
type MatchEvent = { t:number; type:'kill'|'sealed'|'unsealed'|'eliminated'|'win'|'suddenDeath'|'hit'|'shot'|'explosion'|'placed'|'destroyed'; data: Record<string,unknown> };
type Snapshot = { time:number; tick:number; players:PlayerState[]; pieces:PieceState[]; loot:LootBag[]; generators:{island:number; stored:number}[]; sealed:boolean[]; waterY:number; suddenDeath:boolean; winner:number|null; events:MatchEvent[] };
```
`constants.ts` exports `TICK_HZ, PLAYER, PIECES: Record<PieceKind,...>, WEAPONS: Record<WeaponKind,...>, GRENADE, CHARGE, PIECE_DMG_MULT, ECONOMY, LIFECYCLE, SEAL, MAP` with the Key numbers.

- [ ] Step 1: `pnpm init`, add deps (`three @dimforge/rapier3d-compat`) and devDeps (`typescript vite vitest @playwright/test @types/three`); scripts `dev`, `build`, `test` (vitest run), `e2e` (playwright test).
- [ ] Step 2: Test `constants.test.ts`: every PieceKind has hp>0, price>0; steel hp > metal hp > wood hp > sandbags hp; every gun's price>0; `SEAL.blockHeight === 1.3` and `PIECES.sandbags.h < SEAL.blockHeight`.
- [ ] Step 3: Implement constants + types; `pnpm test` PASS; `pnpm build` succeeds.
- [ ] Step 4: Commit `chore: scaffold FAEFight with sim constants and types`.

### Task 2: Map layout

**Files:** `src/sim/map.ts`, `tests/sim/map.test.ts`

**Produces:** `type IslandLayout = { index:number; center:Vec3; radius:number; groundY:number; bunker:{center:Vec3; facingYaw:number; doorways:{center:Vec3; yaw:number; width:number}[]}; spawn:Vec3; generator:Vec3; vault:Vec3; shop:Vec3 }`; `buildMap(playerCount:number): IslandLayout[]`; `bunkerWallBoxes(b: IslandLayout['bunker']): {center:Vec3; half:Vec3; rotY:number}[]`.

Islands on a circle; 2 players → (±40,·,0). For n>2, ring radius chosen so adjacent edge gap = 36 m. Bunker sits toward the back (away from map center), doorways face the other three directions. Generator, vault, shop on the front half.

- [ ] Step 1: Tests: `buildMap(2)` centers at x=±40; gap between edges = 36 ±0.01 for n=2..8; each island has 3 doorways; spawn/generator/vault/shop all within radius-2 of center and ≥3 m apart from each other; no doorway faces the back edge.
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: PASS. Step 5: Commit `feat(sim): island map layout`.

### Task 3: Economy

**Files:** `src/sim/economy.ts`, `tests/sim/economy.test.ts`

**Produces:** `emptyInventory(): Inventory`; `tickGenerator(stored:number, dt:number, active:boolean): number`; `collect(player, gen:{stored:number}): number` (moves all stored into `player.inv.cash`, returns amount); `buy(player, action:ShopAction): {ok:true}|{ok:false; reason:string}`; `vaultTransfer(player, action:VaultAction): {ok:boolean; reason?:string}`; `mergeInventory(into:Inventory, from:Inventory): void`.

- [ ] Step 1: Tests: generator accrues 5/s and caps at 500, stops when inactive; collect empties stored; `buy pistol` with 50 cash → owns pistol with mag 12, spare 36, cash 0; **`cannot spend vault cash`** (cash 0 carried, 1000 vault → buy fails, nothing changes); buying a piece increments `pieces[kind]`; ammo without gun fails; deposit more than carried fails; withdraw moves cash/gear back.
- [ ] Steps 2–4: FAIL → implement → PASS. Step 5: Commit `feat(sim): economy, shop, vault`.

### Task 4: Physics wrapper

**Files:** `src/sim/physics.ts`, `tests/sim/physics.test.ts`

**Produces:** `class Physics { static async create(map: IslandLayout[]): Promise<Physics>; addPiece(p:PieceState):void; removePiece(id:number):void; addPlayer(id:number,pos:Vec3):void; removePlayer(id):void; movePlayer(id:number, desired:Vec3, dt:number): {pos:Vec3; grounded:boolean}; raycast(origin:Vec3, dir:Vec3, maxDist:number, ignorePlayer?:number): {dist:number; point:Vec3; hit:{type:'player';id:number}|{type:'piece';id:number}|{type:'world'}}|null; isGroundAt(x:number,z:number): number|null /* top y or null over water */; overlapsBox(center:Vec3, half:Vec3, rotY:number): boolean }`.

Use `RAPIER.init()` once; static colliders: island cylinders (top at groundY), bunker walls, generator/vault/shop as small boxes; pieces as cuboids (ramp as convex hull); players as kinematic capsules with `KinematicCharacterController` (autostep 0.3 m, snap-to-ground 0.3). Collider→entity map via handles.

- [ ] Step 1: Tests: player dropped on island lands at y≈groundY; walking into a bunker wall stops; walking off the edge falls below y=0; raycast from player hits a piece placed in front with `type:'piece'`; after `removePiece` the ray passes; player can walk up a ramp to its top.
- [ ] Steps 2–4. Step 5: Commit `feat(sim): rapier physics wrapper`.

### Task 5: Building + seal detection

**Files:** `src/sim/building.ts`, `src/sim/seal.ts`, `tests/sim/building.test.ts`, `tests/sim/seal.test.ts`

**Produces:** `snapPlacement(pos:Vec3, rotY:number, free:boolean): {pos:Vec3; rotY:number}`; `validatePlacement(physics, map, pieces, kind, pos, rotY, playerPos): {ok:true; pos:Vec3}|{ok:false; reason:string}` (reach ≤5 m, supported, no overlap with players/pieces/world; returns resolved y resting on support); `damagePiece(piece, amount:number, source:'bullet'|'fist'|'explosive'): boolean /* destroyed */`; `isSealed(bunker, pieces:PieceState[]): boolean`.

Seal algorithm: rasterize 16×16 m square around bunker center at 0.25 m. Blocked = inside a bunker wall box, or inside a piece footprint (OBB expanded by 0.35) whose top above groundY ≥ 1.3 m (stacked pieces: use the piece's top = its base y + h − groundY). BFS from spawn cell; sealed iff no reachable cell with distance > 4 m from bunker center.

- [ ] Step 1: Tests (building): snap rounds to 0.5 m and 15°; `free` keeps raw; placement beyond 5 m rejected; overlap rejected; second sandbags on top of first rests at y=groundY+1.0; scaffold extending 4 m over water from shore accepted, floating scaffold rejected; steel takes 0.1× bullet damage; fists do 0 to steel.
- [ ] Step 2: Tests (seal): open bunker → false; steel in all 3 doorways → true; steel in 2 of 3 → false; **`low pieces do not seal, stacked do`** (sandbags in all 3 → false; double-stacked sandbags in all 3 → true); container blocking a doorway counts; destroying one plate → false again.
- [ ] Steps 3–5: FAIL → implement → PASS. Step 6: Commit `feat(sim): building placement and seal detection`.

### Task 6: Combat

**Files:** `src/sim/combat.ts`, `tests/sim/combat.test.ts`

**Produces:** `eyePos(p:PlayerState):Vec3`; `aimDir(yaw:number,pitch:number):Vec3`; `tryFire(ctx:CombatCtx, p:PlayerState, now:number): MatchEvent[]`; `tryReload(p,now):void`; `throwGrenade(ctx,p,now):void`; `placeCharge(ctx,p,now):void`; `tickExplosives(ctx, now): MatchEvent[]`; `applyPlayerDamage(ctx, target, amount, attackerId, now): MatchEvent[]` (respects invuln, marks death via lifecycle `killPlayer`). `type CombatCtx = { physics: Physics; players: Map<number,PlayerState>; pieces: Map<number,PieceState>; explosives: Explosive[]; onPieceDestroyed(id:number):void; onKill(victim:number, killer:number|null):void }`.

Hitscan: ray from `eyePos` along `aimDir`, range per weapon, ignore shooter. Shotgun: 10 pellets with 4° deterministic spread pattern. Fire rate via `nextFireAt`; mag decrements; empty mag → auto reload. Fists: range 2 m.

- [ ] Step 1: Tests: pistol hit on player deals 20; rate limit (2 shots in same tick → 1 hit); mag empties after 12, reload restores from spare after 1.2 s; invulnerable target takes 0; bullet into steel reduces hp by dmg×0.1; grenade 100 dmg at center, 0 outside 4 m; charge destroys steel (1200 hp) in radius 2; firing a weapon not owned does nothing.
- [ ] Steps 2–4. Step 5: Commit `feat(sim): weapons, hitscan, explosives`.

### Task 7: Lifecycle

**Files:** `src/sim/lifecycle.ts`, `tests/sim/lifecycle.test.ts`

**Produces:** `killPlayer(state, victimId, now, inWater:boolean): MatchEvent[]` (drop carried inventory as LootBag at death pos unless inWater; reset inv to `emptyInventory()` with cash 0; `respawnAt = now+3`); `tickLifecycle(state, physics, map, now): MatchEvent[]` — water death (feet `pos.y` < `waterY`), loot pickup within 1.5 m (merge into inv), respawn when `now ≥ respawnAt`: if `isSealed` → `eliminated=true` event, else teleport to spawn with hp 100, invuln 3 s, equipped fists; win when ≤1 non-eliminated player; sudden death at 900 s (generators inactive, `sealedForced=true` on all bunkers, `waterY += 0.15*dt`).

`type MatchStateCore = { time:number; players:Map<number,PlayerState>; pieces:Map<number,PieceState>; loot:Map<number,LootBag>; generators:{island:number;stored:number}[]; waterY:number; suddenDeath:boolean; forcedSeal:boolean; winner:number|null; nextId:number }`.

- [ ] Step 1: Tests: kill on land → loot bag holds victim's cash/weapons, victim inv empty; **`death in water loses drop`**; other player walking within 1.5 m picks up bag; respawn after 3 s at spawn with invuln; sealed at respawn → eliminated, winner set in 1v1; **`unsealing before respawn restores respawn`** (seal, kill, destroy plate before 3 s → respawns); sealed while alive → not eliminated until killed; at 900 s waterY rises, generators stop, isSealed forced true; vault contents survive death.
- [ ] Steps 2–4. Step 5: Commit `feat(sim): death, loot, respawn, elimination, sudden death`.

### Task 8: Match orchestration

**Files:** `src/sim/match.ts`, `tests/sim/match.test.ts`

**Produces:** `class Match { static async create(opts:{ players:{name:string; isBot:boolean; difficulty?:Difficulty}[]; seed?:number }): Promise<Match>; tick(inputs: Map<number,PlayerInput>): Snapshot /* advances 1/30 s */; readonly map: IslandLayout[]; humanIds(): number[] }`. `type Difficulty = 'easy'|'medium'|'hard'`.

Per tick: bot inputs (Task 9 hook: `bots.get(id).think(view, now)`), apply movement (yaw/pitch, move vector in yaw frame, sprint, jump), interact (nearest of generator/shop/vault within 2.5 m; shop/vault require `island===player.island`), shop/vault actions, build (validate → consume piece → add, `busyUntil = now+placeSec`), weapons, explosives, generators, lifecycle, seal state change events. Snapshot = deep copy.

- [ ] Step 1: Tests: create 1v1 → two players at their spawns; 30 ticks of `moveZ:1` moves ~5 m; interact at generator after 10 s collects ~50; build input with sandbags in inventory places piece and decrements count; build while `busyUntil` > now ignored; snapshot is not mutated by later ticks.
- [ ] Steps 2–4. Step 5: Commit `feat(sim): match orchestration`.

### Task 9: Bots

**Files:** `src/sim/bots/bot.ts`, `src/sim/bots/perception.ts`, `tests/sim/bots.test.ts`

**Produces:** `class Bot { constructor(id:number, difficulty:Difficulty, rng:()=>number); think(view: BotView, now:number): PlayerInput }`; `type BotView = { self:PlayerState; enemies:PlayerState[] /* only line-of-sight visible, via physics.raycast */; map:IslandLayout[]; pieces:PieceState[]; generatorStored:number; sealed:boolean[]; waterY:number }`; `buildBotView(match internals, id): BotView`.

Utility goals scored each 0.5 s (+ noise by difficulty): `collect` (stored ≥ 40), `shop` (no gun or < 4 seal pieces), `bridge` (no scaffold path to target island — place scaffold segments end-to-end along straight line between islands), `attack` (go to enemy bunker), `seal` (enemy dead/respawning or near their bunker — place best owned walls in each open doorway; stack sandbags if that's all), `defend` (own bunker sealed and alive → go home, shoot own blocking piece), `fight` (enemy visible: strafe, aim, fire), `flee-tide` (sudden death: move to highest piece/ramp). Human feel: reaction delay easy 350 / medium 250 / hard 160 ms; aim = smoothed toward target with error cone easy 6° / medium 3.5° / hard 1.8° shrinking 30% over 1 s of tracking; stuck detection (moved < 0.5 m in 2 s → sidestep + jump).

- [ ] Step 1: Tests: bot with 0 cash and stored ≥ 40 picks `collect`; bot with cash ≥ 50 and no gun buys pistol; enemy visible → `fire` true within reaction delay + 1 tick, not before; hard aim error < easy aim error over 200 samples; **`bot vs bot match ends`** (headless 2 hard bots, run ≤ 25 sim-minutes with `tick` loop, assert `winner !== null`, and at least one `sealed` or `kill` event occurred).
- [ ] Steps 2–4. Step 5: Commit `feat(sim): utility bots`.

### Task 10: Client — worker, renderer, camera, input

**Files:** `src/client/worker.ts`, `src/client/render.ts`, `src/client/camera.ts`, `src/client/input.ts`, modify `src/client/main.ts`, `index.html`.

**Produces:** worker protocol: main→worker `{type:'start', difficulty}`, `{type:'input', input:PlayerInput}`; worker→main `{type:'snapshot', snap:Snapshot, map?:IslandLayout[]}` every tick. `class Renderer { constructor(canvas); setMap(map); apply(snap:Snapshot, alpha:number); render(camera) }`; `class ThirdPersonCamera { update(player:PlayerState, yaw, pitch, dt) }` (offset right 0.6 m, up 1.6 m, back 3.2 m, collision pull-in via raycast against scene meshes); `class InputController { sample(): PlayerInput }` (pointer lock, sensitivity slider stored in localStorage, keys per spec §8.7: WASD, Shift, Space, click fire, R, E, B build mode with Q/E or wheel rotate, Alt free, 1–5 weapon slots, G grenade, C charge).

Renderer: `three/webgpu` `WebGPURenderer` (falls back to WebGL2 automatically), Sky addon + directional sun with shadows, water plane at `waterY`, island cylinders with sand/concrete PBR colors, placeholder meshes at exact constants dimensions (capsule players colored per island, pieces boxes with material-tinted colors, generator/vault/NPC distinct shapes), loot bags, build ghost (green/red by `validatePlacement` reused client-side).

- [ ] Step 1: `pnpm dev`, open in Chrome via Playwright: menu → "Play vs Bot (Medium)" → canvas renders, no console errors, FPS counter ≥ 55 on this Mac.
- [ ] Step 2: Commit `feat(client): worker loop, renderer, third-person camera, input`.

### Task 11: Client — HUD, shop, vault, building UX

**Files:** `src/client/hud.ts`, modify `main.ts`, `render.ts`.

HUD: HP bar, carried cash, generator stored (when near), equipped weapon + mag/spare, piece counts, match timer, sudden-death banner, seal status of every bunker ("YOUR BUNKER IS SEALED" red), kill feed, respawn countdown, eliminated/win screen. Shop panel (E at NPC): list with prices, disabled if unaffordable; vault panel: deposit/withdraw cash amounts + gear. Panels release pointer lock while open.

- [ ] Step 1: Playwright e2e `tests/e2e/smoke.spec.ts`: start vs bot; HUD shows cash 50; walk script to shop (teleport via `?debug=1` query that exposes `window.__faefight.teleport(x,z)`), open shop, buy pistol → HUD cash 0 and weapon "pistol 12/36"; place sandbags via debug → piece mesh count +1. Run `pnpm e2e` PASS.
- [ ] Step 2: Commit `feat(client): HUD, shop, vault, build UX`.

### Task 12: Verify + docs

- [ ] `pnpm test` all green; `pnpm build` OK; `pnpm e2e` green.
- [ ] Manual play-through via browser: buy, build bridge, seal bot bunker, kill bot → win screen. Screenshot to `docs/screens/stage1.png`.
- [ ] README with run instructions (`pnpm i && pnpm dev`). Mark spec stage 1 done. Commit `docs: stage 1 complete`.
