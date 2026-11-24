import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { lookTurn } from '../../src/client/characters/npcLook';

/** A neck → head chain under a yawed root, like a shop keeper standing at an angle. */
function rig() {
  const root = new THREE.Group();
  root.rotation.y = 0.7;
  const neck = new THREE.Bone(), head = new THREE.Bone();
  neck.position.y = 1.5; head.position.y = 0.1;
  head.quaternion.setFromEuler(new THREE.Euler(0.05, 0, 0.02)); // the clip's pose
  root.add(neck); neck.add(head);
  root.updateMatrixWorld(true);
  return { head, fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion) };
}

describe('npc head look', () => {
  it('sets the turn from the base pose: the same look on every frame gives the same pose (no spin)', () => {
    const { head, fwd } = rig();
    const base = head.quaternion.clone();
    lookTurn(head, base, 0.6, 0.2, fwd);
    const once = head.quaternion.clone();
    for (let i = 0; i < 200; i++) lookTurn(head, base, 0.6, 0.2, fwd);
    expect(head.quaternion.angleTo(once)).toBeLessThan(1e-6);
    // and the turn is the requested size: 0.6 rad yaw + 0.2 rad pitch away from the base pose
    expect(head.quaternion.angleTo(base)).toBeGreaterThan(0.6);
    expect(head.quaternion.angleTo(base)).toBeLessThan(0.8);
  });

  it('zero look returns exactly to the base pose', () => {
    const { head, fwd } = rig();
    const base = head.quaternion.clone();
    lookTurn(head, base, 0.9, -0.3, fwd);
    lookTurn(head, base, 0, 0, fwd);
    expect(head.quaternion.angleTo(base)).toBeLessThan(1e-6);
  });

  it('yaw turns about world up', () => {
    const { head, fwd } = rig();
    const base = head.quaternion.clone();
    const before = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
    lookTurn(head, base, 0.5, 0, fwd);
    const after = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
    expect(after.y).toBeCloseTo(before.y, 6); // no tilt from a pure yaw
    expect(Math.atan2(after.x, after.z) - Math.atan2(before.x, before.z)).toBeCloseTo(0.5, 5);
  });
});
