/** Human-looking gamer nicknames for bot seats (seeded, clean, unique within a match, < 16 chars). */

const ADJ = ['wavy', 'smol', 'lil', 'big', 'salty', 'sneaky', 'lucky', 'sleepy', 'crispy', 'quiet', 'rusty', 'mighty', 'fuzzy', 'chill', 'tiny', 'grumpy', 'jolly', 'cosmic', 'soggy', 'swift'];
const NOUN = ['bean', 'mortar', 'kestrel', 'otter', 'pickle', 'walrus', 'anchor', 'gull', 'crab', 'puffin', 'barnacle', 'taco', 'noodle', 'lantern', 'pebble', 'raft', 'cactus', 'falcon', 'mango', 'biscuit', 'sprout', 'harbor', 'kraken', 'waffle'];
const TITLE = ['Captain', 'Admiral', 'Doc', 'Sir', 'Uncle', 'Major', 'Lady', 'Skipper'];
const FIRST = ['Dan', 'Mia', 'Sam', 'Lou', 'Kai', 'Ivy', 'Max', 'Zoe', 'Ben', 'Ada', 'Leo', 'Ana'];
const PHRASE = ['nobodyhome', 'IceTeaOnly', 'notabot', 'justvibing', 'NoScopeNan', 'afkbrb', 'MainCharacter', 'ggwp', 'lagmaster', 'TideWaitsNone', 'bridgetoofar', 'sendhelp'];

const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
const MAX_LEN = 15;

function candidate(rng: () => number): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  switch (Math.floor(rng() * 6)) {
    case 0: return `${cap(pick(NOUN))}_${10 + Math.floor(rng() * 90)}`;
    case 1: return `${pick(ADJ)}${pick(NOUN)}`;
    case 2: return `${cap(pick(ADJ))}.${pick(FIRST)}`;
    case 3: return `${pick(TITLE)}_${cap(pick(NOUN))}`;
    case 4: return pick(PHRASE);
    default: return `${cap(pick(ADJ))}${cap(pick(NOUN))}${rng() < 0.5 ? Math.floor(rng() * 100) : ''}`;
  }
}

/** A nickname not in `taken` (case-insensitive); adds it to `taken`. */
export function nickname(rng: () => number, taken: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const n = candidate(rng);
    if (n.length > MAX_LEN || taken.has(n.toLowerCase())) continue;
    taken.add(n.toLowerCase());
    return n;
  }
  throw new Error(`nickname: no free name after 200 tries (${taken.size} taken)`);
}

/** Setup names that are placeholders for a bot seat ("", "Bot", "Bot (hard)", "Bot (easy) 2") get a nickname instead. */
export const isPlaceholderBotName = (name: string) => /^\s*(Bot(\s*\(.*\))?(\s*\d+)?)?\s*$/.test(name);
