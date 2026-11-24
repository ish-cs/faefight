import { countOf, HOTBAR_SIZE } from '../sim/hotbar';
import type { HotbarItem, Loadout, PlayerState, VaultAction } from '../sim/types';
import { VAULT_LEVELS, VAULT_MAX_LEVEL } from '../sim/constants';
import { bankAboveLoadout, emptyLoadout, funds, isUnit as isUnitKind, itemUnits, LOADOUT_MAX_KEEP, vaultLevel, vaultSpec, vaultUpgradePrice } from '../sim/vault';
import { ICONS, iconGroup } from './icons';
import { bumpLoadout, cellCount, keepCashAction, loadoutKinds, moveAction, moveCount, vaultCells, type MoveMods } from './vaultUi';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const setText = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };

/** Smallest vault grid (empty cells pad it so it reads as storage, and is a big drop target). */
const MIN_VAULT_CELLS = 12;
const DRAG_PX = 5;

type Side = 'carried' | 'stored';
type Drag = { kind: HotbarItem; from: Side; cell: HTMLElement; x0: number; y0: number; shift: boolean; one: boolean; moved: boolean; ghost: HTMLElement | null };

export const VAULT_HINT = 'Drag between hotbar and vault · Shift-drag half · Ctrl/Alt-drag one · Shift-click whole stack · scroll a stack or type an amount for an exact count · hold E at the vault to quick-bank';
export const DEATH_HINT = 'Carried cash and items drop when you die. The vault is always safe, and shops take vault cash too.';

/**
 * The vault panel: hotbar and vault as icon grids with drag and drop (split stacks by modifier, wheel or amount
 * box), one-click cash moves, quick-bank, and the restock loadout editor. Renders into the HUD's panel element;
 * every change goes out as a VaultAction (moves need you at your vault; the loadout is accepted anywhere).
 */
export class VaultPanel {
  private carriedGrid = el('div', 'vault-grid carried');
  private storedGrid = el('div', 'vault-grid stored');
  private carriedTitle = el('div', 'vault-col-title');
  private storedTitle = el('div', 'vault-col-title');
  private amount = el('input', 'cash-input vault-amount');
  private keep = el('input', 'cash-input');
  private info = el('div', 'shop-info', VAULT_HINT);
  private loadoutBox = el('div', 'vl-items');
  private loadoutTitle = el('div', 'vault-col-title');
  private loadoutKeep = el('input', 'cash-input');
  private loadoutBuy = el('input');
  private levelText = el('div', 'vault-level-text');
  private upgradeBtn = el('button', 'btn small vault-upgrade');
  private drag: Drag | null = null;
  private wheelAcc = 0;
  private sig = '';
  private me: PlayerState | null = null;
  /** Loadout as edited here (sent on every change; the sim's copy catches up a tick later). */
  private draft: Loadout = emptyLoadout();

  constructor(private root: HTMLElement, private send: (a: VaultAction) => void) {}

  /** Full build (panel opened). */
  render(header: HTMLElement, me: PlayerState) {
    this.me = me;
    this.draft = structuredClone(me.loadout ?? emptyLoadout());
    const btn = (t: string, tip: string, id: string, f: () => void) => {
      const b = el('button', 'btn small', t);
      b.type = 'button';
      b.dataset.testid = id;
      b.onclick = f;
      this.tip(b, tip);
      return b;
    };
    const money = el('div', 'vault-cash');
    this.keep.type = 'number'; this.keep.min = '0'; this.keep.placeholder = 'Keep $'; this.keep.dataset.testid = 'vault-keep-input';
    this.tip(this.keep, 'Carried cash to keep on you: Keep banks the rest (or takes what is missing out of the vault)');
    money.append(
      btn('Deposit cash', 'Bank all carried cash (it drops if you die)', 'vault-deposit-all', () => {
        const m = this.me; if (m && m.inv.cash > 0) this.send({ deposit: { cash: Math.floor(m.inv.cash) } });
      }),
      btn('Withdraw all', 'Take all vault cash (shops take vault cash anyway)', 'vault-withdraw-all', () => {
        const m = this.me; if (m && m.vault.cash >= 1) this.send({ withdraw: { cash: Math.floor(m.vault.cash) } });
      }),
      this.keep,
      btn('Keep', 'Keep this much carried cash on you; the rest goes in the vault', 'vault-keep', () => {
        const m = this.me; const v = Number(this.keep.value);
        if (!m || this.keep.value === '' || !Number.isFinite(v)) return;
        const a = keepCashAction(m.inv.cash, m.vault.cash, v);
        if (a) this.send(a);
      }),
      btn('Quick-bank', 'Bank everything above your restock loadout (same as holding E at the vault)', 'vault-quick-bank', () => this.quickBank()),
    );
    const warn = el('div', 'vault-warn', DEATH_HINT);
    warn.dataset.testid = 'vault-death-hint';
    const level = el('div', 'vault-level');
    this.levelText.dataset.testid = 'vault-level';
    this.upgradeBtn.type = 'button';
    this.upgradeBtn.dataset.testid = 'vault-upgrade';
    this.upgradeBtn.onclick = () => { if (this.upgradeBtn.getAttribute('aria-disabled') !== 'true') this.send({ upgrade: true }); };
    this.upgradeBtn.addEventListener('mouseenter', () => { setText(this.info, this.upgradeBtn.title); this.info.classList.add('on'); });
    this.upgradeBtn.addEventListener('mouseleave', () => { setText(this.info, VAULT_HINT); this.info.classList.remove('on'); });
    level.append(this.levelText, this.upgradeBtn);

    const cols = el('div', 'vault-cols');
    const col = (title: HTMLElement, grid: HTMLElement, side: Side) => {
      const c = el('div', `vault-col ${side}`);
      grid.dataset.drop = side;
      grid.dataset.testid = `vault-grid-${side}`;
      c.append(title, grid);
      return c;
    };
    cols.append(col(this.carriedTitle, this.carriedGrid, 'carried'), col(this.storedTitle, this.storedGrid, 'stored'));

    const amountRow = el('div', 'vault-amount-row');
    this.amount.type = 'number'; this.amount.min = '0'; this.amount.placeholder = 'All'; this.amount.dataset.testid = 'vault-move-amount';
    this.tip(this.amount, 'Exact amount per move (blank = the whole stack, or half / one with Shift / Ctrl while dragging)');
    const sortBtn = btn('Sort', 'The vault is always sorted: guns, pieces, gear, potions', 'vault-sort', () => this.refresh(this.me!, true));
    amountRow.append(el('span', 'vault-k', 'Move amount'), this.amount, sortBtn);

    const lo = el('div', 'vault-loadout');
    lo.dataset.testid = 'vault-loadout';
    this.loadoutKeep.type = 'number'; this.loadoutKeep.min = '0'; this.loadoutKeep.max = String(LOADOUT_MAX_KEEP); this.loadoutKeep.placeholder = '$0';
    this.loadoutKeep.dataset.testid = 'loadout-keep';
    this.loadoutKeep.onchange = () => this.editLoadout({ ...this.draft, keep: Math.max(0, Math.min(LOADOUT_MAX_KEEP, Math.floor(Number(this.loadoutKeep.value) || 0))) });
    this.tip(this.loadoutKeep, 'Carried cash the vault hands you on every respawn');
    this.loadoutBuy.type = 'checkbox'; this.loadoutBuy.dataset.testid = 'loadout-buy';
    this.loadoutBuy.onchange = () => this.editLoadout({ ...this.draft, buy: this.loadoutBuy.checked });
    const buyLabel = el('label', 'vl-buy');
    buyLabel.append(this.loadoutBuy, el('span', '', 'Buy what the vault lacks with vault cash'));
    this.tip(buyLabel, 'On respawn, anything the vault is short of is bought at shop price from vault cash');
    const keepLabel = el('label', 'vl-keep');
    keepLabel.append(el('span', '', 'Keep $ on me'), this.loadoutKeep);
    const opts = el('div', 'vl-opts');
    opts.append(keepLabel, buyLabel);
    lo.append(this.loadoutTitle, this.loadoutBox, opts);

    this.info.dataset.testid = 'vault-info';
    this.root.replaceChildren(header, money, warn, level, cols, amountRow, lo, this.info);
    this.root.oncontextmenu = (e) => e.preventDefault(); // Ctrl-click on a Mac is a right click
    this.refresh(me, true);
  }

  /** Live update from the latest snapshot (cheap when nothing changed; deferred while dragging). */
  refresh(me: PlayerState, force = false) {
    this.me = me;
    if (this.drag) return;
    const sig = JSON.stringify([me.inv, me.vault, me.hotbar, me.loadout ?? null, me.vaultLevel ?? 1]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    setText(this.carriedTitle, `Hotbar · $${Math.floor(me.inv.cash)} carried`);
    const spec = vaultSpec(me), lv = vaultLevel(me);
    setText(this.storedTitle, `Vault · $${Math.floor(me.vault.cash)} banked · ${itemUnits(me.vault)}/${spec.storage} items`);
    const perMin = Math.floor(Math.min(me.vault.cash, spec.base) * spec.rate);
    setText(this.levelText, `Vault Lv${lv} · ${Math.round(spec.rate * 100)}%/min interest on up to $${spec.base} (now +$${perMin}/min)${spec.remote ? ' · deposits from anywhere on your island (H)' : ''}`);
    const price = vaultUpgradePrice(lv);
    if (price === null) {
      setText(this.upgradeBtn, `Lv${VAULT_MAX_LEVEL} · max`);
      this.upgradeBtn.setAttribute('aria-disabled', 'true');
      this.upgradeBtn.title = 'Fully upgraded';
    } else {
      const next = VAULT_LEVELS[lv];
      setText(this.upgradeBtn, `Upgrade → Lv${lv + 1} · $${price}`);
      this.upgradeBtn.setAttribute('aria-disabled', String(funds(me) < price));
      this.upgradeBtn.title = `Lv${lv + 1}: ${Math.round(next.rate * 100)}%/min interest on up to $${next.base}, ${next.storage} item storage, ${next.kinds} loadout kinds${next.remote ? ', deposit from anywhere on your island (H)' : ''}${funds(me) < price ? ` · need $${price - funds(me)} more` : ''}`;
    }
    const carried: HTMLElement[] = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const k = me.hotbar[i];
      carried.push(k && countOf(me.inv, k) > 0 ? this.cell(k, 'carried', me, `vault-hot-${i}`) : this.emptyCell());
    }
    this.carriedGrid.replaceChildren(...carried);
    const stored = vaultCells(me.vault).map((c) => this.cell(c.kind, 'stored', me, `vault-store-${c.kind}`));
    while (stored.length < MIN_VAULT_CELLS) stored.push(this.emptyCell());
    this.storedGrid.replaceChildren(...stored);
    if (document.activeElement !== this.loadoutKeep) this.loadoutKeep.value = this.draft.keep ? String(this.draft.keep) : '';
    this.loadoutBuy.checked = this.draft.buy;
    this.renderLoadout(me);
  }

  private emptyCell() {
    const c = el('div', 'vcell empty');
    return c;
  }

  private cell(kind: HotbarItem, side: Side, me: PlayerState, id: string): HTMLElement {
    const inv = side === 'carried' ? me.inv : me.vault;
    const c = el('div', 'vcell');
    c.dataset.kind = kind;
    c.dataset.side = side;
    c.dataset.testid = id;
    c.dataset.group = iconGroup(kind);
    c.dataset.count = String(countOf(inv, kind));
    const icon = el('span', 'sicon');
    icon.innerHTML = ICONS[kind];
    c.append(icon, el('span', 'vcount', cellCount(kind, inv)));
    const name = LABELS[kind] ?? kind;
    c.setAttribute('aria-label', `${name} ${cellCount(kind, inv)} (${side === 'carried' ? 'carried' : 'in vault'})`);
    this.tip(c, `${name} ${cellCount(kind, inv)} · ${side === 'carried' ? 'drag into the vault' : 'drag onto your hotbar'} (Shift half · Ctrl one · Shift-click all · scroll for an exact amount)`);
    c.onpointerdown = (e) => this.down(e, c, kind, side);
    c.onpointermove = (e) => this.move(e);
    c.onpointerup = (e) => this.up(e);
    c.onpointercancel = () => this.endDrag();
    c.onwheel = (e) => this.wheel(e, Number(c.dataset.count));
    return c;
  }

  private mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
    return { shift: e.shiftKey, one: e.ctrlKey || e.altKey || e.metaKey };
  }

  private down(e: PointerEvent, cell: HTMLElement, kind: HotbarItem, from: Side) {
    if (e.button !== 0) return;
    e.preventDefault();
    cell.setPointerCapture?.(e.pointerId);
    this.drag = { kind, from, cell, x0: e.clientX, y0: e.clientY, ...this.mods(e), moved: false, ghost: null };
  }

  private exact(): number {
    const v = Math.floor(Number(this.amount.value));
    return this.amount.value !== '' && Number.isFinite(v) && v > 0 ? v : 0;
  }

  private count(d: Drag, m: Pick<MoveMods, 'shift' | 'one' | 'drag'>, ignoreExact = false): number {
    const me = this.me;
    if (!me) return 0;
    const have = countOf(d.from === 'carried' ? me.inv : me.vault, d.kind);
    return moveCount(d.kind, have, { ...m, exact: ignoreExact ? 0 : this.exact() });
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
    if (!d.moved) {
      d.moved = true;
      d.ghost = el('div', 'vcell vghost');
      d.ghost.dataset.group = iconGroup(d.kind);
      d.ghost.innerHTML = ICONS[d.kind];
      d.ghost.append(el('span', 'vcount'));
      document.body.append(d.ghost);
      d.cell.classList.add('dragging');
    }
    const m = this.mods(e);
    const n = this.count(d, { shift: d.shift || m.shift, one: d.one || m.one, drag: true });
    setText(d.ghost!.querySelector('.vcount') as HTMLElement, `×${n}`);
    d.ghost!.style.transform = `translate(${e.clientX - 26}px, ${e.clientY - 26}px)`;
    const over = this.dropSide(e);
    this.carriedGrid.classList.toggle('drop-on', over === 'carried' && d.from !== 'carried');
    this.storedGrid.classList.toggle('drop-on', over === 'stored' && d.from !== 'stored');
  }

  private dropSide(e: PointerEvent): Side | null {
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop]');
    return (t?.dataset.drop as Side | undefined) ?? null;
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const me = this.me;
    const m = this.mods(e);
    const shift = d.shift || m.shift, one = d.one || m.one;
    const target = d.moved ? this.dropSide(e) : null;
    this.endDrag();
    if (!me) return;
    const to: Side = d.from === 'carried' ? 'stored' : 'carried';
    let n = 0;
    if (!d.moved) n = shift ? this.count(d, { shift: false, one: false, drag: false }, true) : this.count(d, { shift: false, one, drag: one });
    else if (target === to) n = this.count(d, { shift, one, drag: true });
    const a = moveAction(d.kind, n, d.from, d.from === 'carried' ? me.inv : me.vault);
    if (a?.deposit && itemUnits(me.vault) + (isUnitKind(d.kind) ? 1 : n) > vaultSpec(me).storage) {
      setText(this.info, `Vault full: Lv${vaultLevel(me)} holds ${vaultSpec(me).storage} items (upgrade for more)`);
      this.info.classList.add('on');
      return;
    }
    if (a) this.send(a);
  }

  private endDrag() {
    const d = this.drag;
    this.drag = null;
    d?.ghost?.remove();
    d?.cell.classList.remove('dragging');
    this.carriedGrid.classList.remove('drop-on');
    this.storedGrid.classList.remove('drop-on');
    if (this.me) this.refresh(this.me);
  }

  /** Scroll over a stack: +1 / -1 on the amount box (trackpads send many small deltas). */
  private wheel(e: WheelEvent, max: number) {
    e.preventDefault();
    this.wheelAcc += e.deltaY;
    if (Math.abs(this.wheelAcc) < 30) return;
    const step = this.wheelAcc < 0 ? 1 : -1;
    this.wheelAcc = 0;
    const v = Math.max(0, Math.min(max, this.exact() + step));
    this.amount.value = v ? String(v) : '';
    setText(this.info, v ? `Moves ${v} per click or drag (scroll or type to change, clear for the whole stack)` : VAULT_HINT);
    this.info.classList.toggle('on', true);
  }

  /** Everything above the restock loadout into the vault (also hold E at the vault). */
  quickBank() {
    const me = this.me;
    if (!me) return;
    const dep = bankAboveLoadout({ ...me, loadout: this.draft });
    if (dep) this.send({ deposit: dep });
  }

  private editLoadout(l: Loadout) {
    this.draft = l;
    this.send({ loadout: l });
    if (this.me) this.renderLoadout(this.me);
  }

  private renderLoadout(me: PlayerState) {
    const used = Object.values(this.draft.items).filter((n) => (n ?? 0) > 0).length;
    const maxKinds = vaultSpec(me).kinds;
    setText(this.loadoutTitle, `Restock on respawn · ${used}/${maxKinds} kinds`);
    const rows: HTMLElement[] = [];
    for (const kind of loadoutKinds(me.inv, me.vault, this.draft)) {
      const n = this.draft.items[kind] ?? 0;
      const r = el('div', `vl-item${n > 0 ? ' on' : ''}`);
      r.dataset.group = iconGroup(kind);
      const icon = el('span', 'sicon');
      icon.innerHTML = ICONS[kind];
      const step = (t: string, d: number, id: string) => {
        const b = el('button', 'vl-step', t);
        b.type = 'button';
        b.dataset.testid = `loadout-${id}-${kind}`;
        b.onclick = (e) => {
          const next = bumpLoadout(this.draft, kind, d * (e.shiftKey ? 5 : 1), maxKinds);
          if (next) this.editLoadout(next);
          else if (d > 0 && n === 0) { setText(this.info, `Lv${vaultLevel(me)} loadouts hold ${maxKinds} kinds: take one out first (or upgrade the vault)`); this.info.classList.add('on'); }
        };
        return b;
      };
      const num = el('span', 'vl-n', String(n));
      num.dataset.testid = `loadout-n-${kind}`;
      r.append(icon, el('span', 'vl-name', LABELS[kind] ?? kind), step('−', -1, 'minus'), num, step('+', 1, 'plus'));
      this.tip(r, `${LABELS[kind] ?? kind}: refill to ${n} on respawn from the vault (${countOf(me.vault, kind)} stored) · Shift-click ±5`);
      rows.push(r);
    }
    if (!rows.length) rows.push(el('div', 'vault-empty', 'Buy or store gear to add it to your loadout'));
    this.loadoutBox.replaceChildren(...rows);
  }

  private tip(node: HTMLElement, text: string) {
    node.title = text;
    node.addEventListener('mouseenter', () => { setText(this.info, text); this.info.classList.add('on'); });
    node.addEventListener('mouseleave', () => { setText(this.info, VAULT_HINT); this.info.classList.remove('on'); });
  }
}

const LABELS: Record<string, string> = {
  pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket launcher',
  sandbags: 'Sandbags', wood: 'Wood barricade', metal: 'Sheet metal', steel: 'Steel plate', scaffold: 'Scaffold',
  ramp: 'Ramp', container: 'Container', grenade: 'Grenade', charge: 'Breach charge', medkit: 'Medkit', trap: 'Spike trap',
  shieldSmall: 'Small shield potion', shieldBig: 'Big shield potion', healPotion: 'Heal potion', speedPotion: 'Speed potion',
  grapple: 'Grappling hook',
};
