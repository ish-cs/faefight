# Frame budget: 120 fps on best settings

Target: **120 fps (8.3 ms) on Ultra at native Retina** on the user's Mac (M4 Max, 120 Hz ProMotion), with every
round-11 feature on. Every feature fits inside the numbers below. Measure with `tests/visual/perfAB.mjs` (prod
specs, interleaved A/B, under the heavy lock). See `docs/perf.md` for the LOD, batching and shadow APIs.

## The frame (8.3 ms)

| where | budget | today (ultra, 2× DPR, 8 players) |
|---|---|---|
| main thread (sim apply, interp, three's draw submission) | **≤ 5.5 ms** | see "Measured" |
| GPU total | **≤ 7.5 ms** | see "Measured" |
| — scene pass (opaque + transparent, TAAU input res) | ≤ 3.5 ms | |
| — shadow cascades (2 near every frame, far cached) | ≤ 1.2 ms | |
| — GTAO (half of scene res) | ≤ 1.0 ms | |
| — TAAU resolve + bloom + grade/sharpen (output res) | ≤ 1.0 ms | |
| — headroom for new features, all of round 11 together | ≤ 0.8 ms | |

A single new feature may cost at most **~2 % of frame time (≈ 0.15 ms GPU, 0.1 ms CPU)** at the same view.

## Hard limits

| item | limit | why |
|---|---|---|
| draw calls (camera) | **≤ 300** at any view on high/ultra | ~15–25 µs CPU each, × every shadow cascade they cast into |
| shadow casters per near cascade | ≤ 150 draws | near cascades render every frame |
| new shadow-casting meshes | chunked / instanced only; small (< 0.6 m) → `SMALL_CASTER_LAYER` | far cascades are cached; near ones are not |
| real-time lights | **the existing 3 point lights only** (fire, muzzle, explosion), pooled | adding or removing a light recompiles every lit material (seconds) and adds per-pixel cost to every fragment on screen |
| new lights for features (lamps, day/night, grapple, traps) | emissive materials + bloom, or move one of the pooled lights | the emissive MRT target already blooms for free |
| day/night | animate `SkyLighting.sun` colour/intensity/direction and env uniforms; do **not** add a second shadowed light | each shadowed light = another full cascade set |
| sun direction changes | invalidate the far-cascade cache at most every 0.5 s (`shadowCache`) | cached far cascades assume a still sun |
| triangles | ≤ 3.5 M visible | GPU vertex cost is small next to fill, keep LOD anyway |
| transparent / additive overdraw | ≤ 2 full-screen layers at worst view (rain + 1 effect) | fill-rate bound at Retina |
| particles | pooled, one `InstancedMesh`/sprite batch per effect kind, no per-particle mesh | draw calls |
| per-frame allocations | **none** in the frame loop (no `new Vector3`, `clone()`, closures, arrays) | GC hitches show as p99 spikes |
| shader variants | no material may switch defines/nodes mid-match; build every variant at load (warm-up) | a mid-match compile is a 100 ms – 20 s freeze |
| post passes | no new full-screen pass at output res without a measurement; prefer half-res | each full-res pass at 3456×2234 ≈ 0.3–0.6 ms |
| ragdolls / footprints / shells / wet decals | pooled, capped (shells ≤ 64, footprints ≤ 128 as one instanced mesh, ragdolls ≤ 4 simulated) | |

## Temporal upscaling (ultra)

Ultra renders the scene at **0.6× output resolution** (jittered, no MSAA) and reconstructs native Retina with TAAU
(`post.ts`, three's `TAAUNode`): per-pixel motion vectors (velocity MRT), Halton jitter, variance-clipped history, then
a contrast-adaptive sharpen. Same-frame resolve: **no added latency**. Consequences for feature work:

- **Everything that moves must move through its object/instance/bone matrices** (three writes motion vectors for
  those). Vertex-shader-only animation (wind, waves) has no motion vectors and is held together by the history
  clamp; keep it slow and low-amplitude, or it smears.
- **Transparent effects** (rain, sparks, smoke) are reconstructed too. Keep them short-lived or bright; thin
  sub-pixel streaks should be at least ~1.5 input pixels wide or they flicker.
- Dynamic resolution on ultra scales the *input* resolution only; the output and TAAU history keep their size.
- `?taau=0` turns it off (A/B), `?taau=0.7` sets the input scale.

## Frame governor

When "Dynamic resolution" is on, the governor now budgets for the display's refresh rate (probed from rAF at load,
`refresh.ts`) instead of a fixed 60 fps, so a 120 Hz panel holds 120 fps. A frame cap still wins when set.
