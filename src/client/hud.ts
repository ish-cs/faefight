import { CHARGE, ECONOMY, FLASH, GENERATOR_MAX_LEVEL, GRAPPLE, GRENADE, SMOKE, LIFECYCLE, MEDKIT, PIECES, POTIONS, SHIELD_MAX, TRAP, WEAPONS } from '../sim/constants';
import { elimView } from './elimBanner';
import { ammoPerBox, ammoPrice, ammoTarget, generatorSpec, genUpgradePrice, isHomeOnly, lockItem, lockPrice, lockedGunOf } from '../sim/economy';
import { grappleRange, type CenterIsland, type IslandLayout } from '../sim/map';
import { HOTBAR_SIZE, POTION_KINDS, canAdd, countOf, isGunItem, isHotbarItem, isPieceItem, isPotionItem } from '../sim/hotbar';
import type { BotBrainInfo, GunKind, HotbarItem, Inventory, MatchEvent, PieceKind, PlayerState, ShopItem, Snapshot, VaultAction, WeaponKind } from '../sim/types';
import { dist2D } from '../sim/vec';
import { PIECE_ORDER } from './input';
import { STAMINA } from '../sim/movement';
import { islandColor, islandName } from './colors';
import { endState } from './endState';
import { insideBunker } from '../sim/bots/nav';
import { ICONS, LOCK_ICON, iconGroup, type IconKind } from './icons';
import { chipState } from './chipState';
import { dragOutcome } from './hotbarDrag';
import { ITEM_NAMES as SHORT, VaultPanel } from './vaultPanel';
import { bankAboveLoadout, funds, vaultSpec } from '../sim/vault';
import { SEALED_OUTSIDE_TEXT } from './qol/alerts';
import { FEED_FADE_MS, FEED_LIFE_MS, FeedList, feedEntries, feedText, type FeedEntry, type FeedMarker } from './qol/killFeed';

/** Why someone is out (the sim's `eliminated` event reason), for the kill feed. */
const ELIM_WHY: Record<string, string> = { sealed: ': bunker sealed', trapped: ': trapped in sealed bunker', suddenDeath: ': sudden death' };

const MARK_GLYPH: Record<FeedMarker, string> = { headshot: '◎', explosion: '✸', fall: '↓', water: '≈', storm: '≋', lightning: 'ϟ' };

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const;
/** Carried cash at which the HUD warns it would drop on death. */
const CARRY_WARN = 150;
const LABEL: Record<string, string> = {
  fists: 'Fists', pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket launcher',
  sandbags: 'Sandbags', wood: 'Wood barricade', metal: 'Sheet metal', steel: 'Steel plate', scaffold: 'Scaffold',
  ramp: 'Ramp', container: 'Container', ammo: 'Ammo box', grenade: 'Grenade', charge: 'Breach charge', medkit: 'Medkit', trap: 'Spike trap',
  smoke: 'Smoke grenade', flash: 'Flashbang',
  shieldSmall: 'Small shield potion', shieldBig: 'Big shield potion', healPotion: 'Heal potion', speedPotion: 'Speed potion',
  grapple: 'Grappling hook',
};

function supplyPrompt(c: Snapshot['center']): string {
  if (!c || c.bags + c.steel === 0) return 'Supplies: restocking…';
  const parts = [c.bags ? `${c.bags} sandbags` : '', c.steel ? `${c.steel} steel` : ''].filter(Boolean);
  return `E  Take ${parts.join(' + ')}`;
}

/**
 * Shop price; a generator upgrade's depends on your generator's level (0 once maxed); an ammo box costs
 * what the gun it would fill takes (rockets are dearer).
 */
function priceOf(item: ShopItem, genLevel = 1, me?: PlayerState | null): number {
  if (item === 'genUpgrade') return genUpgradePrice(genLevel) ?? 0;
  const locks = lockedGunOf(item);
  if (locks) return lockPrice(locks);
  if ((GUNS as readonly string[]).includes(item)) return WEAPONS[item as WeaponKind].price;
  if (item in PIECES) return PIECES[item as PieceKind].price;
  if (item === 'ammo') return ammoPrice(me ? ammoTarget(me) : undefined);
  if (item === 'grenade') return GRENADE.price;
  if (item === 'medkit') return MEDKIT.price;
  if (item === 'trap') return TRAP.price;
  if (item === 'smoke') return SMOKE.price;
  if (item === 'flash') return FLASH.price;
  if (isPotionItem(item)) return POTIONS[item].price;
  return CHARGE.price;
}

/** Tiny name under each shop icon. */
function shortOf(item: ShopItem): string {
  if (item === 'genUpgrade') return 'Generator';
  if (item === 'ammo') return 'Ammo';
  const g = lockedGunOf(item);
  return g ? `Lock ${SHORT[g]}` : SHORT[item as HotbarItem] ?? item;
}

/** This map's hook reach for the shop text (set with the map). */
let hookRange: number = GRAPPLE.range;

/** Shop info-bar text: what the item is and does, beyond its name. */
function detailsOf(item: ShopItem, price: number, genLevel: number, me: PlayerState): string {
  const name = labelOf(item);
  const gun = lockedGunOf(item);
  if (gun) return `Lock ${LABEL[gun]}: you respawn with it after dying · ${Math.round(lockPrice(gun) / WEAPONS[gun].price)}× the gun's price · $${price}`;
  if (item === 'genUpgrade') {
    if (genLevel >= GENERATOR_MAX_LEVEL) return `Generator Lv${genLevel}: fully upgraded`;
    const now = generatorSpec(genLevel), next = generatorSpec(genLevel + 1);
    return `Generator Lv${genLevel} → Lv${genLevel + 1}: $${now.rate}/s → $${next.rate}/s, holds $${next.cap} · $${price}`;
  }
  if ((GUNS as readonly string[]).includes(item)) {
    const w = WEAPONS[item as WeaponKind];
    return `${name} · ${w.dmg}${w.pellets > 1 ? `×${w.pellets}` : ''} dmg · ${w.rps}/s · mag ${w.mag} · $${price}`;
  }
  if (item in PIECES) return `${name} · ${PIECES[item as PieceKind].hp} HP wall · $${price} (Shift+click buys 5)`;
  if (item === 'ammo') {
    const g = ammoTarget(me);
    return g ? `Ammo box · +${ammoPerBox(g)} rounds for your ${LABEL[g]} · $${price}` : 'Ammo box · equip a gun first';
  }
  if (item === 'grenade') return `Grenade · ${GRENADE.dmg} dmg in a ${GRENADE.radius} m blast · $${price}`;
  if (item === 'smoke') return `Smoke grenade · a ${SMOKE.radius} m cloud for ${SMOKE.lifeSec}s nobody sees through · carry ${SMOKE.maxCarry} · $${price}`;
  if (item === 'flash') return `Flashbang · blinds whoever faces it within ${FLASH.range} m (never you) · carry ${FLASH.maxCarry} · $${price}`;
  if (item === 'charge') return `Breach charge · cracks walls and sealed doors · $${price}`;
  if (item === 'grapple') return `Grappling hook · ${GRAPPLE.uses} uses · ${Math.round(hookRange)} m · hook a wall to swing to it, a player to yank them to you · Space lets go · $${price}`;
  if (item === 'trap') return `Spike trap · set on a floor or wall; ${TRAP.dmg} dmg to enemies who step in, never you · max ${TRAP.maxPerPlayer} out · $${price}`;
  if (item === 'medkit') return `Medkit · heals ${MEDKIT.heal} HP over ${MEDKIT.useSec}s · $${price}`;
  return `${name} · $${price}`;
}

function labelOf(item: ShopItem): string {
  if (item === 'genUpgrade') return 'Generator ↑';
  const g = lockedGunOf(item);
  return g ? `Lock ${LABEL[g]}` : LABEL[item];
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Set text only when it changed (HUD updates at 30 Hz; avoid needless layout). */
const setText = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const fmtClock = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};


export type HudContext = {
  /** Locally selected hotbar slot (sent to the sim every input). */
  selected: number;
  ghostOk: boolean | null;
  /** Why the ghost is red ("too far", "needs support", "blocked") or what it snapped to; shown after the build hint. */
  buildNote?: string | null;
  /** Holding a spike trap: the hint line (count, where, why not); null/absent otherwise. */
  trapHint?: string | null;
  free: boolean;
  /** I (inventory) mode: pointer released so slots can be dragged. */
  inventory: boolean;
  /** Crosshair gap (px) from the current spread cone; reload progress 0..1 or null; rifle scope up. */
  spreadPx?: number;
  reload?: number | null;
  scoped?: boolean;
  /** Your predicted stamina (client prediction; null/absent = the snapshot's). */
  stamina?: number | null;
  /** Spectating: the player whose HUD to show instead of yours (null = yours). */
  viewId?: number | null;
};
export type HudActions = {
  /** `bulk`: Shift+click (buy several of a building piece). */
  buy(item: ShopItem, bulk?: boolean): void; vault(a: VaultAction): void; closePanel(): void; backToMenu(): void;
  /** Hotbar slot clicked. */
  select(slot: number): void;
  /** Hotbar slot dragged onto another. */
  moveSlot(from: number, to: number): void;
  /** Hotbar slot dragged out over the game view: drop it (the sim's drop action). */
  dropSlot?(slot: number, amount: 'one' | 'stack'): void;
  /** End-screen buttons (default: Back to menu). over = the match has a result (not just you eliminated). */
  endButtons?(over: boolean): HTMLElement[];
};

export class Hud {
  readonly root = el('div', 'hud');
  private map: IslandLayout[] = [];
  private centerIsland: CenterIsland | null = null;
  /** When sudden death starts this match (the host's setting, from MapDef.settings). */
  suddenDeathAt: number = LIFECYCLE.suddenDeathAt;
  /** Host's generator speed multiplier (shop label shows the real rate). */
  genMult = 1;
  private humanId = 0;
  /** Whose view the HUD shows (viewed.ts): hit markers, damage flash, storm vignette. */
  private viewId = 0;
  private me: PlayerState | null = null;
  private snap: Snapshot | null = null;
  private feed = new FeedList<HTMLElement>();

  private hp = el('div', 'hp');
  private hpFill = el('div', 'hp-fill');
  private hpText = el('div', 'hp-text');
  private shield = el('div', 'shield');
  private shieldFill = el('div', 'shield-fill');
  private shieldText = el('div', 'shield-text');
  private lastShield = 0;
  private lastCash = 0;
  /** Shop card under the pointer/focus: its info-bar text refreshes live. */
  private shopHover: HTMLElement | null = null;
  private buffs = el('div', 'buffs');
  private speedBuff = el('div', 'buff speed');
  private drinkBox = el('div', 'heal drink');
  private drinkFill = el('div', 'heal-fill');
  private cash = el('div', 'cash');
  private gen = el('div', 'gen');
  private prompt = el('div', 'prompt');
  private weapon = el('div', 'weapon');
  private extras = el('div', 'extras');
  private hotbar = el('div', 'hotbar');
  private heal = el('div', 'heal');
  private healFill = el('div', 'heal-fill');
  private hotbarSig = '';
  /** Items in the shown hotbar (drag-out drops). */
  private hotbarItems: (HotbarItem | null)[] = [];
  private dragFrom: number | null = null;
  private timer = el('div', 'timer');
  private seals = el('div', 'seals');
  private banner = el('div', 'banner');
  private sealedBanner = el('div', 'sealed-banner', 'YOUR BUNKER IS SEALED');
  /** Sudden death: a big STORM warning for a few seconds, and a storm-coloured screen edge while outside the ring. */
  private stormWarn = el('div', 'storm-warn', 'STORM');
  /** "ELIMINATED by X" for everyone (elimination credit, sim/elimination.ts); gold when it's the viewed player's. */
  private elimBanner = el('div', 'elim-banner');
  private elimBannerUntil = 0;
  private stormVignette = el('div', 'storm-vignette');
  /** Red edges at low HP (the viewed player's: yours, or whoever you spectate). */
  private lowHp = el('div', 'lowhp-vignette');
  /** Whose shop / vault the panel shows: you, or (read-only mirror) the human you spectate. */
  private panelMe: PlayerState | null = null;
  private mirroring = false;
  /** Shop item under the pointer (sent to spectators of you). */
  private hoverItem: ShopItem | null = null;
  private stormWarnUntil = 0;
  /** Sudden death's one seal announcement, a hazard plate under the STORM warning (event 'allSealed'). */
  private allSealed = el('div', 'storm-warn-seal');
  private killfeed = el('div', 'killfeed');
  private center = el('div', 'center-msg');
  private crosshair = el('div', 'crosshair');
  private reloadRing = el('div', 'reload-ring');
  /** Throw charge meter around the crosshair (setThrowCharge); hidden unless a throw is being charged. */
  private chargeRing = el('div', 'charge-ring');
  private chargeShown = -2;
  private scope = el('div', 'scope');
  private damage = el('div', 'damage-flash');
  private endScreen = el('div', 'end-screen');
  private fps = el('div', 'fps');
  /** Shift+F3 perf detail under the counter (frame/GPU ms, draw calls, triangles, governor rung). */
  private fpsDetail = el('div', 'fps-detail');
  private stamina = el('div', 'stamina');
  private staminaFill = el('div', 'stamina-fill');
  private staminaText = el('div', 'stamina-text');
  private exhausted = false;
  /** "Spectating NAME" tag over the followed player's HUD. */
  private watchTag = el('div', 'watch-tag');
  private brain = el('div', 'brain-panel glass');
  private brainSig = '';
  private panel = el('div', 'panel');
  private panelKind: 'shop' | 'potions' | 'vault' | null = null;
  private vaultPanel = new VaultPanel(this.panel, (a) => this.act.vault(a));
  /** Under the cash: a warning when a lot is carried (it drops on death; the home strip already shows the vault). */
  private bankNote = el('div', 'bank-note');

  constructor(parent: HTMLElement, private act: HudActions) {
    this.hp.append(this.hpFill, this.hpText);
    const tl = el('div', 'tl');
    tl.append(this.cash, this.bankNote, this.gen);
    this.bankNote.dataset.testid = 'bank-note';
    this.shield.append(this.shieldFill, el('div', 'shield-segs'), this.shieldText);
    this.shield.dataset.testid = 'shield';
    this.speedBuff.innerHTML = ICONS.speedPotion;
    this.speedBuff.append(el('span', 'buff-time'));
    this.speedBuff.dataset.testid = 'speed-buff';
    this.buffs.append(this.speedBuff);
    const bl = el('div', 'bl');
    this.stamina.append(this.staminaFill, this.staminaText);
    this.stamina.dataset.testid = 'stamina';
    this.watchTag.dataset.testid = 'watch-tag';
    this.brain.dataset.testid = 'brain-panel';
    this.brain.style.display = 'none';
    // perf detail sits in the bottom-left column above the bars: never under the kill feed / notifications
    bl.append(this.fpsDetail, this.watchTag, this.buffs, this.shield, this.hp, this.stamina);
    const br = el('div', 'br');
    br.append(this.weapon, this.extras);
    const tc = el('div', 'tc');
    tc.append(this.timer, this.seals, this.banner);
    this.weapon.dataset.testid = 'weapon';
    this.cash.dataset.testid = 'cash';
    this.hotbar.dataset.testid = 'hotbar';
    this.heal.dataset.testid = 'healing';
    this.heal.append(el('div', 'heal-label', 'Healing…'), el('div', 'heal-bar'));
    (this.heal.lastChild as HTMLElement).append(this.healFill);
    this.drinkBox.dataset.testid = 'drinking';
    this.drinkBox.append(el('div', 'heal-label', 'Drinking…'), el('div', 'heal-bar'));
    (this.drinkBox.lastChild as HTMLElement).append(this.drinkFill);
    this.panel.dataset.testid = 'panel';
    this.buildHotbar();
    // Four ticks that open with the spread cone, plus the hitmarker X.
    for (const c of ['t', 'b', 'l', 'r', 'hm']) this.crosshair.append(el('i', c));
    this.crosshair.dataset.testid = 'crosshair';
    this.reloadRing.dataset.testid = 'reload-ring';
    this.chargeRing.dataset.testid = 'charge-ring';
    this.chargeRing.style.display = 'none';
    this.fps.dataset.testid = 'fps';
    this.fpsDetail.dataset.testid = 'fps-detail';
    this.fpsDetail.style.display = 'none';
    this.scope.dataset.testid = 'scope';
    this.stormWarn.dataset.testid = 'storm-warn';
    this.stormWarn.append(el('div', 'storm-warn-sub', 'Sudden death · get inside the ring'));
    this.allSealed.dataset.testid = 'all-sealed';
    this.allSealed.innerHTML = LOCK_ICON;
    this.allSealed.append(el('span', 'sws-text', 'ALL BUNKERS SEALED'));
    this.allSealed.style.display = 'none';
    this.stormWarn.append(this.allSealed);
    this.stormVignette.dataset.testid = 'storm-vignette';
    this.elimBanner.dataset.testid = 'elim-banner';
    this.lowHp.dataset.testid = 'lowhp-vignette';
    this.root.append(tl, bl, br, tc, this.hotbar, this.heal, this.drinkBox, this.prompt, this.killfeed, this.scope, this.crosshair, this.reloadRing, this.chargeRing, this.center,
      this.sealedBanner, this.stormVignette, this.lowHp, this.stormWarn, this.elimBanner, this.damage, this.endScreen, this.fps, this.panel, this.brain);
    parent.append(this.root);
  }

  setMap(map: IslandLayout[], humanId: number, humanIsland: number, center: CenterIsland | null = null) {
    this.map = map;
    hookRange = grappleRange(map);
    this.centerIsland = center;
    this.humanId = humanId;
    this.seals.replaceChildren(...map.map((isl) => {
      const chip = el('div', 'seal-chip');
      const dot = el('span', 'dot');
      dot.style.background = hex(islandColor(isl.index));
      chip.append(dot, el('span', 'name', isl.index === humanIsland ? 'You' : islandName(isl.index)), el('span', 'state', 'OPEN'));
      return chip;
    }));
  }

  private buildHotbar() {
    const slots = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
      const s = el('div', 'hb-slot empty');
      s.dataset.slot = String(i);
      s.dataset.testid = `hotbar-slot-${i}`;
      const lock = el('span', 'hb-lock');
      lock.innerHTML = LOCK_ICON;
      lock.title = 'Locked: you respawn with it';
      const ammo = el('span', 'hb-ammo');
      ammo.append(el('i'));
      s.append(el('span', 'hb-prog'), el('span', 'hb-key', String(i + 1)), el('span', 'hb-icon'), el('span', 'hb-name'), el('span', 'hb-count'), ammo, lock);
      return s;
    });
    this.hotbar.replaceChildren(...slots);
    const slotAt = (t: EventTarget | null) => {
      const s = t instanceof Element ? t.closest<HTMLElement>('.hb-slot') : null;
      return s ? Number(s.dataset.slot) : null;
    };
    // Dragging out of the bar over the game view drops the item (a "Drop" tag follows the pointer).
    const hint = el('div', 'drag-drop-hint', 'Drop');
    hint.dataset.testid = 'drag-drop-hint';
    this.root.append(hint);
    const where = (x: number, y: number) => {
      const t = document.elementFromPoint(x, y);
      const onBar = !!t?.closest('.hotbar');
      return { slot: slotAt(t), onBar, overGame: !!t && !onBar && !t.closest('.panel, .chat, .chat-ui, button, input, textarea, .overlay, .menu, .end-screen, .brain-panel') };
    };
    const clearDrag = () => {
      this.dragFrom = null;
      this.hotbar.classList.remove('dragging', 'drop-out');
      hint.classList.remove('on');
      slots.forEach((s) => s.classList.remove('drag-src', 'drag-over'));
    };
    window.addEventListener('pointermove', (e) => {
      if (this.dragFrom === null) return;
      const w = where(e.clientX, e.clientY);
      const out = dragOutcome(this.dragFrom, w, e.shiftKey, !this.hotbarItems[this.dragFrom]).kind === 'drop';
      this.hotbar.classList.toggle('drop-out', out);
      hint.classList.toggle('on', out);
      if (out) {
        const item = this.hotbarItems[this.dragFrom];
        setText(hint, e.shiftKey || !item || isGunItem(item) ? `Drop ${item ? SHORT[item] : ''}` : `Drop ${SHORT[item]} (all · Shift: 1)`);
        hint.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
      }
    });
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && this.dragFrom !== null) clearDrag(); });
    // No pointerup will come (touch/pen cancel, window lost focus): drop the drag so the "Drop" tag can't stick.
    window.addEventListener('pointercancel', () => { if (this.dragFrom !== null) clearDrag(); });
    window.addEventListener('blur', () => { if (this.dragFrom !== null) clearDrag(); });
    this.hotbar.addEventListener('pointerdown', (e) => {
      const i = slotAt(e.target);
      if (i === null || e.button !== 0) return;
      e.preventDefault();
      this.dragFrom = i;
      this.hotbar.classList.add('dragging');
      slots[i].classList.add('drag-src');
    });
    this.hotbar.addEventListener('pointerover', (e) => {
      if (this.dragFrom === null) return;
      const i = slotAt(e.target);
      slots.forEach((s, j) => s.classList.toggle('drag-over', j === i && j !== this.dragFrom));
    });
    window.addEventListener('pointerup', (e) => {
      const from = this.dragFrom;
      if (from === null) return;
      const r = dragOutcome(from, where(e.clientX, e.clientY), e.shiftKey, !this.hotbarItems[from]);
      clearDrag();
      if (r.kind === 'select') this.act.select(r.slot);
      else if (r.kind === 'move') this.act.moveSlot(r.from, r.to);
      else if (r.kind === 'drop') this.act.dropSlot?.(r.slot, r.amount);
    });
  }

  private updateHotbar(me: PlayerState, ctx: HudContext, now: number) {
    const inv = me.inv;
    const reloading = me.reloadUntil > 0;
    this.updateHotbarProgress(me, ctx.selected, now);
    this.hotbarItems = me.hotbar;
    const sig = JSON.stringify([me.hotbar, { ...inv, cash: 0 }, ctx.selected, reloading, me.locked]);
    this.hotbar.classList.toggle('editing', ctx.inventory);
    this.hotbar.dataset.ghost = ctx.ghostOk === null ? 'none' : ctx.ghostOk ? 'ok' : 'blocked';
    if (sig === this.hotbarSig) return;
    this.hotbarSig = sig;
    Array.from(this.hotbar.children).forEach((node, i) => {
      const s = node as HTMLElement;
      const k = me.hotbar[i] ?? null;
      s.dataset.item = k ?? '';
      s.classList.toggle('empty', !k);
      s.classList.toggle('selected', i === ctx.selected);
      const icon = s.querySelector('.hb-icon') as HTMLElement;
      if (icon.dataset.kind !== (k ?? '')) { icon.dataset.kind = k ?? ''; icon.innerHTML = k ? ICONS[k] : ''; }
      s.dataset.cat = k ? iconGroup(k) : '';
      s.classList.toggle('locked', isGunItem(k) && me.locked.includes(k));
      setText(s.querySelector('.hb-name') as HTMLElement, k ? SHORT[k] : '');
      let count = '';
      const bar = (s.querySelector('.hb-ammo i') as HTMLElement);
      if (k && isGunItem(k)) {
        const a = inv.weapons[k];
        // Mag only: the full mag/spare readout is the big ammo box bottom-right.
        count = a ? `${a.mag}` : '';
        // Magazine gauge: how full the mag is; amber when low, red when empty.
        const frac = a ? Math.max(0, Math.min(1, a.mag / WEAPONS[k].mag)) : 0;
        bar.style.width = `${Math.round(frac * 100)}%`;
        s.dataset.ammo = !a || a.mag === 0 ? 'empty' : frac <= 0.25 ? 'low' : 'ok';
        s.classList.toggle('reloading', reloading && i === ctx.selected);
      } else {
        if (k) count = String(countOf(inv, k));
        s.classList.remove('reloading');
        delete s.dataset.ammo;
      }
      s.classList.toggle('stack', !!k && !isGunItem(k));
      setText(s.querySelector('.hb-count') as HTMLElement, count);
    });
  }

  /**
   * Live progress overlays (fill rising from the bottom of the slot): reload on the gun in hand,
   * medkit use, potion drinking.
   */
  private updateHotbarProgress(me: PlayerState, selected: number, now: number) {
    let slot = -1, p = 0;
    if (me.alive && me.reloadUntil > 0 && me.reloadSec > 0) {
      slot = selected; p = 1 - (me.reloadUntil - now) / me.reloadSec;
    } else if (me.alive && me.healAt != null) {
      slot = me.hotbar.indexOf('medkit'); p = 1 - (me.healAt - now) / MEDKIT.useSec;
    } else if (me.alive && me.drinking) {
      slot = me.hotbar.indexOf(me.drinking.kind); if (slot < 0) slot = selected;
      p = 1 - (me.drinking.doneAt - now) / POTIONS[me.drinking.kind].useSec;
    }
    p = Math.max(0, Math.min(1, p));
    Array.from(this.hotbar.children).forEach((node, i) => {
      const s = node as HTMLElement;
      const on = i === slot;
      s.classList.toggle('busy', on);
      const bar = s.firstChild as HTMLElement;
      const h = on ? `${Math.round(p * 100)}%` : '0%';
      if (bar.style.height !== h) bar.style.height = h;
    });
  }

  /** Slim stamina bar under HP: calm teal → stressed red (pulsing when low); EXHAUSTED once run dry until back over 30. */
  private updateStamina(v: number, alive: boolean) {
    const s = Math.max(0, Math.min(STAMINA.max, alive ? v : STAMINA.max));
    if (s <= 0.5) this.exhausted = true;
    else if (s >= STAMINA.recoverAt) this.exhausted = false;
    const w = `${((100 * s) / STAMINA.max).toFixed(1)}%`;
    if (this.staminaFill.style.width !== w) this.staminaFill.style.width = w;
    // Hue: 170 (calm teal) at full → 0 (red) at empty.
    const hue = Math.round(170 * Math.pow(s / STAMINA.max, 0.8));
    this.stamina.style.setProperty('--sta-hue', String(hue));
    this.stamina.classList.toggle('low', s < STAMINA.recoverAt);
    this.stamina.classList.toggle('critical', s < STAMINA.startMin);
    this.stamina.classList.toggle('exhausted', this.exhausted);
    this.stamina.classList.toggle('full', s >= STAMINA.max - 0.5);
    setText(this.staminaText, this.exhausted ? 'EXHAUSTED' : '');
  }

  /** Spectating a bot: what it's thinking (bot.debug via the snapshot's `brains`). */
  private updateBrain(b: BotBrainInfo | null, snap: Snapshot) {
    this.brain.style.display = b ? '' : 'none';
    if (!b) { this.brainSig = ''; return; }
    const sig = JSON.stringify(b);
    if (sig === this.brainSig) return;
    this.brainSig = sig;
    const name = (id: number | null) => (id === null ? null : snap.players.find((p) => p.id === id)?.name ?? `#${id}`);
    const head = el('div', 'bb-head');
    head.append(el('span', 'bb-title', 'BOT BRAIN'), el('span', 'bb-tag', b.personality), el('span', `bb-tag diff-${b.difficulty}`, b.difficulty.toUpperCase()));
    const goal = el('div', 'bb-goal');
    goal.dataset.testid = 'brain-goal';
    goal.append(el('span', 'bb-label', 'Goal'), el('span', 'bb-goal-name', (b.goal ?? b.action).toUpperCase()));
    const target = name(b.target);
    if (target) goal.append(el('span', 'bb-target', `→ ${target}`));
    const parts: HTMLElement[] = [head, goal];
    if (b.reason) parts.push(el('div', 'bb-reason', `because ${b.reason}`));
    if (b.steps.length) {
      const ol = el('ol', 'bb-steps');
      b.steps.forEach((s, i) => ol.append(el('li', i < b.step ? 'done' : i === b.step ? 'cur' : '', s)));
      parts.push(ol);
    }
    if (b.fightOdds !== null) {
      const odds = el('div', 'bb-odds');
      const bar = el('div', 'bb-odds-bar');
      const fill = el('i');
      fill.style.width = `${Math.round(b.fightOdds * 100)}%`;
      bar.append(fill);
      odds.append(el('span', 'bb-label', 'Fight odds'), bar, el('span', 'bb-odds-val', `${Math.round(b.fightOdds * 100)}%`));
      parts.push(odds);
    }
    if (b.options.length) {
      const opts = el('div', 'bb-opts');
      opts.append(el('div', 'bb-label', 'Why: top options'));
      const top = Math.max(1e-6, ...b.options.map((o) => o.score));
      for (const o of b.options) {
        const row = el('div', `bb-opt${o.goal === (b.goal ?? b.action) ? ' chosen' : ''}`);
        const bar = el('div', 'bb-opt-bar');
        const fill = el('i');
        fill.style.width = `${Math.max(4, Math.round((100 * Math.max(0, o.score)) / top))}%`;
        bar.append(fill);
        row.append(el('span', 'bb-opt-name', o.goal), bar, el('span', 'bb-opt-val', o.score.toFixed(2)));
        opts.append(row);
      }
      parts.push(opts);
    }
    const thought = el('div', 'bb-thought', `“${b.thought}”`);
    thought.dataset.testid = 'brain-thought';
    parts.push(thought);
    this.brain.replaceChildren(...parts);
  }

  /** Blue shield bar over the health bar (4 × 25 segments), plus the speed-buff timer. */
  private updateShield(me: PlayerState, snap: Snapshot) {
    const sh = Math.max(0, Math.min(SHIELD_MAX, me.shield ?? 0));
    this.shieldFill.style.width = `${(100 * sh) / SHIELD_MAX}%`;
    setText(this.shieldText, sh > 0 ? `${Math.ceil(sh)}` : '');
    this.shield.classList.toggle('empty', sh <= 0);
    if (this.lastShield > 0 && sh <= 0 && me.alive) this.flash(this.shield, 'broke');
    this.lastShield = sh;
    const speedLeft = me.alive ? Math.max(me.speedUntil ?? 0, me.surgeUntil ?? 0) - snap.time : 0;
    this.speedBuff.style.display = speedLeft > 0 ? '' : 'none';
    if (speedLeft > 0) setText(this.speedBuff.querySelector('.buff-time') as HTMLElement, `${Math.ceil(speedLeft)}s`);
  }

  setFps(n: number) {
    setText(this.fps, `${Math.round(n)} fps`);
  }

  /** Perf detail lines (null hides them). */
  setFpsDetail(lines: string[] | null) {
    this.fpsDetail.style.display = lines ? '' : 'none';
    if (lines) setText(this.fpsDetail, lines.join('\n'));
  }

  get panelOpen() {
    return this.panelKind !== null && !this.mirroring;
  }

  /** Practice range: no clock, cash shown as ∞, the shop opens anywhere and everything in it is free. */
  private practice = false;
  setPractice() {
    this.practice = true;
    this.root.classList.add('practice-mode');
  }

  /** Prompt/near-station state is computed here from the snapshot so main stays thin. */
  nearStation(): 'shop' | 'potions' | 'vault' | 'generator' | 'gold' | 'supply' | null {
    const me = this.me;
    if (!me || !me.alive) return null;
    const own = this.map[me.island];
    const r = ECONOMY.interactRadius;
    if (this.map.some((m) => dist2D(m.shop, me.pos) <= r)) return 'shop'; // any island's shop NPC
    if (own && dist2D(own.vault, me.pos) <= r) return 'vault';
    if (this.snap?.potionShops?.some((sh) => dist2D(sh.pos, me.pos) <= r && Math.abs(sh.pos.y - me.pos.y) < 2)) return 'potions';
    if (this.map.some((m) => dist2D(m.generator, me.pos) <= r)) return 'generator';
    const c = this.centerIsland;
    if (c && dist2D(c.goldGen, me.pos) <= r) return 'gold';
    if (c && dist2D(c.supplyGen, me.pos) <= r) return 'supply';
    return this.practice ? 'shop' : null;
  }

  /** Per frame: the throw charge 0..1 (-1 = not charging). Touches the DOM only when the shown percent changes. */
  setThrowCharge(p: number) {
    const v = p < 0 ? -1 : Math.round(p * 100);
    if (v === this.chargeShown) return;
    if ((v < 0) !== (this.chargeShown < 0)) this.chargeRing.style.display = v < 0 ? 'none' : '';
    this.chargeShown = v;
    if (v < 0) return;
    this.chargeRing.style.setProperty('--p', `${Math.round(v * 3.6)}deg`);
    this.chargeRing.classList.toggle('full', v >= 100);
    this.chargeRing.dataset.pct = String(v);
  }

  update(snap: Snapshot, ctx: HudContext) {
    this.snap = snap;
    const found = snap.players.find((p) => p.id === this.humanId) ?? null;
    // After /spectate mid-match our old player is bot-driven: it's not "us" any more, so no player widgets of our own.
    const own = found && !found.isBot ? found : null;
    this.me = own;
    // Spectating someone: their HUD (hp, shield, stamina, cash, hotbar, gun, crosshair) as if you were them.
    const followed = ctx.viewId != null && ctx.viewId !== this.humanId ? snap.players.find((p) => p.id === ctx.viewId) ?? null : null;
    const me = followed ?? own;
    const watching = !!followed;
    this.root.classList.toggle('watching', watching);
    this.panelMe = watching ? followed : own;
    this.lowHp.classList.toggle('on', !!me && me.alive && me.hp <= 30);
    this.updateBrain(watching ? snap.brains?.find((b) => b.id === followed!.id) ?? null : null, snap);
    // No player of our own and nobody followed (spectating host in free fly): player widgets hidden,
    // match info and the end screen still live.
    this.root.classList.toggle('no-player', !me);
    // Eliminated and free-flying: your own $0 / HP 0 / empty hotbar say nothing; hide them like no-player.
    this.root.classList.toggle('out', !watching && !!own?.eliminated);
    if (!me) {
      this.center.style.display = 'none';
      this.heal.style.display = 'none';
      this.drinkBox.style.display = 'none';
      this.sealedBanner.style.display = 'none';
      this.updateMatchInfo(snap, -1);
      const end = endState(snap.winner, 0, false, snap.players);
      if (end) this.showEnd(snap, end);
      this.tickFeed();
      return;
    }
    if (watching) ctx = { ...ctx, selected: me.selected, ghostOk: null, buildNote: null, trapHint: null, inventory: false };
    // Sealed / break-out banner: the viewed player's bunker and countdown.
    this.updateSealed(snap, me);
    if (this.mirroring) { if (this.panelKind === 'vault') this.refreshVault(); else this.renderShop(); }
    const inv = me.inv;

    this.hpFill.style.width = `${Math.max(0, me.hp)}%`;
    this.hpFill.classList.toggle('low', me.hp <= 30);
    setText(this.hpText, `${Math.ceil(me.hp)}`);
    this.updateShield(me, snap);
    setText(this.cash, this.practice ? '$∞' : `$${inv.cash}`);
    // Spent at a shop: the top-left cash ticks down visibly (the shop itself no longer repeats it).
    if (this.panelKind && inv.cash < this.lastCash) this.flash(this.cash, 'spent');
    this.lastCash = inv.cash;
    // Carried cash drops on death; the vault never does (and shops take it). Warn once a fair sum is carried.
    const risky = !this.practice && inv.cash >= CARRY_WARN;
    setText(this.bankNote, risky ? `$${Math.floor(inv.cash)} drops if you die · bank it${(me.vaultLevel ?? 1) > 1 ? ' (H)' : ''}` : '');
    this.bankNote.classList.toggle('risk', risky);
    this.updateStamina(watching ? me.stamina : ctx.stamina ?? me.stamina, me.alive);
    setText(this.watchTag, watching ? `${me.isBot ? 'BOT · ' : ''}${me.name}` : '');

    // Generator stored: shown for whichever generator you're near (yours, or theirs to steal).
    const near = snap.generators
      .map((g) => ({ g, d: dist2D(this.map[g.island].generator, me.pos) }))
      .filter((x) => x.d <= 10).sort((a, b) => a.d - b.d)[0];
    const cg = this.centerIsland && snap.center && dist2D(this.centerIsland.goldGen, me.pos) <= 10 ? snap.center : null;
    this.gen.style.display = near || cg ? '' : 'none';
    if (cg && !near) setText(this.gen, `Gold generator  $${Math.floor(cg.gold)}`);
    else if (near) {
      const lv = snap.genLevels?.[near.g.island] ?? 1;
      setText(this.gen, `${near.g.island === me.island ? 'Your generator' : `${islandName(near.g.island)} generator`}  $${Math.floor(near.g.stored)} · Lv${lv}`);
    }

    const station = watching ? null : this.nearStation();
    const promptText = watching ? '' : isPieceItem(me.hotbar[ctx.selected]) ? '' :
      station === 'shop' ? 'E  Shop' : station === 'potions' ? 'E  Potion seller' : station === 'vault' ? 'E  Vault' :
      // The amount is already on the generator readout top-left; the prompt is just the action.
      station === 'generator' || station === 'gold' ? 'E  Collect' :
      station === 'supply' ? supplyPrompt(snap.center) : '';
    setText(this.prompt, promptText);
    this.prompt.style.display = promptText && !this.panelKind ? '' : 'none';

    // What's in hand: the selected slot (a gun, a stack of pieces/explosives) or fists.
    const held = me.hotbar[ctx.selected] ?? null;
    const buildKind = isPieceItem(held) ? held : null;
    const ammo = isGunItem(held) ? inv.weapons[held] : undefined;
    const reloading = me.reloadUntil > 0;
    const heldText = ammo ? `${ammo.mag}/${ammo.spare}` : held && !isGunItem(held) ? `×${countOf(inv, held)}` : '';
    // Rebuild only when it changes (this runs every frame).
    const weaponKey = `${held ? LABEL[held] : 'Fists'}|${heldText}`;
    if (this.weapon.dataset.key !== weaponKey) {
      this.weapon.dataset.key = weaponKey;
      this.weapon.replaceChildren(el('span', 'wname', held ? LABEL[held] : 'Fists'), el('span', 'ammo', heldText));
    }
    this.weapon.classList.toggle('reloading', reloading);
    setText(this.extras, reloading ? 'Reloading…' : '');
    this.extras.style.display = reloading ? '' : 'none';

    this.updateHotbar(me, ctx, snap.time);
    const healing = me.alive && me.healAt != null;
    this.heal.style.display = healing ? '' : 'none';
    if (healing) this.healFill.style.width = `${Math.round(100 * Math.min(1, Math.max(0, 1 - (me.healAt! - snap.time) / MEDKIT.useSec)))}%`;
    const drink = me.alive ? me.drinking : null;
    this.drinkBox.style.display = drink ? '' : 'none';
    if (drink) {
      this.drinkBox.dataset.kind = drink.kind;
      this.drinkFill.style.width = `${Math.round(100 * Math.min(1, Math.max(0, 1 - (drink.doneAt - snap.time) / POTIONS[drink.kind].useSec)))}%`;
    }
    this.crosshair.classList.toggle('build', !!buildKind);
    const gap = buildKind ? 4 : Math.round(Math.min(60, Math.max(3, ctx.spreadPx ?? 4)));
    if (this.crosshair.style.getPropertyValue('--gap') !== `${gap}px`) this.crosshair.style.setProperty('--gap', `${gap}px`);
    this.crosshair.classList.toggle('scoped', !!ctx.scoped);
    this.scope.classList.toggle('on', !!ctx.scoped);
    const rl = ctx.reload ?? null;
    this.reloadRing.style.display = rl === null ? 'none' : '';
    if (rl !== null) this.reloadRing.style.setProperty('--p', `${Math.round(rl * 360)}deg`);

    this.updateMatchInfo(snap, own ? own.island : -1);
    if (!own) {
      // Spectating host following someone: no player of our own, so no end screen of our own.
      this.center.style.display = 'none';
      const end = endState(snap.winner, 0, false, snap.players);
      if (end) this.showEnd(snap, end);
      this.tickFeed();
      return;
    }
    this.updateOwn(snap, own, watching ? null : buildKind, ctx);
  }

  /** Sealed bunker / break-out countdown banner for `me` (the viewed player). */
  private updateSealed(snap: Snapshot, me: PlayerState) {
    // Sudden death seals every bunker for good (announced once, 'allSealed'): no per-bunker "clear a doorway" nag.
    const sealed = !!snap.sealed[me.island] && !snap.suddenDeath;
    const trapped = me.alive && me.breakoutUntil != null;
    const left = trapped ? Math.max(0, me.breakoutUntil! - snap.time).toFixed(1) : '';
    setText(this.sealedBanner, trapped
      ? !snap.suddenDeath ? `BREAK OUT! ${left}s` : this.map[me.island] && insideBunker(this.map[me.island].bunker, me.pos) ? `SEALED IN! ${left}s` : `GET CLEAR! ${left}s`
      : me.alive ? SEALED_OUTSIDE_TEXT : 'YOUR BUNKER IS SEALED');
    this.sealedBanner.classList.toggle('outside', me.alive && !trapped);
    this.sealedBanner.style.display = (sealed || trapped) && !me.eliminated && snap.winner === null ? 'block' : 'none';
  }

  /** Banners and messages about your own player (respawn countdown, sealed bunker, build hint, end screen). */
  private updateOwn(snap: Snapshot, me: PlayerState, buildKind: PieceKind | null, ctx: HudContext) {
    const inv = me.inv;
    const ownSealed = !!snap.sealed[me.island];

    if (!me.alive && !me.eliminated && me.respawnAt !== null) {
      setText(this.center, ownSealed ? `Bunker sealed — you'll respawn trapped in ${Math.max(0, me.respawnAt - snap.time).toFixed(1)}s with 10s to break out` : `Respawning in ${Math.max(0, me.respawnAt - snap.time).toFixed(1)}s`);
      this.center.style.display = 'block';
    } else if (buildKind) {
      const have = inv.pieces[buildKind] ?? 0;
      setText(this.center, `Build: ${LABEL[buildKind]} (${have})  ·  Z/X rotate  ·  ${ctx.free ? 'free place' : 'Alt free place'}${ctx.buildNote ? `  ·  ${ctx.buildNote}` : ''}`);
      this.center.style.display = 'block';
      this.center.classList.add('small');
    } else if (ctx.trapHint) {
      setText(this.center, ctx.trapHint);
      this.center.style.display = 'block';
      this.center.classList.add('small');
    } else {
      this.center.style.display = 'none';
    }
    if (!buildKind && !ctx.trapHint) this.center.classList.remove('small');

    const end = endState(snap.winner, this.humanId, me.eliminated, snap.players);
    if (end) this.showEnd(snap, end);

    if (this.panelKind === 'shop' || this.panelKind === 'potions') this.renderShop();
    else if (this.panelKind === 'vault') this.refreshVault();
    this.tickFeed();
  }

  /** Timer, storm banner/vignette and the island chips (myIsland -1 = none of them is yours). */
  private updateMatchInfo(snap: Snapshot, myIsland: number) {
    const left = this.practice ? Infinity : this.suddenDeathAt - snap.time;
    setText(this.timer, this.practice ? 'PRACTICE' : snap.suddenDeath ? 'SUDDEN DEATH' : fmtClock(left));
    this.timer.classList.toggle('sd', snap.suddenDeath);
    const st = snap.storm;
    const me = snap.players.find((p) => p.id === (this.viewId || this.humanId));
    // Metres outside the ring (negative = inside), for the living viewed player.
    const out = st && me?.alive ? Math.hypot(me.pos.x - st.x, me.pos.z - st.z) - st.r : null;
    setText(this.banner, st
      ? out !== null && out > 0 ? `IN THE STORM · ${Math.ceil(out)} m to safety` : out !== null ? `Storm closing · edge ${Math.floor(-out)} m away` : 'Storm closing in'
      : left < 60 ? 'Sudden death soon' : '');
    this.banner.style.display = this.banner.textContent ? '' : 'none';
    this.banner.classList.toggle('storm', !!st);
    this.stormVignette.classList.toggle('on', out !== null && out > 0);
    this.stormWarn.style.display = performance.now() < this.stormWarnUntil ? 'flex' : 'none';
    if (this.elimBannerUntil && performance.now() >= this.elimBannerUntil) { this.elimBannerUntil = 0; this.elimBanner.style.display = 'none'; }

    Array.from(this.seals.children).forEach((chip, i) => {
      const sealed = !!snap.sealed[i];
      const out = !!snap.players.find((p) => p.island === i)?.eliminated;
      chip.classList.toggle('sealed', sealed && !out);
      chip.classList.toggle('out', out);
      setText(chip.querySelector('.state') as HTMLElement, chipState(sealed, out));
      // Other islands are labelled with their owner's name (a leaver's seat stays theirs, now bot-run).
      const owner = i === myIsland ? null : snap.players.find((p) => p.island === i);
      if (owner) setText(chip.querySelector('.name') as HTMLElement, owner.name);
    });
  }

  private showEnd(snap: Snapshot, end: NonNullable<ReturnType<typeof endState>>) {
    // Re-shown when the match result changes (e.g. eliminated mid-match, then someone wins).
    const key = `${end.state}|${snap.winner}`;
    if (this.endScreen.dataset.key !== key) {
      this.endScreen.dataset.key = key;
      this.endScreen.dataset.state = end.state;
      this.endScreen.dataset.testid = 'end-screen';
      const btn = el('button', 'btn', 'Back to menu');
      btn.onclick = () => this.act.backToMenu();
      const buttons = el('div', 'end-buttons');
      buttons.append(...(this.act.endButtons?.(snap.winner !== null) ?? [btn]));
      this.endScreen.replaceChildren(el('div', 'end-title', end.title), el('div', 'end-sub', end.sub), buttons);
      this.endScreen.style.display = 'flex';
    }
  }

  get ended() {
    return this.endScreen.style.display === 'flex';
  }

  /** Hide / bring back the end screen (spectating after elimination or the match end). */
  setEndVisible(v: boolean) {
    if (this.endScreen.dataset.key) this.endScreen.style.display = v ? 'flex' : 'none';
  }

  setViewed(id: number) { this.viewId = id; }

  pushEvents(events: MatchEvent[]) {
    const snap = this.snap;
    const name = (id: unknown) => {
      if (typeof id !== 'number') return null;
      return id === this.humanId ? 'You' : snap?.players.find((p) => p.id === id)?.name ?? `#${id}`;
    };
    for (const f of feedEntries(events, {
      humanId: this.humanId,
      ownerOf: (island) => snap?.players.find((p) => p.island === island)?.id ?? null,
    })) this.addFeedNode(this.feedNode(f));
    for (const e of events) {
      if (e.type === 'unsealed') {
        const isl = e.data.island as number | undefined;
        this.addFeed(`${isl === this.me?.island ? 'Your' : `${islandName(isl ?? 0)}'s`} bunker reopened`);
      } else if (e.type === 'eliminated') {
        // Credited ones get the big line from their 'elimination' event (same tick).
        const id = e.data.player ?? e.data.id;
        if (!events.some((x) => x.type === 'elimination' && x.data.victim === id && x.data.by !== null))
          this.addFeed(`${name(id) ?? 'Someone'} eliminated${ELIM_WHY[e.data.reason as string] ?? ''}`, true);
      } else if (e.type === 'elimination' && typeof e.data.by === 'number') {
        this.showElimination(e, name);
      } else if (e.type === 'suddenDeath') {
        this.addFeed('Sudden death: all bunkers sealed, generators stopped, the storm is closing in', true);
        this.stormWarnUntil = performance.now() + 4000;
        this.stormWarn.style.display = 'flex';
      } else if (e.type === 'vaultUpgrade' && e.data.player === this.humanId) {
        this.addFeed(`Vault upgraded to Lv${e.data.level}`);
      } else if (e.type === 'restock' && e.data.player === this.humanId) {
        const d = e.data as { moved: number; bought: number; spent: number; cash: number };
        const parts = [d.moved ? `${d.moved} from the vault` : '', d.bought ? `${d.bought} bought ($${d.spent})` : '', d.cash ? `$${d.cash} cash` : ''].filter(Boolean);
        this.addFeed(`Restocked: ${parts.join(' · ')}`);
      } else if (e.type === 'allSealed') {
        // One announcement for every bunker (no per-bunker seal lines in sudden death): on the STORM banner.
        this.allSealed.style.display = 'flex';
        this.stormWarnUntil = Math.max(this.stormWarnUntil, performance.now() + 5000);
        this.stormWarn.style.display = 'flex';
      } else if (e.type === 'kill') {
        const v = this.viewId || this.humanId;
        if (e.data.killer === v && e.data.victim !== v) this.hitmarker(false, true);
      } else if (e.type === 'hit') {
        // The viewed player's hits (their own predicted ones were shown already: echo).
        const v = this.viewId || this.humanId;
        if (e.data.by === v && e.data.target !== v && !(e.data.echo && v === this.humanId)) this.hitmarker(e.data.part === 'head');
        if (e.data.target === v) this.flash(this.damage, 'on');
      }
    }
  }

  /** Glory: the big banner and a highlighted feed line for an elimination credit. */
  private showElimination(e: MatchEvent, name: (id: unknown) => string | null) {
    const g = elimView(e, this.viewId || this.humanId, name);
    if (!g) return;
    const node = el('div', `feed-item alert elim${g.mine ? ' mine' : ''}`, g.feed);
    node.dataset.testid = 'feed-elim';
    this.addFeedNode(node);
    if (!g.banner) return;
    this.elimBanner.replaceChildren(el('div', 'elim-title', g.banner.title), el('div', 'elim-sub', g.banner.sub));
    this.elimBanner.classList.toggle('mine', g.banner.mine);
    this.elimBanner.dataset.victim = String(e.data.victim);
    this.elimBanner.dataset.by = String(e.data.by);
    this.elimBanner.style.display = 'flex';
    this.elimBannerUntil = performance.now() + 3500;
  }

  /** Crosshair hitmarker (also shown straight away for a predicted hit). */
  hitmarker(head: boolean, kill = false) {
    this.crosshair.classList.toggle('head', head);
    this.crosshair.classList.toggle('kill', kill);
    // Counted for tests / debug (spectating: the viewed player's hits).
    this.crosshair.dataset.hits = String(Number(this.crosshair.dataset.hits ?? 0) + 1);
    this.flash(this.crosshair, 'hit');
  }

  private flash(node: HTMLElement, cls: string) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  private addFeed(text: string, alert = false) {
    this.addFeedNode(el('div', `feed-item${alert ? ' alert' : ''}`, text));
  }

  private addFeedNode(node: HTMLElement) {
    node.style.animationDelay = `0s, ${(FEED_LIFE_MS - FEED_FADE_MS) / 1000}s`;
    this.killfeed.prepend(node);
    for (const gone of this.feed.push(node, performance.now())) gone.remove();
  }

  /** A kill / seal line: killer (island colour) ⟶ weapon icon + markers ⟶ victim. Yours highlighted. */
  private feedNode(f: FeedEntry): HTMLElement {
    const snap = this.snap;
    const nameOf = (id: number) => (id === this.humanId ? 'You' : snap?.players.find((p) => p.id === id)?.name ?? `#${id}`);
    const who = (id: number | null) => {
      const span = el('span', 'fd-name', id === null ? '' : nameOf(id));
      const p = id === null ? undefined : snap?.players.find((q) => q.id === id);
      if (p) span.style.setProperty('--c', hex(islandColor(p.island)));
      if (id === this.humanId) span.classList.add('you');
      return span;
    };
    const node = el('div', `feed-item ${f.kind}${f.mine ? ' mine' : ''}${f.me ? ' me' : ''}`);
    node.dataset.testid = 'feed-entry';
    node.title = feedText(f, nameOf);
    const how = el('span', 'fd-how');
    if (f.kind === 'sealed') {
      how.innerHTML = LOCK_ICON;
      how.append(el('span', 'fd-tag', 'SEALED'));
      if (f.killer !== null) node.append(who(f.killer));
      node.append(how);
      if (f.victim !== null) node.append(who(f.victim));
      return node;
    }
    if (f.weapon && Object.hasOwn(ICONS, f.weapon)) how.innerHTML = ICONS[f.weapon as IconKind];
    else if (f.weapon === 'fists') how.append(el('span', 'fd-glyph', '✊'));
    else if (f.killer !== null || !f.markers.length) how.append(el('span', 'fd-glyph', '⟶'));
    for (const m of f.markers) {
      const b = el('span', `fd-mark ${m}`, MARK_GLYPH[m]);
      b.title = m;
      how.append(b);
    }
    // "X via barrel": a barrel / propane tank the killer set off.
    if (f.via) how.append(el('span', 'fd-tag', `via ${f.via}`));
    if (f.killer !== null) node.append(who(f.killer));
    node.append(how, who(f.victim));
    return node;
  }

  private tickFeed() {
    for (const gone of this.feed.expire(performance.now())) gone.remove();
  }

  // ---- panels ---------------------------------------------------------------------------------

  /** What you have open, for friends spectating you (ViewExtras). */
  viewState(): { panel: 'shop' | 'potions' | 'vault' | null; hover: ShopItem | null } {
    return this.mirroring || !this.panelKind ? { panel: null, hover: null } : { panel: this.panelKind, hover: this.panelKind === 'vault' ? null : this.hoverItem };
  }

  /**
   * Spectating a human: their open shop / vault, read-only (their cash and stock, the item they hover).
   * null closes the mirror.
   */
  setMirror(m: { panel: 'shop' | 'potions' | 'vault' | null; hover: ShopItem | null } | null) {
    if (!m?.panel) {
      if (this.mirroring) { this.closePanel(); this.mirroring = false; }
      return;
    }
    if (!this.panelMe) return;
    if (!this.mirroring || this.panelKind !== m.panel) {
      this.mirroring = true;
      if (m.panel === 'vault') this.openVault(); else this.openShop(m.panel);
      this.panel.classList.add('mirror');
      this.panel.dataset.testid = 'panel-mirror';
    }
    if (m.panel === 'vault') return;
    const info = this.panel.querySelector<HTMLElement>('.shop-info');
    for (const b of Array.from(this.panel.querySelectorAll<HTMLElement>('.shop-item'))) {
      const on = b.dataset.item === m.hover;
      b.classList.toggle('hover', on);
      if (on && info) { setText(info, b.dataset.name ?? ''); info.classList.add('on'); }
    }
    if (!m.hover) info?.classList.remove('on');
  }

  /** The home shop, or a potion seller's counter (`potions`). */
  openShop(kind: 'shop' | 'potions' = 'shop') {
    this.vaultPanel.cancelDrag();
    this.panelKind = kind;
    this.panel.className = 'panel open';
    this.panel.dataset.kind = kind;
    this.renderShop(true);
  }

  openVault() {
    this.vaultPanel.cancelDrag();
    this.panelKind = 'vault';
    this.panel.className = 'panel open';
    this.panel.dataset.kind = 'vault';
    this.renderVault();
  }

  closePanel() {
    this.vaultPanel.cancelDrag();
    this.panelKind = null;
    this.hoverItem = null;
    delete this.panel.dataset.testid;
    this.panel.onkeydown = null;
    this.panel.className = 'panel';
    this.panel.replaceChildren();
  }

  private header(title: string) {
    const h = el('div', 'panel-head');
    const close = el('button', 'close', 'Close  (Esc)');
    close.onclick = () => this.act.closePanel();
    h.append(el('div', 'panel-title', title), close);
    return h;
  }

  private renderShop(rebuild = false) {
    const me = this.panelMe ?? this.me;
    if (!me) return;
    if (rebuild || !this.panel.querySelector('.shop-grid')) {
      const grid = el('div', 'shop-grid');
      const info = el('div', 'shop-info', 'Hover an item for details');
      info.dataset.testid = 'shop-info';
      const section = (title: string, items: ShopItem[]) => {
        const row = el('div', 'shop-row');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', title);
        for (const item of items) {
          // Icon + price only; the name is the tooltip (and the accessible label).
          const b = el('button', 'shop-item');
          b.type = 'button';
          b.dataset.item = item;
          b.dataset.testid = `buy-${item}`;
          b.dataset.name = labelOf(item);
          const gun = lockedGunOf(item);
          const kind: IconKind = gun ?? (item as IconKind);
          b.dataset.group = iconGroup(kind);
          if (gun) b.classList.add('lock-card');
          const icon = el('span', 'sicon');
          icon.innerHTML = ICONS[kind];
          const lock = el('span', 'ilock');
          lock.innerHTML = LOCK_ICON;
          b.append(icon, el('span', 'iname', shortOf(item)), el('span', 'iprice', `$${priceOf(item)}`), el('span', 'ibadge'), el('span', 'istatus'), lock);
          b.onclick = (e) => {
            if (b.getAttribute('aria-disabled') !== 'true') { this.act.buy(item, e.shiftKey); return; }
            // Can't buy: shake the card; can't afford: also flash the cash readout top-left.
            this.flash(b, 'deny');
            if (b.classList.contains('poor')) this.flash(this.cash, 'deny');
          };
          // The name/details show in the panel's info bar (never clipped by the panel edge).
          const show = () => { this.shopHover = b; setText(info, b.dataset.name ?? ''); info.classList.add('on'); this.hoverItem = item; };
          const hide = () => { if (this.shopHover === b) this.shopHover = null; info.classList.remove('on'); if (this.hoverItem === item) this.hoverItem = null; };
          b.onmouseenter = show; b.onfocus = show; b.onmouseleave = hide; b.onblur = hide;
          row.append(b);
        }
        grid.append(el('div', 'shop-section', title), row);
      };
      if (this.panelKind === 'potions') {
        section('Potions', [...POTION_KINDS]);
        section('Gear', ['grapple']);
      } else {
        section('Weapons', [...GUNS, 'ammo']);
        section('Building', PIECE_ORDER);
        section('Gear', ['grenade', 'smoke', 'flash', 'charge', 'trap', 'medkit', 'grapple']);
        // Lock cards only show up once you own (or have locked) that gun.
        section('Upgrades', ['genUpgrade', ...GUNS.map(lockItem)]);
      }
      // No "Carrying $X" line: the cash is always top-left (it flashes on a buy or a can't-afford click).
      this.shopHover = null;
      this.panel.replaceChildren(this.header(this.panelKind === 'potions' ? 'Potion seller' : 'Shop'), grid, info);
      // Focus the panel (not a card, so no tooltip pops up): Tab or an arrow key then walks the cards.
      this.panel.tabIndex = -1;
      if (!this.mirroring) {
        this.panel.onkeydown = (e) => this.shopArrows(e);
        this.panel.focus({ preventScroll: true });
      }
    }
    const panelCash = this.panel.querySelector('.panel-cash') as HTMLElement | null;
    if (panelCash) setText(panelCash, this.practice ? 'Practice: everything is free' : `Carrying $${me.inv.cash} · vault $${Math.floor(me.vault.cash)}`);
    const genLevel = this.snap?.genLevels?.[me.island] ?? 1;
    // Any island's shop NPC sells to you, but upgrades and locks only at your own.
    const atHome = this.practice || (!!this.map[me.island] && dist2D(this.map[me.island].shop, me.pos) <= ECONOMY.interactRadius);
    for (const b of Array.from(this.panel.querySelectorAll<HTMLButtonElement>('.shop-item'))) {
      const item = b.dataset.item as ShopItem;
      const price = priceOf(item, genLevel, me);
      const poor = funds(me) < price;
      const lockGun = lockedGunOf(item);
      let status = '';
      let badge = '';
      setText(b.querySelector('.iprice') as HTMLElement, this.practice ? 'Free' : `$${price}`);
      b.classList.toggle('show-lock', !!lockGun || ((GUNS as readonly string[]).includes(item) && me.locked.includes(item as GunKind)));
      if (item === 'genUpgrade') {
        const next = Math.min(GENERATOR_MAX_LEVEL, genLevel + 1), spec = generatorSpec(next);
        b.dataset.name = genLevel >= GENERATOR_MAX_LEVEL ? `Generator Lv${genLevel} (max)` : `Generator ↑ Lv${next}: $${+(spec.rate * this.genMult).toFixed(2)}/s, holds $${spec.cap}`;
        if (genLevel >= GENERATOR_MAX_LEVEL) status = 'Max';
        else badge = `Lv${next}`;
      } else if (lockGun) {
        const locked = me.locked.includes(lockGun);
        b.hidden = !locked && !me.inv.weapons[lockGun];
        if (locked) status = 'Locked';
      } else if ((GUNS as readonly string[]).includes(item) && me.inv.weapons[item as WeaponKind]) status = 'Owned';
      else if (isHotbarItem(item) && countOf(me.inv, item) === 0 && !canAdd(me.hotbar, item)) status = 'Hotbar full';
      else if (item === 'ammo') {
        const gun = ammoTarget(me);
        if (!gun) status = 'Equip a gun';
        else badge = `+${ammoPerBox(gun)}`;
      }
      if (!status && isHotbarItem(item) && !isGunItem(item)) {
        const n = countOf(me.inv, item);
        if (n > 0) badge = `×${n}`;
      }
      if (!atHome && isHomeOnly(item) && status !== 'Max' && status !== 'Locked') status = 'Home shop';
      const blocked = poor || status !== '';
      if (b.getAttribute('aria-disabled') !== String(blocked)) b.setAttribute('aria-disabled', String(blocked));
      b.classList.toggle('poor', poor && !status);
      b.classList.toggle('blocked', status !== '');
      b.dataset.status = status === 'Hotbar full' ? 'full' : status ? 'other' : '';
      setText(b.querySelector('.istatus') as HTMLElement, status);
      setText(b.querySelector('.ibadge') as HTMLElement, badge);
      b.dataset.st = status;
      // Info-bar text: what it does + why it can't be bought right now.
      const why = status === 'Home shop' ? ' · only at your home shop' : status && status !== 'Max' ? ` · ${status}` : poor ? ` · need $${price - funds(me)} more` : '';
      const details = detailsOf(item, price, genLevel, me) + why;
      if (b.dataset.name !== details) b.dataset.name = details;
      if (this.shopHover === b) setText(this.panel.querySelector('.shop-info') as HTMLElement, details);
      const label = `${labelOf(item)}, $${price}${status ? `, ${status}` : poor ? ', not enough cash' : ''}${badge ? `, ${badge}` : ''}`;
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    }
  }

  /** Arrow keys move focus between shop cards (Enter/Space buys, Tab also works). */
  private shopArrows(e: KeyboardEvent) {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    const cards = Array.from(this.panel.querySelectorAll<HTMLButtonElement>('.shop-item')).filter((c) => !c.hidden);
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    if (at < 0) { cards[0]?.focus(); return; }
    let next = at + dir;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Same column in the next/previous row: nearest card by x on a different line.
      const r = cards[at].getBoundingClientRect();
      const rows = cards.filter((c) => (dir > 0 ? c.getBoundingClientRect().top > r.top + 4 : c.getBoundingClientRect().top < r.top - 4));
      const lineTop = dir > 0 ? Math.min(...rows.map((c) => c.getBoundingClientRect().top)) : Math.max(...rows.map((c) => c.getBoundingClientRect().top));
      const line = rows.filter((c) => Math.abs(c.getBoundingClientRect().top - lineTop) < 4);
      const best = line.sort((a, b) => Math.abs(a.getBoundingClientRect().left - r.left) - Math.abs(b.getBoundingClientRect().left - r.left))[0];
      next = best ? cards.indexOf(best) : at;
    }
    cards[Math.max(0, Math.min(cards.length - 1, next))].focus();
  }

  private renderVault() {
    const me = this.panelMe ?? this.me;
    if (!me) return;
    this.vaultPanel.render(this.header('Vault'), me);
  }

  private refreshVault() {
    const me = this.panelMe ?? this.me;
    if (me) this.vaultPanel.refresh(me);
  }

  /** At my vault, or (remote vault level) anywhere on my island. */
  canBankHere(): boolean {
    const me = this.me, isl = me ? this.map[me.island] : undefined;
    if (!me || !isl || !me.alive) return false;
    if (dist2D(isl.vault, me.pos) <= ECONOMY.interactRadius) return true;
    if (vaultSpec(me).remote && dist2D(isl.center, me.pos) <= isl.radius + 1) return true;
    this.addFeed('Quick-bank works at your vault (from vault Lv2: anywhere on your island)');
    return false;
  }

  /** Hold E at the vault (or the panel's button): everything above the restock loadout goes in. */
  quickBank(): boolean {
    const me = this.me;
    if (!me) return false;
    const dep = bankAboveLoadout(me);
    if (!dep) { this.addFeed('Nothing to bank above your restock loadout'); return false; }
    this.act.vault({ deposit: dep });
    const items = Object.values(dep.pieces ?? {}).reduce((a, n) => a + (n ?? 0), 0) + Object.values(dep.potions ?? {}).reduce((a, n) => a + (n ?? 0), 0) +
      (dep.grenades ?? 0) + (dep.charges ?? 0) + (dep.medkits ?? 0) + (dep.traps ?? 0);
    this.addFeed(`Banked${dep.cash ? ` $${dep.cash}` : ''}${dep.cash && items ? ' +' : ''}${items ? ` ${items} item${items === 1 ? '' : 's'}` : ''}`);
    return true;
  }
}
export { BrainInspector } from './brainPanel';
