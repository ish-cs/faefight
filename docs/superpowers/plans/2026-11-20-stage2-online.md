# FAEFight Stage 2 (Online with Friends) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. TDD: failing test first.

**Goal:** Host a match from the browser, share a 6-character invite code, friends join (2–8 seats), host fills empty seats with bots, everyone plays the same match with text chat.

**Architecture:** Host-authoritative. The host's existing Web Worker runs `Match` for every seat; the host's main thread owns the network links, forwards remote inputs into the worker, and broadcasts snapshots. Remote clients run no simulation: they send inputs and render received snapshots. Contracts: `src/net/protocol.ts` (messages, `Slot`), `src/net/transport.ts` (`Transport`, `HostRoom`, `Link`).

**Tech:** PeerJS 1.5.5 (free public signaling, invite code → host peer id `faefight-<code>`), BroadcastChannel transport for same-browser dev/e2e (`?net=local`), loopback transport for unit tests.

**Spec:** `docs/superpowers/specs/2026-11-19-faefight-design.md` §7, §8.2, §8.3.

## Global Constraints
- $0. No accounts. TURN optional via `VITE_TURN_URL/USER/PASS` env, off by default.
- Never trust remote input: the host sanitizes every `ClientMsg` (shape, numbers finite, strings bounded).
- Chat rendered with `textContent` only, ≤ 200 chars, ≤ 2 msgs/s per player.
- Plain commit messages, no AI attribution.

## Review Focus
1. Malformed / hostile ClientMsg (NaN yaw, huge moveX, negative vault amounts, 10 KB chat) → ignored or clamped, never crashes the host.
2. A friend disconnects mid-match → their player is taken over by a medium bot; match continues.
3. Host closes the tab → every client sees "Host left" and can return to the menu.
4. Joining a full or already-started room → clear message, not a hang.
5. Snapshot bandwidth at 8 players + 300 pieces stays under ~60 KB/s per client.

---

### Task 1 (lead): Sim hardening for remote input
Files: `src/sim/economy.ts`, `src/sim/match.ts`, `src/net/sanitize.ts`, tests.
- [ ] `vaultTransfer` rejects negative/non-finite amounts (test: deposit `{cash:-500}` fails, no change).
- [ ] `sanitizeInput(raw: unknown): PlayerInput | null` — clamps move to [-1,1], drops non-finite yaw/pitch, validates enums (`slot`, `build.kind`, `shop.buy`), returns null for non-objects.
- [ ] `sanitizeClientMsg(raw: unknown): ClientMsg | null`.
- [ ] `Match.setBot(playerId, difficulty)` — hand a human seat to a bot (leaver). Test: after `setBot`, the seat moves with no human input.
- [ ] `MatchSetup.players[i].isBot` seats keep island i (already true).

### Task 2 (agent "net"): Transports, lobby model, chat
Files: `src/net/lobby.ts`, `src/net/chat.ts`, `src/net/loopback.ts`, `src/net/broadcast.ts`, `src/net/peer.ts`, `tests/net/*.test.ts`.
- [ ] `Lobby` (pure): host seat 0; `addHuman(name, peerId) → seat | null (full)`, `removePeer`, `setSeat(i, slot)` (host only: open/bot+difficulty), `toMatchSetup()`, `slots()`.
- [ ] `ChatLimiter`: clean text (trim, strip control chars, cap 200), rate limit 2/s per sender.
- [ ] Loopback + BroadcastChannel + PeerJS `Transport`s behind the same interface; invite code = 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
- [ ] Tests for lobby, chat, loopback round-trip (host↔2 clients, close events).

### Task 3 (agent "client"): Lobby UI, host relay, remote client, chat UI
Files: `src/client/main.ts`, `src/client/worker.ts`, `src/client/protocol.ts`, `src/client/lobbyUi.ts`, `src/client/chatUi.ts`, `src/client/session.ts`, `tests/e2e/online.spec.ts`.
- [x] Menu: Play vs Bot (as today) · Host game · Join game (code + name).
- [x] Lobby screen: code shown big with copy button, seat list, host can set seats to Open / Bot (easy/med/hard), Start (≥ 2 seats filled).
- [x] Worker accepts a roster and `{type:'remoteInput', playerId, input}`; per-player one-shot accumulation; `{type:'botify', playerId}`.
- [x] Host main: broadcasts snapshot every 2nd tick (15 Hz), relays chat, answers preview, botifies leavers.
- [x] Remote client: no worker; renders snapshots; sends inputs at 30 Hz; preview via host.
- [x] Chat: Enter opens input (releases pointer lock), feed bottom-left, fades.
- [x] e2e with `?net=local`: page A hosts, page B joins by code, A starts with 1 bot, both see 3 players, B moves and A sees it, chat round-trips, B closes → A's HUD shows B's seat now a bot.

### Task 4 (lead): Integrate, bandwidth check, real PeerJS check across two browsers, review.
