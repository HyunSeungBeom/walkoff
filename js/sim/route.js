// 뛰기 표와 길(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김). 걸음새, 길을 따라 뛸 때 1/120초마다의 거리·빠르기·걸음 위상 표(runTrack),
// 그 표로 t초에 있는 자리·보는 쪽 읽기(routeState), 베이스를 원호로 도는 길(arcRoute). 친 타자·누상 주자·수비수가 같이 쓴다
import { clamp, lerp } from '../core/math.js';
import { MOUND } from '../core/field.js';
import { smoothRoute } from '../core/race.js';
import { flatDist, unitTo } from './geom.js';

// 친 타자가 뛰기 시작하는 때(맞은 뒤 초)와 길 끝에서 줄이는 빠르기(초속 m씩). 주루는 batter.js
export const RUN_START = 0.28, RUN_BRAKE = 6;
// 걸음새: top 최고 빠르기(m/s), tau 빨라지는 시간 상수(초), cad 걸음 놀림(1초에 도는 바퀴 = 두 걸음, cad[0] + cad[1] × 빠르기), D 한 발이 땅에 붙어 있는 몫,
// effort 걸음 모양(1 전력 질주, 0 천천히 뛰기, 사이는 섞음. 자세는 runnerSkeleton의 RUN_POSE),
// lean 다 빨라졌을 때 숙임, start 출발할 때 더 숙임(라디안), Dstart 출발할 때 더 오래 디딤, drive 출발할 때 몸 뒤를 디뎌 미는 거리(m), dust 발을 찰 때 흙먼지
export const SPRINT = { top: 8.3, tau: 0.8, cad: [1.75, 0.045], D: 0.2, effort: 1, lean: 0.26, start: 0.62, Dstart: 0.1, drive: 0.45, dust: 1 };
export const JOG = { top: 5.4, tau: 1.2, cad: [1.45, 0.06], D: 0.24, effort: 0, lean: 0.06, start: 0.12, Dstart: 0.04, drive: 0.05, dust: 0, bank: 0.45 };   // bank: 베이스를 돌 때 기우는 정도(전력의 45%)
export const TROT = { ...JOG, top: 3.2, tau: 0.6 };
// S에서 bases를 차례로 원호(반지름 R)로 돌아 end까지 가는 길(3루타도 쓴다)
export function arcRoute(S, bases, end, R) {
  const corners = [S], next = [...bases.slice(1), end], TROT_R = R;
  bases.forEach((b, i) => {   // 원호 가운데가 베이스에 오도록 꼭짓점을 바깥으로 옮긴다(90도로 꺾일 때 0.414R)
    const u = unitTo(i ? bases[i - 1] : [0, 0.3], b), v = unitTo(b, next[i]), w = unitTo([0, 0], [u[0] - v[0], u[1] - v[1]]);
    const half = Math.acos(clamp(-(u[0] * v[0] + u[1] * v[1]), -1, 1)) / 2;   // 꺾인 안쪽 각의 반
    corners.push([b[0] + w[0] * TROT_R * (1 / Math.sin(half) - 1), b[1] + w[1] * TROT_R * (1 / Math.sin(half) - 1)]);
  });
  corners.push(end);
  const out = [S];
  for (let i = 1; i < corners.length - 1; i++) {   // 꼭짓점마다 두 직선에 닿는 원호(필렛)
    const P = corners[i], u = unitTo(corners[i - 1], P), v = unitTo(P, corners[i + 1]);
    const half = Math.acos(clamp(-(u[0] * v[0] + u[1] * v[1]), -1, 1)) / 2, t = TROT_R / Math.tan(half), turn = Math.PI - 2 * half;
    const a = [P[0] - u[0] * t, P[1] - u[1] * t], left = [-u[1], u[0]], c = [a[0] + left[0] * TROT_R, a[1] + left[1] * TROT_R];   // 반시계로 돌아 중심은 왼쪽
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), n = Math.ceil(turn * TROT_R / 0.5);
    for (let k = 0; k <= n; k++) { const th = a0 + turn * k / n; out.push([c[0] + Math.cos(th) * TROT_R, c[1] + Math.sin(th) * TROT_R]); }
  }
  out.push(end);
  return out;
}
// 뛰기 시작한 뒤 거리·빠르기·걸음 위상을 1/120초마다 미리 계산한다. 빠르기는 단거리 출발처럼 v = top(1 - e^(-t/tau))로 늘고,
// 길 끝에 멈출 수 있는 때(또는 공이 잡힌 때)부터 초속 6m씩 줄인다. 걸음은 출발부터 빠르게 놀려(1초에 3.5걸음) 첫 걸음이 짧고,
// 빨라지면 4.2걸음·한 걸음 1.9m까지 늘어난다(전에는 4.8걸음·1.7m라 종종걸음 같았다)
export function runTrack(plan) {
  const G = plan.gait, dt = 1 / 120, T = [], S = [], Vv = [], PH = [], BR = plan.brake ?? RUN_BRAKE;
  let s = 0, v = 0, ph = 0, braking = false;
  for (let i = 0, t = 0; i < 120 * 60; i++, t += dt) {
    T.push(t); S.push(s); Vv.push(v); PH.push(ph);
    if (!braking && (s + v * v / (2 * BR) >= plan.total || t + RUN_START + plan.delay >= plan.until)) braking = true;
    v = braking ? Math.max(0, v - BR * dt) : G.top * (1 - Math.exp(-t / G.tau));
    s = Math.min(plan.total, s + v * dt);
    ph += (G.cad[0] + G.cad[1] * v) * dt * Math.min(1, v / 0.4);   // 거의 멈추면 걸음도 멈춘다
    if (braking && v === 0 && i > 0) { T.push(t + dt); S.push(s); Vv.push(0); PH.push(ph); break; }
  }
  return { T, S, V: Vv, PH };
}
// 다리 하나: t0(맞은 뒤 초)에 pts를 지나는 길을 gait로 뛴다
export function makeLeg(t0, pts, gait) {
  const route = pts.length > 2 ? smoothRoute(pts) : pts, total = route.slice(1).reduce((a, q, i) => a + flatDist(route[i], q), 0);
  return { t0, route, gait, total, track: runTrack({ gait, route, total, until: Infinity, delay: 0 }) };
}
export function alongRoute(route, s) {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], d = flatDist(a, b);
    if (s <= d || i === route.length - 1) { const k = clamp(s / (d || 1), 0, 1); return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }
    s -= d;
  }
  return route[route.length - 1];
}
// 미리 계산한 표에서 t초 또는 위상 ph의 값을 찾는다
export const trackAt = (tr, t) => { const n = tr.T.length - 1, i = Math.min(n, Math.max(0, Math.floor(t * 120))); return { s: tr.S[i], v: tr.V[i], ph: tr.PH[i] }; };
export function phaseIndex(tr, ph) {
  let lo = 0, hi = tr.PH.length - 1;
  if (ph >= tr.PH[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.PH[m] < ph) lo = m; else hi = m; }
  return hi;
}
// 표의 1/120초 칸 사이를 이어 읽는다(칸 값 그대로면 최고 속도에서 7cm씩 틀어져 걸음마다 엉덩이 높이가 들쭉날쭉했다)
export function distAtPhase(tr, ph) {
  const i = phaseIndex(tr, ph);
  if (i <= 0 || tr.PH[i] <= tr.PH[i - 1]) return tr.S[i];
  return lerp(tr.S[i - 1], tr.S[i], clamp((ph - tr.PH[i - 1]) / (tr.PH[i] - tr.PH[i - 1]), 0, 1));
}
// 길(route)을 뛰기 표(track)대로 tt초 뛴 자리·빠르기·걸음 위상과 보는 쪽(친 타자·누상 주자가 함께 쓴다)
export function routeState(route, track, gait, tt) {
  const { s, v, ph } = trackAt(track, tt), p = alongRoute(route, s);
  let q = alongRoute(route, s + 1.2);   // 1.2m 앞을 보며 돈다
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05) { const n = route.length; q = [p[0] + route[n - 1][0] - route[n - 2][0], p[1] + route[n - 1][1] - route[n - 2][1]]; }
  const braking = s > 1 && v < trackAt(track, Math.max(0, tt - 0.05)).v - 0.01;
  // 베이스를 돌 때는 안쪽으로 기운다(구심력). turn은 1.2m 사이에 꺾이는 각의 사인이고, 왼쪽(+)으로 돌면 왼쪽으로 기운다
  const dir = unitTo(p, q), q2 = alongRoute(route, s + 2.4), d2 = unitTo(q, q2), turn = Math.hypot(q2[0] - q[0], q2[1] - q[1]) > 0.05 ? dir[0] * d2[1] - dir[1] * d2[0] : 0;
  const bank = clamp(v * v * Math.asin(clamp(turn, -1, 1)) / 1.2 / 9.8 * (gait.bank ?? 1), -0.35, 0.35);
  return { x: p[0], z: p[1], dir, bank, t: tt, speed: v, dist: s, ph, gait, route, track, braking };
}
const STAND_TRACK = { T: [0], S: [0], V: [0], PH: [0] };
// 서 있는 주자(따로 주지 않으면 투수 쪽을 본다)
export const standingRunner = (p, dir = unitTo(p, [0, MOUND])) => { return { x: p[0], z: p[1], dir, bank: 0, t: 0, speed: 0, dist: 0, ph: 0, gait: SPRINT, route: [p, [p[0] + dir[0], p[1] + dir[1]]], track: STAND_TRACK, braking: false, drawShift: 0, lookFoul: false, top: SPRINT.top }; };
