import type { HotbarItem } from '../sim/types';

/** Line/silhouette icons (24×24, drawn in currentColor) shared by the hotbar and the shop. */
export type IconKind = HotbarItem | 'ammo' | 'genUpgrade';

const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"';

export const ICONS: Record<IconKind, string> = {
  pistol: svg('<path d="M3 5.5h16.5V11H12.4l-1.1 1.6L10 19.5H5.2L6.8 11H3z" fill="currentColor"/><path d="M11.4 11.5c.3 1.6 1.2 2.7 2.8 2.7" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
  smg: svg('<path d="M1.5 7.5H17V9h4.5v4H16l-.6 1.2h-1.6l-.9 5.3H9.9l.9-5.3H7.2L5.4 18H2.4l1.7-5H1.5z" fill="currentColor"/><rect x="11.3" y="13" width="2.6" height="7" rx=".8" fill="currentColor"/>'),
  shotgun: svg('<path d="M.8 8.5h22.4v3H12.5V13H7.3l-3.6 5H.8L3 13H.8z" fill="currentColor"/><rect x="13.2" y="11.2" width="7" height="3" rx="1.2" fill="currentColor"/>'),
  rifle: svg('<path d="M.8 10.2h22.4v3h-9l-.8 1.6h-1.6L10.5 20H7.4l.9-5.2H6.2l-3.4 4H.6L2 14.5 .8 13z" fill="currentColor"/><rect x="6.5" y="5.6" width="8" height="2.8" rx="1.4" fill="currentColor"/><path d="M8.5 8.4v1.8M12.5 8.4v1.8" stroke="currentColor" stroke-width="1.6"/>'),
  ammo: svg('<g fill="currentColor"><path d="M5 9c0-2 1-4 2-5 1 1 2 3 2 5v11H5z"/><path d="M10 9c0-2 1-4 2-5 1 1 2 3 2 5v11h-4z"/><path d="M15 9c0-2 1-4 2-5 1 1 2 3 2 5v11h-4z"/></g><path d="M4.5 10h15" stroke="#0e1218" stroke-width="1"/>'),
  sandbags: svg('<g fill="currentColor"><rect x="2" y="13.5" width="6.4" height="5" rx="2.4"/><rect x="8.8" y="13.5" width="6.4" height="5" rx="2.4"/><rect x="15.6" y="13.5" width="6.4" height="5" rx="2.4"/><rect x="5.4" y="8" width="6.4" height="5" rx="2.4"/><rect x="12.2" y="8" width="6.4" height="5" rx="2.4"/></g>'),
  wood: svg(`<rect x="3" y="4" width="18" height="16" rx="1.5" ${S}/><path d="M9 4v16M15 4v16" ${S}/><path d="M3 9l18 6" ${S}/><circle cx="6" cy="6.5" r=".9" fill="currentColor"/><circle cx="18" cy="17.5" r=".9" fill="currentColor"/>`),
  metal: svg(`<rect x="3" y="3.5" width="18" height="17" rx="1" ${S}/><path d="M6.5 3.5c1 2.8 1 14.2 0 17M10.8 3.5c1 2.8 1 14.2 0 17M15 3.5c1 2.8 1 14.2 0 17M19 3.5c.6 2.8.6 14.2 0 17" ${S} stroke-width="1.3"/>`),
  steel: svg('<rect x="3" y="3.5" width="18" height="17" rx="2" fill="currentColor"/><g fill="#0e1218"><circle cx="6.5" cy="7" r="1.1"/><circle cx="17.5" cy="7" r="1.1"/><circle cx="6.5" cy="17" r="1.1"/><circle cx="17.5" cy="17" r="1.1"/></g><path d="M3 12h18" stroke="#0e1218" stroke-width="1.2" opacity=".5"/>'),
  scaffold: svg(`<path d="M4 3v18M20 3v18M4 7h16M4 14h16M4 7l16 7M20 7 4 14M4 21h16" ${S}/>`),
  ramp: svg('<path d="M2.5 19.5 21.5 6.5v13z" fill="currentColor"/><path d="M8 15.8v3.7M13 12.4v7.1M18 9v10.5" stroke="#0e1218" stroke-width="1.2" opacity=".55"/>'),
  container: svg('<rect x="1.8" y="6" width="20.4" height="12.5" rx="1" fill="currentColor"/><path d="M5.5 8v8.5M9 8v8.5M12.5 8v8.5M16 8v8.5" stroke="#0e1218" stroke-width="1.2" opacity=".55"/><path d="M19.5 9v6.5" stroke="#0e1218" stroke-width="1.6"/>'),
  grenade: svg('<circle cx="12" cy="14" r="6.5" fill="currentColor"/><path d="M10 7h4v-2h-4zM14 6l4-2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 14h8M12 10v8" stroke="#0e1218" stroke-width="1" opacity=".45"/>'),
  charge: svg('<rect x="4" y="8" width="16" height="11" rx="2" fill="currentColor"/><path d="M12 8V4h5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="16.5" cy="12" r="1.3" fill="#0e1218"/><path d="M6.5 15.5h7" stroke="#0e1218" stroke-width="1.4"/>'),
  rocket: svg('<rect x="2" y="9" width="17" height="4.6" rx="1.4" fill="currentColor"/><path d="M19 9.4l3.6 1.9-3.6 1.9z" fill="currentColor"/><rect x=".8" y="8.2" width="2.6" height="6.2" rx=".6" fill="currentColor"/><path d="M8 13.6l-.8 4.6h2.6l.8-4.6M13 13.6v3.4h2.2v-3.4" fill="currentColor"/><rect x="7.5" y="6.2" width="4.5" height="2.4" rx=".6" fill="currentColor"/>'),
  genUpgrade: svg('<rect x="2.5" y="9" width="14" height="10" rx="1.5" fill="currentColor"/><path d="M4 21h11" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 10.5 7.4 14.6h2.4l-1 3.4 3.2-4.6H9.6z" fill="#0e1218"/><path d="M19.5 16V4.5M16.2 7.8l3.3-3.3 3.3 3.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  trap: svg('<rect x="2.5" y="16" width="19" height="4" rx="1" fill="currentColor"/><path d="M4 16l1.5-8L7 16M9 16l1.5-10L12 16M14 16l1.5-10L17 16M19 16l1-7 1 7" fill="currentColor"/>'),
  medkit: svg('<rect x="3" y="6" width="18" height="14" rx="3" fill="currentColor"/><path d="M9 6V4h6v2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 9.5v7M8.5 13h7" stroke="#0e1218" stroke-width="2.6"/>'),
  grapple: svg('<path d="M12 3v9" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="3.2" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 12c0 5 -6 6 -7.5 1.5M12 12c0 5 6 6 7.5 1.5M12 12v8.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M4.5 13.5 3.2 11.4M19.5 13.5l1.3-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  // Potions carry their own colours (blue shields, red heal, yellow speed) instead of currentColor.
  shieldSmall: svg('<path d="M10 3h4v4.2l3.6 5.4A5.8 5.8 0 0 1 12 21a5.8 5.8 0 0 1-5.6-8.4L10 7.2z" fill="#4aa8ff"/><rect x="9.3" y="2" width="5.4" height="2.2" rx=".8" fill="#cfe6ff"/><path d="M8 14.5h8" stroke="#0e1218" stroke-width="1" opacity=".35"/><circle cx="10.2" cy="16" r="1.1" fill="#e6f3ff" opacity=".8"/>'),
  shieldBig: svg('<path d="M8.5 2.5h7v3.2c3 1.2 5 4 5 7.3v5.5A3 3 0 0 1 17.5 21.5h-11a3 3 0 0 1-3-3V13c0-3.3 2-6.1 5-7.3z" fill="#2f86f0"/><rect x="7.8" y="1.6" width="8.4" height="2.4" rx=".8" fill="#cfe6ff"/><path d="M12 9.2 15.6 10.6v3c0 2.4-1.6 4-3.6 4.8-2-.8-3.6-2.4-3.6-4.8v-3z" fill="#e6f3ff"/>'),
  healPotion: svg('<path d="M10 3h4v4.2l3.6 5.4A5.8 5.8 0 0 1 12 21a5.8 5.8 0 0 1-5.6-8.4L10 7.2z" fill="#ff5a5a"/><rect x="9.3" y="2" width="5.4" height="2.2" rx=".8" fill="#ffd6d6"/><path d="M12 12.3v5.4M9.3 15h5.4" stroke="#fff" stroke-width="1.9"/>'),
  speedPotion: svg('<path d="M10 3h4v4.2l3.6 5.4A5.8 5.8 0 0 1 12 21a5.8 5.8 0 0 1-5.6-8.4L10 7.2z" fill="#ffd166"/><rect x="9.3" y="2" width="5.4" height="2.2" rx=".8" fill="#fff1c9"/><path d="M12.8 10.5 9.8 15.4h2.6l-1.2 3.6 3.2-5h-2.6z" fill="#0e1218"/>'),
};

/** Small padlock (gun-lock cards and badges). */
export const LOCK_ICON = svg('<rect x="4.5" y="10.5" width="15" height="11" rx="2" fill="currentColor"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="15.5" r="1.6" fill="#0e1218"/>');

/** Colour group for an icon (CSS hooks: guns gold, pieces blue, explosives orange, medkit green, upgrades violet). */
export function iconGroup(k: IconKind): 'gun' | 'piece' | 'explosive' | 'medkit' | 'potion' | 'upgrade' {
  if (k === 'genUpgrade') return 'upgrade';
  if (k === 'shieldSmall' || k === 'shieldBig' || k === 'healPotion' || k === 'speedPotion') return 'potion';
  if (k === 'pistol' || k === 'smg' || k === 'shotgun' || k === 'rifle' || k === 'rocket' || k === 'ammo') return 'gun';
  if (k === 'grenade' || k === 'charge' || k === 'trap') return 'explosive';
  if (k === 'grapple') return 'upgrade';
  if (k === 'medkit') return 'medkit';
  return 'piece';
}
