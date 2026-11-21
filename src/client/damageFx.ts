import * as THREE from 'three/webgpu';
import type { MatchEvent, Snapshot } from '../sim/types';

/**
 * Damage I dealt this update, one entry per target (shotgun pellets add up). `amount` is the total,
 * `shield` the part their shield soaked (shown blue; the rest, to health, yellow).
 */
export function damageNumbers(events: MatchEvent[], me: number): { target: number; amount: number; shield: number }[] {
  const per = new Map<number, { amount: number; shield: number }>();
  for (const e of events) {
    if (e.type !== 'hit' || e.data.by !== me) continue;
    const target = e.data.target as number, amount = Number(e.data.amount) || 0, shield = Number(e.data.shieldAmount) || 0;
    const t = per.get(target) ?? { amount: 0, shield: 0 };
    t.amount += amount;
    t.shield += shield;
    per.set(target, t);
  }
  return [...per].map(([target, t]) => {
    const shield = Math.min(Math.round(t.shield), Math.round(t.amount));
    return { target, amount: Math.round(t.amount), shield };
  });
}

/** Did fire hurt me in these events? (Drives the burning indicator; the sim sends fire damage as `hit` with weapon 'fire'.) */
export function burnedBy(events: MatchEvent[], me: number): boolean {
  return events.some((e) => e.type === 'hit' && e.data.target === me && e.data.weapon === 'fire');
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
  /** "Burning" badge + warm screen edge while fire is hurting me. */
  private burning = document.createElement('div');
  private burnUntil = 0;

  constructor(parent: HTMLElement) {
    this.root.className = 'damage-fx';
    this.burning.className = 'burning-indicator';
    this.burning.innerHTML = '<span class="burning-flame"></span><span>BURNING</span>';
    this.burning.dataset.on = '0';
    this.root.append(this.burning);
    parent.append(this.root);
  }

  onSnapshot(snap: Snapshot, me: number) {
    const now = performance.now() / 1000;
    // Fire ticks every 0.5 s: keep the badge up a little past the last one.
    if (burnedBy(snap.events, me)) this.burnUntil = now + 0.8;
    for (const { target, amount, shield } of damageNumbers(snap.events, me)) {
      if (amount <= 0) continue;
      const jitter = (Math.random() - 0.5) * 40;
      const health = amount - shield;
      // Shield damage in blue, health damage in yellow; both when a hit breaks through.
      const add = (n: number, cls: string, dx: number) => {
        const el = document.createElement('div');
        el.className = `dmg-number ${cls}${amount >= 40 ? ' big' : ''}`;
        el.textContent = `-${n}`;
        this.root.append(el);
        this.floaters.push({ el, target, born: now, jitter: jitter + dx });
      };
      const both = shield > 0 && health > 0;
      if (shield > 0) add(shield, 'shield', both ? -22 : 0);
      if (health > 0) add(health, 'health', both ? 22 : 0);
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
    const on = me && now < this.burnUntil ? '1' : '0';
    if (this.burning.dataset.on !== on) { this.burning.dataset.on = on; this.root.dataset.burning = on; }
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
