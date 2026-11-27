import { generatorSpec } from '../../sim/economy';
import type { IslandLayout } from '../../sim/map';
import type { Snapshot } from '../../sim/types';
import type { Cue } from '../audio/events';
import { settings } from '../settings/store';
import { BunkerWatch, GenWatch, blockedByOthers, doorsText, enemiesOnIsland, genAlertText } from './alerts';
import { relAngle, yawToward } from './compassMath';

/**
 * Bunker-threat warning (doorways blocked + arrow home), "Bunker reopened" / generator toasts and the
 * compact home-island panel under the cash display. Sounds go out through `play` (the audio engine,
 * which applies the master / effects / mute settings).
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const setText = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };
const show = (e: HTMLElement, on: boolean) => { const d = on ? '' : 'none'; if (e.style.display !== d) e.style.display = d; };

const TOAST_MS = 3200;

export class AlertHud {
  private doors = el('div', 'qol-doors');
  private doorsArrow = el('span', 'qd-arrow', '↑');
  private doorsLabel = el('span', 'qd-text');
  private reopened = el('div', 'qol-reopened', 'Bunker reopened');
  private home = el('div', 'qol-home');
  private homeGen = el('span', 'qh-gen');
  private homeFill = el('i', 'qh-fill');
  private homeVault = el('span', 'qh-vault');
  private homeLv = el('span', 'qh-lv');
  private homeThreat = el('span', 'qh-threat', '⚠');
  private genToast = el('div', 'qol-gentoast');
  private bunker = new BunkerWatch();
  private gen = new GenWatch();
  private reopenedUntil = 0;
  private genToastUntil = 0;
  private map: IslandLayout[] = [];
  private humanId = 0;
  private count = 0;
  private live = false;

  constructor(hudRoot: HTMLElement, private play: (cue: Cue) => void) {
    this.doors.dataset.testid = 'doors-warning';
    this.reopened.dataset.testid = 'bunker-reopened';
    this.home.dataset.testid = 'home-panel';
    this.genToast.dataset.testid = 'gen-toast';
    this.homeThreat.title = 'Enemy on your island';
    this.homeVault.title = 'Banked cash: safe when you die';
    this.doors.append(this.doorsArrow, this.doorsLabel);
    const bar = el('span', 'qh-bar');
    bar.append(this.homeFill);
    // Generator level next to the generator, vault level next to the vault (one "Lv" read as the vault's).
    this.home.append(el('span', 'qh-k', 'Home'), this.homeGen, this.homeLv, bar, this.homeVault, this.homeThreat);
    for (const n of [this.doors, this.reopened, this.home, this.genToast, this.homeThreat]) show(n, false);
    const tl = hudRoot.querySelector('.tl');
    if (tl) tl.append(this.home, this.genToast);
    else { console.warn('[alerts] HUD top-left not found; home panel on its own'); hudRoot.append(this.home, this.genToast); }
    hudRoot.append(this.doors, this.reopened);
  }

  private ownId = 0;

  /** Spectating someone: their home's alerts (a followed bot counts; our own bot-run seat doesn't). */
  setViewed(id: number) {
    if (id === this.humanId) return;
    this.humanId = id;
    this.bunker.reset();
    this.gen.reset();
  }

  setMap(map: IslandLayout[], humanId: number) {
    this.map = map;
    this.humanId = humanId;
    this.ownId = humanId;
    this.bunker.reset();
    this.gen.reset();
  }

  /** Blocked doorways right now (the compass pulses your home marker while > 0). */
  get threat(): number { return this.live ? this.count : 0; }

  onSnapshot(s: Snapshot) {
    const now = performance.now();
    const me = s.players.find((p) => p.id === this.humanId);
    const isl = me ? this.map[me.island] : undefined;
    this.live = !!me && (!me.isBot || me.id !== this.ownId) && !me.eliminated && s.winner === null && !!isl;
    if (!me || !isl || !this.live) {
      for (const n of [this.doors, this.reopened, this.home, this.genToast]) show(n, false);
      return;
    }

    // ---- bunker doorways ----
    this.count = Math.max(0, Math.min(3, me.doorsBlocked ?? 0));
    const a = this.bunker.update(this.count, blockedByOthers(s, me.id), now);
    if (a?.kind === 'alarm') {
      this.play({ sound: 'alarm', kind: String(a.count), pos: null, gain: a.count >= 2 ? 0.75 : 0.5 });
      console.info(`[alerts] bunker ${a.count}/3 doorways blocked`);
    } else if (a?.kind === 'reopened') {
      this.reopenedUntil = now + TOAST_MS;
      console.info('[alerts] bunker reopened');
    }
    setText(this.doorsLabel, doorsText(this.count));
    this.doors.dataset.level = String(this.count);
    show(this.doors, this.count > 0 && this.count < 3);
    show(this.reopened, now < this.reopenedUntil && this.count < 3);

    // ---- home generator / vault ----
    const g = s.generators.find((x) => x.island === me.island);
    const lv = s.genLevels?.[me.island] ?? 1;
    const cap = generatorSpec(lv).cap;
    const stored = Math.floor(g?.stored ?? 0);
    const pct = Math.min(100, Math.round((100 * stored) / cap));
    setText(this.homeGen, `$${stored}`);
    this.homeFill.style.width = `${pct}%`;
    this.home.classList.toggle('full', stored >= cap);
    // Vault level only once it's been upgraded (Lv1 next to "Gen Lv1" read as noise).
    setText(this.homeVault, `Vault $${Math.floor(me.vault.cash)}${(me.vaultLevel ?? 1) > 1 ? ` · Lv${me.vaultLevel}` : ''}`);
    setText(this.homeLv, `Gen Lv${lv}`);
    this.home.title = `Generator ${pct}% full`;
    const enemies = enemiesOnIsland(s, me, isl);
    show(this.homeThreat, enemies > 0);
    show(this.home, true);
    if (g) {
      const ga = this.gen.update(g.stored, lv, settings.get().gameplay.genAlertPct, now);
      if (ga) {
        setText(this.genToast, genAlertText(ga));
        this.genToastUntil = now + TOAST_MS;
        this.play({ sound: 'ping', pos: null, gain: 0.45 });
        console.info(`[alerts] ${genAlertText(ga)}`);
      }
    }
    show(this.genToast, now < this.genToastUntil);
  }

  /** Every frame: point the warning's arrow at your bunker. */
  frame(yaw: number, me: { x: number; z: number } | null, myIsland: number) {
    if (!me || this.doors.style.display === 'none') return;
    const b = this.map[myIsland]?.bunker.center;
    if (!b) return;
    const near = Math.hypot(b.x - me.x, b.z - me.z) < 4;
    const deg = Math.round((relAngle(yawToward(me, b), yaw) * 180) / Math.PI);
    const tf = `rotate(${deg}deg)`;
    if (this.doorsArrow.style.transform !== tf) this.doorsArrow.style.transform = tf;
    show(this.doorsArrow, !near);
  }
}
