import './style.css';
import type { Object3D } from 'three/webgpu';
import type { HostMsg, Slot } from '../net/protocol';
import { SnapshotDecoder, type NetSnapshot } from '../net/snapshotCodec';
import { WireDecoder } from '../net/wire';
import type { Link } from '../net/transport';
import { normalizeCode } from '../net/code';
import { pickTransport } from '../net/index';
import type { Placement } from '../sim/building';
import { BuildAim, type AimOutcome } from './buildAim';
import { DT, HEAD, PLAYER, TICK_HZ, WEAPONS } from '../sim/constants';
import { spreadDeg } from '../sim/gunplay';
import type { MoveCmd } from '../sim/movement';
import { MAP_NAMES, MAP_TEMPLATES, resolveMapChoice, type IslandLayout, type MapChoice, type MapDef, type MapTemplate } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import { NO_INPUT, type BuildRequest, type Difficulty, type Inventory, type PlayerInput, type ShopItem, type Snapshot } from '../sim/types';
import { moveForAim } from './aim';
import { AudioSystem } from './audio/engine';
import { reloadClock } from './firstPerson';
import { ChatUi } from './chatUi';
import { loadGameModules, preloadGame } from './gameModules';
import { InputAccumulator } from './inputAccum';
import { InputController } from './input';
import { ACTIONS, activeKeymap, bindingLabel, isAction, type Action } from './keymap';
import { loadingScreen as loadingOverlay } from './loading';
import { LobbyUi, MapPicker } from './lobbyUi';
import type { FromWorker, ToWorker } from './protocol';
import { HostSession, JOIN_ERRORS, JoinError, joinRoom, type SpectateResult } from './session';
import { HELP_TEXT, HOST_ONLY, MONEY_HOST_ONLY, MONEY_NOT_IN_MATCH, MONEY_USAGE, moneyGiven, parseCommand, unknownCommand } from './commands';
import { currentDevice, currentIsChromium, isMobileDevice, showComputerOnly } from './device';
import { openHowTo } from './howTo';
import { SnapshotBuffer } from './snapBuffer';
import { DynamicResolution } from './dynRes';
import { endButtons, GameScope, type EndRole } from './rematch';
import { Scoreboard } from './scoreboard';
import { applyDocumentSettings } from './settings/apply';
import { openSettings } from './settings/panel';
import { settings } from './settings/store';
import { VerticalSmoother } from './interp';
import type { Predictor } from './predict';
import { MAX_CMDS_PER_MSG } from '../net/sanitize';
import { SealAnnouncer } from './announce';
import { BULK_PIECES, BuyQueue } from './qol/combatQol';
import { netStatus, QolHud } from './qol/hudExtras';
import { Killcam } from './qol/killcam';
import { addInviteButton } from './qol/invite';
import { botCountControl, prepareJoin, rememberDifficulty } from './qol/menu';
import { loadPrefs, savePrefs, seatPrefsOf } from './qol/prefs';
import { clearRejoin, loadRejoin, markAutoRejoin, saveRejoin, touchRejoin } from './qol/rejoin';
import { isPieceItem } from '../sim/hotbar';
import { aimDirection, ShotPredictor } from './shotPredict';

const app = document.getElementById('app')!;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const AIM_RANGE = 120;
/** Already-sent movement commands repeated in each network input message. */
const REDUNDANT_CMDS = 2;
const NAME_KEY = 'faefight.name';
const NAME_MAX = 16;
const MAP_KEY = 'faefight.map';
/** Last map played vs bots this page session: Random never repeats it. */
let lastBotMap: MapTemplate | null = null;
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
  return `${move} move · ${k('sprint')} sprint · ${k('jump')} jump · Click fire / place / throw · ${k('aim')} aim · ${k('reload')} reload · ${k('interact')} interact · ${k('chat')} chat · ${k('camera')} first person · ${k('mute')} mute<br>`
    + `${slotText} or wheel pick hotbar slot · ${k('drop')} drop (Ctrl/Shift+${k('drop')} stack) · ${k('inventory')} drag to reorder · hold ${k('scoreboard')} scoreboard · ${k('rotateLeft')}/${k('rotateRight')} rotate piece · ${k('freePlace')} free-place`;
}

// ---------------------------------------------------------------------------------------------
// Backends: where snapshots come from and where input goes.
// ---------------------------------------------------------------------------------------------

type GameSink = {
  map(def: MapDef, humanId: number, island: number): void;
  snapshot(snap: Snapshot): void;
  preview(result: Placement, key: number): void;
  chat(from: string, text: string): void;
  /** The match can't continue (host left / worker died). */
  fatal(title: string, detail: string): void;
  /** Guest: the link dropped without the host ending the match; try to take the seat back. */
  reconnect?(): void;
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
  /** Vs bot only: stop / restart the simulation (pause card). */
  pause?(paused: boolean): void;
  debug?: {
    teleport(x: number, z: number): void; give(inv: Partial<Inventory>, id?: number): void; hp(hp: number): void;
    eliminate(playerId: number): void; kill(playerId: number, killer?: number): void;
    shield(shield: number, id?: number): void; potionShop(x: number, z: number): void;
    pieces(x: number, z: number, n: number): void;
  };
};

/** Simulation in a local worker: vs-bot (session = null) or online host. */
function workerBackend(setupFor: (w: Worker) => { setup: MatchSetup; humanId: number }, session: HostSession | null): Backend & { handOff(): void } {
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
    pause: session ? undefined : (paused) => send({ type: 'pause', paused }),
    /** Vs bot /spectate: a bot takes over the local player. */
    handOff: () => send({ type: 'botify', playerId: humanId }),
    debug: {
      teleport: (x, z) => send({ type: 'debug', cmd: 'teleport', x, z }),
      give: (inv, id) => send({ type: 'debug', cmd: 'give', inv, id }),
      hp: (hp) => send({ type: 'debug', cmd: 'hp', hp }),
      shield: (shield, id) => send({ type: 'debug', cmd: 'shield', shield, id }),
      potionShop: (x, z) => send({ type: 'debug', cmd: 'potionShop', x, z }),
      pieces: (x, z, n) => send({ type: 'debug', cmd: 'pieces', x, z, n }),
      eliminate: (playerId) => send({ type: 'debug', cmd: 'eliminate', playerId }),
      kill: (playerId, killer) => send({ type: 'debug', cmd: 'kill', playerId, killer }),
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
  const wire = new WireDecoder();
  let closed = false;
  let disposed = false;
  return {
    buffered: true,
    inputHz: TICK_HZ,
    connect(sink) {
      sink.map(start.map, start.playerId, start.island);
      const handle = (m: HostMsg) => {
        if (disposed) return;
        if (m.t === 'snap') {
          const n = wire.decode<NetSnapshot>(m.b);
          if (n) sink.snapshot(decoder.decode(n));
        }
        else if (m.t === 'preview') sink.preview(m.result, m.key);
        else if (m.t === 'chat') sink.chat(m.from, m.text);
        else if (m.t === 'ended') { closed = true; if (m.reason === 'host-left') sink.fatal('Host left', 'Match over: the host left the game.'); else sink.fatal('Disconnected', JOIN_ERRORS[m.reason] ?? `Disconnected by the host (${m.reason}).`); }
      };
      early.forEach(handle);
      link.onMessage((raw) => handle(raw as HostMsg));
      link.onClose(() => {
        if (closed || disposed) return;
        closed = true;
        // No goodbye from the host: maybe just our connection. With a fresh rejoin token, try to take the seat back.
        if (sink.reconnect && loadRejoin()) sink.reconnect();
        else sink.fatal('Host left', 'Match over: lost the connection to the host.');
      });
    },
    input: (input, cmds) => { if (!disposed) link.send({ t: 'input', input, cmds, ack: wire.ack || undefined }); },
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
  const bots = botCountControl();
  const mapSel = new MapPicker(storedMapChoice(), 'menu-map', (c) => localStorage.setItem(MAP_KEY, c));
  const mapRow = document.createElement('div');
  mapRow.className = 'map-row';
  mapRow.append('Map', mapSel.root);
  for (const d of ['easy', 'medium', 'hard', 'pro'] as Difficulty[]) {
    const b = document.createElement('button');
    b.className = `btn${d === 'medium' ? ' primary' : ''}`;
    b.textContent = d === 'pro' ? 'PRO' : d[0].toUpperCase() + d.slice(1);
    b.dataset.testid = `play-${d}`;
    b.onclick = () => {
      lockMenu();
      const choice = mapSel.value as MapChoice;
      status.textContent = choice === 'random' ? 'Loading…' : `Loading ${MAP_NAMES[choice]}…`;
      playSolo(d, choice, menu, bots.count()).catch((err) => {
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
    joinLobby(code, name(), menu, rejoin?.code === code ? rejoin.token : undefined).catch((err) => {
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
  const howBtn = document.createElement('button');
  howBtn.className = 'btn menu-settings';
  howBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/></svg><span>How to play</span>';
  howBtn.dataset.testid = 'open-how-to';
  howBtn.onclick = () => openHowTo();
  const menuBtns = document.createElement('div');
  menuBtns.className = 'menu-btns';
  menuBtns.append(howBtn, settingsButton());
  rememberDifficulty(play);
  card.append(mapRow, play, bots.root, online, status, menuBtns, keys);
  menu.append(card);
  app.append(menu);
  if (!currentIsChromium()) menu.append(chromeBanner());
  // ?join=CODE link / reconnect offer: fill the form (after it's in the page, so focus works).
  const rejoin = prepareJoin({ online, nameIn, codeIn, joinBtn, status });
}

/** First-ever launch: How to play opens by itself (once the loading screen is gone), then never again. */
function firstLaunchHowTo() {
  if (settings.get().onboarding.howToSeen) return;
  console.info('[menu] first launch: showing How to play');
  openHowTo(() => settings.update((d) => { d.onboarding.howToSeen = true; }));
}

/** Dismissible "Best in Google Chrome" note for non-Chromium browsers (never blocks them). */
function chromeBanner(): HTMLElement {
  const b = document.createElement('div');
  b.className = 'chrome-banner glass';
  b.dataset.testid = 'chrome-banner';
  const t = document.createElement('span');
  t.textContent = 'Best in Google Chrome';
  const x = document.createElement('button');
  x.className = 'chrome-banner-x';
  x.textContent = '✕';
  x.title = 'Dismiss';
  x.dataset.testid = 'chrome-banner-close';
  x.onclick = () => b.remove();
  b.append(t, x);
  return b;
}


function storedMapChoice(): MapChoice {
  const v = localStorage.getItem(MAP_KEY);
  return v === 'random' || (MAP_TEMPLATES as string[]).includes(v ?? '') ? (v as MapChoice) : 'harbor';
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

/** Vs `bots` opponents (1-7) on the chosen map (Random: a different map than the last one played). Play again keeps difficulty, map choice and bot count. */
async function playSolo(d: Difficulty, choice: MapChoice, menu: HTMLElement, bots = 1) {
  const map = resolveMapChoice(choice, lastBotMap);
  lastBotMap = map;
  const urlBots = DEBUG ? Number(new URLSearchParams(location.search).get('bots')) : 0;
  const backend = workerBackend(() => ({
    // ?debug=1&bots=N (1-7) overrides the menu's bot count (perf testing)
    setup: { players: [{ name: 'You', isBot: false }, ...Array.from({ length: Math.min(7, Math.max(1, urlBots || bots)) },
      (_, i) => ({ name: `Bot (${d})${i ? ` ${i + 1}` : ''}`, isBot: true, difficulty: d }))], map },
    humanId: 1,
  }), null);
  let game: Game | null = null;
  let handedOff = false;
  game = await startGame(backend, menu, undefined, {
    hostId: null,
    // Watch the bots play: your player becomes a medium bot for the rest of this match.
    spectate: () => {
      if (handedOff) return { text: 'You can rejoin as a player next match.', handoff: false };
      handedOff = true;
      backend.handOff();
      console.info('[main] vs bot: player handed to a bot; spectating');
      return { text: 'You are spectating. A bot plays for you this match.', handoff: true };
    },
    // Vs bot you are the host: the cash goes through the local worker (the authoritative sim).
    money: (amount) => {
      if (handedOff) return 'You are spectating: no player to give cash to';
      if (!backend.debug) throw new Error('/money: vs-bot backend has no worker debug channel');
      backend.debug.give({ cash: amount });
      console.info(`[main] vs bot: /money +$${amount}`);
      return moneyGiven(amount);
    },
    role: {
      kind: 'solo',
      playAgain: () => {
        game?.destroy();
        playSolo(d, choice, loadingScreen('Starting a new match…'), bots).catch((err) => {
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
    lobby: (slots, map) => ui?.render(slots, 0, map),
    chat: (from, text) => { chat?.add(from, text); ui?.addChat(from, text); },
    net: (rtt, host) => { netStatus.rtt = rtt; netStatus.host = host; },
  });
  // Last lobby's seat layout (bots + open seats), so a new session starts where the last one left off.
  for (const [i, seat] of (loadPrefs().seats ?? []).entries()) {
    if (i + 1 >= session.lobby.slots().length) session.addSeat();
    if (seat.kind === 'bot') session.setSeat(i + 1, { kind: 'bot', difficulty: seat.difficulty });
  }
  let chat: ChatUi | null = null;
  let game: Game | null = null;
  const launch = (setupFor: (w: Worker) => { setup: MatchSetup; humanId: number }, screen: HTMLElement) => {
    const backend = workerBackend(setupFor, session);
    startGame(backend, screen, (c) => (chat = c), { role, spectate: () => session.toggleSpectate(), money: (n) => session.giveMoney(n), get hostId() { return session.hostPlayer; } }).then((g) => { game = g; }, (err) => {
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
      chat = null;
      launch((w) => session.restart(w), loadingScreen('Starting rematch…'));
    },
    toLobby: () => {
      game?.destroy();
      game = null;
      chat = null;
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
    setMap: (c) => { session.setMap(c); localStorage.setItem(MAP_KEY, c); },
    start: () => { savePrefs({ seats: seatPrefsOf(session.lobby.slots()) }); launch((w) => session.start(w), ui!.root); },
    back: () => location.reload(),
  }, () => location.reload(), (text) => {
    const c = parseCommand(text);
    if (!c) session.localChat(text);
    else if (c.kind === 'spectate') ui!.addChat('', session.toggleSpectate().text);
    else if (c.kind === 'money') ui!.addChat('', c.amount === null ? MONEY_USAGE : MONEY_NOT_IN_MATCH);
    else ui!.addChat('', c.kind === 'help' ? HELP_TEXT : unknownCommand(c.name));
  });
  session.setMap(storedMapChoice());
  addInviteButton(ui.root, session.code);
  console.info(`[host] room ${session.code} open`);
}

async function joinLobby(code: string, name: string, menu: HTMLElement, rejoin?: string) {
  const { link, lobby } = await joinRoom(pickTransport(location.search), code, name, rejoin).catch((err) => {
    clearRejoin(); // the seat is gone (grace over / match ended / host left): no more offers
    throw err;
  });
  menu.remove();
  const ui = new LobbyUi(app, code, null, () => { clearRejoin(); link.close(); location.reload(); }, (text) => {
    const c = parseCommand(text);
    if (!c) link.send({ t: 'chat', text });
    else ui.addChat('', c.kind === 'spectate' ? HOST_ONLY : c.kind === 'money' ? MONEY_HOST_ONLY : c.kind === 'help' ? HELP_TEXT : unknownCommand(c.name));
  });
  ui.render(lobby.slots, lobby.you, lobby.map);
  addInviteButton(ui.root, code);
  let slots = lobby.slots;
  let phase: 'lobby' | 'starting' | 'game' | 'over' = 'lobby';
  let early: HostMsg[] = [];
  let game: Game | null = null;
  const launch = (m: Extract<HostMsg, { t: 'start' }>, screen: HTMLElement) => {
    phase = 'starting';
    early = [];
    const backend = remoteBackend(link, m, early);
    // A spectating host has no player for the scoreboard to mark.
    startGame(backend, screen, undefined, { hostId: slots[0]?.kind === 'human' && slots[0].spectator ? null : 1, role: { kind: 'client' } }).then((g) => { game = g; phase = 'game'; }, (err) => {
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
    // Connection quality + reconnect bookkeeping, in any phase.
    if (m.t === 'ping') { link.send({ t: 'pong', n: m.n }); return; }
    if (m.t === 'net') { netStatus.rtt = m.rtt; netStatus.host = m.host; return; }
    if (m.t === 'rejoin') { saveRejoin({ code, token: m.token, name }); return; }
    if (phase === 'over') return;
    if (phase === 'starting') { early.push(m); return; }
    if (phase === 'game') {
      // The game's backend handles everything else; the host restarting or returning to the lobby is ours.
      if (m.t === 'start') { game?.destroy(); game = null; launch(m, loadingScreen('Host started a rematch…')); }
      else if (m.t === 'lobby') { game?.destroy(); game = null; phase = 'lobby'; slots = m.slots; app.append(ui.root); ui.render(m.slots, m.you, m.map); }
      return;
    }
    if (m.t === 'lobby') { slots = m.slots; ui.render(m.slots, m.you, m.map); }
    else if (m.t === 'chat') ui.addChat(m.from, m.text);
    else if (m.t === 'ended') { phase = 'over'; ui.error(m.reason === 'host-left' ? 'The host closed the lobby.' : `Removed from lobby (${m.reason}).`); }
    else if (m.t === 'start') { ui.loading(m.map.name); launch(m, ui.root); }
  });
}

// ---------------------------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------------------------

/** A running game; destroy() removes every trace of it (rematch / back to lobby). */
type Game = { destroy(): void };
/** spectate / money: what /spectate and /money do here (host / vs bot); absent for a joined friend. */
type EndCtx = { role: EndRole; hostId: number | null; spectate?: () => SpectateResult; money?: (amount: number) => string };

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
  /** Dynamic resolution: drops the render scale while frames run over budget, restores it when stable. */
  const dynRes = new DynamicResolution();
  dynRes.enabled = settings.get().video.dynamicResolution;
  const offSettings = settings.subscribe((st) => {
    renderer.world.sky.setQuality(st.video.quality);
    renderer.world.sky.setResolutionScale(st.video.resolutionScale);
    dynRes.enabled = st.video.dynamicResolution;
    renderer.world.sky.setDynamicScale(dynRes.scale);
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
  renderer.localGunPoint = (which, out) => fpv.gunPoint(which, out);
  // Sim clock as of now: the latest snapshot's time plus how long ago it arrived (reload animation/beats).
  let snapTime = 0, snapAt = performance.now();
  const simNow = () => snapTime + Math.min(0.1, (performance.now() - snapAt) / 1000);
  let adsWas = false;

  let map: IslandLayout[] = [];
  let mapDef: MapDef | null = null;
  let humanId = 0;
  /** No player of our own this match (spectating host, or handed to a bot via /spectate). */
  let watching = false;
  let snap: Snapshot | null = null;
  // Build aiming runs locally every frame against the predictor's collision world (no server round
  // trip): the ghost colour is always current and a click sends exactly the spot the ghost shows.
  const buildAim = new BuildAim();
  let aim: AimOutcome | null = null;
  /** Newest snapshot as received (not delayed by the interpolation buffer): busy state, pieces. */
  let latest: Snapshot | null = null;
  /** A sent build not yet confirmed by a 'placed' event (one at a time, so drag-build can't double-place). */
  let buildPending: { at: number } | null = null;
  /** A click that couldn't place yet (busy placing the last piece) still counts for a moment. */
  let placeWantedAt = -Infinity;
  let lastSnapKey = '';
  const debugPreviews = new Map<number, (r: Placement) => void>();
  let debugPreviewSeq = 0;
  let wasLocked = false;
  let paused: HTMLElement | null = null;
  let dead: HTMLElement | null = null;
  let predictor: Predictor | null = null;
  const buffer = backend.buffered ? new SnapshotBuffer<Snapshot>(0.1) : null;

  const openPanel = (kind: 'shop' | 'potions' | 'vault') => {
    if (kind === 'shop' || kind === 'potions') hud.openShop(kind); else { hud.openVault(); audio.ui('vault'); }
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
  const sealAnnouncer = new SealAnnouncer(app, (k) => {
    canvas.style.setProperty('--shake', `${Math.round(6 + 10 * k)}px`);
    canvas.classList.remove('shake');
    void canvas.offsetWidth;
    canvas.classList.add('shake');
  });
  /** Leaving on purpose: no reconnect offer afterwards. */
  const leave = () => { clearRejoin(); location.reload(); };
  // Shop buys go through a paced queue: Shift+click buys several pieces, one per sim tick.
  const buys = new BuyQueue();
  const buyItem = (item: ShopItem, bulk = false) => {
    buys.add(item, bulk && isPieceItem(item) ? BULK_PIECES : 1);
    if (qol.lastBuy !== item) { qol.lastBuy = item; savePrefs({ lastBuy: item }); }
  };
  const hud = new Hud(app, {
    buy: (item, bulk) => buyItem(item, bulk),
    vault: (a) => input.queue({ vault: a }),
    closePanel,
    backToMenu: leave,
    endButtons: (over) => endButtons(end.role, over, {
      spectate: () => { spectateChosen = true; hud.setEndVisible(false); input.enabled = !dead; canvas.focus(); input.requestLock(); },
      backToMenu: leave,
    }),
    select: (i) => input.select(i),
    moveSlot: (from, to) => input.queue({ moveSlot: { from, to } }),
  });
  const online = backend.buffered || !!onChat;
  const qol = new QolHud(hud.root, { quickBuy: (item) => buyItem(item) }, { online, isHost: !!onChat });
  qol.lastBuy = loadPrefs().lastBuy;
  let rejoinTouchedAt = 0;
  // Killcam: replays your death from the killer's view during the respawn wait (Space skips).
  const killcam = new Killcam(hud.root);
  let killcamCam: InstanceType<typeof ThirdPersonCamera> | null = null;
  let killcamWas = false;
  window.addEventListener('keydown', (e) => {
    if (!killcam.active || e.code !== 'Space' || e.repeat || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // not a spectator "fly up"
    killcam.skip();
  }, { capture: true });

  const input = new InputController(canvas, {
    interact: () => {
      const station = hud.nearStation();
      if (station === 'shop' || station === 'potions' || station === 'vault') openPanel(station);
      else input.queue({ interact: true });
    },
    place: () => { placeWantedAt = performance.now(); tryPlace(); },
    lockChange: (locked) => {
      if (locked) {
        wasLocked = true; hidePause(); hint.style.display = 'none';
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
      const c = parseCommand(text);
      if (c) { runCommand(c); return; } // commands are never sent as chat
      if (backend.buffered || onChat) backend.chat(text); // online: the host relays (and echoes) it
      else chat.add('You', text); // vs bot: local echo only
    },
    typing: (open) => {
      input.enabled = !open && !hud.panelOpen && !hud.ended && !dead;
      if (!open) { canvas.focus(); input.requestLock(); }
    },
  });
  onChat?.(chat);

  function runCommand(c: NonNullable<ReturnType<typeof parseCommand>>) {
    if (c.kind === 'help') { chat.add('', HELP_TEXT); return; }
    if (c.kind === 'unknown') { chat.add('', unknownCommand(c.name)); return; }
    if (c.kind === 'money') {
      // Guests never send it anywhere: the host check happens before validation feedback.
      if (!end.money) chat.add('', MONEY_HOST_ONLY);
      else chat.add('', c.amount === null ? MONEY_USAGE : end.money(c.amount));
      return;
    }
    if (!end.spectate) { chat.add('', HOST_ONLY); return; }
    const r = end.spectate();
    chat.add('', r.text);
    if (r.handoff) leavePlayer();
  }

  /** Our player now belongs to a bot: drop every tie to it and watch through the free-fly camera. */
  function leavePlayer() {
    console.info(`[game] player ${humanId} handed to a bot; spectating`);
    humanId = 0;
    watching = true;
    predictor = null;
    renderer.setLocalPlayer(0);
    renderer.setLocal(null);
    hud.setMap(map, 0, -1);
    audio.setMap(map, 0);
  }

  // FPS counter hotkey (rebindable; Settings → Video has the same toggle).
  window.addEventListener('keydown', (e) => {
    if (e.repeat || !isAction('fps', e.code) || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    settings.update((d) => { d.video.showFps = !d.video.showFps; });
  });

  const spectator = new Spectator(app, renderer.camera, () => renderer.collidables, canvas, () => input.enabled);
  const scoreboard = new Scoreboard(app);
  const scoreOpts = () => ({ humanId, hostId: end.hostId, ...(online ? { ping: (id: number) => qol.pingFor(id, end.hostId), hostTick: netStatus.host } : {}) });
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

  /** Remove the pause card; vs bot, the simulation runs again. */
  function hidePause() {
    if (!paused) return;
    paused.remove();
    paused = null;
    backend.pause?.(false);
  }

  function showPause() {
    input.enabled = false;
    backend.pause?.(true); // vs bot: the world stops (online it can't)
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
    resume.onclick = () => { input.enabled = true; input.requestLock(); hidePause(); };
    resume.dataset.testid = 'resume';
    paused.dataset.testid = 'pause';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:var(--muted)';
    note.textContent = backend.pause ? 'Match paused.' : 'Online matches keep running while this menu is open.';
    const quit = document.createElement('button');
    quit.className = 'btn';
    quit.textContent = online ? 'Leave match' : 'Quit to menu';
    quit.dataset.testid = 'pause-quit';
    quit.onclick = leave;
    card.append(title, resume, settingsButton(), quit, note);
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
    hidePause();
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
    back.onclick = leave;
    card.append(title, note, back);
    dead.append(card);
    document.body.append(dead);
  }

  // Capture phase so this runs before InputController's listener; stopping propagation keeps the
  // same E press from immediately re-opening the panel we just closed.
  window.addEventListener('keydown', (e) => {
    if (!hud.panelOpen) return;
    // B in the shop: buy the last item again.
    if (e.code === 'KeyB' && !e.repeat && qol.lastBuy && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); buyItem(qol.lastBuy, e.shiftKey); return; }
    if (e.code === 'Escape' || (isAction('interact', e.code) && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }, { capture: true });
  window.addEventListener('resize', () => renderer.resize());

  const SNAP_LABEL: Record<string, string> = { bridge: 'snap: bridge', shore: 'snap: bridge start', gap: 'snap: fill gap',
    beside: 'snap: in line', stack: 'snap: stack', door: 'snap: plug doorway', ramp: 'snap: ramp up' };
  const ghostState = () => (aim ? aim.ok : null);
  const buildNote = () => (!aim ? null : !aim.ok ? `✕ ${aim.reason}` : SNAP_LABEL[aim.tag] ?? null);

  /** Place from the current ghost if it's valid, we have the piece and aren't still placing the last one. */
  function tryPlace(): boolean {
    const now = performance.now();
    if (buildPending && now - buildPending.at > 1500) buildPending = null; // lost / rejected
    if (!aim?.ok || !aim.req || buildPending) return false;
    const me = latest?.players.find((p) => p.id === humanId);
    if (!me || !me.alive || (me.inv.pieces[aim.req.kind] ?? 0) <= 0) return false;
    if (me.busyUntil > latest!.time) return false;
    input.queue({ build: aim.req });
    buildPending = { at: now };
    placeWantedAt = -Infinity;
    renderer.pulseGhost();
    return true;
  }

  /** Crosshair gap from the spread cone, reload ring progress, rifle scope. */
  const gunHud = (me: Snapshot['players'][number] | undefined) => {
    if (!me?.alive || me.equipped === 'fists') return { spreadPx: 4, reload: null, scoped: false };
    const now = simNow();
    const deg = spreadDeg(me.equipped, { ads: fpv.adsK > 0.5, bloom: me.bloom, lastShotAt: me.lastShotAt }, now,
      { speed: Math.hypot(me.vel.x, me.vel.z), grounded: Math.abs(me.vel.y) < 0.5 });
    const cam = renderer.camera;
    const px = (Math.tan((deg * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (canvas.clientHeight / 2);
    const c = reloadClock(me, now);
    return { spreadPx: px, reload: c ? c.elapsed / c.duration : null, scoped: me.equipped === 'rifle' && fpv.adsK > 0.9 };
  };

  // Client shot prediction (shotPredict.ts); predictShot is defined with the frame loop.
  const shots = new ShotPredictor();
  /** Debug: when own shots were shown (predicted) and when the host's shot events reached the effects (old path). */
  const shotTimes = { predicted: [] as number[], applied: [] as number[] };
  const applySnapshot = (s: Snapshot) => {
    const first = !snap;
    if (DEBUG) for (const e of s.events) if (e.type === 'shot' && e.data.by === humanId) shotTimes.applied.push(performance.now());
    snap = s;
    snapTime = s.time; snapAt = performance.now();
    hud.pushEvents(renderer.pushSnapshot(s));
    const meSnap = s.players.find((p) => p.id === humanId);
    fpv.onEvents(s.events, humanId, meSnap?.alive ? meSnap.pos : null);
    // (Own 'shot'/'hit' events flagged echo were already shown when predicted; their effects skip them.)
    // My recoil: the sim reports each kick with the shot; it moves my real aim (I have to pull against it).
    for (const e of s.events) {
      const kick = e.data.kick as { pitch: number; yaw: number } | undefined;
      if (e.type === 'shot' && e.data.by === humanId && kick && !first) input.addKick(kick.pitch, kick.yaw);
    }
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
    sealAnnouncer.onSnapshot(s, humanId);
    const meNow = s.players.find((p) => p.id === humanId);
    input.held = meNow?.hotbar[input.selected] ?? null;
    const wasEnded = hud.ended;
    hud.update(s, { selected: input.selected, ghostOk: input.buildMode ? ghostState() : null, buildNote: input.buildMode ? buildNote() : null, free: input.free, inventory: input.inventory, ...gunHud(meNow) });
    if (hud.ended && !wasEnded) spectateChosen = false; // a (new) result popped the end screen up
    scoreboard.update(s, scoreOpts());
    const recap = qol.onSnapshot(s, input.selected);
    if (killcam.active && (meNow?.alive || s.winner !== null)) killcam.stop(meNow?.alive ? 'respawned' : 'match over');
    const died = s.events.find((e) => e.type === 'kill' && e.data.victim === humanId);
    if (died && meNow && s.winner === null && !watching) {
      const killer = typeof died.data.killer === 'number' && died.data.killer !== humanId ? died.data.killer : null;
      const respawnIn = meNow.respawnAt !== null && !meNow.eliminated ? meNow.respawnAt - s.time : null;
      const k = recap?.killer;
      if (killcam.start(died.t, killer, respawnIn, k ? { killerName: k.name, island: k.island, weapon: recap.weapon, distance: recap.distance, headshot: recap.headshot } : null)) {
        hud.setEndVisible(false); // eliminated: the end screen waits for the killcam
      }
    }
    if (backend.buffered) {
      // Guest: keep the rejoin record fresh while the match runs; a finished match has nothing to rejoin.
      if (s.winner !== null) clearRejoin();
      else if (performance.now() - rejoinTouchedAt > 2000) { rejoinTouchedAt = performance.now(); touchRejoin(); }
    }
    chat.enabled = !hud.ended && !dead && !hud.panelOpen;
    if (hud.ended && input.enabled) { input.enabled = false; if (document.pointerLockElement) document.exitPointerLock(); }
  };

  backend.connect({
    map: (def, id, island) => {
      mapDef = def;
      map = def.islands;
      humanId = id;
      console.info(`[main] map: ${def.name} (${def.template}, ${map.length} islands)`);
      loading.progress('map', 0, `Loading ${def.name}`);
      renderer.setMap(def, humanId);
      loading.progress('map', 1, `Building ${def.name}`);
      maybeWarm();
      watching = id === 0;
      if (id === 0) {
        // Spectating host: no player of our own; start the free-fly camera high over the islands.
        const m = map;
        const cx = m.reduce((a, i) => a + i.center.x, 0) / m.length, cz = m.reduce((a, i) => a + i.center.z, 0) / m.length;
        const r = Math.max(...m.map((i) => Math.hypot(i.center.x - cx, i.center.z - cz) + i.radius));
        renderer.camera.position.set(cx, m[0].groundY + r * 0.55, cz + r * 1.05);
        input.yaw = 0;
        input.pitch = -0.45;
      } else
      // Client-side prediction of our own movement (same movement code + a local collision world).
      import('./predict').then(({ Predictor: P }) => P.create(def, id)).then((p) => { predictor = p; },
        (err) => console.error('[predict] could not start; falling back to server positions', err));
      hud.setMap(map, humanId, island, def.center);
      qol.setMap(map, humanId, island);
      audio.setMap(map, humanId);
    },
    snapshot: (s) => {
      // Newest state goes straight to prediction and interpolation; events/HUD may be delayed.
      predictor?.onSnapshot(s);
      killcam.push(s);
      latest = s;
      if (buffer) qol.onNetSnapshot();
      shots.reconcile(s.events, humanId, performance.now());
      if (buildPending && s.events.some((e) => e.type === 'placed' && (e.data as { by?: number }).by === humanId)) buildPending = null;
      renderer.ingest(s);
      if (buffer) buffer.push(s); else applySnapshot(s);
    },
    // Ghost validation is local now (buildAim); the sim's preview only answers debug cross-checks.
    preview: (result, key) => { debugPreviews.get(key)?.(result); debugPreviews.delete(key); },
    chat: (from, text) => chat.add(from, text),
    fatal: showFatal,
    reconnect: () => {
      const r = loadRejoin();
      showFatal('Connection lost', 'Reconnecting to the host… a bot plays your seat until you are back.');
      // Is the host still there? If its room is gone the match is over; otherwise reload and take the seat back.
      const hostGone = () => {
        clearRejoin();
        dead?.remove();
        dead = null;
        showFatal('Host left', 'Match over: lost the connection to the host.');
      };
      if (!r) { hostGone(); return; }
      pickTransport(location.search).join(r.code).then((probe) => {
        probe.close();
        console.info('[rejoin] host still up; reloading to reclaim the seat');
        markAutoRejoin();
        location.reload();
      }, (err) => { console.info('[rejoin] host unreachable', err); hostGone(); });
    },
  });

  if (DEBUG) {
    (window as unknown as { __faefight: unknown }).__faefight = {
      ...(backend.debug ?? {}),
      snapshot: () => snap,
      map: () => map,
      mapDef: () => mapDef,
      humanId: () => humanId,
      renderInfo: () => renderer.info(),
      renderer,
      chatLines: () => [...document.querySelectorAll('.chat-line')].map((n) => n.textContent),
      input,
      cameraMode: () => fpv.mode,
      cameraFov: () => renderer.camera.fov,
      adsK: () => fpv.adsK,
      spectator: () => ({
        ...spectator.info(),
        camera: { x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z },
        // Own avatar shown? (hiddenId hides it; a dead avatar is hidden after its death pose.)
        selfVisible: renderer.characters.hiddenId !== humanId &&
          !!(renderer.characters as unknown as { avatars: Map<number, { group: Object3D }> }).avatars.get(humanId)?.group.visible,
      }),
      scoreboard: () => scoreboard.visible,
      audio: () => audio.stats(),
      killcam: () => killcam.info(),
      audioPlay: (cue: Parameters<AudioSystem['debugPlay']>[0]) => audio.debugPlay(cue),
      settings: () => settings.get(),
      /** Local player's rendered (predicted) feet this frame, and prediction stats. */
      predicted: () => ({ active: !!predictor?.active, pos: lastRendered, seq: moveSeq, stats: predictor?.stats ?? null, pending: predictor?.pending ?? 0 }),
      frames: () => frameStats(),
      resetFrames: () => { frameMs.length = 0; workMs.length = 0; renderer.gpuMs.length = 0; },
      gpuMs: () => renderer.gpuStats(),
      renderScale: () => ({ dyn: dynRes.scale, pixelRatio: renderer.world.sky.pixelRatio, smoothedMs: dynRes.smoothedMs }),
      interpDelay: () => renderer.interpDelay,
      shotPredict: () => ({ ...shots.stats, inFlight: shots.inFlight, times: shotTimes }),
      /** Current build ghost: snap tag, ghost/rest position, rotation, validity (+ reason) and the exact request a click sends. */
      buildAim: () => aim,
      /** The sim's own verdict for a build request (round trip), to cross-check the local ghost. */
      serverPreview: (req: BuildRequest) => new Promise<Placement>((res) => { const k = ++debugPreviewSeq; debugPreviews.set(k, res); backend.preview(req, k); }),
    };
  }

  // ---- client shot prediction (shotPredict.ts) ----
  const shotRay = new THREE.Raycaster();
  const shotFrom = new THREE.Vector3(), shotDir = new THREE.Vector3(), victimFeet = new THREE.Vector3();
  /** Fire pressed this frame: show the shot now if the gun can fire; predict a hitmarker when it can't miss. */
  const predictShot = (yaw: number, pitch: number) => {
    const meNew = latest?.players.find((p) => p.id === humanId);
    const w = shots.tryFire(meNew, performance.now());
    if (!w || !meNew) return;
    if (DEBUG) shotTimes.predicted.push(performance.now());
    const range = WEAPONS[w].range;
    shotFrom.set(feet.x, feet.y + PLAYER.eyeHeight, feet.z);
    const d = aimDirection(yaw, pitch);
    shotDir.set(d.x, d.y, d.z);
    shotRay.set(shotFrom, shotDir);
    shotRay.far = range;
    const hit = shotRay.intersectObjects(renderer.aimTargets(), false)[0];
    const to = hit ? hit.point : shotFrom.clone().addScaledVector(shotDir, range);
    const ev = { t: simNow(), type: 'shot' as const, data: { by: humanId, weapon: w, from: { x: shotFrom.x, y: shotFrom.y, z: shotFrom.z }, to: { x: to.x, y: to.y, z: to.z }, predicted: true } };
    renderer.localEvent(ev);
    fpv.onEvents([ev], humanId, meNew.pos);
    audio.predicted('shot', w);
    const victim = hit && w !== 'rocket' ? renderer.characters.playerOf(hit.object) : null;
    if (victim === null || !renderer.playerPos(victim, victimFeet)) return;
    // Only when the whole spread cone fits on the body: the host's random spread can't make it a miss.
    const cone = spreadDeg(w, { ads: fpv.adsK > 0.5, bloom: meNew.bloom, lastShotAt: meNew.lastShotAt }, simNow(),
      { speed: Math.hypot(meNew.vel.x, meNew.vel.z), grounded: Math.abs(meNew.vel.y) < 0.5 });
    if (WEAPONS[w].pellets === 1 && Math.atan2(PLAYER.radius * 0.8, hit!.distance) < (cone * Math.PI) / 180) return;
    shots.markHit();
    const head = to.y >= victimFeet.y + HEAD.y - HEAD.r;
    hud.hitmarker(head);
    audio.predicted('hitmarker');
    if (head) audio.predicted('headshot');
    renderer.gunFx.onEvent({ t: ev.t, type: 'hit', data: { target: victim, by: humanId, pos: { x: to.x, y: to.y, z: to.z }, part: to.y >= victimFeet.y + HEAD.y - HEAD.r ? 'head' : 'body', weapon: w } }, humanId);
  };

  // ---- frame loop ----
  const feet = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  const sendAcc = new InputAccumulator();
  let nextSendAt = 0;
  let last = performance.now();
  // Movement commands: fixed 1/30 s steps on our clock, applied locally at once (prediction) and sent.
  let moveSeq = 0;
  let moveAcc = 0;
  let jumpLatch = false;
  let unsent: MoveCmd[] = [];
  let sentTail: MoveCmd[] = []; // last commands already sent (input redundancy)
  const predicted = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  let lastRendered: { x: number; y: number; z: number } | null = null;
  const eyeY = new VerticalSmoother();
  const viewFeet = new THREE.Vector3();
  const frameMs: number[] = [];
  const frameStats = () => {
    const xs = [...frameMs].sort((a, b) => a - b);
    const q = (k: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * k))] ?? 0;
    const ws = [...workMs].sort((a, b) => a - b);
    const wq = (k: number) => ws[Math.min(ws.length - 1, Math.floor(ws.length * k))] ?? 0;
    return {
      n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / (xs.length || 1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: xs[xs.length - 1] ?? 0,
      /** Main-thread time spent inside the frame callback (CPU cost, independent of vsync). */
      cpuAvg: ws.reduce((a, b) => a + b, 0) / (ws.length || 1), cpuP95: wq(0.95), cpuP99: wq(0.99),
      hitches: xs.filter((x) => x > 25).length,
    };
  };
  const workMs: number[] = [];
  let fpsFrames = 0, fpsSince = last;
  let lastDrawn = 0;
  const frame = () => {
    const now = performance.now();
    // Settings → Video frame cap (rAF itself is vsync-locked; this only skips frames below it).
    const cap = settings.get().video.frameCap;
    if (cap && now - lastDrawn < 1000 / cap - 2) { requestAnimationFrame(frame); return; }
    lastDrawn = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    if (revealed) {
      dynRes.frame(now - last, 1000 / (cap || 60));
      renderer.world.sky.setDynamicScale(dynRes.scale);
    }
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
    const nextBuy = buys.take(now);
    if (nextBuy) input.queue({ shop: { buy: nextBuy } });
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
    // No player of our own (spectating host / handed to a bot), dead (respawning or eliminated), or free
    // fly picked on the end screen: invisible spectator camera.
    const spectating = !!snap && (watching || (!!me && (!me.alive || spectateChosen)));
    const kc = killcam.active ? killcam.frame(now) : null;
    if (!kc && killcamWas) {
      // Killcam over: back to the live world; the normal death flow (free-fly, end screen) carries on.
      renderer.setReplay(null);
      if (!spectateChosen) hud.setEndVisible(true);
    }
    killcamWas = !!kc;
    if (kc) {
      spectator.exit();
      renderer.setReplay({ snap: kc.snap, motion: kc.motion });
      renderer.replayEvents(kc.events);
      renderer.characters.hiddenId = -1;
      renderer.setGhost(null);
      aim = null;
      killcamCam ??= new ThirdPersonCamera(renderer.camera, () => renderer.collidables);
      killcamCam.update(feet.set(kc.feet.x, kc.feet.y, kc.feet.z), kc.yaw, kc.pitch, dt);
    } else if (spectating) {
      spectator.enter(renderer.camera.position);
      renderer.characters.hiddenId = humanId;
      renderer.setGhost(null);
      aim = null;
      spectator.frame({ cam: renderer.camera, yaw: input.yaw, pitch: input.pitch, dt, humanId, players: snap!.players,
        posOf: (id, out) => renderer.playerPos(id, out) });
    } else spectator.exit();
    input.applyKick(dt);
    // Sights: right mouse with a gun, not while reloading (the sim agrees). Zoom slows mouse look to match.
    const adsWant = !!me?.alive && !spectating && input.ads && me.equipped !== 'fists' && me.reloadUntil === 0;
    if (adsWant && !adsWas) audio.local('ads');
    adsWas = adsWant;
    fpv.setAds(adsWant, dt);
    input.lookScale = me && me.equipped !== 'fists' ? 1 / (1 + (WEAPONS[me.equipped].adsZoom - 1) * fpv.adsK) : 1;
    if (me && !spectating && renderer.playerPos(humanId, feet)) {
      lastRendered = { x: feet.x, y: feet.y, z: feet.z };
      // Cameras follow a vertically smoothed feet position (steps/ramps/corrections don't jolt the
      // view); look angles are applied raw.
      const view = viewFeet.set(feet.x, eyeY.update(feet.y, predicting ? predicted.vel.y : null, dt), feet.z);
      if (!fpv.updateCamera(view, input.yaw, input.pitch, me, humanId)) camera.update(view, input.yaw, input.pitch, dt);

      // Build ghost (holding a piece): where the crosshair points (or a nearby snap spot), validated
      // locally every frame against the predictor's world with the sim's own rules.
      input.held = me.hotbar[input.selected] ?? null;
      const buildKind = input.buildKind;
      if (buildKind && me.alive && predictor) {
        const cam = renderer.camera;
        cam.getWorldDirection(aimDir);
        aim = buildAim.update({
          physics: predictor.world, kind: buildKind,
          ray: { eye: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, dir: { x: aimDir.x, y: aimDir.y, z: aimDir.z } },
          player: { x: feet.x, y: feet.y, z: feet.z }, yaw: input.yaw, buildRot: input.buildRot, free: input.free,
          humanId, pieces: (latest ?? snap!).pieces, islands: map, myIsland: me.island,
        });
        if (!(me.inv.pieces[buildKind] ?? 0)) { aim.ok = false; aim.reason = 'none left'; aim.req = null; }
        const snapKey = aim.tag === 'aim' ? '' : `${aim.tag}${aim.ghost.x.toFixed(1)}${aim.ghost.z.toFixed(1)}`;
        if (snapKey && snapKey !== lastSnapKey && aim.ok) audio.ui('tick', 0.15);
        lastSnapKey = snapKey;
        renderer.setGhost(buildKind, aim.ghost, aim.rotY, aim.ok, aim.ok ? aim.anchor : null);
        if (input.clickHeld || now - placeWantedAt < 350) tryPlace();
      } else {
        renderer.setGhost(null);
        aim = null;
      }
    }

    // Spectating: the sim ignores a dead player anyway; an alive winner flying around must not act either.
    if (spectating) sample = { ...NO_INPUT, yaw: me?.yaw ?? input.yaw, pitch: me?.pitch ?? input.pitch, select: input.selected };
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
    if (sample.fire && me?.alive && !spectating) predictShot(sample.yaw, sample.pitch);
    // Lag compensation: tell the host which moment of everyone else we were looking at when we fired.
    const viewT = renderer.renderTime;
    if (sample.fire && viewT !== null) sample.viewT = viewT;
    if (backend.inputHz === null) { backend.input(sample, unsent); unsent = []; }
    else {
      // Network: send at a fixed rate; taps between sends are accumulated, never lost.
      sendAcc.push(sample);
      if (snap && now >= nextSendAt) {
        // Redundancy: re-send the last few commands too (the host's MoveQueue drops seqs it has), so a
        // late or lost input message doesn't cost a movement step on links that drop.
        const cmds = [...sentTail, ...unsent].slice(-MAX_CMDS_PER_MSG);
        backend.input(sendAcc.take(), cmds);
        sentTail = cmds.slice(-REDUNDANT_CMDS);
        unsent = [];
        nextSendAt = Math.max(nextSendAt + 1000 / backend.inputHz, now - 1000 / backend.inputHz);
      }
    }
    const cp = renderer.camera.position;
    qol.frame(input.yaw, me?.alive && !spectating ? { x: feet.x, z: feet.z } : { x: cp.x, z: cp.z }, snap);
    damageFx.frame(renderer.camera, input.yaw, me?.alive ? feet : null, (id) => renderer.playerPos(id, fxPos));
    fpv.applyShake(dt); // visual only: the aim ray above was taken without it
    renderer.render(input.yaw);
    fpv.render(spectating ? undefined : me, input.yaw, input.pitch, dt, predicting ? predicted.vel : undefined, simNow());
    audio.frame(renderer.camera);
    audio.rockets(renderer.gunFx.liveRockets());
    if (warmed && !revealed) {
      framesAfterWarm++;
      loading.progress('frames', framesAfterWarm / WARM_FRAMES);
      if (framesAfterWarm >= WARM_FRAMES) reveal();
    }
    workMs.push(performance.now() - now);
    if (workMs.length > 600) workMs.shift();
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
  if (isMobileDevice(currentDevice())) {
    // Phones and tablets: a card instead of the game, and nothing of the game is loaded.
    console.info('[main] mobile device: showing the computer-only card');
    void loading.hide();
    showComputerOnly(app);
    return;
  }
  loading.show('boot', { styles: 1, fonts: 1, menu: 1 });
  applyDocumentSettings();
  loading.progress('styles', 1);
  // System fonts only, but wait for them (bounded) so the menu never reflows after it appears.
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  loading.progress('fonts', 1);
  showMenu();
  loading.progress('menu', 1);
  void loading.hide().then(firstLaunchHowTo);
  preloadGame();
}

boot().catch((err) => {
  console.error('[main] boot failed', err);
  if (isMobileDevice(currentDevice())) showComputerOnly(app); else showMenu();
});
