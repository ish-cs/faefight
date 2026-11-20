import { describe, expect, test } from 'vitest';
import { sealAnnouncement } from '../../src/client/announce';

const players = [{ id: 1, name: 'You' }, { id: 2, name: 'IceTeaOnly' }, { id: 3, name: 'Captain_Walrus' }];
const sealed = (data: Record<string, unknown>) => ({ t: 1, type: 'sealed' as const, data });

describe('sealAnnouncement', () => {
  test('someone sealed someone else', () => {
    expect(sealAnnouncement(sealed({ island: 2, owner: 3, by: 2 }), 1, players)).toBe("IceTeaOnly sealed Captain_Walrus's bunker");
  });
  test('you sealed someone', () => {
    expect(sealAnnouncement(sealed({ island: 1, owner: 2, by: 1 }), 1, players)).toBe("You sealed IceTeaOnly's bunker");
  });
  test('someone sealed yours', () => {
    expect(sealAnnouncement(sealed({ island: 0, owner: 1, by: 3 }), 1, players)).toBe('Captain_Walrus sealed YOUR bunker');
  });
  test('sealed yourself in', () => {
    expect(sealAnnouncement(sealed({ island: 0, owner: 1, by: 1 }), 1, players)).toBe('You sealed your own bunker!');
  });
  test('sudden death / unknown sealer', () => {
    expect(sealAnnouncement(sealed({ island: 2, owner: 3, by: null }), 1, players)).toBe("Captain_Walrus's bunker is sealed");
  });
  test('other events give nothing', () => {
    expect(sealAnnouncement({ t: 1, type: 'unsealed', data: { island: 1 } }, 1, players)).toBeNull();
  });
});
