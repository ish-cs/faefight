/** Aim down sights: hold or toggle (Settings → Controls), and the Mac Ctrl+click quirk. Pure, no DOM. */

export type AimMode = 'hold' | 'toggle';
export const AIM_MODES: readonly AimMode[] = ['hold', 'toggle'];

export const isCtrlCode = (code: string) => code === 'ControlLeft' || code === 'ControlRight';

/** macOS (Ctrl+click is a secondary click there). */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /Mac/i.test(nav.platform ?? '') || /Macintosh|Mac OS X/i.test(nav.userAgent ?? '');
}

/**
 * The button a press really means. macOS turns Ctrl+click into a secondary click (button 2 + contextmenu),
 * so while a Ctrl key is held to aim, a trackpad click arrives as a right click; it is meant as the primary
 * (fire) click. Elsewhere, and without Ctrl held, buttons are taken as they come (right click still aims).
 */
export function effectiveButton(button: number, ctrlKey: boolean, ctrlHeld: boolean, mac: boolean): number {
  return mac && ctrlHeld && ctrlKey && button === 2 ? 0 : button;
}

/** Hold: aiming while an aim key/button is down. Toggle: each press of one flips it on/off. */
export class AimLatch {
  private on = false;
  constructor(public mode: () => AimMode) {}
  /** A fresh press (not a key repeat) of any aim key or button. */
  press() {
    if (this.mode() === 'toggle') this.on = !this.on;
  }
  active(held: boolean): boolean {
    return this.mode() === 'toggle' ? this.on : held;
  }
  reset() {
    this.on = false;
  }
}
