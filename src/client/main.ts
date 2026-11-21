import './style.css';
import type { Object3D } from 'three/webgpu';
import type { HostMsg, Slot, ViewExtras } from '../net/protocol';
import { SnapshotDecoder, type NetSnapshot } from '../net/snapshotCodec';
import { WireDecoder } from '../net/wire';
import type { Link } from '../net/transport';
import { normalizeCode } from '../net/code';
import { pickTransport } from '../net/index';
import type { Placement } from '../sim/building';
import { BuildAim, type AimOutcome } from './buildAim';
import { DT, HEAD, LIFECYCLE, PLAYER, TICK_HZ, WEAPONS } from '../sim/constants';
import { spreadDeg } from '../sim/gunplay';
import type { MoveCmd } from '../sim/movement';
import { MAP_NAMES, MAP_TEMPLATES, resolveMapChoice, type IslandLayout, type MapChoice, type MapDef, type MapTemplate } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import { NO_INPUT, type BuildRequest, type Difficulty, type Inventory, type PieceKind, type PieceState, type PlayerInput, type ShopItem, type Snapshot } from '../sim/types';
import { BuildPredictor } from './buildPredict';
import type { BrainDigest } from '../sim/bots/introspect';
import { moveForAim } from './aim';
import { BodyCam, SpectatorCamera, viewedPlayer } from './viewed';
import { AudioSystem } from './audio/engine';
import { errors, installErrorReporting } from './telemetry/errors';
import { telemetryEnabled } from './telemetry/config';
import { installReplayUploads, MIN_UNFINISHED_SEC, replayUploader } from './telemetry/replayUpload';
import { reloadClock } from './firstPerson';
import { ChatUi } from './chatUi';
import { loadGameModules, preloadGame } from './gameModules';
import { InputAccumulator } from './inputAccum';
import { InputController } from './input';
import { ACTIONS, activeKeymap, bindingLabel, isAction, type Action } from './keymap';
import { loadingScreen as loadingOverlay } from './loading';
import { LobbyUi, MapPicker } from './lobbyUi';
import { GameSettingsPanel } from './gameSettingsUi';
import { sanitizeSettings } from '../net/sanitize';
import type { GameSettings } from '../sim/settings';
import type { FromWorker, ToWorker } from './protocol';
import { HostSession, JOIN_ERRORS, JoinError, joinRoom, type SpectateResult } from './session';
import { HELP_TEXT, HOST_ONLY, MONEY_HOST_ONLY, MONEY_NOT_IN_MATCH, MONEY_USAGE, moneyGiven, parseCommand, unknownCommand } from './commands';
import { currentDevice, currentIsChromium, isMobileDevice, showComputerOnly } from './device';
import { openHowTo } from './howTo';
import { SnapshotBuffer } from './snapBuffer';
import { FrameGovernor } from './governor';
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
import { aimDirection, predictedHit, ShotPredictor } from './shotPredict';
import { BUILD, saveReplay, savesSettled, trackSave } from './replay/save';
import { ReplayLink } from './replay/link';
import { showReplays } from './replay/replaysUi';
import { ReplayControls } from './replay/viewerUi';
import { followNewHost, GuestMigration, hostReachable, takeOver, type HeldLink, type HostWorker } from './migration';
import type { PracticeCmd } from '../sim/practice';
import { PracticePanel } from './practicePanel';
import { EmoteWheel } from './emoteWheel';
import { isWheelId, quipLines, type WheelId } from '../sim/emotes';
// UI theme last: its tokens and skin win over style.css / qol.css / settings.css (docs/ui-style.md).
import './ui/theme.css';
import './ui/skin.css';

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

const PAUSE_ICONS = {
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/></svg>',
};

/** Pause-card button: icon + label, same shape as the Settings button. */
function pauseButton(icon: string, label: string, cls: string) {
  const b = document.createElement('button');
  b.className = `${cls} pause-btn`;
  b.innerHTML = icon;
  const span = document.createElement('span');
  span.textContent = label;
  b.append(span);
  return b;
}

/** One-line key help from the live keymap (follows rebinding). */
function keyHelp(): string {
  const k = (a: Action) => bindingLabel(activeKeymap(), a).split(' / ')[0];
  const move = (['forward', 'left', 'back', 'right'] as Action[]).map(k).join('');
  const slots = ACTIONS.filter((a) => a.group === 'Hotbar').map((a) => k(a.id));
  const slotText = slots.join('') === '123456789' ? '1–9' : slots.join(' ');
  return `${move} move · ${k('sprint')} sprint · ${k('jump')} jump · Click fire / place / throw · ${k('aim')} aim · ${k('reload')} reload · ${k('interact')} interact · ${k('chat')} chat · hold ${k('emote')} emotes · ${k('camera')} first person · ${k('mute')} mute<br>`
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
  /** Brain digest of the bot being spectated (~4 Hz): worker directly, or the host for a guest. */
  brain?(d: BrainDigest): void;
  /** Sim time jumped (replay seek): forget interpolation history before the next snapshot. */
  reset?(): void;
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
  /** Emote / quick-chat wheel pick (the host rate-limits it; the sim applies it). */
  wheel?(id: WheelId): void;
  /** Spectating: the player followed (null = none). Remote only: the host then sends their HUD state. */
  follow?(id: number | null): void;
  /** Spectating a human: their ghost / open panel (host: from the session; guest: what the host relayed). */
  viewOf?(id: number): ViewExtras | null;
  /** My ghost / open panel, for whoever spectates me (online only). */
  sendView?(v: ViewExtras): void;
  /** Stop delivering to the sink (game torn down for a rematch / back to lobby). Remote: the link stays open. */
  close(): void;
  /** Vs bot only: stop / restart the simulation (pause card). */
  pause?(paused: boolean): void;
  /** Watching a recording (forced spectator camera, playback controls). */
  replay?: ReplayLink;
  /** Local worker only: practice range panel commands. */
  practice?(cmd: PracticeCmd): void;
  debug?: {
    teleport(x: number, z: number): void; give(inv: Partial<Inventory>, id?: number): void; hp(hp: number): void;
    eliminate(playerId: number): void; kill(playerId: number, killer?: number): void;
    shield(shield: number, id?: number): void; potionShop(x: number, z: number): void;
    /** Jump the match clock (e.g. straight to sudden death), and call a lightning strike (storm running). */
    time(t: number): void; strike(x: number, z: number): void;
    pieces(x: number, z: number, n: number): void;
    /** Place one piece (rules skipped) on the ground at (x, z) + `up` m, owned by `owner` (default: nobody). */
    place(kind: PieceKind, x: number, z: number, rotY: number, up?: number, owner?: number): void;
    /** Detonate a rocket / grenade / charge at (x, ground + up, z). */
    explode(kind: 'rocket' | 'grenade' | 'charge', x: number, z: number, up?: number): void;
    plugDoor(door: number, owner: number): void; removePiece(id: number): void; genStored(stored: number): void;
  };
};

/** Simulation in a local worker: vs-bot (session = null) or online host. */
function workerBackend(setupFor: (w: Worker) => { setup: MatchSetup; humanId: number }, session: HostSession | null): Backend & { handOff(): void } {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (m: ToWorker) => worker.postMessage(m);
  let humanId = 0;
  // Every match is recorded here (vs bot, or online as host), always: kept locally (Replays screen) and,
  // in deployed builds, uploaded so the bots learn from it. No setting turns this off.
  const gotReplay = (m: Extract<FromWorker, { type: 'replay' }>) => {
    if (!m.partial) saveReplay(m.bytes, m.meta);
    void replayUploader?.share(m.bytes, { id: m.meta.id, unfinished: m.partial || m.meta.unfinished, duration: m.meta.duration });
  };
  // Tab hidden mid-match (often the last chance before it's closed): upload what's recorded so far, once, after 60 s of play.
  let simTime = 0, peeked = false;
  const onHidden = () => {
    if (document.visibilityState !== 'hidden' || peeked || simTime < MIN_UNFINISHED_SEC) return;
    peeked = true;
    send({ type: 'peekRecording' });
  };
  let closed = false;
  // Bots whose brain digests the worker should make: the one our camera follows, plus friends' (host).
  let localWatch: number | null = null, watchSig = '';
  const syncWatch = () => {
    const ids = [...new Set([...(localWatch !== null ? [localWatch] : []), ...(session?.brainWants() ?? [])])];
    const sig = ids.join(',');
    if (sig !== watchSig) { watchSig = sig; send({ type: 'brainWatch', ids }); }
  };
  return {
    buffered: false,
    inputHz: null,
    follow: (id) => { localWatch = id; syncWatch(); },
    viewOf: (id) => session?.viewOf(id) ?? null,
    sendView: session ? (v) => session.setLocalView(v) : undefined,
    connect(sink) {
      worker.onerror = (e) => { console.error('[worker] crashed', e.message); errors?.report('worker', e.message, `at ${e.filename}:${e.lineno}:${e.colno}`); sink.fatal('Simulation crashed', e.message); };
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'map') {
          sink.map(m.map, m.humanId, m.humanIsland);
          session?.onMap(m.map, m.islands);
        } else if (m.type === 'snapshot') {
          simTime = m.snap.time;
          sink.snapshot(m.snap);
          session?.onSnapshot(m.snap);
          if (session) syncWatch();
          // Vs bot: quick chat (ours and the bots') shows as chat lines here; online the host session relays it.
          if (!session) for (const l of quipLines(m.snap.events, m.snap.players)) sink.chat(l.from, l.text);
        } else if (m.type === 'brains') {
          const mine = localWatch === null ? undefined : m.digests.find((d) => d.id === localWatch);
          if (mine) sink.brain?.(mine);
          session?.onBrains(m.digests);
        } else if (m.type === 'preview') {
          if (m.playerId === humanId) sink.preview(m.result, m.key);
          else session?.onPreview(m.playerId, m.result, m.key);
        } else if (m.type === 'replay') {
          gotReplay(m);
        } else if (m.type === 'checkpoint') {
          session?.onCheckpoint(m.match, m.tick);
        } else if (m.type === 'error') {
          console.error(`[worker] ${m.message}`);
          errors?.report('worker', m.message);
          toast(m.message);
        }
      };
      document.addEventListener('visibilitychange', onHidden);
      const s = setupFor(worker);
      humanId = s.humanId;
      send({ type: 'start', setup: s.setup, humanId: s.humanId, record: { kind: session ? 'host' : 'solo', build: BUILD } });
    },
    input: (input, cmds) => send({ type: 'input', input, cmds }),
    preview: (req, key) => send({ type: 'preview', playerId: humanId, req, key }),
    chat: (text) => session?.localChat(text),
    wheel: (id) => {
      if (session) session.localWheel(id);
      else if (humanId !== 0) send({ type: 'wheel', playerId: humanId, id });
    },
    pause: session ? undefined : (paused) => send({ type: 'pause', paused }),
    practice: (cmd) => send({ type: 'practice', cmd }),
    /** Vs bot /spectate: a bot takes over the local player. */
    handOff: () => send({ type: 'botify', playerId: humanId }),
    debug: {
      teleport: (x, z) => send({ type: 'debug', cmd: 'teleport', x, z }),
      give: (inv, id) => send({ type: 'debug', cmd: 'give', inv, id }),
      hp: (hp) => send({ type: 'debug', cmd: 'hp', hp }),
      shield: (shield, id) => send({ type: 'debug', cmd: 'shield', shield, id }),
      potionShop: (x, z) => send({ type: 'debug', cmd: 'potionShop', x, z }),
      time: (t) => send({ type: 'debug', cmd: 'time', t }),
      strike: (x, z) => send({ type: 'debug', cmd: 'strike', x, z }),
      pieces: (x, z, n) => send({ type: 'debug', cmd: 'pieces', x, z, n }),
      place: (kind, x, z, rotY, up = 0, owner = 0) => send({ type: 'debug', cmd: 'place', kind, x, z, rotY, up, owner }),
      explode: (kind, x, z, up = 0) => send({ type: 'debug', cmd: 'explode', kind, x, z, up }),
      plugDoor: (door, owner) => send({ type: 'debug', cmd: 'plugDoor', door, owner }),
      removePiece: (id) => send({ type: 'debug', cmd: 'removePiece', id }),
      genStored: (stored) => send({ type: 'debug', cmd: 'genStored', stored }),
      eliminate: (playerId) => send({ type: 'debug', cmd: 'eliminate', playerId }),
      kill: (playerId, killer) => send({ type: 'debug', cmd: 'kill', playerId, killer }),
    },
    close() {
      if (closed) return;
      closed = true;
      worker.onerror = null;
      document.removeEventListener('visibilitychange', onHidden);
      // Left before a result: keep what was recorded. The worker sends it, then says it's done.
      trackSave(new Promise<void>((resolve) => {
        const stop = () => { clearTimeout(timer); worker.onmessage = null; worker.terminate(); resolve(); };
        const timer = setTimeout(() => { console.warn('[replays] recording did not finish in time; dropped'); stop(); }, 5000);
        worker.onmessage = (e: MessageEvent<FromWorker>) => {
          if (e.data.type === 'replay') gotReplay(e.data);
          else if (e.data.type === 'recordingDone') stop();
        };
        send({ type: 'finishRecording' });
      }));
    },
  };
}

/** Host migration hooks for a guest's backend (migration.ts); joinLobby owns the lobby-level bookkeeping. */
type MigrationCtx = {
  gm: GuestMigration;
  name: string;
  /** Room code of the current host. */
  code(): string;
  /** Another guest took over: its link replaces the old one (flush() is called after the handlers attach). */
  relink(link: HeldLink, code: string): void;
  /** This guest now hosts the match. */
  promoted(): void;
};

/**
 * Remote client: no simulation; the host link is the source of truth. `early` = messages that arrived
 * before the game was ready. With `mig`, losing the host mid-match migrates it (migration.ts): either this
 * tab takes over (a restored worker + HostSession feed the same game) or it follows the guest who did.
 */
function remoteBackend(firstLink: Link, start: Extract<HostMsg, { t: 'start' }>, early: HostMsg[], mig?: MigrationCtx): Backend {
  let link = firstLink;
  let decoder = new SnapshotDecoder();
  let wire = new WireDecoder();
  const views = new Map<number, ViewExtras>();
  /** After taking over as host (migration): who our camera follows, and the bots the local worker digests. */
  let hostFollow: number | null = null, hostWatchSig = '';
  let closed = false;
  let disposed = false;
  /** Newest snapshot tick and when it arrived; whether the match already has a result. */
  let lastTick = 0, lastTickAt = 0, over = false;
  /** Set once this guest has taken over as host. */
  let hosting: { worker: Worker; session: HostSession | null; humanId: number } | null = null;
  return {
    buffered: true,
    inputHz: TICK_HZ,
    connect(sink) {
      sink.map(start.map, start.playerId, start.island);
      const handle = (m: HostMsg) => {
        if (disposed) return;
        if (m.t === 'snap') {
          const n = wire.decode<NetSnapshot>(m.b);
          if (n) {
            const snap = decoder.decode(n);
            lastTick = snap.tick;
            lastTickAt = performance.now();
            if (snap.winner !== null) over = true;
            sink.snapshot(snap);
          }
        }
        else if (mig?.gm.onHostMsg(m)) return;
        else if (m.t === 'preview') sink.preview(m.result, m.key);
        else if (m.t === 'brain') sink.brain?.(m.d);
        else if (m.t === 'view') views.set(m.id, m.v);
        else if (m.t === 'chat') sink.chat(m.from, m.text);
        else if (m.t === 'ended') {
          closed = true;
          if (m.reason === 'host-left') { if (!migrate(false)) sink.fatal('Host left', 'Match over: the host left the game.'); }
          else sink.fatal('Disconnected', JOIN_ERRORS[m.reason] ?? `Disconnected by the host (${m.reason}).`);
        }
      };
      const attach = (l: Link) => {
        l.onMessage((raw) => { if (l === link) handle(raw as HostMsg); });
        l.onClose(() => {
          if (l !== link || closed || disposed) return;
          closed = true;
          if (migrate(true)) return;
          // No goodbye from the host: maybe just our connection. With a fresh rejoin token, try to take the seat back.
          if (sink.reconnect && loadRejoin()) sink.reconnect();
          else sink.fatal('Host left', 'Match over: lost the connection to the host.');
        });
      };
      /** Host lost mid-match: move the match to the backup. False if this guest can't (no plan/checkpoint yet, match over). */
      const migrate = (probe: boolean): boolean => {
        if (!mig || over || disposed || !mig.gm.ready) return false;
        const { gm, name } = mig;
        const transport = pickTransport(location.search);
        const run = async () => {
          // Our own connection may be what dropped: if the old host still answers, rejoin it as before.
          if (probe && await hostReachable(transport, mig.code())) {
            console.info('[migrate] old host still up; reconnecting to it instead');
            if (sink.reconnect && loadRejoin()) { sink.reconnect(); return; }
            throw new Error('lost the connection to the host');
          }
          toast('Host left: migrating…');
          const t0 = performance.now();
          if (gm.isBackup) {
            const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
            const h: { worker: Worker; session: HostSession | null; humanId: number } = { worker: w, session: null, humanId: start.playerId };
            hosting = h;
            const ready = new Promise<HostWorker>((resolve, reject) => {
              w.onerror = (e) => { console.error('[worker] crashed', e.message); reject(new Error(e.message)); };
              w.onmessage = (e: MessageEvent<FromWorker>) => {
                const m = e.data;
                if (disposed) return;
                if (m.type === 'restored') resolve(w);
                else if (m.type === 'snapshot') {
                  sink.snapshot(m.snap); h.session?.onSnapshot(m.snap);
                  // Brain digests for the bot we follow and the bots friends follow (as workerBackend does).
                  const ids = [...new Set([...(hostFollow !== null ? [hostFollow] : []), ...(h.session?.brainWants() ?? [])])];
                  const sig = ids.join(',');
                  if (sig !== hostWatchSig) { hostWatchSig = sig; w.postMessage({ type: 'brainWatch', ids } satisfies ToWorker); }
                } else if (m.type === 'brains') {
                  const mine = hostFollow === null ? undefined : m.digests.find((d) => d.id === hostFollow);
                  if (mine) sink.brain?.(mine);
                  h.session?.onBrains(m.digests);
                }
                else if (m.type === 'preview') { if (m.playerId === h.humanId) sink.preview(m.result, m.key); else h.session?.onPreview(m.playerId, m.result, m.key); }
                else if (m.type === 'checkpoint') h.session?.onCheckpoint(m.match, m.tick);
                else if (m.type === 'error') { console.error(`[worker] ${m.message}`); reject(new Error(m.message)); toast(m.message); }
              };
            });
            const { session } = await takeOver({
              transport, gm, name, map: start.map, lastTick, lastTickAt,
              startWorker: (match, humanId, botify, toTick) => {
                w.postMessage({ type: 'restore', match, humanId, botify, toTick } satisfies ToWorker, [match.buffer]);
                return ready;
              },
              events: { lobby: () => {}, chat: (from, text) => sink.chat(from, text), net: (rtt, host) => { netStatus.rtt = rtt; netStatus.host = host; } },
            });
            h.session = session;
            mig.promoted();
            session.system(`${name} is now hosting`);
            toast('You are now hosting');
          } else {
            const token = loadRejoin()?.token;
            if (!token || !gm.plan) throw new Error('no seat token for the new host');
            const plan = gm.plan;
            const f = await followNewHost({ transport, plan, name, token });
            gm.plan = null;
            gm.sealed = null; // the new host sends its own plan
            link = f.link;
            decoder = new SnapshotDecoder();
            wire = new WireDecoder();
            closed = false;
            attach(f.link);
            mig.relink(f.link, plan.code);
            f.link.flush();
            toast(`${f.hostName || 'Another player'} is now hosting`);
          }
          console.info(`[migrate] done in ${Math.round(performance.now() - t0)} ms (${hosting ? 'now hosting' : 'following the new host'})`);
          if (DEBUG) (window as unknown as { __faefightMigrated?: string }).__faefightMigrated = hosting ? 'host' : 'guest';
        };
        run().catch((err) => {
          console.warn('[migrate] failed', err);
          if (hosting) { hosting.worker.terminate(); hosting = null; }
          sink.fatal('Host left', `Match over: the host left and the match could not move to another player (${err?.message ?? err}).`);
        });
        return true;
      };
      early.forEach(handle);
      attach(link);
    },
    input: (input, cmds) => {
      if (disposed) return;
      if (hosting) hosting.worker.postMessage({ type: 'input', input, cmds } satisfies ToWorker);
      else link.send({ t: 'input', input, cmds, ack: wire.ack || undefined });
    },
    preview: (req, key) => {
      if (disposed) return;
      if (hosting) hosting.worker.postMessage({ type: 'preview', playerId: hosting.humanId, req, key } satisfies ToWorker);
      else link.send({ t: 'preview', req, key });
    },
    chat: (text) => { if (hosting) hosting.session?.localChat(text); else link.send({ t: 'chat', text }); },
    wheel: (id) => {
      if (disposed) return;
      if (hosting) hosting.session?.localWheel(id); else link.send({ t: 'wheel', id });
    },
    close: () => {
      disposed = true;
      if (hosting) { hosting.session?.close(); hosting.worker.terminate(); hosting = null; }
    },
    // Spectator follow is for a remote host; a guest hosting after a migration has the full snapshot.
    follow: (id) => { hostFollow = id; if (!disposed && !hosting) link.send({ t: 'follow', id }); },
    // Spectating a human: what the host relayed (or, hosting after a migration, the local session's).
    viewOf: (id) => (hosting ? hosting.session?.viewOf(id) ?? null : views.get(id) ?? null),
    sendView: (v) => { if (disposed) return; if (hosting) hosting.session?.setLocalView(v); else link.send({ t: 'view', v }); },
  };
}

/** A recorded match, re-simulated in a worker (replay viewer). */
function replayBackend(bytes: Uint8Array): Backend {
  const link = new ReplayLink(bytes);
  return {
    buffered: false,
    inputHz: null,
    replay: link,
    connect(sink) {
      link.onError = (m) => { console.error(`[replay] ${m}`); toast(m); };
      link.info.then((info) => {
        const h = info.header;
        const id = h.localId || h.players[0]?.id || 1;
        sink.map(info.map, id, h.players.find((p) => p.id === id)?.island ?? 0);
        link.onSnapshot = (m) => { if (m.reset) sink.reset?.(); sink.snapshot(m.snap); };
      }, (err) => sink.fatal('Could not open replay', String(err?.message ?? err)));
    },
    input: () => {},
    preview: () => {},
    chat: () => {},
    close: () => link.close(),
  };
}

/** Watch a recording; Exit goes back to the Replays screen. */
async function playReplay(bytes: Uint8Array, screen: HTMLElement) {
  let game: Game | null = null;
  game = await startGame(replayBackend(bytes), screen, undefined, {
    role: { kind: 'client' },
    hostId: null,
    exitReplay: () => { game?.destroy(); openReplays(); },
  });
}

function openReplays() {
  const screen = showReplays(app, {
    back: () => { screen.remove(); showMenu(); },
    play: (bytes) => {
      screen.querySelectorAll('button').forEach((b) => (b.disabled = true));
      playReplay(bytes, screen).catch((err) => {
        console.error('[replay] failed to start', err);
        toast(`Could not play replay: ${err?.message ?? err}`);
        screen.remove();
        openReplays();
      });
    },
  });
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
  // Game settings for vs-bot matches (same panel and remembered values as the host's lobby). Hidden behind a toggle.
  const soloSettings = new GameSettingsPanel(loadPrefs().settings, (st) => savePrefs({ settings: st }), 'menu-settings');
  soloSettings.root.hidden = true;
  const settingsToggle = document.createElement('button');
  settingsToggle.type = 'button';
  settingsToggle.className = 'btn small toggle gs-toggle';
  settingsToggle.textContent = 'Game settings';
  settingsToggle.dataset.testid = 'menu-settings-toggle';
  settingsToggle.setAttribute('aria-pressed', 'false');
  settingsToggle.onclick = () => {
    soloSettings.root.hidden = !soloSettings.root.hidden;
    settingsToggle.classList.toggle('selected', !soloSettings.root.hidden);
    settingsToggle.setAttribute('aria-pressed', String(!soloSettings.root.hidden));
  };
  for (const d of ['easy', 'medium', 'hard', 'pro'] as Difficulty[]) {
    const b = document.createElement('button');
    b.className = `btn${d === 'medium' ? ' primary' : ''}`;
    b.textContent = d === 'pro' ? 'PRO' : d[0].toUpperCase() + d.slice(1);
    b.dataset.testid = `play-${d}`;
    b.onclick = () => {
      lockMenu();
      const choice = mapSel.value as MapChoice;
      status.textContent = choice === 'random' ? 'Loading…' : `Loading ${MAP_NAMES[choice]}…`;
      playSolo(d, choice, menu, bots.count(), soloSettings.value).catch((err) => {
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
  const replaysBtn = document.createElement('button');
  replaysBtn.className = 'btn menu-settings';
  replaysBtn.textContent = 'Replays';
  replaysBtn.dataset.testid = 'open-replays';
  replaysBtn.onclick = () => { menu.remove(); openReplays(); };
  menuBtns.append(howBtn, settingsButton(), replaysBtn);
  rememberDifficulty(play);
  // Practice range: offline sandbox (targets, dummies, free shop and building). Not a difficulty, so not in `play`.
  const practiceRow = document.createElement('div');
  practiceRow.className = 'practice-play';
  const practiceBtn = document.createElement('button');
  practiceBtn.className = 'btn';
  practiceBtn.textContent = 'Practice';
  practiceBtn.dataset.testid = 'play-practice-range';
  practiceBtn.onclick = () => {
    lockMenu();
    status.textContent = 'Loading the practice range…';
    playPractice(menu).catch((err) => {
      console.error('[main] failed to start practice', err);
      status.textContent = `Failed to start: ${err?.message ?? err}`;
      unlockMenu();
    });
  };
  const practiceNote = document.createElement('span');
  practiceNote.textContent = 'Targets, dummies, free shop & building';
  practiceRow.append(practiceBtn, practiceNote);
  card.append(mapRow, play, bots.root, practiceRow, settingsToggle, soloSettings.root, online, status, menuBtns, keys);
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
async function playSolo(d: Difficulty, choice: MapChoice, menu: HTMLElement, bots = 1, settings: GameSettings = loadPrefs().settings) {
  const map = resolveMapChoice(choice, lastBotMap);
  lastBotMap = map;
  const urlBots = DEBUG ? Number(new URLSearchParams(location.search).get('bots')) : 0;
  const backend = workerBackend(() => ({
    // ?debug=1&bots=N (1-7) overrides the menu's bot count (perf testing)
    setup: { players: [{ name: 'You', isBot: false }, ...Array.from({ length: Math.min(7, Math.max(1, urlBots || bots)) },
      (_, i) => ({ name: `Bot (${d})${i ? ` ${i + 1}` : ''}`, isBot: true, difficulty: d }))], map, settings: sanitizeSettings(settings) },
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
        playSolo(d, choice, loadingScreen('Starting a new match…'), bots, settings).catch((err) => {
          console.error('[main] play again failed', err);
          toast(`Could not restart: ${err?.message ?? err}`);
        });
      },
    },
  });
}

/** Practice range: you alone on the range layout (sim/practice.ts); no timer, no result, Esc → Quit to menu. */
async function playPractice(menu: HTMLElement) {
  const backend = workerBackend(() => ({ setup: { players: [{ name: 'You', isBot: false }], practice: true }, humanId: 1 }), null);
  await startGame(backend, menu, undefined, {
    hostId: null,
    practice: true,
    money: () => 'Practice: cash is already unlimited',
    role: { kind: 'solo', playAgain: () => location.reload() },
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
    lobby: (slots, map, settings) => ui?.render(slots, 0, map, settings),
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
    setColor: (c) => { session.setColor(0, c); savePrefs({ color: c }); },
    setSettings: (st) => { session.setSettings(st); savePrefs({ settings: session.settings }); },
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
  // The host's last game settings and colour.
  { const p = loadPrefs(); session.setSettings(p.settings); if (p.color !== null) session.setColor(0, p.color); }
  addInviteButton(ui.root, session.code);
  console.info(`[host] room ${session.code} open`);
}

async function joinLobby(firstCode: string, name: string, menu: HTMLElement, rejoin?: string) {
  let code = firstCode;
  const joined = await joinRoom(pickTransport(location.search), code, name, rejoin).catch((err) => {
    clearRejoin(); // the seat is gone (grace over / match ended / host left): no more offers
    throw err;
  });
  let link: Link = joined.link;
  const lobby = joined.lobby;
  menu.remove();
  const ui = new LobbyUi(app, code, null, () => { clearRejoin(); link.close(); location.reload(); }, (text) => {
    const c = parseCommand(text);
    if (!c) link.send({ t: 'chat', text });
    else ui.addChat('', c.kind === 'spectate' ? HOST_ONLY : c.kind === 'money' ? MONEY_HOST_ONLY : c.kind === 'help' ? HELP_TEXT : unknownCommand(c.name));
  }, {
    setReady: (ready) => link.send({ t: 'ready', ready }),
    setColor: (color) => { link.send({ t: 'color', color }); savePrefs({ color }); },
  });
  ui.render(lobby.slots, lobby.you, lobby.map, sanitizeSettings(lobby.settings));
  // Ask for the colour this player picked last time (the host refuses it if someone else has it).
  { const c = loadPrefs().color; if (c !== null) link.send({ t: 'color', color: c }); }
  addInviteButton(ui.root, code);
  let slots = lobby.slots;
  /** Our seat (host migration: the plan names the backup by seat). */
  let you = lobby.you;
  let phase: 'lobby' | 'starting' | 'game' | 'over' = 'lobby';
  let early: HostMsg[] = [];
  let game: Game | null = null;
  const launch = (m: Extract<HostMsg, { t: 'start' }>, screen: HTMLElement) => {
    phase = 'starting';
    early = [];
    const backend = remoteBackend(link, m, early, {
      gm: new GuestMigration(you),
      name,
      code: () => code,
      relink: (l, c) => { link = l; code = c; l.onMessage(onHostMsg); },
      promoted: () => { phase = 'over'; clearRejoin(); link.close(); },
    });
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
  const onHostMsg = (raw: unknown) => {
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
      else if (m.t === 'lobby') { game?.destroy(); game = null; phase = 'lobby'; slots = m.slots; you = m.you; app.append(ui.root); ui.render(m.slots, m.you, m.map, sanitizeSettings(m.settings)); }
      return;
    }
    if (m.t === 'lobby') { slots = m.slots; you = m.you; ui.render(m.slots, m.you, m.map, sanitizeSettings(m.settings)); }
    else if (m.t === 'chat') ui.addChat(m.from, m.text);
    else if (m.t === 'ended') { phase = 'over'; ui.error(m.reason === 'host-left' ? 'The host closed the lobby.' : `Removed from lobby (${m.reason}).`); }
    else if (m.t === 'start') { ui.loading(m.map.name); launch(m, ui.root); }
  };
  link.onMessage(onHostMsg);
}

// ---------------------------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------------------------

/** A running game; destroy() removes every trace of it (rematch / back to lobby). */
type Game = { destroy(): void };
/** spectate / money: what /spectate and /money do here (host / vs bot); absent for a joined friend. */
type EndCtx = { role: EndRole; hostId: number | null; spectate?: () => SpectateResult; money?: (amount: number) => string; exitReplay?: () => void; practice?: boolean };

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
  // lods/pbrStats come through the lazy render module: a static import would pull three.js onto the phone card.
  const { Renderer, lods, pbrStats } = mods.render, { ThirdPersonCamera } = mods.camera, { FirstPersonView } = mods.viewmodel;
  const { DamageFx } = mods.damageFx, { Hud } = mods.hud, { Spectator } = mods.spectator;
  const offCharProgress = mods.characters.onCharacterProgress((f) => loading.progress('characters', f, 'Downloading characters'));

  const scope = new GameScope([app, document.body]);
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  canvas.tabIndex = 0;
  app.prepend(canvas);
  loading.progress('gpu', 0, 'Starting WebGPU');
  const renderer = await Renderer.create(canvas);
  const prevLost = renderer.gpu.onDeviceLost.bind(renderer.gpu);
  renderer.gpu.onDeviceLost = (info) => { errors?.report('gpu', `device lost: ${info.message} (${info.reason ?? 'unknown'})`); prevLost(info); };
  renderer.world.onCritterSound = (s) => audio.critter(s);
  loading.progress('gpu', 1, 'Starting the simulation');
  loading.progress('map', 0); // running until the map arrives (the bar creeps meanwhile)
  loading.progress('map', 0); // running until the map arrives (the bar creeps meanwhile)
  console.info(`[render] backend: ${renderer.backend}`);
  scope.begin(); // window/document listeners from here on are removed by destroy()
  let running = true;
  /** Free-fly chosen from the end screen (otherwise spectating = being dead). */
  let spectateChosen = false;
  /**
   * Frame-time governor (Settings → Video "dynamic resolution"): over budget it drops GTAO, shadow resolution,
   * grass density and LOD distance first, render resolution last; restores them with headroom.
   */
  const governor = new FrameGovernor();
  const sky = renderer.world.sky;
  const govSkip = () => governor.setSkip((s) => s === 'ao' && !sky.presetHasAo);
  govSkip();
  governor.enabled = settings.get().video.dynamicResolution;
  const applyGovernor = () => {
    const k = governor.knobs;
    sky.setGovernor(k);
    renderer.world.grass.densityScale = k.grass;
    lods.bias = k.lodBias;
    sky.setDynamicScale(k.res);
  };
  let govQuality = sky.quality;
  const offSettings = settings.subscribe((st) => {
    sky.setQuality(st.video.quality);
    sky.setResolutionScale(st.video.resolutionScale);
    sky.setCompetitive(st.video.competitive);
    governor.enabled = st.video.dynamicResolution;
    perfDetail = st.video.perfDetail || DEBUG;
    if (sky.quality !== govQuality) { govQuality = sky.quality; governor.reset(); govSkip(); }
    applyGovernor();
  });
  /** Shift + the FPS key (F3 / `): perf detail under the FPS counter (Settings → Video → Performance stats). */
  let perfDetail = settings.get().video.perfDetail || DEBUG, detailShown = false;

  // ---- reveal: map + avatars + first snapshot → shader warm-up → a few hidden frames → fade in ----
  let charsReady = false, warmStarted = false, warmed = false, revealed = false, framesAfterWarm = 0;
  renderer.characters.ready.then(() => {
    charsReady = true;
    offCharProgress();
    loading.progress('characters', 1);
    maybeWarm();
  });
  const revealTimer = setTimeout(() => { console.warn('[loading] warm-up took too long; showing the game anyway'); reveal(); }, REVEAL_TIMEOUT_MS);
  /** Frame-loop hooks for the warm-up (warmup.ts): pause drawing, count drawn frames, run a hook before each. */
  const warmLoop = { paused: false, left: 0, before: null as (() => void) | null, done: null as (() => void) | null };
  function maybeWarm() {
    if (warmStarted || !snap || !map.length || !charsReady) return;
    warmStarted = true;
    // One normal frame first so the camera already sits behind the player.
    requestAnimationFrame(() => {
      const loop = {
        setPaused: (on: boolean) => { warmLoop.paused = on; },
        frames: (n: number, before?: () => void) => new Promise<void>((done) => {
          warmLoop.before = before ?? null; warmLoop.left = n; warmLoop.done = done;
        }),
      };
      mods.warmup.warmUp(renderer, loop, fpv, (f, label) => loading.progress('shaders', f, label))
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
  /** Own placements shown at once and reconciled with the host's pieces (buildPredict.ts); also paces placing. */
  const builds = new BuildPredictor();
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
    // Same click / key press that closed the panel re-captures the mouse: no extra click needed.
    if (input.enabled) input.requestLock();
  };

  /** Back to the menu (a page reload) once this match's recording is stored. */
  function leaveToMenu() {
    backend.close();
    void savesSettled().then(() => location.reload());
  }

  const fxPos = new THREE.Vector3();
  const damageFx = new DamageFx(app);
  const sealAnnouncer = new SealAnnouncer(app, (k) => {
    canvas.style.setProperty('--shake', `${Math.round(6 + 10 * k)}px`);
    canvas.classList.remove('shake');
    void canvas.offsetWidth;
    canvas.classList.add('shake');
  });
  /** Leaving on purpose: no reconnect offer afterwards. */
  const leave = () => { clearRejoin(); leaveToMenu(); };
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
    // Same as the drop key: select that slot and drop from it in the same input (the sim selects first).
    dropSlot: (slot, amount) => { input.select(slot); input.queue({ drop: amount }); },
  });
  if (end.practice) hud.setPractice();
  const online = backend.buffered || !!onChat;
  const qol = new QolHud(hud.root, { quickBuy: (item) => buyItem(item), play: (cue) => audio.alert(cue) }, { online, isHost: !!onChat });
  qol.lastBuy = loadPrefs().lastBuy;
  let rejoinTouchedAt = 0;
  // Killcam: replays your death from the killer's view during the respawn wait (Space skips).
  const killcam = new Killcam(hud.root);
  let killcamCam: InstanceType<typeof ThirdPersonCamera> | null = null;
  let killcamWas = false;
  /** Whose death the killcam is showing (you, or the player you follow). */
  let killcamFor: number | null = null;
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
      if (!locked) closeWheel(); // Esc while the wheel is open lands here (the browser takes Esc first)
      if (locked) {
        wasLocked = true; hidePause(); hint.style.display = 'none';
        if (input.inventory) input.setInventory(false);
        return;
      }
      if (replay) return; // Esc just frees the mouse for the playback bar
      if (spectateChosen && !chat.open && !dead) {
        // Esc while spectating from the end screen: back to it (it's the pause menu here).
        spectateChosen = false;
        input.enabled = false;
        hud.setEndVisible(true);
        return;
      }
      if (wasLocked && !input.inventory && !hud.panelOpen && !hud.ended && !paused && !chat.open && !dead && !practice?.open) showPause();
    },
    inventoryChange: (open) => {
      hint.textContent = open ? `Drag hotbar items to reorder · ${bindingLabel(activeKeymap(), 'inventory')} to resume` : 'Click to resume';
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

  // ---- emote & quick-chat wheel: hold the key, point, release to send (Esc / losing the mouse cancels) ----
  const wheel = new EmoteWheel(app);
  const closeWheel = () => { wheel.cancel(); input.lookLocked = false; };
  const sendWheel = (id: WheelId) => {
    if (!isWheelId(id)) throw new Error(`[wheel] unknown id ${String(id)}`);
    console.info(`[wheel] ${id}`);
    if (!backend.wheel) { console.info('[wheel] not available here (replay)'); return; }
    backend.wheel(id);
  };
  window.addEventListener('keydown', (e) => {
    if (wheel.open && e.code === 'Escape') { e.preventDefault(); closeWheel(); return; }
    if (e.repeat || !isAction('emote', e.code) || e.target instanceof HTMLInputElement) return;
    if (!input.enabled || chat.open || hud.panelOpen || watching || !humanId) return;
    e.preventDefault();
    wheel.show();
    input.lookLocked = true;
  });
  window.addEventListener('keyup', (e) => {
    if (!wheel.open || !isAction('emote', e.code)) return;
    input.lookLocked = false;
    const id = wheel.release();
    if (id) sendWheel(id);
  });
  window.addEventListener('mousemove', (e) => {
    if (!wheel.open) return;
    if (input.locked) wheel.move(e.movementX, e.movementY); else wheel.pointAt(e.clientX, e.clientY);
  });
  window.addEventListener('blur', closeWheel);

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
    const t = e.target as HTMLElement | null;
    if (e.repeat || !isAction('fps', e.code) || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
    e.preventDefault();
    if (e.shiftKey) settings.update((d) => { d.video.perfDetail = !d.video.perfDetail; if (d.video.perfDetail) d.video.showFps = true; });
    else settings.update((d) => { d.video.showFps = !d.video.showFps; });
  });

  const spectator = new Spectator(app, renderer.camera, () => renderer.collidables, canvas, () => input.enabled);
  const bodyCam = new BodyCam();
  /** Our own seat, kept after /spectate hands it to a bot (humanId → 0): "you" in bot-brain text. */
  let selfId = 0;
  // Spectating a bot: B opens its brain inspector, Shift+B its in-world overlay (route, aim, target, ghosts, build).
  const brainX = new mods.hud.BrainInspector(app);
  const brainFx = new mods.render.BrainOverlay(renderer.scene);
  const brainTmp = new THREE.Vector3(), brainFeet = new THREE.Vector3();
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (e.repeat || !isAction('brain', e.code) || hud.panelOpen || spectator.following === null ||
      (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
    e.preventDefault();
    if (e.shiftKey) brainX.toggleOverlay(); else brainX.toggle();
  });
  // Replay viewer: always the spectator camera, playback bar at the bottom, interpolation on the playback clock.
  const replay = backend.replay ?? null;
  let replayUi: ReplayControls | null = null;
  if (replay) {
    app.classList.add('replay-mode'); // hides the first-person HUD (hotbar, health…): nobody is "you" here
    renderer.clockNow = replay.clock;
    spectateChosen = true;
    replay.info.then((info) => {
      if (!running) return;
      replayUi = new ReplayControls(app, {
        length: info.length,
        kills: info.kills,
        players: info.header.players,
        play: () => replay.play(),
        pause: () => replay.pause(),
        speed: (x) => replay.setSpeed(x),
        seek: (t) => replay.seek(t),
        follow: (id) => {
          if (id === null) { spectator.mode = 'free'; spectator.pos.copy(renderer.camera.position); }
          else { spectator.mode = 'follow'; spectator.followId = id; }
          canvas.focus();
        },
        exit: () => end.exitReplay?.(),
      });
      replay.onState = (st) => replayUi?.setState(st);
      if (replay.last) replayUi.setState(replay.last);
    }, () => {});
  }
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
  hint.textContent = 'Click to resume';
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
    paused.className = 'overlay pause-overlay';
    paused.dataset.testid = 'pause';
    const card = document.createElement('div');
    card.className = 'card glass pause-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Paused');
    const head = document.createElement('div');
    head.className = 'pause-head';
    // The kicker says whether the world stopped; no separate note repeating "paused".
    head.innerHTML = `<div class="pause-kicker${backend.pause ? '' : ' live'}"></div><div class="pause-title">Paused</div>`;
    head.firstElementChild!.textContent = backend.pause ? 'Match paused · vs bots' : 'Online · the match keeps running';
    // Compact match info: time left, map, and your own numbers.
    const me = snap?.players.find((p) => p.id === humanId);
    const info = document.createElement('div');
    info.className = 'pause-info';
    info.dataset.testid = 'pause-info';
    const stat = (k: string, v: string) => { const d = document.createElement('div'); d.className = 'pause-stat'; d.innerHTML = '<span class="k"></span><span class="v"></span>'; d.children[0].textContent = k; d.children[1].textContent = v; return d; };
    info.append(
      stat('Time', document.querySelector('.hud .timer')?.textContent || '–'),
      stat('Map', mapDef?.name ?? '–'),
      stat('K / D', me ? `${me.kills} / ${me.deaths}` : '–'),
      stat('Cash', me ? `$${me.inv.cash}` : '–'),
    );
    const resume = pauseButton(PAUSE_ICONS.play, 'Resume', 'btn primary');
    resume.onclick = () => { input.enabled = true; input.requestLock(); hidePause(); };
    resume.dataset.testid = 'resume';
    // Settings / How to play open in place of the card (same backdrop), and the card comes back on close.
    const under = (open: (onClose: () => void) => void) => () => {
      paused?.classList.add('under');
      open(() => paused?.classList.remove('under'));
    };
    const set = settingsButton();
    set.className = 'btn pause-btn';
    set.onclick = under((onClose) => openSettings({ onClose }));
    const how = pauseButton(PAUSE_ICONS.help, 'How to play', 'btn');
    how.dataset.testid = 'pause-how-to';
    how.onclick = under((onClose) => openHowTo(onClose));
    const quit = pauseButton(PAUSE_ICONS.exit, online ? 'Leave match' : 'Quit to menu', 'btn danger');
    quit.dataset.testid = 'pause-quit';
    quit.onclick = leave;
    const btns = document.createElement('div');
    btns.className = 'pause-btns';
    btns.append(resume, set, how, quit);
    card.append(head, info, btns);
    paused.append(card);
    document.body.append(paused);
    resume.focus({ preventScroll: true });
  }

  // ---- practice range panel (practicePanel.ts): O opens the controls, O / Esc / Resume closes them ----
  const practice = end.practice ? new PracticePanel(app, {
    send: (cmd) => {
      if (!backend.practice) throw new Error('practice panel: backend has no practice channel');
      backend.practice(cmd);
    },
    faceRange: () => { input.yaw = 0; input.pitch = 0; },
    closed: () => closePractice(),
  }) : null;
  function openPractice() {
    practice!.setOpen(true);
    input.enabled = false;
    chat.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closePractice() {
    practice!.setOpen(false);
    input.enabled = !hud.ended && !dead;
    chat.enabled = !hud.ended && !dead;
    canvas.focus();
    input.requestLock();
  }
  if (practice) window.addEventListener('keydown', (e) => {
    if (e.repeat || e.target instanceof HTMLInputElement) return;
    if (practice.open && (e.code === 'Escape' || e.code === 'KeyO')) { e.preventDefault(); e.stopPropagation(); closePractice(); return; }
    // O, unless the player bound it to a game action.
    if (e.code === 'KeyO' && !ACTIONS.some((a) => isAction(a.id, 'KeyO')) && !hud.panelOpen && !paused && !chat.open && !dead && !input.inventory) {
      e.preventDefault();
      openPractice();
    }
  }, { capture: true });

  function showFatal(titleText: string, detail: string) {
    if (dead) return;
    if (titleText === 'Simulation crashed') errors?.report('fatal', `${titleText}: ${detail}`);
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

  /** Pieces of this kind we can still place: the newest host count minus our predictions it doesn't show yet. */
  const piecesLeft = (me: Snapshot['players'][number], kind: PieceKind) =>
    (me.inv.pieces[kind] ?? 0) - builds.unconfirmed(latest?.pieces ?? [], kind);

  /**
   * Place from the current ghost if it's valid, we have the piece and the last placement's placeSec has passed
   * (paced locally; the host enforces the same rate). The piece shows at once as a prediction.
   */
  function tryPlace(): boolean {
    const now = performance.now();
    if (!aim?.ok || !aim.req || !builds.canPlace(now) || !latest) return false;
    const me = latest.players.find((p) => p.id === humanId);
    if (!me || !me.alive || piecesLeft(me, aim.req.kind) <= 0) return false;
    if (me.healAt !== null || me.drinking) return false; // busy with a medkit/potion: the host would refuse it
    input.queue({ build: aim.req });
    const afterId = latest.pieces.reduce((m, p) => Math.max(m, p.id), 0);
    const piece = builds.place(aim.req.kind, aim.ghost, aim.rotY, humanId, now, afterId);
    predictor?.addLocalPiece(piece);
    renderer.setPredictedPieces(builds.pieces);
    placeWantedAt = -Infinity;
    renderer.pulseGhost();
    return true;
  }

  /** Host pieces about to be drawn: confirmed predictions give way to the real piece, refused ones fade. */
  const reconcileBuilds = (pieces: readonly PieceState[]) => {
    const r = builds.reconcile(pieces, performance.now());
    if (!r.confirmed.length && !r.rejected.length) return;
    for (const p of [...r.confirmed, ...r.rejected]) predictor?.removeLocalPiece(p.id);
    renderer.setPredictedPieces(builds.pieces);
  };

  /** Crosshair gap from the spread cone, reload ring progress, rifle scope. */
  const gunHud = (me: Snapshot['players'][number] | undefined, own = true) => {
    if (!me?.alive || me.equipped === 'fists') return { spreadPx: 4, reload: null, scoped: false };
    const now = simNow();
    const ads = own ? fpv.adsK > 0.5 : me.ads;
    const deg = spreadDeg(me.equipped, { ads, bloom: me.bloom, lastShotAt: me.lastShotAt }, now,
      { speed: Math.hypot(me.vel.x, me.vel.z), grounded: Math.abs(me.vel.y) < 0.5 });
    const cam = renderer.camera;
    const px = (Math.tan((deg * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (canvas.clientHeight / 2);
    const c = reloadClock(me, now);
    return { spreadPx: px, reload: c ? c.elapsed / c.duration : null, scoped: me.equipped === 'rifle' && (own ? fpv.adsK > 0.9 : me.ads && spectator.firstPerson) };
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
    reconcileBuilds(s.pieces); // before pushSnapshot: a confirmed prediction hands over to the real piece in the same draw
    hud.pushEvents(renderer.pushSnapshot(s));
    // The player whose view we show: the followed one while spectating, else us (viewed.ts).
    const viewer = viewedPlayer(humanId, spectator.following);
    hud.setViewed(viewer);
    audio.setViewed(viewer);
    qol.setViewed(viewer, s.players.find((p) => p.id === viewer)?.island ?? -1);
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
    damageFx.onSnapshot(s, viewer);
    practice?.onSnapshot(s, humanId);
    sealAnnouncer.onSnapshot(s, viewer);
    const meNow = s.players.find((p) => p.id === humanId);
    input.held = meNow?.hotbar[input.selected] ?? null;
    const wasEnded = hud.ended;
    // Spectating someone: the HUD shows their view (hotbar, ammo, cash, hp/shield/stamina, crosshair).
    const viewId = spectator.following;
    const viewed = viewId !== null ? s.players.find((p) => p.id === viewId) : undefined;
    hud.update(s, { selected: input.selected, ghostOk: input.buildMode ? ghostState() : null, buildNote: input.buildMode ? buildNote() : null, free: input.free, inventory: input.inventory,
      stamina: predictor?.stamina ?? null, viewId, ...(viewed ? gunHud(viewed, false) : gunHud(meNow)) });
    brainX.setFollow(viewed?.isBot ? viewId : null, s.players, selfId);
    if (hud.ended && !wasEnded && !replay) spectateChosen = false; // a (new) result popped the end screen up
    scoreboard.update(s, scoreOpts());
    const recap = qol.onSnapshot(s, viewed ? viewed.selected : input.selected);
    // One killcam, for your own death or for the player you follow while spectating (the recap above
    // follows the viewed player too): the killer-view replay when enough of the killer is on record,
    // else (no killer, too little data, replay viewer) the body cam holds on the victim.
    if (killcam.active && killcamFor !== null) {
      const v = s.players.find((p) => p.id === killcamFor);
      if (v?.alive || s.winner !== null) killcam.stop(v?.alive ? 'respawned' : 'match over');
    }
    const died = s.events.find((e) => e.type === 'kill' && e.data.victim === viewer);
    if (died && s.winner === null) {
      const victim = s.players.find((p) => p.id === viewer);
      const killer = typeof died.data.killer === 'number' && died.data.killer !== viewer ? died.data.killer : null;
      const respawnIn = victim && victim.respawnAt !== null && !victim.eliminated ? victim.respawnAt - s.time : null;
      const k = recap?.killer;
      const started = !backend.replay && killcam.start(died.t, killer, respawnIn,
        k ? { killerName: k.name, island: k.island, weapon: recap.weapon, distance: recap.distance, headshot: recap.headshot } : null);
      if (started) {
        killcamFor = viewer;
        if (viewer === humanId) hud.setEndVisible(false); // eliminated: the end screen waits for the killcam
      } else if (viewer !== humanId) bodyCam.onEvents(s.events, spectator.following, performance.now() / 1000);
    }
    if (backend.buffered) {
      // Guest: keep the rejoin record fresh while the match runs; a finished match has nothing to rejoin.
      if (s.winner !== null) clearRejoin();
      else if (performance.now() - rejoinTouchedAt > 2000) { rejoinTouchedAt = performance.now(); touchRejoin(); }
    }
    chat.enabled = !replay && !hud.ended && !dead && !hud.panelOpen;
    if (replay) { if (hud.ended) hud.setEndVisible(false); } // the result shows in the kill feed; keep watching
    else if (hud.ended && input.enabled) { input.enabled = false; if (document.pointerLockElement) document.exitPointerLock(); }
  };

  backend.connect({
    map: (def, id, island) => {
      mapDef = def;
      map = def.islands;
      humanId = id;
      if (id) selfId = id;
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
      hud.suddenDeathAt = def.settings?.suddenDeathSec ?? LIFECYCLE.suddenDeathAt;
      hud.genMult = def.settings?.genMult ?? 1;
      if (practice && map[island]) practice.setBunker(map[island].bunker);
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
      renderer.ingest(s);
      if (buffer) buffer.push(s); else applySnapshot(s);
    },
    // Ghost validation is local now (buildAim); the sim's preview only answers debug cross-checks.
    preview: (result, key) => { debugPreviews.get(key)?.(result); debugPreviews.delete(key); },
    chat: (from, text) => chat.add(from, text),
    fatal: showFatal,
    brain: (d) => brainX.setDigest(d),
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
    reset: () => renderer.resetInterp(),
  });

  if (DEBUG) {
    (window as unknown as { __faefight: unknown }).__faefight = {
      ...(backend.debug ?? {}),
      snapshot: () => snap,
      map: () => map,
      mapDef: () => mapDef,
      humanId: () => humanId,
      renderInfo: () => renderer.info(),
      /** Wildlife: drawn instances per species / swarm, and live agents (incl. hidden + off-screen) per species. */
      critters: () => {
        const c = renderer.world.critters;
        if (!c) return null;
        const live: Record<string, number> = {};
        for (const a of c.sim.agents) live[a.def.name] = (live[a.def.name] ?? 0) + 1;
        return { drawn: c.stats(), live };
      },
      renderer,
      chatLines: () => [...document.querySelectorAll('.chat-line')].map((n) => n.textContent),
      /** Emote wheel: open state and hovered slot; `wheel(id)` sends a pick directly. */
      wheelState: () => ({ open: wheel.open, hovered: wheel.hovered }),
      wheel: (id: WheelId) => sendWheel(id),
      input,
      cameraMode: () => fpv.mode,
      cameraFov: () => renderer.camera.fov,
      adsK: () => fpv.adsK,
      brain: () => ({ open: brainX.isOpen, overlay: brainFx.group.visible, digest: brainX.current }),
      /** The build ghost as drawn (own, or a spectated human's). */
      ghost: () => {
        const g = (renderer as unknown as { ghost: Object3D | null }).ghost;
        return g?.visible ? { x: g.position.x, y: g.position.y, z: g.position.z } : null;
      },
      /** E2E: open the shop panel wherever we stand (its buttons may still refuse away from the shop). */
      openShop: () => { hud.openShop(); if (document.pointerLockElement) document.exitPointerLock(); },
      spectator: () => ({
        ...spectator.info(),
        camera: { x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z },
        // Own avatar shown? (hiddenId hides it; a dead avatar is hidden after its death pose.)
        selfVisible: renderer.characters.hiddenId !== humanId &&
          !!(renderer.characters as unknown as { avatars: Map<number, { group: Object3D }> }).avatars.get(humanId)?.group.visible,
      }),
      /** Free-fly camera position while spectating (offline map thumbnails: tests/visual/mapThumbs.mjs). */
      spectateAt: (x: number, y: number, z: number) => { spectator.pos.set(x, y, z); },
      scoreboard: () => scoreboard.visible,
      /** Loot on the ground as drawn: label lines, label shown, model count. */
      loot: () => renderer.lootView.info(),
      audio: () => audio.stats(),
      killcam: () => killcam.info(),
      audioPlay: (cue: Parameters<AudioSystem['debugPlay']>[0]) => audio.debugPlay(cue),
      settings: () => settings.get(),
      /** Local player's rendered (predicted) feet this frame, and prediction stats. */
      predicted: () => ({ active: !!predictor?.active, pos: lastRendered, seq: moveSeq, stats: predictor?.stats ?? null, pending: predictor?.pending ?? 0 }),
      frames: () => frameStats(),
      resetFrames: () => { frameMs.length = 0; workMs.length = 0; renderer.gpuMs.length = 0; },
      gpuMs: () => renderer.gpuStats(),
      renderScale: () => ({ dyn: governor.knobs.res, pixelRatio: renderer.world.sky.pixelRatio, smoothedMs: governor.smoothedMs }),
      pbr: () => pbrStats,
      /** Input→render latency probe: synthetic look events (no pointer lock needed), then stats. */
      latency: () => latency.stats(),
      resetLatency: () => { latency.cpu.length = 0; latency.gpu.length = 0; },
      lookProbe: (on: boolean) => { input.debugLocked = on; },
      governor: () => ({ level: governor.level, knobs: governor.knobs, enabled: governor.enabled, lodTargets: lods.count, lodScale: lods.scale }),
      interpDelay: () => renderer.interpDelay,
      shotPredict: () => ({ ...shots.stats, inFlight: shots.inFlight, times: shotTimes }),
      /** Replay viewer: playback state (tick, playing, speed, divergedAt), or null in a live game. */
      replayState: () => (replay ? replay.last : null),
      /** Current build ghost: snap tag, ghost/rest position, rotation, validity (+ reason) and the exact request a click sends. */
      buildAim: () => aim,
      /** Build prediction: unconfirmed pieces and placed/confirmed/rejected counts. */
      buildPredict: () => ({ pending: builds.pieces, ...builds.stats }),
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
    const head = to.y >= victimFeet.y + HEAD.y - HEAD.r;
    shots.markHit();
    hud.hitmarker(head);
    audio.predicted('hitmarker');
    if (head) audio.predicted('headshot');
    renderer.gunFx.onEvent({ t: ev.t, type: 'hit', data: { target: victim, by: humanId, pos: { x: to.x, y: to.y, z: to.z }, part: head ? 'head' : 'body', weapon: w, ...predictedHit(w, hit!.distance, head) } }, humanId);
  };

  // ---- frame loop ----
  const feet = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  const specMotion = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
  const viewMotion = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
  let lastFollow: number | null = null;
  const specCam = new SpectatorCamera();
  let lastViewSig = '', nextViewAt = 0;
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
  /**
   * Input → render latency (mouse look): from the oldest undrawn look event to (a) the frame's draw submission
   * (CPU) and (b) the GPU finishing that frame (queue.onSubmittedWorkDone). Display scan-out comes on top.
   */
  const latency = {
    cpu: [] as number[], gpu: [] as number[],
    drawn(t0: number) {
      const cpu = performance.now() - t0;
      this.cpu.push(cpu); if (this.cpu.length > 300) this.cpu.shift();
      const dev = (renderer.gpu.backend as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
      dev?.queue.onSubmittedWorkDone().then(() => { this.gpu.push(performance.now() - t0); if (this.gpu.length > 300) this.gpu.shift(); }, () => {});
    },
    stats() {
      const q = (xs: number[], k: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * k))] ?? 0; };
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      return { n: this.cpu.length, cpuAvg: avg(this.cpu), cpuP95: q(this.cpu, 0.95), gpuAvg: avg(this.gpu), gpuP95: q(this.gpu, 0.95) };
    },
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
    if (revealed) {
      // main-thread work of the previous frame tells the governor whether frames are GPU- or CPU-bound
      if (governor.frame(now - last, 1000 / (cap || 60), workMs[workMs.length - 1] ?? now - last)) applyGovernor();
    }
    frameMs.push(now - last);
    errors?.frame(now - last);
    if (frameMs.length > 600) frameMs.shift();
    last = now;
    fpsFrames++;
    if (now - fpsSince >= 500) {
      hud.setFps((fpsFrames * 1000) / (now - fpsSince));
      if (!perfDetail && detailShown) { hud.setFpsDetail(null); detailShown = false; }
      if (perfDetail) {
        detailShown = true;
        const ri = renderer.info(), g = renderer.gpuMs.length ? renderer.gpuMs[renderer.gpuMs.length - 1] : null;
        hud.setFpsDetail([
          `${((now - fpsSince) / fpsFrames).toFixed(1)} ms${g !== null ? ` · gpu ${g.toFixed(1)} ms` : ''}`,
          `${ri.drawCalls} draws · ${(ri.triangles / 1e6).toFixed(2)}M tris`,
          `gov ${governor.level}${governor.gpuBound ? ' gpu' : ' cpu'} · res ${sky.pixelRatio.toFixed(2)} · lod ×${lods.scale.toFixed(2)}`,
        ]);
      }
      fpsFrames = 0; fpsSince = now;
    }
    if (buffer) for (const r of buffer.advance(dt)) applySnapshot(r.snap);
    if (snap) reconcileBuilds(snap.pieces); // refusals time out between snapshots too
    renderer.setPieceFades(builds.fades(now));
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
    hint.style.display = snap && !input.locked && !hud.panelOpen && !paused && !hud.ended && !chat.open && !dead && !practice?.open ? '' : 'none';

    const me = snap?.players.find((p) => p.id === humanId);
    if (wheel.open && (!input.enabled || chat.open)) closeWheel();
    // No player of our own (spectating host / handed to a bot), dead (respawning or eliminated), or free
    // fly picked on the end screen: invisible spectator camera.
    const spectating = replay ? !!snap : !!snap && (watching || (!!me && (!me.alive || spectateChosen)));
    const kc = killcam.active ? killcam.frame(now) : null;
    if (!kc && killcamWas) {
      // Killcam over: back to the live world; the normal death flow (free-fly, end screen) carries on.
      renderer.setReplay(null);
      if (!spectateChosen) hud.setEndVisible(true);
    }
    killcamWas = !!kc;
    if (kc) {
      // (A spectator keeps following: the free-fly / follow camera just waits for the replay.)
      renderer.setReplay({ snap: kc.snap, motion: kc.motion });
      renderer.replayEvents(kc.events);
      renderer.characters.hiddenId = -1;
      renderer.setGhost(null);
      aim = null;
      killcamCam ??= new ThirdPersonCamera(renderer.camera, () => renderer.collidables);
      killcamCam.update(feet.set(kc.feet.x, kc.feet.y, kc.feet.z), kc.yaw, kc.pitch, dt);
    } else if (spectating) {
      spectator.enter(renderer.camera.position);
      renderer.characters.hiddenId = replay ? -1 : humanId; // a replay shows everyone
      renderer.setGhost(null);
      aim = null;
      // Their camera mode (bots: over the shoulder), V flips it; their death plays as a short killcam.
      const fid = spectator.mode === 'follow' ? spectator.followId : null;
      const fp = specCam.firstPerson(fid, fid !== null ? snap!.players.find((p) => p.id === fid)?.view : undefined, fpv.mode);
      const kc = bodyCam.active(fid, now / 1000) ? { victim: bodyCam.victim!, killer: bodyCam.killer } : null;
      spectator.frame({ cam: renderer.camera, yaw: input.yaw, pitch: input.pitch, dt, humanId: replay ? 0 : humanId, players: snap!.players,
        posOf: (id, out) => renderer.playerPos(id, out),
        lookOf: (id) => renderer.playerMotion(id, specMotion), firstPerson: fp, killcam: kc });
      // A human's build ghost and open shop / vault, as they see them.
      const fv = spectator.following !== null && !snap!.players.find((p) => p.id === spectator.following)?.isBot ? backend.viewOf?.(spectator.following) ?? null : null;
      const g = kc ? null : fv?.ghost ?? null;
      if (g) renderer.setGhost(g.kind, { x: g.x, y: g.y, z: g.z }, g.rotY, g.ok);
      hud.setMirror(kc || !fv ? null : { panel: fv.panel, hover: fv.hover });
      // From their eyes: hide their avatar (as your own is hidden in first person).
      renderer.characters.hiddenId = spectator.firstPerson && spectator.following !== null ? spectator.following : humanId;
      replayUi?.setFollow(spectator.following);
    } else { spectator.exit(); hud.setMirror(null); }
    // Online: tell the host who we watch, so it can send that player's HUD state (only while we're dead).
    const following = spectator.following;
    if (following !== lastFollow) { lastFollow = following; backend.follow?.(following); }
    const bd = brainX.overlayOn ? brainX.current : null;
    brainFx.update(bd, bd ? renderer.playerPos(bd.id, brainFeet) : null, (id) => renderer.playerPos(id, brainTmp), now / 1000);
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
          // predicted pieces too: a held place keeps building along the aim instead of re-aiming at the same spot
          humanId, pieces: (latest ?? snap!).pieces.concat(builds.pieces), islands: map, myIsland: me.island,
        });
        const meLatest = latest?.players.find((p) => p.id === humanId) ?? me;
        if (piecesLeft(meLatest, buildKind) <= 0) { aim.ok = false; aim.reason = 'none left'; aim.req = null; }
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

    // What I see beyond the snapshot (ghost, open panel), for anyone spectating me: on change, at most 4 Hz.
    if (backend.sendView && now >= nextViewAt) {
      const vs = hud.viewState();
      const gk = !spectating && aim && input.buildMode ? (me?.hotbar[input.selected] ?? null) : null;
      const v: ViewExtras = {
        ghost: aim && gk && aim.ghost ? { kind: gk as PieceKind, x: Math.round(aim.ghost.x * 100) / 100, y: Math.round(aim.ghost.y * 100) / 100, z: Math.round(aim.ghost.z * 100) / 100, rotY: Math.round(aim.rotY * 1000) / 1000, ok: aim.ok } : null,
        panel: vs.panel, hover: vs.hover,
      };
      const sig = JSON.stringify(v);
      if (sig !== lastViewSig) { lastViewSig = sig; nextViewAt = now + 250; backend.sendView(v); }
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
    // Camera mode rides along (cosmetic): spectators watching us see through the same camera.
    sample.view = fpv.mode === 'first' ? 1 : 0;
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
    // Following someone: compass and hit arcs from their position and facing.
    const vId = spectator.following;
    const vMotion = vId !== null ? renderer.playerMotion(vId, viewMotion) : null;
    if (vMotion) {
      qol.frame(vMotion.yaw, { x: vMotion.pos.x, z: vMotion.pos.z }, snap);
      damageFx.frame(renderer.camera, vMotion.yaw, vMotion.pos, (id) => renderer.playerPos(id, fxPos));
    } else {
      qol.frame(input.yaw, me?.alive && !spectating ? { x: feet.x, z: feet.z } : { x: cp.x, z: cp.z }, snap);
      damageFx.frame(renderer.camera, input.yaw, me?.alive ? feet : null, (id) => renderer.playerPos(id, fxPos));
    }
    fpv.applyShake(dt); // visual only: the aim ray above was taken without it
    if (!warmLoop.paused) {
      warmLoop.before?.();
      renderer.render(input.yaw);
      fpv.render(spectating ? undefined : me, input.yaw, input.pitch, dt, predicting ? predicted.vel : undefined, simNow());
      renderer.captureInfo();
      if (input.lookEventT !== null) { latency.drawn(input.lookEventT); input.lookEventT = null; }
      if (warmLoop.left > 0 && --warmLoop.left === 0) { warmLoop.before = null; warmLoop.done?.(); }
    }
    audio.frame(renderer.camera);
    audio.rockets(renderer.gunFx.liveRockets());
    audio.fires(renderer.world.fire.burning());
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
      app.classList.remove('replay-mode');
      document.body.classList.remove('brain-x-open');
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
  if (telemetryEnabled()) { installErrorReporting(); installReplayUploads(); }
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
