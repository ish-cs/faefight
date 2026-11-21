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

export type LoadEvent = { kind: 'show' | 'progress' | 'hide'; phase?: string; frac?: number; total: number; label?: string; t: number };

export class LoadingScreen {
  private root: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;
  private tip: HTMLElement;
  private tipText: HTMLElement;
  private weights: Record<string, number> = {};
  private fracs: Record<string, number> = {};
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
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Start a load. `boot` = first page load (no tips); `match` = starting/joining a match. */
  show(mode: 'boot' | 'match', phases: Record<string, number>) {
    clearTimeout(this.hideTimer);
    this.weights = phases;
    this.fracs = {};
    this.target = 0;
    this.shown = 0;
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
    this.shown = 1;
    this.paint();
    this.log({ kind: 'hide' });
    clearInterval(this.tipTimer);
    return new Promise((res) => {
      // A beat at 100% so the bar visibly completes, then the fade.
      this.hideTimer = window.setTimeout(() => {
        this.root.classList.add('hidden');
        this.hideTimer = window.setTimeout(() => {
          this.root.classList.add('gone');
          this.root.remove();
          cancelAnimationFrame(this.raf);
          res();
        }, 460);
      }, 120);
    });
  }

  private startTips() {
    clearInterval(this.tipTimer);
    const next = () => {
      this.tipIndex = (this.tipIndex + 1) % TIPS.length;
      this.tip.style.opacity = '0';
      setTimeout(() => { this.tipText.dataset.text = TIPS[this.tipIndex]; this.tip.style.opacity = '1'; }, 400);
    };
    this.tipText.dataset.text = TIPS[this.tipIndex];
    this.tip.style.opacity = '1';
    this.tipTimer = window.setInterval(next, 4500);
  }

  private tick() {
    // Ease toward the target; a small creep inside a phase keeps the bar alive during long single steps.
    const gap = this.target - this.shown;
    this.shown += gap > 0 ? Math.max(gap * 0.12, 0.0015) : 0;
    if (this.shown > this.target) this.shown = this.target;
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
