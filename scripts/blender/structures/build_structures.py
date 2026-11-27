"""
FAEFight cast-concrete structures: island bunker + quay wall module (Blender 5.x, headless, scripted + seeded).

  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
      --python scripts/blender/structures/build_structures.py -- [--bake 2048] [--samples 96] [--nobake]

Same pipeline shape as scripts/blender/container/build_container.py (one shared atlas, Cycles CPU bakes, numpy
composition, JPEG maps):

1. Low poly, built from the SAME numbers as the sim (src/sim/constants.ts MAP.bunker, src/sim/map.ts bunkerParts):
   - bunker: the exact union of the sim's wall boxes (interior 4, wall 0.3, height 2.6, door 1.6 × 2.2, firing slits
     0.6 × 1.35..1.53, roof slab 0.2) as a conforming grid of quads (no T-junctions), plus the interior floor at
     +0.045 (it replaces the old floor plane). Collision is untouched: this is the visual mesh only.
   - quay: one 8-segment module of the island rim (R = 22, a 128-gon: 8 segments = 8.64 m of arc), built flat
     (x along the wall, y = height below the deck, z = outward) and bent onto the rim at runtime (islands.ts):
     an 8 cm capping beam (top strip + face + soffit) over the wall face, down to 0.6 m below the waterline.
2. High poly = low poly with 2 cm bevels; Cycles bakes tangent normals (bevels), AO (ambient only at runtime),
   part IDs, world position and the low-poly normal.
3. numpy composition, all patterns in world space from the position bake (so they line up across UV islands):
   plywood formwork panels (per-panel tone, grout fins, tie holes, blowholes), cold joint under the roof pour,
   chipped arrises, spalled door jambs with exposed rusty rebar + stirrups and rust runs, bullet pockmarks around the
   slits and doors, rain streaks, dirty runs under the slits, splash dirt, efflorescence, lichen on the roof,
   a dusty floor; on the quay: expansion joints, tide zone (algae, barnacles, salt line), rust runs from old fixings.
   Heights become normal detail through their texture-space gradient (correct in any UV orientation).
     albedo.jpg  sRGB          normal.jpg  OpenGL tangent normal          arm.jpg  R = AO, G = roughness, B = 0
4. Writes public/assets/models/structures.glb (meshes bunker, quay; Blender UVs, v flipped by glTF) and
   public/assets/textures/structure/{albedo,normal,arm}.jpg.
"""
import bpy, bmesh, math, os, sys, time
import numpy as np
from mathutils import Vector

T0 = time.time()
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def opt(k, d):
    return type(d)(argv[argv.index(f'--{k}') + 1]) if f'--{k}' in argv else d

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BAKE = opt('bake', 2048)
TEX = opt('tex', 2048)      # albedo
NTEX = opt('ntex', 2048)    # normal (formwork fins, tie holes, chips)
ATEX = opt('atex', 1024)    # AO + roughness are low frequency
SAMPLES = opt('samples', 96)
SEED = opt('seed', 11)
WORK = opt('work', '/tmp/faefight-blender/structures')
OUT_GLB = os.path.join(REPO, 'public/assets/models/structures.glb')
OUT_TEX = os.path.join(REPO, 'public/assets/textures/structure')
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT_TEX, exist_ok=True); os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
def log(*a): print(f'[structures {time.time() - T0:6.1f}s]', *a, flush=True)

# ------------------------------------------------------------------------------------------------ sim numbers
# src/sim/constants.ts MAP.bunker (keep in sync; tests/client/structureModel.test.ts checks the exported mesh)
B_IN, B_WALL, B_H, B_DW, B_DH = 4.0, 0.3, 2.6, 1.6, 2.2
SL_W, SL_Y0, SL_Y1 = 0.6, 1.35, 1.53
ROOF = 0.2                      # map.ts: roof box at height + 0.1, half 0.1
FLOOR_Y = 0.045                 # interior floor (was a plane at +0.045 over the 4 cm apron slab)
OUTER = B_IN + 2 * B_WALL
# quay module: island radius 22, rim = 128-gon (CircleGeometry(R, 128)); module = 8 segments
R_ISL, SEGS, MOD_SEGS = 22.0, 128, 8
Q_W = R_ISL * 2 * math.pi * MOD_SEGS / SEGS   # arc length of the module (bent at runtime: x / R = angle)
Q_LIP = 0.08                    # capping beam stands proud of the wall face
Q_BEAM = 0.9                    # beam depth below the deck
Q_BOT = 2.6                     # module bottom below the deck (waterline at 2.0: MAP.groundY - MAP.waterY)
WATER = -2.0
Q_OFF = 40.0                    # the module sits this far along +x in the bake scene (out of the bunker's AO)

# ------------------------------------------------------------------------------------------------ geometry (sim frame: x right, y up, z back; bunker front = -z)
def bunker_boxes():
    """Port of src/sim/map.ts bunkerParts (local, slits on): [(x0, x1, y0, y1, z0, z1)]."""
    out, off = [], B_IN / 2 + B_WALL / 2
    for nx, nz, door in ((0, -1, True), (-1, 0, True), (1, 0, True), (0, 1, False)):
        ax, az = (0, 1) if nx != 0 else (1, 0)
        bx, bz = nx * off, nz * off
        def box(a, ln, y0, y1):
            px, pz = bx + ax * a, bz + az * a
            hx, hz = (B_WALL / 2, ln / 2) if nx != 0 else (ln / 2, B_WALL / 2)
            out.append((px - hx, px + hx, y0, y1, pz - hz, pz + hz))
        def piece(a, ln):
            box(a, ln, 0, SL_Y0); box(a, ln, SL_Y1, B_H)
            side = (ln - SL_W) / 2
            for s in (-1, 1): box(a + s * (SL_W / 2 + side / 2), side, SL_Y0, SL_Y1)
        if not door:
            for s in (-1, 1): piece(s * OUTER / 4, OUTER / 2)
            continue
        seg = (OUTER - B_DW) / 2
        for s in (-1, 1): piece(s * (B_DW / 2 + seg / 2), seg)
        box(0, B_DW, B_DH, B_H)
    out.append((-OUTER / 2, OUTER / 2, B_H, B_H + ROOF, -OUTER / 2, OUTER / 2))
    return out

def union_quads(boxes):
    """Exact surface of a union of axis-aligned boxes on the grid of all their bounds: one quad per exposed cell face
    (conforming: no T-junctions). Bottom faces at y = 0 are dropped (in the ground). Returns [(4 corners, normal)]."""
    r = lambda v: round(v, 6)
    xs = sorted({r(b[i]) for b in boxes for i in (0, 1)}); ys = sorted({r(b[i]) for b in boxes for i in (2, 3)}); zs = sorted({r(b[i]) for b in boxes for i in (4, 5)})
    nx, ny, nz = len(xs) - 1, len(ys) - 1, len(zs) - 1
    fill = np.zeros((nx, ny, nz), bool)
    for i in range(nx):
        for j in range(ny):
            for k in range(nz):
                c = ((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2)
                fill[i, j, k] = any(b[0] < c[0] < b[1] and b[2] < c[1] < b[3] and b[4] < c[2] < b[5] for b in boxes)
    F = lambda i, j, k: 0 <= i < nx and 0 <= j < ny and 0 <= k < nz and fill[i, j, k]
    quads = []
    for i in range(nx):
        for j in range(ny):
            for k in range(nz):
                if not fill[i, j, k]: continue
                x0, x1, y0, y1, z0, z1 = xs[i], xs[i + 1], ys[j], ys[j + 1], zs[k], zs[k + 1]
                if not F(i + 1, j, k): quads.append((((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)), (1, 0, 0)))
                if not F(i - 1, j, k): quads.append((((x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)), (-1, 0, 0)))
                if not F(i, j + 1, k): quads.append((((x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)), (0, 1, 0)))
                if not F(i, j - 1, k) and y0 > 1e-6: quads.append((((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)), (0, -1, 0)))
                if not F(i, j, k + 1): quads.append((((x1, y0, z1), (x1, y1, z1), (x0, y1, z1), (x0, y0, z1)), (0, 0, 1)))
                if not F(i, j, k - 1): quads.append((((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)), (0, 0, -1)))
    return quads

def floor_quads():
    """Interior floor + the three door thresholds at FLOOR_Y (grid-aligned with the walls)."""
    h, w = B_IN / 2, B_DW / 2
    qs = [((-h, -h), (h, h))]
    qs += [((-w, -OUTER / 2), (w, -h)), ((-OUTER / 2, -w), (-h, w)), ((h, -w), (OUTER / 2, w))]
    return [(((x0, FLOOR_Y, z0), (x0, FLOOR_Y, z1), (x1, FLOOR_Y, z1), (x1, FLOOR_Y, z0)), (0, 1, 0)) for (x0, z0), (x1, z1) in qs]

def quay_quads():
    """Module in its own frame: x along the wall (centred), y = height relative to the deck (0), z outward (0 = rim)."""
    cols = [-Q_W / 2 + Q_W * c / MOD_SEGS for c in range(MOD_SEGS + 1)]
    qs = []
    for a, b in zip(cols, cols[1:]):
        qs.append((((a, 0, 0), (a, 0, Q_LIP), (b, 0, Q_LIP), (b, 0, 0)), (0, 1, 0)))                       # beam top strip
        qs.append((((a, -Q_BEAM, Q_LIP), (b, -Q_BEAM, Q_LIP), (b, 0, Q_LIP), (a, 0, Q_LIP)), (0, 0, 1)))   # beam face
        qs.append((((a, -Q_BEAM, 0), (b, -Q_BEAM, 0), (b, -Q_BEAM, Q_LIP), (a, -Q_BEAM, Q_LIP)), (0, -1, 0)))  # soffit
        for y0, y1 in ((-Q_BOT, WATER + 0.5), (WATER + 0.5, -Q_BEAM)):
            qs.append((((a, y0, 0), (b, y0, 0), (b, y1, 0), (a, y1, 0)), (0, 0, 1)))                        # wall face
    return qs

def planar_uv(p, n):
    """Metres on the face, right-handed tangent frame (T = up × N on walls, v = world up)."""
    x, y, z = p
    if n[1] > 0.5: return (x, -z)
    if n[1] < -0.5: return (x, z)
    if n[0] > 0.5: return (-z, y)
    if n[0] < -0.5: return (z, y)
    if n[2] > 0.5: return (x, y)
    return (-x, y)

def islands(quads):
    """Union-find: quads in the same plane sharing an edge form one UV island."""
    par = list(range(len(quads)))
    def find(i):
        while par[i] != i: par[i] = par[par[i]]; i = par[i]
        return i
    plane = lambda q: (q[1], round(sum(q[0][0][a] * abs(q[1][a]) for a in range(3)), 5))
    edges = {}
    for qi, (vs, n) in enumerate(quads):
        for e in range(4):
            a, b = vs[e], vs[(e + 1) % 4]
            key = (plane(quads[qi]), tuple(sorted((tuple(round(c, 5) for c in a), tuple(round(c, 5) for c in b)))))
            if key in edges: par[find(qi)] = find(edges[key])
            else: edges[key] = qi
    groups = {}
    for qi in range(len(quads)): groups.setdefault(find(qi), []).append(qi)
    return list(groups.values())

PARTS = {'bunker': bunker_boxes, 'floor': floor_quads, 'quay': quay_quads}
QUADS = {'bunker': union_quads(bunker_boxes()), 'floor': floor_quads(), 'quay': quay_quads()}
log('quads:', {k: len(v) for k, v in QUADS.items()})

# UV islands over all three parts, metres, packed into one atlas (skyline, no rotation, uniform scale)
ISL = []   # (part, [quad idx], u0, v0, w, h)
UVM = {}   # (part, qi) -> [(u, v)] metres
for part, qs in QUADS.items():
    for grp in islands(qs):
        uvs = []
        for qi in grp:
            vs, n = qs[qi]
            UVM[(part, qi)] = [planar_uv(p, n) for p in vs]; uvs += UVM[(part, qi)]
        us, vv = [u for u, _ in uvs], [v for _, v in uvs]
        ISL.append((part, grp, min(us), min(vv), max(us) - min(us), max(vv) - min(vv)))
MARGIN = 12 / 2048
log('islands', len(ISL), 'area m2', round(sum(i[4] * i[5] for i in ISL), 1))
UVP = {}
def skyline(scale, place=False):
    sky = [(0.0, 1.0, 0.0)]
    for part, grp, u0, v0, w, h in sorted(ISL, key=lambda i: (-i[5], -i[4])):
        w2, h2 = w * scale + MARGIN, h * scale + MARGIN
        best = None
        for i, (sx, _, _) in enumerate(sky):
            if sx + w2 > 1.0 + 1e-9: break
            top, j, x_end = 0.0, i, sx + w2
            while j < len(sky) and sky[j][0] < x_end - 1e-9:
                top = max(top, sky[j][2]); j += 1
            if top + h2 <= 1.0 and (best is None or top < best[1] - 1e-9): best = (sx, top)
        if best is None: return False
        bx, by = best
        if place:
            for qi in grp:
                UVP[(part, qi)] = [(bx + MARGIN / 2 + (u - u0) * scale, by + MARGIN / 2 + (v - v0) * scale) for u, v in UVM[(part, qi)]]
        new = []
        for (sx, sw, sy) in sky:
            e = sx + sw
            if e <= bx + 1e-12 or sx >= bx + w2 - 1e-12: new.append((sx, sw, sy)); continue
            if sx < bx: new.append((sx, bx - sx, sy))
            if e > bx + w2: new.append((bx + w2, e - bx - w2, sy))
        new.append((bx, w2, by + h2)); new.sort()
        merged = []
        for seg in new:
            if merged and abs(merged[-1][2] - seg[2]) < 1e-12: merged[-1] = (merged[-1][0], merged[-1][1] + seg[1], seg[2])
            else: merged.append(seg)
        sky = merged
    return True
lo_s, hi_s = 0.001, 1.0
for _ in range(40):
    mid = (lo_s + hi_s) / 2
    lo_s, hi_s = (mid, hi_s) if skyline(mid) else (lo_s, mid)
assert skyline(lo_s, place=True), 'atlas packing failed'
UV_PER_M = lo_s
log(f'atlas {UV_PER_M * TEX:.0f} px/m at {TEX} ({1000 / (UV_PER_M * TEX):.1f} mm/texel)')

# ------------------------------------------------------------------------------------------------ Blender scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection
def B(p, off=0.0):  # sim (x, y, z) → Blender (x, -z, y)
    return Vector((p[0] + off, -p[2], p[1]))

def make_obj(name, parts, off=0.0, split=True):
    """split: faces of different normals don't share vertices (flat bake cage + flat export normals); the high-poly
    source is built connected so the bevel modifier sees the edges."""
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new('UVMap'); pid = bm.faces.layers.int.new('part')
    vmap = {}
    def V(p, n):
        k = tuple(round(c, 6) for c in p) + (tuple(n) if split else ())
        if k not in vmap: vmap[k] = bm.verts.new(B(p))
        return vmap[k]
    for part in parts:
        for qi, (vs, n) in enumerate(QUADS[part]):
            f = bm.faces.new([V(p, n) for p in vs])
            f.smooth = False
            f[pid] = list(PARTS).index(part)
            for l, uv in zip(f.loops, UVP[(part, qi)]): l[uvl].uv = uv
    bm.normal_update()
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); col.objects.link(o)
    o.location = (off, 0, 0)
    return o

low_b = make_obj('bunker', ('bunker', 'floor'))
low_q = make_obj('quay', ('quay',), Q_OFF)
for o, part in ((low_b, 'bunker'), (low_q, 'quay')):
    # winding check: every polygon normal must match the quad's declared normal
    want = [n for pt in (('bunker', 'floor') if part == 'bunker' else ('quay',)) for _, n in QUADS[pt]]
    bad = sum(1 for p, n in zip(o.data.polygons, want) if (p.normal - B(n)).length > 1e-3)
    assert bad == 0, f'{o.name}: {bad} faces wound against their normal'
tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in (low_b, low_q)}
log('low poly tris', tris)
if '--nobake' in argv: sys.exit(0)

def high_copy(src, name, keep, bevel):
    o = src.copy(); o.data = src.data.copy(); o.name = name; col.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(o.data); pl = bm.faces.layers.int['part']
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[pl] not in keep], context='FACES')
    bm.to_mesh(o.data); bm.free()
    if bevel:
        m = o.modifiers.new('bevel', 'BEVEL'); m.width = bevel; m.segments = 3; m.limit_method = 'ANGLE'; m.angle_limit = math.radians(30)
        m.harden_normals = False
        bpy.context.view_layer.objects.active = o; o.select_set(True)
        bpy.ops.object.modifier_apply(modifier='bevel'); o.select_set(False)
    return o
PI = list(PARTS)
conn_b = make_obj('bunker_conn', ('bunker', 'floor'), split=False)
conn_q = make_obj('quay_conn', ('quay',), Q_OFF, split=False)
hi_walls = high_copy(conn_b, 'hi_walls', (PI.index('bunker'),), 0.02)
hi_floor = high_copy(conn_b, 'hi_floor', (PI.index('floor'),), 0)
hi_quay = high_copy(conn_q, 'hi_quay', (PI.index('quay'),), 0.025)
for o in (conn_b, conn_q): bpy.data.objects.remove(o)
HIGH = {low_b: [hi_walls, hi_floor], low_q: [hi_quay]}
# AO occluders: the ground (apron) under the bunker, the island deck behind the quay module
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0)); ground = bpy.context.active_object; ground.name = 'ground'
bpy.ops.mesh.primitive_plane_add(size=1, location=(Q_OFF, 1.0, 0)); deck = bpy.context.active_object; deck.name = 'deck'
deck.scale = (Q_W * 1.5, 2.0, 1)  # deck: z = 0, y from 0 (rim) inward (sim -z = Blender +y)
for o in (low_b, low_q):
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_volume_scatter = o.visible_shadow = False

scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'
scene.render.threads_mode = 'FIXED'; scene.render.threads = opt('threads', 6)
scene.world = bpy.data.worlds.new('w'); scene.world.light_settings.distance = 0.9
scene.render.bake.margin = 12; scene.render.bake.margin_type = 'EXTEND'

def emit_mat(name, colour=None):
    m = bpy.data.materials.new(name); nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    if colour is not None: em.inputs['Color'].default_value = (*colour, 1)
    else:
        g = nt.nodes.new('ShaderNodeNewGeometry'); nt.links.new(g.outputs['Position'], em.inputs['Color'])
    return m
ID_COL = {hi_walls: (1, 0, 0), hi_floor: (0, 1, 0), hi_quay: (0, 0, 1)}
ID_MATS = {o: emit_mat(f'id_{o.name}', c) for o, c in ID_COL.items()}
POS_MAT = emit_mat('pos')
def set_pass(kind):
    for o in ID_COL:
        o.data.materials.clear(); o.data.materials.append(POS_MAT if kind == 'pos' else ID_MATS[o])
def new_img(name):
    img = bpy.data.images.new(name, BAKE, BAKE, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.zeros(BAKE * BAKE * 4, np.float32)); return img
bake_mat = bpy.data.materials.new('bake')
bake_node = bake_mat.node_tree.nodes.new('ShaderNodeTexImage'); bake_mat.node_tree.nodes.active = bake_node
for o in (low_b, low_q): o.data.materials.clear(); o.data.materials.append(bake_mat)
def bake(kind, img, samples, **kw):
    bake_node.image = img; scene.cycles.samples = samples
    for i, (active, sel) in enumerate(HIGH.items()):
        bpy.ops.object.select_all(action='DESELECT')
        for o in sel: o.select_set(True)
        active.select_set(True); bpy.context.view_layer.objects.active = active
        t = time.time()
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.06, max_ray_distance=0.12, use_clear=i == 0, **kw)
        log(f'bake {kind} {active.name}: {time.time() - t:.1f}s')
    arr = np.empty(BAKE * BAKE * 4, np.float32); img.pixels.foreach_get(arr)
    return arr.reshape(BAKE, BAKE, 4)
if '--recompose' in argv:  # iterate on compose.py without re-baking (bakes.npz from the last full run)
    _z = np.load(os.path.join(WORK, 'bakes.npz')); NRM, AO, IDM, POS, LN = (_z[k] for k in ('NRM', 'AO', 'IDM', 'POS', 'LN'))
else:
  set_pass('id')
  NRM = bake('NORMAL', new_img('normal'), 4, normal_space='TANGENT')
  AO = bake('AO', new_img('ao'), SAMPLES)
  IDM = bake('EMIT', new_img('id'), 4)
  set_pass('pos')
  POS = bake('EMIT', new_img('pos'), 4)
  img = new_img('lownormal'); bake_node.image = img; scene.cycles.samples = 1
  for i, active in enumerate((low_b, low_q)):
      bpy.ops.object.select_all(action='DESELECT'); active.select_set(True); bpy.context.view_layer.objects.active = active
      bpy.ops.object.bake(type='NORMAL', normal_space='OBJECT', use_selected_to_active=False, use_clear=i == 0)
  LN = np.empty(BAKE * BAKE * 4, np.float32); img.pixels.foreach_get(LN); LN = LN.reshape(BAKE, BAKE, 4)
  np.savez_compressed(os.path.join(WORK, 'bakes.npz'), NRM=NRM, AO=AO, IDM=IDM, POS=POS, LN=LN)

# ------------------------------------------------------------------------------------------------ compose
exec(compile(open(os.path.join(HERE, 'compose.py')).read(), os.path.join(HERE, 'compose.py'), 'exec'))

# ------------------------------------------------------------------------------------------------ export
for o in list(scene.objects): o.select_set(False)
low_q.location = (0, 0, 0)
for o in (low_b, low_q):
    o.data.materials.clear(); o.select_set(True)
    a = o.data.attributes.get('part'); a and o.data.attributes.remove(a)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_materials='NONE', export_texcoords=True, export_normals=True,
          export_yup=True, export_apply=True, export_vertex_color='NONE', export_tangents=False, export_animations=False)
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
log(f'wrote {OUT_GLB} ({os.path.getsize(OUT_GLB) / 1024:.0f} KB); UV_PER_M={UV_PER_M:.5f}')
