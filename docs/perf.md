# Rendering performance: how to add content without costing frames

This is for anyone adding props, creatures or effects under `src/client/world`. The engine handles LOD, culling,
shadow-caster filtering and the frame-time governor. Your job is to register through it instead of creating
map-wide meshes.

## The rules

1. **Never make one mesh or InstancedMesh that spans the whole map.** three.js frustum-culls per mesh, so a
   map-wide mesh is always drawn, including into every shadow cascade. Split it spatially (the helpers below do this).
2. **Static, non-moving props**: use `StaticBatch` and build with `{ chunked: true }`. Nothing else is needed.
3. **Many copies of one model** (pallets, drums, crates, critters at rest): use `ChunkedInstances`.
4. **Single objects with a cheaper far version**: use `registerLod`.
5. **Small things** (under ~0.6 m radius) cast shadows only in the near cascades. Put them on
   `SMALL_CASTER_LAYER`. The helpers do this for you.
6. **Animated things**: skip the update while hidden or off-screen (see "Idle work").

Distances you pass are metres **at the high preset**. The manager multiplies them by the preset
(`LOD_QUALITY_SCALE`: low 0.65, high 1, ultra 1.35) and by the governor's LOD bias (0.6–1). Switches between
levels use ±12 % hysteresis, so nothing flickers at a threshold.

## Static dressing: `StaticBatch` (src/client/world/geo.ts)

```ts
const b = new StaticBatch();
b.add(material, geometry, matrix, tint, cast, receive);   // as before
b.build(parent, 'myProps', { chunked: true });            // ← the only change
```

With `chunked: true`, parts are binned by (material, cast, receive), size class and chunk:

| class  | bounding radius | grid | culled beyond (high) | shadows |
|--------|-----------------|------|----------------------|---------|
| small  | < 0.6 m         | 16 m | 70 m                 | near cascades only |
| medium | < 4 m           | 32 m | 240 m                | all cascades |
| large  | ≥ 4 m           | 64 m | never                | all cascades |

Leave out `chunked` only for batches that move as a whole (a boat group, a crane hook). Their meshes
use local coordinates, and distance culling would test the wrong place.

## Repeated models: `ChunkedInstances` (src/client/world/chunked.ts)

```ts
import { ChunkedInstances } from './chunked';

const pallets = new ChunkedInstances({
  name: 'pallet',
  levels: [
    { parts: [{ geometry, material, cast: true }], maxDist: 40 },  // full detail up to 40 m
    { simplify: 0.35, parts: null, maxDist: 140 },                 // auto-simplified (meshoptimizer) up to 140 m
  ],                                                               // beyond the last maxDist: culled
  small: true,   // near-cascade shadows only
  chunk: 16,     // grid size (m), default 16
});
for (const p of placements) pallets.add(matrix, color, tier);   // tier 0 = always, higher = thinned first
parent.add(pallets.build());   // registers with the LOD manager itself

pallets.setTierLimit(quality === 'low' ? 0 : 2);   // quality thinning, per chunk
pallets.setVisible(id, false);                    // e.g. a broken prop
pallets.dispose();                                // map teardown (unregisters)
```

- `parts` is the same `{ geometry, material, cast, receive }[]` that `StaticBatch.take()` returns. Build a model
  once with `StaticBatch` and pass `take()`.
- **Impostors**: add a level `{ parts: null, impostor: { views: 8, cell: 128 }, maxDist: 4000 }`. Level 0 is
  baked once into an 8-view atlas, lit by the world's sun and environment (impostor.ts). It is drawn as one
  camera-facing quad per instance (one draw per chunk) and keeps each instance's tint, scale, yaw and hidden state.
  Bakes are queued, one model per frame, during the loading/reveal frames. Use impostors for anything tall that
  stays visible far away: palms, lamps, cranes, stacks. Breakable cosmetics use them from 70 m (cosmetics.ts).
- A level can be `parts: null`, meaning nothing is drawn in that distance band.
- `simplify: r` generates the level from level 0 asynchronously. Level 0 geometry shows until it's ready, so
  load never blocks on it.
- Each chunk × level × part is one draw. 16 m chunks suit dense props. Use 32 m for sparse ones.

## Single objects: `registerLod` / `registerDistanceCull` (src/client/world/lod.ts)

```ts
import { registerLod, registerDistanceCull, releaseLods } from './lod';

group.add(full, low);                              // both in the scene
mesh.userData.lod = registerLod([full, low, null], [35, 150]);   // full < 35 m < low < 150 m < hidden
other.userData.lod = registerDistanceCull(other, 90);
// teardown: releaseLods(root) unregisters every userData.lod under root
```

For anything custom, implement `LodTarget` (`updateLod(cam, scale)`, optional `lodEvery` for refreshing every
N frames) and call `lods.register(target)`. The pure math lives in `lodMath.ts` (`selectLod`, `chunkKey`,
`distToSphere`) and is unit-tested.

## Shadows

- `SMALL_CASTER_LAYER` (layer 4): drawn by the camera, cast into the first 2 cascades only (first 1 on low).
  `mesh.layers.set(SMALL_CASTER_LAYER)`. The helpers above do this for small props.
- Don't set `castShadow` on flat ground clutter (decals, chains, puddles, footprints). It doubles their cost for
  nothing.
- Chunked meshes are also culled per cascade by the cascade's own frustum. A map-wide mesh is not.
- **Cached far cascades** (shadowCache.ts, sky.ts): the sun never moves and the world is static, so the far
  cascades re-render only when the camera has moved 1.5 m or turned 3.4° since their last render, or after 24
  frames at most. At most one far cascade renders per frame. Near cascades render every frame. Far-away
  *moving* casters can therefore lag up to 24 frames in the far cascades, which is invisible at that distance.
  Don't rely on far cascades for anything that moves fast and matters.

## Textures

PBR sets (`public/assets/textures/<set>/{albedo,normal,arm}`) ship as KTX2/Basis: ETC1S for albedo and ARM,
UASTC+RDO+Zstd for normals, full mip chains baked in, Y-flipped to match the JPEG path. `preloadPbr()` loads them
before the world builds and transcodes them in a worker to BC7/BC1/ASTC/ETC2, whatever the GPU supports. Any map
that fails falls back to its JPEG. `?ktx2=0` forces JPEG for A/B. To re-encode after changing a JPEG, run
`node scripts/encodeKtx2.mjs [set]` (see the script header for the dev-only encoder install). Anisotropy is
2/8/16 for low/high/ultra.

## Idle work

- Animated props and critters: update only when `obj.visible` (LOD may have hidden it). Do the work at a lower
  rate when far away, e.g. every 2nd–4th frame beyond 60 m.
- Physics props: let bodies sleep. Skip the mesh sync for sleeping bodies (`body.isSleeping()`).

## Frame-time governor (src/client/governor.ts)

Settings → Video "Dynamic resolution" turns it on. When the smoothed frame time exceeds the budget, it steps down
one rung at a time: GTAO off → shadow maps ½ → grass ½ → LOD distances ×0.7 → render resolution 0.9 … 0.6.
With headroom it climbs back last-in, first-out. Content gets LOD bias and grass density for free if it uses
the APIs above.

## Measuring

- In game: **F3** toggles the FPS counter. **Shift+F3** toggles perf detail: frame ms, GPU ms (with `?gputime=1`),
  draw calls, triangles, governor rung, resolution and LOD scale. `?debug=1` shows detail by default.
  `window.__faefight.governor()` and `.renderInfo()` return the same data.
- Harness (headless, 1600×900, vsync off, 8 players). Run it under the heavy lock:
  `node tests/visual/perfMatch.mjs [--stress=3] [--presets=low,high,ultra] [--shots=docs/screens/perf-x]`.
  It needs a running server (`GAME_URL`). `tests/visual/perfAB.mjs` wraps it: it takes the heavy lock, starts one
  vite per source tree, runs each spec, then kills the servers and releases the lock.
  `?debug=1&stress=3` triples every decorative prop.
- `tests/visual/sceneCensus.mjs`: meshes grouped by name (count, visible, casters, triangles). Use it to find
  what costs draws.
