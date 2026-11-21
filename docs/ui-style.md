# FAEFight UI style: "Harbor Ops"

Dockside industrial signage under a tropical sun. Condensed stencil type, crane orange, sea teal and
hazard yellow on solid navy-steel panels with hazard-stripe edges and chamfered buttons.

Tokens and components live in `src/client/ui/theme.css`; the reskin of the existing screens lives in
`src/client/ui/skin.css`. Both are imported **last** in `main.ts`, so their rules win over `style.css`,
`qol.css` and `settings.css` at equal specificity. Fonts are self-hosted in
`public/fonts/` (SIL OFL 1.1). Nothing is loaded from a CDN.

## Rules

- Use the tokens (`var(--c-orange)`, `var(--sp-3)`, …). Don't hard-code colours or fonts.
- Use the component classes below for new UI. Old classes (`.btn`, `.glass`, `.panel`, …) are reskinned, so existing markup is fine too.
- No dropdowns (`<select>`). Use a segmented control (`.ui-seg`) or a slider.
- HUD (over the 3D canvas): use `.ui-plate` backplates and `var(--hud-shadow)` text shadows. **No `backdrop-filter`** on the HUD; it re-composites every frame. Modal overlays may use `.ui-backdrop`.
- Animate only `transform` and `opacity`. Per-frame HUD code must not read layout (`offsetWidth`, `getBoundingClientRect`) and must not rebuild DOM each frame; change text with a "did it change" check.
- Keyboard: every control needs a visible `:focus-visible` state. The primitives already have one (yellow ring).
- One primary (orange) action per card. Icons on all the buttons in a group, or on none of them.
- Say each thing once. Cash lives top-left (it flashes on buys), mag/spare lives bottom-right, the
  hotbar shows only the mag. Status words show only when they matter (a chip says SEALED, never OPEN).
- Every widget needs a label or an icon (the HP and shield bars have heart/shield icons).
- Something you can't use must look it: dimmed with the reason in a status strip, or hidden.

## Tokens

| Group | Tokens |
|---|---|
| Fonts | `--ff-display` (Big Shoulders Display, condensed, uppercase titles, numbers, buttons) · `--ff-stencil` (Big Shoulders Stencil, wordmark and hero titles) · `--ff-body` (Barlow Semi Condensed, text) |
| Type scale | `--fs-2xs` 10.5 · `--fs-xs` 12 · `--fs-sm` 13.5 · `--fs-md` 15 · `--fs-lg` 18 · `--fs-xl` 24 · `--fs-2xl` 32 · `--fs-3xl` 44 · `--fs-4xl` 64 · `--fs-5xl` 96 · `--track-label` · `--track-btn` |
| Surfaces | `--c-ink-950` … `--c-ink-400` (navy steel, dark to light) · `--c-line` · `--c-line-strong` · `--panel-bg` · `--panel-bg-tx` (with grain) · `--plate` · `--plate-strong` |
| Text | `--c-text` · `--c-text-dim` · `--c-text-faint` |
| Accents | `--c-orange` (primary, selection) · `--c-teal` (info, "you") · `--c-yellow` (cash, warning, focus) · `--c-red` (danger, sealed) · `--c-green` (health) · `--c-blue` (shield) · `--c-violet` (upgrades) · `--c-on-orange` / `--c-on-yellow` / `--c-on-teal` (text on those) |
| Spacing | `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 |
| Radii | `--r-xs` 2 · `--r-sm` 4 · `--r-md` 6 · `--r-lg` 10 · `--r-pill` · `--cut` (button chamfer) |
| Shadows | `--sh-1` · `--sh-2` · `--sh-3` · `--sh-inset` · `--hud-shadow` · `--hud-shadow-big` |
| Patterns | `--hazard` (yellow/black stripes) · `--hazard-red` · `--noise` (grain) |
| Motion | `--ease-snap` · `--ease-out` · `--dur-1` 90ms · `--dur-2` 160ms · `--dur-3` 260ms |
| Focus | `--focus` (outer ring) · `--focus-inset` (for clipped elements) |
| Legacy aliases | `--glass` `--glass-strong` `--line` `--text` `--muted` `--accent` (= orange) `--danger` `--gold` (= yellow) |

## Components

| Class | Use |
|---|---|
| `.ui-panel` | Card / modal surface. Add `.ui-panel--striped` (hazard top edge) and/or `.ui-panel--brackets` (orange corner marks). |
| `.ui-plate` | HUD backplate (no blur). |
| `.ui-btn` / `.btn` | Button, chamfered, uppercase display type. Variants: `--primary` (`.btn.primary`), `--secondary` (default), `--teal`, `--danger` (`.btn.danger`), `--ghost` (`.btn.ghost`). Sizes: `--sm` (`.btn.small`), `--lg`, `--block`. Icon: put an `<svg>` first, it is sized for you. |
| `.ui-kbd` | Keycap, e.g. `<span class="ui-kbd">Esc</span>`; inside a button it goes to the right edge. |
| `.ui-input` | Text input (`.text-in` gets the same look). |
| `.ui-seg` | Segmented control: buttons inside; the chosen one has `.on`, `.selected` or `aria-checked="true"`. |
| `.ui-toggle` | `<label class="ui-toggle"><input type="checkbox"><span class="knob"></span></label>` |
| `.ui-slider` | `<input type="range" class="ui-slider" style="--fill:40%">` |
| `.ui-chip` | Small tag. `--accent`, `--teal`, `--warn`, `--danger`. |
| `.ui-toast` | Toast at the top centre. `--ok`, `--warn`, `--danger` (default tone is teal). |
| `.ui-tip` + `data-tip="…"` | CSS tooltip on hover/focus. |
| `.ui-infobar` | One-line detail strip (shop info bar). |
| `.ui-backdrop` | Full-screen blurred, darkened backdrop behind a modal. |
| `.ui-display` / `.ui-stencil` / `.ui-kicker` / `.ui-num` / `.ui-hud-text` | Type helpers. |
| `.pause-*` | Pause card (see `main.ts` `showPause`). |

## Screens

Before/after screenshots: `docs/screens/ui-before-*.png`, `docs/screens/ui-after-*.png`, made by
`node tests/visual/uiShots.mjs http://localhost:<port> <before|after>` against a running `pnpm vite`.
The `hud-storm` shot darkens the canvas to check HUD contrast in dark scenes; `hud-day` / `hud-sky`
check it over bright sand, water and sky.
