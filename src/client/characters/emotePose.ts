import { EMOTES, type EmoteId } from '../../sim/emotes';

/**
 * Emote animation for the soldier rig: a base clip plus procedural bone turns layered on top (the rig
 * only ships a Wave clip). Turns are about the BODY's axes in world space (right / up / forward of the
 * avatar's facing), so they work whatever each bone's local axes are. Pure: the Avatar applies them.
 */

/** Rig bones the overlays use (GLTFLoader-sanitised names: "UpperArm.R" → "UpperArmR"). */
export const EMOTE_BONES = ['Hips', 'Torso', 'Chest', 'Neck', 'Head', 'UpperArmR', 'LowerArmR', 'WristR', 'UpperArmL', 'LowerArmL'] as const;
export type EmoteBone = (typeof EMOTE_BONES)[number];
export type BodyAxis = 'right' | 'up' | 'fwd';
export type BoneTurn = { bone: EmoteBone; axis: BodyAxis; angle: number };

const CLIP: Record<EmoteId, string> = { wave: 'Wave', dance: 'Idle_Neutral', salute: 'Idle_Neutral', laugh: 'Idle_Neutral', point: 'Idle_Neutral' };
export const emoteClip = (id: EmoteId) => CLIP[id];

/** Blend in/out time (s) of the procedural layer at the start and end of an emote. */
const EASE = 0.25;

/** 0..1 weight of the overlay `t` s into an emote (eases in, holds, eases out before it ends). */
export function emoteWeight(id: EmoteId, t: number): number {
  const sec = EMOTES[id].sec;
  if (t < 0 || t >= sec) return 0;
  const k = Math.min(1, t / EASE, (sec - t) / EASE);
  return k * k * (3 - 2 * k);
}

/** Bone turns for emote `id`, `t` s in (already scaled by emoteWeight). */
export function emotePose(id: EmoteId, t: number): BoneTurn[] {
  const w = emoteWeight(id, t);
  if (w === 0) return [];
  const s = (hz: number, ph = 0) => Math.sin((t * hz + ph) * Math.PI * 2);
  let out: BoneTurn[];
  switch (id) {
    case 'wave':
      out = []; // the clip does it all
      break;
    case 'dance': {
      // Hip sway and a shoulder groove at ~2 beats/s, arms up in a V pumping in turn.
      // (Signs: + about `fwd` swings the right arm in across the body, so out-and-up is negative; mirrored for the left.)
      const beat = s(1), pump = s(2);
      out = [
        { bone: 'Hips', axis: 'fwd', angle: 0.14 * beat },
        { bone: 'Chest', axis: 'up', angle: 0.35 * beat },
        { bone: 'Head', axis: 'fwd', angle: -0.18 * beat },
        { bone: 'UpperArmR', axis: 'fwd', angle: -2.2 - 0.3 * pump },
        { bone: 'LowerArmR', axis: 'fwd', angle: -0.3 * pump },
        { bone: 'UpperArmL', axis: 'fwd', angle: 2.2 - 0.3 * pump },
        { bone: 'LowerArmL', axis: 'fwd', angle: -0.3 * pump },
      ];
      break;
    }
    case 'salute':
      // Elbow out at shoulder height, fingertips at the right brow (solved against the rig: tests/client/emotePose.test.ts), chest out.
      out = [
        { bone: 'Chest', axis: 'right', angle: 0.06 },
        { bone: 'UpperArmR', axis: 'fwd', angle: -0.8 },
        { bone: 'LowerArmR', axis: 'fwd', angle: -1.5 },
        { bone: 'LowerArmR', axis: 'up', angle: 2.4 },
      ];
      break;
    case 'laugh': {
      // Lean back and shake with laughter, hands on the belly (+ about `right` leans back).
      const shake = Math.abs(s(4.5));
      out = [
        { bone: 'Torso', axis: 'right', angle: 0.1 + 0.05 * shake },
        { bone: 'Chest', axis: 'right', angle: 0.12 + 0.05 * shake },
        { bone: 'Head', axis: 'right', angle: 0.15 + 0.08 * shake },
        { bone: 'Chest', axis: 'up', angle: 0.06 * s(2.2) },
        { bone: 'UpperArmR', axis: 'right', angle: 0.4 },
        { bone: 'LowerArmR', axis: 'up', angle: 1.4 },
        { bone: 'LowerArmR', axis: 'right', angle: 0.4 },
        { bone: 'UpperArmL', axis: 'right', angle: 0.4 },
        { bone: 'LowerArmL', axis: 'up', angle: -1.4 },
        { bone: 'LowerArmL', axis: 'right', angle: 0.4 },
      ];
      break;
    }
    case 'point':
      // Right arm straight out toward where the player faces.
      out = [
        { bone: 'UpperArmR', axis: 'right', angle: 1.45 },
        { bone: 'UpperArmR', axis: 'up', angle: 0.25 },
        { bone: 'Chest', axis: 'up', angle: 0.15 },
      ];
      break;
  }
  return w === 1 ? out : out.map((x) => ({ ...x, angle: x.angle * w }));
}
