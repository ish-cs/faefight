"""
FAEFight shipping-container asset pipeline (Blender 5.x, headless, fully scripted + seeded = reproducible).

  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
      --python scripts/blender/container/build_container.py -- [--bake 2048] [--tex 1024] [--samples 128] [--work DIR]
  then: NODE_PATH=/tmp/ktx/node_modules node scripts/encodeKtx2.mjs container      (see encodeKtx2.mjs header)

1. High poly ISO 20 ft box (6.058 × 2.591 × 2.438 m): trapezoidal side/end/roof corrugation, ribbed doors, frame with
   forklift pockets, corner castings with oval apertures (boolean), locking bars, cams + keepers, handles, hinges,
   rubber gaskets, CSC plate, seeded dents + panel waviness, stencilled markings (fictional owner code).
2. Low poly LOD0 (shell + frame + locking bars) and LOD1 (5 quads) sharing ONE hand-oriented UV atlas
   (islands upright: texture v = world up on every wall, so rust runs can be grown downward in texture space).
3. Cycles bakes high → low: tangent normals, AO (low poly ray-invisible), part IDs, object position, low-poly normal.
4. numpy composition into a white-livery atlas: paint (+ CC0 Poly Haven "Rusty Painted Metal" scan as paint mottling
   and rust grain), edge wear from normal-map curvature, rust at the sills / castings / roof pools, rust runs, grime,
   chipped stencils. The livery is NOT baked: arm.b codes how much the per-container vertex colour tints a texel.
     albedo.jpg  sRGB, white-livery colour
     normal.jpg  OpenGL tangent normal
     arm.jpg     R = baked AO (ambient only; the sun stays dynamic), G = roughness,
                 B = 1 tinted paint / 0.5 untinted dielectric (rust, stencils, rubber) / 0 bare metal
5. Writes public/assets/models/container.glb (meshes container_lod0, container_lod1; Blender UVs, v flipped by glTF)
   and public/assets/textures/container/*.jpg.
"""
import bpy, bmesh, math, os, sys, random, time
import numpy as np
from mathutils import Matrix, Vector

T0 = time.time()
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def opt(k, d):
    return type(d)(argv[argv.index(f'--{k}') + 1]) if f'--{k}' in argv else d

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BAKE = opt('bake', 2048)
TEX = opt('tex', 2048)      # albedo + ARM (stencils + livery mask need the texels)
NTEX = opt('ntex', 1024)    # normal (corrugation / dents are low-frequency; a tiled detail normal adds grain)
SAMPLES = opt('samples', 128)
SEED = opt('seed', 20)
WORK = opt('work', '/tmp/faefight-blender/container')
OUT_GLB = os.path.join(REPO, 'public/assets/models/container.glb')
OUT_TEX = os.path.join(REPO, 'public/assets/textures/container')
DETAIL_SRC = os.path.join(REPO, 'public/assets/textures/painted_metal/albedo.jpg')  # Poly Haven CC0
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT_TEX, exist_ok=True); os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
rnd = random.Random(SEED)
def log(*a): print(f'[container {time.time() - T0:6.1f}s]', *a, flush=True)

# ------------------------------------------------------------------------------------------------ dimensions (m)
L, W, H = 6.058, 2.438, 2.591
hl, hw = L / 2, W / 2
SIDE_IN, FRONT_IN, DOOR_IN, ROOF_IN = 0.035, 0.045, 0.055, 0.03   # wall mean planes inset from the outer frame
POST = 0.16                                                        # corner post footprint
CAST = (0.178, 0.162, 0.118)                                       # ISO corner casting x, y, z
BARS_Y = (-0.86, -0.36, 0.36, 0.86)
BAR_R, BAR_X = 0.0165, hl - 0.015

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

def link(name, me):
    o = bpy.data.objects.new(name, me); col.objects.link(o); return o

def grid_mesh(name, P, closed_u=False):
    """P: (nv, nu, 3) vertex grid → quad mesh (winding u then v = U×V normal)."""
    nv, nu, _ = P.shape
    j, i = np.meshgrid(np.arange(nv - 1), np.arange(nu - 1), indexing='ij')
    a = (j * nu + i).ravel()
    faces = np.stack([a, a + 1, a + 1 + nu, a + nu], 1)
    me = bpy.data.meshes.new(name)
    me.from_pydata(P.reshape(-1, 3).tolist(), [], faces.tolist())
    me.update()
    return me

def box_bm(bm, x0, x1, y0, y1, z0, z1):
    m = Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1))
    return bmesh.ops.create_cube(bm, size=1.0, matrix=m)

def cyl_bm(bm, r, z0, z1, x, y, seg=16, axis='z'):
    d = z1 - z0
    rot = {'z': Matrix.Identity(4), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]
    c = {'z': (x, y, (z0 + z1) / 2), 'x': ((z0 + z1) / 2, x, y), 'y': (x, (z0 + z1) / 2, y)}[axis]
    return bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=d, matrix=Matrix.Translation(c) @ rot)

def bm_obj(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return link(name, me)

# ------------------------------------------------------------------------------------------------ high poly
def trap(t, a=0.26, s=0.24):
    """Trapezoid profile (period 1): +1 outer flat, slope, -1 inner flat, slope."""
    t = np.mod(t, 1.0)
    b = 1 - 2 * s - a
    out = np.ones_like(t)
    dn = (t >= a) & (t < a + s); out[dn] = 1 - 2 * (t[dn] - a) / s
    inn = (t >= a + s) & (t < a + s + b); out[inn] = -1
    up = t >= a + s + b; out[up] = -1 + 2 * (t[up] - a - s - b) / s
    return out

def rounded(f, du, radius=0.012):
    """Box-filter a profile sampled along axis 1 (rounds the folds like pressed sheet)."""
    k = max(1, int(round(radius / du)))
    pad = np.pad(f, ((0, 0), (k, k)), mode='edge')
    c = np.cumsum(pad, 1); c = np.pad(c, ((0, 0), (1, 0)))
    return (c[:, 2 * k + 1:] - c[:, :-2 * k - 1]) / (2 * k + 1)

def dent_field(U, V, dents, wave=0.0, wseed=0.0):
    off = np.zeros_like(U)
    for (u, v, r, d) in dents:
        off -= d * np.exp(-((U - u) ** 2 + (V - v) ** 2) / (r * r))
    if wave:  # oil-canning: low-frequency panel waviness
        off += wave * np.sin(U * 2.1 + wseed) * np.sin(V * 2.7 + wseed * 1.7)
    return off

def rand_dents(u0, u1, v0, v1, n, rmin, rmax, dmin, dmax, low_bias=0.0):
    out = []
    for _ in range(n):
        v = v0 + (v1 - v0) * (rnd.random() ** (1 + low_bias))
        out.append((rnd.uniform(u0, u1), v, rnd.uniform(rmin, rmax), rnd.uniform(dmin, dmax)))
    return out

def corr_panel(name, origin, U, V, N, u0, u1, v0, v1, du, nv, period, depth, along='u', dents=(), wave=0.0, profile=None):
    us = np.arange(u0, u1 + du * 0.5, du)
    vs = np.linspace(v0, v1, nv)
    UU, VV = np.meshgrid(us, vs)
    if profile is not None:
        prof = profile(UU, VV)
    elif along == 'u':
        prof = rounded(trap((UU - u0) / period), du)
    else:  # profile varies along v: round along v by transposing
        prof = rounded(trap((VV - v0) / period).T, (v1 - v0) / (nv - 1)).T
    off = prof * depth / 2 + dent_field(UU, VV, dents, wave, rnd.random() * 6)
    P = np.asarray(origin)[None, None] + UU[..., None] * np.asarray(U) + VV[..., None] * np.asarray(V) + off[..., None] * np.asarray(N)
    return link(name, grid_mesh(name, P))

HIGH, HIGH_BARS, DECALS, CUTTERS = [], [], [], []
def hi(o, ident='paint'):
    o['id'] = ident; HIGH.append(o); return o

UP = (0, 0, 1)
# side walls (vertical corrugation, 21 periods between the posts)
su0, su1 = -hl + POST - 0.03, hl - POST + 0.03
SP = (2 * hl - 2 * POST) / 21
for sgn in (1, -1):
    N = (0, sgn, 0); Uax = (-sgn, 0, 0)
    dents = rand_dents(su0, su1, 0.2, H - 0.2, 7, 0.12, 0.45, 0.006, 0.022, low_bias=1.0) + rand_dents(su0, su1, 0.15, 0.9, 3, 0.05, 0.1, 0.01, 0.02)
    hi(corr_panel(f'side{sgn:+d}', (0, sgn * (hw - SIDE_IN), 0), Uax, UP, N, su0, su1, 0.1, H - 0.07, 0.006, 64, SP, 0.036, dents=dents, wave=0.004))
# front end wall (vertical corrugation, deeper)
fu = hw - POST + 0.03
hi(corr_panel('front', (-hl + FRONT_IN, 0, 0), (0, -1, 0), UP, (-1, 0, 0), -fu, fu, 0.08, H - 0.07, 0.006, 64, (2 * hw - 2 * POST) / 8, 0.045,
              dents=rand_dents(-fu, fu, 0.2, H - 0.2, 4, 0.1, 0.35, 0.006, 0.018), wave=0.003))
# roof (ribs across the width → profile along the length), dents from twistlocks / spreaders
ru0, ru1 = -hl + POST - 0.03, hl - POST + 0.03
hi(corr_panel('roof', (0, 0, H - ROOF_IN), (1, 0, 0), (0, 1, 0), (0, 0, 1), ru0, ru1, -hw + 0.05, hw - 0.05, 0.006, 48, (ru1 - ru0) / 24, 0.02,
              dents=rand_dents(ru0, ru1, -hw + 0.2, hw - 0.2, 6, 0.15, 0.5, 0.01, 0.035), wave=0.003))
# doors: two leaves, horizontal pressed ribs
def door_profile(v0, v1):
    def f(UU, VV):
        t = (VV - v0) / (v1 - v0)
        band = np.mod(t * 5, 1.0)
        rib = np.clip((np.minimum(band - 0.25, 0.75 - band)) / 0.06, 0, 1)
        flat = (t > 0.05) & (t < 0.95)
        return np.where(flat, rib * 2 - 1, -1) * 0.5 + 0.5
    return f
dv0, dv1 = 0.16, H - 0.14
for sgn in (1, -1):
    ua, ub = (0.012, hw - POST + 0.02) if sgn > 0 else (-(hw - POST + 0.02), -0.012)
    hi(corr_panel(f'door{sgn:+d}', (hl - DOOR_IN, 0, 0), (0, 1, 0), UP, (1, 0, 0), ua, ub, dv0 - 0.02, dv1 + 0.02, 0.006, 160, 1, 0.05,
                  profile=door_profile(dv0, dv1), dents=rand_dents(ua, ub, 0.3, H - 0.3, 2, 0.1, 0.3, 0.004, 0.012), wave=0.002))

# frame (one object, bevelled)
bm = bmesh.new()
for sx in (-1, 1):
    for sy in (-1, 1):
        x0, x1 = (-hl, -hl + POST) if sx < 0 else (hl - POST, hl)
        y0, y1 = (-hw, -hw + POST) if sy < 0 else (hw - POST, hw)
        box_bm(bm, x0, x1, y0, y1, CAST[2], H - CAST[2])
        # post face recess strip (pressed section)
        if sx < 0: box_bm(bm, x0 - 0.0, x0 + 0.012, (y0 + y1) / 2 - 0.035, (y0 + y1) / 2 + 0.035, CAST[2] + 0.02, H - CAST[2] - 0.02)
for sy in (-1, 1):
    yo, yi = sy * hw, sy * (hw - 0.10)
    ya, yb = min(yo, yi), max(yo, yi)
    # bottom side rail with two forklift pockets (x = ±1.025, 0.36 wide)
    xs = [-hl + CAST[0], -1.025 - 0.18, -1.025 + 0.18, 1.025 - 0.18, 1.025 + 0.18, hl - CAST[0]]
    for k in range(0, 6, 2): box_bm(bm, xs[k], xs[k + 1], ya, yb, 0.0, 0.16)
    for k in (1, 3):
        rec = sy * (hw - 0.075)
        box_bm(bm, xs[k], xs[k + 1], min(rec, yi), max(rec, yi), 0.0, 0.16)                  # pocket back
        box_bm(bm, xs[k], xs[k + 1], ya, yb, 0.0, 0.022); box_bm(bm, xs[k], xs[k + 1], ya, yb, 0.135, 0.16)  # lips
    # top side rail (square tube) + a lower lip
    box_bm(bm, -hl + CAST[0], hl - CAST[0], min(sy * hw, sy * (hw - 0.08)), max(sy * hw, sy * (hw - 0.08)), H - 0.10, H - 0.006)
for x0, x1, zb, zt in ((-hl, -hl + 0.12, 0.12, 0.10), (hl - 0.12, hl, 0.16, 0.14)):  # front rails, door sill + header
    box_bm(bm, x0, x1, -hw + CAST[1], hw - CAST[1], 0.0, zb)
    box_bm(bm, x0, x1, -hw + CAST[1], hw - CAST[1], H - zt, H - 0.006)
# underside cross members (seen from low angles only)
for k in range(9):
    x = -hl + 0.5 + k * (L - 1.0) / 8
    box_bm(bm, x - 0.05, x + 0.05, -hw + 0.08, hw - 0.08, 0.0, 0.12)
frame = hi(bm_obj('frame', bm))
bev = frame.modifiers.new('bevel', 'BEVEL'); bev.width = 0.006; bev.segments = 2; bev.limit_method = 'ANGLE'

# corner castings with oval apertures
for sx in (-1, 1):
    for sy in (-1, 1):
        for top in (0, 1):
            bm = bmesh.new()
            x0, x1 = (-hl, -hl + CAST[0]) if sx < 0 else (hl - CAST[0], hl)
            y0, y1 = (-hw, -hw + CAST[1]) if sy < 0 else (hw - CAST[1], hw)
            z0, z1 = (H - CAST[2], H) if top else (0, CAST[2])
            box_bm(bm, x0, x1, y0, y1, z0, z1)
            c = bm_obj(f'cast{sx}{sy}{top}', bm)
            cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
            holes = [  # (centre, axis, rx, ry) oval cutters, 3 cm deep into the casting
                ((cx, sy * hw, cz), 'y', 0.062, 0.0315),
                ((sx * hl, cy, cz), 'x', 0.03, 0.025),
            ]
            if top: holes.append(((cx, cy, H), 'z', 0.062, 0.0315))
            for (p, ax, rx, ry) in holes:
                cb = bmesh.new()
                bmesh.ops.create_cone(cb, cap_ends=True, segments=24, radius1=1, radius2=1, depth=0.06,
                                      matrix=Matrix.Translation(p) @ {'z': Matrix.Identity(4), 'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(math.pi / 2, 4, 'X')}[ax]
                                      @ Matrix.Diagonal((rx, ry, 1, 1)))
                cut = bm_obj('cutter', cb); cut.hide_render = True; cut.display_type = 'WIRE'; CUTTERS.append(cut)
                bo = c.modifiers.new('hole', 'BOOLEAN'); bo.operation = 'DIFFERENCE'; bo.object = cut; bo.solver = 'EXACT'
            b2 = c.modifiers.new('bevel', 'BEVEL'); b2.width = 0.004; b2.segments = 2; b2.limit_method = 'ANGLE'
            hi(c)

# door hardware (painted) + gaskets (rubber) + CSC plate
bm = bmesh.new()
for y in BARS_Y:
    for z in (0.45, 1.3, 2.15): box_bm(bm, hl - DOOR_IN + 0.01, hl - 0.002, y - 0.045, y + 0.045, z - 0.035, z + 0.035)   # bar guides
    for z in (0.12, H - 0.12): box_bm(bm, BAR_X - 0.025, BAR_X + 0.02, y - 0.03, y + 0.03, z - 0.035, z + 0.035)         # cams
    box_bm(bm, hl - 0.02, hl + 0.012, y - 0.05, y + 0.05, 0.10, 0.155)                                                    # keepers (sill)
    box_bm(bm, hl - 0.02, hl + 0.012, y - 0.05, y + 0.05, H - 0.135, H - 0.08)                                            # keepers (header)
    inward = -0.32 if abs(y) > 0.6 else 0.30
    inward *= 1 if y > 0 else -1
    box_bm(bm, BAR_X - 0.02, BAR_X + 0.025, y - 0.03, y + 0.03, 1.0, 1.1)                                                 # handle hub
    box_bm(bm, BAR_X + 0.005, BAR_X + 0.03, min(y, y + inward), max(y, y + inward), 1.03, 1.07)                           # lever
    yr = y + inward
    box_bm(bm, hl - DOOR_IN + 0.01, BAR_X + 0.03, yr - 0.03, yr + 0.03, 0.98, 1.12)                                       # retainer
for sy in (-1, 1):
    for z in (0.32, 0.95, 1.65, 2.28):
        cyl_bm(bm, 0.022, z - 0.055, z + 0.055, hl - 0.022, sy * (hw - POST - 0.005), seg=12)
        box_bm(bm, hl - DOOR_IN, hl - DOOR_IN + 0.02, min(sy * (hw - POST), sy * (hw - POST - 0.17)), max(sy * (hw - POST), sy * (hw - POST - 0.17)), z - 0.04, z + 0.04)
hw_obj = hi(bm_obj('hardware', bm))
b3 = hw_obj.modifiers.new('bevel', 'BEVEL'); b3.width = 0.003; b3.segments = 1; b3.limit_method = 'ANGLE'
bm = bmesh.new()
gx0, gx1 = hl - DOOR_IN - 0.02, hl - DOOR_IN + 0.012
for sy in (-1, 1):
    box_bm(bm, gx0, gx1, min(sy * (hw - POST), sy * (hw - POST - 0.018)), max(sy * (hw - POST), sy * (hw - POST - 0.018)), dv0 - 0.02, dv1 + 0.02)
box_bm(bm, gx0, gx1, -0.012, 0.012, dv0 - 0.02, dv1 + 0.02)
box_bm(bm, gx0, gx1, -hw + POST, hw - POST, dv0 - 0.02, dv0 - 0.002)
box_bm(bm, gx0, gx1, -hw + POST, hw - POST, dv1 + 0.002, dv1 + 0.02)
hi(bm_obj('gaskets', bm), 'rubber')
bm = bmesh.new(); box_bm(bm, hl - 0.04, hl - 0.034, -0.72, -0.5, 1.2, 1.32)
hi(bm_obj('csc_plate', bm), 'plate')
# locking bars (galvanised), baked onto their own low-poly bars
bm = bmesh.new()
for y in BARS_Y: cyl_bm(bm, BAR_R, 0.07, H - 0.07, BAR_X, y, seg=16)
bars_hi = bm_obj('bars_hi', bm); bars_hi['id'] = 'galv'; HIGH_BARS.append(bars_hi)
for p in bars_hi.data.polygons: p.use_smooth = True

# stencils (fictional owner code; Blender's built-in font)
def text(body, size, origin, n, align='CENTER', name='txt'):
    cu = bpy.data.curves.new(name, 'FONT'); cu.body = body; cu.size = size; cu.align_x = align; cu.align_y = 'CENTER'
    o = link(name, cu)
    n = Vector(n); r = Vector(UP).cross(n).normalized(); up = n.cross(r)
    o.matrix_world = Matrix.Translation(origin) @ Matrix((r, up, n)).transposed().to_4x4()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    bpy.data.objects.remove(o); bpy.data.curves.remove(cu)
    m = link(name, me); m.matrix_world = Matrix.Translation(origin) @ Matrix((r, up, n)).transposed().to_4x4()
    m['id'] = 'decal'; DECALS.append(m); return m
CODE, TYPE = 'FAEU 204871 3', '22G1'
for sgn in (1, -1):
    y = sgn * (hw - 0.012); n = (0, sgn, 0)
    text(CODE, 0.13, (hl - 1.05, y, H - 0.36), n)
    text(TYPE, 0.12, (hl - 1.05, y, H - 0.54), n)
    text('PALMERA', 0.5, (-0.35, y, 1.3), n)
    text('LINES', 0.2, (-0.35, y, 0.92), n)
text(CODE, 0.12, (-hl + 0.018, 0, H - 0.36), (-1, 0, 0))
text(TYPE, 0.11, (-hl + 0.018, 0, H - 0.52), (-1, 0, 0))
dxx = hl - 0.038
text(CODE, 0.1, (dxx, 0.62, H - 0.4), (1, 0, 0))
text(TYPE, 0.09, (dxx, 0.62, H - 0.54), (1, 0, 0))
for k, line in enumerate(('MAX.GROSS  30,480 KG', '                 67,200 LB', 'TARE          2,230 KG', '                   4,920 LB',
                          'NET          28,250 KG', 'CU.CAP.     33.2 CU.M')):
    text(line, 0.045, (dxx, 0.62, 1.92 - k * 0.062), (1, 0, 0), name=f'w{k}')
text('PALMERA', 0.12, (dxx, -0.62, H - 0.42), (1, 0, 0))
log(f'high poly: {sum(len(o.data.polygons) for o in HIGH + HIGH_BARS)} faces, {len(DECALS)} stencils')

# ------------------------------------------------------------------------------------------------ low poly + atlas
# shell (part 0) = the wall mean planes; frame boxes (part 1); locking bars (part 2)
CORE = (-hl + FRONT_IN, hl - DOOR_IN, -hw + SIDE_IN, hw - SIDE_IN, 0.05, H - ROOF_IN)
FRAME = []
for sx in (-1, 1):
    for sy in (-1, 1):
        FRAME.append(((-hl, -hl + POST) if sx < 0 else (hl - POST, hl)) + ((-hw, -hw + POST) if sy < 0 else (hw - POST, hw)) + (0.0, H))
for sy in (-1, 1):
    ya, yb = sorted((sy * hw, sy * (hw - 0.10))); FRAME.append((-hl + POST, hl - POST, ya, yb, 0.0, 0.16))
    ya, yb = sorted((sy * hw, sy * (hw - 0.08))); FRAME.append((-hl + POST, hl - POST, ya, yb, H - 0.10, H - 0.006))
FRAME += [(-hl, -hl + 0.12, -hw + POST, hw - POST, 0.0, 0.12), (-hl, -hl + 0.12, -hw + POST, hw - POST, H - 0.10, H - 0.006),
          (hl - 0.12, hl, -hw + POST, hw - POST, 0.0, 0.16), (hl - 0.12, hl, -hw + POST, hw - POST, H - 0.14, H - 0.006)]
SOLIDS = [CORE] + FRAME

def inside(p, b, eps=1e-4):
    return b[0] + eps < p.x < b[1] - eps and b[2] + eps < p.y < b[3] - eps and b[4] + eps < p.z < b[5] - eps

bm = bmesh.new()
part = bm.faces.layers.int.new('part'); solid = bm.faces.layers.int.new('solid')
for si, b in enumerate(FRAME):
    res = box_bm(bm, *b)
    for f in {f for v in res['verts'] for f in v.link_faces}:
        f[part] = 1; f[solid] = si + 1
bm.normal_update()
dead = []
for f in bm.faces:
    c = f.calc_center_median()
    if f.normal.z < -0.5 and c.z < 0.2:  # undersides at deck level: never seen (on the deck or another box)
        dead.append(f); continue
    probes = [c] + [c.lerp(v.co, 0.9) for v in f.verts]
    probes = [p + f.normal * 0.002 for p in probes]
    if all(any(inside(p, b) for k, b in enumerate(SOLIDS) if k != f[solid]) for p in probes): dead.append(f)
bmesh.ops.delete(bm, geom=dead, context='FACES')
# shell: wall mean planes clipped to the openings between the frame members (no atlas space under the frame)
def quad(pts, n):
    vs = [bm.verts.new(p) for p in pts]
    f = bm.faces.new(vs); f.normal_update()
    if f.normal.dot(Vector(n)) < 0: f.normal_flip()
    f[part] = 0; f[solid] = 0
x0, x1, y0, y1, zb, zt = CORE
for sy in (-1, 1):
    y = sy * (hw - SIDE_IN)
    quad([(-hl + POST, y, 0.16), (hl - POST, y, 0.16), (hl - POST, y, H - 0.10), (-hl + POST, y, H - 0.10)], (0, sy, 0))
quad([(-hl + 0.12, -hw + 0.08, zt), (hl - 0.12, -hw + 0.08, zt), (hl - 0.12, hw - 0.08, zt), (-hl + 0.12, hw - 0.08, zt)], (0, 0, 1))
quad([(x0, -hw + POST, 0.12), (x0, hw - POST, 0.12), (x0, hw - POST, H - 0.10), (x0, -hw + POST, H - 0.10)], (-1, 0, 0))
quad([(x1, -hw + POST, 0.16), (x1, hw - POST, 0.16), (x1, hw - POST, H - 0.14), (x1, -hw + POST, H - 0.14)], (1, 0, 0))
for y in BARS_Y:
    res = bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=BAR_R, radius2=BAR_R, depth=H - 0.14, matrix=Matrix.Translation((BAR_X, y, H / 2)))
    for f in {f for v in res['verts'] for f in v.link_faces}: f[part] = 2; f[solid] = -1; f.smooth = True
bm.normal_update()

uvl = bm.loops.layers.uv.new('UVMap')
for f in bm.faces:
    if f[part] == 2:  # bar: cylindrical (arc length, height)
        cx = BAR_X; cy = min(BARS_Y, key=lambda y: abs(y - f.calc_center_median().y))
        angs = [math.atan2(l.vert.co.y - cy, l.vert.co.x - cx) for l in f.loops]
        if max(angs) - min(angs) > math.pi: angs = [a + 2 * math.pi if a < 0 else a for a in angs]
        for l, a in zip(f.loops, angs): l[uvl].uv = (a * BAR_R, l.vert.co.z)
        continue
    n = f.normal
    k = 0.7 if (f[part] == 0 and n.z > 0.5) else 1.0   # roof: 70 % texel density (seen from far / above)
    for l in f.loops:
        p = l.vert.co
        if abs(n.z) > 0.5: uv = (p.x, p.y * (1 if n.z > 0 else -1))
        else:
            r = Vector(UP).cross(n).normalized(); uv = (p.dot(r), p.z)
        l[uvl].uv = (uv[0] * k, uv[1] * k)
# skyline-pack the islands (no rotation: texture v stays world-up), largest uniform scale that fits the unit square
def islands_of(bm):
    groups = {}
    for f in bm.faces:
        key = ('bar', round(f.calc_center_median().y, 2)) if f[part] == 2 else ('face', f.index)
        groups.setdefault(key, []).append(f)
    return list(groups.values())
ISL = []
for fs in islands_of(bm):
    us = [l[uvl].uv.x for f in fs for l in f.loops]; vs = [l[uvl].uv.y for f in fs for l in f.loops]
    ISL.append((fs, min(us), min(vs), max(us) - min(us), max(vs) - min(vs)))
MARGIN = 6 / 1024  # 6 px at 1K = 12 px at 2K: room for mip bleed
log('island area m2:', round(sum(i[3] * i[4] for i in ISL), 2), 'n', len(ISL), 'top:', sorted([(round(i[3],2), round(i[4],2)) for i in ISL], key=lambda t: -t[0]*t[1])[:12])
def skyline(scale, place=False):
    """Skyline bottom-left packer: each island (tallest first) goes where the skyline is lowest."""
    sky = [(0.0, 1.0, 0.0)]  # segments (x, width, y)
    for fs, u0, v0, w, h in sorted(ISL, key=lambda i: (-i[3], -i[4])):
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
            for f in fs:
                for l in f.loops:
                    l[uvl].uv = (bx + MARGIN / 2 + (l[uvl].uv.x - u0) * scale, by + MARGIN / 2 + (l[uvl].uv.y - v0) * scale)
        # raise the skyline over [bx, bx + w2]
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
lo_s, hi_s = 0.01, 1.0
for _ in range(40):
    mid = (lo_s + hi_s) / 2
    lo_s, hi_s = (mid, hi_s) if skyline(mid) else (lo_s, mid)
assert skyline(lo_s, place=True), 'atlas packing failed'
low = bm_obj('container_lod0', bm)

# texel density (UV units per metre) from a side-wall face
me = low.data; uvd = me.uv_layers['UVMap'].data
side = next(p for p in me.polygons if p.normal.y > 0.9 and p.area > 5)  # shell side quad
l0, l1 = side.loop_indices[0], side.loop_indices[1]
v0, v1 = me.vertices[me.loops[l0].vertex_index].co, me.vertices[me.loops[l1].vertex_index].co
UV_PER_M = (Vector(uvd[l0].uv) - Vector(uvd[l1].uv)).length / (v0 - v1).length
log(f'low poly: {sum(len(p.vertices) - 2 for p in me.polygons)} tris, atlas {UV_PER_M * TEX:.0f} px/m at {TEX}, {UV_PER_M * BAKE:.0f} px/m baked')

if '--nobake' in argv: sys.exit(0)

def split_copy(src, name, keep):
    o = src.copy(); o.data = src.data.copy(); o.name = name; col.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(o.data); pl = bm.faces.layers.int['part']
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[pl] not in keep], context='FACES')
    bm.to_mesh(o.data); bm.free(); return o
lowA = split_copy(low, 'bakeA', (0, 1))
lowB = split_copy(low, 'bakeB', (2,))
lod1 = split_copy(low, 'container_lod1', (0,))
for v in lod1.data.vertices:  # shell quads → outer box faces (far field: corrugated walls without the frame relief)
    v.co.x = -hl if v.co.x < -hl + 0.5 else hl if v.co.x > hl - 0.5 else v.co.x
    v.co.y = -hw if v.co.y < -hw + 0.5 else hw if v.co.y > hw - 0.5 else v.co.y
    v.co.z = 0.0 if v.co.z < 0.5 else H
for o in (low, lowA, lowB, lod1):
    o.visible_camera = o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_volume_scatter = o.visible_shadow = False

# ------------------------------------------------------------------------------------------------ bake
scene.render.engine = 'CYCLES'
try:
    if '--gpu' not in argv: raise RuntimeError('CPU by default (Metal kernel compile crashes headless Blender 5.3)')
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = True
    scene.cycles.device = 'GPU'
except Exception as e:
    log('CPU bake:', e); scene.cycles.device = 'CPU'
scene.render.threads_mode = 'FIXED'; scene.render.threads = opt('threads', 6)
scene.world = bpy.data.worlds.new('w'); scene.world.light_settings.distance = 0.5
scene.render.bake.margin = 6; scene.render.bake.margin_type = 'EXTEND'

IDS = {'paint': (1, 0, 0), 'galv': (0, 1, 0), 'rubber': (0, 0, 1), 'decal': (1, 1, 1), 'plate': (0, 1, 1)}
def emit_mat(name, colour=None):
    m = bpy.data.materials.new(name); nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    if colour is not None: em.inputs['Color'].default_value = (*colour, 1)
    else:  # object position normalised to the box: (p + (hl, hw, 0)) / (L, W, H)
        g = nt.nodes.new('ShaderNodeNewGeometry'); a = nt.nodes.new('ShaderNodeVectorMath'); a.operation = 'ADD'
        a.inputs[1].default_value = (hl, hw, 0); d = nt.nodes.new('ShaderNodeVectorMath'); d.operation = 'DIVIDE'
        d.inputs[1].default_value = (L, W, H)
        nt.links.new(g.outputs['Position'], a.inputs[0]); nt.links.new(a.outputs[0], d.inputs[0]); nt.links.new(d.outputs[0], em.inputs['Color'])
    return m
ID_MATS = {k: emit_mat(f'id_{k}', c) for k, c in IDS.items()}
POS_MAT = emit_mat('pos')
ALL_HIGH = HIGH + HIGH_BARS + DECALS
def set_pass(kind):
    for o in ALL_HIGH:
        o.data.materials.clear(); o.data.materials.append(POS_MAT if kind == 'pos' else ID_MATS[o['id']])

def new_img(name):
    img = bpy.data.images.new(name, BAKE, BAKE, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.zeros(BAKE * BAKE * 4, np.float32)); return img
bake_mat = bpy.data.materials.new('bake'); 
bake_node = bake_mat.node_tree.nodes.new('ShaderNodeTexImage'); bake_mat.node_tree.nodes.active = bake_node
for o in (lowA, lowB): o.data.materials.clear(); o.data.materials.append(bake_mat)

def bake(kind, img, samples, decals=False, **kw):
    bake_node.image = img
    scene.cycles.samples = samples
    for o in DECALS: o.hide_render = not decals
    for active, sel, clear in ((lowA, HIGH + (DECALS if decals else []), True), (lowB, HIGH_BARS, False)):
        bpy.ops.object.select_all(action='DESELECT')
        for o in sel: o.select_set(True)
        active.select_set(True); bpy.context.view_layer.objects.active = active
        t = time.time()
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.1, max_ray_distance=0.25, use_clear=clear, **kw)
        log(f'bake {kind} {active.name}: {time.time() - t:.1f}s')
    arr = np.empty(BAKE * BAKE * 4, np.float32); img.pixels.foreach_get(arr)
    img.filepath_raw = os.path.join(WORK, f'bake_{img.name}.png'); img.file_format = 'PNG'; img.save()
    return arr.reshape(BAKE, BAKE, 4)

set_pass('id')
NRM = bake('NORMAL', new_img('normal'), 4, normal_space='TANGENT')
AO = bake('AO', new_img('ao'), SAMPLES)
IDM = bake('EMIT', new_img('id'), 4, decals=True)
set_pass('pos')
POS = bake('EMIT', new_img('pos'), 4)
# low-poly object-space normal (face orientation per texel)
img = new_img('lownormal'); bake_node.image = img; scene.cycles.samples = 1
for active, clear in ((lowA, True), (lowB, False)):
    bpy.ops.object.select_all(action='DESELECT'); active.select_set(True); bpy.context.view_layer.objects.active = active
    bpy.ops.object.bake(type='NORMAL', normal_space='OBJECT', use_selected_to_active=False, use_clear=clear)
LN = np.empty(BAKE * BAKE * 4, np.float32); img.pixels.foreach_get(LN); LN = LN.reshape(BAKE, BAKE, 4)

# ------------------------------------------------------------------------------------------------ compose
nrng = np.random.default_rng(SEED)
def vnoise(n, cx, cy):
    g = nrng.random((cy + 2, cx + 2)).astype(np.float32)
    fx = np.linspace(0, cx, n, endpoint=False); ix = fx.astype(int); tx = fx - ix; tx = tx * tx * (3 - 2 * tx)
    fy = np.linspace(0, cy, n, endpoint=False); iy = fy.astype(int); ty = fy - iy; ty = ty * ty * (3 - 2 * ty)
    a = g[iy][:, ix]; b = g[iy][:, ix + 1]; c = g[iy + 1][:, ix]; d = g[iy + 1][:, ix + 1]
    tx = tx[None, :]; ty = ty[:, None]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
def fbm(cells, octaves=4, aniso=1.0):
    out = np.zeros((BAKE, BAKE), np.float32); amp, tot = 1.0, 0.0
    for o in range(octaves):
        c = cells * 2 ** o
        out += amp * vnoise(BAKE, int(c), max(1, int(c / aniso))); tot += amp; amp *= 0.5
    return out / tot
def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
def blur(a, r):
    for ax in (0, 1):
        c = np.cumsum(np.pad(a, [(r, r) if i == ax else (0, 0) for i in range(a.ndim)], mode='edge'), ax)
        c = np.concatenate([np.zeros_like(np.take(c, [0], ax)), c], ax)
        a = (np.take(c, range(2 * r + 1, c.shape[ax]), ax) - np.take(c, range(0, c.shape[ax] - 2 * r - 1), ax)) / (2 * r + 1)
    return a

M_PX = UV_PER_M * BAKE  # bake pixels per metre (non-roof)
cov = IDM[..., :3].sum(-1) > 0.05
pal = np.array(list(IDS.values()), np.float32); names = list(IDS.keys())
cls = np.argmin(((IDM[..., None, :3] - pal[None, None]) ** 2).sum(-1), -1)
is_ = {k: (cls == i) & cov for i, k in enumerate(names)}
px, py, pz = POS[..., 0] * L - hl, POS[..., 1] * W - hw, POS[..., 2] * H
ln = LN[..., :3] * 2 - 1
vert = np.abs(ln[..., 2]) < 0.5; top = ln[..., 2] > 0.5
ao = np.clip(AO[..., 0], 0, 1)
nx, ny = NRM[..., 0] * 2 - 1, NRM[..., 1] * 2 - 1
curv = blur((np.roll(nx, -1, 1) - np.roll(nx, 1, 1)) + (np.roll(ny, -1, 0) - np.roll(ny, 1, 0)), 2)
curv = np.where(cov, curv, 0) / (np.percentile(np.abs(curv[cov]), 99) + 1e-6)

# CC0 scan (Poly Haven Rusty Painted Metal) tiled at 1 m: paint mottling + rust grain
det = bpy.data.images.load(DETAIL_SRC); dw, dh = det.size
d = np.empty(dw * dh * 4, np.float32); det.pixels.foreach_get(d); d = d.reshape(dh, dw, 4)[..., :3]
dl = (0.2126 * d[..., 0] + 0.7152 * d[..., 1] + 0.0722 * d[..., 2]) ** 2.2
yy, xx = np.mgrid[0:BAKE, 0:BAKE]
dlum = dl[((yy / M_PX) * dh).astype(int) % dh, ((xx / M_PX) * dw).astype(int) % dw]
dlum = dlum / dlum.mean()

n_big, n_mid, n_fine = fbm(3, 3), fbm(12, 4), fbm(48, 3)
vstreak = fbm(40, 3, aniso=12.0)  # stretched vertically (texture v = world up on walls)
corner = np.full_like(px, 9.0)
for cx in (-hl, hl):
    for cy in (-hw, hw):
        for cz in (0, H): corner = np.minimum(corner, np.sqrt((px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2))
paint_px = is_['paint'] | is_['decal']

# rust sources
r_sill = ss(0.32, 0.02, pz) * ss(0.42, 0.7, n_mid * 0.6 + n_fine * 0.4)
r_cast = ss(0.42, 0.08, corner) * ss(0.35, 0.62, n_mid * 0.5 + n_fine * 0.5)
r_roof = top * ss(0.6, 0.72, n_mid * 0.6 + n_big * 0.4)
r_dent = ss(0.35, 0.9, curv) * ss(0.55, 0.72, n_fine)
r_wall = vert * ss(0.66, 0.78, n_mid * 0.65 + n_fine * 0.35) * 0.8   # scattered blooms where the paint has failed
rust = np.clip(np.maximum.reduce([r_sill, r_cast, r_roof * 0.85, r_dent, r_wall]), 0, 1) * paint_px
# rust runs: drag the rust mask down the wall (texture rows below = lower on the same wall)
run = np.zeros_like(rust); K = int(0.55 * M_PX)
for k in range(2, K, 2):
    src = np.roll(rust, -k, 0)
    same = (np.abs(np.roll(px, -k, 0) - px) < 0.02) & (np.abs(np.roll(py, -k, 0) - py) < 0.02) & (np.roll(pz, -k, 0) > pz) & np.roll(cov, -k, 0)
    run = np.maximum(run, src * same * (1 - k / K) ** 1.5)
run *= ss(0.45, 0.75, vstreak) * vert * paint_px
chips = ss(0.3, 0.8, curv) * ss(0.5, 0.62, n_fine) * paint_px * (1 - rust)
grime_low = ss(0.7, 0.0, pz) * (0.5 + 0.5 * n_mid)
wstreak = ss(0.55, 0.8, vstreak) * ss(H - 1.8, H - 0.15, pz) * vert

def lum(c): return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722 + 1e-5
def over(rgb, mask, a, colour):
    """Untinted layer `colour` over the (vertex-tinted at runtime) paint, amount a. The shader computes
    rgb·mix(1, tint, mask); for (1-a)·paint·tint + a·colour that needs mask ·= (1-a)·lum(rgb)/lum(new rgb),
    else the fringes of every rust patch / stencil lose their tint but keep the white paint → pale halos."""
    a = a[..., None]
    new = rgb * (1 - a) + colour * a
    return new, mask * (1 - a[..., 0]) * lum(rgb) / lum(new)
rgb = np.zeros((BAKE, BAKE, 3), np.float32); rough = np.zeros((BAKE, BAKE), np.float32); code = np.ones((BAKE, BAKE), np.float32)
paint = 0.8 * (0.93 + 0.12 * n_big) * (0.96 + 0.06 * np.clip(dlum, 0.3, 2.0))
rgb[:] = paint[..., None]
rough[:] = 0.46 + 0.12 * n_mid + 0.1 * top
mask = np.ones_like(paint)
mask = np.where(top, 0.86, mask)                  # sun-chalked roof: livery washes out
rgb *= np.where(top, 1.05, 1.0)[..., None]
dec = is_['decal'] * (1 - ss(0.68, 0.8, n_fine * 0.7 + n_mid * 0.3))   # stencils chipped
rgb, mask = over(rgb, mask, dec, 0.62 * (0.92 + 0.12 * n_mid[..., None]))
rough = rough * (1 - dec) + 0.5 * dec
RUST_D, RUST_O = np.array([0.075, 0.032, 0.014]), np.array([0.3, 0.115, 0.035])
rust_col = (RUST_D + (RUST_O - RUST_D) * n_mid[..., None]) * np.clip(0.55 + 0.6 * dlum, 0.3, 1.8)[..., None]
rt = np.clip(np.maximum(rust, run * 0.75), 0, 1)
rgb, mask = over(rgb, mask, rt, rust_col); rough = rough * (1 - rt) + (0.86 + 0.08 * n_fine) * rt
rgb, mask = over(rgb, mask, chips, np.array([0.07, 0.065, 0.06])); rough = rough * (1 - chips) + 0.62 * chips
DIRT = np.array([0.62, 0.55, 0.45])               # multiplied: road dirt darkens + browns the livery, never bleaches it
g = grime_low * 0.55
rgb *= (1 - g[..., None]) + DIRT * g[..., None]; rough += g * 0.2
rgb *= (1 - 0.28 * wstreak)[..., None]; rough += 0.1 * wstreak
rgb *= (0.62 + 0.38 * ao)[..., None]               # cavity dirt (AO itself goes to the ambient term via arm.r)
code = 0.5 + 0.5 * np.clip(mask, 0, 1)                            # 1 tinted paint … 0.5 untinted dielectric
for k, (a, r_, cd) in {'galv': (0.42, 0.36, 0.0), 'rubber': (0.03, 0.85, 0.5), 'plate': (0.55, 0.32, 0.0)}.items():
    s = is_[k]
    v = a * (0.9 + 0.2 * n_fine)
    rgb[s] = v[s][..., None]; rough[s] = r_ + 0.08 * n_mid[s]; code[s] = cd
gr = is_['galv'] * ss(0.62, 0.75, n_fine)  # a little rust on the bars
rgb = rgb * (1 - gr[..., None]) + rust_col * gr[..., None]; code = np.where(gr > 0.5, 0.5, code); rough = rough * (1 - gr) + 0.85 * gr
rgb[~cov] = 0.5; rough[~cov] = 0.6; code[~cov] = 1.0

def down(a, n=None):  # box downsample to n (default TEX)
    n = n or TEX; f = BAKE // n
    return a if f == 1 else a.reshape(n, f, n, f, *a.shape[2:]).mean((1, 3))
def srgb(x):
    x = np.clip(x, 0, 1); return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
nrm = down(np.stack([nx, ny, NRM[..., 2] * 2 - 1], -1), NTEX); nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-8
OUT = {
    'albedo': (srgb(down(rgb)), 'sRGB'),
    'normal': (nrm * 0.5 + 0.5, 'Non-Color'),
    'arm': (np.stack([down(ao), np.clip(down(rough), 0.04, 1), down(code)], -1), 'Non-Color'),
}
for name, (a, cs) in OUT.items():
    n = a.shape[0]
    img = bpy.data.images.new(f'out_{name}', n, n, alpha=False)
    img.colorspace_settings.name = cs
    px4 = np.concatenate([np.clip(a, 0, 1), np.ones((n, n, 1), np.float32)], -1).astype(np.float32)
    img.pixels.foreach_set(px4.ravel())
    path = os.path.join(OUT_TEX, f'{name}.jpg')
    img.filepath_raw = path; img.file_format = 'JPEG'
    scene.render.image_settings.quality = 92
    try: img.save(filepath=path, quality=92)
    except TypeError: img.save()
    log(f'wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)')

# ------------------------------------------------------------------------------------------------ export
for o in list(scene.objects):
    if o not in (low, lod1): o.hide_set(True); o.select_set(False)
for o in (low, lod1):
    o.data.materials.clear(); o.hide_set(False); o.select_set(True)
    a = o.data.attributes.get('part');  a and o.data.attributes.remove(a)
    a = o.data.attributes.get('solid'); a and o.data.attributes.remove(a)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
kw = dict(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_materials='NONE', export_texcoords=True, export_normals=True,
          export_yup=True, export_apply=True, export_vertex_color='NONE', export_tangents=False, export_animations=False)
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
for o in (low, lod1): log(f'{o.name}: {sum(len(p.vertices) - 2 for p in o.data.polygons)} tris')
log(f'wrote {OUT_GLB} ({os.path.getsize(OUT_GLB) / 1024:.0f} KB); UV_PER_M={UV_PER_M:.5f}')
