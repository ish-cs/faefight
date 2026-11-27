import * as THREE from 'three/webgpu';

/**
 * BatchedMesh culling once per frame instead of once per pass (perf stage B).
 *
 * three's WebGPU Batch node calls `_updateDrawParameters(camera)` on every pass a BatchedMesh is drawn in (camera +
 * each shadow cascade): a per-instance frustum cull, then a re-upload of the r32uint indirect texture — even when
 * nothing changed. That was ~40 texture uploads and a few thousand sphere tests per frame. Here each mesh culls once
 * per frame against the union of the frame's frusta (main camera + every shadow cascade, the cascades padded by
 * `CASCADE_PAD` m since a cascade may move later in the same frame), keeps the world-space instance spheres cached
 * until the matrices change, and re-uploads the indirect texture only when the visible list actually changed.
 * A pass drawn from any other camera (impostor bakes, thumbnails) falls back to three's own per-pass cull.
 */
export const CASCADE_PAD = 2;

const cull = {
  frame: 0,
  /** frusta of this frame: [0] = main camera, the rest = cascades (padded) */
  frusta: [] as THREE.Frustum[],
  cams: [] as THREE.Camera[],
  n: 0,
};
const _m = new THREE.Matrix4();

/** Call once per frame before drawing: the main camera and the shadow cascade cameras of the frame. */
export function beginBatchCullFrame(camera: THREE.Camera, cascades: readonly THREE.Camera[]) {
  cull.frame++;
  cull.n = 1 + cascades.length;
  while (cull.frusta.length < cull.n) cull.frusta.push(new THREE.Frustum());
  cull.cams.length = 0;
  cull.cams.push(camera, ...cascades);
  for (let i = 0; i < cull.n; i++) {
    const c = cull.cams[i];
    c.updateMatrixWorld();
    _m.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    cull.frusta[i].setFromProjectionMatrix(_m, c.coordinateSystem, (c as { reversedDepth?: boolean }).reversedDepth);
  }
}

type Priv = {
  _instanceInfo: { visible: boolean; active: boolean; geometryIndex: number }[];
  _geometryInfo: { start: number; count: number }[];
  _mergedDrawStarts: Int32Array; _mergedDrawCounts: Int32Array; _mergedDrawInstanceCounts: Int32Array;
  _multiDrawStarts: Int32Array; _multiDrawCounts: Int32Array;
  _mergedDrawCount: number; _multiDrawCount: number; _multiDrawBytesPerElement: number;
  _visibilityChanged: boolean;
  _indirectTexture: THREE.DataTexture;
  _matricesTexture: THREE.DataTexture;
  _updateDrawParameters: (camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, drawFormat?: string) => void;
};

const _s = new THREE.Sphere();

/** Stats (debug / census): per-frame culls done, uploads done, passes served from the frame's cull. */
export const batchCullStats = { culls: 0, uploads: 0, reused: 0, fallback: 0 };

/** Replace this mesh's per-pass cull with the per-frame union cull (needs sortObjects = false, perObjectFrustumCulled). */
export function installBatchCull(mesh: THREE.BatchedMesh) {
  const p = mesh as unknown as Priv;
  const orig = p._updateDrawParameters.bind(mesh);
  let frame = -1;
  let spheres = new Float32Array(0);
  let spheresVer = -1;
  const lastWorld = new Float32Array(16).fill(NaN);
  // three's WebGPU onBeforeRender flags the indirect texture for upload on every pass when perObjectFrustumCulled;
  // the cull below flags it only when the list changed
  mesh.onBeforeRender = () => {};
  p._updateDrawParameters = (camera, geometry, material, drawFormat = 'multiDraw') => {
    if (mesh.sortObjects || !mesh.perObjectFrustumCulled || (material as { wireframe?: boolean }).wireframe || !cull.cams.includes(camera)) {
      frame = -1; // the next registered pass recomputes (the texture now holds this pass's list)
      batchCullStats.fallback++;
      orig(camera, geometry, material, drawFormat);
      return;
    }
    if (frame === cull.frame && !p._visibilityChanged) { batchCullStats.reused++; return; }
    frame = cull.frame;
    batchCullStats.culls++;
    const info = p._instanceInfo, geos = p._geometryInfo;
    const n = info.length;
    // world-space instance spheres, recomputed only when an instance or the mesh moved
    const mw = mesh.matrixWorld.elements;
    let worldMoved = false;
    for (let i = 0; i < 16; i++) if (lastWorld[i] !== mw[i]) { worldMoved = true; lastWorld[i] = mw[i]; }
    const ver = p._matricesTexture.version;
    if (worldMoved || ver !== spheresVer || spheres.length < n * 4) {
      if (spheres.length < n * 4) spheres = new Float32Array(n * 4);
      spheresVer = ver;
      for (let i = 0; i < n; i++) {
        const ii = info[i];
        if (!ii.active) continue;
        mesh.getMatrixAt(i, _m);
        _m.premultiply(mesh.matrixWorld);
        mesh.getBoundingSphereAt(ii.geometryIndex, _s)!.applyMatrix4(_m);
        spheres[i * 4] = _s.center.x; spheres[i * 4 + 1] = _s.center.y; spheres[i * 4 + 2] = _s.center.z; spheres[i * 4 + 3] = _s.radius;
      }
    }
    const index = geometry.getIndex();
    const bpe = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
    const merged = drawFormat === 'merged';
    const ind = p._indirectTexture.image.data as Uint32Array;
    const ms = p._mergedDrawStarts, mc = p._mergedDrawCounts, mic = p._mergedDrawInstanceCounts;
    const fr = cull.frusta, nf = cull.n;
    let count = 0, mcount = 0, changed = false;
    for (let i = 0; i < n; i++) {
      const ii = info[i];
      if (!ii.visible || !ii.active) continue;
      _s.center.set(spheres[i * 4], spheres[i * 4 + 1], spheres[i * 4 + 2]);
      const r = spheres[i * 4 + 3];
      _s.radius = r;
      let inView = fr[0].intersectsSphere(_s);
      if (!inView) {
        _s.radius = r + CASCADE_PAD;
        for (let f = 1; f < nf && !inView; f++) inView = fr[f].intersectsSphere(_s);
      }
      if (!inView) continue;
      const gi = geos[ii.geometryIndex];
      const start = gi.start * bpe, cnt = gi.count;
      if (merged) {
        if (mcount > 0 && ms[mcount - 1] === start && mc[mcount - 1] === cnt) mic[mcount - 1]++;
        else { ms[mcount] = start; mc[mcount] = cnt; mic[mcount] = 1; mcount++; }
      } else {
        p._multiDrawStarts[count] = start; p._multiDrawCounts[count] = cnt;
      }
      if (ind[count] !== i) { ind[count] = i; changed = true; }
      count++;
    }
    if (count !== p._multiDrawCount) changed = true;
    if (changed) { p._indirectTexture.needsUpdate = true; batchCullStats.uploads++; }
    p._multiDrawCount = count;
    p._mergedDrawCount = mcount;
    p._multiDrawBytesPerElement = bpe;
    p._visibilityChanged = false;
  };
}
