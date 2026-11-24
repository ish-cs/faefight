import * as THREE from 'three/webgpu';

const _parent = new THREE.Quaternion(), _turn = new THREE.Quaternion(), _pitch = new THREE.Quaternion();
const _axis = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

/**
 * Pose `bone` as `base` (this frame's clip pose) turned by `yaw` about world up, then `pitch` about the keeper's
 * right axis (+ = look up). Sets the rotation from the base pose every call, so calling it every frame with the
 * same look gives the same pose (it never accumulates). No allocations.
 */
export function lookTurn(bone: THREE.Object3D, base: THREE.Quaternion, yaw: number, pitch: number, fwd: THREE.Vector3) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_parent);
  _axis.set(fwd.z, 0, -fwd.x).normalize(); // keeper's right (fwd × up)
  _turn.setFromAxisAngle(UP, yaw).multiply(_pitch.setFromAxisAngle(_axis, -pitch));
  // local = parent⁻¹ · turn · parent · base
  bone.quaternion.copy(base).premultiply(_parent).premultiply(_turn).premultiply(_parent.invert());
  bone.updateMatrixWorld(true);
}
