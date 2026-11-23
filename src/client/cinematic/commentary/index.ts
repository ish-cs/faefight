/**
 * Commentary glue: the Commentator + voice (neural Kokoro once loaded, the browser voice until then) +
 * captions, switched on by cinematic mode (the director, read structurally from window.__cinematic so this
 * works whether or not it's in the build) or, if Settings → Commentary → While spectating is on, by spectating.
 */
import type { PlayerState, Snapshot } from '../../../sim/types';
import { settings } from '../../settings/store';
import { Commentator, type Caption, type ShotEvent } from './commentator';
import { KEY_VARS, LINES, PERSONA, type LineKey } from './lines';
import { HybridTts, NEURAL_DEFAULT, voiceTester, type NeuralState } from './neural';
import type { Persona } from './tts';

/** The slice of the cinematic director we use (src/client/cinematic/director.ts). */
export interface DirectorLike {
  readonly active: boolean;
  on(ev: 'shot', fn: (e: ShotEvent) => void): () => void;
  on(ev: 'active', fn: (active: boolean) => void): () => void;
}

/**
 * The name to say: a vs-bot match names the local human "You" (that's for the HUD); the commentator uses the
 * display name from the menu (faefight.name) instead, or "our player" when none is set.
 */
export function displayName(p: Pick<PlayerState, 'name' | 'isBot'>, stored: () => string | null = storedName): string {
  // Watch-bots names carry a difficulty tag ("Ash (hard)"): the commentator just says the name.
  if (p.isBot || p.name !== 'You') return p.name.replace(/\s*\([^)]*\)\s*$/, '') || p.name;
  const n = stored()?.trim();
  return n || 'our player';
}

function storedName(): string | null {
  try { return localStorage.getItem('faefight.name'); } catch { return null; }
}

/** Lines with no placeholders: the same audio every time, worth synthesizing ahead. */
export function fixedLines(): { text: string; persona: Persona }[] {
  const out: { text: string; persona: Persona }[] = [];
  for (const k of Object.keys(LINES) as LineKey[]) if (KEY_VARS[k].length === 0) for (const text of LINES[k]) out.push({ text, persona: PERSONA[k] });
  return out;
}

class Captions {
  private el: HTMLDivElement | null = null;
  private chip: HTMLDivElement | null = null;
  show(c: Caption | null) {
    if (!c) { if (this.el) this.el.classList.remove('on'); return; }
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'commentary-caption';
      this.el.dataset.testid = 'commentary-caption';
      this.el.setAttribute('aria-live', 'polite');
      document.body.append(this.el);
    }
    this.el.textContent = c.text;
    this.el.dataset.persona = c.persona;
    this.el.classList.add('on');
  }
  /** Small corner status ("Loading voice… 40%"); null hides it. */
  status(text: string | null) {
    if (!text) { this.chip?.remove(); this.chip = null; return; }
    if (!this.chip) {
      this.chip = document.createElement('div');
      this.chip.className = 'commentary-status';
      this.chip.dataset.testid = 'commentary-status';
      document.body.append(this.chip);
    }
    this.chip.textContent = text;
  }
}

export class Commentary {
  readonly commentator: Commentator;
  readonly tts: HybridTts;
  private captions = new Captions();
  private dir: DirectorLike | null = null;
  private spectating = false;
  private lastTime = -1;
  private prefetchQueue: { text: string; persona: Persona }[] = [];
  /** Last neural-voice state, for the debug hook / e2e. */
  neuralState: NeuralState = 'off';

  constructor(duck: (on: boolean) => void, tts?: HybridTts) {
    this.tts = tts ?? new HybridTts(undefined, (s, d) => this.onNeural(s, d));
    this.commentator = new Commentator({
      tts: this.tts,
      displayName,
      volume: () => this.volume(),
      onCaption: (c) => this.captions.show(c && settings.get().audio.captions ? c : null),
      duck,
    });
    settings.subscribe(() => { this.applyVoices(); this.recompute(); });
    // A hidden tab never talks (a background preview tab, a minimised window); an unfocused one only in cinematic mode.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.recompute());
      window.addEventListener('blur', () => this.recompute());
      window.addEventListener('focus', () => this.recompute());
    }
    this.applyVoices();
    // Settings → Test voice uses the same neural voice the commentary does (loading it if needed).
    voiceTester.neural = (persona, voice) => {
      this.tts.ensureNeural();
      const n = this.tts.neural;
      if (!n?.available) return false;
      const was = n.voices[persona];
      n.voices[persona] = voice || NEURAL_DEFAULT[persona];
      n.cancel();
      n.speak(persona === 'pbp' ? 'And he takes the shot. What a finish! That is how you win a fight!' : 'Smart play there. He saved his money, and now it pays off.',
        { persona, intensity: 0.8, volume: this.volume() });
      n.voices[persona] = was;
      return true;
    };
  }

  private volume() { const a = settings.get().audio; return a.muted ? 0 : a.commentary * a.master; }

  private onNeural(s: NeuralState, detail: string) {
    this.neuralState = s;
    if (s === 'loading') this.captions.status(`Loading commentator voice… ${detail}%`);
    else if (s === 'ready') { this.captions.status(null); this.prefetchQueue = fixedLines(); }
    else this.captions.status(null);
  }

  private applyVoices() {
    const a = settings.get().audio;
    this.tts.browser.setVoices({ pbp: a.voicePbp || undefined, colour: a.voiceColour || undefined });
    this.tts.useNeural = a.voiceEngine === 'neural';
    if (this.tts.neural) this.tts.neural.voices = { pbp: a.neuralPbp || NEURAL_DEFAULT.pbp, colour: a.neuralColour || NEURAL_DEFAULT.colour };
  }

  /** May the commentator be heard right now? Visible, and focused unless cinematic mode is on. */
  private audible(): boolean {
    if (typeof document === 'undefined') return true;
    return !document.hidden && (document.hasFocus() || !!this.dir?.active);
  }

  /** Each snapshot, with whether we're watching rather than playing. */
  onSnapshot(s: Snapshot, spectating: boolean, hold = false) {
    this.commentator.hold = hold;
    this.attachDirector();
    if (s.time < this.lastTime) this.commentator.reset(); // a new match
    this.lastTime = s.time;
    if (spectating !== this.spectating) { this.spectating = spectating; this.recompute(); }
    this.commentator.onSnapshot(s);
    // Idle time: synthesize the fixed lines ahead, one at a time, never while a line is playing.
    const n = this.tts.neural;
    if (this.commentator.active && n?.available && this.prefetchQueue.length && !this.tts.speaking) {
      const next = this.prefetchQueue[0];
      if (n.prefetch(next.text, next.persona)) this.prefetchQueue.shift();
    }
  }

  /** Leaving the match (back to the menu). */
  stop() { this.spectating = false; this.commentator.setActive(false); this.commentator.reset(); this.lastTime = -1; }

  private attachDirector() {
    const d = (window as unknown as { __cinematic?: DirectorLike }).__cinematic;
    if (!d || d === this.dir || typeof d.on !== 'function') return;
    this.dir = d;
    d.on('shot', (e) => this.commentator.onShot(e));
    d.on('active', () => this.recompute());
    console.info('[commentary] attached to the cinematic director');
    this.recompute();
  }

  private recompute() {
    const a = settings.get().audio;
    const on = a.commentaryOn && this.audible() && (!!this.dir?.active || (this.spectating && a.commentarySpectate));
    this.commentator.setActive(on);
    if (on) { this.tts.ensureNeural(); this.applyVoices(); }
  }
}
