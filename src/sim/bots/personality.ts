/**
 * A bot's temperament: continuous trait weights in 0..1 that shift utility scores and tactics.
 * Traits never unlock or forbid anything; every bot can do everything.
 */
export type Traits = {
  /** Wants fights, attacks early, keeps shooting at low HP. */
  aggression: number;
  /** Guards home, banks cash, disengages early. */
  caution: number;
  /** Collects, steals generators, picks up loot. */
  greed: number;
  /** Builds up before striking; sticks to a chosen target. */
  patience: number;
  /** Hunts whoever just hurt it. */
  vengeance: number;
  /** Third-parties: hunts the busy, the respawning, the unarmed, the already sealed. */
  opportunism: number;
  /** Spends on pieces, throws down cover, cuts bridges. */
  builder: number;
  /** 0 = close quarters (shotgun/SMG), 1 = long range (rifle). */
  range: number;
};

export const ARCHETYPES = ['Rusher', 'Turtle', 'Vulture', 'Economist', 'Sniper'] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export type Personality = { archetype: Archetype; traits: Traits };

export const PRESETS: Record<Archetype, Traits> = {
  Rusher: { aggression: 0.9, caution: 0.15, greed: 0.3, patience: 0.15, vengeance: 0.6, opportunism: 0.3, builder: 0.3, range: 0.15 },
  Turtle: { aggression: 0.25, caution: 0.85, greed: 0.5, patience: 0.85, vengeance: 0.4, opportunism: 0.3, builder: 0.9, range: 0.5 },
  Vulture: { aggression: 0.5, caution: 0.45, greed: 0.8, patience: 0.4, vengeance: 0.3, opportunism: 0.95, builder: 0.3, range: 0.5 },
  Economist: { aggression: 0.35, caution: 0.6, greed: 0.9, patience: 0.9, vengeance: 0.3, opportunism: 0.4, builder: 0.5, range: 0.6 },
  Sniper: { aggression: 0.45, caution: 0.6, greed: 0.45, patience: 0.6, vengeance: 0.5, opportunism: 0.5, builder: 0.35, range: 0.95 },
};

/** How far each trait may wander from its preset. */
const JITTER = 0.15;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Random archetype plus jitter on every trait, drawn from the (seeded) rng. */
export function rollPersonality(rng: () => number): Personality {
  const archetype = ARCHETYPES[Math.min(ARCHETYPES.length - 1, Math.floor(rng() * ARCHETYPES.length))];
  const base = PRESETS[archetype];
  const traits = {} as Traits;
  for (const k of Object.keys(base) as (keyof Traits)[]) traits[k] = clamp01(base[k] + (rng() * 2 - 1) * JITTER);
  return { archetype, traits };
}

export const preset = (archetype: Archetype): Personality => ({ archetype, traits: { ...PRESETS[archetype] } });
