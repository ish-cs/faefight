import { AMMO_BOX, CHARGE, ECONOMY, GRENADE, LIFECYCLE, PIECES, WEAPONS } from '../sim/constants';
import type { IslandLayout } from '../sim/map';
import { HOTBAR_SIZE, canAdd, countOf, isGunItem, isHotbarItem, isPieceItem } from '../sim/hotbar';
import type { HotbarItem, Inventory, MatchEvent, PieceKind, PlayerState, ShopItem, Snapshot, VaultAction, WeaponKind } from '../sim/types';
import { dist2D } from '../sim/vec';
import { PIECE_ORDER } from './input';
import { ISLAND_COLORS, ISLAND_NAMES } from './render';
import { endState } from './endState';

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle'] as const;
const LABEL: Record<string, string> = {
  fists: 'Fists', pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle',
  sandbags: 'Sandbags', wood: 'Wood barricade', metal: 'Sheet metal', steel: 'Steel plate', scaffold: 'Scaffold',
  ramp: 'Ramp', container: 'Container', ammo: 'Ammo box', grenade: 'Grenade', charge: 'Breach charge',
};

function priceOf(item: ShopItem): number {
  if ((GUNS as readonly string[]).includes(item)) return WEAPONS[item as WeaponKind].price;
  if (item in PIECES) return PIECES[item as PieceKind].price;
  if (item === 'ammo') return AMMO_BOX.price;
  if (item === 'grenade') return GRENADE.price;
  return CHARGE.price;
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
  pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle',
  sandbags: 'Sandbags', wood: 'Wood', metal: 'Metal', steel: 'Steel', scaffold: 'Scaffold', ramp: 'Ramp', container: 'Container',
  grenade: 'Grenade', charge: 'Charge',
};
const category = (k: HotbarItem) => (isGunItem(k) ? 'gun' : isPieceItem(k) ? 'piece' : k);
// Tiny line icons per category, drawn in currentColor.
const ICONS: Record<string, string> = {
  gun: '<svg viewBox="0 0 24 24"><path d="M3 8h15l2 2h1v3h-6l-1 1h-2l-1 4H7l1-4H3z" fill="currentColor"/></svg>',
  piece: '<svg viewBox="0 0 24 24"><path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  grenade: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="6.5" fill="currentColor"/><path d="M10 7h4v-2h-4zM14 6l4-2" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  charge: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="11" rx="2" fill="currentColor"/><path d="M12 8V4h5" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
};

export type HudContext = {
  /** Locally selected hotbar slot (sent to the sim every input). */
  selected: number;
  ghostOk: boolean | null;
  free: boolean;
  /** Tab mode: pointer released so slots can be dragged. */
  inventory: boolean;
};
export type HudActions = {
  buy(item: ShopItem): void; vault(a: VaultAction): void; closePanel(): void; backToMenu(): void;
  /** Hotbar slot clicked. */
  select(slot: number): void;
  /** Hotbar slot dragged onto another. */
  moveSlot(from: number, to: number): void;
};

export class Hud {
  readonly root = el('div', 'hud');
  private map: IslandLayout[] = [];
  private humanId = 0;
  private me: PlayerState | null = null;
  private snap: Snapshot | null = null;
  private feed: { at: number; node: HTMLElement }[] = [];

  private hp = el('div', 'hp');
  private hpFill = el('div', 'hp-fill');
  private hpText = el('div', 'hp-text');
  private cash = el('div', 'cash');
  private gen = el('div', 'gen');
  private prompt = el('div', 'prompt');
  private weapon = el('div', 'weapon');
  private extras = el('div', 'extras');
  private hotbar = el('div', 'hotbar');
  private hotbarSig = '';
  private dragFrom: number | null = null;
  private timer = el('div', 'timer');
  private seals = el('div', 'seals');
  private banner = el('div', 'banner');
  private sealedBanner = el('div', 'sealed-banner', 'YOUR BUNKER IS SEALED');
  private killfeed = el('div', 'killfeed');
  private center = el('div', 'center-msg');
  private crosshair = el('div', 'crosshair');
  private damage = el('div', 'damage-flash');
  private endScreen = el('div', 'end-screen');
  private fps = el('div', 'fps');
  private panel = el('div', 'panel');
  private panelKind: 'shop' | 'vault' | null = null;
  private vaultCash!: HTMLInputElement;

  constructor(parent: HTMLElement, private act: HudActions) {
    this.hp.append(this.hpFill, this.hpText);
    const tl = el('div', 'tl');
    tl.append(this.cash, this.gen);
    const bl = el('div', 'bl');
    bl.append(this.hp);
    const br = el('div', 'br');
    br.append(this.weapon, this.extras);
    const tc = el('div', 'tc');
    tc.append(this.timer, this.seals, this.banner);
    this.weapon.dataset.testid = 'weapon';
    this.cash.dataset.testid = 'cash';
    this.hotbar.dataset.testid = 'hotbar';
    this.panel.dataset.testid = 'panel';
    this.buildHotbar();
    this.root.append(tl, bl, br, tc, this.hotbar, this.prompt, this.killfeed, this.crosshair, this.center,
      this.sealedBanner, this.damage, this.endScreen, this.fps, this.panel);
    parent.append(this.root);
  }

  setMap(map: IslandLayout[], humanId: number, humanIsland: number) {
    this.map = map;
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
      s.append(el('span', 'hb-key', String(i + 1)), el('span', 'hb-icon'), el('span', 'hb-name'), el('span', 'hb-count'));
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
    const sig = JSON.stringify([me.hotbar, inv.weapons, inv.pieces, inv.grenades, inv.charges, ctx.selected, reloading]);
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
      const cat = k ? category(k) : '';
      if (icon.dataset.cat !== cat) { icon.dataset.cat = cat; icon.innerHTML = cat ? ICONS[cat] : ''; }
      s.dataset.cat = cat;
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

  setFps(n: number) {
    setText(this.fps, `${Math.round(n)} fps`);
  }

  get panelOpen() {
    return this.panelKind !== null;
  }

  /** Prompt/near-station state is computed here from the snapshot so main stays thin. */
  nearStation(): 'shop' | 'vault' | 'generator' | null {
    const me = this.me;
    if (!me || !me.alive) return null;
    const own = this.map[me.island];
    const r = ECONOMY.interactRadius;
    if (own && dist2D(own.shop, me.pos) <= r) return 'shop';
    if (own && dist2D(own.vault, me.pos) <= r) return 'vault';
    if (this.map.some((m) => dist2D(m.generator, me.pos) <= r)) return 'generator';
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
    setText(this.cash, `$${inv.cash}`);

    // Generator stored: shown for whichever generator you're near (yours, or theirs to steal).
    const near = snap.generators
      .map((g) => ({ g, d: dist2D(this.map[g.island].generator, me.pos) }))
      .filter((x) => x.d <= 10).sort((a, b) => a.d - b.d)[0];
    this.gen.style.display = near ? '' : 'none';
    if (near) setText(this.gen, `${near.g.island === me.island ? 'Your generator' : `${ISLAND_NAMES[near.g.island % 8]} generator`}  $${Math.floor(near.g.stored)}`);

    const station = this.nearStation();
    const promptText = isPieceItem(me.hotbar[ctx.selected]) ? '' :
      station === 'shop' ? 'E  Shop' : station === 'vault' ? 'E  Vault' :
      station === 'generator' ? `E  Collect $${Math.floor(near?.g.stored ?? 0)}` : '';
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
    this.crosshair.classList.toggle('build', !!buildKind);

    const left = LIFECYCLE.suddenDeathAt - snap.time;
    setText(this.timer, snap.suddenDeath ? 'SUDDEN DEATH' : fmtClock(left));
    this.timer.classList.toggle('sd', snap.suddenDeath);
    setText(this.banner, snap.suddenDeath ? `Tide rising · water ${snap.waterY.toFixed(1)} m` : left < 60 ? 'Sudden death soon' : '');
    this.banner.style.display = this.banner.textContent ? '' : 'none';

    Array.from(this.seals.children).forEach((chip, i) => {
      const sealed = !!snap.sealed[i];
      chip.classList.toggle('sealed', sealed);
      setText(chip.querySelector('.state') as HTMLElement, sealed ? 'SEALED' : 'OPEN');
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
      if (this.endScreen.dataset.state !== end.state) {
        this.endScreen.dataset.state = end.state;
        const btn = el('button', 'btn', 'Back to menu');
        btn.onclick = () => this.act.backToMenu();
        this.endScreen.replaceChildren(el('div', 'end-title', end.title), el('div', 'end-sub', end.sub), btn);
        this.endScreen.style.display = 'flex';
      }
    }

    if (this.panelKind === 'shop') this.renderShop();
    else if (this.panelKind === 'vault') this.refreshVault();
    this.tickFeed();
  }

  get ended() {
    return this.endScreen.style.display === 'flex';
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
        if (e.data.by === this.humanId) this.flash(this.crosshair, 'hit');
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

  openShop() {
    this.panelKind = 'shop';
    this.panel.className = 'panel open';
    this.panel.dataset.kind = 'shop';
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
        grid.append(el('div', 'shop-section', title));
        for (const item of items) {
          const b = el('button', 'shop-item');
          b.dataset.item = item;
          b.dataset.testid = `buy-${item}`;
          b.append(el('span', 'iname', LABEL[item]), el('span', 'iprice', `$${priceOf(item)}`), el('span', 'inote', ''));
          b.onclick = () => this.act.buy(item);
          grid.append(b);
        }
      };
      section('Weapons', [...GUNS, 'ammo', 'grenade', 'charge']);
      section('Building', PIECE_ORDER);
      this.panel.replaceChildren(this.header('Shop'), el('div', 'panel-cash'), grid);
    }
    setText(this.panel.querySelector('.panel-cash') as HTMLElement, `Carrying $${me.inv.cash}`);
    for (const b of Array.from(this.panel.querySelectorAll<HTMLButtonElement>('.shop-item'))) {
      const item = b.dataset.item as ShopItem;
      let note = '';
      let disabled = me.inv.cash < priceOf(item);
      if ((GUNS as readonly string[]).includes(item) && me.inv.weapons[item as WeaponKind]) { disabled = true; note = 'owned'; }
      else if (isHotbarItem(item) && countOf(me.inv, item) === 0 && !canAdd(me.hotbar, item)) { disabled = true; note = 'Hotbar full'; }
      else if (item === 'ammo') {
        if (me.equipped === 'fists') { disabled = true; note = 'equip a gun'; }
        else note = `+${WEAPONS[me.equipped].mag * AMMO_BOX.mags} ${LABEL[me.equipped]}`;
      } else if (item in PIECES) note = `have ${me.inv.pieces[item as PieceKind] ?? 0}`;
      else if (item === 'grenade') note = `have ${me.inv.grenades}`;
      else if (item === 'charge') note = `have ${me.inv.charges}`;
      if (b.disabled !== disabled) b.disabled = disabled;
      setText(b.querySelector('.inote') as HTMLElement, note);
    }
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
      if (rows.length === 1) rows.push(el('div', 'vault-empty', 'No gear'));
      node.replaceChildren(...rows);
    };
    col('carried');
    col('stored');
  }
}
