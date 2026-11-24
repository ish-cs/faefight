/**
 * Dev-only emote lab (served by the dev server at /tests/visual/emote-lab.html, not part of the build).
 * Five soldiers in a row facing the camera, each playing one emote (frozen at ?t=<s> or looping), two
 * of them with speech bubbles. Used by tests/visual/emoteShots.mjs for docs/screens/emotes-poses.png.
 */
import { buildMapDef } from '../../src/sim/map';
import { EMOTE_IDS, EMOTES, type QuipId } from '../../src/sim/emotes';
import { newPlayer } from '../../src/sim/player';
import type { Snapshot } from '../../src/sim/types';
import { Renderer } from '../../src/client/render';

const q = new URLSearchParams(location.search);
const freeze = q.has('t') ? Number(q.get('t')) : null;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = await Renderer.create(canvas);
const def = buildMapDef(8);
await r.setMap(def, 0);
await r.characters.ready;
const isl = def.islands[0], C = isl.center, GY = isl.groundY;
const quips: (QuipId | null)[] = [null, 'gg', null, 'niceShot', null];
// ?only=<emote>: just that one, centred (close-ups while tuning poses).
const only = q.get('only');
const players = EMOTE_IDS.map((id, i) => {
  const p = newPlayer(i + 1, EMOTES[id].label, true, i, { x: C.x + (i - 2) * 1.25, y: GY, z: C.z });
  p.yaw = Math.PI; // facing +Z, toward the camera
  return p;
}).filter((p, i) => !only || EMOTE_IDS[i] === only);
if (only) players[0].pos.x = C.x;
// ?side=1: from the side (profile of arm poses); ?d=<m>: camera distance.
const d = Number(q.get('d') ?? 4.6);
if (q.has('side')) r.camera.position.set(C.x + d * 1.4, GY + 1.3, C.z + 0.3);
else r.camera.position.set(C.x, GY + 1.25, C.z + d);
r.camera.lookAt(C.x, GY + 1.0, C.z);

let tick = 0;
const t0 = performance.now();
const loop = () => {
  const time = (performance.now() - t0) / 1000 + 10;
  players.forEach((p, k) => {
    const i = only ? EMOTE_IDS.indexOf(only as never) : k;
    const id = EMOTE_IDS[i];
    const t = freeze ?? time % (EMOTES[id].sec - 0.05);
    p.emote = { id, at: time - t };
    const qid = quips[i];
    if (qid) p.quip = { id: qid, at: time - 0.5 }; else delete p.quip;
  });
  const s: Snapshot = {
    time, tick: tick++, players: players.map((p) => ({ ...p, pos: { ...p.pos }, vel: { ...p.vel } })), pieces: [], loot: [], projectiles: [], generators: [],
    sealed: def.islands.map(() => false), genLevels: def.islands.map(() => 1), waterY: 0, suddenDeath: false, winner: null, potionShops: [], events: [],
  };
  r.ingest(s);
  r.pushSnapshot(s);
  r.beginFrame();
  r.render(0);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
(window as unknown as { emoteLab: unknown }).emoteLab = { ready: true, renderer: r };
