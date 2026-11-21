// Encode the PBR JPEG sets in public/assets/textures/<set>/{albedo,normal,arm}.jpg to GPU-compressed KTX2 (Basis
// Universal) next to them, with full mip chains. albedo/arm: ETC1S (small; albedo sRGB), normal: UASTC (keeps normal
// precision) + RDO + Zstd. Y-flipped to match the JPEG path's flipY (compressed textures can't flip at upload). pbr.ts loads the .ktx2 when the GPU can transcode it, the .jpg otherwise.
//
// The encoder is a dev-only tool, not a project dependency:
//   npm i --no-save --prefix /tmp/ktx ktx2-encoder@0.6.0 jpeg-js@0.4.4
//   NODE_PATH=/tmp/ktx/node_modules node scripts/encodeKtx2.mjs [set …]
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODS = resolve(process.env.NODE_PATH ?? 'node_modules');
const require = createRequire(join(MODS, 'x.js'));
const { encodeToKTX2 } = await import(pathToFileURL(join(MODS, 'ktx2-encoder/dist/node/index.js')).href);
const jpeg = require('jpeg-js');

const ROOT = 'public/assets/textures';
const only = process.argv.slice(2);
const sets = readdirSync(ROOT).filter((d) => statSync(join(ROOT, d)).isDirectory() && (!only.length || only.includes(d)));
// Block-compressed GPU formats need the base level to be a multiple of 4 in both axes (WebGPU rejects the texture
// otherwise: linen is 1024×1026). Resample (nearest, keeps tiling) down to the multiple of 4 below.
const imageDecoder = async (buf) => {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  const W = img.width & ~3, H = img.height & ~3;
  if (W === img.width && H === img.height) return { data: new Uint8Array(img.data), width: W, height: H };
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, Math.round((y * img.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, Math.round((x * img.width) / W));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  console.log(`  resampled ${img.width}×${img.height} → ${W}×${H} (block size)`);
  return { data: out, width: W, height: H };
};
const OPTS = {
  albedo: { isUASTC: false, qualityLevel: 200, compressionLevel: 2, isPerceptual: true },
  arm: { isUASTC: false, qualityLevel: 200, compressionLevel: 2, isPerceptual: false },
  // UASTC + rate-distortion optimisation: keeps normal precision, RDO makes the Zstd stage effective
  normal: { isUASTC: true, isNormalMap: true, needSupercompression: true, uastcLDRQualityLevel: 2, enableRDO: true, rdoQualityLevel: 1.5, isPerceptual: false },
};
let jpgBytes = 0, ktxBytes = 0;
for (const set of sets) {
  for (const map of ['albedo', 'normal', 'arm']) {
    const src = join(ROOT, set, `${map}.jpg`);
    let buf;
    try { buf = readFileSync(src); } catch { continue; }
    const t0 = Date.now();
    const out = await encodeToKTX2(new Uint8Array(buf), { ...OPTS[map], generateMipmap: true, isYFlip: true, imageDecoder });
    writeFileSync(join(ROOT, set, `${map}.ktx2`), out);
    jpgBytes += buf.length; ktxBytes += out.length;
    console.log(`${set}/${map}: ${(buf.length / 1024).toFixed(0)} KB jpg → ${(out.length / 1024).toFixed(0)} KB ktx2 (${Date.now() - t0} ms)`);
  }
}
console.log(`total: ${(jpgBytes / 1048576).toFixed(1)} MB jpg → ${(ktxBytes / 1048576).toFixed(1)} MB ktx2`);
// manifest pbr.ts reads before fetching any .ktx2 (every set/map that has a .ktx2 next to its .jpg)
const maps = readdirSync(ROOT).filter((d) => statSync(join(ROOT, d)).isDirectory())
  .flatMap((d) => ['albedo', 'normal', 'arm'].filter((m) => { try { return statSync(join(ROOT, d, `${m}.ktx2`)).isFile(); } catch { return false; } }).map((m) => `${d}/${m}`));
writeFileSync(join(ROOT, 'ktx2.json'), JSON.stringify({ maps }, null, 1) + '\n');
console.log(`manifest: ${maps.length} maps`);
