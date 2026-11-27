# Texture composition for build_structures.py (exec'd there; also run alone with --recompose to iterate without baking).
# In: NRM, AO, IDM, POS, LN (BAKE² float bakes), UV_PER_M, the sim numbers. Out: structure/{albedo,normal,arm}.jpg.
# Everything is a function of the baked WORLD position (sim frame), so patterns match across UV islands and edges.
nrng = np.random.default_rng(SEED)
M_PX = UV_PER_M * BAKE  # bake texels per metre

def _h(ix, iy, s):
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + s * 982451653) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffffff) / 16777216.0
def vn(u, v, s=0):
    """Value noise on arbitrary coordinate arrays (cells of 1), smooth, in [0, 1)."""
    iu, iv = np.floor(u), np.floor(v); fu, fv = u - iu, v - iv
    fu, fv = fu * fu * (3 - 2 * fu), fv * fv * (3 - 2 * fv)
    a, b, c, d = _h(iu, iv, s), _h(iu + 1, iv, s), _h(iu, iv + 1, s), _h(iu + 1, iv + 1, s)
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv
def fbm(u, v, s=0, oct=4):
    out, amp, tot = 0.0, 1.0, 0.0
    for o in range(oct):
        out = out + amp * vn(u * 2 ** o, v * 2 ** o, s + o * 101); tot += amp; amp *= 0.5
    return out / tot
def n3(x, y, z, f, s=0, oct=3):
    """Noise continuous across faces (a function of the 3D point): two skewed 2D slices."""
    return 0.5 * (fbm((x + 0.53 * y) * f, (z - 0.71 * y) * f, s, oct) + fbm((y + 0.31 * x) * f, (x - 0.27 * z) * f, s + 7, oct))
def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
def blur(a, r):
    for ax in (0, 1):
        c = np.cumsum(np.pad(a, [(r, r) if i == ax else (0, 0) for i in range(a.ndim)], mode='edge'), ax)
        c = np.concatenate([np.zeros_like(np.take(c, [0], ax)), c], ax)
        a = (np.take(c, range(2 * r + 1, c.shape[ax]), ax) - np.take(c, range(0, c.shape[ax] - 2 * r - 1), ax)) / (2 * r + 1)
    return a
def cells(u, v, size, s):
    """Jittered point per cell (kept 25 % inside the cell): distance to it + two cell hashes."""
    cu, cv = np.floor(u / size), np.floor(v / size)
    pu = (cu + 0.25 + 0.5 * _h(cu, cv, s)) * size; pv = (cv + 0.25 + 0.5 * _h(cu, cv, s + 1)) * size
    return np.hypot(u - pu, v - pv), _h(cu, cv, s + 2), _h(cu, cv, s + 3)

# ---------------------------------------------------------------- per-texel frame (sim coordinates)
ids = IDM[..., :3]
cov = ids.sum(-1) > 0.05
part = np.argmax(ids, -1)                     # 0 bunker walls, 1 floor, 2 quay
is_w, is_f, is_q = cov & (part == 0), cov & (part == 1), cov & (part == 2)
x = POS[..., 0] - np.where(is_q, Q_OFF, 0.0); y = POS[..., 2]; z = -POS[..., 1]
ln = LN[..., :3] * 2 - 1
nx, ny, nz = ln[..., 0], ln[..., 2], -ln[..., 1]
vert, top, under = np.abs(ny) < 0.5, ny > 0.5, ny < -0.5
xax = np.abs(nx) > np.abs(nz)                 # wall plane normal to x (side walls) vs z
a = np.where(xax, z, x)                       # along-wall coordinate
plane = np.where(xax, x, z)
fid = np.round(plane * 10) * 13 + np.where(xax, 7, 3) + np.sign(np.where(xax, nx, nz)) * 2
foff = (fid * 0.6180339) % 1.0 * 97.0         # decorrelates faces in face-local noise
au = a + foff
# face-local 2D noise coordinates: (along + face offset, height) on walls, (x + offset, z) on roofs/floors/soffits
fu = np.where(vert, au, x + foff); fv = np.where(vert, y, z)
ao = np.clip(AO[..., 0], 0, 1)
bnx, bny, bnz = NRM[..., 0] * 2 - 1, NRM[..., 1] * 2 - 1, NRM[..., 2] * 2 - 1
outer_w = is_w & vert & (np.abs(plane) > B_IN / 2 + B_WALL / 2)
inner_w = is_w & vert & ~outer_w
roof_top = is_w & top & (y > B_H + ROOF / 2)
ceiling = is_w & under

H = np.zeros((BAKE, BAKE), np.float64)                  # height detail, metres
rgb = np.zeros((BAKE, BAKE, 3), np.float64)
rough = np.zeros((BAKE, BAKE), np.float64)
log('compose: frame ready')

# ---------------------------------------------------------------- base concrete
big, mid, fine = fbm(fu * 0.45, fv * 0.45, 1, 3), fbm(fu * 3, fv * 3, 2, 3), fbm(fu * 14, fv * 14, 3, 2)
topn = fbm(x * 0.6 + 50, z * 0.6, 4, 3)
base = np.array([0.262, 0.245, 0.214])
tone = np.where(vert, 0.86 + 0.28 * big + 0.1 * (mid - 0.5) + 0.05 * (fine - 0.5), 0.88 + 0.22 * topn + 0.08 * (fbm(x * 4, z * 4, 5, 3) - 0.5))
rgb[:] = base * tone[..., None]
rough[:] = 0.86 + 0.08 * (mid - 0.5)

# ---------------------------------------------------------------- plywood formwork (bunker walls + ceiling, quay faces)
formed = (is_w & (vert | under)) | (is_q & vert)
PW, PH = 2.44, 1.22
pu = np.where(vert, a + np.where(is_q, Q_W / 2, OUTER / 2), x + OUTER / 2)   # panels start at a corner / module edge
pv = np.where(vert, y + np.where(is_q, 4.0, 0.0), z + OUTER / 2)
if True:
    pw = np.where(is_q, Q_W / 4, PW)
    iu, iv = np.floor(pu / pw), np.floor(pv / PH)
    du = np.minimum(pu - iu * pw, (iu + 1) * pw - pu); dv = np.minimum(pv - iv * PH, (iv + 1) * PH - pv)
    dj = np.minimum(du, dv)
    fin = ss(0.005, 0.0015, dj) * formed
    H += 0.0012 * fin
    ptone = 0.93 + 0.14 * _h(iu, iv + fid * 31, 9)
    pwarm = (_h(iu, iv + fid * 31, 10) - 0.5) * 0.04
    rgb *= np.where(formed, ptone, 1.0)[..., None] * np.stack([1 + pwarm, np.ones_like(pwarm), 1 - pwarm], -1)
    rgb *= (1 - 0.22 * fin - 0.06 * ss(0.05, 0.0, dj) * formed)[..., None]
    # tie holes: 3 × 2 per panel, plugged with mortar (lighter disc, dark recessed centre)
    ru, rv = pu - iu * pw, pv - iv * PH
    tu = np.minimum.reduce([np.abs(ru - pw * f) for f in (0.125, 0.5, 0.875)])
    tv = np.minimum(np.abs(rv - 0.3), np.abs(rv - 0.92))
    td = np.hypot(tu, tv)
    hole = ss(0.013, 0.008, td) * formed
    plug = ss(0.024, 0.018, td) * formed
    H -= 0.007 * hole + 0.0015 * plug
    rgb *= (1 + 0.1 * plug - 0.55 * hole)[..., None]
    # blowholes (bug holes) on formed faces
    bd, bh, br = cells(fu, fv, 0.06, 21)
    bug = (bh < 0.3) & (bd < 0.0025 + 0.0045 * br) & formed
    H -= 0.003 * bug
    rgb *= np.where(bug, 0.62, 1.0)[..., None]
log('compose: formwork')

# ---------------------------------------------------------------- cold joint under the roof pour; roof band tone
cj = is_w & vert & (np.abs(y - B_H) < 0.006)
H -= 0.003 * cj; rgb *= np.where(cj, 0.55, 1.0)[..., None]
rgb *= np.where(is_w & vert & (y > B_H), 1.04, 1.0)[..., None]

# ---------------------------------------------------------------- chipped arrises (convex edges only: AO high there)
bev = np.clip(1 - bnz, 0, 1) * cov
edge = np.clip(blur((bev > 0.01).astype(np.float64), 3) * 1.6, 0, 1) * ss(0.75, 0.92, ao)
cn = n3(x, y, z, 7.0, 31)
chip = edge * ss(0.56, 0.68, cn + 0.15 * (n3(x, y, z, 30.0, 33) - 0.5))
H -= 0.012 * chip * (0.5 + 0.5 * n3(x, y, z, 40.0, 35, 2))
agg = n3(x, y, z, 80.0, 37, 2)
rgb = rgb * (1 - chip[..., None]) + (rgb * 1.16 * (0.85 + 0.3 * agg[..., None])) * chip[..., None]
rough += 0.05 * chip

# ---------------------------------------------------------------- spalled door jambs with exposed rebar
JAMBS = []  # (edge x, edge z, material dir x, material dir z, outer face)
for s in (-1, 1):
    JAMBS += [(s * B_DW / 2, -OUTER / 2, s, 1, True), (s * B_DW / 2, -B_IN / 2, s, -1, False)]
    JAMBS += [(-OUTER / 2, s * B_DW / 2, 1, s, True), (-B_IN / 2, s * B_DW / 2, -1, s, False)]
    JAMBS += [(OUTER / 2, s * B_DW / 2, -1, s, True), (B_IN / 2, s * B_DW / 2, 1, s, False)]
nhx, nhz = np.where(vert, nx, 0), np.where(vert, nz, 0)
spall = np.zeros_like(H); bar = np.zeros_like(H); runs = np.zeros_like(H)
def depth_at(j, yy, outer):
    d = 0.095 * ss(0.42, 0.72, fbm(yy * 1.9, j * 7.3 + 0.5, 41, 2)) * (1.0 if outer else 0.5)
    return d * ss(0.08, 0.3, yy) * ss(B_DH - 0.02, B_DH - 0.25, yy)
for j, (ex, ez, dxm, dzm, outer) in enumerate(JAMBS):
    dist = np.hypot(x - ex, z - ez)
    m = is_w & vert & (dist < 0.25) & (y < B_DH + 0.05)
    if not m.any(): continue
    xm, zm, ym, dm = x[m], z[m], y[m], dist[m]
    D = depth_at(j, ym, outer)
    jag = (n3(xm, ym, zm, 22.0, 43 + j) - 0.5) * 0.03
    s_ = np.clip(D * 1.15 - dm * 0.85 + jag, 0, None) * (D > 0.006)
    # surface point pushed into the wall by the spall depth; rebar 55 mm in from both faces, stirrups every 200 mm
    px_, pz_ = xm - nhx[m] * s_, zm - nhz[m] * s_
    qx, qz = ex + dxm * 0.055, ez + dzm * 0.055
    rd = np.hypot(px_ - qx, pz_ - qz)
    yk = np.minimum((ym - 0.12) % 0.2, 0.2 - (ym - 0.12) % 0.2)  # distance to the nearest stirrup level
    vbar = ss(0.0105, 0.007, rd) * ss(0.035, 0.045, s_)
    sbar = ss(0.008, 0.005, yk) * ss(0.045, 0.055, s_) * (rd < 0.11)
    b_ = np.maximum(vbar, sbar)
    prof = np.sqrt(np.clip(1 - (rd / 0.0105) ** 2, 0, 1)) * (vbar >= sbar) + np.sqrt(np.clip(1 - (yk / 0.008) ** 2, 0, 1)) * (sbar > vbar)
    hb = -0.05 + 0.01 * prof
    hh = np.where(b_ > 0.05, np.maximum(-s_, hb), -s_)
    spall[m] = np.maximum(spall[m], s_); bar[m] = np.maximum(bar[m], b_)
    H[m] = np.minimum(H[m], hh + H[m] * (s_ <= 0))
    # rust runs under exposed steel: down the faces either side of the edge
    ex_ = np.zeros_like(ym)
    for k in range(1, 22):
        ex_ = np.maximum(ex_, ss(0.035, 0.05, depth_at(j, ym + k * 0.04, outer)) * (1 - k / 22) ** 1.3)
    rn = ex_ * ss(0.16, 0.03, dm) * ss(0.35, 0.7, vn(xm * 40 + zm * 40, ym * 1.2, 47 + j))
    runs[m] = np.maximum(runs[m], rn)
sp = ss(0.001, 0.006, spall)
inside = rgb * 1.12 * (0.8 + 0.4 * agg[..., None]) * (1 - np.clip(spall * 5, 0, 0.35))[..., None]
rgb = rgb * (1 - sp[..., None]) + inside * sp[..., None]
RUST_D, RUST_O = np.array([0.07, 0.032, 0.014]), np.array([0.26, 0.1, 0.03])
rust_c = RUST_D + (RUST_O - RUST_D) * n3(x, y, z, 120.0, 51, 2)[..., None]
rgb = rgb * (1 - bar[..., None]) + rust_c * bar[..., None]
RUN_C = np.array([0.2, 0.1, 0.045])
rgb = rgb * (1 - 0.7 * runs[..., None]) + RUN_C * 0.7 * runs[..., None]
rough = rough * (1 - bar) + 0.72 * bar + 0.04 * sp
log('compose: jambs, rebar, runs')

# ---------------------------------------------------------------- bullet pockmarks (outer faces, thick around slits + doors)
def slit_dist(xx, zz, aa):
    """Along-wall distance to the nearest firing slit on this wall (front/left/right ±1.55, back ±1.15)."""
    back = ~xax & (zz > 0)
    c = np.where(back, OUTER / 4, B_DW / 2 + (OUTER - B_DW) / 4)
    return np.abs(np.abs(aa) - c)
sd = slit_dist(x, z, a)
door_face = ~(~xax & (z > 0))
near = 0.06 + 0.4 * ss(0.8, 0.3, sd) * ss(0.7, 0.2, np.abs(y - (SL_Y0 + SL_Y1) / 2)) + 0.25 * door_face * ss(1.4, 0.9, np.abs(a)) * ss(2.4, 1.8, y)
pd, ph, pr = cells(au, y, 0.2, 61)
r = 0.012 + 0.026 * pr
pock = outer_w & (ph < near) & (pd < r)
cr = np.where(pock, 1 - (pd / r) ** 2, 0)
H -= 0.4 * r * cr * pock
rgb *= np.where(pock, 1.15 * (0.85 + 0.3 * agg) - 0.5 * ss(0.75, 0.95, cr), 1.0)[..., None]
log('compose: pockmarks')

# ---------------------------------------------------------------- weathering
st = ss(0.5, 0.82, fbm(au * 7, y * 0.35, 71, 3)) * ss(0.0, 2.8, y) ** 0.7 * outer_w
rgb *= (1 - 0.3 * st)[..., None] * np.array([1.0, 0.99, 0.95])
roof_drip = outer_w & (y > B_H - 0.5) & (y < B_H + 0.01)
rgb *= (1 - 0.18 * ss(B_H - 0.5, B_H, y) * roof_drip * fbm(au * 9, y * 2, 73, 2))[..., None]
# dirty runs under each slit (water + grime washing out of the opening)
wd = 0.3 + 0.07 * (SL_Y0 - y)
slr = ss(wd, wd - 0.12, sd) * ss(SL_Y0 - 1.4, SL_Y0 - 0.05, y) * (y < SL_Y0) * ss(0.35, 0.75, fbm(au * 14, y * 0.6, 75, 3))
rgb *= (1 - slr * np.where(outer_w, 0.32, 0.12) * is_w * vert)[..., None]
# soot fan above the slits on the outer face (muzzle blast)
soot = outer_w * ss(0.45, 0.1, sd) * ss(SL_Y1 + 0.45, SL_Y1, y) * (y > SL_Y1 - 0.01) * ss(0.3, 0.7, fbm(au * 8, y * 8, 77, 3))
rgb *= (1 - 0.35 * soot)[..., None]
# splash dirt at the foot, damp
foot = (is_w & vert) * ss(0.5, 0.0, y) * (0.55 + 0.45 * fbm(au * 3, y * 6, 79, 3))
DIRT = np.array([0.72, 0.64, 0.52])
rgb *= (1 - foot[..., None] * 0.5) + DIRT * foot[..., None] * 0.5
rough -= 0.05 * foot
# efflorescence: white salt blooms under the cold joint and out of the slits
eff = (is_w & vert) * ss(0.6, 0.8, fbm(au * 12, y * 1.2, 81, 3)) * ss(0.4, 0.6, fbm(au * 1.5, y * 1.5, 82, 2)) * (ss(1.9, 2.55, y) * (y < B_H) + 0.6 * ss(0.5, 0.1, sd) * ss(SL_Y0, SL_Y0 - 0.5, y) * (y < SL_Y0))
rgb = rgb * (1 - 0.22 * eff[..., None]) + np.array([0.5, 0.5, 0.47]) * 0.22 * eff[..., None]
# interior: a little grime, less sun-bleach
rgb *= np.where(inner_w | ceiling, 0.9, 1.0)[..., None]
log('compose: weathering')

# ---------------------------------------------------------------- roof top: weathered, lichen, ponding stains, broom finish
if True:
    lic = ss(0.6, 0.74, fbm(x * 2.2, z * 2.2, 91, 4)) * roof_top
    orange = ss(0.72, 0.8, fbm(x * 5 + 9, z * 5, 93, 3)) * roof_top
    pond = ss(0.48, 0.62, fbm(x * 0.7, z * 0.7, 95, 3)) * roof_top
    rgb *= (1 - 0.18 * pond)[..., None]
    rgb = rgb * (1 - 0.6 * lic[..., None]) + np.array([0.11, 0.12, 0.095]) * 0.6 * lic[..., None]
    rgb = rgb * (1 - 0.5 * orange[..., None]) + np.array([0.33, 0.19, 0.06]) * 0.5 * orange[..., None]
    H += roof_top * 0.0006 * (vn(x * 4, z * 60, 97) - 0.5)
    rough += roof_top * (0.04 * lic - 0.08 * pond)

# ---------------------------------------------------------------- floor: dusty slab, scuffs, sand blown in at the doors
if True:
    scuff = ss(0.6, 0.75, fbm(x * 3 + 4, z * 0.8, 101, 3)) * is_f
    thr = is_f & ((np.abs(x) > B_IN / 2) | (np.abs(z) > B_IN / 2))
    sand = is_f * np.clip(ss(1.1, 2.2, np.maximum(np.abs(x), np.abs(z))) * ss(1.4, 0.4, np.minimum(np.abs(x), np.abs(z))) * (0.6 + 0.6 * fbm(x * 3, z * 3, 103, 3)) + thr * 0.6, 0, 1)
    rgb *= np.where(is_f, 0.95, 1.0)[..., None]
    rgb *= (1 - 0.18 * scuff)[..., None]
    rgb = rgb * (1 - 0.55 * sand[..., None]) + np.array([0.42, 0.36, 0.26]) * 0.55 * sand[..., None]
    rough = np.where(is_f, 0.8 - 0.1 * scuff + 0.1 * sand, rough)
    H += is_f * 0.0008 * (fbm(x * 30, z * 30, 105, 2) - 0.5)

# ---------------------------------------------------------------- quay module
if True:
    qy = y; t = qy - WATER                       # height above the waterline
    beam = is_q & vert & (qy > -Q_BEAM - 0.01)
    lower = is_q & vert & ~beam
    qtop, soff = is_q & top, is_q & under
    rgb *= np.where(lower, 0.72, 1.0)[..., None] * np.where(beam | qtop, 0.92, 1.0)[..., None]
    rough = np.where(is_q, rough + 0.04, rough)
    # expansion joints: module ends (half joints) + middle
    jd = np.minimum(np.abs(np.abs(x) - Q_W / 2), np.abs(x))
    jn = ss(0.014, 0.009, jd) * is_q
    H -= 0.012 * jn; rgb *= (1 - 0.8 * jn)[..., None]
    # lift joints on the old wall
    lj = lower * ss(0.006, 0.002, np.minimum(np.abs(qy + 1.55), np.abs(qy + 2.25)))
    H -= 0.003 * lj; rgb *= (1 - 0.35 * lj)[..., None]
    # top arris of the beam: heavily chipped by mooring lines and boats
    qa = (beam & (qy > -0.07)) | (qtop & (z > Q_LIP - 0.07))
    qchip = qa * ss(0.5, 0.62, n3(x, y, z, 9.0, 111) + 0.15 * (n3(x, y, z, 35.0, 113) - 0.5))
    H -= 0.015 * qchip * (0.5 + 0.5 * n3(x, y, z, 50.0, 115, 2))
    rgb = rgb * (1 - qchip[..., None]) + rgb * 1.15 * (0.85 + 0.3 * agg[..., None]) * qchip[..., None]
    # rust from old fixings: two bolts per module on the beam, runs down over the wall below
    for k, fx in enumerate((-Q_W * 0.31, Q_W * 0.17, Q_W * 0.41)):
        fy = -0.35 - 0.2 * k
        spot = ss(0.03, 0.012, np.hypot(x - fx, qy - fy)) * (beam | lower)
        rr = ss(0.05 + 0.05 * (fy - qy), 0.0, np.abs(x - fx + 0.01 * np.sin(qy * 9))) * (qy < fy) * np.exp(-(fy - qy) / 1.1) * ss(0.3, 0.6, vn(x * 50, qy * 1.5, 117 + k)) * (beam | lower)
        H += 0.004 * spot
        rgb = rgb * (1 - 0.8 * spot[..., None]) + rust_c * 0.8 * spot[..., None]
        rgb = rgb * (1 - 0.5 * rr[..., None]) + RUN_C * 0.5 * rr[..., None]
    # salt + weathering streaks
    qst = ss(0.5, 0.85, fbm(x * 6, qy * 0.35, 121, 3)) * (beam | lower)
    rgb *= (1 - 0.3 * qst)[..., None]
    salt = lower * ss(0.45, 0.6, t) * ss(1.1, 0.75, t + 0.25 * fbm(x * 0.7, 0, 124, 2)) * ss(0.5, 0.75, fbm(x * 16, t * 1.5, 123, 3))
    rgb = rgb * (1 - 0.25 * salt[..., None]) + np.array([0.5, 0.5, 0.47]) * 0.25 * salt[..., None]
    # tide zone: wet stain, algae, barnacles, dark below the water
    wet = lower * ss(1.0, 0.25, t + 0.15 * (fbm(x * 2, t * 2, 125, 2) - 0.5))
    rgb *= (1 - 0.3 * wet)[..., None]; rough -= 0.25 * wet
    alg = lower * ss(0.38, -0.05, t + 0.18 * (fbm(x * 3, t * 4, 127, 3) - 0.5))
    rgb = rgb * (1 - 0.75 * alg[..., None]) + np.array([0.05, 0.065, 0.03]) * 0.75 * alg[..., None]
    rough -= 0.35 * alg
    bd2, bh2, br2 = cells(x * 1.0 + 3, t, 0.035, 131)
    bz = lower & (t > -0.6) & (t < 0.28 + 0.1 * vn(x * 3, 0, 133)) & (bh2 < 0.3) & (bd2 < 0.003 + 0.005 * br2)
    bprof = np.where(bz, 1 - (bd2 / (0.003 + 0.005 * br2)) ** 2, 0)
    H += 0.004 * bprof
    rgb = np.where(bz[..., None], np.array([0.3, 0.29, 0.26]) * (0.55 + 0.45 * bprof[..., None]), rgb)
    rgb *= np.where(lower & (t < -0.05), 0.55, 1.0)[..., None]
    # soffit: damp, dark, drips
    rgb *= np.where(soff, 0.75, 1.0)[..., None]; rough = np.where(soff, 0.8, rough)
log('compose: quay')

# ---------------------------------------------------------------- cavity dirt from AO, wrap-up
rgb *= (0.6 + 0.4 * ao)[..., None]
rough = np.clip(rough, 0.3, 1.0)
# height detail → tangent normal (gradient in UV texel space; atlas islands are planar so any orientation works)
gu = np.gradient(H, axis=1) * M_PX; gv = np.gradient(H, axis=0) * M_PX
nn = np.stack([bnx - gu, bny - gv, np.maximum(bnz, 0.2)], -1)
nn /= np.linalg.norm(nn, axis=-1, keepdims=True) + 1e-8
mean = rgb[cov].mean(0); rgb[~cov] = mean; rough[~cov] = 0.85; ao = np.where(cov, ao, 1.0)
nn[~cov] = (0, 0, 1)
log('albedo mean (linear):', np.round(mean, 3), 'walls', np.round(rgb[is_w].mean(0), 3), 'quay', np.round(rgb[is_q].mean(0), 3), 'ao mean', round(float(ao[cov].mean()), 3))

def down(arr, n):
    f = BAKE // n
    return arr if f == 1 else arr.reshape(n, f, n, f, *arr.shape[2:]).mean((1, 3))
def srgb(v):
    v = np.clip(v, 0, 1); return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
nd = down(nn, NTEX); nd /= np.linalg.norm(nd, axis=-1, keepdims=True) + 1e-8
OUT = {
    'albedo': (srgb(down(rgb, TEX)), 'sRGB'),
    'normal': (nd * 0.5 + 0.5, 'Non-Color'),
    'arm': (np.stack([down(ao, ATEX), np.clip(down(rough, ATEX), 0.04, 1), np.zeros((ATEX, ATEX))], -1), 'Non-Color'),
}
for name, (arr, cs) in OUT.items():
    n = arr.shape[0]
    img = bpy.data.images.new(f'out_{name}', n, n, alpha=False)
    img.colorspace_settings.name = cs
    px4 = np.concatenate([np.clip(arr, 0, 1), np.ones((n, n, 1))], -1).astype(np.float32)
    img.pixels.foreach_set(px4.ravel())
    path = os.path.join(OUT_TEX, f'{name}.jpg')
    img.filepath_raw = path; img.file_format = 'JPEG'
    scene.render.image_settings.quality = 92
    try: img.save(filepath=path, quality=92)
    except TypeError: img.save()
    log(f'wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)')
