/// <reference lib="webworker" />
import { Match } from '../sim/match';
import { TICK_HZ } from '../sim/constants';
import type { MatchSetup } from '../sim/matchApi';
import type { Difficulty, PlayerInput } from '../sim/types';
import { InputAccumulator } from './inputAccum';
import type { FromWorker, ToWorker } from './protocol';

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

/** Difficulty a leaver's seat is handed to. */
const TAKEOVER_DIFFICULTY: Difficulty = 'medium';

let match: Match | null = null;
let humanId = 0;
let groundYFor: (x: number, z: number) => number = () => 0;

// One accumulator per human-controlled player (local + remote). Botified players are dropped.
const inputs = new Map<number, InputAccumulator>();

function pushInput(playerId: number, input: PlayerInput) {
  const acc = inputs.get(playerId);
  if (acc) acc.push(input); // unknown or botified ids are ignored
}

function step() {
  if (!match) return;
  const tickInputs = new Map<number, PlayerInput>();
  for (const [id, acc] of inputs) tickInputs.set(id, acc.take());
  post({ type: 'snapshot', snap: match.tick(tickInputs) });
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

async function start(setup: MatchSetup, localId: number) {
  if (match) throw new Error('worker: match already started');
  const m = await Match.create(setup);
  match = m;
  const ids = m.humanIds();
  if (!ids.includes(localId)) throw new Error(`worker: local player ${localId} is not a human seat (humans: ${ids.join(',')})`);
  humanId = localId;
  for (const id of ids) inputs.set(id, new InputAccumulator());
  groundYFor = (x, z) => m.map.find((i) => Math.hypot(i.center.x - x, i.center.z - z) <= i.radius)?.groundY ?? m.map[0].groundY;
  const snap0 = m.tick(new Map());
  const me = snap0.players.find((p) => p.id === humanId);
  if (!me) throw new Error(`worker: human ${humanId} missing from snapshot`);
  const islands = setup.players.map((_, i) => snap0.players.find((p) => p.id === i + 1)?.island ?? i);
  post({ type: 'map', map: m.def, humanId, humanIsland: me.island, islands });
  startLoop();
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start':
        start(msg.setup, msg.humanId).catch((err) => post({ type: 'error', message: `start failed: ${String(err?.stack ?? err)}` }));
        break;
      case 'input':
        pushInput(humanId, msg.input);
        break;
      case 'remoteInput':
        if (msg.playerId !== humanId) pushInput(msg.playerId, msg.input);
        break;
      case 'botify':
        if (!match) throw new Error('botify before start');
        if (!inputs.delete(msg.playerId)) break; // already a bot
        match.setBot(msg.playerId, TAKEOVER_DIFFICULTY);
        break;
      case 'preview':
        if (match) post({ type: 'preview', playerId: msg.playerId, result: match.previewBuild(msg.playerId, msg.req), key: msg.key });
        break;
      case 'debug':
        if (!match) throw new Error('debug before start');
        if (msg.cmd === 'teleport') match.debugTeleport(humanId, { x: msg.x, y: groundYFor(msg.x, msg.z), z: msg.z });
        else if (msg.cmd === 'hp') match.debugSetHp(humanId, msg.hp);
        else match.debugGive(humanId, msg.inv);
        break;
    }
  } catch (err) {
    post({ type: 'error', message: `${msg.type}: ${String((err as Error)?.stack ?? err)}` });
  }
};
