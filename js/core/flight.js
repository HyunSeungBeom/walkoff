// 친 공이 날아가고 구르는 길과 잡는 때(2026-11-04 main.js에서 옮김). 끝내기 상황 주루 플레이(scenario.js)를 서버도 같은 계산으로 다시 정해야 해서
// core로 옮겼다. 그림(main.js fieldPlay)과 끝내기 주루 판정이 같은 값을 쓴다. 무작위·화면 값 없이 타구(r)와 수비 자리만 쓴다
import { clamp, DEG, lerp } from './math.js';
import { FAIR_SPRAY, fenceDist, fieldHome, INFIELDERS, OUTFIELDERS } from './field.js';
import { hrExtra, hrLiftK } from './judge.js';
import { FIELD_REACT, FIELD_SPEED, GRASS_DECEL, groundPath, sprintDist } from './race.js';

export const THROW_OUT = 35, CATCH_Y = 1.9;   // 외야수 송구 빠르기(m/s), 뜬공을 잡는 높이(머리 위 글러브, 자세 catchHigh)
const flatDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const byPos = (pos) => [...INFIELDERS, ...OUTFIELDERS].find((f) => f.pos === pos);
const homeOf = fieldHome;
export const speedOf = (f) => (f.pos === '투수' ? FIELD_SPEED.p : OUTFIELDERS.includes(f) ? FIELD_SPEED.out : FIELD_SPEED.in);
export const reactOf = (f) => (f.pos === '투수' ? FIELD_REACT.p : OUTFIELDERS.includes(f) ? FIELD_REACT.out : FIELD_REACT.in);

// 공이 머리 위 글러브 높이로 내려오는 때(뜬공을 잡는 순간). 낮은 타구는 가장 높은 데서 조금 내려온 때
export function catchTime(r) {
  const dur = flightDuration(r);
  const N = 400;   // 끝에서는 공이 빨리 떨어져서 촘촘히 찾는다(40칸이면 3m 높이에서 잡았다)
  let peak = 0;
  for (let i = 0; i <= N; i++) peak = Math.max(peak, flightPos(r, dur * i / N).y);
  const y = Math.min(CATCH_Y, peak * 0.9);
  for (let i = N; i >= 0; i--) if (flightPos(r, dur * i / N).y >= y) return dur * i / N;
  return dur;
}
// 떨어진 안타가 튀고 구르는 길(2026-11-02 사용자 '굴러가는 공'). 맞은 공의 빠르기·각도로 처음 구르는 빠르기를 내고(낮은 타구일수록 많이 구른다)
// 외야 잔디에서 초속 6m씩 준다. 담장 앞 0.8m에 닿으면 맞고 튀어나와(빠르기의 30%, 3m까지) 멈춘다. 판정은 그대로다
export function rollPath(r) {
  const dur = flightDuration(r), land = flightPos(r, dur), a = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY) * DEG, dir = [Math.sin(a), Math.cos(a)];
  const room = Math.max(0, fenceDist(a / DEG) - 0.8 - land.s);
  let u0 = clamp(r.ev / 3.6 * Math.cos(r.la * DEG) * 0.35 * (1 - clamp(r.la, 0, 50) / 80), 3, 20);
  if (r.kind === 'double' || r.kind === 'triple') u0 = Math.max(u0, Math.sqrt(2 * GRASS_DECEL * room) + 3);   // 2루타는 외야수 사이를 빠져 담장까지 구른다(늦게 주워야 주자가 2루를 먼저 밟는다)
  const free = u0 * u0 / (2 * GRASS_DECEL), tw = free <= room ? Infinity : (u0 - Math.sqrt(u0 * u0 - 2 * GRASS_DECEL * room)) / GRASS_DECEL;
  const vw = Number.isFinite(tw) ? u0 - GRASS_DECEL * tw : 0, back = Math.min(3, vw * 0.3), tb = back > 0 ? Math.sqrt(2 * back / GRASS_DECEL) * 1.4 : 0;
  const rolled = (q) => {   // 떨어진 뒤 q초에 간 거리(담장을 맞고 나오면 줄어든다)
    if (q <= 0) return 0;
    if (q < tw && q < u0 / GRASS_DECEL) return u0 * q - 0.5 * GRASS_DECEL * q * q;   // 멈추면 그대로(전에는 멈춘 뒤 거꾸로 굴러갔다. 얕은 안타는 내야수가 먼저 주워 안 보였다)
    if (Number.isFinite(tw)) { const k = clamp((q - tw) / Math.max(0.01, tb), 0, 1); return room - back * (1 - (1 - k) * (1 - k)); }
    return free;
  };
  const tStop = Number.isFinite(tw) ? tw + tb : u0 / GRASS_DECEL;
  const at = (t) => {
    const q = t - dur, d = rolled(q), s = land.s + d, hop = Math.abs(Math.sin(Math.PI * Math.min(d, 9) / 4.5)) * 0.5 * clamp(1 - d / 9, 0, 1) * clamp(1 - r.la / 70, 0.3, 1);
    return { x: dir[0] * s, y: 0.04 + hop, z: 0.3 + dir[1] * s, trail: false };
  };
  return { dur, land: [land.x, land.z], at, pos: (t) => { const q = at(t); return [q.x, q.z]; }, tEnd: dur + tStop, wall: Number.isFinite(tw) };
}
// 굴러가는 공(rollPath)을 from에서 출발한 수비수가 잡는 첫 때(tMin 뒤, 팔이 reach m 닿는다. slack초 먼저 가 있으면 서서 막는다). 끝까지 못 따라가면 멈춘 공에 가는 때
export function interceptRoll(roll, from, react, top, tau, tMin, slack = 0, reach = 0.8) {
  for (let i = 0; ; i++) {
    const t = tMin + i / 60, b = roll.pos(t);
    if (Math.hypot(b[0] - from[0], b[1] - from[1]) - reach <= sprintDist(t - react - slack, top, tau)) return { t, at: b };
    if (t > roll.tEnd + 12 || i > 7200) return { t, at: b };   // 2분이 넘으면(숫자가 없는 타구) 그만 찾는다
  }
}

// 공이 날아가는(땅볼은 굴러가는) 시간. 뜬 타구는 그리는 꼭짓점 높이 H로 실제 체공 시간 2√(2H/g)이다(2026-11-02 사용자 결정 '실제처럼').
// 전에는 0.8~1.9초(홈런 2.4초)로 실제의 절반쯤이라, 수비수를 실제 사람처럼 뛰게 하면 초속 13m로 뛰어야 잡았다. 땅볼은 멈출 때까지
export function flightDuration(r) {
  if (r.type === 'ground') return (r.gpath ??= groundPath(r)).tStop;
  if (r.type === 'foul') return 1.0;
  const H = Math.max(1, (r.kind === 'hr' ? r.dist : carryOf(r)) * Math.tan(Math.max(r.la, 8) * DEG) / 4 * 1.3), T0 = 2 * Math.sqrt(2 * H / 9.8);
  return r.kind === 'hr' ? T0 / 2 * (1 + 1 / Math.sqrt(1 - 0.4 * hrLiftK(r.ev))) : T0;   // 홈런은 내려오는 시간이 길다
}
// 잡히는 뜬공·직선타를 그리는 비거리(2026-11-02). 판정(classify)의 비거리 그대로 그리면 잡는 수비수가 사람 빠르기로 못 가는 공이 많아서
// (직선타 아웃의 77%, 외야 뜬공 아웃의 18%는 다이빙해도 3m 넘게 모자랐다. 전에는 초속 11m로 뛰어 몸을 날렸다) 그런 공만 그 수비수가 달려가
// 잡을 수 있는 데까지 비거리를 당겨(멀리 보내) 그린다. 다이빙으로 닿는 공은 그대로 그려 몸을 날려 잡는다. 판정·점수는 그대로이고 결과 화면의 비거리도 그린 거리다
// 달리며 뜬공에 글러브가 닿는 거리(m): 머리 위 공은 몸 앞 0.36m, 가슴 높이 공은 팔을 뻗어 0.62m(catchAir와 같다)
export const airReach = (y) => (y > 1.6 ? 0.36 : 0.62);
export function carryOf(r) {
  if (r.carry !== undefined) return r.carry;
  if (r.kind === 'hr') return (r.carry = r.dist + hrExtra(r.ev));   // 끝에서 뻗는 만큼 더 간다(flightPos)
  r.carry = r.dist;
  if (r.kind !== 'out' || r.type === 'ground' || r.type === 'foul' || !r.fielder) return r.carry;
  const f = byPos(r.fielder.pos), h = homeOf(f), [top, tau] = speedOf(f), react = reactOf(f);
  const short = (c) => { r.carry = c; const tc = catchTime(r), q = flightPos(r, tc); return flatDist(h, [q.x, q.z]) - airReach(q.y) - sprintDist(tc - react, top, tau); };
  if (short(r.dist) <= 1.0) return (r.carry = r.dist);   // 다이빙(1m 더)으로 닿으면 그대로
  const a = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY) * DEG, depth = h[0] * Math.sin(a) + (h[1] - 0.3) * Math.cos(a);   // 수비수 자리를 타구 방향 위에 내린 거리
  let best = { c: r.dist, sh: Infinity };
  for (let i = 1; i <= 60; i++) {
    const c = lerp(r.dist, depth + (r.type === 'line' ? 15 : 10), i / 60), sh = short(c);
    if (sh < best.sh) best = { c, sh };
    if (sh <= -0.3) break;
  }
  return (r.carry = best.c);   // 끝까지 못 닿으면 가장 덜 모자란 거리(그 공은 몸을 날려 잡는다)
}

export function flightPos(r, t) {
  if (r.type === 'ground') {   // 땅볼은 groundPath를 따라 구르고 처음 34m 동안 작게 튄다
    const path = (r.gpath ??= groundPath(r)), s = path.dist(t), q = path.pos(t), fade = clamp(1 - s / 34, 0, 1);
    return { x: q[0], y: 0.04 + Math.abs(Math.sin(Math.PI * s / 8.5)) * 0.6 * fade * fade, z: q[1], tau: clamp(t / path.tStop, 0, 1), s };
  }
  const a = (r.type === 'foul' ? r.spray : clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY)) * DEG;   // 페어 타구는 파울선 안쪽에 그린다
  if (r.kind === 'hr') {   // 올라가는 길은 원래 비거리(r.dist)대로, 정점부터는 내려오는 시간을 늘리고 그동안 carryOf(r)까지 앞으로 뻗는다
    const base = r.dist, H = base * Math.tan(Math.max(r.la, 8) * DEG) / 4 * 1.3, T0 = 2 * Math.sqrt(2 * Math.max(1, H) / 9.8), T1 = T0 / 2, T2 = T1 / Math.sqrt(1 - 0.4 * hrLiftK(r.ev));
    let s, y;
    if (t <= T1) { const u = t / T0; s = base * (1 - Math.pow(1 - u, 1.35)); y = 1 + 4 * H * u * (1 - u) - u; }
    else {   // 정점의 가로 빠르기에서 이어지게(끝으로 갈수록 천천히) 앞으로 가고, 높이는 줄어든 중력으로 떨어진다
      const u = clamp((t - T1) / T2, 0, 1), sA = base * (1 - Math.pow(0.5, 1.35)), D = carryOf(r), vA = base * 1.35 * Math.pow(0.5, 0.35) / T0, pw = Math.max(1, vA * T2 / (D - sA));
      s = sA + (D - sA) * (1 - Math.pow(1 - u, pw)); y = (H + 0.5) * (1 - u * u);
    }
    return { x: s * Math.sin(a), y: Math.max(0.04, y), z: 0.3 + s * Math.cos(a), tau: clamp(t / (T1 + T2), 0, 1), s };
  }
  const tau = clamp(t / flightDuration(r), 0, 1), dist = carryOf(r);
  const H = dist * Math.tan(Math.max(r.la, 8) * DEG) / 4 * 1.3;
  const s = (r.type === 'pop' || r.type === 'foul') ? dist * tau : dist * (1 - Math.pow(1 - tau, 1.35));
  const y = 1 + 4 * H * tau * (1 - tau) - tau;
  return { x: s * Math.sin(a), y: Math.max(0.04, y), z: 0.3 + s * Math.cos(a), tau, s };
}
