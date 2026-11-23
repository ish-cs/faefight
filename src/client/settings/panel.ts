import { AIM_MODES, ctrlAimDefault, isMacPlatform, platformNav } from '../aimInput';
import './settings.css';

import {
  ACTIONS, type Action, type ActionGroup, actionLabel, bindingLabel, conflictsFor, defaultKeymap, findConflicts, isBindable, keyLabel,
  rebind, setKeymapSuspended, unbind,
} from '../keymap';
import {
  CROSSHAIR_COLORS, CROSSHAIRS, type Crosshair, FRAME_CAPS, GEN_ALERT_PCTS, LIMITS, QUALITIES, type Settings, settings,
} from './store';
import type { Quality } from '../world/sky';
import { availableVoices, testVoice } from '../cinematic/commentary/tts';
import { NEURAL_VOICES, neuralEngine, voiceTester } from '../cinematic/commentary/neural';

const PERF_STATS = ['off', 'fps', 'detailed'] as const;
const PERF_STATS_LABEL: Record<(typeof PERF_STATS)[number], string> = { off: 'Off', fps: 'FPS', detailed: 'Detailed' };

/**
 * Settings modal (main menu + in-game pause card). Every control writes straight to the settings
 * store, which persists and applies live. Game keys are suspended while it is open.
 */

type Tab = 'controls' | 'video' | 'audio' | 'gameplay';
const TABS: { id: Tab; label: string }[] = [
  { id: 'controls', label: 'Controls' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'gameplay', label: 'Gameplay' },
];
const GROUPS: ActionGroup[] = ['Movement', 'Actions', 'Hotbar', 'Building', 'Interface'];
const QUALITY_NOTE: Record<Quality, string> = {
  low: 'No bloom or AO, 2 shadow cascades',
  high: 'Bloom, ambient occlusion, 3 shadow cascades',
  ultra: 'High + sharper render and 4 shadow cascades',
};
const CROSSHAIR_LABEL: Record<Crosshair, string> = { cross: 'Cross', dot: 'Dot', circle: 'Circle', 'cross-dot': 'Cross + dot' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const set = (fn: (d: Settings) => void) => settings.update(fn);

let openPanel: { close(): void } | null = null;

export const settingsOpen = () => openPanel !== null;

export function openSettings(opts: { onClose?: () => void; tab?: Tab } = {}): { close(): void } {
  if (openPanel) return openPanel;
  setKeymapSuspended(true);
  if (document.pointerLockElement) document.exitPointerLock();
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'settings-overlay');
  overlay.dataset.testid = 'settings';
  const card = el('div', 'settings glass');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Settings');
  const head = el('div', 'set-head');
  const title = el('div', 'set-title', 'Settings');
  const close = el('button', 'set-close', 'Done');
  close.dataset.testid = 'settings-close';
  head.append(title, close);
  const nav = el('nav', 'set-nav');
  const body = el('div', 'set-body');
  card.append(head, nav, body);
  overlay.append(card);
  document.body.append(overlay);

  let tab: Tab = opts.tab ?? 'controls';
  let capturing: { action: Action; btn: HTMLButtonElement } | null = null;
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const t of TABS) {
    const b = el('button', 'set-tab', t.label);
    b.dataset.testid = `settings-tab-${t.id}`;
    b.onclick = () => { tab = t.id; render(); };
    tabBtns.set(t.id, b);
    nav.append(b);
  }

  function render() {
    capturing = null;
    for (const [id, b] of tabBtns) b.classList.toggle('on', id === tab);
    body.replaceChildren();
    if (tab === 'controls') renderControls();
    else if (tab === 'video') renderVideo();
    else if (tab === 'audio') renderAudio();
    else renderGameplay();
  }

  // ---- generic rows ----
  const row = (label: string, note: string, control: HTMLElement, cls = '') => {
    const r = el('div', `set-row ${cls}`.trim());
    const l = el('div', 'set-label');
    l.append(el('div', 'set-name', label));
    if (note) l.append(el('div', 'set-note', note));
    r.append(l, control);
    body.append(r);
    return r;
  };
  const section = (name: string) => body.append(el('div', 'set-section', name));

  const slider = (label: string, note: string, testid: string, min: number, max: number, step: number,
    get: () => number, put: (v: number) => void, fmt: (v: number) => string) => {
    const wrap = el('div', 'set-slider');
    const input = el('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(get());
    input.dataset.testid = testid;
    const val = el('span', 'set-val', fmt(get()));
    const paint = () => {
      const k = (Number(input.value) - min) / (max - min);
      input.style.setProperty('--fill', `${(k * 100).toFixed(1)}%`);
    };
    input.oninput = () => { put(Number(input.value)); val.textContent = fmt(get()); paint(); };
    paint();
    wrap.append(input, val);
    return row(label, note, wrap);
  };

  const toggle = (label: string, note: string, testid: string, get: () => boolean, put: (v: boolean) => void) => {
    const sw = el('label', 'set-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = get();
    input.dataset.testid = testid;
    input.onchange = () => put(input.checked);
    sw.append(input, el('span', 'knob'));
    return row(label, note, sw);
  };

  const segmented = <T extends string | number>(label: string, note: string, testid: string, options: readonly T[],
    name: (o: T) => string, get: () => T, put: (v: T) => void, after?: () => void) => {
    const seg = el('div', 'set-seg');
    seg.dataset.testid = testid;
    const paint = () => seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', options[i] === get()));
    for (const o of options) {
      const b = el('button', '', name(o));
      b.dataset.value = String(o);
      b.onclick = () => { put(o); paint(); after?.(); };
      seg.append(b);
    }
    paint();
    return row(label, note, seg);
  };

  const resetBtn = (label: string, fn: () => void) => {
    const foot = el('div', 'set-foot');
    const b = el('button', 'btn small', label);
    b.dataset.testid = 'settings-reset';
    b.onclick = () => { fn(); render(); };
    foot.append(b);
    body.append(foot);
  };

  // ---- tabs ----
  function renderControls() {
    const c = () => settings.get().controls;
    section('Mouse');
    slider('Sensitivity', 'Mouse and trackpad look speed', 'set-sensitivity', LIMITS.sensitivity[0], LIMITS.sensitivity[1], 0.05,
      () => c().sensitivity, (v) => set((d) => { d.controls.sensitivity = v; }), (v) => v.toFixed(2));
    body.append(sensPreview());
    toggle('Invert Y', 'Push the mouse up to look down', 'set-invert', () => c().invertY, (v) => set((d) => { d.controls.invertY = v; }));
    segmented('Aim mode', 'Right mouse and Ctrl: hold to aim, or press once to aim and again to stop', 'set-aim-mode', AIM_MODES,
      (m) => (m === 'hold' ? 'Hold' : 'Toggle'), () => c().aimMode, (m) => set((d) => { d.controls.aimMode = m; }));
    toggle('Ctrl aims', isMacPlatform(platformNav()) ? 'Either Ctrl key aims too, so a trackpad can aim and click to fire'
      : 'Either Ctrl key aims too (trackpads). Ctrl+W can close the tab: play fullscreen to keep it in the game',
    'set-ctrl-aim', () => c().ctrlAim, (v) => set((d) => { d.controls.ctrlAim = v; }));

    const conflicts = findConflicts(c().keys);
    const banner = el('div', 'set-conflicts');
    banner.dataset.testid = 'key-conflicts';
    if (conflicts.length) {
      banner.textContent = conflicts.map((x) => `${keyLabel(x.code)} is bound to ${x.actions.map(actionLabel).join(' and ')}`).join(' · ');
      body.append(banner);
    }
    for (const g of GROUPS) {
      section(g);
      for (const a of ACTIONS.filter((x) => x.group === g)) {
        const codes = c().keys[a.id];
        const keys = el('div', 'set-keys');
        const btn = el('button', 'keycap', codes.length ? bindingLabel(c().keys, a.id) : 'Unbound');
        btn.dataset.testid = `bind-${a.id}`;
        btn.classList.toggle('unbound', !codes.length);
        btn.onclick = () => startCapture(a.id, btn);
        keys.append(btn);
        if (codes.join() !== a.defaults.join()) {
          const undo = el('button', 'key-reset', '↺');
          undo.title = `Reset to ${a.defaults.map(keyLabel).join(' / ')}`;
          undo.onclick = () => { set((d) => { d.controls.keys = { ...d.controls.keys, [a.id]: [...a.defaults] }; }); render(); };
          keys.prepend(undo);
        }
        const clash = codes.flatMap((code) => conflictsFor(c().keys, a.id, code));
        const r = row(a.label, clash.length ? `Also bound to ${[...new Set(clash)].map(actionLabel).join(', ')}` : '', keys, 'key-row');
        r.classList.toggle('conflict', clash.length > 0);
      }
    }
    body.append(el('div', 'set-hint', 'Fire / use / place is the left mouse button; the mouse wheel also picks hotbar slots. Ctrl aims too when "Ctrl aims" is on.'));
    resetBtn('Reset controls to defaults', () => set((d) => { d.controls.keys = defaultKeymap(); d.controls.sensitivity = 1; d.controls.invertY = false; d.controls.aimMode = 'hold'; d.controls.ctrlAim = ctrlAimDefault(platformNav()); }));
  }

  function sensPreview() {
    const box = el('div', 'sens-preview');
    box.dataset.testid = 'sens-preview';
    const dot = el('div', 'sens-dot');
    const hint = el('div', 'sens-hint', 'Move the mouse here to try it');
    box.append(hint, dot);
    let x = 0.5, y = 0.5;
    box.onmousemove = (e) => {
      const w = box.clientWidth, h = box.clientHeight;
      const s = settings.get().controls;
      const k = 0.6 * s.sensitivity;
      x = (((x * w + e.movementX * k) % w) + w) % w / w;
      y = (((y * h + e.movementY * k * (s.invertY ? -1 : 1)) % h) + h) % h / h;
      dot.style.left = `${(x * 100).toFixed(2)}%`;
      dot.style.top = `${(y * 100).toFixed(2)}%`;
      hint.style.opacity = '0';
      dot.style.opacity = '1';
    };
    return box;
  }

  function startCapture(action: Action, btn: HTMLButtonElement) {
    if (capturing) capturing.btn.classList.remove('listening');
    capturing = { action, btn };
    btn.classList.add('listening');
    btn.textContent = 'Press a key…';
    btn.title = 'Esc cancels · Backspace clears';
  }

  function renderVideo() {
    const v = () => settings.get().video;
    section('Display');
    segmented('Graphics quality', QUALITY_NOTE[v().quality], 'set-quality', QUALITIES, (q) => q[0].toUpperCase() + q.slice(1),
      () => v().quality, (q) => set((d) => { d.video.quality = q; }), render);
    slider('Resolution scale', 'Render resolution relative to the quality preset', 'set-resscale',
      LIMITS.resolutionScale[0], LIMITS.resolutionScale[1], 0.05,
      () => v().resolutionScale, (x) => set((d) => { d.video.resolutionScale = x; }), (x) => `${Math.round(x * 100)}%`);
    segmented('Frame cap', 'Browsers always sync to the display (vsync); a cap limits below it to save power',
      'set-framecap', FRAME_CAPS, (f) => (f === 0 ? 'Vsync' : `${f}`), () => v().frameCap, (f) => set((d) => { d.video.frameCap = f; }));
    toggle('Competitive mode', 'Maximum frame rate, still readable: 1× render scale, no ambient occlusion, bloom or lens flare', 'set-competitive', () => v().competitive, (x) => set((d) => { d.video.competitive = x; }));
    toggle('Dynamic resolution', 'Lower the render resolution briefly when the frame rate drops below target', 'set-dynres',
      () => v().dynamicResolution, (x) => set((d) => { d.video.dynamicResolution = x; }));
    {
      const keys = settings.get().controls.keys.fps.map(keyLabel).filter(Boolean).join(' / ') || '—';
      segmented('Performance stats', `Also ${keys} in game (Shift: detail): frame time, draw calls, triangles`, 'set-fps', PERF_STATS, (x) => PERF_STATS_LABEL[x],
        () => (!v().showFps ? 'off' : v().perfDetail ? 'detailed' : 'fps'),
        (x) => set((d) => { d.video.showFps = x !== 'off'; d.video.perfDetail = x === 'detailed'; }));
    }
    section('Field of view');
    slider('Third person', '', 'set-fov3', LIMITS.fovThird[0], LIMITS.fovThird[1], 1,
      () => v().fovThird, (x) => set((d) => { d.video.fovThird = x; }), (x) => `${Math.round(x)}°`);
    slider('First person', '', 'set-fov1', LIMITS.fovFirst[0], LIMITS.fovFirst[1], 1,
      () => v().fovFirst, (x) => set((d) => { d.video.fovFirst = x; }), (x) => `${Math.round(x)}°`);
    resetBtn('Reset video to defaults', () => settings.reset('video'));
  }

  function renderAudio() {
    const a = () => settings.get().audio;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    section('Volume');
    slider('Master', '', 'set-master', 0, 1, 0.05, () => a().master, (x) => set((d) => { d.audio.master = x; d.audio.muted = false; }), pct);
    slider('Effects', 'Weapons, impacts, footsteps, building', 'set-effects', 0, 1, 0.05, () => a().effects, (x) => set((d) => { d.audio.effects = x; }), pct);
    slider('Interface', 'Hit ticks, shop, alerts, win and lose stingers', 'set-ui', 0, 1, 0.05, () => a().ui, (x) => set((d) => { d.audio.ui = x; }), pct);
    slider('Ambience', 'Waves, wind, rain, wildlife', 'set-ambience', 0, 1, 0.05, () => a().ambience, (x) => set((d) => { d.audio.ambience = x; }), pct);
    section('Music');
    toggle('Music', 'Calm while you build, tense in a nearby fight, intense when the storm closes', 'set-music-on', () => a().musicOn, (x) => set((d) => { d.audio.musicOn = x; }));
    slider('Music volume', '', 'set-music', 0, 1, 0.05, () => a().music, (x) => set((d) => { d.audio.music = x; }), pct);
    section('Commentary');
    toggle('Commentary', 'A sportscaster calls the action when you watch bots (cinematic mode)', 'set-commentary-on', () => a().commentaryOn, (x) => set((d) => { d.audio.commentaryOn = x; }));
    slider('Commentary volume', 'Game sound dips a little while the commentator talks', 'set-commentary', 0, 1, 0.05, () => a().commentary, (x) => set((d) => { d.audio.commentary = x; }), pct);
    toggle('Captions', 'Show what the commentator says on screen', 'set-captions', () => a().captions, (x) => set((d) => { d.audio.captions = x; }));
    toggle('While spectating', 'Also commentate when you spectate a match', 'set-commentary-spectate', () => a().commentarySpectate, (x) => set((d) => { d.audio.commentarySpectate = x; }));
    // Opt-in neural voice (only in a build that ships one): off = the model is never fetched; on = it downloads
    // once (progress shows in the corner while watching) and the browser voice speaks until it's ready.
    if (neuralEngine.makeWorker) {
      const r = toggle('Neural voice (≈160 MB one-time download)', 'A free, more natural commentator voice. Needs WebGPU; until it has loaded (or without WebGPU) your system voice speaks', 'set-neural-voice',
        () => a().voiceEngine === 'neural', (x) => { set((d) => { d.audio.voiceEngine = x ? 'neural' : 'browser'; }); render(); });
      r.classList.add('set-neural-row');
    }
    // Voice per commentator. Neural: the Kokoro voices. Browser: the best installed English voices (macOS: add
    // Premium/Enhanced ones in System Settings → Accessibility → Spoken Content → Manage Voices). '' = Auto.
    const neural = a().voiceEngine === 'neural' && !!neuralEngine.makeWorker;
    const voices = neural ? ['', ...NEURAL_VOICES.map((v) => v.id)] : ['', ...availableVoices().slice(0, 14)];
    const label = (v: string) => (!v ? 'Auto' : neural ? NEURAL_VOICES.find((n) => n.id === v)?.label ?? v : v.replace(/\s*\((English|en)[^)]*\)/i, ''));
    const voiceRow = (title: string, persona: 'pbp' | 'colour', testid: string, get: () => string, put: (v: string) => void) => {
      const r = segmented(title, persona === 'pbp' ? 'Calls the action' : 'Analysis, strategy and quiet moments', testid, voices, label, get, put);
      r.classList.add('set-voice-row');
      const test = el('button', 'btn small set-voice-test', 'Test voice');
      test.dataset.testid = `${testid}-test`;
      test.onclick = () => {
        const au = a();
        // The neural voice if it's loaded (Test also starts loading it); else the browser voice.
        if (neural && voiceTester.neural?.(persona, get())) return;
        testVoice(persona, neural ? '' : get(), au.muted ? 0 : au.commentary * au.master);
      };
      r.append(test);
    };
    if (neural) {
      voiceRow('Play-by-play voice', 'pbp', 'set-voice-pbp', () => a().neuralPbp, (v) => set((d) => { d.audio.neuralPbp = v; }));
      voiceRow('Colour voice', 'colour', 'set-voice-colour', () => a().neuralColour, (v) => set((d) => { d.audio.neuralColour = v; }));
    } else {
      voiceRow('Play-by-play voice', 'pbp', 'set-voice-pbp', () => a().voicePbp, (v) => set((d) => { d.audio.voicePbp = v; }));
      voiceRow('Colour voice', 'colour', 'set-voice-colour', () => a().voiceColour, (v) => set((d) => { d.audio.voiceColour = v; }));
    }
    section('Output');
    toggle('Mute', `Also on ${keyLabel(settings.get().controls.keys.mute[0] ?? '') || '—'} in game`, 'set-mute', () => a().muted, (x) => set((d) => { d.audio.muted = x; }));
    resetBtn('Reset audio to defaults', () => settings.reset('audio'));
  }

  function renderGameplay() {
    const g = () => settings.get().gameplay;
    section('Crosshair');
    const preview = el('div', 'xh-preview');
    const xh = el('div', 'crosshair');
    preview.append(xh);
    const paint = () => { preview.dataset.crosshair = g().crosshair; preview.style.setProperty('--xh', g().crosshairColor); };
    segmented('Style', '', 'set-crosshair', CROSSHAIRS, (x) => CROSSHAIR_LABEL[x], () => g().crosshair, (x) => set((d) => { d.gameplay.crosshair = x; }), paint);
    const sw = el('div', 'set-swatches');
    sw.dataset.testid = 'set-xh-color';
    for (const c of CROSSHAIR_COLORS) {
      const b = el('button', 'swatch');
      b.style.setProperty('--c', c);
      b.title = c;
      b.classList.toggle('on', g().crosshairColor === c);
      b.onclick = () => {
        set((d) => { d.gameplay.crosshairColor = c; });
        sw.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
        paint();
      };
      sw.append(b);
    }
    row('Color', '', sw);
    body.append(preview);
    paint();
    section('Feedback');
    toggle('Damage numbers', 'Floating numbers over players you hit', 'set-dmgnums', () => g().damageNumbers, (x) => set((d) => { d.gameplay.damageNumbers = x; }));
    toggle('Island beacons', "A light beam in each player's colour over their bunker (thin and flickering while sealed)", 'set-beacons', () => g().islandBeacons, (x) => set((d) => { d.gameplay.islandBeacons = x; }));
    section('Alerts');
    segmented('Generator alert', 'Soft ping + toast when your home generator reaches this', 'set-gen-alert', GEN_ALERT_PCTS,
      (x) => (x === 100 ? 'Full' : x === 0 ? 'Off' : `${x}%`), () => g().genAlertPct, (x) => set((d) => { d.gameplay.genAlertPct = x; }));
    section('Camera');
    segmented('Default camera', `Toggle in game with ${keyLabel(settings.get().controls.keys.camera[0] ?? '') || '—'}`, 'set-camera',
      ['third', 'first'] as const, (m) => (m === 'third' ? 'Third person' : 'First person'), () => g().cameraMode, (m) => set((d) => { d.gameplay.cameraMode = m; }));
    slider('Screen shake', 'Explosions, damage, heavy weapons and the hit-stop on kills (0% = off)', 'set-shake', 0, 1, 0.05,
      () => g().screenShake, (x) => set((d) => { d.gameplay.screenShake = x; }), (x) => (x <= 0 ? 'Off' : `${Math.round(x * 100)}%`));
    toggle('Camera bob', 'First-person head bob while walking and sprinting', 'set-bob', () => g().cameraBob, (x) => set((d) => { d.gameplay.cameraBob = x; }));
    resetBtn('Reset gameplay to defaults', () => settings.reset('gameplay'));
  }

  // ---- keys: capture, Esc, tab cycling ----
  const onKey = (e: KeyboardEvent) => {
    if (capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const { action } = capturing;
      if (e.code === 'Escape') { render(); return; }
      if (e.code === 'Backspace') { set((d) => { d.controls.keys = unbind(d.controls.keys, action); }); render(); return; }
      if (!isBindable(e.code)) { capturing.btn.textContent = `${keyLabel(e.code)} can't be bound`; return; }
      set((d) => { d.controls.keys = rebind(d.controls.keys, action, e.code); });
      console.info(`[settings] ${action} → ${e.code}`);
      render();
      return;
    }
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); api.close(); }
  };
  window.addEventListener('keydown', onKey, { capture: true });
  // While capturing, a key release must not reach the game either.
  const onKeyUp = (e: KeyboardEvent) => { if (capturing) e.stopImmediatePropagation(); };
  window.addEventListener('keyup', onKeyUp, { capture: true });

  const api = {
    close() {
      if (openPanel !== api) return;
      openPanel = null;
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      setKeymapSuspended(false);
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 140);
      prevFocus?.focus?.();
      opts.onClose?.();
    },
  };
  close.onclick = () => api.close();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) api.close(); });
  openPanel = api;
  render();
  close.focus();
  return api;
}
