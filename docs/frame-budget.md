# Frame budget: 120 fps on best settings

Target: **120 fps (8.3 ms) on Ultra at native Retina** on the user's Mac (M4 Max, 120 Hz ProMotion), with every
round-11 feature on. Every feature fits inside the numbers below. Measure with `tests/visual/perfAB.mjs` (prod
specs, interleaved A/B, under the heavy lock). See `docs/perf.md` for the LOD, batching and shadow APIs.

## The frame (8.3 ms)

| where | budget | today (ultra, 2× DPR, 8 players, Nov 21) |
|---|---|---|
| main thread (sim apply, interp, three's draw submission) | **≤ 5.5 ms** | 3.3–8.0 ms (load-dependent; worst at mid-map, 360+ draws) |
| GPU total | **≤ 7.5 ms** | ≈ 5.3–9 ms (110–256 GPU-done fps per view) |
| — scene pass (opaque + transparent, 0.7× MSAA ×4) | ≤ 4.5 ms | largest share (≈ 2/3 of timestamp total) |
| — GTAO (half of scene res, 12 samples) | ≤ 1.5 ms | ≈ 1/3 |
| — output-res grade + upscale/sharpen + flare | ≤ 1.5 ms | ≈ 1/3 |
| — ocean | ≤ 0.6 ms | ≈ 1/10 |
| — shadow cascades (2 near every frame, far cached) | ≤ 0.5 ms | ≈ 0 (cached) |
| — bloom | ≤ 0.2 ms | ≈ 3 % |
| — headroom for new features, all of round 11 together | ≤ 0.8 ms | |

Shares come from `tests/visual/passCost.mjs` (GPU timestamps overlap on Apple GPUs, so shares don't sum to 100 %).

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
| camera/aim raycast targets (`renderer.collidables`) | no map-wide mesh: pass merged meshes through `raycastProxies()` (raycastProxy.ts) | 2–3 rays/frame test every triangle of any mesh whose box they cross; merged slabs + bunkers cost realism3 ~0.9 ms/frame |
| per-frame allocations | **none** in the frame loop (no `new Vector3`, `clone()`, closures, arrays) | GC hitches show as p99 spikes |
| shader variants | no material may switch defines/nodes mid-match; build every variant at load (warm-up) | a mid-match compile is a 100 ms – 20 s freeze |
| post passes | no new full-screen pass at output res without a measurement; prefer half-res | each full-res pass at 3456×2234 ≈ 0.3–0.6 ms |
| ragdolls / footprints / shells / wet decals | pooled, capped (shells ≤ 64, footprints ≤ 128 as one instanced mesh, ragdolls ≤ 4 simulated) | |

## Upscaling (high / ultra): TAAU

High and ultra render the scene **without MSAA** at a fraction of the output (ultra 0.67× of 2× DPR, high 0.75× of
1.5× DPR) and reconstruct + anti-alias at output size from jittered history (`taau.ts`, a fork of three's TAAUNode),
then RCAS-sharpen inside the grade pass (no extra output-resolution pass). Low keeps native MSAA ×4.

Rules for anything that moves on screen (velocity MRT, `velocity.ts`):
- Vertex displacement through `positionNode` is handled for every material (its displacement is carried into the
  previous position). Fast time-driven animation (wing flaps): use `timeDisplaced(m, t => …)`.
- Camera-following meshes must follow in the shader (a uniform offset), not through `mesh.position`.
- Instanced materials near WebGPU's 8 vertex buffers: `staticVelocity(m)` (camera-only motion, no previous buffers).
- Additive FX are reactive automatically (no history lock behind tracers/sparks); a normal-blended FX layer that
  moves fast calls `reactive(m)`. `?taaudbg=1` shows motion vectors and the reactive mask.

`?upscale=cas` (0.7× MSAA ×4 + CAS, the previous ultra), `?upscale=fsr`, `?upscale=0` (native MSAA) stay for A/B;
`?upscaleScale=` sets the input scale.

## Measuring: what to trust

- **GPU-done fps** (perfMatch column, `__faefight.gpuFps()`): frames the GPU actually finished per second. This is
  the throughput number.
- rAF fps **overstates** throughput with vsync off: frames queue on the GPU (0.2–0.5 s look→GPU-done on main).
- GPU timestamp ms (`?gputime=1`) are **inflated** on Apple GPUs (tile-based passes overlap; 47 ms reported while
  the GPU finishes 120 frames/s) — use them only as *relative* per-pass shares (`tests/visual/passCost.mjs`).
- `look→GPU done` latency is in perfMatch too; it must stay under ~3 frames.

## GPU queue latency cap

The frame loop skips a rAF while the oldest unfinished GPU frame is older than 40 ms (`refresh.ts` `FrameQueue`).
Without it, a GPU-bound frame loop queued 0.2–0.6 s of work (look → GPU done). A 2-frame count cap was tried first and
starved the GPU, because Chrome reports `onSubmittedWorkDone` 15–25 ms late. `?gpuqueue=25` / `=0` for A/B.

## Frame governor

When "Dynamic resolution" is on, the governor now budgets for the display's refresh rate (probed from rAF at load,
`refresh.ts`) instead of a fixed 60 fps, so a 120 Hz panel holds 120 fps. A frame cap still wins when set.

## Draw-count techniques in use

- Static dressing: `StaticBatch` bins per material, heavy bins emitted **indexed** (from the parts' indexed twins).
- Moving props: one `BatchedMesh` per material across kinds, `sortObjects = false`, plus **one shadow-only batch**
  (`SHADOW_ONLY_FIRST_LAYER`, first cascade only) instead of a shadow draw per material (gameProps.ts, debris.ts).
- Self-lit inserts (`lit`, `lamp`, `glow`) never cast (`NO_SHADOW`, lod.ts).
- Small static parts cast into the first cascade only; the second near cascade renders every other frame.
- Tried and removed: per-cell shadow stand-ins for map-wide meshes (each cascade's long light frustum touched
  several cells: +20 shadow draws for −200k shadow tris; under load draws cost more than triangles).

## Known follow-ups (realism3, Nov 22)

Realism3 runs at ~0.90–0.95 of main's fps under load (120+ in quiet runs). What's left:
- **Dock clusters far LOD.** Clusters are the largest remaining cost (+16 % with them off, quiet run). They share the
  map-wide dressing meshes, so a per-island far version (one cheap vertex-coloured material per far island) saves GPU
  but adds ~6–20 draws: worth it only when GPU-bound. Distant islands must still read as busy docks (150–300 m).
- **Storm wet layer.** The storm view is the widest gap (0.85–0.96): the rain/wet shading on realism3's extra
  weathered materials is pure per-pixel cost. A distance fade of the wet + weathering layers (skip the noise fetches
  past ~60 m) is the candidate; check same-view shots.
