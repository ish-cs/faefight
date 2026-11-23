/**
 * Commentary glue: the Commentator + browser voice + captions, switched on by cinematic mode (the
 * director, read structurally from window.__cinematic so this works whether or not it's in the build)
 * or, if Settings → Commentary → While spectating is on, by spectating.
 */
import type { Snapshot } from '../../../sim/types';
import { settings } from '../../settings/store';
import { Commentator, type Caption, type ShotEvent } from './commentator';
import { BrowserTts, type Tts } from './tts';

/** The slice of the cinematic director we use (src/client/cinematic/director.ts). */
export interface DirectorLike {
  readonly active: boolean;
  on(ev: 'shot', fn: (e: ShotEvent) => void): () => void;
  on(ev: 'active', fn: (active: boolean) => void): () => void;
}

class Captions {
  private el: HTMLDivElement | null = null;
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
}

export class Commentary {
  readonly commentator: Commentator;
  private captions = new Captions();
  private dir: DirectorLike | null = null;
  private spectating = false;
  private lastTime = -1;

  constructor(duck: (on: boolean) => void, tts: Tts = new BrowserTts()) {
    this.commentator = new Commentator({
      tts,
      volume: () => { const a = settings.get().audio; return a.muted ? 0 : a.commentary * a.master; },
      onCaption: (c) => this.captions.show(c && settings.get().audio.captions ? c : null),
      duck,
    });
    settings.subscribe(() => this.recompute());
  }

  /** Each snapshot, with whether we're watching rather than playing. */
  onSnapshot(s: Snapshot, spectating: boolean) {
    this.attachDirector();
    if (s.time < this.lastTime) this.commentator.reset(); // a new match
    this.lastTime = s.time;
    if (spectating !== this.spectating) { this.spectating = spectating; this.recompute(); }
    this.commentator.onSnapshot(s);
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
    this.commentator.setActive(a.commentaryOn && (!!this.dir?.active || (this.spectating && a.commentarySpectate)));
  }
}
