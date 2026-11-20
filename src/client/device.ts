/**
 * Device / browser gates for the menu. Pure functions over what the browser reports, plus readers for
 * the live values. No three.js or game code here: the phone card must not pull them in.
 */

export type DeviceInfo = { coarse: boolean; anyFine: boolean; width: number; ua: string };

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i;

/** Phone / tablet: touch-primary with no fine pointer at all, or a narrow screen with a mobile user agent. */
export function isMobileDevice(d: DeviceInfo): boolean {
  if (d.coarse && !d.anyFine) return true;
  return d.width < 900 && MOBILE_UA.test(d.ua);
}

/** Chromium-based (Chrome, Edge, Brave, Opera, Arc… all say "Chrome/" in the UA). Firefox and Safari are not; Chrome on iOS is WebKit. */
export function isChromium(ua: string): boolean {
  return /(Chrome|Chromium)\/\d/.test(ua) && !/Firefox|FxiOS|CriOS/.test(ua);
}

export function currentDevice(): DeviceInfo {
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  return { coarse: mq('(pointer: coarse)'), anyFine: mq('(any-pointer: fine)'), width: Math.min(screen.width || innerWidth, innerWidth), ua: navigator.userAgent };
}

export function currentIsChromium(): boolean {
  return isChromium(navigator.userAgent);
}

/** Full-screen "use a computer" card shown instead of the game on phones and tablets. */
export function showComputerOnly(parent: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'menu device-gate';
  wrap.dataset.testid = 'computer-only';
  const card = document.createElement('div');
  card.className = 'menu-card glass gate-card';
  const icon = document.createElement('div');
  icon.className = 'gate-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>';
  const h = document.createElement('h1');
  h.textContent = 'FAEFight';
  const msg = document.createElement('p');
  msg.className = 'gate-msg';
  msg.textContent = 'FAEFight is a computer game — open this link on a laptop or desktop in Chrome.';
  const copy = document.createElement('button');
  copy.className = 'btn';
  copy.textContent = 'Copy link';
  copy.onclick = () => {
    navigator.clipboard?.writeText(location.href).then(() => { copy.textContent = 'Link copied'; }, () => { copy.textContent = 'Copy failed'; });
  };
  card.append(icon, h, msg, copy);
  wrap.append(card);
  parent.append(wrap);
}
