/**
 * GitHub's Linux runners have no GPU: the game renders through software GL (SwiftShader / llvmpipe) at
 * about 1 fps there, and a match takes ~30 s to load. Measured on CI for SwiftShader GL, SwiftShader
 * WebGPU, llvmpipe (EGL and Xvfb) and lavapipe Vulkan WebGPU: all 0.8–1.5 fps. Anything that plays a
 * match in real time (moving, aiming, building, prediction, timing) can't pass there, so those tests are
 * skipped on CI only, with this reason. Run them locally (real GPU) before a merge: `pnpm e2e`.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export const ON_CI = !!env.CI;
export const NEEDS_GPU = 'needs a GPU: plays a match in real time, and CI renders in software at ~1 fps (see tests/e2e/gpu.ts)';
