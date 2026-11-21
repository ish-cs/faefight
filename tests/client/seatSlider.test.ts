import { describe, expect, it } from 'vitest';
import { keyStop, posFromX, SEAT_STOPS, slotToStop, stopToSlot } from '../../src/client/seatSlider';

describe('lobby seat slider', () => {
  it('maps every stop to a seat and back', () => {
    expect(SEAT_STOPS).toEqual(['open', 'easy', 'medium', 'hard', 'pro']);
    SEAT_STOPS.forEach((_, i) => expect(slotToStop(stopToSlot(i))).toBe(i));
    expect(stopToSlot(0)).toEqual({ kind: 'open' });
    expect(stopToSlot(4)).toEqual({ kind: 'bot', difficulty: 'pro' });
  });

  it('reads open and bot seats; a human seat has no slider', () => {
    expect(slotToStop({ kind: 'open' })).toBe(0);
    expect(slotToStop({ kind: 'bot', difficulty: 'hard', name: 'Moss' })).toBe(3);
    expect(slotToStop({ kind: 'human', name: 'Ann', peerId: 'p', isHost: false })).toBe(-1);
  });

  it('clamps and rounds out-of-range stops', () => {
    expect(stopToSlot(-3)).toEqual({ kind: 'open' });
    expect(stopToSlot(9)).toEqual({ kind: 'bot', difficulty: 'pro' });
    expect(stopToSlot(1.6)).toEqual({ kind: 'bot', difficulty: 'medium' });
  });

  it('keyboard: arrows step and stop at the ends, Home/End jump, other keys ignored', () => {
    expect(keyStop(2, 'ArrowRight')).toBe(3);
    expect(keyStop(2, 'ArrowUp')).toBe(3);
    expect(keyStop(2, 'ArrowLeft')).toBe(1);
    expect(keyStop(2, 'ArrowDown')).toBe(1);
    expect(keyStop(4, 'ArrowRight')).toBe(4);
    expect(keyStop(0, 'ArrowLeft')).toBe(0);
    expect(keyStop(2, 'Home')).toBe(0);
    expect(keyStop(2, 'End')).toBe(4);
    expect(keyStop(2, 'Enter')).toBeNull();
    expect(keyStop(2, 'a')).toBeNull();
  });

  it('pointer x → thumb position, stop centres on integers', () => {
    const w = 250; // 50 px per stop
    expect(posFromX(25, w)).toBeCloseTo(0);
    expect(posFromX(125, w)).toBeCloseTo(2);
    expect(posFromX(225, w)).toBeCloseTo(4);
    expect(posFromX(-40, w)).toBe(0);
    expect(posFromX(400, w)).toBe(4);
    expect(Math.round(posFromX(160, w))).toBe(3); // a click lands on the nearest stop
    expect(posFromX(10, 0)).toBe(0);
  });
});
