import { CENTER, MAP } from './constants';
import type { Vec3 } from './types';
import type { GameSettings } from './settings';
import { add, forward, right, rotateY, scale, v3, yawOf } from './vec';

export type Doorway = { center: Vec3; yaw: number; width: number };
export type Bunker = { center: Vec3; facingYaw: number; doorways: Doorway[] };
export type IslandLayout = {
  index: number;
  center: Vec3;
  radius: number;
  groundY: number;
  bunker: Bunker;
  spawn: Vec3;
  generator: Vec3;
  vault: Vec3;
  shop: Vec3;
};
export type Box = { center: Vec3; half: Vec3; rotY: number };

/** Layout templates. `harbor` is the original map; every template has a neutral center island. */
export type MapTemplate = 'harbor' | 'yard';
/** What the host picks in the lobby: a template, or a random one per match. */
export type MapChoice = MapTemplate | 'random';
export const MAP_TEMPLATES: MapTemplate[] = ['harbor', 'yard'];
export const MAP_NAMES: Record<MapTemplate, string> = { harbor: 'Harbor', yard: 'Container Yard' };
export const isMapChoice = (x: unknown): x is MapChoice => x === 'random' || (MAP_TEMPLATES as unknown[]).includes(x);
export const isMapTemplate = (x: unknown): x is MapTemplate => (MAP_TEMPLATES as unknown[]).includes(x);

/**
 * Built-in map cover: solid, indestructible boxes (physics `world`, camera blockers, bot obstacles).
 * `island` = player island index, or -1 for the center island.
 */
export type StaticBox = Box & { role: 'cover'; island: number; look: 'container' | 'barrier' };

/** Purely decorative props: breakable (sim-authoritative hp), never collide with players, pieces, seals or support. */
export type CosmeticKind = 'barrel' | 'crate' | 'fence' | 'palm' | 'lamp' | 'bollard';
export type CosmeticDef = { id: number; kind: CosmeticKind; pos: Vec3; rotY: number };
/** Hit shape (vertical cylinder standing on pos) and hit points per cosmetic kind. */
export const COSMETIC: Record<CosmeticKind, { r: number; h: number; hp: number }> = {
  barrel: { r: 0.35, h: 0.95, hp: 30 },
  crate: { r: 0.45, h: 0.8, hp: 40 },
  fence: { r: 1.0, h: 1.1, hp: 40 },
  palm: { r: 0.3, h: 7, hp: 80 },
  lamp: { r: 0.2, h: 5, hp: 60 },
  bollard: { r: 0.25, h: 0.6, hp: 60 },
};

/** Neutral island at the middle of the ring: anyone may use its stations. */
export type CenterIsland = {
  center: Vec3;
  radius: number;
  groundY: number;
  /** Bonus cash generator (2× rate, high cap, anyone collects). */
  goldGen: Vec3;
  /** Accumulates free building pieces; collect by interacting. */
  supplyGen: Vec3;
  /** Potion seller NPC (interaction point). */
  potionShop: Vec3;
  /** Standing within CENTER.wellRadius of this point refills shield. */
  shieldWell: Vec3;
};

export type MapDef = {
  template: MapTemplate;
  name: string;
  seed: number;
  /** Kill plane (sea) and its sudden-death rise rate (m/s). */
  waterY: number;
  tideRate: number;
  islands: IslandLayout[];
  center: CenterIsland;
  statics: StaticBox[];
  cosmetics: CosmeticDef[];
  /** Set by the match: the rules in force (clamped) and the palette colour per island (index = island). */
  settings?: GameSettings;
  colors?: number[];
};

type TemplateSpec = {
  radius: number;
  gap: number;
  /** Center island radius bounds, and the island→center gap it grows toward. */
  centerR: [number, number];
  centerGap: number;
  /** Smallest island→center gap (the ring grows to keep it; harbor never needs to). */
  minCenterGap: number;
};
const SPEC: Record<MapTemplate, TemplateSpec> = {
  harbor: { radius: MAP.islandRadius, gap: MAP.gap, centerR: [10, 14], centerGap: 36, minCenterGap: 8 },
  yard: { radius: 19, gap: 26, centerR: [10, 13], centerGap: 26, minCenterGap: 8 },
};

/** Pick the template for a match. Random never repeats `last` (the previous map this host played). */
export function resolveMapChoice(choice: MapChoice, last: MapTemplate | null, rng: () => number = Math.random): MapTemplate {
  if (choice !== 'random') return choice;
  const pool = MAP_TEMPLATES.filter((t) => t !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** Player islands only. `harbor` reproduces the original (pre-MapDef) map exactly. */
export function buildMap(playerCount: number, template: MapTemplate = 'harbor'): IslandLayout[] {
  return buildMapDef(playerCount, template).islands;
}

export function buildMapDef(playerCount: number, template: MapTemplate = 'harbor', seed = 1): MapDef {
  if (playerCount < 2 || playerCount > 8) throw new Error(`buildMap: playerCount must be 2..8, got ${playerCount}`);
  const spec = SPEC[template];
  if (!spec) throw new Error(`buildMap: unknown template ${String(template)}`);
  const r = spec.radius;
  const g = MAP.groundY;
  const base = (r + spec.gap / 2) / Math.sin(Math.PI / playerCount);
  // 3+ players: the center island sits at the ring's centre (the only point equally far from every island), and the
  // ring grows if needed to keep it clear. 2 players: it sits off to the side on the bisector, so it is not a
  // stepping stone on the direct route; island→center is half the island gap, so going via the center costs the
  // same bridging as going direct.
  const two = playerCount === 2;
  const ring = two ? base : Math.max(base, r + spec.centerR[0] + spec.minCenterGap);
  const centerR = two ? spec.centerR[0] : Math.min(spec.centerR[1], Math.max(spec.centerR[0], ring - r - spec.centerGap));
  const centerDist = r + centerR + Math.max(spec.minCenterGap, spec.gap / 2);
  const c0 = two ? v3(0, 0, Math.sqrt(centerDist ** 2 - ring ** 2)) : v3(0, 0, 0);
  const islands: IslandLayout[] = [];
  const statics: StaticBox[] = [];
  const cosmetics: CosmeticDef[] = [];
  const cosmetic = (kind: CosmeticKind, pos: Vec3, rotY: number) => cosmetics.push({ id: cosmetics.length + 1, kind, pos, rotY });

  for (let i = 0; i < playerCount; i++) {
    const a = Math.PI + (2 * Math.PI * i) / playerCount;
    const center = v3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
    const inward = v3(-Math.cos(a), 0, -Math.sin(a));
    const facingYaw = yawOf(inward);
    const lat = right(facingYaw);
    const at = (fwd: number, side: number): Vec3 => {
      const p = add(add(center, scale(inward, fwd)), scale(lat, side));
      return v3(p.x, g, p.z);
    };
    const bunkerCenter = at(-(r - 7), 0);
    const off = MAP.bunker.interior / 2 + MAP.bunker.wall / 2;
    const doorways: Doorway[] = [0, Math.PI / 2, -Math.PI / 2].map((d) => {
      const yaw = facingYaw + d;
      const c = add(bunkerCenter, scale(forward(yaw), off));
      return { center: v3(c.x, g, c.z), yaw, width: MAP.bunker.doorWidth };
    });
    islands.push({
      index: i,
      center,
      radius: r,
      groundY: g,
      bunker: { center: bunkerCenter, facingYaw, doorways },
      spawn: bunkerCenter,
      generator: at(6, -6),
      vault: at(8, 0),
      shop: at(6, 6),
    });

    // Island-local statics and cosmetics: identical on every island, rotated with it.
    // Box local X runs along the island's lateral axis, local Z along -forward (toward the bunker).
    const stat = (fwd: number, side: number, half: Vec3) => {
      const c = at(fwd, side);
      statics.push({ center: v3(c.x, g + half.y, c.z), half, rotY: facingYaw, role: 'cover', island: i, look: 'container' });
    };
    const cos = (kind: CosmeticKind, fwd: number, side: number, rot = 0) => cosmetic(kind, at(fwd, side), facingYaw + rot);
    const CH = 2.59 / 2, CL = 6.06 / 2, CW = 2.44 / 2;
    if (template === 'yard') {
      // Container cover: a 1-high stack and a 2-high stack (high ground) on the flanks, a 1-high wall at the front.
      stat(1, -9.5, v3(CW, CH, CL));
      stat(1, 9.5, v3(CW, 2 * CH, CL));
      stat(13.5, 0, v3(CL, CH, CW));
      for (const s of [-1, 1]) {
        cos('lamp', -4, s * 13);
        cos('fence', -r + 1.4, s * 6.5);
        cos('fence', -r + 1.9, s * 8.6, s * 0.25);
      }
      cos('barrel', -2, 12.5); cos('barrel', -2.8, 13.1); cos('barrel', -2.2, 13.8);
      cos('crate', -3, -12.5, 0.2); cos('crate', -3.9, -12.9, -0.1);
      cos('crate', 9, -4.5, 0.4); cos('barrel', 10, 4.2);
      for (let k = 0; k < 10; k++) {
        const t = ((k + 0.5) / 10) * Math.PI * 2;
        cos('bollard', Math.cos(t) * (r - 0.45), Math.sin(t) * (r - 0.45));
      }
    } else {
      // Harbor: the mooring bollards along the coping, plus a little yard clutter.
      for (let k = 0; k < 14; k++) {
        const t = ((k + 0.5) / 14) * Math.PI * 2;
        cos('bollard', Math.cos(t) * (r - 0.45), Math.sin(t) * (r - 0.45));
      }
      for (const s of [-1, 1]) { cos('palm', -14, s * 11, s); cos('lamp', 3, s * 15); }
      cos('barrel', -4, 10); cos('barrel', -4.7, 10.6); cos('barrel', -3.9, 10.9);
      cos('crate', -3, -11, 0.3); cos('crate', -3.8, -11.5, -0.2);
      cos('fence', -r + 1.4, 8); cos('fence', -r + 1.4, -8);
    }
  }

  // Center island: shield well in the middle, three stations around it, low concrete barriers between them.
  const polar = (rad: number, deg: number, y = g) => v3(c0.x + Math.cos((deg * Math.PI) / 180) * rad, y, c0.z + Math.sin((deg * Math.PI) / 180) * rad);
  const center: CenterIsland = {
    center: c0, radius: centerR, groundY: g,
    shieldWell: v3(c0.x, g, c0.z),
    goldGen: polar(CENTER.stationRadius, 90),
    supplyGen: polar(CENTER.stationRadius, 210),
    potionShop: polar(CENTER.stationRadius, 330),
  };
  for (const deg of [30, 150, 270]) {
    // Long side (local X) tangential, so the barrier faces the middle.
    statics.push({ center: polar(7.3, deg, g + 0.55), half: v3(1.1, 0.55, 0.32), rotY: -(deg * Math.PI) / 180 + Math.PI / 2, role: 'cover', island: -1, look: 'barrier' });
  }
  for (const deg of [60, 180, 300]) cosmetic('lamp', polar(centerR - 1.2, deg), 0);
  for (const [rad, deg, kind] of [[8.2, 112, 'barrel'], [8.5, 120, 'barrel'], [8.2, 240, 'crate'], [8.6, 0, 'crate']] as const)
    cosmetic(kind, polar(rad, deg), (deg * Math.PI) / 180);

  return {
    template, name: MAP_NAMES[template], seed,
    waterY: MAP.waterY, tideRate: MAP.tideRate,
    islands, center, statics, cosmetics,
  };
}

/**
 * Static, indestructible concrete boxes that make up a bunker (walls with door gaps, lintels, roof).
 * With `slits` (default) every door-wall segment and the back wall have a firing slit: bullets and sight pass
 * through, a player can't (see bunkerSlitBoxes for the plugs that stop players and explosives). Without slits the
 * walls are whole boxes with the same footprints: what seal detection uses, so slits never change a seal.
 */
export function bunkerWallBoxes(b: Bunker, slits = true): Box[] {
  return bunkerParts(b, slits).walls;
}

/** The firing slit openings as boxes: physics plugs them for players and explosives, never for bullets. */
export function bunkerSlitBoxes(b: Bunker): Box[] {
  return bunkerParts(b, true).slits;
}

function bunkerParts(b: Bunker, withSlits: boolean): { walls: Box[]; slits: Box[] } {
  const { interior, wall, height, doorWidth, doorHeight, slit } = MAP.bunker;
  const outer = interior + 2 * wall;
  const walls: Box[] = [];
  const slits: Box[] = [];
  const push = (out: Box[], local: Vec3, half: Vec3) => {
    const c = add(b.center, rotateY(local, b.facingYaw));
    out.push({ center: c, half, rotY: b.facingYaw });
  };
  const off = interior / 2 + wall / 2;
  // Sides in bunker-local space: front (-Z), left (-X), right (+X) have doors; back (+Z) is solid.
  const sides: { normal: Vec3; door: boolean }[] = [
    { normal: v3(0, 0, -1), door: true },
    { normal: v3(-1, 0, 0), door: true },
    { normal: v3(1, 0, 0), door: true },
    { normal: v3(0, 0, 1), door: false },
  ];
  for (const s of sides) {
    const along = s.normal.x !== 0 ? v3(0, 0, 1) : v3(1, 0, 0);
    const base = scale(s.normal, off);
    const halfFor = (lenAlong: number, hy: number) =>
      s.normal.x !== 0 ? v3(wall / 2, hy, lenAlong / 2) : v3(lenAlong / 2, hy, wall / 2);
    const box = (out: Box[], a: number, len: number, y0: number, y1: number) => {
      const p = add(base, scale(along, a));
      push(out, v3(p.x, (y0 + y1) / 2, p.z), halfFor(len, (y1 - y0) / 2));
    };
    /** A wall piece centred at `a` along the side, with one slit in its middle when slits are on. */
    const piece = (a: number, len: number) => {
      if (!withSlits) { box(walls, a, len, 0, height); return; }
      box(walls, a, len, 0, slit.y0);
      box(walls, a, len, slit.y1, height);
      const side = (len - slit.width) / 2;
      for (const sign of [-1, 1]) box(walls, a + sign * (slit.width / 2 + side / 2), side, slit.y0, slit.y1);
      box(slits, a, slit.width, slit.y0, slit.y1);
    };
    if (!s.door) {
      // Back wall: two slits, as two halves.
      for (const sign of [-1, 1]) piece(sign * outer / 4, outer / 2);
      continue;
    }
    const seg = (outer - doorWidth) / 2;
    const segOff = doorWidth / 2 + seg / 2;
    for (const sign of [-1, 1]) piece(sign * segOff, seg);
    box(walls, 0, doorWidth, doorHeight, height);
  }
  push(walls, v3(0, height + 0.1, 0), v3(outer / 2, 0.1, outer / 2));
  return { walls, slits };
}
