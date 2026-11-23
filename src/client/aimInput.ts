/** Aim down sights: hold or toggle (Settings → Controls), and the Mac Ctrl+click quirk. Pure, no DOM. */

export type AimMode = 'hold' | 'toggle';
export const AIM_MODES: readonly AimMode[] = ['hold', 'toggle'];

export const isCtrlCode = (code: string) => code === 'ControlLeft' || code === 'ControlRight';

type Nav = { userAgentData?: { platform?: string }; platform?: string; userAgent?: string };
/** The browser's navigator (undefined outside a browser). */
export const platformNav = (): Nav | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as Nav));

/** macOS (Ctrl+click is a secondary click there; browser shortcuts use Cmd, not Ctrl). */
export function isMacPlatform(nav: Nav | undefined): boolean {
  if (!nav) return false;
  const p = nav.userAgentData?.platform || nav.platform || '';
  return p ? /mac/i.test(p) : /Macintosh|Mac OS X/i.test(nav.userAgent ?? '');
}

/**
 * Ctrl aims by default only on macOS. On Windows/Linux Ctrl+W/T/N close/open tabs and a page can't block
 * them (outside fullscreen keyboard lock), so holding Ctrl to aim while walking with W would close the game.
 */
export const ctrlAimDefault = (nav: Nav | undefined) => isMacPlatform(nav);

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
