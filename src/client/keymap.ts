/**
 * Central key bindings. Every game key handler asks this module "is this KeyboardEvent.code bound
 * to action X?" instead of hard-coding codes, so the Settings → Controls tab can rebind anything.
 *
 * Pure data + functions (no DOM), plus one live map that the settings store keeps in sync.
 * Bindings are KeyboardEvent.code values (layout-independent: 'KeyW' is the key where W sits on QWERTY).
 */

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'jump'
  | 'aim' | 'reload' | 'interact' | 'drop'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6' | 'slot7' | 'slot8' | 'slot9'
  | 'rotateLeft' | 'rotateRight' | 'freePlace'
  | 'inventory' | 'scoreboard' | 'chat' | 'emote' | 'camera' | 'mute' | 'quality' | 'fps' | 'brain';

export type ActionGroup = 'Movement' | 'Actions' | 'Hotbar' | 'Building' | 'Interface';

export type ActionDef = { id: Action; label: string; group: ActionGroup; defaults: string[] };

export const ACTIONS: readonly ActionDef[] = [
  { id: 'forward', label: 'Move forward', group: 'Movement', defaults: ['KeyW'] },
  { id: 'back', label: 'Move back', group: 'Movement', defaults: ['KeyS'] },
  { id: 'left', label: 'Move left', group: 'Movement', defaults: ['KeyA'] },
  { id: 'right', label: 'Move right', group: 'Movement', defaults: ['KeyD'] },
  { id: 'sprint', label: 'Sprint', group: 'Movement', defaults: ['ShiftLeft', 'ShiftRight'] },
  { id: 'jump', label: 'Jump', group: 'Movement', defaults: ['Space'] },
  { id: 'aim', label: 'Aim down sights (hold)', group: 'Actions', defaults: ['Mouse2'] },
  { id: 'reload', label: 'Reload', group: 'Actions', defaults: ['KeyR'] },
  { id: 'interact', label: 'Interact / shop / vault', group: 'Actions', defaults: ['KeyE'] },
  { id: 'drop', label: 'Drop item (+Ctrl/Shift: stack)', group: 'Actions', defaults: ['KeyQ'] },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `slot${n}` as Action, label: `Hotbar slot ${n}`, group: 'Hotbar' as const, defaults: [`Digit${n}`] })),
  { id: 'rotateLeft', label: 'Rotate piece left', group: 'Building', defaults: ['KeyZ'] },
  { id: 'rotateRight', label: 'Rotate piece right', group: 'Building', defaults: ['KeyX'] },
  { id: 'freePlace', label: 'Free placement (hold)', group: 'Building', defaults: ['AltLeft', 'AltRight'] },
  { id: 'inventory', label: 'Reorder hotbar', group: 'Interface', defaults: ['KeyI'] },
  { id: 'scoreboard', label: 'Scoreboard', group: 'Interface', defaults: ['Tab'] },
  { id: 'chat', label: 'Chat', group: 'Interface', defaults: ['Enter', 'NumpadEnter'] },
  { id: 'emote', label: 'Emote / quick chat wheel (hold)', group: 'Interface', defaults: ['KeyT'] },
  { id: 'camera', label: 'First / third person', group: 'Interface', defaults: ['KeyV'] },
  { id: 'mute', label: 'Mute audio', group: 'Interface', defaults: ['KeyM'] },
  { id: 'quality', label: 'Toggle graphics quality', group: 'Interface', defaults: ['KeyP'] },
  // ` as well: on a Mac F3 is Mission Control unless fn is held. Shift + this key toggles the perf detail.
  { id: 'fps', label: 'Show / hide FPS counter (+Shift: perf detail)', group: 'Interface', defaults: ['F3', 'Backquote'] },
  // B also re-buys in the shop (main.ts), but the shop never opens while spectating.
  { id: 'brain', label: 'Spectating a bot: brain inspector (+Shift: in-world overlay)', group: 'Interface', defaults: ['KeyB'] },
];

export const ACTION_IDS: readonly Action[] = ACTIONS.map((a) => a.id);
const DEFS = new Map(ACTIONS.map((a) => [a.id, a]));

export type Keymap = Record<Action, string[]>;

/** Keys that can never be bound: Esc releases the pointer / closes menus, and OS/browser keys. */
const RESERVED = new Set(['Escape', 'MetaLeft', 'MetaRight', 'ContextMenu', 'F5', 'F11', 'F12']);
/** Each action can hold at most this many keys (e.g. both Shift keys). */
const MAX_PER_ACTION = 2;

export function defaultKeymap(): Keymap {
  const km = {} as Keymap;
  for (const a of ACTIONS) km[a.id] = [...a.defaults];
  return km;
}

const VALID_CODE = /^[A-Za-z][A-Za-z0-9]{0,24}$/;
export const isBindable = (code: string) => VALID_CODE.test(code) && !RESERVED.has(code);

/** Stored/foreign data → a complete keymap: unknown actions dropped, bad codes dropped, missing actions defaulted. */
export function sanitizeKeymap(raw: unknown): Keymap {
  const km = defaultKeymap();
  if (!raw || typeof raw !== 'object') return km;
  for (const id of ACTION_IDS) {
    const v = (raw as Record<string, unknown>)[id];
    if (!Array.isArray(v)) continue;
    const codes = [...new Set(v.filter((c): c is string => typeof c === 'string' && isBindable(c)))].slice(0, MAX_PER_ACTION);
    km[id] = codes; // an empty list is a deliberate "unbound"
  }
  // maps saved before ` joined F3 on the FPS key: add it unless the player bound ` elsewhere
  if (km.fps.length === 1 && km.fps[0] === 'F3' && !ACTION_IDS.some((a) => km[a].includes('Backquote'))) km.fps = ['F3', 'Backquote'];
  return km;
}

/** New map with `action` bound to exactly `code` (other actions untouched: conflicts are reported, not resolved). */
export function rebind(km: Keymap, action: Action, code: string): Keymap {
  if (!DEFS.has(action)) throw new Error(`[keymap] unknown action "${action}"`);
  if (!isBindable(code)) throw new Error(`[keymap] "${code}" cannot be bound`);
  return { ...km, [action]: [code] };
}

export function unbind(km: Keymap, action: Action): Keymap {
  return { ...km, [action]: [] };
}

export function resetAction(km: Keymap, action: Action): Keymap {
  return { ...km, [action]: [...DEFS.get(action)!.defaults] };
}

/** Every key bound to more than one action, with those actions (in ACTIONS order). */
export function findConflicts(km: Keymap): { code: string; actions: Action[] }[] {
  const by = new Map<string, Action[]>();
  for (const id of ACTION_IDS) for (const c of km[id]) by.set(c, [...(by.get(c) ?? []), id]);
  return [...by].filter(([, a]) => a.length > 1).map(([code, actions]) => ({ code, actions }));
}

/** Actions other than `action` that `code` is already bound to. */
export function conflictsFor(km: Keymap, action: Action, code: string): Action[] {
  return ACTION_IDS.filter((id) => id !== action && km[id].includes(code));
}

export const actionLabel = (a: Action) => DEFS.get(a)?.label ?? a;

const NAMED: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter', Tab: 'Tab', Backspace: 'Backspace',
  ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'R-Alt',
  CapsLock: 'Caps', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn',
};

/** Short human label for a KeyboardEvent.code ('KeyW' → 'W', 'Digit1' → '1', 'ShiftLeft' → 'Shift'). */
export function keyLabel(code: string): string {
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Mouse(\d)$/.exec(code); // mouse buttons are bound as 'Mouse<button>'
  if (m) return m[1] === '0' ? 'LMB' : m[1] === '2' ? 'RMB' : m[1] === '1' ? 'MMB' : `Mouse ${m[1]}`;
  m = /^Numpad(\w+)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
}

/** Label for an action's current keys, e.g. 'Shift' (both shifts collapse), 'Enter', '—' when unbound. */
export function bindingLabel(km: Keymap, action: Action): string {
  const labels = [...new Set(km[action].map((c) => keyLabel(c).replace(/^R-/, '')))];
  return labels.length ? labels.join(' / ') : '—';
}

// ---------------------------------------------------------------------------------------------
// Live map (fed by the settings store) and the one query every handler uses.
// ---------------------------------------------------------------------------------------------

let active: Keymap = defaultKeymap();
let suspended = false;

export function setActiveKeymap(km: Keymap) { active = km; }
export function activeKeymap(): Keymap { return active; }

/** While true (settings panel open / capturing a key), no game action matches anything. */
export function setKeymapSuspended(v: boolean) { suspended = v; }
export function keymapSuspended() { return suspended; }

/** Is `code` (KeyboardEvent.code) bound to `action` right now? */
export function isAction(action: Action, code: string): boolean {
  return !suspended && active[action].includes(code);
}

/** Hotbar slot index (0-based) bound to `code`, or -1. */
export function slotForCode(code: string): number {
  if (suspended) return -1;
  for (let i = 1; i <= 9; i++) if (active[`slot${i}` as Action].includes(code)) return i - 1;
  return -1;
}

/** Is any key bound to `action` in the held-key set? (for held controls: move, sprint, free placement) */
export function isHeld(action: Action, held: ReadonlySet<string>): boolean {
  if (suspended) return false;
  for (const c of active[action]) if (held.has(c)) return true;
  return false;
}
