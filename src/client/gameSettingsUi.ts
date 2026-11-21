import { DEFAULT_SETTINGS, SETTING_KEYS, SETTING_RANGES, clampSettings, sameSettings, type GameSettings } from '../sim/settings';

/** Labels and value text per setting (pure: unit-tested). */
export const SETTING_LABEL: Record<keyof GameSettings, string> = {
  startCash: 'Starting cash',
  suddenDeathSec: 'Sudden death at',
  genMult: 'Generator speed',
};

export function formatSetting(key: keyof GameSettings, v: number): string {
  if (key === 'startCash') return `$${v}`;
  if (key === 'suddenDeathSec') return `${Math.round(v / 60)} min`;
  return `${v}×`;
}

/**
 * "Game settings" panel: one slider per setting plus Reset to defaults (no dropdowns). The host (and
 * vs-bot menu) edit it; guests get a read-only copy that the host's lobby messages update.
 * onChange fires once per committed change (slider released / key), with clamped settings.
 */
export class GameSettingsPanel {
  readonly root = document.createElement('div');
  private inputs = new Map<keyof GameSettings, { input: HTMLInputElement; out: HTMLElement }>();
  private reset: HTMLButtonElement | null = null;
  private current: GameSettings;

  constructor(value: GameSettings, private onChange: ((s: GameSettings) => void) | null, testid = 'game-settings') {
    this.current = clampSettings(value);
    this.root.className = 'game-settings';
    this.root.dataset.testid = testid;
    const head = document.createElement('div');
    head.className = 'gs-head';
    const title = document.createElement('span');
    title.className = 'label';
    title.textContent = onChange ? 'Game settings' : 'Game settings · set by the host';
    head.append(title);
    if (onChange) {
      this.reset = document.createElement('button');
      this.reset.type = 'button';
      this.reset.className = 'btn small';
      this.reset.textContent = 'Reset to defaults';
      this.reset.dataset.testid = `${testid}-reset`;
      this.reset.onclick = () => this.commit({ ...DEFAULT_SETTINGS });
      head.append(this.reset);
    }
    this.root.append(head);
    for (const key of SETTING_KEYS) {
      const { min, max, step } = SETTING_RANGES[key];
      const row = document.createElement('label');
      row.className = 'gs-row';
      const name = document.createElement('span');
      name.className = 'gs-name';
      name.textContent = SETTING_LABEL[key];
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'gs-range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.dataset.testid = `${testid}-${key}`;
      input.disabled = !onChange;
      const out = document.createElement('span');
      out.className = 'gs-value';
      out.dataset.testid = `${testid}-${key}-value`;
      input.oninput = () => { out.textContent = formatSetting(key, Number(input.value)); };
      input.onchange = () => this.commit({ ...this.current, [key]: Number(input.value) });
      row.append(name, input, out);
      this.root.append(row);
      this.inputs.set(key, { input, out });
    }
    this.value = this.current;
  }

  get value(): GameSettings { return { ...this.current }; }
  set value(v: GameSettings) {
    this.current = clampSettings(v);
    for (const [key, { input, out }] of this.inputs) {
      input.value = String(this.current[key]);
      out.textContent = formatSetting(key, this.current[key]);
    }
    if (this.reset) this.reset.disabled = sameSettings(this.current, DEFAULT_SETTINGS);
  }

  set disabled(d: boolean) {
    if (!this.onChange) return;
    for (const { input } of this.inputs.values()) input.disabled = d;
    if (this.reset) this.reset.disabled = d || sameSettings(this.current, DEFAULT_SETTINGS);
  }

  private commit(next: GameSettings) {
    this.value = next;
    this.onChange?.(this.value);
  }
}
