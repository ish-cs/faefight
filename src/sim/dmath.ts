/**
 * Deterministic transcendental math for the sim.
 *
 * Math.sin/cos/atan2/exp/acos are NOT bit-identical across JS engines: Chromium ships its own libm
 * (measured on Chrome 159: ~3–25% of random inputs differ by an ulp from Node 22's V8), so a replay
 * recorded in the browser drifted from its re-run in Node (the learning pipeline) from tick 1.
 * These are ports of fdlibm/musl that use only + - * / and Math.sqrt, which IEEE 754 defines exactly,
 * so every engine gives the same bits. The sim must use these instead of the Math.* versions
 * (tests/sim/dmath.test.ts checks that src/sim does not call the Math ones).
 *
 * Math.hypot, sqrt, abs, floor, round, min, max, sign, imul, fround stay: they are exact operations
 * (V8's hypot is its own scaled sum + sqrt, not libm).
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer); // little-endian on every platform we run on: [lo, hi]
const hiWord = (x: number) => { f64[0] = x; return u32[1] | 0; };
const loWord = (x: number) => { f64[0] = x; return u32[0] | 0; };
const fromWords = (hi: number, lo: number) => { u32[1] = hi; u32[0] = lo; return f64[0]; };
const withLoZero = (x: number) => { f64[0] = x; u32[0] = 0; return f64[0]; };

// ---- sin / cos ----

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
function kSin(x: number, y: number, iy: number): number {
  const z = x * x, w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
function kCos(x: number, y: number): number {
  const z = x * x, w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const v = 1.0 - hz;
  return v + (((1.0 - v) - hz) + (z * r - x * y));
}

const TOINT = 6755399441055744; // 1.5 / EPSILON
const INVPIO2 = 6.36619772367581382433e-01, PIO4 = 7.85398163397448278999e-01;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
const rem = [0, 0];
/**
 * x reduced by multiples of pi/2: rem = [y0, y1] (x - n·pi/2 = y0 + y1), returns n. musl's "medium"
 * Cody–Waite path, exact for |x| < 2^20·pi/2; beyond that (never in a match) still deterministic, less accurate.
 */
function remPio2(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  let fn = x * INVPIO2 + TOINT - TOINT;
  let r = x - fn * PIO2_1, w = fn * PIO2_1T;
  if (r - w < -PIO4) { fn--; r = x - fn * PIO2_1; w = fn * PIO2_1T; }
  else if (r - w > PIO4) { fn++; r = x - fn * PIO2_1; w = fn * PIO2_1T; }
  let y0 = r - w;
  const ex = ix >>> 20;
  let ey = (hiWord(y0) >>> 20) & 0x7ff;
  if (ex - ey > 16) {
    let t = r;
    w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); y0 = r - w;
    ey = (hiWord(y0) >>> 20) & 0x7ff;
    if (ex - ey > 31) {
      t = r;
      w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); y0 = r - w;
    }
  }
  rem[0] = y0;
  rem[1] = (r - y0) - w;
  return fn % 4; // fn is an exact integer; only n mod 4 matters
}

export function sin(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e500000 ? x : kSin(x, 0, 0); // |x| ≲ pi/4
  if (ix >= 0x7ff00000) return NaN;
  const n = (remPio2(x) + 4) & 3;
  const y0 = rem[0], y1 = rem[1];
  switch (n) {
    case 0: return kSin(y0, y1, 1);
    case 1: return kCos(y0, y1);
    case 2: return -kSin(y0, y1, 1);
    default: return -kCos(y0, y1);
  }
}

export function cos(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e46a09e ? 1.0 : kCos(x, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = (remPio2(x) + 4) & 3;
  const y0 = rem[0], y1 = rem[1];
  switch (n) {
    case 0: return kCos(y0, y1);
    case 1: return -kSin(y0, y1, 1);
    case 2: return -kCos(y0, y1);
    default: return kSin(y0, y1, 1);
  }
}

// ---- atan / atan2 ----

const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];

export function atan(x: number): number {
  const hx = hiWord(x), ix = hx & 0x7fffffff, neg = hx < 0;
  if (ix >= 0x44100000) { // |x| >= 2^66
    if (x !== x) return x;
    const z = ATANHI[3] + ATANLO[3];
    return neg ? -z : z;
  }
  let id: number;
  if (ix < 0x3fdc0000) { // |x| < 0.4375
    if (ix < 0x3e400000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
      else { id = 1; x = (x - 1.0) / (x + 1.0); }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
    else { id = 3; x = -1.0 / x; }
  }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return neg ? -r : r;
}

const PI = 3.1415926535897931160E+00, PI_LO = 1.2246467991473531772E-16;
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y;
  let ix = hiWord(x);
  const lx = loWord(x);
  let iy = hiWord(y);
  const ly = loWord(y);
  if (((ix - 0x3ff00000) | lx) === 0) return atan(y); // x = 1
  const m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2);
  ix &= 0x7fffffff;
  iy &= 0x7fffffff;
  if ((iy | ly) === 0) { // y = ±0
    switch (m) {
      case 0: case 1: return y;
      case 2: return PI;
      default: return -PI;
    }
  }
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2; // x = ±0
  if (ix === 0x7ff00000) { // x = ±inf
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI / 4;
        case 1: return -PI / 4;
        case 2: return 3 * PI / 4;
        default: return -3 * PI / 4;
      }
    }
    switch (m) {
      case 0: return 0.0;
      case 1: return -0.0;
      case 2: return PI;
      default: return -PI;
    }
  }
  if (ix + (64 << 20) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2; // |y/x| > 2^64
  const z = (m & 2) && iy + (64 << 20) < ix ? 0 : atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ---- acos ----

const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17;
const pS0 = 1.66666666666666657415e-01, pS1 = -3.25565818622400915405e-01, pS2 = 2.01212532134862925881e-01,
  pS3 = -4.00555345006794114027e-02, pS4 = 7.91534994289814532176e-04, pS5 = 3.47933107596021167570e-05,
  qS1 = -2.40339491173441421878e+00, qS2 = 2.02094576023350569471e+00, qS3 = -6.88283971605453293030e-01,
  qS4 = 7.70381505559019352791e-02;
function acosR(z: number): number {
  const p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
  const q = 1.0 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
  return p / q;
}

export function acos(x: number): number {
  const hx = hiWord(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) { // |x| >= 1 or NaN
    if (((ix - 0x3ff00000) | loWord(x)) === 0) return hx < 0 ? 2 * PIO2_HI : 0;
    return NaN;
  }
  if (ix < 0x3fe00000) { // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI;
    return PIO2_HI - (x - (PIO2_LO - x * acosR(x * x)));
  }
  if (hx < 0) { // x < -0.5
    const z = (1.0 + x) * 0.5, s = Math.sqrt(z);
    const w = acosR(z) * s - PIO2_LO;
    return 2 * (PIO2_HI - (s + w));
  }
  const z = (1.0 - x) * 0.5, s = Math.sqrt(z);
  const df = withLoZero(s);
  const c = (z - df * df) / (s + df);
  const w = acosR(z) * s + c;
  return 2 * (df + w);
}

// ---- exp ----

const LN2HI = 6.93147180369123816490e-01, LN2LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
  P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
const TWO1023 = fromWords(0x7fe00000, 0), TWOM1022 = fromWords(0x00100000, 0), TWO53 = fromWords(0x43400000, 0);

function scalbn(y: number, n: number): number {
  if (n > 1023) {
    y *= TWO1023; n -= 1023;
    if (n > 1023) { y *= TWO1023; n -= 1023; if (n > 1023) n = 1023; }
  } else if (n < -1022) {
    y *= TWOM1022 * TWO53; n += 1022 - 53;
    if (n < -1022) { y *= TWOM1022 * TWO53; n += 1022 - 53; if (n < -1022) n = -1022; }
  }
  return y * fromWords((0x3ff + n) << 20, 0);
}

export function exp(x: number): number {
  const hx0 = hiWord(x), neg = hx0 < 0 ? 1 : 0, hx = hx0 & 0x7fffffff;
  if (hx >= 0x4086232b) { // |x| >= 708.39 or NaN
    if (x !== x) return x;
    if (x > 709.782712893383973096) return Infinity;
    if (x < -745.13321910194110842) return 0;
  }
  let hi: number, lo: number, k: number;
  if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
    k = hx >= 0x3ff0a2b2 ? Math.trunc(INVLN2 * x + (neg ? -0.5 : 0.5)) : 1 - neg - neg;
    hi = x - k * LN2HI;
    lo = k * LN2LO;
    x = hi - lo;
  } else if (hx > 0x3e300000) { // |x| > 2^-28
    k = 0; hi = x; lo = 0;
  } else {
    return 1 + x;
  }
  const xx = x * x;
  const c = x - xx * (P1 + xx * (P2 + xx * (P3 + xx * (P4 + xx * P5))));
  const y = 1 + (x * c / (2 - c) - lo + hi);
  return k === 0 ? y : scalbn(y, k);
}
