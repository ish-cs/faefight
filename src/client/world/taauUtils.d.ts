// three r187 ships TAAUtils.js without type declarations; taau.ts uses these helpers as-is.
declare module 'three/addons/tsl/utils/TAAUtils.js' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export const clipAABB: (...a: any[]) => any;
  export const flickerReduction: (...a: any[]) => any;
  export const sampleCurrentDepth: (...a: any[]) => any;
  export const samplePreviousDepth: (...a: any[]) => any;
  export function computeHaltonOffsets(length: number): [number, number][];
}
