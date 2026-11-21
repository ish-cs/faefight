# Anti-cheat: threat model and hardening (2026-11-20)

FAEFight is host-authoritative peer-to-peer: the host's browser runs the sim (`src/sim/*` in a Web Worker),
remote friends send **inputs** and receive **snapshots** over WebRTC (PeerJS). Budget: $0.

**Bottom line.** A host-authoritative game can stop most cheats by *remote* players: they only send
inputs, and the sim checks every one. It **cannot** stop the *host* from cheating. The host's browser
holds the whole game state and runs the rules, so the host can edit memory, change the sim or read
every position. Only a server that nobody playing controls fixes this (see "Option: free authoritative server").
Aimbots and triggerbots are also out of reach. They produce ordinary-looking inputs, so detection
would need statistics and an anti-cheat client we can't ship in a browser.

## Trust boundaries

| Actor | Controls | Trusted? |
|---|---|---|
| Host browser | sim, physics, every snapshot, lobby | yes (has to be; see limits) |
| Remote client | its own `ClientMsg`s, its own renderer, its own JS (DevTools, userscripts, modded build) | **no** |
| PeerJS signalling server | peer-id brokering | no (it only sees ids; data goes peer-to-peer) |

A remote client can send **any JSON-ish value** at **any rate**, with **any peer id** (PeerJS lets the
connecting side choose one), and can read **everything the host sends it**.

## 1. Remote client sends bad actions → host rejects (prevented)

| Cheat | Where it's stopped | Status |
|---|---|---|
| Speed / teleport / fly | Client can't send positions. `ClientMsg` has no position field; `sanitizeInput` clamps `moveX/moveZ` to [-1,1]; `Match.move` uses fixed walk/sprint speeds, jumps only when grounded, and moves once per tick however many inputs arrive (`InputAccumulator` keeps the latest held state). | ✅ prevented (verified by tests) |
| Fire-rate / infinite ammo / no reload | `tryFire` checks `nextFireAt` (1/rps), mag > 0 and no reload in progress, and fires at most once per tick. `tickReload` moves spare ammo into the mag only after `reloadSec`. | ✅ prevented |
| Build reach / overlap / spam | `validatePlacement` checks reach (5 m) and overlap; `Match.build` needs the piece in your inventory and sets `busyUntil = placeSec` (0.15–1 s); at most one build per tick and one per `placeSec` (a build sent while busy is held ≤ 0.25 s, one slot, newest wins). Build *previews* are limited to 20/s per peer. | ✅ prevented |
| Shop / vault from afar or another island | `near(isl.shop)` / `near(isl.vault)`: only your own island's station, within 2.5 m. Generators: any island's (raiding is a game mechanic), within 2.5 m. | ✅ prevented |
| Using items not owned | `buy` checks cash; `vaultTransfer` checks holdings; grenades, charges and medkits check counts; weapon select checks ownership. | ✅ prevented |
| Garbage yaw/pitch (NaN, 1e308) | `num()` rejects non-finite values; pitch is clamped in the sim (yaw is any finite number; trig makes it harmless). | ✅ prevented |
| Acting while dead | Dead players are skipped in `tick`. | ✅ prevented |
| Driving another player | The host derives the player id from the seat of the link's peer id, never from message contents. Host functions (start/kick/seat edits/rematch) are host-UI calls only: `ClientMsg` has no such message and unknown `t` is dropped. | ✅ prevented |
| Posing as the host by peer id | The host's lobby key used to be the string `host`, and a PeerJS client can choose its own peer id. It is now an id that can't arrive over the wire. | ✅ fixed |
| Input / message flooding | **New** `src/net/rateLimit.ts`: each peer gets a bucket for all messages (90/s, burst 180) and one for inputs (60/s, burst 90; the client sends 30/s). Excess is dropped. Dropped, malformed and oversized messages add strikes, which decay at 30/s. Past 300 strikes the peer is disconnected with `ended: 'flood'`. | ✅ prevented |
| Oversized messages | **New**: a bounded walker (`messageSize`) measures each message before sanitizing and drops anything over 4 KB or nested more than 6 deep (counts as 10 strikes). Caveat: PeerJS decodes its binary format *before* our code sees the message. Chrome caps a WebRTC message at about 256 KB, so the worst case is bounded, but it isn't truly "before parse". A true pre-parse cap needs `serialization: 'raw'` plus our own `JSON.parse` (see follow-ups). | 🟡 mitigated |
| Chat spam | `ChatLimiter` (2 msgs/s); `cleanChat` strips control and surrogate junk. Chat also counts toward the message bucket. | ✅ prevented |
| Name impersonation | **New**: `cleanName` applies NFKC, strips control/format characters (zero-width, bidi overrides), collapses whitespace and caps at 16 code points. Reserved names (`host`, `system`, `server`, `admin`, `bot`, `you`) become `Player`. The lobby makes every name unique, case-insensitively, against humans and bot nicknames (`Bob` → `Bob 2`). This also fixes a case bug where a bot nickname could duplicate a human's name. | ✅ prevented |
| Version spoofing | The version must match `NET_VERSION`, otherwise `ended: 'version'`. A modded client can still *claim* the right version: browsers have no client attestation. This doesn't matter much, because the host validates every message anyway. | 🟡 mismatches rejected; spoofing not preventable |

## 2. Information cheats (wallhack / ESP / radar): send less (mitigated)

A client sees everything we send it. Before this change, each snapshot held every player's exact
position, aim and hp, every generator's cash, and the contents of every loot bag.
**New** `src/net/interest.ts` (host-side, per client, after `SnapshotEncoder.take`):

- **Players**: an enemy is *revealed* to a viewer when any of these hold:
  - within 10 m (you'd hear their footsteps);
  - in line of sight. Rays go from the viewer's eye (now and 0.25 s ahead, plus ±0.6 m lean) to the enemy's head, chest and knees (plus ±0.45 m lateral, now and 0.25 s ahead). The occluders are bunker walls and placed pieces. Ramps count as their lower half, so the test under-occludes rather than over-occludes;
  - they just damaged the viewer (you know where you got shot from);
  - the viewer is eliminated, or the match is over (spectators see all).

  A revealed enemy stays revealed for 0.6 s after the last positive test. This prevents pop-in at corners and covers 100 ms render delay and latency. An unrevealed enemy is still listed (name, island, alive/eliminated/respawn: kill feed, scoreboard and HUD need them). Its pos/vel are frozen at the last position this viewer was sent (initially its bunker). Yaw, pitch, hp, equipped weapon and all timers become neutral values. Its id goes in `snap.hidden`, and the renderer doesn't draw hidden players.
- **Inventories / vaults / hotbars** of other players: never sent (already on main; verified by test).
- **Generators**: `stored` is sent only for the viewer's own generator and any generator within 15 m. Others show 0.
- **Loot bags**: contents are never sent (the client only renders the bag).
- **Events**: `shot` events from an unrevealed shooter are sent without `to` (no tracer) and with `from` rounded to 4 m, only within 120 m (the audio max distance). Exception: if the bullet path passes within 4 m of the viewer, you see it fly past. In that case it's sent in full and the shooter is revealed. `hit` events are sent only when they involve the viewer or a revealed target. Kills, explosions, pieces, seals and other public events are unchanged.

What stays exposed (by design or cost): positions within 10 m behind walls, everyone visible across open water (it's an open map), all pieces (world geometry, including what's inside a bunker), kill feed, the scoreboard, and the sealed state of every island (shown on the HUD for everyone). Terrain occlusion (a player swimming behind an island) and small props are not modelled.

## 3. Aim assistance (not preventable here)

Aimbots and triggerbots send the same input shape as a human: yaw, pitch and fire. A per-tick yaw/pitch
delta limit would misfire on flicks: a 180° flick inside one 33 ms tick is humanly possible with a high-dpi mouse.
**Not implemented.** Possible later work: host-side logging of suspicious statistics (e.g. headshot
ratio, or time-to-target after a reveal), shown to the host only, never auto-kicking.

## 4. Host cheating (not preventable in P2P)

The host can give itself cash, god mode or wallhacks, kick at will, or alter any rule. Nothing in
the client can detect this, because the host *is* the referee. Mitigations: play with people you trust,
or let a different friend host each game.

### Option: free authoritative server (the only real fix)

The sim is already plain TypeScript with Rapier (WASM) in a Worker, so it can run unchanged in Node:

1. **Make the sim headless.** `src/sim/*` doesn't touch the DOM. Add `server/index.ts`: create a `Match`, tick at 30 Hz, and reuse the logic of `HostSession` (lobby, sanitize, rate limit, interest, encoder) with a server `Transport`.
2. **Transport.** The easiest option is `node-datachannel` (WebRTC in Node; it speaks to the PeerJS signalling server through a small adapter). Simpler: WebSockets (`ws`), adding a `WsTransport` to `src/net/` beside `peer.ts`. The browser is then a "remote client" for everyone, including the person who created the room.
3. **Host it for $0.** Oracle Cloud *Always Free* gives an Ampere A1 VM (up to 4 OCPU / 24 GB) at no cost. Steps:
   - Sign up (a card is needed for verification; it isn't charged on Always Free shapes). Create a VM with an `Ubuntu 22.04` image and the `VM.Standard.A1.Flex` shape, 1 OCPU / 6 GB.
   - In the VCN security list, open ingress TCP 443 (wss), plus UDP if you use WebRTC. Also run `sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT` (Oracle images block ports at the host too).
   - Install Node 22 and pnpm, clone, run `pnpm build:server`, and run under `systemd` (or `pm2`).
   - TLS: get a free domain (e.g. DuckDNS), then use Caddy as a reverse proxy, which gets Let's Encrypt certificates automatically.
   - The client picks the server through `VITE_SERVER_URL`. Room codes stay the same and are minted by the server.
4. **Cost/effort.** About 1–2 days, mostly the transport and the server lifecycle (rooms, idle shutdown). CPU cost is about 1 ms/tick per 8-player match. Risks: Oracle sometimes reclaims idle Always Free VMs (keep it busy, or use Pay-As-You-Go with Always Free limits), and A1 capacity is often "out of host capacity" in popular regions.

Not built in this change: it's not cheap, and it changes hosting and ops.

## Follow-ups (not done)
- PeerJS `serialization: 'raw'` + JSON with a byte cap before `JSON.parse` (needs a real-WebRTC e2e test).
- Interest management for pieces (e.g. hiding what's inside an enemy bunker).
- Aim statistics logging (host-only).
