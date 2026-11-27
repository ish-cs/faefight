/**
 * Pure camera-path helpers (no three.js: unit-testable, shared by the killcam and the cinematic director).
 * - smoothDamp / smoothDampV3: critically damped spring toward a moving target (no overshoot, frame-rate independent)
 * - solveTwoShot: a collision-aware camera that frames two players, blending from a wide establishing angle
 *   (blend 0) to over the subject's shoulder toward the target (blend 1). Geometry is queried through a
 *   raycast callback, so the solver never needs the scene.
 * No allocations per call when `out` is passed (the scratch vectors are module-level).
 */

export type V3 = { x: number; y: number; z: number };
/** First hit distance along the unit ray `dir` from `o` within `far`, or null. */
export type Raycast = (o: V3, dir: V3, far: number) => number | null;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (x: number) => { const u = clamp01(x); return u * u * (3 - 2 * u); };
/** Smoother start/stop than smoothstep (zero velocity and acceleration at both ends). */
export const smootherstep = (x: number) => { const u = clamp01(x); return u * u * u * (u * (u * 6 - 15) + 10); };

/**
 * Critically damped spring (Game Programming Gems 4, 1.10): moves `cur` toward `target` with velocity `vel.v`
 * (updated in place), settling in about `smoothTime` s. Never overshoots a fixed target.
 */
export function smoothDamp(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number): number {
  if (dt <= 0) return cur;
  const w = 2 / Math.max(1e-4, smoothTime);
  const x = w * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const ch = cur - target;
  const tmp = (vel.v + w * ch) * dt;
  vel.v = (vel.v - w * tmp) * e;
  let out = target + (ch + tmp) * e;
  // No overshoot past the target.
  if ((target - cur > 0) === (out > target)) { out = target; vel.v = (out - target) / dt; }
  return out;
}

const sdx = { v: 0 }, sdy = { v: 0 }, sdz = { v: 0 };
/** smoothDamp per axis; `cur` and `vel` are updated in place. */
export function smoothDampV3(cur: V3, target: V3, vel: V3, smoothTime: number, dt: number): V3 {
  sdx.v = vel.x; sdy.v = vel.y; sdz.v = vel.z;
  cur.x = smoothDamp(cur.x, target.x, sdx, smoothTime, dt);
  cur.y = smoothDamp(cur.y, target.y, sdy, smoothTime, dt);
  cur.z = smoothDamp(cur.z, target.z, sdz, smoothTime, dt);
  vel.x = sdx.v; vel.y = sdy.v; vel.z = sdz.v;
  return cur;
}

/** Framing knobs (m). */
export const SHOT = {
  /** Look/anchor heights above the feet. */
  subjectChest: 1.45,
  targetChest: 1.25,
  /** Over the shoulder: behind, to the side, above the subject's chest; grows a little with the pair's distance. */
  shoulderBack: 2.4,
  shoulderBackPerM: 0.035,
  shoulderSide: 0.8,
  shoulderUp: 0.45,
  /** Wide: from the side of the pair, a little behind the subject, above. */
  wideDist: 5,
  wideDistPerM: 0.55,
  wideMax: 17,
  wideUp: 2.2,
  wideUpPerM: 0.12,
  wideBack: 0.35,
  /** The wide shot centres on the pair's midpoint, but never further than this from the subject (long shots: the
   *  subject side-on with the line of fire running off toward the target, not two specks). */
  wideReach: 10,
  /** Keep this far in front of whatever blocks the camera. */
  skin: 0.35,
  /** Never pulled in closer than this to the anchor. */
  minDist: 0.7,
  /** Extra heights tried when the view is blocked. */
  raise: [1.4, 3] as readonly number[],
};

export type TwoShotIn = {
  /** The subject's feet (the killer: the camera rides with them). */
  subject: V3;
  /** The target's feet (the victim). */
  target: V3;
  /** 0 = wide establishing angle, 1 = over the subject's shoulder toward the target. */
  blend: number;
  /** Preferred side (+1 right of the subject→target line, -1 left): kept unless that side is blocked. */
  side: 1 | -1;
  /** Score cost of leaving `side` (default 30: only to keep a player in sight, never for a slightly shorter pull-in; 0 = free pick). */
  switchCost?: number;
  /** Optional extra yaw (rad) swung around the pair for the wide angle (an orbit); 0 = straight from the side. */
  orbit?: number;
  raycast: Raycast;
};

export type TwoShotOut = {
  pos: V3;
  look: V3;
  /** The side actually used (feed it back as `side` next frame: hysteresis). */
  side: 1 | -1;
  /** Whether both players are in clear line of sight from `pos`. */
  clear: boolean;
};

const _s: V3 = { x: 0, y: 0, z: 0 }, _t: V3 = { x: 0, y: 0, z: 0 }, _c: V3 = { x: 0, y: 0, z: 0 };
const _d: V3 = { x: 0, y: 0, z: 0 }, _best: V3 = { x: 0, y: 0, z: 0 }, _look: V3 = { x: 0, y: 0, z: 0 };

/** Whether `a` sees `b` (no hit before reaching it, allowing `slack` m short of it). */
export function sees(a: V3, b: V3, raycast: Raycast, slack = 0.3): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return true;
  _d.x = dx / len; _d.y = dy / len; _d.z = dz / len;
  const h = raycast(a, _d, len);
  return h === null || h >= len - slack;
}

/**
 * Pulls `cam` (in place) in toward `anchor` so it sits `skin` in front of whatever lies between them.
 * Returns how far it was pulled in (0 = clear).
 */
export function clampToAnchor(anchor: V3, cam: V3, raycast: Raycast, skin = SHOT.skin, minDist = SHOT.minDist): number {
  const dx = cam.x - anchor.x, dy = cam.y - anchor.y, dz = cam.z - anchor.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return 0;
  _d.x = dx / len; _d.y = dy / len; _d.z = dz / len;
  const h = raycast(anchor, _d, len + skin);
  if (h === null) return 0;
  const want = Math.max(Math.min(minDist, len), h - skin);
  if (want >= len) return 0;
  cam.x = anchor.x + _d.x * want; cam.y = anchor.y + _d.y * want; cam.z = anchor.z + _d.z * want;
  return len - want;
}

/** A moving camera's collision (sweepCamera). */
export const SWEEP = {
  /** A frame never ends closer than this to a surface (m; the camera's near plane is 0.05). */
  skin: 0.06,
  /** A prop at most this thick along the move (a lamp post, a pole, a railing) is passed in one frame: the frame
   *  lands just beyond it, never inside. Anything thicker stops the camera. Thin enough that the pass stays a
   *  glide (≤ 0.37 m in a frame), not a jump. */
  hop: 0.25,
} as const;

const _bk: V3 = { x: 0, y: 0, z: 0 }, _far: V3 = { x: 0, y: 0, z: 0 };
/**
 * Moves a camera from `from` (where the last frame was drawn) toward `to` (updated in place) like a solid
 * object, so no frame is ever drawn from inside a prop: a thin prop on the way (≤ SWEEP.hop) is passed, landing
 * just beyond it; anything thicker stops it SWEEP.skin short of the surface. Returns true when stopped.
 */
export function sweepCamera(from: V3, to: V3, raycast: Raycast): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return false;
  _d.x = dx / len; _d.y = dy / len; _d.z = dz / len;
  const h = raycast(from, _d, len + SWEEP.skin);
  if (h === null) return false;
  {
    // Crossing (or about to touch) a surface: where does that prop end? Seen back from just past the thickest prop we'd pass.
    const reach = len + SWEEP.hop + SWEEP.skin;
    _far.x = from.x + _d.x * reach; _far.y = from.y + _d.y * reach; _far.z = from.z + _d.z * reach;
    _bk.x = -_d.x; _bk.y = -_d.y; _bk.z = -_d.z;
    const e = raycast(_far, _bk, reach - h);
    const exit = e === null ? -Infinity : reach - e;
    if (e !== null && e > 0 && exit - h <= SWEEP.hop) {
      // Thin: the frame lands beyond it (or where it was heading, if that is already past it).
      const land = Math.max(len, exit + SWEEP.skin);
      to.x = from.x + _d.x * land; to.y = from.y + _d.y * land; to.z = from.z + _d.z * land;
      return false;
    }
  }
  const want = Math.max(0, Math.min(len, h - SWEEP.skin));
  to.x = from.x + _d.x * want; to.y = from.y + _d.y * want; to.z = from.z + _d.z * want;
  return true;
}

/** How far along subject→target the wide shot centres (0.5 = midpoint; less on long shots). */
const wideFrac = (span: number) => (span > 2 * SHOT.wideReach ? SHOT.wideReach / span : 0.5);

/** The ideal (unobstructed) camera for a side and extra height, written to `o`. */
function ideal(inp: TwoShotIn, side: number, raise: number, o: V3) {
  const s = _s, t = _t;
  let fx = t.x - s.x, fz = t.z - s.z;
  const span = Math.hypot(fx, fz);
  if (span > 1e-3) { fx /= span; fz /= span; } else { fx = 0; fz = -1; }
  const rx = -fz * side, rz = fx * side; // right of the subject→target line (mirrored for side -1)
  const b = smootherstep(inp.blend);
  // Over the shoulder.
  const back = SHOT.shoulderBack + Math.min(span, 40) * SHOT.shoulderBackPerM;
  const shX = s.x - fx * back + rx * SHOT.shoulderSide, shY = s.y + SHOT.shoulderUp, shZ = s.z - fz * back + rz * SHOT.shoulderSide;
  // Wide, from the side of the pair (optionally orbited around the midpoint).
  const wf = wideFrac(span);
  const mx = s.x + (t.x - s.x) * wf, mz = s.z + (t.z - s.z) * wf;
  const near = span * wf * 2; // the span the wide shot frames
  const w = Math.min(SHOT.wideMax, SHOT.wideDist + near * SHOT.wideDistPerM);
  const a = inp.orbit ?? 0, ca = Math.cos(a), sa = Math.sin(a);
  const ox = rx * w - fx * w * SHOT.wideBack, oz = rz * w - fz * w * SHOT.wideBack;
  const wX = mx + ox * ca - oz * sa, wZ = mz + ox * sa + oz * ca;
  const wY = Math.max(s.y, t.y) + SHOT.wideUp + near * SHOT.wideUpPerM;
  o.x = wX + (shX - wX) * b;
  o.y = wY + (shY - wY) * b + raise;
  o.z = wZ + (shZ - wZ) * b;
}

/**
 * The camera for two players: candidates on the preferred side, the other side and raised, each pulled in front
 * of whatever blocks it from the subject; the best keeps both players in view and stays nearest the ideal.
 * The look point slides from the pair's midpoint (wide) to just short of the target (over the shoulder).
 * Horizon: the caller looks at `look` with world up (no roll).
 */
export function solveTwoShot(inp: TwoShotIn, out: TwoShotOut): TwoShotOut {
  const s = _s, t = _t;
  s.x = inp.subject.x; s.y = inp.subject.y + SHOT.subjectChest; s.z = inp.subject.z;
  t.x = inp.target.x; t.y = inp.target.y + SHOT.targetChest; t.z = inp.target.z;
  const b = smootherstep(inp.blend);
  const wf = wideFrac(Math.hypot(t.x - s.x, t.z - s.z));
  const mx = s.x + (t.x - s.x) * wf, my = s.y + (t.y - s.y) * wf, mz = s.z + (t.z - s.z) * wf;
  // Over the shoulder: look 85% of the way to the target, so the subject's shoulder stays in the frame edge.
  _look.x = mx + (s.x + (t.x - s.x) * 0.85 - mx) * b;
  _look.y = my + (s.y + (t.y - s.y) * 0.85 - my) * b;
  _look.z = mz + (s.z + (t.z - s.z) * 0.85 - mz) * b;
  let bestScore = Infinity, bestSide: 1 | -1 = inp.side, bestClear = false;
  const sides: (1 | -1)[] = [inp.side, inp.side === 1 ? -1 : 1];
  for (let si = 0; si < 2; si++) {
    const side = sides[si];
    for (let ri = -1; ri < SHOT.raise.length; ri++) {
      const raise = ri < 0 ? 0 : SHOT.raise[ri];
      ideal(inp, side, raise, _c);
      const ix = _c.x, iy = _c.y, iz = _c.z;
      const pulled = clampToAnchor(s, _c, inp.raycast);
      const seeS = sees(_c, s, inp.raycast), seeT = sees(_c, t, inp.raycast);
      const moved = Math.hypot(_c.x - ix, _c.y - iy, _c.z - iz);
      // Losing the target costs most, then the subject; then pull-in, height and switching sides.
      const score = (seeT ? 0 : 100) + (seeS ? 0 : 40) + pulled * 2 + moved + raise * 1.5 + (si ? inp.switchCost ?? 30 : 0);
      if (score < bestScore) {
        bestScore = score; bestSide = side; bestClear = seeS && seeT;
        _best.x = _c.x; _best.y = _c.y; _best.z = _c.z;
      }
      if (score === 0) break;
    }
    if (bestScore === 0) break;
  }
  out.pos.x = _best.x; out.pos.y = _best.y; out.pos.z = _best.z;
  out.look.x = _look.x; out.look.y = _look.y; out.look.z = _look.z;
  out.side = bestSide;
  out.clear = bestClear;
  return out;
}

/** Subject chest (the anchor the camera is clamped to): `out` = feet + chest height. */
export function subjectAnchor(feet: V3, out: V3): V3 {
  out.x = feet.x; out.y = feet.y + SHOT.subjectChest; out.z = feet.z;
  return out;
}
