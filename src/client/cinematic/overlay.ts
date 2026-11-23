import type { ShotReason } from './interest';

const TAG: Record<ShotReason, string> = {
  duel: 'DUEL', clutch: 'CLUTCH', seal: 'SEAL', hunt: 'HUNTED', rocket: 'ROCKET', parkour: 'ON THE MOVE',
  leader: 'LEADER', elimination: 'KILL', suddenDeath: 'SUDDEN DEATH', idle: 'LIVE',
};
const WEAPON: Record<string, string> = { fists: 'Fists' };

export type OverlayPlayer = { id: number; name: string; hp: number; shield: number; equipped: string; kills: number; alive: boolean };

/**
 * Broadcast lower third for cinematic mode: featured player's name, HP / shield and weapon, the storyline tag,
 * and how many are left. Updated at most ~5 Hz; DOM writes only when text changes.
 */
export class CinematicOverlay {
  readonly root = document.createElement('div');
  private name = document.createElement('div');
  private tag = document.createElement('span');
  private hp = document.createElement('div');
  private hpFill = document.createElement('i');
  private shFill = document.createElement('i');
  private info = document.createElement('div');
  private alive = document.createElement('div');
  private last = 0;

  constructor(parent: HTMLElement) {
    this.root.className = 'cine-l3';
    this.root.dataset.testid = 'cinematic-overlay';
    this.root.hidden = true;
    this.tag.className = 'cine-tag';
    this.name.className = 'cine-name';
    this.hp.className = 'cine-hp';
    this.hpFill.className = 'cine-hp-fill';
    this.shFill.className = 'cine-sh-fill';
    this.hp.append(this.hpFill, this.shFill);
    this.info.className = 'cine-info';
    this.alive.className = 'cine-alive';
    this.alive.dataset.testid = 'cinematic-alive';
    const card = document.createElement('div');
    card.className = 'cine-card glass';
    const head = document.createElement('div');
    head.className = 'cine-head';
    head.append(this.tag, this.name);
    card.append(head, this.hp, this.info);
    const hint = document.createElement('div');
    hint.className = 'cine-hint';
    hint.textContent = 'CINEMATIC · N or Esc to exit';
    this.root.append(card, this.alive, hint);
    parent.append(this.root);
  }

  show(on: boolean) { this.root.hidden = !on; }

  update(now: number, p: OverlayPlayer | undefined, reason: ShotReason | undefined, alive: number) {
    if (now - this.last < 200) return;
    this.last = now;
    set(this.alive, `${alive} ALIVE`);
    if (!p) { set(this.name, '—'); return; }
    set(this.name, p.name);
    set(this.tag, reason ? TAG[reason] : 'LIVE');
    const hp = `${Math.max(0, Math.min(100, p.hp))}%`, sh = `${Math.max(0, Math.min(100, p.shield))}%`;
    if (this.hpFill.style.width !== hp) this.hpFill.style.width = hp;
    if (this.shFill.style.width !== sh) this.shFill.style.width = sh;
    const w = WEAPON[p.equipped] ?? p.equipped[0].toUpperCase() + p.equipped.slice(1);
    set(this.info, p.alive ? `${Math.ceil(p.hp)} HP${p.shield > 0 ? ` · ${Math.ceil(p.shield)} shield` : ''} · ${w} · ${p.kills} kill${p.kills === 1 ? '' : 's'}` : 'DOWN');
  }

  destroy() { this.root.remove(); }
}

function set(el: HTMLElement, text: string) { if (el.textContent !== text) el.textContent = text; }
