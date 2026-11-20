import * as THREE from 'three/webgpu';
import { color, float, max, min, mix, normalize, positionWorld, smoothstep, texture, time, transformNormalToView, uniform, vec2, vec3 } from 'three/tsl';
import type { IslandLayout } from '../../sim/map';

const NORMALS_URL = `${import.meta.env.BASE_URL}assets/textures/waternormals.jpg`;

/**
 * Animated ocean: two scrolling samples of the three.js water normal map (MIT), turquoise shallows hugging
 * the island walls fading to deep blue, a thin foam line where water meets the quay. Opaque on purpose: a
 * transparent pass would blend against the sky and wash out. The caller moves `mesh.position.y` with the tide.
 */
export function buildWater(map: IslandLayout[]): THREE.Mesh {
  const tex = new THREE.TextureLoader().load(NORMALS_URL, undefined, undefined, (err) => console.error(`[world/water] failed to load ${NORMALS_URL}`, err));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.07, metalness: 0 });
  mat.envMapIntensity = 0.55; // keep sky reflections from bleaching the turquoise
  mat.name = 'ocean';
  const p = positionWorld.xz;
  const t = time;
  const s1 = texture(tex, p.mul(0.045).add(vec2(t.mul(0.011), t.mul(0.007)))).xyz;
  const s2 = texture(tex, p.mul(0.11).sub(vec2(t.mul(0.009), t.mul(-0.013)))).xyz;
  const s3 = texture(tex, p.mul(0.012).add(vec2(t.mul(-0.003), t.mul(0.004)))).xyz;
  const n = s1.add(s2).add(s3).mul(2 / 3).sub(1); // average of three [-1,1] normals
  const strength = 0.55;
  mat.normalNode = transformNormalToView(normalize(vec3(n.x.mul(strength), n.z, n.y.mul(strength))));

  // distance to the nearest island quay wall
  const rim = map.map((isl) => p.sub(uniform(new THREE.Vector2(isl.center.x, isl.center.z))).length().sub(isl.radius));
  const near = max(rim.slice(1).reduce((a, b) => min(a, b), rim[0]), float(0));
  const shallow = color(0x16c9b6), mid = color(0x0b9bb0), deep = color(0x07527f);
  const base = mix(mix(shallow, mid, smoothstep(0, 9, near)), deep, smoothstep(6, 40, near));
  const foamNoise = s2.x.add(s1.y).mul(0.5);
  const foam = float(1).sub(smoothstep(0.15, 0.9, near.add(foamNoise.mul(0.5)))).mul(0.85);
  mat.colorNode = mix(base, color(0xeaf6f4), foam);
  mat.roughnessNode = mix(float(0.06), float(0.6), foam);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), mat);
  mesh.name = 'ocean';
  mesh.receiveShadow = true;
  return mesh;
}
