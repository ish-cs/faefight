/**
 * Full-screen branded loading screen (markup + critical CSS live in index.html so it is the very
 * first paint). Progress is real: the caller declares weighted phases and reports each phase's
 * 0..1 completion; the bar eases toward the weighted sum and never goes backwards.
 * Detached from the DOM while hidden.
 */

export const TIPS = [
  'Seal a bunker while its owner respawns: a sealed player who dies is out for good.',
  'Collect cash at your generator, then spend it at the shop before you push.',
  'Bridges win games. Ramps and scaffolds get you over the water and onto their quay.',
  'Breach charges crack sealed walls fast. Keep one for the endgame.',
  'Steel walls shrug off bullets but not explosives. Mix your materials.',
  'Drop a medkit stack into your vault before a risky push.',
  'Hold the free-placement key to place pieces off the grid.',
  'Ctrl or Shift with the drop key throws the whole stack.',
  'At 15:00 a storm closes in on the middle of the map. Stay inside the ring.',
  'Every key can be rebound in Settings → Controls.',
];

/** Short names for the step dots under the bar (match loads); phases without one get no dot. */
export const STEP_NAMES: Record<string, string> = {
  code: 'Code', gpu: 'Graphics', characters: 'Players', map: 'Islands', shaders: 'Shaders', frames: 'Ready',
};
/** Inside a running phase the bar creeps on, easing toward this share of what's left of it (never reaching it). */
const CREEP_SHARE = 0.5;
/** Time constant (ms) of that creep: after ~2.6 s a stuck phase has crept ~a third of its remaining width. */
const CREEP_TAU_MS = 2600;

export type LoadEvent = { kind: 'show' | 'progress' | 'hide'; phase?: string; frac?: number; total: number; label?: string; t: number };

export class LoadingScreen {
  private root: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;
  private tip: HTMLElement;
  private tipText: HTMLElement;
  private tipHead: HTMLElement;
  private steps: HTMLElement;
  private stepEls = new Map<string, HTMLElement>();
  private weights: Record<string, number> = {};
  private fracs: Record<string, number> = {};
  /** When each phase first reported progress below 1 (it is running; the bar may creep into it). */
  private startedAt: Record<string, number> = {};
  private target = 0;
  private shown = 0;
  private raf = 0;
  private tipTimer = 0;
  private tipIndex = Math.floor(Math.random() * TIPS.length);
  private hideTimer = 0;
  visible = true;
  /** Every show/progress/hide, for the ?debug=1 hook and tests. */
  readonly events: LoadEvent[] = [];

  constructor() {
    const found = document.getElementById('loading');
    if (!found) throw new Error('[loading] #loading element missing from index.html');
    this.root = found;
    const q = (s: string) => {
      const e = this.root.querySelector<HTMLElement>(s);
      if (!e) throw new Error(`[loading] ${s} missing from #loading`);
      return e;
    };
    this.fill = q('.ld-fill');
    this.label = q('.ld-label');
    this.pct = q('.ld-pct');
    this.tip = q('.ld-tip');
    this.tipText = q('.ld-tip-text');
    this.tipHead = q('.ld-tip b');
    this.steps = q('.ld-steps');
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Start a load. `boot` = first page load (no tips); `match` = starting/joining a match. */
  show(mode: 'boot' | 'match', phases: Record<string, number>) {
    clearTimeout(this.hideTimer);
    this.weights = phases;
    this.fracs = {};
    this.startedAt = {};
    this.target = 0;
    this.shown = 0;
    this.buildSteps(mode === 'match' ? Object.keys(phases).filter((k) => k in STEP_NAMES) : []);
    this.root.classList.toggle('boot', mode === 'boot');
    const wasHidden = !this.visible || !this.root.isConnected;
    this.root.classList.remove('gone');
    if (!this.root.isConnected) document.body.prepend(this.root);
    if (wasHidden) {
      // Force a style flush so the fade-in transition runs from opacity 0.
      this.root.classList.add('hidden');
      void this.root.offsetWidth;
      this.root.classList.remove('hidden');
    }
    this.visible = true;
    this.setText(this.label, 'Loading');
    this.paint();
    if (mode === 'match') this.startTips();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.log({ kind: 'show' });
  }

  /** Phase `phase` is `frac` (0..1) done. Unknown phases are an error in the caller. */
  progress(phase: string, frac: number, label?: string) {
    if (!(phase in this.weights)) { console.warn(`[loading] unknown phase "${phase}"`); return; }
    const f = Math.min(1, Math.max(this.fracs[phase] ?? 0, frac));
    this.fracs[phase] = f;
    this.startedAt[phase] ??= performance.now();
    const step = this.stepEls.get(phase);
    if (step) { step.classList.toggle('done', f >= 1); step.classList.toggle('on', f < 1); }
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0) || 1;
    this.target = Math.max(this.target, Object.entries(this.weights).reduce((a, [k, w]) => a + w * (this.fracs[k] ?? 0), 0) / sum);
    if (label) this.setText(this.label, label);
    this.log({ kind: 'progress', phase, frac: f, label });
  }

  get total() { return this.target; }

  /** Fill to 100%, fade out, detach. Resolves when gone. */
  hide(): Promise<void> {
    if (!this.visible) return Promise.resolve();
    this.visible = false;
    this.target = 1;
    this.setText(this.label, 'Ready');
    for (const el of this.stepEls.values()) { el.classList.remove('on'); el.classList.add('done'); }
    this.paint();
    this.log({ kind: 'hide' });
    clearInterval(this.tipTimer);
    return new Promise((res) => {
      // The bar sweeps to 100% (tick, fast while hiding), a beat, then the fade.
      this.hideTimer = window.setTimeout(() => {
        this.root.classList.add('hidden');
        this.hideTimer = window.setTimeout(() => {
          this.root.classList.add('gone');
          this.root.remove();
          cancelAnimationFrame(this.raf);
          res();
        }, 520);
      }, 200);
    });
  }

  private startTips() {
    clearInterval(this.tipTimer);
    const put = () => {
      this.tipText.dataset.text = TIPS[this.tipIndex];
      this.tipHead.dataset.text = `TIP ${this.tipIndex + 1} / ${TIPS.length}`;
    };
    const next = () => {
      this.tipIndex = (this.tipIndex + 1) % TIPS.length;
      this.tip.style.opacity = '0';
      setTimeout(() => { put(); this.tip.style.opacity = '1'; }, 400);
    };
    put();
    this.tip.style.opacity = '1';
    this.tipTimer = window.setInterval(next, 5000);
  }

  /** One dot + name per phase under the bar (match loads); empty for the boot screen. */
  private buildSteps(keys: string[]) {
    this.steps.replaceChildren();
    this.stepEls.clear();
    for (const k of keys) {
      const el = document.createElement('div');
      el.className = 'ld-step';
      el.dataset.testid = `loading-step-${k}`;
      const name = document.createElement('span');
      name.dataset.text = STEP_NAMES[k];
      el.append(document.createElement('i'), name);
      this.steps.append(el);
      this.stepEls.set(k, el);
    }
  }

  /**
   * Where the bar may go right now: the reported total plus, for each running phase, a creep into its
   * unfinished width that eases toward CREEP_SHARE of it with time. Grows monotonically within a phase
   * (more progress adds more than it takes from the creep), never reaches the next real milestone, and
   * hide() alone takes the bar to 100 %.
   */
  private ceiling(now: number): number {
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0) || 1;
    let room = 0;
    for (const [k, t0] of Object.entries(this.startedAt)) {
      const f = this.fracs[k] ?? 0;
      if (f >= 1) continue;
      room += ((this.weights[k] ?? 0) * (1 - f) * CREEP_SHARE * (1 - Math.exp(-(now - t0) / CREEP_TAU_MS))) / sum;
    }
    return Math.min(0.995, this.target + room);
  }

  private tick() {
    // Ease toward the ceiling; the bar only ever moves forward.
    const gap = (this.visible ? this.ceiling(performance.now()) : 1) - this.shown;
    if (gap > 0) this.shown += Math.min(gap, Math.max(gap * (this.visible ? 0.1 : 0.3), 0.0008));
    if (!this.visible && gap < 0.002) this.shown = 1;
    this.paint();
    if (this.visible || this.shown < 1) this.raf = requestAnimationFrame(this.tick);
  }

  private paint() {
    const p = Math.round(this.shown * 100);
    this.fill.style.width = `${(this.shown * 100).toFixed(2)}%`;
    this.pct.dataset.text = `${p}%`;
    this.root.setAttribute('aria-valuenow', String(p));
    this.root.setAttribute('aria-valuetext', `${this.label.dataset.text ?? 'Loading'} ${p}%`);
  }

  /** Visible text lives in data-text (rendered by CSS ::before; see index.html). */
  private setText(e: HTMLElement, text: string) { e.dataset.text = text; }

  private log(e: Omit<LoadEvent, 't' | 'total'>) {
    this.events.push({ ...e, total: this.target, t: Math.round(performance.now()) });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }
}

let instance: LoadingScreen | null = null;
export function loadingScreen(): LoadingScreen {
  instance ??= new LoadingScreen();
  return instance;
}
