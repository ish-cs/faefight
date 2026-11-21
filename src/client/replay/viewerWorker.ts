/// <reference lib="webworker" />
import { TICK_HZ } from '../../sim/constants';
import type { MapDef } from '../../sim/map';
import { decodeReplay } from '../../sim/replay/codec';
import type { ReplayHeader } from '../../sim/replay/format';
import { ReplayRunner } from '../../sim/replay/runner';
import type { MatchEvent, Snapshot } from '../../sim/types';

/** page → replay worker */
export type ToViewer =
  | { type: 'load'; bytes: Uint8Array }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'seek'; tick: number };

export type KillMarker = { tick: number; killer: number | null; victim: number };

/** replay worker → page */
export type FromViewer =
  | { type: 'info'; header: ReplayHeader; map: MapDef; length: number; kills: KillMarker[] }
  /** reset: the time jumped (seek); drop interpolation history. */
  | { type: 'snapshot'; snap: Snapshot; reset: boolean }
  | { type: 'state'; tick: number; playing: boolean; speed: number; divergedAt: number | null }
  | { type: 'error'; message: string };

const post = (m: FromViewer) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let runner: ReplayRunner | null = null;
let playing = false;
let speed = 1;
let acc = 0;

function state() {
  if (runner) post({ type: 'state', tick: runner.tick, playing, speed, divergedAt: runner.divergedAt });
}

/** 30 times a second: run `speed` ticks' worth (fractional speeds accumulate), send the last snapshot with every event. */
function pump() {
  if (!runner || !playing) return;
  acc += speed;
  const n = Math.floor(acc);
  acc -= n;
  if (!n) return;
  const events: MatchEvent[] = [];
  let snap: Snapshot | null = null;
  for (let i = 0; i < n; i++) {
    const s = runner.step();
    if (!s) break;
    events.push(...s.events);
    snap = s;
  }
  if (snap) post({ type: 'snapshot', snap: { ...snap, events }, reset: false });
  if (runner.done) playing = false;
  state();
}

async function load(bytes: Uint8Array) {
  const replay = await decodeReplay(bytes);
  runner?.dispose();
  runner = await ReplayRunner.create(replay);
  // Marker ticks count this recording's ticks (seek's units): a segment after a host migration starts at startTick.
  const kills = replay.events.filter((e) => e[1] === 'kill').map(([tick, , d]) => ({ tick: tick - runner!.startTick, killer: (d.killer as number | null) ?? null, victim: d.victim as number }));
  post({ type: 'info', header: replay.header, map: runner.match.def, length: runner.length, kills });
  const first = runner.step();
  if (first) post({ type: 'snapshot', snap: first, reset: true });
  playing = true;
  state();
}

setInterval(() => {
  try { pump(); } catch (err) { playing = false; post({ type: 'error', message: `replay: ${String((err as Error)?.stack ?? err)}` }); }
}, 1000 / TICK_HZ);

self.onmessage = (e: MessageEvent<ToViewer>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'load':
        load(m.bytes).catch((err) => post({ type: 'error', message: `Could not open replay: ${(err as Error)?.message ?? err}` }));
        break;
      case 'play':
        if (runner?.done) { const s = runner.seek(1); if (s) post({ type: 'snapshot', snap: { ...s, events: [] }, reset: true }); }
        playing = true; state(); break;
      case 'pause': playing = false; state(); break;
      case 'speed':
        if (!(m.speed >= 0.25 && m.speed <= 8)) throw new Error(`speed must be 0.25–8, got ${m.speed}`);
        speed = m.speed; state(); break;
      case 'seek': {
        if (!runner) break;
        const s = runner.seek(Math.max(1, m.tick));
        if (s) post({ type: 'snapshot', snap: { ...s, events: [] }, reset: true });
        state();
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: `${m.type}: ${String((err as Error)?.stack ?? err)}` });
  }
};
