import { WEAPONS } from '../../sim/constants';
import { isGunItem } from '../../sim/hotbar';
import type { IslandLayout } from '../../sim/map';
import type { PlayerState, PlayerStats, ShopItem, Snapshot } from '../../sim/types';
import { ISLAND_COLORS } from '../colors';
import { ICONS, type IconKind } from '../icons';
import { ammoWarning, slotAmmoState } from './combatQol';
import { barX, headingDeg, relAngle, yawToward } from './compassMath';
import { LinkHealth, pingLabel, type HostTick } from './netQuality';
import { RecapTracker, SOURCE_LABEL, type Recap } from './recap';
import { awards, fmtLife, summaryOrder } from './summaryData';
import './qol.css';

/**
 * Extra HUD pieces (QoL) layered onto the existing HUD with a couple of hooks from main:
 * compass bar, death recap card, low-ammo warning + hotbar ammo tints, connection indicator,
 * quick re-buy in the shop, and the match summary on the end screen.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const setText = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const show = (e: HTMLElement, on: boolean) => { const d = on ? '' : 'none'; if (e.style.display !== d) e.style.display = d; };

/** Online connection state, written by the session (host) or by 'net' messages (guests). */
export const netStatus: { rtt: (number | null)[]; host: HostTick; online: boolean; isHost: boolean } = { rtt: [], host: 'ok', online: false, isHost: false };

const SPAN = (100 * Math.PI) / 180; // ±100° visible
const HALF_W = 230; // px (bar is 460 wide)
const DANGER_SEC = 3;

/** `x` undefined = never placed yet (so the first place() always writes). */
type Marker = { node: HTMLElement; label?: HTMLElement; x?: number | null };

class Compass {
  readonly root = el('div', 'qol-compass glass');
  private strip = el('div', 'qc-strip');
  private heading = el('div', 'qc-heading');
  private ticks: { node: HTMLElement; deg: number; x?: number | null }[] = [];
  private markers = new Map<string, Marker>();
  private danger: { from: { x: number; z: number }; at: number }[] = [];

  constructor() {
    this.root.dataset.testid = 'compass';
    for (let deg = 0; deg < 360; deg += 15) {
      const card = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[deg];
      const node = el('div', `qc-tick${card ? ' card' : deg % 45 === 0 ? ' mid' : ''}`, card ?? (deg % 45 === 0 ? String(deg) : ''));
      this.strip.append(node);
      this.ticks.push({ node, deg });
    }
    this.root.append(this.strip, this.heading, el('div', 'qc-caret'));
  }

  private marker(key: string, cls: string, label?: string): Marker {
    let m = this.markers.get(key);
    if (!m) {
      const node = el('div', `qc-marker ${cls}`);
      node.dataset.key = key;
      const lab = label !== undefined ? el('span', 'qc-label', label) : undefined;
      if (lab) node.append(lab);
      this.strip.append(node);
      m = { node, label: lab };
      this.markers.set(key, m);
    }
    return m;
  }

  private place(m: { node: HTMLElement; x?: number | null }, x: number | null) {
    const rx = x === null ? null : Math.round(x);
    if (rx === m.x) return;
    m.x = rx;
    if (rx === null) { m.node.style.display = 'none'; return; }
    m.node.style.display = '';
    m.node.style.transform = `translateX(${rx}px)`;
  }

  hurtFrom(pos: { x: number; z: number }, nowMs: number) {
    this.danger.push({ from: { x: pos.x, z: pos.z }, at: nowMs });
    if (this.danger.length > 4) this.danger.shift();
  }

  frame(yaw: number, me: { x: number; z: number } | null, snap: Snapshot | null, map: IslandLayout[], myIsland: number, nowMs: number) {
    setText(this.heading, String(headingDeg(yaw)).padStart(3, '0'));
    for (const t of this.ticks) {
      this.place(t, barX(relAngle((-t.deg * Math.PI) / 180, yaw), SPAN, HALF_W));
      const under = t.x != null && Math.abs(t.x) < 14 && t.deg % 90 !== 0; // the caret covers a number; letters stay
      if (t.node.classList.contains('atcaret') !== under) t.node.classList.toggle('atcaret', under);
    }
    if (!me || !snap) return;
    const labelled: { m: Marker; d: number }[] = [];
    const at = (key: string, p: { x: number; z: number }) => {
      const m = this.markers.get(key)!;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      this.place(m, d < 4 ? null : barX(relAngle(yawToward(me, p), yaw), SPAN, HALF_W));
      if (m.x != null && m.label) labelled.push({ m, d });
    };
    for (const isl of map) {
      if (isl.index === myIsland) {
        this.marker('home', 'home', 'Home');
        at('home', isl.bunker.center);
        continue;
      }
      const owner = snap.players.find((p) => p.island === isl.index);
      if (!owner) continue; // centre island (no owner): marked below
      const key = `isl${isl.index}`;
      const m = this.marker(key, 'island', '');
      m.node.style.setProperty('--c', hex(ISLAND_COLORS[isl.index % 8]));
      const out = owner.eliminated, sealed = !!snap.sealed[isl.index];
      m.node.classList.toggle('out', out);
      m.node.classList.toggle('sealed', sealed && !out);
      setText(m.label!, `${owner.name}${out ? ' · OUT' : sealed ? ' · SEALED' : ''}`);
      at(key, isl.center);
    }
    // Centre island, when the map has one (an island with no owner), and the potion seller(s).
    const owned = new Set(snap.players.map((p) => p.island));
    for (const isl of map) if (!owned.has(isl.index) && isl.index !== myIsland) { this.marker(`mid${isl.index}`, 'island center', 'Center'); at(`mid${isl.index}`, isl.center); }
    (snap.potionShops ?? []).forEach((sh, i) => { this.marker(`pot${i}`, 'potion', 'Potions'); at(`pot${i}`, sh.pos); });
    // Markers in the same direction: only the nearest keeps its label (no overlapping text).
    // Islands (players) win over the potion seller; then the nearer one.
    const rank = (m: Marker) => (m.node.classList.contains('potion') ? 1 : 0);
    labelled.sort((p, q) => rank(p.m) - rank(q.m) || p.d - q.d);
    const taken: number[] = [];
    for (const { m } of labelled) {
      const clash = taken.some((x) => Math.abs(x - m.x!) < 74);
      if (!clash) taken.push(m.x!);
      if (m.node.classList.contains('nolabel') !== clash) m.node.classList.toggle('nolabel', clash);
    }
    this.danger = this.danger.filter((d) => nowMs - d.at < DANGER_SEC * 1000);
    for (let i = 0; i < 4; i++) {
      const m = this.marker(`danger${i}`, 'danger');
      const d = this.danger[i];
      if (!d) { this.place(m, null); continue; }
      m.node.style.opacity = String(1 - (nowMs - d.at) / (DANGER_SEC * 1000));
      this.place(m, barX(relAngle(yawToward(me, d.from), yaw), SPAN, HALF_W) ?? (relAngle(yawToward(me, d.from), yaw) > 0 ? HALF_W : -HALF_W));
    }
  }
}

function recapCard(r: Recap): HTMLElement {
  const card = el('div', 'qol-recap glass');
  card.dataset.testid = 'death-recap';
  const head = el('div', 'qr-head');
  const icon = el('span', 'qr-icon');
  if (r.weapon && Object.hasOwn(ICONS, r.weapon)) icon.innerHTML = ICONS[r.weapon as IconKind];
  else icon.textContent = r.weapon === 'water' ? '≈' : r.weapon === 'fall' ? '↓' : '✕';
  const title = el('div', 'qr-title', r.title);
  head.append(icon, title);
  if (r.killer) {
    const dot = el('span', 'dot');
    dot.style.background = hex(ISLAND_COLORS[r.killer.island % 8]);
    title.prepend(dot);
  }
  card.append(head);
  const facts: string[] = [];
  if (r.weapon && r.killer) facts.push(WEAPON_NAME[r.weapon] ?? r.weapon);
  if (r.distance !== null) facts.push(`${r.distance} m`);
  if (r.headshot) facts.push('Headshot');
  if (facts.length) card.append(el('div', 'qr-facts', facts.join(' · ')));
  if (r.killerHp !== null) {
    const left = el('div', 'qr-left');
    left.dataset.testid = 'recap-killer-hp';
    left.append(el('span', 'qr-k', 'They had'), el('span', 'qr-hp', `${r.killerHp} HP`));
    if (r.killerShield) left.append(el('span', 'qr-sh', `+${r.killerShield} shield`));
    card.append(left);
  }
  if (r.bySource.length) {
    const list = el('div', 'qr-sources');
    list.append(el('div', 'qr-k', 'Damage taken · last 10 s'));
    const max = Math.max(...r.bySource.map((s) => s.amount));
    for (const s of r.bySource) {
      const row = el('div', `qr-src ${s.source}`);
      const bar = el('span', 'qr-bar');
      bar.style.width = `${Math.round((60 * s.amount) / max)}px`;
      row.append(el('span', 'qr-sname', SOURCE_LABEL[s.source]), bar, el('span', 'qr-amt', String(s.amount)));
      list.append(row);
    }
    card.append(list);
  }
  return card;
}

const WEAPON_NAME: Record<string, string> = {
  fists: 'Fists', pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket', grenade: 'Grenade', charge: 'Breach charge',
};
const ITEM_NAME: Record<string, string> = {
  ...WEAPON_NAME, sandbags: 'Sandbags', wood: 'Wood', metal: 'Metal', steel: 'Steel', scaffold: 'Scaffold', ramp: 'Ramp', container: 'Container',
  ammo: 'Ammo', medkit: 'Medkit', shieldSmall: 'Shield S', shieldBig: 'Shield L', healPotion: 'Heal', speedPotion: 'Speed', genUpgrade: 'Generator ↑',
};

function summaryNode(stats: PlayerStats[], snap: Snapshot, humanId: number): HTMLElement {
  const root = el('div', 'qol-summary glass');
  root.dataset.testid = 'match-summary';
  const nameOf = (id: number) => snap.players.find((p) => p.id === id);
  const aw = awards(stats);
  if (aw.length) {
    const row = el('div', 'qs-awards');
    for (const a of aw) {
      const p = nameOf(a.id);
      const chip = el('div', `qs-award ${a.key}`);
      chip.dataset.testid = `award-${a.key}`;
      chip.append(el('div', 'qs-atitle', a.title), el('div', 'qs-aname', p ? (p.id === humanId ? 'You' : p.name) : `#${a.id}`), el('div', 'qs-adetail', a.detail));
      row.append(chip);
    }
    root.append(row);
  }
  const table = el('table');
  const head = el('tr');
  for (const h of ['', 'Player', 'Kills', 'Deaths', 'Damage', 'Seals', 'Built', 'Cash', 'Longest life']) head.append(el('th', '', h));
  table.append(el('thead'));
  table.tHead!.append(head);
  const body = el('tbody');
  for (const s of summaryOrder(stats)) {
    const p = nameOf(s.id);
    const tr = el('tr', s.id === humanId ? 'you' : '');
    tr.dataset.testid = `summary-${s.id}`;
    const dot = el('span', 'dot');
    dot.style.background = hex(ISLAND_COLORS[(p?.island ?? 0) % 8]);
    const dc = el('td');
    dc.append(dot);
    const name = el('td', 'qs-name', p?.name ?? `#${s.id}`);
    if (s.id === humanId) name.append(el('span', 'tagpill you', 'you'));
    tr.append(dc, name, ...[s.kills, s.deaths, s.damage, s.seals, s.built, `$${s.cash}`, fmtLife(s.longestLife)].map((v) => el('td', 'num', String(v))));
    body.append(tr);
  }
  table.append(body);
  root.append(table);
  return root;
}

export type QolActions = { quickBuy(item: ShopItem): void };

export class QolHud {
  private compass = new Compass();
  private recap = new RecapTracker();
  private recapNode: HTMLElement | null = null;
  private ammo = el('div', 'qol-ammo');
  private net = el('div', 'qol-net glass');
  private health = new LinkHealth();
  private summaryKey = '';
  private map: IslandLayout[] = [];
  private humanId = 0;
  private myIsland = 0;
  lastBuy: ShopItem | null = null;

  constructor(private hudRoot: HTMLElement, private act: QolActions, private opts: { online: boolean; isHost: boolean }) {
    this.ammo.dataset.testid = 'ammo-warning';
    this.net.dataset.testid = 'net-indicator';
    show(this.ammo, false);
    show(this.net, false);
    const tc = hudRoot.querySelector('.tc');
    if (tc) tc.prepend(this.compass.root); else { console.warn('[qol] HUD top-centre not found; compass on its own'); hudRoot.append(this.compass.root); }
    hudRoot.append(this.ammo, this.net);
    netStatus.online = opts.online;
    netStatus.isHost = opts.isHost;
  }

  setMap(map: IslandLayout[], humanId: number, island: number) {
    this.map = map;
    this.humanId = humanId;
    this.myIsland = island;
  }

  /** Every applied snapshot (after the HUD's own update). */
  onSnapshot(s: Snapshot, selected: number) {
    const now = performance.now();
    const me = s.players.find((p) => p.id === this.humanId);
    for (const e of s.events) {
      if (e.type !== 'hit' || e.data.target !== this.humanId || typeof e.data.by !== 'number' || e.data.by === this.humanId) continue;
      const by = s.players.find((p) => p.id === e.data.by);
      if (by && !s.hidden?.includes(by.id)) this.compass.hurtFrom(by.pos, now);
    }
    const r = this.recap.onSnapshot(s, this.humanId);
    if (r) this.showRecap(r);
    if (me?.alive && this.recapNode) { this.recapNode.remove(); this.recapNode = null; }
    if (me) this.updateAmmo(me, selected);
    this.updateSummary(s);
  }

  /** Remote snapshot arrival (before buffering): drives the "bad connection" indicator. */
  onNetSnapshot() {
    this.health.onSnapshot(performance.now());
  }

  /** Every frame: compass + connection pill + shop quick-buy button. */
  frame(yaw: number, me: { x: number; z: number } | null, snap: Snapshot | null) {
    const now = performance.now();
    this.compass.frame(yaw, me, snap, this.map, this.myIsland, now);
    this.updateNet(now);
    this.updateQuickBuy();
  }

  private showRecap(r: Recap) {
    this.recapNode?.remove();
    this.recapNode = recapCard(r);
    this.hudRoot.append(this.recapNode);
  }

  private updateAmmo(me: PlayerState, selected: number) {
    const held = me.hotbar[selected] ?? null;
    const a = isGunItem(held) ? me.inv.weapons[held] : undefined;
    const w = me.alive && a && isGunItem(held) ? ammoWarning(a.mag, a.spare, WEAPONS[held].mag, me.reloadUntil > 0) : null;
    show(this.ammo, !!w);
    if (w) { setText(this.ammo, w.text); this.ammo.dataset.kind = w.kind; }
    const slots = this.hudRoot.querySelectorAll<HTMLElement>('.hotbar .hb-slot');
    slots.forEach((node, i) => {
      const k = me.hotbar[i] ?? null;
      const ammo = isGunItem(k) ? me.inv.weapons[k] : undefined;
      const st = ammo ? slotAmmoState(ammo.mag, ammo.spare) : null;
      if ((node.dataset.ammo ?? '') !== (st ?? '')) node.dataset.ammo = st ?? '';
    });
  }

  private updateNet(now: number) {
    if (!this.opts.online) return;
    const myRtt = this.opts.isHost ? null : netStatus.rtt[this.humanId - 1] ?? null;
    const bad = !this.opts.isHost && this.health.bad(now, myRtt);
    const strained = netStatus.host === 'strained';
    const text = bad ? `Connection unstable${myRtt !== null ? ` · ${Math.round(myRtt)} ms` : ''}` : strained ? 'Host tick strained' : '';
    show(this.net, !!text);
    if (text) { setText(this.net, text); this.net.dataset.kind = bad ? 'bad' : 'strained'; }
  }

  private updateQuickBuy() {
    const head = this.hudRoot.querySelector<HTMLElement>('.panel.open[data-kind="shop"] .panel-head, .panel.open[data-kind="potions"] .panel-head');
    if (!head) return;
    let b = head.querySelector<HTMLButtonElement>('.qol-rebuy');
    const item = this.lastBuy;
    const potions = head.closest<HTMLElement>('.panel')?.dataset.kind === 'potions';
    const fits = !!item && (potions ? item.startsWith('shield') || item.endsWith('Potion') : !(item.startsWith('shield') || item.endsWith('Potion')));
    if (!fits) { b?.remove(); return; }
    if (!b) {
      b = el('button', 'btn small qol-rebuy');
      b.dataset.testid = 'quick-buy';
      b.onclick = () => { if (this.lastBuy) this.act.quickBuy(this.lastBuy); };
      head.insertBefore(b, head.lastElementChild);
    }
    setText(b, `↻ ${ITEM_NAME[item!] ?? item}  (B)`);
  }

  private updateSummary(s: Snapshot) {
    const end = this.hudRoot.querySelector<HTMLElement>('.end-screen');
    if (!end || !s.stats || end.style.display !== 'flex') return;
    const key = `${end.dataset.key}`;
    if (key === this.summaryKey && end.querySelector('.qol-summary')) return;
    this.summaryKey = key;
    end.querySelector('.qol-summary')?.remove();
    const node = summaryNode(s.stats, s, this.humanId);
    const buttons = end.querySelector('.end-buttons');
    if (buttons) end.insertBefore(node, buttons); else end.append(node);
  }

  /** Ping column text for the scoreboard. */
  pingFor = (id: number, hostId: number | null): string => pingLabel(netStatus.rtt[id - 1], id === hostId);
}
