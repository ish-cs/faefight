/**
 * Separable (diagonal) evolution strategy over params normalized to [0,1]^n:
 * mirrored Gaussian sampling around a mean, weighted recombination of the best half (CMA-style log weights),
 * per-dimension step sizes adapted from the selected steps (sep-CMA rank-μ update), clamped to a floor so the
 * search keeps exploring under the heavy noise of 8-player FFA fitness. Pure and seeded: same inputs, same outputs.
 */
export type EsState = { mean: number[]; sigma: number[]; gen: number };
export type EsConfig = { lambda: number; sigma0: number; sigmaMin: number; sigmaMax: number; cSigma: number };

export const DEFAULT_ES: EsConfig = { lambda: 14, sigma0: 0.12, sigmaMin: 0.02, sigmaMax: 0.3, cSigma: 0.15 };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clip01 = (x: number) => Math.min(1, Math.max(0, x));

export function initEs(mean: number[], cfg: EsConfig = DEFAULT_ES): EsState {
  return { mean: mean.map(clip01), sigma: mean.map(() => cfg.sigma0), gen: 0 };
}

/** λ candidates (mirrored pairs: m + σz, m − σz), clipped into the box. */
export function sample(st: EsState, rng: () => number, cfg: EsConfig = DEFAULT_ES): number[][] {
  if (cfg.lambda % 2) throw new Error(`ES: lambda must be even for mirrored sampling, got ${cfg.lambda}`);
  const out: number[][] = [];
  for (let k = 0; k < cfg.lambda / 2; k++) {
    const z = st.mean.map(() => gaussian(rng));
    out.push(st.mean.map((m, i) => clip01(m + st.sigma[i] * z[i])));
    out.push(st.mean.map((m, i) => clip01(m - st.sigma[i] * z[i])));
  }
  return out;
}

/** Next state from candidates and their fitness (higher is better). */
export function update(st: EsState, cands: number[][], fitness: number[], cfg: EsConfig = DEFAULT_ES): EsState {
  if (cands.length !== fitness.length) throw new Error(`ES: ${cands.length} candidates but ${fitness.length} fitness values`);
  if (fitness.some((f) => !Number.isFinite(f))) throw new Error(`ES: non-finite fitness ${JSON.stringify(fitness)}`);
  const mu = Math.floor(cands.length / 2);
  const order = fitness.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, mu);
  const raw = order.map((_, r) => Math.log(mu + 0.5) - Math.log(r + 1));
  const sum = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => x / sum);
  const n = st.mean.length;
  const mean = new Array<number>(n).fill(0);
  const vari = new Array<number>(n).fill(0);
  order.forEach(([, idx], r) => {
    for (let i = 0; i < n; i++) {
      mean[i] += w[r] * cands[idx][i];
      const d = cands[idx][i] - st.mean[i];
      vari[i] += w[r] * d * d;
    }
  });
  // Weighted variance of selected steps vs the expected σ² under no selection pressure (mu_eff-scaled).
  const sigma = st.sigma.map((s, i) => {
    const next = Math.sqrt((1 - cfg.cSigma) * s * s + cfg.cSigma * vari[i] * 1.5);
    return Math.min(cfg.sigmaMax, Math.max(cfg.sigmaMin, next));
  });
  return { mean: mean.map(clip01), sigma, gen: st.gen + 1 };
}
