import * as THREE from 'three/webgpu';
import type { MatchEvent, Snapshot } from '../sim/types';

/** Damage I dealt this update, one number per target (shotgun pellets add up). */
export function damageNumbers(events: MatchEvent[], me: number): { target: number; amount: number }[] {
  const per = new Map<number, number>();
  for (const e of events) {
    if (e.type !== 'hit' || e.data.by !== me) continue;
    const target = e.data.target as number, amount = Number(e.data.amount) || 0;
    per.set(target, (per.get(target) ?? 0) + amount);
  }
  return [...per].map(([target, amount]) => ({ target, amount: Math.round(amount) }));
}

/** Screen-relative bearing of an attacker: 0 ahead, +PI/2 right, ±PI behind (camera yaw 0 looks toward -Z). */
export function hitDirection(me: { x: number; z: number }, attacker: { x: number; z: number }, camYaw: number): number {
  const dx = attacker.x - me.x, dz = attacker.z - me.z;
  const side = dx * Math.cos(camYaw) - dz * Math.sin(camYaw);
  const ahead = -dx * Math.sin(camYaw) - dz * Math.cos(camYaw);
  return Math.atan2(side, ahead);
}

const NUMBER_SEC = 0.9;
const ARROW_SEC = 1.2;
const HEAD_Y = 2.0;

type Floater = { el: HTMLElement; target: number; born: number; jitter: number };
type Arrow = { el: HTMLElement; attacker: number; born: number };

/** Floating damage numbers over players I hit, and red edge arcs pointing at whoever hit me. */
export class DamageFx {
  private root = document.createElement('div');
  private floaters: Floater[] = [];
  private arrows: Arrow[] = [];
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root.className = 'damage-fx';
    parent.append(this.root);
  }

  onSnapshot(snap: Snapshot, me: number) {
    const now = performance.now() / 1000;
    for (const { target, amount } of damageNumbers(snap.events, me)) {
      if (amount <= 0) continue;
      const el = document.createElement('div');
      el.className = `dmg-number${amount >= 40 ? ' big' : ''}`;
      el.textContent = `-${amount}`;
      this.root.append(el);
      this.floaters.push({ el, target, born: now, jitter: (Math.random() - 0.5) * 40 });
    }
    for (const e of snap.events) {
      if (e.type !== 'hit' || e.data.target !== me || typeof e.data.by !== 'number' || e.data.by === me) continue;
      const el = document.createElement('div');
      el.className = 'hit-arrow';
      this.root.append(el);
      this.arrows.push({ el, attacker: e.data.by, born: now });
    }
  }

  /** Call every frame. `posOf` gives a player's interpolated feet position. */
  frame(camera: THREE.Camera, camYaw: number, me: THREE.Vector3 | null, posOf: (id: number) => THREE.Vector3 | null) {
    const now = performance.now() / 1000;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.floaters = this.floaters.filter((f) => {
      const age = now - f.born;
      const p = posOf(f.target);
      if (age > NUMBER_SEC || !p) { f.el.remove(); return false; }
      this.v.set(p.x, p.y + HEAD_Y, p.z).project(camera);
      if (this.v.z > 1) { f.el.style.opacity = '0'; return true; }
      const x = (this.v.x * 0.5 + 0.5) * w + f.jitter, y = (-this.v.y * 0.5 + 0.5) * h - age * 60;
      f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 + Math.max(0, 0.15 - age) * 3})`;
      f.el.style.opacity = String(1 - Math.max(0, age - NUMBER_SEC * 0.5) / (NUMBER_SEC * 0.5));
      return true;
    });
    this.arrows = this.arrows.filter((a) => {
      const age = now - a.born;
      const p = posOf(a.attacker);
      if (age > ARROW_SEC || !p || !me) { a.el.remove(); return false; }
      const deg = (hitDirection(me, p, camYaw) * 180) / Math.PI;
      a.el.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
      a.el.style.opacity = String(1 - age / ARROW_SEC);
      return true;
    });
  }
}
