import './style.css';
import * as THREE from 'three/webgpu';
import { snapPlacement, type Placement } from '../sim/building';
import { PLAYER } from '../sim/constants';
import type { IslandLayout } from '../sim/map';
import type { BuildRequest, Difficulty, Inventory, Snapshot } from '../sim/types';
import { ThirdPersonCamera } from './camera';
import { Hud } from './hud';
import { InputController } from './input';
import type { FromWorker, ToWorker } from './protocol';
import { Renderer } from './render';

const app = document.getElementById('app')!;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const GHOST_AHEAD = 3;
const AIM_RANGE = 120;

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 8000);
}

function sensitivityControl(input: { sensitivity: number; setSensitivity(v: number): void } | null, initial: number) {
  const row = document.createElement('label');
  row.className = 'sens';
  const range = document.createElement('input');
  range.type = 'range'; range.min = '0.2'; range.max = '3'; range.step = '0.05';
  range.value = String(initial);
  const val = document.createElement('span');
  val.textContent = Number(initial).toFixed(2);
  range.oninput = () => {
    const v = Number(range.value);
    val.textContent = v.toFixed(2);
    if (input) input.setSensitivity(v);
    else localStorage.setItem('faefight.sensitivity', String(v));
  };
  row.append('Mouse sensitivity', range, val);
  return row;
}

function showMenu() {
  const menu = document.createElement('div');
  menu.className = 'menu';
  const card = document.createElement('div');
  card.className = 'menu-card glass';
  card.innerHTML = `<h1>FAEFight</h1><div class="tag">Islands. Bunkers. Seal them in.</div><div class="label">Play vs Bot</div>`;
  const play = document.createElement('div');
  play.className = 'play';
  for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
    const b = document.createElement('button');
    b.className = `btn${d === 'medium' ? ' primary' : ''}`;
    b.textContent = d[0].toUpperCase() + d.slice(1);
    b.dataset.testid = `play-${d}`;
    b.onclick = () => {
      play.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = true));
      const l = document.createElement('div');
      l.className = 'loading';
      l.textContent = 'Loading…';
      card.append(l);
      startGame(d, menu).catch((err) => {
        console.error('[main] failed to start', err);
        l.textContent = `Failed to start: ${err?.message ?? err}`;
      });
    };
    play.append(b);
  }
  const stored = Number(localStorage.getItem('faefight.sensitivity')) || 1;
  const keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML = 'WASD move · Shift sprint · Space jump · Click fire · R reload · E interact<br>B build (1–7 piece, Q/E or wheel rotate, hold Alt free-place) · 1–5 weapons · G grenade · C charge';
  card.append(play, sensitivityControl(null, stored), keys);
  menu.append(card);
  app.append(menu);
}

async function startGame(difficulty: Difficulty, menu: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  canvas.tabIndex = 0;
  app.prepend(canvas);
  const renderer = await Renderer.create(canvas);
  console.info(`[render] backend: ${renderer.backend}`);
  const camera = new ThirdPersonCamera(renderer.camera, () => renderer.collidables);

  let map: IslandLayout[] = [];
  let humanId = 0;
  let snap: Snapshot | null = null;
  let preview: { key: string; result: Placement } | null = null;
  let previewSentKey = '';
  let lastReq: BuildRequest | null = null;
  let wasLocked = false;
  let paused: HTMLElement | null = null;

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (m: ToWorker) => worker.postMessage(m);
  worker.onerror = (e) => { console.error('[worker] crashed', e.message); toast(`Simulation crashed: ${e.message}`); };

  const openPanel = (kind: 'shop' | 'vault') => {
    if (kind === 'shop') hud.openShop(); else hud.openVault();
    input.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
  };
  const closePanel = () => {
    if (!hud.panelOpen) return;
    hud.closePanel();
    input.enabled = !hud.ended;
    canvas.focus();
  };

  const hud = new Hud(app, {
    buy: (item) => input.queue({ shop: { buy: item } }),
    vault: (a) => input.queue({ vault: a }),
    closePanel,
    backToMenu: () => location.reload(),
  });

  const input = new InputController(canvas, {
    interact: () => {
      const station = hud.nearStation();
      if (station === 'shop' || station === 'vault') openPanel(station);
      else input.queue({ interact: true });
    },
    place: () => {
      const me = snap?.players.find((p) => p.id === humanId);
      if (!lastReq || !me || !me.alive) return;
      if ((me.inv.pieces[lastReq.kind] ?? 0) <= 0) return;
      if (!preview || preview.key !== reqKey(lastReq) || !preview.result.ok) return;
      input.queue({ build: lastReq });
    },
    lockChange: (locked) => {
      if (locked) { wasLocked = true; paused?.remove(); paused = null; hint.style.display = 'none'; return; }
      if (wasLocked && !hud.panelOpen && !hud.ended && !paused) showPause();
    },
  });

  const hint = document.createElement('div');
  hint.className = 'click-hint glass';
  hint.textContent = 'Click to capture the mouse';
  document.body.append(hint);

  function showPause() {
    input.enabled = false;
    paused = document.createElement('div');
    paused.className = 'overlay';
    const card = document.createElement('div');
    card.className = 'card glass';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:28px;font-weight:800';
    title.textContent = 'Paused';
    const resume = document.createElement('button');
    resume.className = 'btn';
    resume.textContent = 'Resume';
    resume.onclick = () => { input.enabled = true; input.requestLock(); paused?.remove(); paused = null; };
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:var(--muted)';
    note.textContent = 'The match keeps running while paused.';
    card.append(title, sensitivityControl(input, input.sensitivity), resume, note);
    paused.append(card);
    document.body.append(paused);
  }

  // Capture phase so this runs before InputController's listener; stopping propagation keeps the
  // same E press from immediately re-opening the panel we just closed.
  window.addEventListener('keydown', (e) => {
    if (!hud.panelOpen) return;
    if (e.code === 'Escape' || (e.code === 'KeyE' && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }, { capture: true });
  window.addEventListener('resize', () => renderer.resize());

  const reqKey = (r: BuildRequest) => `${r.kind}|${r.pos.x.toFixed(2)}|${r.pos.y.toFixed(2)}|${r.pos.z.toFixed(2)}|${r.rotY.toFixed(3)}|${r.free}`;

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'map') {
      map = m.map;
      humanId = m.humanId;
      renderer.setMap(map, humanId);
      hud.setMap(map, humanId, m.humanIsland);
    } else if (m.type === 'snapshot') {
      const first = !snap;
      snap = m.snap;
      const events = renderer.pushSnapshot(snap);
      hud.pushEvents(events);
      if (first) {
        const me = snap.players.find((p) => p.id === humanId);
        if (me) input.yaw = me.yaw;
        input.enabled = true;
        menu.remove();
        canvas.focus();
      }
      hud.update(snap, { buildMode: input.buildMode, buildKind: input.buildKind, ghostOk: input.buildMode ? (preview?.result.ok ?? null) : null, free: input.free });
      if (hud.ended && input.enabled) { input.enabled = false; if (document.pointerLockElement) document.exitPointerLock(); }
    } else if (m.type === 'preview') {
      preview = { key: previewSentKey, result: m.result };
    } else if (m.type === 'error') {
      console.error(`[worker] ${m.message}`);
      toast(m.message);
    }
  };
  send({ type: 'start', difficulty });

  if (DEBUG) {
    (window as unknown as { __faefight: unknown }).__faefight = {
      teleport: (x: number, z: number) => send({ type: 'debug', cmd: 'teleport', x, z }),
      give: (inv: Partial<Inventory>) => send({ type: 'debug', cmd: 'give', inv }),
      snapshot: () => snap,
      map: () => map,
      humanId: () => humanId,
      renderInfo: () => renderer.info(),
      input,
    };
  }

  // ---- frame loop ----
  const feet = new THREE.Vector3();
  let last = performance.now();
  let fpsFrames = 0, fpsSince = last;
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsFrames++;
    if (now - fpsSince >= 500) { hud.setFps((fpsFrames * 1000) / (now - fpsSince)); fpsFrames = 0; fpsSince = now; }
    hint.style.display = snap && !input.locked && !hud.panelOpen && !paused && !hud.ended ? '' : 'none';

    const me = snap?.players.find((p) => p.id === humanId);
    if (me && renderer.playerPos(humanId, feet)) {
      camera.update(feet, input.yaw, input.pitch, dt);

      // Build ghost: ~3 m ahead on the ground, snapped like the sim snaps it, validated by the worker.
      if (input.buildMode && me.alive) {
        const fx = -Math.sin(input.yaw), fz = -Math.cos(input.yaw);
        const req: BuildRequest = {
          kind: input.buildKind,
          pos: { x: feet.x + fx * GHOST_AHEAD, y: me.pos.y, z: feet.z + fz * GHOST_AHEAD },
          rotY: input.yaw + input.buildRot,
          free: input.free,
        };
        const snapped = snapPlacement(req.pos, req.rotY, req.free);
        req.pos = snapped.pos;
        req.rotY = snapped.rotY;
        lastReq = req;
        const key = reqKey(req);
        if (key !== previewSentKey) { previewSentKey = key; send({ type: 'preview', req }); }
        const have = (me.inv.pieces[req.kind] ?? 0) > 0;
        const fresh = preview && preview.key === key ? preview.result : null;
        const ok = !!fresh?.ok && have;
        renderer.setGhost(req.kind, fresh?.ok ? fresh.pos : req.pos, req.rotY, ok);
      } else {
        renderer.setGhost(null);
        lastReq = null;
      }
    }

    const sample = input.sample();
    if (me?.alive) {
      // Aim the sim's eye ray (from the player's head) at whatever is under the crosshair; the camera
      // sits over the shoulder, so the raw look angles would shoot ~0.6 m right of the crosshair.
      const target = camera.aimPoint(renderer.aimTargets(), AIM_RANGE);
      const ex = feet.x, ey = feet.y + PLAYER.eyeHeight, ez = feet.z;
      const dx = target.x - ex, dy = target.y - ey, dz = target.z - ez;
      sample.yaw = Math.atan2(-dx, -dz);
      sample.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    send({ type: 'input', input: sample });
    renderer.render(input.yaw);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

showMenu();
