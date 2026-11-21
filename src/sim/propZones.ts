/**
 * No-build zones around NPCs, the generator and the vault (building.ts, the building agent's single source of
 * truth); gameplay props (props.ts) keep out of the same zones.
 */
export { type NoBuildZone, islandNoBuildZones, generatorZone, vaultZone, shopZone, potionZone, boxesOverlap } from './building';
