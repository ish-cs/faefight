/** Island team colours/names (no three.js, so menu/lobby code can use them without the renderer chunk). */
export const ISLAND_COLORS = [0xe0533d, 0x3d84e0, 0x3dbb6a, 0xe0b23d, 0xa65de0, 0x3dd0d0, 0xe07a3d, 0xd6d6d6];
export const ISLAND_NAMES = ['Red', 'Blue', 'Green', 'Gold', 'Purple', 'Teal', 'Orange', 'White'];

/** Palette index per island for the running match (MapDef.colors: players pick their colour in the lobby). */
let palette: readonly number[] = [];
/** The match's colours (call when its map arrives); undefined = island k plays colour k (old default). */
export function setIslandPalette(colors: readonly number[] | undefined) { palette = colors ? [...colors] : []; }
const paletteIndex = (island: number) => (palette[island] ?? island) % ISLAND_COLORS.length;
/** Colour (0xRRGGBB) of an island's team in the running match. */
export const islandColor = (island: number) => ISLAND_COLORS[paletteIndex(island)];
/** Name of an island's team colour ("Red", "Blue"…) in the running match. */
export const islandName = (island: number) => ISLAND_NAMES[paletteIndex(island)];
