// 작은 기하(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김): 3D 벡터(V), 두 마디를 잇는 관절 자리(bendJoint), 마당(위에서 본 [x, z])의 거리·방향,
// 0 → 1을 부드럽게 잇기(smooth). 수비 일정·주루·뼈대(sim)와 그림(main.js)이 같이 쓴다
import { clamp } from '../core/math.js';

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
};

// 두 마디(넓적다리·정강이, 위팔·아래팔)를 이을 무릎·팔꿈치 위치. pole 쪽으로 굽힌다
export function bendJoint(a, c, l1, l2, pole) {
  const d = V.sub(c, a), full = V.len(d) || 1;
  const dist = Math.min(full, l1 + l2 - 0.001);
  const dir = V.mul(d, 1 / full);
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const p = V.sub(pole, V.mul(dir, V.dot(pole, dir)));
  return V.add(V.add(a, V.mul(dir, along)), V.mul(p, h / (V.len(p) || 1)));
}
export const unit3 = (v) => V.mul(v, 1 / (V.len(v) || 1));
export const flatDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const unitTo = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz) || 1; return [dx / d, dz / d]; };
export const stepToward = (a, b, d) => { const u = unitTo(a, b); return [a[0] + u[0] * d, a[1] + u[1] * d]; };   // a에서 b 쪽으로 d m
export const faceTo = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);
export const smooth = (u) => { const k = clamp(u, 0, 1); return k * k * (3 - 2 * k); };
