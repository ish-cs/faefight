import { settings, type Settings } from './store';

/**
 * Settings that are pure presentation are applied as attributes on <html>, read by CSS
 * (settings.css): FPS counter, crosshair style/colour, damage numbers. Live on every change.
 */
export function applyDocumentSettings() {
  const apply = (s: Settings) => {
    const root = document.documentElement;
    root.dataset.fps = s.video.showFps ? 'on' : 'off';
    root.dataset.crosshair = s.gameplay.crosshair;
    root.dataset.dmgnums = s.gameplay.damageNumbers ? 'on' : 'off';
    root.style.setProperty('--xh', s.gameplay.crosshairColor);
  };
  apply(settings.get());
  settings.subscribe(apply);
}
