import './style.css';
import type { Object3D } from 'three/webgpu';
import type { HostMsg, Slot } from '../net/protocol';
import { SnapshotDecoder } from '../net/snapshotCodec';
import type { Link } from '../net/transport';
import { normalizeCode } from '../net/code';
import { pickTransport } from '../net/index';
import { snapPlacement, type Placement } from '../sim/building';
import { DT, PLAYER, TICK_HZ } from '../sim/constants';
import type { MoveCmd } from '../sim/movement';
import type { IslandLayout } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import { NO_INPUT, type BuildRequest, type Difficulty, type Inventory, type PlayerInput, type Snapshot } from '../sim/types';
import { moveForAim } from './aim';
import { AudioSystem } from './audio/engine';
import { ChatUi } from './chatUi';
import { loadGameModules, preloadGame } from './gameModules';
import { InputAccumulator } from './inputAccum';
import { InputController } from './input';
import { ACTIONS, activeKeymap, bindingLabel, isAction, type Action } from './keymap';
import { loadingScreen as loadingOverlay } from './loading';
import { LobbyUi } from './lobbyUi';
import type { FromWorker, ToWorker } from './protocol';
import { HostSession, JOIN_ERRORS, JoinError, joinRoom } from './session';
import { SnapshotBuffer } from './snapBuffer';
import { endButtons, GameScope, type EndRole } from './rematch';
import { Scoreboard } from './scoreboard';
import { applyDocumentSettings } from './settings/apply';
import { openSettings } from './settings/panel';
import { settings } from './settings/store';
import { VerticalSmoother } from './interp';
import type { Predictor } from './predict';
import { MAX_CMDS_PER_MSG } from '../net/sanitize';

const app = document.getElementById('app')!;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const GHOST_AHEAD = 3;
const AIM_RANGE = 120;
const NAME_KEY = 'faefight.name';
const NAME_MAX = 16;
/** Created at load so M-mute works from the menu; the AudioContext itself starts on the first click/key. */
const audio = new AudioSystem();

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 8000);
}

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

/** "Settings" button (main menu + pause card). */
function settingsButton(onClose?: () => void) {
  const b = document.createElement('button');
  b.className = 'btn menu-settings';
  b.innerHTML = `${GEAR}<span>Settings</span>`;
  b.dataset.testid = 'open-settings';
  b.onclick = () => openSettings({ onClose });
  return b;
}

/** One-line key help from the live keymap (follows rebinding). */
function keyHelp(): string {
  const k = (a: Action) => bindingLabel(activeKeymap(), a).split(' / ')[0];
  const move = (['forward', 'left', 'back', 'right'] as Action[]).map(k).join('');
  const slots = ACTIONS.filter((a) => a.group === 'Hotbar').map((a) => k(a.id));
  const slotText = slots.join('') === '123456789' ? '1–9' : slots.join(' ');
  return `${move} move · ${k('sprint')} sprint · ${k('jump')} jump · Click fire / place / throw · ${k('reload')} reload · ${k('interact')} interact · ${k('chat')} chat · ${k('camera')} first person · ${k('mute')} mute<br>`
    + `${slotText} or wheel pick hotbar slot · ${k('drop')} drop (Ctrl/Shift+${k('drop')} stack) · ${k('inventory')} drag to reorder · hold ${k('scoreboard')} scoreboard · ${k('rotateLeft')}/${k('rotateRight')} rotate piece · ${k('freePlace')} free-place`;
}

// ---------------------------------------------------------------------------------------------
// Backends: where snapshots come from and where input goes.
// ---------------------------------------------------------------------------------------------

type GameSink = {
  map(map: IslandLayout[], humanId: number, island: number): void;
  snapshot(snap: Snapshot): void;
  preview(result: Placement, key: number): void;
  chat(from: string, text: string): void;
  /** The match can't continue (host left / worker died). */
  fatal(title: string, detail: string): void;
};

type Backend = {
  /** Remote snapshots arrive at ~15 Hz with jitter: play them through a delay buffer. */
  readonly buffered: boolean;
  /** Input send rate: every frame for the local worker; 30 Hz over the network. */
  readonly inputHz: number | null;
  connect(sink: GameSink): void;
  /** Held/one-shot input plus the movement commands made since the last call (prediction). */
  input(i: PlayerInput, cmds: MoveCmd[]): void;
  preview(req: BuildRequest, key: number): void;
  chat(text: string): void;
  /** Stop delivering to the sink (game torn down for a rematch / back to lobby). Remote: the link stays open. */
  close(): void;
  debug?: {
    teleport(x: number, z: number): void; give(inv: Partial<Inventory>): void; hp(hp: number): void;
    eliminate(playerId: number): void; kill(playerId: number): void;
  };
};

/** Simulation in a local worker: vs-bot (session = null) or online host. */
function workerBackend(setupFor: (w: Worker) => { setup: MatchSetup; humanId: number }, session: HostSession | null): Backend {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (m: ToWorker) => worker.postMessage(m);
  let humanId = 0;
  return {
    buffered: false,
    inputHz: null,
    connect(sink) {
      worker.onerror = (e) => { console.error('[worker] crashed', e.message); sink.fatal('Simulation crashed', e.message); };
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'map') {
          sink.map(m.map, m.humanId, m.humanIsland);
          session?.onMap(m.map, m.islands);
        } else if (m.type === 'snapshot') {
          sink.snapshot(m.snap);
          session?.onSnapshot(m.snap);
        } else if (m.type === 'preview') {
          if (m.playerId === humanId) sink.preview(m.result, m.key);
          else session?.onPreview(m.playerId, m.result, m.key);
        } else if (m.type === 'error') {
          console.error(`[worker] ${m.message}`);
          toast(m.message);
        }
      };
      const s = setupFor(worker);
      humanId = s.humanId;
      send({ type: 'start', setup: s.setup, humanId: s.humanId });
    },
    input: (input, cmds) => send({ type: 'input', input, cmds }),
    preview: (req, key) => send({ type: 'preview', playerId: humanId, req, key }),
    chat: (text) => session?.localChat(text),
    debug: {
      teleport: (x, z) => send({ type: 'debug', cmd: 'teleport', x, z }),
      give: (inv) => send({ type: 'debug', cmd: 'give', inv }),
      hp: (hp) => send({ type: 'debug', cmd: 'hp', hp }),
      eliminate: (playerId) => send({ type: 'debug', cmd: 'eliminate', playerId }),
      kill: (playerId) => send({ type: 'debug', cmd: 'kill', playerId }),
    },
    close() {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    },
  };
}

/** Remote client: no simulation; the host link is the source of truth. `early` = messages that arrived before the game was ready. */
function remoteBackend(link: Link, start: Extract<HostMsg, { t: 'start' }>, early: HostMsg[]): Backend {
  const decoder = new SnapshotDecoder();
  let closed = false;
  let disposed = false;
  return {
    buffered: true,
    inputHz: TICK_HZ,
    connect(sink) {
      sink.map(start.map, start.playerId, start.island);
      const handle = (m: HostMsg) => {
        if (disposed) return;
        if (m.t === 'snap') sink.snapshot(decoder.decode(m.s));
        else if (m.t === 'preview') sink.preview(m.result, m.key);
        else if (m.t === 'chat') sink.chat(m.from, m.text);
        else if (m.t === 'ended') { closed = true; if (m.reason === 'host-left') sink.fatal('Host left', 'Match over: the host left the game.'); else sink.fatal('Disconnected', JOIN_ERRORS[m.reason] ?? `Disconnected by the host (${m.reason}).`); }
      };
      early.forEach(handle);
      link.onMessage((raw) => handle(raw as HostMsg));
      link.onClose(() => { if (!closed && !disposed) { closed = true; sink.fatal('Host left', 'Match over: lost the connection to the host.'); } });
    },
    input: (input, cmds) => { if (!disposed) link.send({ t: 'input', input, cmds }); },
    preview: (req, key) => { if (!disposed) link.send({ t: 'preview', req, key }); },
    chat: (text) => link.send({ t: 'chat', text }),
    close: () => { disposed = true; },
  };
}

// ---------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------

function storedName() {
  return (localStorage.getItem(NAME_KEY) ?? '').slice(0, NAME_MAX);
}

function showMenu() {
  const menu = document.createElement('div');
  menu.className = 'menu';
  const card = document.createElement('div');
  card.className = 'menu-card glass';
  card.innerHTML = `<h1>FAEFight</h1><div class="tag">Islands. Bunkers. Seal them in.</div><div class="label">Play vs Bot</div>`;
  const play = document.createElement('div');
  play.className = 'play';
  const status = document.createElement('div');
  status.className = 'loading';
  status.dataset.testid = 'menu-status';
  const lockMenu = () => card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((x) => (x.disabled = true));
  const unlockMenu = () => card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((x) => (x.disabled = false));
  for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
    const b = document.createElement('button');
    b.className = `btn${d === 'medium' ? ' primary' : ''}`;
    b.textContent = d[0].toUpperCase() + d.slice(1);
    b.dataset.testid = `play-${d}`;
    b.onclick = () => {
      lockMenu();
      status.textContent = 'Loading…';
      playSolo(d, menu).catch((err) => {
        console.error('[main] failed to start', err);
        status.textContent = `Failed to start: ${err?.message ?? err}`;
      });
    };
    play.append(b);
  }

  // ---- online ----
  const online = document.createElement('div');
  online.className = 'online';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Play with friends';
  const nameIn = document.createElement('input');
  nameIn.className = 'text-in';
  nameIn.placeholder = 'Your name';
  nameIn.maxLength = NAME_MAX;
  nameIn.value = storedName();
  nameIn.dataset.testid = 'name-input';
  nameIn.oninput = () => localStorage.setItem(NAME_KEY, nameIn.value.trim());
  const hostBtn = document.createElement('button');
  hostBtn.className = 'btn';
  hostBtn.textContent = 'Host game';
  hostBtn.dataset.testid = 'host-game';
  const codeIn = document.createElement('input');
  codeIn.className = 'text-in code-in';
  codeIn.placeholder = 'CODE';
  codeIn.maxLength = 8;
  codeIn.dataset.testid = 'code-input';
  const joinBtn = document.createElement('button');
  joinBtn.className = 'btn';
  joinBtn.textContent = 'Join game';
  joinBtn.dataset.testid = 'join-game';
  const rowA = document.createElement('div');
  rowA.className = 'online-row';
  rowA.append(nameIn, hostBtn);
  const rowB = document.createElement('div');
  rowB.className = 'online-row';
  rowB.append(codeIn, joinBtn);
  online.append(label, rowA, rowB);

  const name = () => nameIn.value.trim().slice(0, NAME_MAX);
  const needName = () => {
    if (name()) return false;
    status.textContent = 'Enter a name first.';
    nameIn.focus();
    return true;
  };

  hostBtn.onclick = () => {
    if (needName()) return;
    lockMenu();
    status.textContent = 'Opening a room…';
    hostLobby(name(), menu).catch((err) => {
      console.error('[host] failed to open room', err);
      status.textContent = `Could not host: ${err?.message ?? err}`;
      unlockMenu();
    });
  };
  const doJoin = () => {
    if (needName()) return;
    const code = normalizeCode(codeIn.value);
    if (!code) { status.textContent = 'Invite codes are 6 letters/digits, e.g. K7Q2MX.'; codeIn.focus(); return; }
    lockMenu();
    status.textContent = `Joining ${code}…`;
    joinLobby(code, name(), menu).catch((err) => {
      console.warn('[join] failed', err);
      showJoinError(menu, err instanceof JoinError ? err.message : `Could not join: ${err?.message ?? err}`);
    });
  };
  joinBtn.onclick = doJoin;
  codeIn.onkeydown = (e) => { if (e.key === 'Enter') doJoin(); };

  const keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML = keyHelp();
  const unsub = settings.subscribe(() => { if (keys.isConnected) keys.innerHTML = keyHelp(); else unsub(); });
  card.append(play, online, status, settingsButton(), keys);
  menu.append(card);
  app.append(menu);
}

/** Full-screen "starting…" card shown while a rematch tears down the old game and builds the new one. */
function loadingScreen(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'menu';
  el.dataset.testid = 'rematch-loading';
  const card = document.createElement('div');
  card.className = 'menu-card glass';
  card.textContent = text;
  el.append(card);
  app.append(el);
  return el;
}

/** Vs bot. Play again = same difficulty on a fresh worker. */
async function playSolo(d: Difficulty, menu: HTMLElement) {
  const backend = workerBackend(() => ({
    // ?debug=1&bots=N (1-7) fills more seats for perf testing
    setup: { players: [{ name: 'You', isBot: false }, ...Array.from({ length: DEBUG ? Math.min(7, Math.max(1, Number(new URLSearchParams(location.search).get('bots')) || 1)) : 1 },
      (_, i) => ({ name: `Bot (${d})${i ? ` ${i + 1}` : ''}`, isBot: true, difficulty: d }))] },
    humanId: 1,
  }), null);
  let game: Game | null = null;
  game = await startGame(backend, menu, undefined, {
    hostId: null,
    role: {
      kind: 'solo',
      playAgain: () => {
        game?.destroy();
        playSolo(d, loadingScreen('Starting a new match…')).catch((err) => {
          console.error('[main] play again failed', err);
          toast(`Could not restart: ${err?.message ?? err}`);
        });
      },
    },
  });
}

function showJoinError(menu: HTMLElement, message: string) {
  menu.remove();
  const ui = new LobbyUi(app, '', null, () => location.reload());
  ui.error(message);
}

async function hostLobby(name: string, menu: HTMLElement) {
  let ui: LobbyUi | null = null;
  const session = await HostSession.create(pickTransport(location.search), name, {
    lobby: (slots) => ui?.render(slots, 0),
    chat: (from, text) => chat?.add(from, text),
  });
  let chat: ChatUi | null = null;
  let game: Game | null = null;
  const launch = (setupFor: (w: Worker) => { setup: MatchSetup; humanId: number }, screen: HTMLElement) => {
    const backend = workerBackend(setupFor, session);
    startGame(backend, screen, (c) => (chat = c), { hostId: 1, role }).then((g) => { game = g; }, (err) => {
      console.error('[host] failed to start', err);
      screen.remove();
      app.append(ui!.root);
      ui!.error(`Failed to start: ${err?.message ?? err}`);
    });
  };
  const role: EndRole = {
    kind: 'host',
    rematch: () => {
      game?.destroy();
      game = null;
      launch((w) => session.restart(w), loadingScreen('Starting rematch…'));
    },
    toLobby: () => {
      game?.destroy();
      game = null;
      app.append(ui!.root);
      session.backToLobby(); // re-renders the lobby (ev.lobby)
    },
  };
  menu.remove();
  ui = new LobbyUi(app, session.code, {
    setSeat: (i, slot: Slot) => session.setSeat(i, slot),
    addSeat: () => session.addSeat(),
    removeSeat: (i) => session.removeSeat(i),
    kick: (i) => session.kick(i),
    start: () => launch((w) => session.start(w), ui!.root),
    back: () => location.reload(),
  }, () => location.reload());
  ui.render(session.lobby.slots(), 0);
  console.info(`[host] room ${session.code} open`);
}

async function joinLobby(code: string, name: string, menu: HTMLElement) {
  const { link, lobby } = await joinRoom(pickTransport(location.search), code, name);
  menu.remove();
  const ui = new LobbyUi(app, code, null, () => { link.close(); location.reload(); });
  ui.render(lobby.slots, lobby.you);
  let phase: 'lobby' | 'starting' | 'game' | 'over' = 'lobby';
  let early: HostMsg[] = [];
  let game: Game | null = null;
  const launch = (m: Extract<HostMsg, { t: 'start' }>, screen: HTMLElement) => {
    phase = 'starting';
    early = [];
    const backend = remoteBackend(link, m, early);
    startGame(backend, screen, undefined, { hostId: 1, role: { kind: 'client' } }).then((g) => { game = g; phase = 'game'; }, (err) => {
      console.error('[join] failed to start', err);
      phase = 'over';
      screen.remove();
      app.append(ui.root);
      ui.error(`Failed to start: ${err?.message ?? err}`);
    });
  };
  link.onClose(() => { if (phase === 'lobby') ui.error('The host closed the lobby.'); });
  link.onMessage((raw) => {
    const m = raw as HostMsg;
    if (phase === 'over') return;
    if (phase === 'starting') { early.push(m); return; }
    if (phase === 'game') {
      // The game's backend handles everything else; the host restarting or returning to the lobby is ours.
      if (m.t === 'start') { game?.destroy(); game = null; launch(m, loadingScreen('Host started a rematch…')); }
      else if (m.t === 'lobby') { game?.destroy(); game = null; phase = 'lobby'; app.append(ui.root); ui.render(m.slots, m.you); }
      return;
    }
    if (m.t === 'lobby') ui.render(m.slots, m.you);
    else if (m.t === 'ended') { phase = 'over'; ui.error(m.reason === 'host-left' ? 'The host closed the lobby.' : `Removed from lobby (${m.reason}).`); }
    else if (m.t === 'start') launch(m, ui.root);
  });
}

// ---------------------------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------------------------

/** A running game; destroy() removes every trace of it (rematch / back to lobby). */
type Game = { destroy(): void };
type EndCtx = { role: EndRole; hostId: number | null };

/** Loading-screen phases for a match and their share of the bar (real progress, see loading.ts). */
const MATCH_PHASES = { code: 15, gpu: 10, characters: 25, map: 15, shaders: 30, frames: 5 };
/** Hidden frames rendered after the warm-up before the loading screen fades. */
const WARM_FRAMES = 3;
/** Never leave the player staring at the loading screen if a step hangs. */
const REVEAL_TIMEOUT_MS = 25_000;

async function startGame(backend: Backend, menu: HTMLElement, onChat?: (c: ChatUi) => void,
  end: EndCtx = { role: { kind: 'client' }, hostId: null }): Promise<Game> {
  const loading = loadingOverlay();
  loading.show('match', MATCH_PHASES);
  try {
    return await runGame(backend, menu, onChat, end);
  } catch (err) {
    void loading.hide();
    throw err;
  }
}

async function runGame(backend: Backend, menu: HTMLElement, onChat: ((c: ChatUi) => void) | undefined, end: EndCtx): Promise<Game> {
  const loading = loadingOverlay();
  const loadStart = performance.now();
  const mods = await loadGameModules((done, total) => loading.progress('code', done / total, 'Loading game code'));
  const THREE = mods.three;
  const { Renderer } = mods.render, { ThirdPersonCamera } = mods.camera, { FirstPersonView } = mods.viewmodel;
  const { DamageFx } = mods.damageFx, { Hud } = mods.hud, { Spectator } = mods.spectator;
  const offCharProgress = mods.characters.onCharacterProgress((f) => loading.progress('characters', f, 'Downloading characters'));

  const scope = new GameScope([app, document.body]);
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  canvas.tabIndex = 0;
  app.prepend(canvas);
  loading.progress('gpu', 0, 'Starting WebGPU');
  const renderer = await Renderer.create(canvas);
  loading.progress('gpu', 1, 'Starting the simulation');
  console.info(`[render] backend: ${renderer.backend}`);
  scope.begin(); // window/document listeners from here on are removed by destroy()
  let running = true;
  /** Free-fly chosen from the end screen (otherwise spectating = being dead). */
  let spectateChosen = false;
  const offSettings = settings.subscribe((st) => {
    renderer.world.sky.setQuality(st.video.quality);
    renderer.world.sky.setResolutionScale(st.video.resolutionScale);
  });

  // ---- reveal: map + avatars + first snapshot → shader warm-up → a few hidden frames → fade in ----
  let charsReady = false, warmStarted = false, warmed = false, revealed = false, framesAfterWarm = 0;
  renderer.characters.ready.then(() => {
    charsReady = true;
    offCharProgress();
    loading.progress('characters', 1);
    maybeWarm();
  });
  const revealTimer = setTimeout(() => { console.warn('[loading] warm-up took too long; showing the game anyway'); reveal(); }, REVEAL_TIMEOUT_MS);
  function maybeWarm() {
    if (warmStarted || !snap || !map.length || !charsReady) return;
    warmStarted = true;
    // One normal frame first so the camera already sits behind the player.
    requestAnimationFrame(() => {
      mods.warmup.warmUp(renderer, () => snap?.pieces ?? [], input.yaw, (f, label) => loading.progress('shaders', f, label))
        .catch((err) => console.warn('[loading] shader warm-up failed; continuing', err))
        .finally(() => { warmed = true; });
    });
  }
  function reveal() {
    if (revealed) return;
    revealed = true;
    clearTimeout(revealTimer);
    console.info(`[loading] match ready in ${Math.round(performance.now() - loadStart)} ms`);
    loading.progress('frames', 1, 'Ready');
    void loading.hide();
    canvas.focus();
  }
  const camera = new ThirdPersonCamera(renderer.camera, () => renderer.collidables);
  const fpv = new FirstPersonView(renderer, () => input.enabled);

  let map: IslandLayout[] = [];
  let humanId = 0;
  let snap: Snapshot | null = null;
  let preview: { key: string; result: Placement } | null = null;
  const previewKeys = new Map<number, string>(); // numeric wire key → request key
  let previewSeq = 0;
  let previewSentKey = '';
  let lastReq: BuildRequest | null = null;
  let wasLocked = false;
  let paused: HTMLElement | null = null;
  let dead: HTMLElement | null = null;
  let predictor: Predictor | null = null;
  const buffer = backend.buffered ? new SnapshotBuffer<Snapshot>(0.1) : null;

  const openPanel = (kind: 'shop' | 'vault') => {
    if (kind === 'shop') hud.openShop(); else { hud.openVault(); audio.ui('vault'); }
    input.enabled = false;
    chat.enabled = false; // Enter on a focused shop card buys; it must not open chat
    if (document.pointerLockElement) document.exitPointerLock();
  };
  const closePanel = () => {
    if (!hud.panelOpen) return;
    hud.closePanel();
    input.enabled = !hud.ended && !dead;
    chat.enabled = !hud.ended && !dead;
    canvas.focus();
  };

  const fxPos = new THREE.Vector3();
  const damageFx = new DamageFx(app);
  const hud = new Hud(app, {
    buy: (item) => input.queue({ shop: { buy: item } }),
    vault: (a) => input.queue({ vault: a }),
    closePanel,
    backToMenu: () => location.reload(),
    endButtons: (over) => endButtons(end.role, over, {
      spectate: () => { spectateChosen = true; hud.setEndVisible(false); input.enabled = !dead; canvas.focus(); input.requestLock(); },
      backToMenu: () => location.reload(),
    }),
    select: (i) => input.select(i),
    moveSlot: (from, to) => input.queue({ moveSlot: { from, to } }),
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
      if (locked) {
        wasLocked = true; paused?.remove(); paused = null; hint.style.display = 'none';
        if (input.inventory) input.setInventory(false);
        return;
      }
      if (spectateChosen && !chat.open && !dead) {
        // Esc while spectating from the end screen: back to it (it's the pause menu here).
        spectateChosen = false;
        input.enabled = false;
        hud.setEndVisible(true);
        return;
      }
      if (wasLocked && !input.inventory && !hud.panelOpen && !hud.ended && !paused && !chat.open && !dead) showPause();
    },
    inventoryChange: (open) => {
      hint.textContent = open ? `Drag hotbar items to reorder · ${bindingLabel(activeKeymap(), 'inventory')} to resume` : 'Click to capture the mouse';
      hint.classList.toggle('inventory', open);
    },
  });

  const chat = new ChatUi(app, {
    send: (text) => {
      if (backend.buffered || onChat) backend.chat(text); // online: the host relays (and echoes) it
      else chat.add('You', text); // vs bot: local echo only
    },
    typing: (open) => {
      input.enabled = !open && !hud.panelOpen && !hud.ended && !dead;
      if (!open) { canvas.focus(); input.requestLock(); }
    },
  });
  onChat?.(chat);

  const spectator = new Spectator(app, renderer.camera, () => renderer.collidables, canvas, () => input.enabled);
  const scoreboard = new Scoreboard(app);
  const scoreOpts = () => ({ humanId, hostId: end.hostId });
  window.addEventListener('keydown', (e) => {
    if (!isAction('scoreboard', e.code) || hud.panelOpen || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    if (!scoreboard.visible) { scoreboard.setVisible(true); if (snap) scoreboard.update(snap, scoreOpts()); }
  });
  window.addEventListener('keyup', (e) => { if (isAction('scoreboard', e.code)) scoreboard.setVisible(false); });
  window.addEventListener('blur', () => scoreboard.setVisible(false));

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
    card.append(title, resume, settingsButton(), note);
    paused.append(card);
    document.body.append(paused);
  }

  function showFatal(titleText: string, detail: string) {
    if (dead) return;
    reveal();
    input.enabled = false;
    chat.enabled = false;
    chat.close();
    if (document.pointerLockElement) document.exitPointerLock();
    paused?.remove();
    paused = null;
    dead = document.createElement('div');
    dead.className = 'overlay';
    dead.dataset.testid = 'fatal';
    const card = document.createElement('div');
    card.className = 'card glass';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:28px;font-weight:800';
    title.textContent = titleText;
    const note = document.createElement('div');
    note.style.cssText = 'font-size:13px;color:var(--muted)';
    note.textContent = detail;
    const back = document.createElement('button');
    back.className = 'btn primary';
    back.textContent = 'Back to menu';
    back.onclick = () => location.reload();
    card.append(title, note, back);
    dead.append(card);
    document.body.append(dead);
  }

  // Capture phase so this runs before InputController's listener; stopping propagation keeps the
  // same E press from immediately re-opening the panel we just closed.
  window.addEventListener('keydown', (e) => {
    if (!hud.panelOpen) return;
    if (e.code === 'Escape' || (isAction('interact', e.code) && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }, { capture: true });
  window.addEventListener('resize', () => renderer.resize());

  const reqKey = (r: BuildRequest) => `${r.kind}|${r.pos.x.toFixed(2)}|${r.pos.y.toFixed(2)}|${r.pos.z.toFixed(2)}|${r.rotY.toFixed(3)}|${r.free}`;

  // Placement verdict for the ghost as it stands now (null while the sim's answer for it is pending).
  const ghostState = () => (preview && lastReq && preview.key === reqKey(lastReq) ? preview.result.ok : null);

  const applySnapshot = (s: Snapshot) => {
    const first = !snap;
    snap = s;
    hud.pushEvents(renderer.pushSnapshot(s));
    fpv.onEvents(s.events, humanId);
    audio.snapshot(s);
    if (first) {
      const me = s.players.find((p) => p.id === humanId);
      if (me) { input.yaw = me.yaw; input.selected = me.selected; }
      input.enabled = !dead;
      menu.remove(); // the loading screen still covers the game until warm-up is done
      canvas.focus();
      maybeWarm();
    }
    damageFx.onSnapshot(s, humanId);
    const meNow = s.players.find((p) => p.id === humanId);
    input.held = meNow?.hotbar[input.selected] ?? null;
    const wasEnded = hud.ended;
    hud.update(s, { selected: input.selected, ghostOk: input.buildMode ? ghostState() : null, free: input.free, inventory: input.inventory });
    if (hud.ended && !wasEnded) spectateChosen = false; // a (new) result popped the end screen up
    scoreboard.update(s, scoreOpts());
    chat.enabled = !hud.ended && !dead && !hud.panelOpen;
    if (hud.ended && input.enabled) { input.enabled = false; if (document.pointerLockElement) document.exitPointerLock(); }
  };

  backend.connect({
    map: (m, id, island) => {
      map = m;
      humanId = id;
      renderer.setMap(map, humanId);
      loading.progress('map', 1, 'Building islands');
      maybeWarm();
      // Client-side prediction of our own movement (same movement code + a local collision world).
      import('./predict').then(({ Predictor: P }) => P.create(m, id)).then((p) => { predictor = p; },
        (err) => console.error('[predict] could not start; falling back to server positions', err));
      hud.setMap(map, humanId, island);
      audio.setMap(map, humanId);
    },
    snapshot: (s) => {
      // Newest state goes straight to prediction and interpolation; events/HUD may be delayed.
      predictor?.onSnapshot(s);
      renderer.ingest(s);
      if (buffer) buffer.push(s); else applySnapshot(s);
    },
    preview: (result, key) => {
      const k = previewKeys.get(key);
      if (k === undefined) return;
      previewKeys.delete(key);
      preview = { key: k, result };
    },
    chat: (from, text) => chat.add(from, text),
    fatal: showFatal,
  });

  if (DEBUG) {
    (window as unknown as { __faefight: unknown }).__faefight = {
      ...(backend.debug ?? {}),
      snapshot: () => snap,
      map: () => map,
      humanId: () => humanId,
      renderInfo: () => renderer.info(),
      renderer,
      chatLines: () => [...document.querySelectorAll('.chat-line')].map((n) => n.textContent),
      input,
      cameraMode: () => fpv.mode,
      spectator: () => ({
        ...spectator.info(),
        camera: { x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z },
        // Own avatar shown? (hiddenId hides it; a dead avatar is hidden after its death pose.)
        selfVisible: renderer.characters.hiddenId !== humanId &&
          !!(renderer.characters as unknown as { avatars: Map<number, { group: Object3D }> }).avatars.get(humanId)?.group.visible,
      }),
      scoreboard: () => scoreboard.visible,
      audio: () => audio.stats(),
      audioPlay: (cue: Parameters<AudioSystem['debugPlay']>[0]) => audio.debugPlay(cue),
      settings: () => settings.get(),
      /** Local player's rendered (predicted) feet this frame, and prediction stats. */
      predicted: () => ({ active: !!predictor?.active, pos: lastRendered, seq: moveSeq, stats: predictor?.stats ?? null, pending: predictor?.pending ?? 0 }),
      frames: () => frameStats(),
      resetFrames: () => { frameMs.length = 0; },
      interpDelay: () => renderer.interpDelay,
    };
  }

  // ---- frame loop ----
  const feet = new THREE.Vector3();
  const sendAcc = new InputAccumulator();
  let nextSendAt = 0;
  let last = performance.now();
  // Movement commands: fixed 1/30 s steps on our clock, applied locally at once (prediction) and sent.
  let moveSeq = 0;
  let moveAcc = 0;
  let jumpLatch = false;
  let unsent: MoveCmd[] = [];
  const predicted = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  let lastRendered: { x: number; y: number; z: number } | null = null;
  const eyeY = new VerticalSmoother();
  const viewFeet = new THREE.Vector3();
  const frameMs: number[] = [];
  const frameStats = () => {
    const xs = [...frameMs].sort((a, b) => a - b);
    const q = (k: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * k))] ?? 0;
    return { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / (xs.length || 1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: xs[xs.length - 1] ?? 0 };
  };
  let fpsFrames = 0, fpsSince = last;
  let lastDrawn = 0;
  const frame = () => {
    const now = performance.now();
    // Settings → Video frame cap (rAF itself is vsync-locked; this only skips frames below it).
    const cap = settings.get().video.frameCap;
    if (cap && now - lastDrawn < 1000 / cap - 2) { requestAnimationFrame(frame); return; }
    lastDrawn = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs.push(now - last);
    if (frameMs.length > 600) frameMs.shift();
    last = now;
    fpsFrames++;
    if (now - fpsSince >= 500) { hud.setFps((fpsFrames * 1000) / (now - fpsSince)); fpsFrames = 0; fpsSince = now; }
    if (buffer) for (const r of buffer.advance(dt)) applySnapshot(r.snap);
    renderer.beginFrame();

    // Movement: the raw (camera-frame) move axes become numbered fixed-step commands. The sim and
    // our predictor apply exactly the same commands; between steps the predictor extrapolates
    // with the live input so a key press shows on the very next frame.
    let sample = input.sample();
    if (sample.jump) jumpLatch = true;
    const liveCmd = (seq: number): MoveCmd => ({ seq, moveX: sample.moveX, moveZ: sample.moveZ, yaw: input.yaw, jump: jumpLatch, sprint: sample.sprint });
    moveAcc += dt;
    for (let n = 0; moveAcc >= DT; n++) {
      moveAcc -= DT;
      if (n >= 5) { moveAcc = 0; break; }
      const cmd = liveCmd(++moveSeq);
      jumpLatch = false;
      predictor?.step(cmd);
      unsent.push(cmd);
    }
    if (unsent.length > MAX_CMDS_PER_MSG) unsent = unsent.slice(-MAX_CMDS_PER_MSG);
    const predicting = !!predictor && predictor.renderState(liveCmd(moveSeq + 1), moveAcc / DT, dt, predicted);
    renderer.setLocal(predicting ? predicted : null);
    hint.style.display = snap && !input.locked && !hud.panelOpen && !paused && !hud.ended && !chat.open && !dead ? '' : 'none';

    const me = snap?.players.find((p) => p.id === humanId);
    // Dead (respawning or eliminated), or free fly picked on the end screen: invisible spectator camera.
    const spectating = !!me && (!me.alive || spectateChosen);
    if (spectating) {
      spectator.enter(renderer.camera.position);
      renderer.characters.hiddenId = humanId;
      renderer.setGhost(null);
      lastReq = null;
      spectator.frame({ cam: renderer.camera, yaw: input.yaw, pitch: input.pitch, dt, humanId, players: snap!.players,
        posOf: (id, out) => renderer.playerPos(id, out) });
    } else spectator.exit();
    if (me && !spectating && renderer.playerPos(humanId, feet)) {
      lastRendered = { x: feet.x, y: feet.y, z: feet.z };
      // Cameras follow a vertically smoothed feet position (steps/ramps/corrections don't jolt the
      // view); look angles are applied raw.
      const view = viewFeet.set(feet.x, eyeY.update(feet.y, predicting ? predicted.vel.y : null, dt), feet.z);
      if (!fpv.updateCamera(view, input.yaw, input.pitch, me, humanId)) camera.update(view, input.yaw, input.pitch, dt);

      // Build ghost (holding a piece): ~3 m ahead on the ground, snapped like the sim snaps it, validated by the sim.
      input.held = me.hotbar[input.selected] ?? null;
      const buildKind = input.buildKind;
      if (buildKind && me.alive) {
        const fx = -Math.sin(input.yaw), fz = -Math.cos(input.yaw);
        const req: BuildRequest = {
          kind: buildKind,
          pos: { x: feet.x + fx * GHOST_AHEAD, y: me.pos.y, z: feet.z + fz * GHOST_AHEAD },
          rotY: input.yaw + input.buildRot,
          free: input.free,
        };
        const snapped = snapPlacement(req.pos, req.rotY, req.free);
        req.pos = snapped.pos;
        req.rotY = snapped.rotY;
        lastReq = req;
        const key = reqKey(req);
        if (key !== previewSentKey) {
          previewSentKey = key;
          const wire = ++previewSeq;
          previewKeys.set(wire, key);
          if (previewKeys.size > 64) previewKeys.delete(previewKeys.keys().next().value!); // lost replies
          backend.preview(req, wire);
        }
        const have = (me.inv.pieces[req.kind] ?? 0) > 0;
        const fresh = preview && preview.key === key ? preview.result : null;
        const ok = !!fresh?.ok && have;
        renderer.setGhost(req.kind, fresh?.ok ? fresh.pos : req.pos, req.rotY, ok);
      } else {
        renderer.setGhost(null);
        lastReq = null;
      }
    }

    // Spectating: the sim ignores a dead player anyway; an alive winner flying around must not act either.
    if (spectating) sample = { ...NO_INPUT, yaw: me!.yaw, pitch: me!.pitch, select: input.selected };
    else if (me?.alive && !fpv.isActive) { // first person: the eye ray already is the crosshair ray
      // Aim the sim's eye ray (from the player's head) at whatever is under the crosshair; the camera
      // sits over the shoulder, so the raw look angles would shoot ~0.6 m right of the crosshair.
      // Targets nearer than the head itself would flip the aim backwards, so clamp just past the eye.
      const ex = feet.x, ey = feet.y + PLAYER.eyeHeight, ez = feet.z;
      const target = camera.aimPoint(renderer.aimTargets(), AIM_RANGE, new THREE.Vector3(ex, ey, ez));
      const dx = target.x - ex, dy = target.y - ey, dz = target.z - ez;
      const camYaw = sample.yaw;
      sample.yaw = Math.atan2(-dx, -dz);
      sample.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      Object.assign(sample, moveForAim(sample.moveX, sample.moveZ, camYaw, sample.yaw));
    }
    if (backend.inputHz === null) { backend.input(sample, unsent); unsent = []; }
    else {
      // Network: send at a fixed rate; taps between sends are accumulated, never lost.
      sendAcc.push(sample);
      if (snap && now >= nextSendAt) {
        backend.input(sendAcc.take(), unsent);
        unsent = [];
        nextSendAt = Math.max(nextSendAt + 1000 / backend.inputHz, now - 1000 / backend.inputHz);
      }
    }
    damageFx.frame(renderer.camera, input.yaw, me?.alive ? feet : null, (id) => renderer.playerPos(id, fxPos));
    renderer.render(input.yaw);
    fpv.render(spectating ? undefined : me, input.yaw, input.pitch, dt, predicting ? predicted.vel : undefined);
    audio.frame(renderer.camera);
    if (warmed && !revealed) {
      framesAfterWarm++;
      loading.progress('frames', framesAfterWarm / WARM_FRAMES);
      if (framesAfterWarm >= WARM_FRAMES) reveal();
    }
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  scope.end();

  return {
    destroy() {
      if (!running) return;
      running = false;
      offSettings();
      clearTimeout(revealTimer);
      if (!revealed) { revealed = true; void loading.hide(); }
      input.enabled = false;
      chat.enabled = false;
      chat.close();
      if (document.pointerLockElement) document.exitPointerLock();
      backend.close();
      scope.dispose(); // listeners + every element this game added (canvas, HUD, chat, overlays)
      renderer.gpu.dispose();
      console.info('[game] torn down');
    },
  };
}

/** First load: branded loading screen (already painted by index.html) → styles + fonts → menu → fade; then preload the game. */
async function boot() {
  const loading = loadingOverlay();
  if (DEBUG) (window as unknown as { __faefightLoading: unknown }).__faefightLoading = {
    visible: () => loading.visible,
    events: () => loading.events,
    screen: loading, // screenshots drive it directly (tests/visual/settingsShots.mjs)
  };
  loading.show('boot', { styles: 1, fonts: 1, menu: 1 });
  applyDocumentSettings();
  loading.progress('styles', 1);
  // System fonts only, but wait for them (bounded) so the menu never reflows after it appears.
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  loading.progress('fonts', 1);
  showMenu();
  loading.progress('menu', 1);
  void loading.hide();
  preloadGame();
}

boot().catch((err) => {
  console.error('[main] boot failed', err);
  showMenu();
});
