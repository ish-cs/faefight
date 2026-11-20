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
  genUpgrade: svg('<rect x="2.5" y="9" width="14" height="10" rx="1.5" fill="currentColor"/><path d="M4 21h11" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 10.5 7.4 14.6h2.4l-1 3.4 3.2-4.6H9.6z" fill="#0e1218"/><path d="M19.5 16V4.5M16.2 7.8l3.3-3.3 3.3 3.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  medkit: svg('<rect x="3" y="6" width="18" height="14" rx="3" fill="currentColor"/><path d="M9 6V4h6v2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 9.5v7M8.5 13h7" stroke="#0e1218" stroke-width="2.6"/>'),
};

/** Small padlock (gun-lock cards and badges). */
export const LOCK_ICON = svg('<rect x="4.5" y="10.5" width="15" height="11" rx="2" fill="currentColor"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="15.5" r="1.6" fill="#0e1218"/>');

/** Colour group for an icon (CSS hooks: guns gold, pieces blue, explosives orange, medkit green, upgrades violet). */
export function iconGroup(k: IconKind): 'gun' | 'piece' | 'explosive' | 'medkit' | 'upgrade' {
  if (k === 'genUpgrade') return 'upgrade';
  if (k === 'pistol' || k === 'smg' || k === 'shotgun' || k === 'rifle' || k === 'ammo') return 'gun';
  if (k === 'grenade' || k === 'charge') return 'explosive';
  if (k === 'medkit') return 'medkit';
  return 'piece';
}
