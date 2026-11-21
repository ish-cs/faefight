import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acos, atan, atan2, cos, exp, sin } from '../../src/sim/dmath';

// Seeded inputs (no Math.random: the same every run).
function inputs(n: number, scale: number): number[] {
  let s = 987654321;
  const out: number[] = [];
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; out.push((s / 4294967296 - 0.5) * 2 * scale); }
  return out;
}
/** Error in units of the result's last place (1 ulp ≈ |x|·2^-52). */
const ulps = (got: number, want: number) => (got === want ? 0 : Math.abs(got - want) / (Math.max(Math.abs(want), 2 ** -1022) * 2 ** -52));

describe('deterministic math (dmath) agrees with Math to ~1 ulp', () => {
  const cases: [string, (x: number) => number, (x: number) => number, number[]][] = [
    ['sin', sin, Math.sin, [...inputs(20000, 10), ...inputs(2000, 1e5), ...inputs(2000, 0.5)]],
    ['cos', cos, Math.cos, [...inputs(20000, 10), ...inputs(2000, 1e5), ...inputs(2000, 0.5)]],
    ['atan', atan, Math.atan, [...inputs(20000, 10), ...inputs(2000, 1e6), ...inputs(2000, 0.3)]],
    ['acos', acos, Math.acos, inputs(20000, 1)],
    ['exp', exp, Math.exp, [...inputs(20000, 20), ...inputs(2000, 700)]],
  ];
  for (const [name, f, ref, xs] of cases)
    it(name, () => {
      let worst = 0;
      for (const x of xs) worst = Math.max(worst, ulps(f(x), ref(x)));
      expect(worst).toBeLessThanOrEqual(2);
    });
  it('atan2', () => {
    const ys = inputs(20000, 10), xs = inputs(20001, 10).slice(1);
    let worst = 0;
    for (let i = 0; i < ys.length; i++) worst = Math.max(worst, ulps(atan2(ys[i], xs[i]), Math.atan2(ys[i], xs[i])));
    expect(worst).toBeLessThanOrEqual(2);
  });
  it('special values match Math', () => {
    const sp = [0, -0, 1, -1, Infinity, -Infinity, NaN, Math.PI, -Math.PI, Math.PI / 2, 1e-300, 5e-324];
    for (const x of sp) {
      expect(Object.is(sin(x), Math.sin(x)) || ulps(sin(x), Math.sin(x)) <= 2).toBe(true);
      expect(Object.is(cos(x), Math.cos(x)) || ulps(cos(x), Math.cos(x)) <= 2).toBe(true);
      expect(Object.is(atan(x), Math.atan(x))).toBe(true);
      expect(Object.is(exp(x), Math.exp(x)) || ulps(exp(x), Math.exp(x)) <= 2).toBe(true);
      for (const y of sp) expect(Object.is(atan2(y, x), Math.atan2(y, x)), `atan2(${y}, ${x})`).toBe(true);
    }
    for (const x of [1, -1, 0.5, -0.5, 0, 2, NaN]) expect(Object.is(acos(x), Math.acos(x)), `acos(${x})`).toBe(true);
    expect(exp(710)).toBe(Infinity);
    expect(exp(-746)).toBe(0);
  });
});

// Math.sin/cos/atan2/... give different last bits in Chromium and Node, so a browser-recorded replay
// would diverge when the learning pipeline re-runs it in Node. The sim must use src/sim/dmath.ts.
it('src/sim calls no engine-dependent Math functions', () => {
  const banned = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt)\b|\*\*/;
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('dmath.ts')) continue;
      // Blank out block comments (keeping line numbers), then line comments.
      const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
      src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (banned.test(code)) bad.push(`${p}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(join(__dirname, '../../src/sim'));
  expect(bad, bad.join('\n')).toEqual([]);
});
