# Charged grenade throws + impact detonation (NET 47)

User: "grenade should blow up upon hitting floor immediately, and the longer you hold the further it throws (up to a
point), with a throw-like path trace." Confirmed later: the same for smoke and flash.

## Approaches
- **Chosen: charge on the client, power on the input.** The client times the hold; the release sends
  `throwGrenade`/`throwUtil` plus `throwPower` (0..1, 1/100 steps). The sim stays stateless and replays/multiplayer
  carry the power (replay codec extras, sanitize clamps). Bots set it directly.
- Sim-side charge state (charge start in PlayerState, snapshot field): more wire and state for no gain.
- Throw button held over ticks, counted by the sim: couples throws to tick timing and the input accumulator.

## Design calls
- `THROW = { minSpeed 6, maxSpeed 18, chargeSec 1.1, up 3, fuseSec 4 }`. Speed is linear in power and capped at 1.
  No power (old replays, scripted inputs) = the kind's legacy speed (grenade 14, smoke 13, flash 15).
- Impact: frag, smoke and flash all go off on first contact with anything solid except the thrower (floor, wall,
  piece, other players) and also at the sea surface. If one never touches anything, a 4 s fuse sets it off.
  Flash no longer pops mid-air.
- One step function, `combat.stepThrown`, does the flight with no allocations. The sim and the client preview
  (`combat.predictThrow` against the predictor world) both use it, so the arc is the sim's path. The preview uses
  the angles actually sent (aim-corrected toward the crosshair point in third person).
- Controls: left button down starts the charge, release throws. Right click, a slot switch, a menu, losing focus,
  or the item running out each cancel the charge.
- Preview (`world/throwArc.ts`): instanced dots every 0.6 m, plus a ring at the landing point (frag blast 4 m,
  smoke cloud 6.5 m, flash full range 4 m) and a centre disc. All three draw on top of the scene (no depth test).
  Three draws while charging, none otherwise. All of it is allocated up front and warmed at load.
- HUD: an amber ring around the crosshair (`charge-ring`) that turns white when the charge is full.
- Bots: `chargedThrow` takes the least charge, in 5% steps, whose high lob comes down at least `util.lobPitch`
  steep, so it drops behind cover or onto a plug instead of clipping it. Knob `util.lobPitch` = E 0.7 / M 0.85 /
  H 0.95 / P 1.05 rad, ES range [0.4, 1.3]. Flat doorway throws and smoke/flash throws use the legacy-speed charge.
  The brain panel shows "grenade lobbed after them (charge N%)". Bots release at once (they don't wait out the
  charge time).
