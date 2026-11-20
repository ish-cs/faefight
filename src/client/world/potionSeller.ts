import * as THREE from 'three/webgpu';
import type { PotionShop } from '../../sim/types';

/**
 * PLACEHOLDER potion seller: a robed figure behind a small counter with a glowing blue flask above.
 * Driven by `snapshot.potionShops`; the map/world art for the centre-island NPC can replace this.
 */
export class PotionSellers {
  private stalls = new Map<number, THREE.Group>();
  private key = '';
  private flasks: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {}

  sync(shops: PotionShop[] | undefined) {
    const list = shops ?? [];
    const key = list.map((s) => `${s.id}:${s.pos.x.toFixed(2)},${s.pos.y.toFixed(2)},${s.pos.z.toFixed(2)}`).join('|');
    if (key === this.key) return;
    this.key = key;
    for (const g of this.stalls.values()) this.scene.remove(g);
    this.stalls.clear();
    this.flasks = [];
    for (const s of list) {
      const g = stall();
      g.position.set(s.pos.x, s.pos.y, s.pos.z);
      this.scene.add(g);
      this.stalls.set(s.id, g);
      this.flasks.push(g.getObjectByName('flask')!);
    }
  }

  frame(now: number) {
    for (const f of this.flasks) {
      f.rotation.y = now / 700;
      f.position.y = 2.5 + Math.sin(now / 400) * 0.08;
    }
  }
}

function stall(): THREE.Group {
  const g = new THREE.Group();
  const std = (color: number) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.8 });
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.6), std(0x6b4a2e));
  counter.position.set(0, 0.45, 0.6);
  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 1.5, 12), std(0x4b2d7f));
  robe.position.set(0, 0.75, -0.1);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), std(0xe0b48c));
  head.position.set(0, 1.68, -0.1);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 12), std(0x2d1a52));
  hat.position.set(0, 2.0, -0.1);
  const flask = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 12),
    new THREE.MeshStandardNodeMaterial({ color: 0x4aa8ff, emissive: 0x2f86f0, emissiveIntensity: 1.6, roughness: 0.2 }),
  );
  flask.name = 'flask';
  flask.position.set(0, 2.5, 0.6);
  for (const m of [counter, robe, head, hat]) { m.castShadow = true; m.receiveShadow = true; }
  g.add(counter, robe, head, hat, flask);
  return g;
}
