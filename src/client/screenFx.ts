import type * as THREE from 'three/webgpu';

/**
 * Full-screen overlays for smoke grenades and flashbangs (sim/utility.ts), for whoever's eyes the screen shows
 * (viewed.ts: the local player, or the followed player when spectating or watching a recording; nothing over the
 * killcam's replay camera, which isn't anyone's eyes):
 * - smoke fog: grey, alpha by how deep the camera is in a cloud (world/smokeFx.ts smokeDepth), under the HUD;
 * - flash: white at flashAlpha(blind), over the HUD. "Reduced flash" (Settings → Gameplay) makes it a dim grey.
 * Seizure-safe: while one blind lasts the flash only ever fades (never brightens again, never flickers); a new flash
 * (a new `blind.at`) may brighten it once.
 */

const FLASH_WHITE = '#ffffff', FLASH_GREY = '#777777';
/** Overlay opacity (1/100 steps) for a flash of whiteness `a` (0..1); Reduced flash caps it at 0.85. */
export const flashOpacity = (a: number, reduced: boolean): number => Math.round(Math.min(1, Math.max(0, a)) * (reduced ? 0.85 : 1) * 100) / 100;
/** Overlay colour and opacity for a flash of whiteness `a` (0..1): white, or a dim grey with Reduced flash. */
export function flashStyle(a: number, reduced: boolean): { color: string; opacity: number } {
  return { color: reduced ? FLASH_GREY : FLASH_WHITE, opacity: flashOpacity(a, reduced) };
}

/**
 * The flash level actually shown: `a` for a new blind (`at` changed), else never above what was shown before
 * (monotonic fade per blind, whatever the interpolated clock does).
 */
export function monotonicFlash(a: number, at: number | null, prevA: number, prevAt: number | null): number {
  if (at === null) return 0;
  return at !== prevAt ? a : Math.min(a, prevA);
}

export class ScreenFx {
  private fog = document.createElement('div');
  private flash = document.createElement('div');
  private fogShown = -1;
  private fogTone = -1;
  private flashShown = 0;
  private flashAt: number | null = null;
  private flashOp = -1;
  private flashColor = '';

  constructor(parent: HTMLElement, canvas: HTMLElement) {
    this.fog.className = 'smoke-fog';
    this.flash.className = 'flash-white';
    // the fog sits right over the 3D view (under the HUD); the flash goes over everything but menus
    if (canvas.parentElement === parent) canvas.after(this.fog); else parent.prepend(this.fog);
    parent.append(this.flash);
  }

  /**
   * Per frame. `smoke` = depth into a cloud 0..1; `flashA` = flashAlpha of the viewed player's blind (`blindAt` its
   * start, null = none); `tone` = ambient light colour (day/night) for the fog.
   */
  frame(smoke: number, flashA: number, blindAt: number | null, reduced: boolean, tone: THREE.Color) {
    const f = Math.round(smoke * 0.95 * 50) / 50;
    if (f !== this.fogShown) {
      this.fogShown = f;
      this.fog.style.opacity = String(f);
      this.fog.style.display = f > 0 ? 'block' : 'none';
    }
    if (f > 0) {
      // grey lit like the scene (day/night ambient); the css string is built only when the tone changes
      const r = Math.round(Math.min(1, tone.r) * 175), g = Math.round(Math.min(1, tone.g) * 175), b = Math.round(Math.min(1, tone.b * 1.02) * 175);
      const key = (r << 16) | (g << 8) | b;
      if (key !== this.fogTone) { this.fogTone = key; this.fog.style.background = `rgb(${r},${g},${b})`; }
    }
    const a = monotonicFlash(flashA, blindAt, this.flashShown, this.flashAt);
    this.flashShown = a;
    this.flashAt = blindAt;
    const op = flashOpacity(a, reduced), color = reduced ? FLASH_GREY : FLASH_WHITE;
    if (op !== this.flashOp) {
      this.flashOp = op;
      this.flash.style.opacity = String(op);
      this.flash.style.display = op > 0 ? 'block' : 'none';
    }
    if (color !== this.flashColor) { this.flashColor = color; this.flash.style.background = color; }
  }

  /** Debug / e2e: what the overlays show now. */
  info() { return { fog: Math.max(0, this.fogShown), flash: Math.max(0, this.flashOp), flashColor: this.flashColor }; }
}
