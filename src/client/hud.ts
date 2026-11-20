import { CHARGE, ECONOMY, GENERATOR_MAX_LEVEL, GRENADE, LIFECYCLE, MEDKIT, PIECES, POTIONS, SHIELD_MAX, WEAPONS } from '../sim/constants';
import { ammoPerBox, ammoPrice, ammoTarget, generatorSpec, genUpgradePrice, isHomeOnly, lockItem, lockPrice, lockedGunOf } from '../sim/economy';
import type { CenterIsland, IslandLayout } from '../sim/map';
import { HOTBAR_SIZE, POTION_KINDS, canAdd, countOf, isGunItem, isHotbarItem, isPieceItem, isPotionItem } from '../sim/hotbar';
import type { GunKind, HotbarItem, Inventory, MatchEvent, PieceKind, PlayerState, ShopItem, Snapshot, VaultAction, WeaponKind } from '../sim/types';
import { dist2D } from '../sim/vec';
import { PIECE_ORDER } from './input';
import { ISLAND_COLORS, ISLAND_NAMES } from './render';
import { endState } from './endState';
import { ICONS, LOCK_ICON, iconGroup, type IconKind } from './icons';
import { chipState } from './chipState';

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const;
const LABEL: Record<string, string> = {
  fists: 'Fists', pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket launcher',
  sandbags: 'Sandbags', wood: 'Wood barricade', metal: 'Sheet metal', steel: 'Steel plate', scaffold: 'Scaffold',
  ramp: 'Ramp', container: 'Container', ammo: 'Ammo box', grenade: 'Grenade', charge: 'Breach charge', medkit: 'Medkit',
  shieldSmall: 'Small shield potion', shieldBig: 'Big shield potion', healPotion: 'Heal potion', speedPotion: 'Speed potion',
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
  if (isPotionItem(item)) return POTIONS[item].price;
  return CHARGE.price;
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

/** Short hotbar labels (slots are narrow). */
const SHORT: Record<HotbarItem, string> = {
  pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket',
  sandbags: 'Sandbags', wood: 'Wood', metal: 'Metal', steel: 'Steel', scaffold: 'Scaffold', ramp: 'Ramp', container: 'Container',
  grenade: 'Grenade', charge: 'Charge', medkit: 'Medkit',
  shieldSmall: 'Shield S', shieldBig: 'Shield L', healPotion: 'Heal', speedPotion: 'Speed',
};

export type HudContext = {
  /** Locally selected hotbar slot (sent to the sim every input). */
  selected: number;
  ghostOk: boolean | null;
  free: boolean;
  /** I (inventory) mode: pointer released so slots can be dragged. */
  inventory: boolean;
  /** Crosshair gap (px) from the current spread cone; reload progress 0..1 or null; rifle scope up. */
  spreadPx?: number;
  reload?: number | null;
  scoped?: boolean;
};
export type HudActions = {
  buy(item: ShopItem): void; vault(a: VaultAction): void; closePanel(): void; backToMenu(): void;
  /** Hotbar slot clicked. */
  select(slot: number): void;
  /** Hotbar slot dragged onto another. */
  moveSlot(from: number, to: number): void;
  /** End-screen buttons (default: Back to menu). over = the match has a result (not just you eliminated). */
  endButtons?(over: boolean): HTMLElement[];
};

export class Hud {
  readonly root = el('div', 'hud');
  private map: IslandLayout[] = [];
  private centerIsland: CenterIsland | null = null;
  private humanId = 0;
  private me: PlayerState | null = null;
  private snap: Snapshot | null = null;
  private feed: { at: number; node: HTMLElement }[] = [];

  private hp = el('div', 'hp');
  private hpFill = el('div', 'hp-fill');
  private hpText = el('div', 'hp-text');
  private shield = el('div', 'shield');
  private shieldFill = el('div', 'shield-fill');
  private shieldText = el('div', 'shield-text');
  private lastShield = 0;
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
  private dragFrom: number | null = null;
  private timer = el('div', 'timer');
  private seals = el('div', 'seals');
  private banner = el('div', 'banner');
  private sealedBanner = el('div', 'sealed-banner', 'YOUR BUNKER IS SEALED');
  private killfeed = el('div', 'killfeed');
  private center = el('div', 'center-msg');
  private crosshair = el('div', 'crosshair');
  private reloadRing = el('div', 'reload-ring');
  private scope = el('div', 'scope');
  private damage = el('div', 'damage-flash');
  private endScreen = el('div', 'end-screen');
  private fps = el('div', 'fps');
  private panel = el('div', 'panel');
  private panelKind: 'shop' | 'potions' | 'vault' | null = null;
  private vaultCash!: HTMLInputElement;

  constructor(parent: HTMLElement, private act: HudActions) {
    this.hp.append(this.hpFill, this.hpText);
    const tl = el('div', 'tl');
    tl.append(this.cash, this.gen);
    this.shield.append(this.shieldFill, el('div', 'shield-segs'), this.shieldText);
    this.shield.dataset.testid = 'shield';
    this.speedBuff.innerHTML = ICONS.speedPotion;
    this.speedBuff.append(el('span', 'buff-time'));
    this.speedBuff.dataset.testid = 'speed-buff';
    this.buffs.append(this.speedBuff);
    const bl = el('div', 'bl');
    bl.append(this.buffs, this.shield, this.hp);
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
    this.scope.dataset.testid = 'scope';
    this.root.append(tl, bl, br, tc, this.hotbar, this.heal, this.drinkBox, this.prompt, this.killfeed, this.scope, this.crosshair, this.reloadRing, this.center,
      this.sealedBanner, this.damage, this.endScreen, this.fps, this.panel);
    parent.append(this.root);
  }

  setMap(map: IslandLayout[], humanId: number, humanIsland: number, center: CenterIsland | null = null) {
    this.map = map;
    this.centerIsland = center;
    this.humanId = humanId;
    this.seals.replaceChildren(...map.map((isl) => {
      const chip = el('div', 'seal-chip');
      const dot = el('span', 'dot');
      dot.style.background = hex(ISLAND_COLORS[isl.index % 8]);
      chip.append(dot, el('span', 'name', isl.index === humanIsland ? 'You' : ISLAND_NAMES[isl.index % 8]), el('span', 'state', 'OPEN'));
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
      s.append(el('span', 'hb-key', String(i + 1)), el('span', 'hb-icon'), el('span', 'hb-name'), el('span', 'hb-count'), lock);
      return s;
    });
    this.hotbar.replaceChildren(...slots);
    const slotAt = (t: EventTarget | null) => {
      const s = t instanceof Element ? t.closest<HTMLElement>('.hb-slot') : null;
      return s ? Number(s.dataset.slot) : null;
    };
    const clearDrag = () => {
      this.dragFrom = null;
      this.hotbar.classList.remove('dragging');
      slots.forEach((s) => s.classList.remove('drag-src', 'drag-over'));
    };
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
      const to = slotAt(document.elementFromPoint(e.clientX, e.clientY));
      clearDrag();
      if (to === null) return;
      if (to === from) this.act.select(to);
      else this.act.moveSlot(from, to);
    });
  }

  private updateHotbar(me: PlayerState, ctx: HudContext) {
    const inv = me.inv;
    const reloading = me.reloadUntil > 0;
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
      if (k && isGunItem(k)) {
        const a = inv.weapons[k];
        count = a ? `${a.mag}/${a.spare}` : '';
        s.classList.toggle('reloading', reloading && i === ctx.selected);
      } else if (k) count = String(countOf(inv, k));
      setText(s.querySelector('.hb-count') as HTMLElement, count);
    });
  }

  /** Blue shield bar over the health bar (4 × 25 segments), plus the speed-buff timer. */
  private updateShield(me: PlayerState, snap: Snapshot) {
    const sh = Math.max(0, Math.min(SHIELD_MAX, me.shield ?? 0));
    this.shieldFill.style.width = `${(100 * sh) / SHIELD_MAX}%`;
    setText(this.shieldText, sh > 0 ? `${Math.ceil(sh)}` : '');
    this.shield.classList.toggle('empty', sh <= 0);
    if (this.lastShield > 0 && sh <= 0 && me.alive) this.flash(this.shield, 'broke');
    this.lastShield = sh;
    const speedLeft = me.alive ? (me.speedUntil ?? 0) - snap.time : 0;
    this.speedBuff.style.display = speedLeft > 0 ? '' : 'none';
    if (speedLeft > 0) setText(this.speedBuff.querySelector('.buff-time') as HTMLElement, `${Math.ceil(speedLeft)}s`);
  }

  setFps(n: number) {
    setText(this.fps, `${Math.round(n)} fps`);
  }

  get panelOpen() {
    return this.panelKind !== null;
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
    return null;
  }

  update(snap: Snapshot, ctx: HudContext) {
    this.snap = snap;
    const me = snap.players.find((p) => p.id === this.humanId) ?? null;
    this.me = me;
    if (!me) return;
    const inv = me.inv;

    this.hpFill.style.width = `${Math.max(0, me.hp)}%`;
    this.hpFill.classList.toggle('low', me.hp <= 30);
    setText(this.hpText, `${Math.ceil(me.hp)}`);
    this.updateShield(me, snap);
    setText(this.cash, `$${inv.cash}`);

    // Generator stored: shown for whichever generator you're near (yours, or theirs to steal).
    const near = snap.generators
      .map((g) => ({ g, d: dist2D(this.map[g.island].generator, me.pos) }))
      .filter((x) => x.d <= 10).sort((a, b) => a.d - b.d)[0];
    const cg = this.centerIsland && snap.center && dist2D(this.centerIsland.goldGen, me.pos) <= 10 ? snap.center : null;
    this.gen.style.display = near || cg ? '' : 'none';
    if (cg && !near) setText(this.gen, `Gold generator  $${Math.floor(cg.gold)}`);
    else if (near) {
      const lv = snap.genLevels?.[near.g.island] ?? 1;
      setText(this.gen, `${near.g.island === me.island ? 'Your generator' : `${ISLAND_NAMES[near.g.island % 8]} generator`}  $${Math.floor(near.g.stored)} · Lv${lv}`);
    }

    const station = this.nearStation();
    const promptText = isPieceItem(me.hotbar[ctx.selected]) ? '' :
      station === 'shop' ? 'E  Shop' : station === 'potions' ? 'E  Potion seller' : station === 'vault' ? 'E  Vault' :
      station === 'generator' ? `E  Collect $${Math.floor(near?.g.stored ?? 0)}` :
      station === 'gold' ? `E  Collect $${Math.floor(snap.center?.gold ?? 0)}` :
      station === 'supply' ? supplyPrompt(snap.center) : '';
    setText(this.prompt, promptText);
    this.prompt.style.display = promptText && !this.panelKind ? '' : 'none';

    // What's in hand: the selected slot (a gun, a stack of pieces/explosives) or fists.
    const held = me.hotbar[ctx.selected] ?? null;
    const buildKind = isPieceItem(held) ? held : null;
    const ammo = isGunItem(held) ? inv.weapons[held] : undefined;
    const reloading = me.reloadUntil > 0;
    const heldText = ammo ? `${ammo.mag}/${ammo.spare}` : held && !isGunItem(held) ? `×${countOf(inv, held)}` : '';
    this.weapon.replaceChildren(el('span', 'wname', held ? LABEL[held] : 'Fists'), el('span', 'ammo', heldText));
    this.weapon.classList.toggle('reloading', reloading);
    setText(this.extras, reloading ? 'Reloading…' : '');
    this.extras.style.display = reloading ? '' : 'none';

    this.updateHotbar(me, ctx);
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

    const left = LIFECYCLE.suddenDeathAt - snap.time;
    setText(this.timer, snap.suddenDeath ? 'SUDDEN DEATH' : fmtClock(left));
    this.timer.classList.toggle('sd', snap.suddenDeath);
    setText(this.banner, snap.suddenDeath ? `Tide rising · water ${snap.waterY.toFixed(1)} m` : left < 60 ? 'Sudden death soon' : '');
    this.banner.style.display = this.banner.textContent ? '' : 'none';

    Array.from(this.seals.children).forEach((chip, i) => {
      const sealed = !!snap.sealed[i];
      const out = !!snap.players.find((p) => p.island === i)?.eliminated;
      chip.classList.toggle('sealed', sealed && !out);
      chip.classList.toggle('out', out);
      setText(chip.querySelector('.state') as HTMLElement, chipState(sealed, out));
      // Other islands are labelled with their owner's name (a leaver's seat stays theirs, now bot-run).
      const owner = i === me.island ? null : snap.players.find((p) => p.island === i);
      if (owner) setText(chip.querySelector('.name') as HTMLElement, owner.name);
    });
    const ownSealed = !!snap.sealed[me.island];
    const trapped = me.alive && me.breakoutUntil != null;
    setText(this.sealedBanner, trapped
      ? `BREAK OUT! ${Math.max(0, me.breakoutUntil! - snap.time).toFixed(1)}s`
      : 'YOUR BUNKER IS SEALED');
    this.sealedBanner.style.display = (ownSealed || trapped) && !me.eliminated && snap.winner === null ? 'block' : 'none';

    if (!me.alive && !me.eliminated && me.respawnAt !== null) {
      setText(this.center, ownSealed ? `Bunker sealed — you'll respawn trapped in ${Math.max(0, me.respawnAt - snap.time).toFixed(1)}s with 10s to break out` : `Respawning in ${Math.max(0, me.respawnAt - snap.time).toFixed(1)}s`);
      this.center.style.display = 'block';
    } else if (buildKind) {
      const have = inv.pieces[buildKind] ?? 0;
      setText(this.center, `Build: ${LABEL[buildKind]} (${have})  ·  Z/X rotate  ·  ${ctx.free ? 'free place' : 'Alt free place'}`);
      this.center.style.display = 'block';
      this.center.classList.add('small');
    } else {
      this.center.style.display = 'none';
    }
    if (!buildKind) this.center.classList.remove('small');

    const end = endState(snap.winner, this.humanId, me.eliminated, snap.players);
    if (end) {
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

    if (this.panelKind === 'shop' || this.panelKind === 'potions') this.renderShop();
    else if (this.panelKind === 'vault') this.refreshVault();
    this.tickFeed();
  }

  get ended() {
    return this.endScreen.style.display === 'flex';
  }

  /** Hide / bring back the end screen (spectating after elimination or the match end). */
  setEndVisible(v: boolean) {
    if (this.endScreen.dataset.key) this.endScreen.style.display = v ? 'flex' : 'none';
  }

  pushEvents(events: MatchEvent[]) {
    const snap = this.snap;
    const name = (id: unknown) => {
      if (typeof id !== 'number') return null;
      return id === this.humanId ? 'You' : snap?.players.find((p) => p.id === id)?.name ?? `#${id}`;
    };
    for (const e of events) {
      if (e.type === 'kill') {
        const victim = name(e.data.victim ?? e.data.target), killer = name(e.data.killer ?? e.data.by);
        this.addFeed(killer && killer !== victim ? `${killer}  ✕  ${victim}` : `${victim} died`);
      } else if (e.type === 'sealed' || e.type === 'unsealed') {
        const isl = e.data.island as number | undefined;
        this.addFeed(`${isl === this.me?.island ? 'Your' : `${ISLAND_NAMES[(isl ?? 0) % 8]}'s`} bunker ${e.type === 'sealed' ? 'SEALED' : 'reopened'}`, e.type === 'sealed');
      } else if (e.type === 'eliminated') {
        this.addFeed(`${name(e.data.player ?? e.data.id) ?? 'Someone'} eliminated`, true);
      } else if (e.type === 'suddenDeath') {
        this.addFeed('Sudden death: generators stopped, tide rising', true);
      } else if (e.type === 'hit') {
        if (e.data.by === this.humanId && e.data.target !== this.humanId) {
          this.crosshair.classList.toggle('head', e.data.part === 'head');
          this.flash(this.crosshair, 'hit');
        }
        if (e.data.target === this.humanId) this.flash(this.damage, 'on');
      }
    }
  }

  private flash(node: HTMLElement, cls: string) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  private addFeed(text: string, alert = false) {
    const node = el('div', `feed-item${alert ? ' alert' : ''}`, text);
    this.killfeed.prepend(node);
    this.feed.unshift({ at: performance.now(), node });
    while (this.feed.length > 5) this.feed.pop()!.node.remove();
  }

  private tickFeed() {
    const now = performance.now();
    this.feed = this.feed.filter((f) => {
      if (now - f.at < 6000) return true;
      f.node.remove();
      return false;
    });
  }

  // ---- panels ---------------------------------------------------------------------------------

  /** The home shop, or a potion seller's counter (`potions`). */
  openShop(kind: 'shop' | 'potions' = 'shop') {
    this.panelKind = kind;
    this.panel.className = 'panel open';
    this.panel.dataset.kind = kind;
    this.renderShop(true);
  }

  openVault() {
    this.panelKind = 'vault';
    this.panel.className = 'panel open';
    this.panel.dataset.kind = 'vault';
    this.renderVault();
  }

  closePanel() {
    this.panelKind = null;
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
    const me = this.me;
    if (!me) return;
    if (rebuild || !this.panel.querySelector('.shop-grid')) {
      const grid = el('div', 'shop-grid');
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
          b.append(icon, el('span', 'iprice', `$${priceOf(item)}`), el('span', 'ibadge'), el('span', 'istatus'), lock);
          b.onclick = () => { if (b.getAttribute('aria-disabled') !== 'true') this.act.buy(item); };
          row.append(b);
        }
        grid.append(el('div', 'shop-section', title), row);
      };
      if (this.panelKind === 'potions') {
        section('Potions', [...POTION_KINDS]);
      } else {
        section('Weapons', [...GUNS, 'ammo']);
        section('Building', PIECE_ORDER);
        section('Gear', ['grenade', 'charge', 'medkit']);
        // Lock cards only show up once you own (or have locked) that gun.
        section('Upgrades', ['genUpgrade', ...GUNS.map(lockItem)]);
      }
      this.panel.replaceChildren(this.header(this.panelKind === 'potions' ? 'Potion seller' : 'Shop'), el('div', 'panel-cash'), grid);
      // Focus the panel (not a card, so no tooltip pops up): Tab or an arrow key then walks the cards.
      this.panel.tabIndex = -1;
      this.panel.onkeydown = (e) => this.shopArrows(e);
      this.panel.focus({ preventScroll: true });
    }
    setText(this.panel.querySelector('.panel-cash') as HTMLElement, `Carrying $${me.inv.cash}`);
    const genLevel = this.snap?.genLevels?.[me.island] ?? 1;
    // Any island's shop NPC sells to you, but upgrades and locks only at your own.
    const atHome = !!this.map[me.island] && dist2D(this.map[me.island].shop, me.pos) <= ECONOMY.interactRadius;
    for (const b of Array.from(this.panel.querySelectorAll<HTMLButtonElement>('.shop-item'))) {
      const item = b.dataset.item as ShopItem;
      const price = priceOf(item, genLevel, me);
      setText(b.querySelector('.iprice') as HTMLElement, `$${price}`);
      const poor = me.inv.cash < price;
      const lockGun = lockedGunOf(item);
      let status = '';
      let badge = '';
      setText(b.querySelector('.iprice') as HTMLElement, `$${price}`);
      b.classList.toggle('show-lock', !!lockGun || ((GUNS as readonly string[]).includes(item) && me.locked.includes(item as GunKind)));
      if (item === 'genUpgrade') {
        const next = Math.min(GENERATOR_MAX_LEVEL, genLevel + 1), spec = generatorSpec(next);
        b.dataset.name = genLevel >= GENERATOR_MAX_LEVEL ? `Generator Lv${genLevel} (max)` : `Generator ↑ Lv${next}: $${spec.rate}/s, holds $${spec.cap}`;
        if (genLevel >= GENERATOR_MAX_LEVEL) status = 'Max';
        else badge = `Lv${next}`;
      } else if (lockGun) {
        const locked = me.locked.includes(lockGun);
        b.hidden = !locked && !me.inv.weapons[lockGun];
        b.dataset.name = `Lock ${LABEL[lockGun]}: respawn with it`;
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
    const cashRow = el('div', 'vault-cash');
    this.vaultCash = el('input', 'cash-input');
    this.vaultCash.type = 'number';
    this.vaultCash.min = '0';
    this.vaultCash.placeholder = 'Amount';
    this.vaultCash.dataset.testid = 'vault-amount';
    const amt = () => Math.max(0, Math.floor(Number(this.vaultCash.value) || 0));
    const btn = (t: string, f: () => void, id: string) => { const b = el('button', 'btn small', t); b.onclick = f; b.dataset.testid = id; return b; };
    cashRow.append(this.vaultCash,
      btn('Deposit', () => amt() && this.act.vault({ deposit: { cash: amt() } }), 'vault-deposit'),
      btn('Withdraw', () => amt() && this.act.vault({ withdraw: { cash: amt() } }), 'vault-withdraw'),
      btn('Deposit all', () => this.me && this.me.inv.cash > 0 && this.act.vault({ deposit: { cash: this.me.inv.cash } }), 'vault-deposit-all'),
      btn('Withdraw all', () => this.me && this.me.vault.cash > 0 && this.act.vault({ withdraw: { cash: this.me.vault.cash } }), 'vault-withdraw-all'));
    const cols = el('div', 'vault-cols');
    cols.append(el('div', 'vault-col carried'), el('div', 'vault-col stored'));
    this.panel.replaceChildren(this.header('Vault'), cashRow, cols);
    this.refreshVault(true);
  }

  private vaultSig = '';

  private refreshVault(force = false) {
    const me = this.me;
    if (!me) return;
    const sig = JSON.stringify([me.inv, me.vault]);
    if (!force && sig === this.vaultSig) return;
    this.vaultSig = sig;
    const col = (side: 'carried' | 'stored') => {
      const inv: Inventory = side === 'carried' ? me.inv : me.vault;
      const verb = side === 'carried' ? 'deposit' : 'withdraw';
      const node = this.panel.querySelector(`.vault-col.${side}`) as HTMLElement;
      const rows: HTMLElement[] = [el('div', 'vault-col-title', `${side === 'carried' ? 'Carried' : 'In vault'} · $${inv.cash}`)];
      const row = (label: string, req: VaultAction['deposit']) => {
        const r = el('div', 'vault-row');
        const b = el('button', 'btn small', side === 'carried' ? 'Store →' : '← Take');
        b.onclick = () => this.act.vault({ [verb]: req });
        r.append(el('span', '', label), b);
        rows.push(r);
      };
      for (const [k, a] of Object.entries(inv.weapons)) if (a) row(`${LABEL[k]}  ${a.mag}/${a.spare}`, { weapons: { [k]: a } });
      for (const [k, n] of Object.entries(inv.pieces)) if (n) row(`${LABEL[k]} ×${n}`, { pieces: { [k]: n } });
      if (inv.grenades) row(`Grenades ×${inv.grenades}`, { grenades: inv.grenades });
      if (inv.charges) row(`Charges ×${inv.charges}`, { charges: inv.charges });
      if (inv.medkits) row(`Medkits ×${inv.medkits}`, { medkits: inv.medkits });
      for (const [k, n] of Object.entries(inv.potions ?? {})) if (n) row(`${LABEL[k]} ×${n}`, { potions: { [k]: n } });
      if (rows.length === 1) rows.push(el('div', 'vault-empty', 'No gear'));
      node.replaceChildren(...rows);
    };
    col('carried');
    col('stored');
  }
}
