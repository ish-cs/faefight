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
| Mouse | Aim (click to capture) · LMB fire · R reload |
| 1–5 | Fists / pistol / SMG / shotgun / rifle |
| E | Collect cash at a generator · open your shop or vault |
| B | Build mode: 1–7 pick piece, Q/E or wheel rotate, hold Alt for free placement, click to place |
| G / C | Throw grenade / place breach charge |

## Develop

```bash
pnpm test    # simulation unit tests (Vitest)
pnpm e2e     # browser smoke test (Playwright)
pnpm build   # typecheck + production build
```

- `src/sim/` is the pure TypeScript game simulation (Rapier physics, 30 Hz), with no DOM or Three.js.
- `src/client/` is the Three.js renderer, input and HUD. The simulation runs in a Web Worker.
- Design: `docs/superpowers/specs/2026-11-19-faefight-design.md`
