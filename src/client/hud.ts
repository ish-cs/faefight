import { AMMO_BOX, CHARGE, ECONOMY, GRENADE, LIFECYCLE, PIECES, WEAPONS } from '../sim/constants';
import type { IslandLayout } from '../sim/map';
import type { Inventory, MatchEvent, PieceKind, PlayerState, ShopItem, Snapshot, VaultAction, WeaponKind } from '../sim/types';
import { dist2D } from '../sim/vec';
import { PIECE_ORDER } from './input';
import { ISLAND_COLORS, ISLAND_NAMES } from './render';

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

export type HudContext = { buildMode: boolean; buildKind: PieceKind; ghostOk: boolean | null; free: boolean };
export type HudActions = { buy(item: ShopItem): void; vault(a: VaultAction): void; closePanel(): void; backToMenu(): void };

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
  private pieces = el('div', 'pieces');
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
    this.pieces.dataset.testid = 'pieces';
    this.panel.dataset.testid = 'panel';
    this.root.append(tl, bl, br, tc, this.pieces, this.prompt, this.killfeed, this.crosshair, this.center,
      this.sealedBanner, this.damage, this.endScreen, this.fps, this.panel);
    parent.append(this.root);
  }

  setMap(map: IslandLayout[], humanId: number) {
    this.map = map;
    this.humanId = humanId;
    this.seals.replaceChildren(...map.map((isl) => {
      const chip = el('div', 'seal-chip');
      const dot = el('span', 'dot');
      dot.style.background = hex(ISLAND_COLORS[isl.index % 8]);
      chip.append(dot, el('span', 'name', isl.index === map[humanId]?.index ? 'You' : ISLAND_NAMES[isl.index % 8]), el('span', 'state', 'OPEN'));
      return chip;
    }));
    this.pieces.replaceChildren(...PIECE_ORDER.map((k, i) => {
      const s = el('div', 'piece-slot');
      s.dataset.kind = k;
      s.append(el('span', 'key', String(i + 1)), el('span', 'pname', LABEL[k]), el('span', 'count', '0'));
      return s;
    }));
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
    const promptText = ctx.buildMode ? '' :
      station === 'shop' ? 'E  Shop' : station === 'vault' ? 'E  Vault' :
      station === 'generator' ? `E  Collect $${Math.floor(near?.g.stored ?? 0)}` : '';
    setText(this.prompt, promptText);
    this.prompt.style.display = promptText && !this.panelKind ? '' : 'none';

    const w = me.equipped;
    const ammo = w === 'fists' ? null : inv.weapons[w];
    const reloading = me.reloadUntil > 0;
    this.weapon.replaceChildren(el('span', 'wname', LABEL[w]), el('span', 'ammo', ammo ? `${ammo.mag}/${ammo.spare}` : ''));
    this.weapon.classList.toggle('reloading', reloading);
    setText(this.extras, `${reloading ? 'Reloading…  ' : ''}Grenades ${inv.grenades}  ·  Charges ${inv.charges}`);

    this.pieces.classList.toggle('build', ctx.buildMode);
    for (const slot of Array.from(this.pieces.children) as HTMLElement[]) {
      const k = slot.dataset.kind as PieceKind;
      const n = inv.pieces[k] ?? 0;
      setText(slot.querySelector('.count') as HTMLElement, String(n));
      slot.classList.toggle('empty', n === 0);
      slot.classList.toggle('selected', ctx.buildMode && ctx.buildKind === k);
    }
    this.pieces.dataset.ghost = ctx.ghostOk === null ? 'none' : ctx.ghostOk ? 'ok' : 'blocked';
    this.crosshair.classList.toggle('build', ctx.buildMode);

    const left = LIFECYCLE.suddenDeathAt - snap.time;
    setText(this.timer, snap.suddenDeath ? 'SUDDEN DEATH' : fmtClock(left));
    this.timer.classList.toggle('sd', snap.suddenDeath);
    setText(this.banner, snap.suddenDeath ? `Tide rising · water ${snap.waterY.toFixed(1)} m` : left < 60 ? 'Sudden death soon' : '');
    this.banner.style.display = this.banner.textContent ? '' : 'none';

    Array.from(this.seals.children).forEach((chip, i) => {
      const sealed = !!snap.sealed[i];
      chip.classList.toggle('sealed', sealed);
      setText(chip.querySelector('.state') as HTMLElement, sealed ? 'SEALED' : 'OPEN');
    });
    const ownSealed = !!snap.sealed[me.island];
    this.sealedBanner.style.display = ownSealed && !me.eliminated && snap.winner === null ? 'block' : 'none';

    if (!me.alive && !me.eliminated && me.respawnAt !== null) {
      setText(this.center, ownSealed ? `Bunker sealed — respawn in ${(me.respawnAt - snap.time).toFixed(1)}s unless you're cleared` : `Respawning in ${Math.max(0, me.respawnAt - snap.time).toFixed(1)}s`);
      this.center.style.display = 'block';
    } else if (ctx.buildMode) {
      const have = inv.pieces[ctx.buildKind] ?? 0;
      setText(this.center, `Build: ${LABEL[ctx.buildKind]} (${have})${ctx.free ? ' · free place' : ''}${have === 0 ? ' — buy some at your shop' : ''}`);
      this.center.style.display = 'block';
      this.center.classList.add('small');
    } else {
      this.center.style.display = 'none';
    }
    if (!ctx.buildMode) this.center.classList.remove('small');

    const won = snap.winner !== null && snap.winner === this.humanId;
    const lost = (snap.winner !== null && snap.winner !== this.humanId) || me.eliminated;
    if (won || lost) {
      if (this.endScreen.dataset.state !== (won ? 'won' : 'lost')) {
        this.endScreen.dataset.state = won ? 'won' : 'lost';
        const btn = el('button', 'btn', 'Back to menu');
        btn.onclick = () => this.act.backToMenu();
        this.endScreen.replaceChildren(
          el('div', 'end-title', won ? 'VICTORY' : me.eliminated ? 'ELIMINATED' : 'DEFEAT'),
          el('div', 'end-sub', won ? 'Last one standing.' : snap.winner !== null ? `${snap.players.find((p) => p.id === snap.winner)?.name ?? 'Someone'} wins.` : 'Your bunker was sealed when you died.'),
          btn,
        );
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
