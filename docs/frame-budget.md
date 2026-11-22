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

## Upscaling (ultra)

Ultra renders the scene at **0.7× output resolution with MSAA ×4** and upscales to native Retina in the final grade
pass: bilinear + a contrast-adaptive sharpen (`post.ts` `'cas'`). No extra full-resolution pass, no history, so no
ghosting and **no added latency**. Thin wires and alpha-to-coverage foliage survive (they need MSAA).

Tried and rejected (still selectable for A/B with `?upscale=`):
- `taau` (three's TAAUNode, 0.6×, jittered, velocity MRT): cheapest GPU, but power-line wires vanished, foliage
  that relies on MSAA alpha-to-coverage dithered, and characters went soft. Velocity also adds the previous instance
  matrix to every instanced mesh, which pushed critters over WebGPU's 8 vertex buffers.
- `fsr` (FSR 1 EASU + RCAS): looks the same as `cas` but adds two output-sized passes (~+40 % GPU timestamp vs `cas`).

`?upscale=0` renders native (main's ultra), `?upscaleScale=0.8` sets the input scale. Dynamic resolution on ultra
scales the *input* resolution only; output-sized targets keep their size.

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
