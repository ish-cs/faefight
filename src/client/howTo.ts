import { LIFECYCLE, ROCKET } from '../sim/constants';
import { activeKeymap, bindingLabel } from './keymap';

/** "How to play" card: the match loop in eight one-line steps. Opened from the menu, and once on a first launch. */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICON = {
  goal: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  cash: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  bridge: svg('<path d="M2 16h20M4 16v4M20 16v4M2 12c4 0 6-4 10-4s6 4 10 4M7 12v4M12 8v8M17 12v4"/>'),
  seal: svg('<path d="M4 21V9l8-6 8 6v12z"/><path d="M9 21v-6h6v6"/><path d="M9 15l6 6M15 15l-6 6"/>'),
  skull: svg('<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/><path d="M10 20v-2M14 20v-2"/>'),
  timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
  rocket: svg('<path d="M12 2c3 2.5 4 6 4 10v4H8v-4c0-4 1-7.5 4-10z"/><path d="M8 13l-3 3v3h3M16 13l3 3v3h-3M10 20l2 2 2-2"/>'),
  storm: svg('<path d="M6 15a4 4 0 0 1 .6-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1 0 7"/><path d="M13 12l-3 5h4l-3 5"/>'),
};

function steps(): { icon: keyof typeof ICON; title: string; text: string }[] {
  const e = bindingLabel(activeKeymap(), 'interact');
  return [
    { icon: 'goal', title: 'The goal', text: 'Seal every enemy bunker, then eliminate them. Last one standing wins.' },
    { icon: 'cash', title: 'Cash and shop', text: `Press ${e} to collect cash at your generator, then spend it at the shop.` },
    { icon: 'bridge', title: 'Cross over', text: 'Lay scaffolds toward an enemy island; a grappling hook only spans the last gap.' },
    { icon: 'rocket', title: 'Rocket jump', text: `Fire a rocket at your feet to launch high: ${ROCKET.selfDmgMax} damage at most, soft landing.` },
    { icon: 'seal', title: 'Seal their bunker', text: 'Plug all 3 doorways of their bunker while they are dead or outside it.' },
    { icon: 'skull', title: 'Respawn', text: `Respawn takes ${LIFECYCLE.respawnSec} s; die with your bunker sealed and you are out for good.` },
    { icon: 'timer', title: 'Sealed in yourself?', text: `Sealed while dead? Respawn trapped and break out within ${LIFECYCLE.breakoutSec} s.` },
    { icon: 'storm', title: 'Sudden death', text: 'Barriers drop over every bunker doorway, no one respawns, and the storm closes in.' },
  ];
}

let open: HTMLElement | null = null;

export function openHowTo(onClose?: () => void) {
  if (open) return;
  const overlay = document.createElement('div');
  overlay.className = 'howto-overlay';
  overlay.dataset.testid = 'how-to-play';
  const card = document.createElement('div');
  card.className = 'howto glass';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'How to play');
  const title = document.createElement('div');
  title.className = 'howto-title';
  title.textContent = 'How to play';
  const list = document.createElement('ol');
  list.className = 'howto-steps';
  for (const s of steps()) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = `howto-icon i-${s.icon}`;
    icon.innerHTML = ICON[s.icon]; // constant SVG markup
    const body = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'howto-step-title';
    t.textContent = s.title;
    const p = document.createElement('div');
    p.className = 'howto-step-text';
    p.textContent = s.text;
    body.append(t, p);
    li.append(icon, body);
    list.append(li);
  }
  const done = document.createElement('button');
  done.className = 'btn primary howto-done';
  done.textContent = 'Got it';
  done.dataset.testid = 'how-to-close';
  card.append(title, list, done);
  overlay.append(card);
  document.body.append(overlay);
  open = overlay;
  const close = () => {
    if (open !== overlay) return;
    open = null;
    removeEventListener('keydown', onKey, true);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  done.onclick = close;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  done.focus();
}
