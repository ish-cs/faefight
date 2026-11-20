/** Label for an island's bunker chip in the HUD: an eliminated owner is OUT whatever the bunker's state. */
export const chipState = (sealed: boolean, ownerEliminated: boolean): 'OUT' | 'SEALED' | 'OPEN' =>
  ownerEliminated ? 'OUT' : sealed ? 'SEALED' : 'OPEN';
