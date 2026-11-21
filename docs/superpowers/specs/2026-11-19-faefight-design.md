# FAEFight — Design

Date: 2026-11-19 · Status: draft for approval

## 1. Intent

A realistic-looking, third-person online shooter played in the browser, where each player starts on their own island and wins by **sealing the other players' spawn bunkers** so they can't respawn. Built for Ishaan to play with friends (invite code) or against AI that feels human. Budget: **$0**.

What makes it different: the island-elimination format exists only as blocky/cartoony games. FAEFight puts it in a sunny, realistic, GTA-mood world (original art and setting, no GTA content), and elimination comes from *trapping* opponents with built walls, not from breaking an object.

## 2. Goals

- Matches of **2–8 players, free-for-all**, one island per player. 1v1 = two islands facing each other; 3–8 = islands in a ring around open water.
- Fill empty slots with **friends via invite code** or **AI bots** (easy / medium / hard). Bots must feel human, not robotic or aimbot-perfect.
- Realistic look: sunny tropical harbor islands (docks, shipping containers, warehouses), real materials, good lighting.
- Runs in a desktop browser with keyboard + mouse **or trackpad**.
- Text chat in matches.

## 3. Non-goals (for now)

Teams (2v2 etc.), public matchmaking with strangers, accounts, saved progress/unlocks, voice chat, mobile/touch, controllers, anti-cheat, monetization.

## 4. Anti-goals (failure even if it "works")

- Looks blocky or cartoony.
- Bots that feel like bots (instant reactions, perfect aim, aimless wandering).
- Feels laggy for the non-host player.
- Spending any money.

## 5. Game rules (decided by Ishaan)

| Rule | Detail |
|---|---|
| Islands | One per player. Water between islands. |
| Cash generator | On each island; builds up cash over time. You must **walk up to it to collect**. Cannot be destroyed. |
| Cash on hand | Collected cash is carried. Only carried cash can be spent. |
| Vault | A physical location on your island. Deposit or withdraw cash there. Anything in the vault survives death. |
| Death drop | On death you lose **everything carried** (cash, weapons, ammo, building pieces). It drops where you died and **anyone can pick it up**. |
| NPC shop | NPCs on your island sell building pieces (and weapons). Cannot be killed/destroyed. |
| Spawn bunker | Your respawn point. Respawn after death or falling in water. **You respawn with nothing** (fists only). |
| Water | Falling in the water = death. |
| Sealing | If no walkable path exists from your bunker's spawn to open ground, your bunker is **sealed** and you cannot respawn. |
| Elimination | Sealed bunker + you die → eliminated. If sealed while you're alive outside, you're alive until you die. |
| Unsealing | Walls have health and can be shot/broken. If the owner clears a path, the respawn comes back (sealing is checked live, at the moment of death). |
| Win | Last player not eliminated. |
| Camera | Third person over the shoulder. First-person toggle (stage 4). |
| Building | A general grid, but placement should feel very free-form. |

## 6. Rules proposed by me (Ishaan can override)

- **Weapons sold by NPCs:** pistol (cheap) → SMG → shotgun → rifle; explosives (grenades, breaching charge) are expensive and are the main way to crack steel. Every cash decision is "gun or walls?".
  - **Range falloff (approved by Ishaan, 2026-11-20):** sniping across the map shouldn't pay off, and close fights should be rewarded, for players and bots alike. Each bullet does full damage up to a near range, drops linearly to a floor at a far range, and stays at the floor beyond that. Headshots (×2) multiply on top. Piece damage uses the same falloff, so chipping at walls from long range is weaker too. Rocket, grenade and charge are unchanged. One function, `gunplay.shotDamage`, is shared by the sim and the client's predicted hit. Hits reduced by range carry a `falloff` tag, and their damage number is drawn slightly dimmer.

    | Gun | Full damage to | Floor reached at | Floor |
    |---|---|---|---|
    | pistol | 15 m | 40 m | 50% |
    | smg | 10 m | 35 m | 50% |
    | shotgun (per pellet) | 8 m | 25 m | 20% |
    | rifle | 25 m | 60 m | 55% |
  - **Spread:** the cone is hip or aimed base, plus bloom from sustained fire (the rifle adds 0.7° per shot), plus a movement penalty (walking, then more for sprinting, most in the air). Aiming cuts bloom to 60% and halves the movement penalty. Tap-firing lets the bloom recover fully, so an aimed, still, tapped shot stays accurate at mid range. Each shot's offset comes from a hash seeded by (tick, player), so the host, lag compensation and replays all agree.
- **Building pieces:** sandbags (cheap, weak), wood barricade, sheet-metal wall, steel plate (expensive, strong), scaffold bridge segment (how you cross water), ramp/stairs, shipping container (big, tough, pricey). Material decides health and which damage hurts it (fists only dent sandbags/wood).
- **Sudden death at 15:00 (approved by Ishaan; storm replaced the rising tide 2026-11-20):** generators stop, every bunker seals for good (deaths are final), and a **storm** closes in. The ring starts beyond the map edge and shrinks linearly onto the map centre over 3 min (the centre island once maps have one; the map origin until then), then holds a 12 m final circle. Outside the ring you lose hp once a second, straight to hp (shield doesn't help, like falls and water), ramping from 2/s to a 20/s cap the longer the storm runs. **Lightning** strikes in the storm (some near players standing in it, some just inside the ring edge), each telegraphed by a ground marker ~1 s before it lands, hurting players within 4 m (up to 55), also straight to hp. Neither the storm nor lightning damages buildings. Water level stays constant and still kills. Last alive wins; ring damage guarantees matches end. Ring and strikes are deterministic from the match seed (snapshot carries radius + telegraphed strikes). Weather goes dark and rainy with lightning flashes and distance-delayed thunder (rain instanced near the camera, density per quality preset).
- **Seal check timing:** checked when the respawn would happen (~3 s respawn timer). Kill-then-seal before the timer ends = eliminated.
- **Respawn protection:** 3 s invulnerability after respawn.
- **Build rights:** anyone can build anywhere, including against an enemy bunker door. Bunkers have 3 doorways. Strong pieces take longer to place (steel ~2 s). You can damage your own walls.
- **Vault (my calls):** only the owner can use it; it's indestructible; it stores cash **and** gear (weapons, ammo, pieces). Withdraw/deposit takes ~1 s.
- **Generator stealing (my call):** enemies standing at your generator can collect its uncollected cash. Makes generators worth fighting over.
- **Free-form placement:** 0.5 m snap grid + 15° rotation steps; hold a key to disable snapping; ghost preview turns red when blocked. Seal detection does not depend on the grid (see 8.4).
- Islands are ~40–60 m across, separated by ~25–40 m of water so crossing needs a scaffold bridge (no swimming).

## 7. Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **Host's browser runs the match** (peer-to-peer, WebRTC) | $0; host leaving ends match; a few networks need a relay | ✅ **Chosen** ($0 rule) |
| Paid authoritative server (Fly.io/Railway + Colyseus) | Best fairness/smoothness, ~$5–10/mo | ❌ costs money |
| Oracle Cloud Always Free server | $0 real server, needs card verification, idle reclaim risk | Later upgrade path; match code written so it can move there |
| Your Mac + Cloudflare Tunnel | $0, only while Mac is on | Fallback only |

Engine: **Three.js** chosen by Ishaan over Godot (Godot web export is WebGL2-only, worst visuals), Babylon.js, PlayCanvas, Unity (heavy downloads), Unreal (no web export).

## 8. Technical design

### 8.1 Stack
- TypeScript, Vite, Three.js (`WebGPURenderer`, automatic WebGL2 fallback).
- Rapier3D (WASM) for physics/character controller.
- Networking: WebRTC data channels; free public signaling (PeerJS cloud server or Trystero-style public relays); free TURN tier (e.g. Open Relay) as fallback. Verify current free terms before wiring.
- Static hosting: Cloudflare Pages or GitHub Pages ($0).
- Tests: Vitest (simulation logic), Playwright (browser smoke + 2-tab multiplayer).

### 8.2 Architecture
- **One simulation module** (`sim/`), pure TypeScript, no rendering, deterministic tick (30 Hz). Owns: players, physics, building pieces + health, economy, damage, seal detection, sudden death, bots. Runs in a **Web Worker** on the host. Same code can later run in Node on a server.
- **Client** (`client/`): rendering, input, camera, UI, audio, chat. Sends inputs; receives state snapshots.
- **Host-authoritative**: host's sim decides everything. Remote clients use client-side prediction for their own movement and interpolation for everyone else. Implemented: every client (host included) predicts its own movement with the sim's own `sim/movement.ts` against a local Rapier world, sending numbered 30 Hz move commands that the host queues per player (`client/moveQueue.ts`) and acks in snapshots (`PlayerState.mv.ack`); the client replays unacked commands and blends small corrections over ~100 ms (`client/predict.ts`). Others are drawn at display rate from an adaptive-delay Hermite timeline (`client/interp.ts`). Hits resolved on host with lag compensation: clients send the sim time they were viewing with each shot and the host rewinds hitboxes to it, up to 0.4 s (`sim/lagComp.ts`). Own shots are predicted on the client and reconciled with the host's events (`client/shotPredict.ts`). Snapshots go out binary and delta-compressed against each client's last ack, 15–30 Hz by bandwidth (`net/wire.ts`, `net/snapRate.ts`).
- **Offline vs AI** = same sim in a worker, no network.

### 8.3 Lobby
Host creates match → gets a short invite code (e.g. `FAE-7K2Q`) → friends enter code → host sees slots, fills the rest with bots and picks difficulty → start. Text chat runs over the same data channel.

### 8.4 Seal detection
On the host, whenever a piece near a bunker is placed or destroyed, and again at each respawn attempt: run a walkability flood fill (coarse 3D grid sized to the player capsule) from the spawn pad outward; if it can't reach outside the bunker's exit radius, the bunker is sealed. Shown in the HUD for everyone ("RED's bunker SEALED").

### 8.5 AI bots
Run inside the host sim using the same inputs a player sends (no cheating on visibility; they "see" via raycasts).
- **Brain:** utility-based decision making over goals: earn/spend, defend own bunker, build bridge, attack/hunt, attempt seal, retreat.
- **Human feel:** reaction delay (150–350 ms by difficulty), aim that tracks with smoothing + error that tightens over time, misses, uses cover, peeks, reloads at sensible times, makes purchase mistakes on easy.
- **Difficulty** scales reaction, aim error, decision quality, and economy efficiency, not health or damage.
- Tested by headless bot-vs-bot matches (must finish, must seal sometimes, no stuck bots).

### 8.6 Look
- Sunny tropical harbor: docks, containers, warehouses, cranes, palms. Original layout built from modular pieces.
- Lighting: HDRI sky, baked lighting for static geometry, one sun shadow, SSAO, bloom, filmic tone mapping, color grade. Animated ocean shader.
- Assets ($0 only): Poly Haven (CC0 textures/HDRIs/models), Mixamo (free characters + motion-capture animations), CC0/CC-BY realistic models (attribution in a credits screen).
- Target: menu loads instantly; match assets (~30–60 MB) stream in the background.
- Visual reference (my call): sunny GTA V harbor mood. Stage 3 = assemble free assets + simple custom models; placeholder pieces in stages 1–2 use final dimensions.
- **Hardware target:** players use **MacBooks** (Apple Silicon). Support Chrome and Safari. Target 60 fps at 1080p-ish on a base M1 MacBook Air; quality presets (low/high) so post effects can be turned down.

### 8.7 Controls
WASD move, mouse/trackpad aim (adjustable sensitivity, pointer lock), click shoot, right-click aim, R reload, E interact (NPC shop), Minecraft-style 9-slot hotbar (1–9/wheel select; holding a piece = build mode, Z/X rotate, Alt free-place; Q drop one, Ctrl/Shift+Q drop stack; Tab releases the mouse to drag slots), Space jump, Shift sprint, Enter chat, V camera toggle (stage 4).

## 9. Stages (each one playable)

1. ✅ **Offline vs bots** (done 2026-11-19): one 1v1 map, movement, shooting, generator, shop, building, seal + elimination, basic bots. Placeholder art allowed.
2. ✅ **Online** (done 2026-11-20): invite codes, host-authoritative WebRTC, 2–8 players + bot fill, text chat.
3. **Look:** full realistic art pass, lighting, ocean, animations, sound.
4. **Polish:** first-person toggle, human-like bot tuning for all difficulties, sudden death tuning, credits.

## 10. Left to the builder

Prices, cash rate, weapon/material numbers, exact map layout, file structure inside `sim/` and `client/`, choice between PeerJS and Trystero after verifying free terms.
