import { NO_INPUT, type PlayerInput } from '../sim/types';

/**
 * Merges input samples arriving faster or slower than they are consumed.
 * Held controls (move, aim, sprint, fire held) come from the latest sample; one-shot actions are
 * accumulated until the next take() so a quick tap between two consumers is never lost, and each
 * acts exactly once.
 */
export class InputAccumulator {
  private held: PlayerInput = { ...NO_INPUT };
  private pending: Partial<PlayerInput> = {};
  /** False until the first sample arrives: there's nothing to take yet (the sim then keeps the spawn look). */
  started = false;

  push(input: PlayerInput) {
    this.started = true;
    this.held = input;
    const p = this.pending;
    if (input.jump) p.jump = true;
    if (input.fire) { p.fire = true; if (input.viewT !== undefined) p.viewT = input.viewT; }
    if (input.reload) p.reload = true;
    if (input.interact) p.interact = true;
    if (input.throwGrenade) p.throwGrenade = true;
    if (input.placeCharge) p.placeCharge = true;
    if (input.slot) p.slot = input.slot;
    if (input.build) p.build = input.build;
    if (input.shop) p.shop = input.shop;
    if (input.vault) p.vault = input.vault;
    if (input.drop) p.drop = p.drop === 'stack' ? 'stack' : input.drop;
    if (input.moveSlot) p.moveSlot = input.moveSlot;
    if (input.useMedkit) p.useMedkit = true;
    if (input.drink) p.drink = true;
  }

  take(): PlayerInput {
    const input: PlayerInput = {
      ...this.held, reload: false, interact: false, throwGrenade: false, placeCharge: false,
      slot: null, build: null, shop: null, vault: null, drop: null, moveSlot: null, useMedkit: false, drink: false, ...this.pending,
    };
    this.pending = {};
    return input;
  }
}
