// Public sound API for gameplay/render code: import { playSfx } from '../audio/api' (path relative to you).
//
//   playSfx(name, pos?, opts?)
//     name  a SoundId (events.ts). pos: world position → 3D (distance falloff, air absorption, walls muffle it);
//           null/omitted → 2D, for your own body or the interface.
//     opts  { gain?: 0..1.5 (default 0.8), kind?: variant, own?: true = your own action (closer, never culled) }
//   Safe before the first click (silently nothing: browsers start audio on a user gesture) and in tests.
//   The voice limiter caps simultaneous sounds, so calling it per event (not per frame) is fine.
//
// Names (all synthesized at play time, see sfx.ts):
//   Weapons      shot (kind WeaponKind; distant variant automatic past 30 m), reload (kind 'weapon:beat'),
//                dry (empty click), equip (kind WeaponKind), ads
//   Impacts      impact (kind: wood | hollow | metal | concrete | sand | grass | wet | gravel | water; none = flesh)
//   Movement     footstep / land / jump (kind Surface: grass sand concrete wood hollow metal wet gravel water)
//   Building     placed / destroyed (kind PieceKind)
//   Blasts       explosion (kind grenade | charge | rocket | barrel | propane), hazard (kind hiss | clang | crateHit | crate)
//   Interface    click, coin, loot, purchase, vault, tick, ping, alarm (kind '1' | '2'), horn, kill, death, win, lose, draw
//   Round-11 hooks, ready to call:
//     grapple    grappleFire, grappleAttach (at the hook), grappleReel (~0.6 s ratchet; repeat while reeling), grappleRelease
//     spike trap spikeArm, spikeTrigger
//     shells     shellCasing (kind Surface: hard surfaces ring, soft ones barely tick)
//     ragdolls   ragdollThud (kind Surface)
//     docks      dockCreak (stressed planks), dockBreak (planks give way + splash)
//     barriers   barrierSlam (a concrete doorway slab landing; sudden death)
//     day/night  setDaylight(0..1): gulls by day, crickets and owls at night (ambience)
//   Music is automatic (music.ts): calm → tense near a fight → intense in the storm.

import type { Vec3 } from '../../sim/types';
import type { SoundId } from './events';

export type SfxOpts = { gain?: number; kind?: string; own?: boolean };

type Sink = { playSfx(sound: SoundId, pos: Vec3 | null, opts: SfxOpts): void; setDaylight(k: number): void };
let sink: Sink | null = null;

/** The AudioSystem registers itself when it's created (engine.ts). */
export function registerAudio(s: Sink) { sink = s; }

export function playSfx(sound: SoundId, pos: Vec3 | null = null, opts: SfxOpts = {}): void {
  sink?.playSfx(sound, pos, opts);
}

/** 0 = night, 1 = full day. */
export function setDaylight(k: number): void {
  sink?.setDaylight(k);
}
