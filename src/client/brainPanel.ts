import './brainPanel.css';
import type { BrainDigest } from '../sim/bots/introspect';
import { TRAIT_KEYS } from '../sim/bots/introspect';
import { personalize } from './viewed';

/**
 * The expanded bot-brain inspector shown while spectating a bot (B toggles it): Now, Scores (goal utilities
 * with their factor breakdown), Log, Perception, Plans and State, from the bot's brain digest (~4 Hz).
 * Player references (`@id`) in the digest's text are shown as names.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Factor colours: positive pushes the goal up, negative down; noise and stickiness are the bot's own wobble. */
const tone = (k: string, v: number) => (k === 'noise' || k === 'sticky' ? 'nz' : v >= 0 ? 'pos' : 'neg');
const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2);

export class BrainInspector {
  readonly root = el('div', 'brain-x');
  private digest: BrainDigest | null = null;
  private names = new Map<number, string>();
  private open = false;
  private overlay = true;
  /** Goals whose breakdown is expanded (click a row); the chosen goal and runner-up are always open. */
  private expanded = new Set<string>();
  private lastSig = '';
  /** Bot being followed (null: none / not a bot): the panel only shows for that bot's digest. */
  private follow: number | null = null;
  /** The local player (even after handing the seat to a bot): "you" in the text. */
  private selfId = 0;

  constructor(parent: HTMLElement) {
    this.root.dataset.testid = 'brain-inspector';
    this.root.style.display = 'none';
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-goal]');
      if (!row) return;
      const g = row.dataset.goal!;
      if (this.expanded.has(g)) this.expanded.delete(g); else this.expanded.add(g);
      this.lastSig = '';
      this.render();
    });
    parent.append(this.root);
  }

  get isOpen() { return this.open; }
  get overlayOn() { return this.open && this.overlay && this.visible; }
  /** Showing right now (open, following a bot with a fresh digest). */
  get visible() { return this.open && this.follow !== null && this.digest?.id === this.follow; }
  get current(): BrainDigest | null { return this.visible ? this.digest : null; }

  toggle() { this.open = !this.open; this.sync(); }
  toggleOverlay() { this.overlay = !this.overlay; if (!this.open) this.open = true; this.sync(); }

  /** Every snapshot: who we follow (a bot, or null) and the names for `@id`. */
  setFollow(id: number | null, players: { id: number; name: string }[], selfId = 0) {
    this.selfId = selfId;
    if (id !== this.follow) { this.follow = id; this.digest = null; this.lastSig = ''; this.expanded.clear(); }
    for (const p of players) this.names.set(p.id, p.name);
    this.sync();
  }

  setDigest(d: BrainDigest) {
    if (d.id !== this.follow) return;
    this.digest = d;
    this.render();
  }

  private sync() {
    const show = this.visible || (this.open && this.follow !== null);
    this.root.style.display = show ? '' : 'none';
    document.body.classList.toggle('brain-x-open', show);
    if (show && !this.digest) this.root.replaceChildren(el('div', 'bx-wait', 'Reading its mind…'));
    else if (show) this.render();
  }

  private name(id: number) { return id < 0 ? 'the storm' : id === this.selfId && id > 0 ? 'You' : this.names.get(id) ?? `#${id}`; }
  private text(s: string) { return personalize(s, this.selfId, (id) => this.names.get(id) ?? `#${id}`); }

  private render() {
    const d = this.digest;
    if (!d || !this.visible) return;
    const sig = JSON.stringify(d);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.root.replaceChildren(this.head(d), this.now(d), this.scores(d), this.log(d), this.perception(d), this.plans(d), this.state(d),
      el('div', 'bx-foot', `B close · Shift+B overlay ${this.overlay ? 'on' : 'off'} · click a goal for its breakdown`));
  }

  private section(title: string, id: string, ...kids: (HTMLElement | null)[]) {
    const s = el('section', 'bx-sec');
    s.dataset.testid = `bx-${id}`;
    s.append(el('h4', 'bx-h', title), ...kids.filter((k): k is HTMLElement => !!k));
    return s;
  }

  private head(d: BrainDigest) {
    const h = el('div', 'bx-head');
    h.append(el('span', 'bx-title', 'BRAIN'), el('span', 'bx-name', this.name(d.id)), el('span', 'bx-chip', d.arch), el('span', `bx-chip diff-${d.diff}`, d.diff.toUpperCase()));
    return h;
  }

  private now(d: BrainDigest) {
    const goal = el('div', 'bx-goal');
    goal.dataset.testid = 'bx-goal';
    goal.append(el('span', 'bx-goal-name', d.goal.toUpperCase()), el('span', 'bx-arrow', '→'), el('span', 'bx-step', d.step));
    const why = el('div', 'bx-why', this.text(d.why || '…'));
    why.dataset.testid = 'bx-why';
    const meta = el('div', 'bx-meta', `${d.thinking ? 'hesitating · ' : ''}re-thinks in ${d.next.toFixed(1)} s${d.decidedAgo !== null ? ` · decided ${d.decidedAgo.toFixed(1)} s ago` : ''}`);
    return this.section('Now', 'now', goal, why, meta);
  }

  private scores(d: BrainDigest) {
    const box = el('div', 'bx-scores');
    const live = d.scores.filter((s) => s[2] > 0 || s[1] > 0);
    const dead = d.scores.filter((s) => !(s[2] > 0 || s[1] > 0));
    const top = Math.max(0.01, ...live.map((s) => s[1]));
    live.forEach(([goal, score, , f], i) => {
      const row = el('div', `bx-row${goal === d.goal ? ' chosen' : ''}`);
      row.dataset.goal = goal;
      row.title = f.map(([k, v]) => `${k} ${fmt(v)}`).join('\n');
      const bar = el('div', 'bx-bar');
      // Stacked by factor: each positive factor a segment (the bar is the score, best = full width).
      let acc = 0;
      for (const [k, v] of f) {
        if (v <= 0 || k === 'noise' || k === 'sticky') continue;
        const seg = el('i', `seg s${acc++ % 4}`);
        seg.style.width = `${Math.max(0, (100 * v) / top)}%`;
        bar.append(seg);
      }
      if (!acc) { const seg = el('i', 'seg s0'); seg.style.width = `${Math.max(2, (100 * Math.max(0, score)) / top)}%`; bar.append(seg); }
      row.append(el('span', 'bx-g', goal), bar, el('span', 'bx-v', score.toFixed(2)));
      box.append(row);
      if (i < 2 || this.expanded.has(goal)) {
        const fx = el('div', 'bx-fx');
        for (const [k, v] of f) fx.append(el('span', `bx-f ${tone(k, v)}`, `${k} ${fmt(v)}`));
        box.append(fx);
      }
    });
    if (!live.length) box.append(el('div', 'bx-dim', 'No decision yet: it re-scores its goals every ~0.3–1.6 s.'));
    if (dead.length) {
      const z = el('div', 'bx-zero');
      z.append(el('span', 'bx-dim', 'At 0: '), ...dead.map(([g, , , , gate]) => el('span', 'bx-z', gate ? `${g} (${this.text(gate)})` : g)));
      box.append(z);
    }
    return this.section('Scores', 'scores', box);
  }

  private log(d: BrainDigest) {
    const ol = el('ol', 'bx-log');
    for (const [t, from, to, why] of d.log) {
      const li = el('li');
      li.append(el('span', 'bx-t', `${Math.max(0, d.t - t).toFixed(0)}s`), el('span', 'bx-sw', `${from} → ${to}`), el('span', 'bx-lw', this.text(why)));
      ol.append(li);
    }
    return this.section('Log', 'log', d.log.length ? ol : el('div', 'bx-dim', 'No goal switches yet.'));
  }

  private perception(d: BrainDigest) {
    const parts: HTMLElement[] = [];
    if (d.target) {
      const t = el('div', 'bx-target');
      t.append(el('span', 'bx-k', 'Target'), el('b', '', this.name(d.target.id)), el('span', 'bx-dim', ` — ${this.text(d.target.why)}`));
      parts.push(t);
    }
    const ul = el('ul', 'bx-seen');
    for (const [id, age, , , , hp, armed] of d.seen) {
      const li = el('li', age === 0 ? 'now' : '');
      li.append(el('span', 'bx-dot'), el('b', '', this.name(id)), el('span', '', age === 0 ? ' in sight' : ` last seen ${age.toFixed(0)} s ago`),
        el('span', 'bx-dim', ` · ${hp} hp${armed ? ', armed' : ', unarmed'}`));
      ul.append(li);
    }
    parts.push(d.seen.length ? ul : el('div', 'bx-dim', 'Knows of no enemy right now.'));
    if (d.hurt.length) parts.push(el('div', 'bx-hurt', `Shot by: ${d.hurt.map(([id, dmg, ago]) => `${this.name(id)} −${dmg} (${ago.toFixed(0)} s ago)`).join(', ')}`));
    if (d.grudge.length) parts.push(el('div', 'bx-dim', `Grudges: ${d.grudge.map(([id, g]) => `${this.name(id)} ${g}`).join(', ')}`));
    if (d.rivals.length) parts.push(el('div', 'bx-dim', `Rivals: ${d.rivals.map(([id, s]) => `${this.name(id)} ${s.toFixed(2)}`).join(' · ')}`));
    return this.section('Perception', 'perception', ...parts);
  }

  private plans(d: BrainDigest) {
    const ol = el('ol', 'bx-plan');
    d.plan.forEach((s, i) => ol.append(el('li', i < d.planAt ? 'done' : i === d.planAt ? 'cur' : '', this.text(s))));
    const shop = d.shop ? el('div', 'bx-shop', `Shopping: ${d.shop.items.join(', ')} ($${d.shop.cost}) — ${d.shop.why}`) : null;
    const build = d.build ? el('div', 'bx-build', `Building: ${d.build.kind} at (${d.build.x.toFixed(0)}, ${d.build.z.toFixed(0)}) — ${this.text(d.build.why)}`) : null;
    const path = d.path.length > 1 ? el('div', 'bx-dim', `Route: ${d.path.length - 1} waypoint${d.path.length > 2 ? 's' : ''} ahead`) : null;
    return this.section('Plans', 'plans', ol, shop, build, path);
  }

  private state(d: BrainDigest) {
    const s = d.st;
    const grid = el('div', 'bx-stats');
    const stat = (k: string, v: string) => { const c = el('div', 'bx-stat'); c.append(el('span', 'bx-k', k), el('span', 'bx-n', v)); grid.append(c); };
    stat('HP', `${s.hp}`); stat('Shield', `${s.sh}`); stat('Stamina', `${s.sta}${s.winded ? ' (winded)' : ''}`);
    stat('Cash', `$${s.cash}`); stat('Vault', `$${s.vault}`); stat('Gear', `$${s.inv}`);
    stat('Stress', s.stress > 0 ? `${s.stress.toFixed(1)} s` : 'calm'); stat('Aim error', `${s.aimErr.toFixed(1)}°`);
    stat('Reaction', `${s.react.toFixed(2)} s${s.reactLeft > 0 ? ` (${s.reactLeft.toFixed(2)} left)` : ''}`);
    stat('Recoil control', `${Math.round(s.comp * 100)}%`);
    stat('Burst', s.spray === null ? 'full auto' : s.rest > 0 ? `resting ${s.rest.toFixed(2)} s` : `${s.burst[0]}/${s.burst[1]} past ${s.spray} m`);
    const traits = el('div', 'bx-traits');
    TRAIT_KEYS.forEach((k, i) => {
      const t = el('div', 'bx-trait');
      const bar = el('div', 'bx-tbar');
      const fill = el('i');
      fill.style.width = `${d.traits[i]}%`;
      bar.append(fill);
      t.append(el('span', 'bx-k', k), bar);
      traits.append(t);
    });
    return this.section('State', 'state', grid, traits);
  }
}
