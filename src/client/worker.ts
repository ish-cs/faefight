/// <reference lib="webworker" />
import { Match } from '../sim/match';
import { TICK_HZ } from '../sim/constants';
import type { MatchSetup } from '../sim/matchApi';
import type { Difficulty, PlayerInput } from '../sim/types';
import type { MoveCmd } from '../sim/movement';
import { InputAccumulator } from './inputAccum';
import { MoveQueue } from './moveQueue';
import { Recorder } from '../sim/replay/recorder';
import { metaOf, type ReplayKind, type ReplayOp } from '../sim/replay/format';
import type { FromWorker, ToWorker } from './protocol';
import { packMatch, unpackMatch } from '../net/matchCheckpoint';

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Difficulty a leaver's seat is handed to. */
const TAKEOVER_DIFFICULTY: Difficulty = 'medium';

let match: Match | null = null;
/** Tick of the newest snapshot: what a checkpoint taken now is "as of". */
let lastTick = 0;
let humanId = 0;
let humanIsland = -1;
/** Vs-bot pause: the loop keeps running but takes no steps. */
let paused = false;
let groundYFor: (x: number, z: number) => number = () => 0;
/** Records this match (vs bot, or online as host: remote players' inputs too). Null when off or done. */
let recorder: Recorder | null = null;

/** Run one tick (through the recorder when recording). */
function runTick(inputs: Map<number, PlayerInput>, moves?: Map<number, MoveCmd[]>) {
  const snap = recorder ? recorder.tick(inputs, moves) : match!.tick(inputs, moves);
  if (recorder && snap.winner !== null) void finishRecording();
  return snap;
}

function recordOp(op: ReplayOp) {
  recorder?.op(op);
}

/** Encode and hand the recording to the page (which stores it). Recording stops. */
let finishing: Promise<void> = Promise.resolve();
function finishRecording(): Promise<void> {
  const rec = recorder;
  recorder = null;
  if (rec) finishing = finishing.then(() => encodeAndSend(rec));
  return finishing;
}

async function encodeAndSend(rec: Recorder, partial = false) {
  try {
    const { bytes, header, footer } = await rec.finish();
    const meta = metaOf({ header, footer }, bytes.length);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'replay', bytes, meta, partial } satisfies FromWorker, [bytes.buffer]);
    console.info(`[replay] recorded ${footer.ticks} ticks (${(bytes.length / 1024).toFixed(0)} KB)${footer.unfinished ? ', unfinished' : ''}`);
  } catch (err) {
    post({ type: 'error', message: `recording failed: ${String((err as Error)?.stack ?? err)}` });
  }
}

// One accumulator per human-controlled player (local + remote). Botified players are dropped.
const inputs = new Map<number, InputAccumulator>();
// Numbered movement commands per human (client prediction): see moveQueue.ts.
const moveQueues = new Map<number, MoveQueue>();

function pushInput(playerId: number, input: PlayerInput, cmds?: MoveCmd[]) {
  const acc = inputs.get(playerId);
  if (!acc) return; // unknown or botified ids are ignored
  acc.push(input);
  if (cmds?.length) moveQueues.get(playerId)?.push(cmds);
}

function step() {
  if (!match) return;
  const tickInputs = new Map<number, PlayerInput>();
  const moves = new Map<number, MoveCmd[]>();
  for (const [id, acc] of inputs) {
    const input = acc.take();
    tickInputs.set(id, input);
    const q = moveQueues.get(id);
    if (q) moves.set(id, q.take(input));
  }
  const snap = runTick(tickInputs, moves);
  lastTick = snap.tick;
  post({ type: 'snapshot', snap });
}

function startLoop() {
  const stepMs = 1000 / TICK_HZ;
  let next = performance.now();
  const loop = () => {
    const now = performance.now();
    let n = 0;
    if (paused) { next = now + stepMs; setTimeout(loop, 50); return; } // no backlog to catch up on resume
    while (now >= next && n < 5) { step(); next += stepMs; n++; }
    if (now - next > stepMs * 5) next = now; // fell far behind (tab throttled): drop the backlog
    setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();
}

async function start(setup: MatchSetup, localId: number, record: { kind: ReplayKind; build: string } | null) {
  if (match) throw new Error('worker: match already started');
  const m = await Match.create(setup);
  m.cloneSnapshots = false; // postMessage copies each snapshot already
  match = m;
  const ids = m.humanIds();
  // localId 0: the host spectates (no local player); it still runs the sim for everyone else.
  if (localId !== 0 && !ids.includes(localId)) throw new Error(`worker: local player ${localId} is not a human seat (humans: ${ids.join(',')})`);
  humanId = localId;
  for (const id of ids) { inputs.set(id, new InputAccumulator()); moveQueues.set(id, new MoveQueue()); }
  if (record) recorder = new Recorder(m, { setup, kind: record.kind, localId, build: record.build });
  groundYFor = (x, z) => m.map.find((i) => Math.hypot(i.center.x - x, i.center.z - z) <= i.radius)?.groundY ?? m.map[0].groundY;
  const snap0 = runTick(new Map());
  const me = snap0.players.find((p) => p.id === humanId);
  if (humanId !== 0 && !me) throw new Error(`worker: human ${humanId} missing from snapshot`);
  const islands = setup.players.map((_, i) => snap0.players.find((p) => p.id === i + 1)?.island ?? i);
  humanIsland = me?.island ?? -1;
  post({ type: 'map', map: m.def, humanId, humanIsland, islands });
  startLoop();
}

/** Host migration: continue a match from another host's checkpoint (see migration.ts). */
async function restore(bytes: Uint8Array, localId: number, botify: number[], toTick: number) {
  if (match) throw new Error('worker: match already started');
  const t0 = performance.now();
  const m = await unpackMatch(bytes);
  m.cloneSnapshots = false;
  for (const id of botify) if (m.humanIds().includes(id)) m.setBot(id, TAKEOVER_DIFFICULTY);
  const ids = m.humanIds();
  if (!ids.includes(localId)) throw new Error(`worker: restored match has no human ${localId} (humans: ${ids.join(',')})`);
  let tick = m.tick(new Map()).tick;
  const from = tick;
  while (tick < toTick) tick = m.tick(new Map()).tick;
  match = m;
  lastTick = tick;
  humanId = localId;
  for (const id of ids) { inputs.set(id, new InputAccumulator()); moveQueues.set(id, new MoveQueue()); }
  groundYFor = (x, z) => m.map.find((i) => Math.hypot(i.center.x - x, i.center.z - z) <= i.radius)?.groundY ?? m.map[0].groundY;
  console.info(`[worker] restored at tick ${from}, caught up ${tick - from} ticks in ${(performance.now() - t0).toFixed(0)} ms`);
  post({ type: 'restored', tick });
  startLoop();
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start':
        start(msg.setup, msg.humanId, msg.record ?? null).catch((err) => post({ type: 'error', message: `start failed: ${String(err?.stack ?? err)}` }));
        break;
      case 'restore':
        restore(msg.match, msg.humanId, msg.botify, msg.toTick).catch((err) => post({ type: 'error', message: `restore failed: ${String(err?.stack ?? err)}` }));
        break;
      case 'checkpoint': {
        if (!match) throw new Error('checkpoint before start');
        const tick = lastTick;
        packMatch(match).then((b) => post({ type: 'checkpoint', match: b, tick }, [b.buffer]),
          (err) => post({ type: 'error', message: `checkpoint failed: ${String(err?.stack ?? err)}` }));
        break;
      }
      case 'input':
        pushInput(humanId, msg.input, msg.cmds);
        break;
      case 'remoteInput':
        if (msg.playerId !== humanId) pushInput(msg.playerId, msg.input, msg.cmds);
        break;
      case 'botify':
        if (!match) throw new Error('botify before start');
        if (!inputs.delete(msg.playerId)) break; // already a bot
        moveQueues.delete(msg.playerId);
        match.setBot(msg.playerId, TAKEOVER_DIFFICULTY);
        recordOp({ k: 'setBot', id: msg.playerId, difficulty: TAKEOVER_DIFFICULTY });
        break;
      case 'humanize':
        if (!match) throw new Error('humanize before start');
        if (inputs.has(msg.playerId)) break; // already human
        inputs.set(msg.playerId, new InputAccumulator());
        moveQueues.set(msg.playerId, new MoveQueue());
        match.setHuman(msg.playerId);
        recordOp({ k: 'setHuman', id: msg.playerId });
        break;
      case 'pause':
        paused = msg.paused;
        console.info(`[worker] ${paused ? 'paused' : 'resumed'}`);
        break;
      case 'wheel':
        // Humans only (bots pick their own lines); unknown / botified ids are ignored like inputs.
        if (match && inputs.has(msg.playerId)) { match.wheel(msg.playerId, msg.id); recordOp({ k: 'wheel', id: msg.playerId, what: msg.id }); }
        break;
      case 'practice':
        if (!match) throw new Error('practice before start');
        match.practiceCommand(msg.cmd);
        break;
      case 'preview':
        if (match) {
          post({ type: 'preview', playerId: msg.playerId, result: match.previewBuild(msg.playerId, msg.req), key: msg.key });
          recordOp({ k: 'preview', id: msg.playerId, req: msg.req });
        }
        break;
      case 'finishRecording':
        finishRecording().finally(() => post({ type: 'recordingDone' }));
        break;
      case 'peekRecording':
        if (recorder) { const rec = recorder; finishing = finishing.then(() => encodeAndSend(rec, true)); }
        break;
      case 'debug':
        if (!match) throw new Error('debug before start');
        if (msg.cmd === 'teleport') {
          const pos = { x: msg.x, y: groundYFor(msg.x, msg.z), z: msg.z };
          match.debugTeleport(humanId, pos); recordOp({ k: 'teleport', id: humanId, pos });
        } else if (msg.cmd === 'hp') { match.debugSetHp(humanId, msg.hp); recordOp({ k: 'hp', id: humanId, hp: msg.hp }); }
        // Debug-only (e2e) clock jumps / strikes are not recorded: a replay of a match that used them diverges.
        else if (msg.cmd === 'time') match.debugSetTime(msg.t);
        else if (msg.cmd === 'strike') match.debugStrike(msg.x, msg.z);
        else if (msg.cmd === 'shield') { match.debugSetShield(msg.id ?? humanId, msg.shield); recordOp({ k: 'shield', id: msg.id ?? humanId, shield: msg.shield }); }
        else if (msg.cmd === 'potionShop') {
          const positions = [{ x: msg.x, y: groundYFor(msg.x, msg.z), z: msg.z }];
          match.debugSetPotionShops(positions); recordOp({ k: 'potionShops', positions });
        } else if (msg.cmd === 'pieces') {
          const kinds = ['wood', 'metal', 'steel', 'sandbags', 'container', 'scaffold'] as const;
          for (let i = 0; i < Math.min(400, msg.n); i++) {
            const ring = 6 + Math.floor(i / 24) * 4, a = (i % 24) / 24 * Math.PI * 2 + ring;
            const x = msg.x + Math.cos(a) * ring, z = msg.z + Math.sin(a) * ring;
            const pos = { x, y: groundYFor(x, z), z };
            match.debugPlacePiece(kinds[i % kinds.length], pos, a); recordOp({ k: 'piece', kind: kinds[i % kinds.length], pos, rotY: a });
          }
        }
        else if (msg.cmd === 'place') match.debugPlacePiece(msg.kind, { x: msg.x, y: groundYFor(msg.x, msg.z) + msg.up, z: msg.z }, msg.rotY, msg.owner);
        else if (msg.cmd === 'explode') match.debugExplode(msg.kind, { x: msg.x, y: groundYFor(msg.x, msg.z) + msg.up, z: msg.z }, humanId);
        // Debug-only (e2e) seal/generator setups: not recorded (see above).
        else if (msg.cmd === 'plugDoor') match.debugPlugDoor(humanIsland, msg.door, msg.owner);
        else if (msg.cmd === 'removePiece') match.debugRemovePiece(msg.id);
        else if (msg.cmd === 'genStored') match.debugSetGenerator(humanIsland, msg.stored);
        else if (msg.cmd === 'eliminate') { match.debugEliminate(msg.playerId); recordOp({ k: 'eliminate', id: msg.playerId }); }
        else if (msg.cmd === 'kill') { match.debugKill(msg.playerId); recordOp({ k: 'kill', id: msg.playerId }); }
        else if (msg.cmd === 'give') { match.debugGive(msg.id ?? humanId, msg.inv); recordOp({ k: 'give', id: msg.id ?? humanId, inv: msg.inv }); }
        break;
    }
  } catch (err) {
    post({ type: 'error', message: `${msg.type}: ${String((err as Error)?.stack ?? err)}` });
  }
};
