import { describe, test } from 'vitest';
import { drownMatches } from './drownMatches';

// Second half of botDrown.test.ts's whole-match check (separate file: runs on its own worker). Method: drownMatches.ts.
describe('bots stay out of the water (2)', () => {
  test('8 mixed bots, seeds 4–6, whole matches: at most 1 unexplained water death before sudden death', async () => {
    await drownMatches([4, 5, 6]);
  }, 1_200_000);
});
