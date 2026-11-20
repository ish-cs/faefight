/// <reference lib="webworker" />
import { Match } from './fakeMatch'; // TODO(integration): switch to ../sim/match
import { TICK_HZ } from '../sim/constants';
import type { MatchApi } from '../sim/matchApi';
import { NO_INPUT, type PlayerInput } from '../sim/types';
import type { FromWorker, ToWorker } from './protocol';

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let match: MatchApi | null = null;
let humanId = 0;
let groundYFor: (x: number, z: number) => number = () => 0;

// Held controls come from the latest input message; one-shot actions are accumulated between ticks
// so a quick tap that lands between two ticks is never lost, and each acts on exactly one tick.
let held: PlayerInput = { ...NO_INPUT };
let pending: Partial<PlayerInput> = {};

function accumulate(input: PlayerInput) {
  held = input;
  if (input.jump) pending.jump = true;
  if (input.fire) pending.fire = true;
  if (input.reload) pending.reload = true;
  if (input.interact) pending.interact = true;
  if (input.throwGrenade) pending.throwGrenade = true;
  if (input.placeCharge) pending.placeCharge = true;
  if (input.slot) pending.slot = input.slot;
  if (input.build) pending.build = input.build;
  if (input.shop) pending.shop = input.shop;
  if (input.vault) pending.vault = input.vault;
}

function step() {
  if (!match) return;
  const input: PlayerInput = {
    ...held, reload: false, interact: false, throwGrenade: false, placeCharge: false,
    slot: null, build: null, shop: null, vault: null, ...pending,
  };
  pending = {};
  const snap = match.tick(new Map([[humanId, input]]));
  post({ type: 'snapshot', snap });
}

function startLoop() {
  const stepMs = 1000 / TICK_HZ;
  let next = performance.now();
  const loop = () => {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) { step(); next += stepMs; n++; }
    if (now - next > stepMs * 5) next = now; // fell far behind (tab throttled): drop the backlog
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();
}

async function start(difficulty: 'easy' | 'medium' | 'hard') {
  if (match) throw new Error('worker: match already started');
  const m = await Match.create({
    players: [{ name: 'You', isBot: false }, { name: `Bot (${difficulty})`, isBot: true, difficulty }],
  });
  match = m;
  const ids = m.humanIds();
  if (ids.length !== 1) throw new Error(`worker: expected 1 human, got ${ids.length}`);
  humanId = ids[0];
  groundYFor = (x, z) => m.map.find((i) => Math.hypot(i.center.x - x, i.center.z - z) <= i.radius)?.groundY ?? m.map[0].groundY;
  post({ type: 'map', map: m.map, humanId });
  startLoop();
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start':
        start(msg.difficulty).catch((err) => post({ type: 'error', message: `start failed: ${String(err?.stack ?? err)}` }));
        break;
      case 'input':
        accumulate(msg.input);
        break;
      case 'preview':
        if (match) post({ type: 'preview', result: match.previewBuild(humanId, msg.req) });
        break;
      case 'debug':
        if (!match) throw new Error('debug before start');
        if (msg.cmd === 'teleport') match.debugTeleport(humanId, { x: msg.x, y: groundYFor(msg.x, msg.z), z: msg.z });
        else match.debugGive(humanId, msg.inv);
        break;
    }
  } catch (err) {
    post({ type: 'error', message: `${msg.type}: ${String((err as Error)?.stack ?? err)}` });
  }
};
