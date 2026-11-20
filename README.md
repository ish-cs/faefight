# FAEFight

Third-person island shooter in the browser. Each player starts on their own harbor island. Earn cash, buy guns and walls, bridge over to the enemy, and seal their spawn bunker. A sealed player who dies doesn't respawn. Last one standing wins.

## Run

```bash
pnpm i
pnpm dev        # http://localhost:5173
```

Pick a bot difficulty on the menu, then click the game to capture the mouse.

## Controls

| Key | Action |
|---|---|
| WASD / Shift / Space | Move / sprint / jump |
| Mouse | Aim (click to capture) · LMB fire / place / throw · R reload |
| 1–9 / wheel | Select hotbar slot: a gun to shoot, a piece to build (click places), a grenade/charge (click throws/places), a medkit (click: +50 HP after 2 s), an empty slot for fists |
| Q / Ctrl+Q (or Shift+Q) | Drop one from the selected slot / drop the whole stack |
| I | Release the mouse and drag hotbar slots to reorder (I again or click the game to resume) |
| Z / X | Rotate the held piece · hold Alt for free placement |
| E | Collect cash at a generator · open your shop or vault |
| V | Toggle first / third person |
| M | Mute / unmute sound |
| P | Cycle graphics quality (low / high / ultra) |
| Enter | Chat |

Every key can be rebound in **Settings → Controls** (main menu or the pause card). Settings (controls, video, audio, gameplay) are stored in `localStorage` under `faefight.settings.v1`.

Bought items go into the first free hotbar slot (9 slots, like Minecraft). With a full hotbar you can only buy more of what you already hold.

## Develop

```bash
pnpm test    # simulation unit tests (Vitest)
pnpm e2e     # browser smoke test (Playwright)
pnpm build   # typecheck + production build
```

- `src/sim/` is the pure TypeScript game simulation (Rapier physics, 30 Hz), with no DOM or Three.js.
- `src/client/` is the Three.js renderer, input and HUD. The simulation runs in a Web Worker.
- Design: `docs/superpowers/specs/2026-11-19-faefight-design.md`
