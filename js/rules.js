// walkoff 판정 규칙: 기본 값, 공 순서, 스윙 판정과 타구 분류, 1루 경주, 점수. 화면·소리·게임 상태(game·settings)를 모르는 순수한 계산이라
// 게임(js/main.js)과 분석 스크립트(scripts/outcomes.js)가 같이 쓰고, 랭킹 서버도 같이 쓰게 옮길 수 있다(2026-11-03 코드 나누기 1단계).
// 게임 상태가 필요한 것은 인자로 받는다: 연속 기록(results), 몸쪽·바깥쪽과 좌타 대 좌완(bats)
// ===== 기본 값 (단위: m, km/h, 초, ms) =====
// 좌표: x는 오른쪽(1루 쪽), y는 위, z는 투수 쪽. 홈플레이트 앞 끝이 z = 0
export const RELEASE = { x: -0.55, y: 1.75, z: 17.0 };                    // 우투수가 공을 놓는 곳
export const ZONE = { left: -0.25, right: 0.25, bottom: 0.5, top: 1.1 };   // 공 반지름까지 넣은 스트라이크 존
export const BALL_R = 0.037;
export const FAIR_MS = 90;      // 타이밍 차이가 이 안이면 앞으로 가는 타구
export const FOUL_MS = 140;     // 이 안이면 파울, 넘으면 헛스윙
export const PERFECT_MS = 15;   // 정타
export const REACH_M = 0.2;     // 존 밖으로 이만큼 넘게 빠지면 배트가 닿지 않음

export const PITCHES = {
  fastball: { name: '직구',     kmh: [146, 153], brk: { x: 0.02, y: 0.06 },  late: 2.0, la: 4,   color: '#ffffff' },
  slider:   { name: '슬라이더', kmh: [134, 140], brk: { x: 0.32, y: -0.08 }, late: 2.6, la: -3,  color: '#7fd1ff' },
  curve:    { name: '커브',     kmh: [116, 124], brk: { x: 0.16, y: -0.55 }, late: 2.0, la: -6, lift: 6, color: '#c49bff' },
  change:   { name: '체인지업', kmh: [125, 131], brk: { x: -0.14, y: -0.24 }, late: 2.2, la: -7, lift: 6, color: '#8ef0a8' },
  fork:     { name: '포크',     kmh: [132, 138], brk: { x: 0.0, y: -0.5 },   late: 3.0, la: -14, lift: 9, color: '#ffb86b' },
};

// 실제 150km 직구는 0.4초 남짓이지만 게임에서는 0.75초쯤으로 늦춘다
export const flightTime = (kmh) => 112 / kmh;

export const POINTS = { hr: 1000, triple: 800, double: 500, single: 300, ball: 100 };
// 10구 모드는 기회 10번. 존 밖 공을 골라내면 그 공은 기회를 쓰지 않는다(기회 +1, 최대 +5)
// 기회 10번. 볼(존 밖 공을 참음)은 기회를 쓰지 않는다(2026-10-29 사용자 결정으로 추가 기회 상한 5번을 없앰).
// 투구 순서는 40개를 미리 만든다. 볼이 30개 넘게 나올 일은 사실상 없고, 다 쓰면 판을 끝낸다
export const CHANCES = 10, SEQ_LEN = 40;
export const PERFECT_BONUS = 100;
// 연속 홈런(2026-10-30 사용자 결정, 사용자 목소리 '연속 홈런 시 추가점'): 두 번째 연속(백투백)은 +500, 세 번째부터는 +1,000씩.
// 골라낸 볼은 기회를 쓰지 않아서 연속을 끊지 않고, 끝내기 찬스면 보너스도 2배다. 서버(worker/src/pitches.js)도 같은 값으로 점수 상한을 잰다
export const hrStreakBonus = (n) => (n >= 3 ? 1000 : n === 2 ? 500 : 0);
// 이번 공 앞으로 이어진 홈런 수. 볼은 건너뛰고, 다른 결과(안타·아웃·파울·헛스윙·루킹 스트라이크)가 나오면 끊긴다
export function hrStreakBefore(results, i) {
  let n = 0;
  for (let j = i - 1; j >= 0; j--) { const kind = results[j]?.kind; if (kind === 'ball') continue; if (kind !== 'hr') break; n++; }
  return n;
}
// 연속 안타(2026-11-03 사용자 결정 '연속 안타 보너스, 밸런스 있게'): 두 번째 연속 +100, 세 번째 +200, 네 번째부터 +300씩. 홈런·2루타·내야 안타도 안타다.
// 연속 홈런처럼 골라낸 볼은 끊지 않고 다른 결과는 끊는다. 홈런이면 연속 홈런 보너스와 더하지 않고 큰 쪽만 준다. 그래서 n번째마다 연속 홈런
// 보너스보다 작거나 같아, 서버 점수 상한(전광판 안타를 모두 홈런·연속 홈런 보너스로 본다)을 넘지 않는다
export const hitStreakBonus = (n) => (n >= 4 ? 300 : n === 3 ? 200 : n === 2 ? 100 : 0);
export function hitStreakBefore(results, i) {
  let n = 0;
  for (let j = i - 1; j >= 0; j--) { const r = results[j]; if (r?.kind === 'ball') continue; if (!r?.hit) break; n++; }
  return n;
}

// 외야 담장: 파울라인 쪽 100m, 가운데 122m. spray는 타구 방향(도), 음수가 3루 쪽
export const fenceDist = (spray) => 100 + 22 * Math.cos(clamp(spray, -45, 45) * 2 * Math.PI / 180);
export const INFIELDERS = [
  { pos: '3루수', a: -33, d: 32 }, { pos: '유격수', a: -13, d: 40 },
  { pos: '2루수', a: 13, d: 40 }, { pos: '1루수', a: 33, d: 32 }, { pos: '투수', a: 0, d: 18 },
];
export const OUTFIELDERS = [
  { pos: '좌익수', a: -28, d: 86 }, { pos: '중견수', a: 0, d: 95 }, { pos: '우익수', a: 28, d: 86 },
];

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
export const DEG = Math.PI / 180;

// 마당 좌표(m): x는 1루 쪽(+), z는 홈에서 투수 쪽(+). a는 홈에서 본 각도(도, 음수가 3루 쪽)
export const polar = (a, d) => [d * Math.sin(a * DEG), d * Math.cos(a * DEG)];
export const MOUND = 18.44, BASE1 = polar(45, 27.43), BASE2 = [0, 38.8], BASE3 = polar(-45, 27.43);
// 페어 타구를 그리고 수비를 움직일 때는 방향을 파울선 안쪽(±43°)으로 자른다. spray가 ±60°까지 나와 페어 땅볼이 파울 지역에 그려졌다. 판정은 그대로
export const FAIR_SPRAY = 43;
// 수비수 달리기(초속 m, 빨라지는 시간 상수 초)와 반응 시간(초). 판정(1루 경주)과 그림이 같은 값을 쓴다. 내야수는 투구에 맞춰 반 걸음 나가 있어서 첫발이 조금 빠르다
export const FIELD_SPEED = { in: [7, 0.46], out: [8.5, 0.6], p: [6.5, 0.45] }, FIELD_REACT = { in: 0.22, out: 0.3, p: 0.4 };
// 다이빙(그림 FTRACK.dive와 같은 식): 잡기 DIVE_LEAD초 전까지 공 쪽으로 달려가 그 자리에서 박차고 날아, 엉덩이 앞 DIVE_GLOVE m의 글러브가 공에 닿는다.
// 엉덩이가 나는 거리는 그때 빠르기로 DIVE_LEAD초 + 박차는 DIVE_PUSH m(서서 날면 1m, 전력으로 달려오면 3.3m). 전에는 '다이빙하면 2.4m 더'로 쳐서
// 거의 서 있던 수비수가 몸을 날린 자리에서 공까지 5m를 날아야 했다
export const DIVE_LEAD = 0.33, DIVE_GLOVE = 1.06, DIVE_PUSH = 1.0;
// 땅볼에 글러브가 닿는 거리(m): 서서 잡을 때는 몸 앞 0.6m, 달려가며 한 손으로 뻗으면 0.95m. 서서 잡으려면 공보다 0.3초 먼저 가 있어야 한다
export const SET_REACH = 0.6, RUN_REACH = 0.95, SET_SLACK = 0.3;
// 0에서 출발해 top(1 - e^(-t/tau))로 빨라지는 달리기(주자·수비수 걸음 runTrack과 같은 식)로 t초에 가는 거리와, d m를 가는 시간(멈추지 않고 지나가는 때)
export const sprintDist = (t, top, tau) => (t <= 0 ? 0 : top * (t - tau * (1 - Math.exp(-t / tau))));
export function sprintTime(d, top, tau) {
  if (d <= 0) return 0;
  let lo = 0, hi = 40;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (top * (m - tau * (1 - Math.exp(-m / tau))) < d) lo = m; else hi = m; }
  return hi;
}
// 땅볼이 굴러가는 길(2026-11-02): 처음 빠르기는 타구 속도에서 내고(덮어 친 공은 느리다) 내야에서는 초속 3m씩, 외야 잔디(40m 너머)에서는 6m씩 준다.
// 공은 홈플레이트 앞 0.3m에서 spray 방향(±43°로 자름)으로 간다
export const GROUND_DECEL = 3.0, GRASS_DECEL = 6.0, GRASS_AT = 40;
export function groundPath(r) {
  const a = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY) * DEG, dir = [Math.sin(a), Math.cos(a)];
  const u0 = Math.max(4, (r.ev - 45) * 0.38) * (r.la < 0 ? Math.max(0.6, 1 + r.la / 40) : 1);
  // 내야 구간: 감속 3m/s². GRASS_AT m에 닿으면 그때 빠르기로 외야 구간(감속 6m/s²)을 이어 간다
  const tIn = u0 * u0 / (2 * GROUND_DECEL) <= GRASS_AT ? Infinity : (u0 - Math.sqrt(u0 * u0 - 2 * GROUND_DECEL * GRASS_AT)) / GROUND_DECEL;
  const uIn = Number.isFinite(tIn) ? u0 - GROUND_DECEL * tIn : 0;
  const tStop = Number.isFinite(tIn) ? tIn + uIn / GRASS_DECEL : u0 / GROUND_DECEL;
  const dist = (t) => {
    const k = Math.min(t, tStop);
    if (k <= tIn) return u0 * k - 0.5 * GROUND_DECEL * k * k;
    const q = k - tIn;
    return GRASS_AT + uIn * q - 0.5 * GRASS_DECEL * q * q;
  };
  const speed = (t) => (t >= tStop ? 0 : t <= tIn ? u0 - GROUND_DECEL * t : uIn - GRASS_DECEL * (t - tIn));
  return { dir, u0, tStop, dist, speed, pos: (t) => { const s = dist(t); return [dir[0] * s, 0.3 + dir[1] * s]; } };
}
// 수비수가 굴러오는 땅볼에 닿는 첫 때와 자리. reach는 몸에서 글러브가 닿는 거리, slack은 공보다 먼저 가 있어야 하는 때(서서 잡기),
// 공이 홈에서 maxDepth m보다 멀어지면 더 쫓지 않는다(내야수가 외야 잔디까지 쫓아가 잡지 않게). 못 닿으면 null. 1/120초 간격으로 찾는다
export function reachGround(path, home, react, top, tau, reach, slack = 0, maxDepth = Infinity, until = path.tStop + 2) {
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) {
    const b = path.pos(t);
    if (Math.hypot(b[0], b[1]) > maxDepth) return null;
    if (Math.hypot(b[0] - home[0], b[1] - home[1]) - reach <= sprintDist(t - react - slack, top, tau)) return { t, at: b };
  }
  return null;
}
// 다이빙으로 땅볼에 닿고도 남는 거리(음수면 닿는다): t초에 잡으려면 DIVE_LEAD초 전까지 달린 자리에서 날아야 한다
export function diveShort(b, home, t, react, top, tau) {
  const tl = t - DIVE_LEAD - react, vL = tl > 0 ? top * (1 - Math.exp(-tl / tau)) : 0;
  return Math.hypot(b[0] - home[0], b[1] - home[1]) - DIVE_GLOVE - vL * DIVE_LEAD - DIVE_PUSH - sprintDist(tl, top, tau);
}
export function reachDive(path, home, react, top, tau, maxDepth = Infinity, until = path.tStop + 2) {
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) {
    const b = path.pos(t);
    if (Math.hypot(b[0], b[1]) > maxDepth) return null;
    if (diveShort(b, home, t, react, top, tau) <= 0) return { t, at: b };
  }
  return null;
}
// 달려가 닿는 첫 때(std), 못 닿으면 다이빙(dive), 그래도 못 닿으면 가장 가까이 가는 때에 다이빙(forced)
export function interceptGround(path, home, react, top, tau, until = path.tStop + 2) {
  const run = reachGround(path, home, react, top, tau, RUN_REACH, 0, Infinity, until);
  if (run) return { ...run, how: 'std' };
  const dive = reachDive(path, home, react, top, tau, Infinity, until);
  if (dive) return { ...dive, how: 'dive' };
  let best = null;
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) { const short = diveShort(path.pos(t), home, t, react, top, tau); if (!best || short < best.short) best = { t, short }; }
  return { t: best.t, at: path.pos(best.t), how: 'forced' };
}

export function hasBatchim(word) {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0;
}
export const eun = (word) => word + (hasBatchim(word) ? '은' : '는');

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted(rnd, weights) {
  const keys = Object.keys(weights);
  let r = rnd() * keys.reduce((s, k) => s + weights[k], 0);
  for (const k of keys) { r -= weights[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

export const PITCH_MIX = { fastball: 3, slider: 2, curve: 1.5, change: 2, fork: 1.5 };

// 공 하나. inZone 확률로 존 안에 넣고, 빠질 때는 구종마다 빠지는 쪽이 다르다(우투수 기준)
export function makePitch(rnd, type, inZone, extra = {}) {
  const def = PITCHES[type];
  const kmh = Math.round(lerp(def.kmh[0], def.kmh[1], rnd()));
  let tx, ty;
  if (rnd() < inZone) {
    tx = lerp(-0.2, 0.2, rnd()); ty = lerp(0.58, 1.02, rnd());
  } else if (type === 'slider') {
    tx = lerp(0.33, 0.5, rnd()); ty = lerp(0.45, 0.95, rnd());        // 우타자 바깥으로 빠짐
  } else if (type === 'fastball') {
    if (rnd() < 0.6) { tx = lerp(-0.2, 0.2, rnd()); ty = lerp(1.17, 1.32, rnd()); }  // 높게
    else { tx = lerp(-0.5, -0.33, rnd()); ty = lerp(0.6, 1.0, rnd()); }            // 우타자 몸쪽
  } else {
    tx = lerp(-0.22, 0.22, rnd()); ty = lerp(0.2, 0.42, rnd());       // 떨어지는 공은 낮게 빠짐
  }
  return { type, kmh, tx: extra.lefty ? -tx : tx, ty, T: flightTime(kmh), ...extra };   // 좌투수는 좌우가 뒤집힌다
}

// 10구 흐름: 1~2구는 직구로 감을 잡고, 3구부터 변화구를 섞는다
export function makeSequence(seed, lefty = false) {
  const rnd = mulberry32(seed);
  // 볼을 골라내면 기회가 늘어서 공을 SEQ_LEN개 미리 만든다. 같은 시드면 n번째 공은 누구에게나 같고, 길이를 늘려도 앞의 공은 그대로다
  return Array.from({ length: SEQ_LEN }, (_, i) => {
    const type = i < 2 ? 'fastball' : i === 2 ? (rnd() < 0.5 ? 'fastball' : 'slider') : pickWeighted(rnd, PITCH_MIX);
    return makePitch(rnd, type, i < 3 ? 0.8 : 0.6, { n: i + 1, lefty });
  });
}

// 판마다 상대 투수의 손. 좌완이 35%다. 공 순서와 다른 난수를 써서 순서는 그대로 둔다
export const pitcherHand = (seed) => (mulberry32((seed ^ 0x9e3779b9) >>> 0)() < 0.35 ? 'L' : 'R');

// u: 0(놓는 순간)~1(홈플레이트 앞). 휘는 양이 u의 거듭제곱이라 끝에서 크게 휜다. 좌투수는 놓는 곳과 휘는 쪽이 반대다
export function ballPos(p, u) {
  const def = PITCHES[p.type], hs = p.lefty ? -1 : 1, rx = RELEASE.x * hs, bx = def.brk.x * hs, by = def.brk.y;
  const k = Math.pow(Math.max(u, 0), def.late);
  return {
    x: rx + (p.tx - bx - rx) * u + bx * k,
    y: RELEASE.y + (p.ty - by - RELEASE.y) * u + by * k,
    z: RELEASE.z * (1 - u),
  };
}

// 좌타자는 좌투수를 상대할 일이 드물어서 공이 늦게 보인다(좌타 대 좌완에만 적용. 우타 대 우완은 흔해서 익숙하다)
export const hardMatchup = (p, bats) => !!p.lefty && bats === 'L';

export function zoneMiss(p) {
  return Math.max(ZONE.left - p.tx, p.tx - ZONE.right, ZONE.bottom - p.ty, p.ty - ZONE.top, 0);
}
// 존에서 어느 쪽으로 몇 cm 빠졌는지(공 가장자리와 존 사이). 우타자는 몸쪽이 왼쪽(-x), 좌타자는 오른쪽이다.
// 판정은 그대로 두고, '걸쳐 보였는데 볼' 같은 공이 실제로 얼마나 빠졌는지 숫자로 알려 준다(2026-10-30)
export function zoneOff(p, bats) {
  const sides = [['아래', ZONE.bottom - p.ty], ['위', p.ty - ZONE.top], [bats === 'L' ? '바깥쪽' : '몸쪽', ZONE.left - p.tx], [bats === 'L' ? '몸쪽' : '바깥쪽', p.tx - ZONE.right]];
  const [dir, m] = sides.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { dir, cm: Math.max(1, Math.round(m * 100)) };
}
export const offText = (p, bats) => { const o = zoneOff(p, bats); return `존 ${o.dir}${/[래위]$/.test(o.dir) ? '로' : '으로'} ${o.cm}cm`; };

// 발사각별 비거리 비율. 공기 저항 때문에 30도 근처에서 가장 멀리 간다
export const CARRY_BY_LA = [[0, 0], [5, 0.25], [10, 0.45], [15, 0.62], [20, 0.8], [25, 0.93], [30, 1], [35, 0.97],
  [40, 0.9], [45, 0.8], [50, 0.68], [60, 0.5], [70, 0.32], [80, 0.15], [90, 0]];

export function carry(ev, la) {
  if (la <= 0) return 0;
  let g = 0;
  for (let i = 1; i < CARRY_BY_LA.length; i++) {
    const [a0, g0] = CARRY_BY_LA[i - 1], [a1, g1] = CARRY_BY_LA[i];
    if (la <= a1) { g = lerp(g0, g1, (la - a0) / (a1 - a0)); break; }
  }
  return Math.max(0, 1.07 * ev - 54) * g;   // 177km/h·30도면 135m쯤
}

export function nearest(list, spray) {
  return list.reduce((best, f) => (Math.abs(f.a - spray) < Math.abs(best.a - spray) ? f : best));
}

export function fieldArea(spray) {
  if (spray < -20) return '좌';
  if (spray < -8) return '좌중';
  if (spray <= 8) return '중';
  if (spray <= 20) return '우중';
  return '우';
}

// 스윙 판정. dt는 스윙 시각 - 공 도착 시각(ms), 음수면 빠름. 무작위 없이 계산한다
export function judgeSwing(p, dt, bats = 'R') {
  const def = PITCHES[p.type];
  const miss = zoneMiss(p);
  const adt = Math.abs(dt);
  const slowBall = p.type === 'curve' || p.type === 'change';
  const r = { kind: 'whiff', name: '헛스윙', hit: false, points: 0, dt, ev: 0, la: 0, spray: 0, dist: 0, reason: '', perfect: false, bats };

  if (miss > REACH_M) { r.reason = `${offText(p, bats)} 빠진 공이었어요`; return r; }
  if (adt > FOUL_MS) {
    r.reason = dt < 0 ? (slowBall ? `${eun(def.name)} 느려요. 더 기다렸다 치세요` : '너무 빨리 휘둘렀어요') : '너무 늦게 휘둘렀어요';
    return r;
  }

  const tq = 1 - Math.pow(Math.min(adt, FAIR_MS) / FAIR_MS, 1.6);
  const reach = 1 - miss / REACH_M;
  const q = tq * (0.35 + 0.65 * reach);
  r.ev = Math.round(75 + 100 * Math.pow(q, 1.2) + (p.kmh - 135) * 0.25);
  // 높은 공은 뜨고, 빠르면 덮어 친다. 커브·체인지업·포크는 잘 맞힐수록(tq의 세제곱) lift만큼 덜 깔린다(2026-11-03 유저 목소리 '포크·체인지업은 홈런이 안 나온다', 커브는 사용자 결정.
  // 전에는 정타여도 포크 홈런 0%, 체인지업 4%, 커브 3%였다. 세제곱이라 빗맞은 포크는 그대로 땅볼이 많다(45% → 38%))
  r.la = Math.round(24 + (p.ty - 0.8) * 40 + def.la + (def.lift ?? 0) * tq * tq * tq + dt * 0.2);
  // 빠르면 당겨치고 늦으면 밀어친다. 당기는 쪽이 우타는 3루 쪽(음수), 좌타는 1루 쪽(양수)
  const side = bats === 'L' ? -1 : 1;
  r.spray = Math.round(side * dt / FAIR_MS * 42 + p.tx * 40);

  if (adt > FAIR_MS) {
    r.kind = 'foul'; r.name = '파울'; r.type = 'foul';
    r.ev = Math.round(95 + (FOUL_MS - adt) * 0.8);
    r.la = clamp(r.la, -5, 55);
    r.spray = side * Math.sign(dt) * Math.round(48 + (adt - FAIR_MS) * 0.4);
    r.dist = Math.max(20, carry(r.ev, Math.max(r.la, 15)));
    r.reason = dt < 0 ? (slowBall ? `${eun(def.name)} 느려요. 조금 더 기다리세요` : '빨라서 당겨친 파울') : '늦어서 밀린 파울';
    return r;
  }

  r.perfect = adt <= PERFECT_MS && miss === 0;
  r.dist = carry(r.ev, r.la);
  classify(r, p, miss);
  if (r.perfect && r.kind === 'out') throughGap(r, p, miss);
  if (r.kind === 'out' && r.type === 'ground') settleAtFirst(r, bats);   // 1루 경주: 늦으면 내야 안타
  return r;
}

// 정타는 아웃이 되지 않는다(2026-10-30 사용자 결정, 사용자 목소리 '정타를 쳤는데 아웃'). 정타는 타이밍이 맞아 가운데로 가는데
// 가운데에는 중견수가 있고 담장도 가장 멀어서, 존 안 정타의 28%가 중견수 직선타·담장 앞 뜬공으로 잡혔다(같은 공을 30ms 늦게 치면 2루타였다).
// 잡힐 정타만 가장 가까운 수비 빈틈으로 보내 다시 판정한다. 빈틈은 수비 위치의 가운데: 땅볼은 3유간·투수 옆·1·2루간, 뜬 타구는 좌중간·우중간
export const between = (list) => list.slice(1).map((f, i) => (list[i].a + f.a) / 2);
export const GAPS = { ground: between(INFIELDERS.slice(0, 4)), air: between(OUTFIELDERS) };
export function throughGap(r, p, miss) {
  const gaps = r.type === 'ground' ? GAPS.ground : GAPS.air;
  r.spray = gaps.reduce((best, g) => (Math.abs(g - r.spray) < Math.abs(best - r.spray) ? g : best));
  Object.assign(r, { dist: carry(r.ev, r.la), fielder: undefined, gap: undefined, wall: undefined, split: true });
  classify(r, p, miss);
}

export function classify(r, p, miss) {
  const s = r.spray, ev = r.ev, la = r.la;
  const area = fieldArea(s);
  const single = () => {
    r.kind = 'single'; r.hit = true;
    r.name = area.startsWith('좌') ? '좌전 안타' : area.startsWith('우') ? '우전 안타' : '중전 안타';
  };
  const double = () => {
    r.kind = 'double'; r.hit = true;
    r.name = s < -35 ? '좌익선상 2루타' : s < -8 ? '좌중간 2루타' : s <= 8 ? '중월 2루타' : s <= 35 ? '우중간 2루타' : '우익선상 2루타';
  };
  // 3루타(2026-11-03 사용자 결정): 담장을 맞은 2루타 가운데 가장 가까운 외야수에게서 12도 넘게 먼 공(좋은 타구의 3%쯤). 800점
  const triple = () => {
    r.kind = 'triple'; r.hit = true;
    r.name = s < -35 ? '좌익선상 3루타' : s < -8 ? '좌중간 3루타' : s <= 8 ? '중월 3루타' : s <= 35 ? '우중간 3루타' : '우익선상 3루타';
  };
  const homeRun = () => { r.kind = 'hr'; r.hit = true; r.name = `${area}월 홈런`; };
  const outBy = (f, what) => { r.kind = 'out'; r.name = `${f.pos} ${what}`; r.fielder = f; };
  const infield4 = INFIELDERS.slice(0, 4);

  if (la < 8) {
    r.type = 'ground';
    const fielders = ev < 110 ? INFIELDERS : infield4;          // 느린 땅볼은 투수도 잡는다
    const cover = 7 + 8 * clamp((150 - ev) / 60, 0, 1);         // 느릴수록 수비가 따라간다
    const f = nearest(fielders, s);
    if (Math.abs(f.a - s) <= cover || ev < 85) { outBy(f, '땅볼'); r.dist = f.d; }
    else if (Math.abs(s) > 33 && ev >= 140) { double(); r.dist = 78; }
    else { single(); r.dist = 62; r.gap = s < -13 ? '3유간' : s > 13 ? '1·2루간' : '투수 옆'; }
  } else if (la < 22) {
    r.type = 'line';
    const fi = nearest(infield4, s), fo = nearest(OUTFIELDERS, s);
    if (r.dist < 28) { if (Math.abs(fi.a - s) <= 7) outBy(fi, '직선타'); else single(); }
    else if (r.dist >= fenceDist(s)) homeRun();
    else if (Math.abs(fo.a - s) <= 7 && r.dist > 55 && r.dist < 98) outBy(fo, '직선타');
    else if (r.dist >= 82) double();
    else single();
  } else if (la < 50) {
    r.type = 'fly';
    const fence = fenceDist(s), fo = nearest(OUTFIELDERS, s);
    if (r.dist >= fence) homeRun();
    else if (r.dist >= fence - 6) { if (Math.abs(fo.a - s) > 12) triple(); else double(); r.wall = true; }
    else if (r.dist < 38) outBy(nearest(infield4, s), '뜬공');
    else if (r.dist < 58) single();                                // 내야와 외야 사이에 떨어진다
    else if (Math.abs(fo.a - s) > 10 && r.dist >= 80) double();    // 외야수 사이를 가른다
    else outBy(fo, '뜬공');
  } else {
    r.type = 'pop';
    outBy(nearest(infield4, s), '뜬공');
    r.dist = Math.min(r.dist, 30);
  }
  r.points = POINTS[r.kind] || 0;
  r.reason = reasonFor(r, p, miss);
}

// 홈런은 정점을 지나 내려올 때 덜 떨어져 끝에서 쭉 뻗는다(2026-11-03 사용자 '홈런이 마지막에 쭉쭉 뻗어 가는 느낌'). 타구 속도 159 → 180km/h에 따라
// k 0 → 1, 내려오는 시간은 1/√(1 − 0.4k)배(최대 1.29배)이고 그동안 4 + 16k m 더 가서 관중석 깊이 꽂힌다. 홈런이 되는지(dist ≥ 담장)와 점수는 그대로다
export const hrLiftK = (ev) => clamp((ev - 159) / 21, 0, 1);
export const hrExtra = (ev) => 4 + 16 * hrLiftK(ev);
export function reasonFor(r, p, miss) {
  if (r.kind === 'hr') return r.perfect ? '완벽한 타이밍이에요' : `${Math.round(r.dist + hrExtra(r.ev))}m 날아갔어요`;
  if (r.split) return '정타라 수비 사이로 빠졌어요';
  if (miss > 0) return `${offText(p, r.bats)} 빠진 공이라 힘이 덜 실렸어요`;
  if (p.type === 'fork' && r.type === 'ground') return '포크는 끝에서 떨어져서 공 윗부분을 치기 쉬워요';
  if (r.kind === 'triple') return '담장을 맞고 외야수 사이로 빠졌어요';
  if (r.wall) return '조금만 더 갔으면 홈런이었어요';
  if (p.ty > 1.0 && (r.type === 'fly' || r.type === 'pop')) return '높은 공은 뜨기 쉬워요';
  if (p.ty < 0.65 && r.type === 'ground') return '낮은 공은 땅볼이 되기 쉬워요';
  if (r.gap) return `${r.gap}을 빠져나갔어요`;
  if (Math.abs(r.dt) <= PERFECT_MS) return '타이밍은 완벽했어요';
  return r.dt > 0 ? '늦어서 밀어친 타구예요' : '빨라서 당겨친 타구예요';
}

export function judgeTake(p, bats) {
  return zoneMiss(p) === 0
    ? { kind: 'strike', name: '루킹 스트라이크', points: 0, reason: '존에 들어온 공이었어요', took: true }
    : { kind: 'ball', name: '볼', points: POINTS.ball, reason: `${offText(p, bats)} 빠졌어요 · 선구안 보너스`, took: true };
}

// ===== 1루 경주(2026-11-02 사용자 '간발의 승부', 판정이 바뀐다) =====
// 땅볼 아웃으로 판정된 공을 수비수가 잡아 던진 공이 1루에 닿는 때와, 친 타자가 1루를 밟는 때를 견줘 늦으면 내야 안타로 바꾼다.
// 무작위 없이 ev·la·spray·수비수·타석만 쓰고 화면(폰 그림 이동 등)은 쓰지 않아 PC·폰이 같다. 그림(fieldPlay)도 이 시각을 그대로 쓴다.
// 정타는 이미 수비 사이로 빠져(throughGap) 여기 오지 않는다. 서버는 바꾸지 않는다(내야 안타도 배트가 닿은 공이라 초록불을 받는다)
// 친 뒤 주자가 1루를 밟는 때(초). 우타는 스윙한 힘이 3루 쪽으로 쏠려 타석에서 늦게 나오고 좌타는 1루 쪽이라 빠르다. 그림은 출발 시각으로 맞춘다(runStartOf).
// 우타의 땅볼은 3루·유격 쪽(먼 송구)으로, 좌타는 1·2루 쪽(짧은 송구, 1루수가 직접 밟기)으로 많이 가서 둘의 차이를 실제(0.1초쯤)보다 크게 두어 내야 안타가 한쪽으로 쏠리지 않게 했다
export const RUN_TO_1B = { R: 4.7, L: 4.2 };
// 땅볼을 잡는 방법(2026-11-02 사용자 '러닝 스로가 더 빠르다, 몸을 날리는 건 1·2루간·3유간으로 가는 어려운 공만'):
//  set   공 길에 먼저 가서 서서 잡고 한 발 내디뎌 던진다(정면 땅볼)
//  run   달려가며 한 손으로 잡아 멈추지 않고 던진다(러닝 스로). 앞으로 달려 나오거나(charge) 1루 쪽으로 몸이 가는 공
//  plant 1루 반대쪽으로 달려가며 잡아(백핸드·2루 쪽) 발을 디뎌 멈추고 던진다
//  dive  달려도 글러브가 안 닿아 몸을 날려 잡고 일어나 던진다
// 서서 잡아도 주자보다 0.3초 넘게 먼저 닿으면 서서 잡고, 아니면 1루에 가장 빨리 닿는 방법을 고른다. 다이빙은 달려서는 안 닿는 공뿐이다.
// 전에는 늘 가장 일찍 닿는 자리에서 잡게 하고 잡은 뒤 1.45초를 들고 있다 던져서, 그림이 땅볼의 86%를 다이빙으로 그렸다
// 잡아서 공을 놓기까지(초, 서서 잡기)와 1루까지 평균 송구 빠르기(m/s). run·plant·dive는 PLAY_EX(초)와 PLAY_SPEED(빠르기 배수)를 쓴다.
// 1루수는 잡고 공을 챙겨 1루로 뛰거나 토스하기까지. 분석 스크립트(scripts/outcomes.js)로 맞춘 값이다
export const EXCHANGE = { '3루수': 0.95, '유격수': 0.95, '2루수': 0.9, '1루수': 0.4, '투수': 1.0 };
export const THROW_SPEED = { '3루수': 30, '유격수': 29, '2루수': 25, '투수': 25 };
export const PLAY_EX = { run: 0.75, plant: 1.25, dive: 2.0 }, PLAY_SPEED = { run: 0.85, plant: 0.92, dive: 0.78 };
export const fieldHome = (f) => (f.pos === '투수' ? [0, MOUND - 1.5] : polar(f.a, f.d));   // 투수는 공을 던진 뒤 마운드 앞 수비 자세 자리
// 투수가 1루 커버를 가는 길: 마운드 앞에서 1루 4m 앞 선 안쪽(0.6m)으로 달려가 선을 따라 베이스 안쪽을 밟는다(꺾이는 곳은 둥글게).
// 1루수가 멀리 잡으면 이 길을 뛰는 투수에게 토스하고, 투수는 베이스 1m 앞(TOSS_STEP초 앞)에서 받아 밟는다
export const PCOVER = (() => {
  const at = (d, o) => [BASE1[0] - Math.SQRT1_2 * (d + o), BASE1[1] - Math.SQRT1_2 * (d - o)];   // 1루에서 홈 쪽 선을 따라 d, 선 안쪽(내야 쪽)으로 o
  const a = [0, MOUND - 1.5], c = at(4, 0.6), k = 2 / Math.hypot(c[0] - a[0], c[1] - a[1]), c0 = [c[0] + (a[0] - c[0]) * k, c[1] + (a[1] - c[1]) * k], c1 = at(2, 0.4), pts = [a];
  for (let i = 0; i <= 8; i++) { const s = i / 8; pts.push([0, 1].map((j) => (1 - s) * (1 - s) * c0[j] + 2 * (1 - s) * s * c[j] + s * s * c1[j])); }
  pts.push(at(0, 0.3));
  return pts;
})();
export const PCOVER_LEN = PCOVER.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - PCOVER[i][0], q[1] - PCOVER[i][1]), 0), TOSS_STEP = 0.12;
// 친 타자가 출발점(타석)에서 at까지 가는 때. 1루를 밟는 때(RUN_TO_1B)에 맞춘 SPRINT 걸음 비율로 센다(1루수 태그용)
export function runnerTimeAt(at, bats) {
  const start = [(bats === 'L' ? 1 : -1) * 1.0, 0.3], full = sprintTime(Math.hypot(BASE1[0] - start[0], BASE1[1] - start[1]), 8.3, 0.8);
  return 0.28 + sprintTime(Math.hypot(at[0] - start[0], at[1] - start[1]), 8.3, 0.8) * (RUN_TO_1B[bats === 'L' ? 'L' : 'R'] - 0.28) / full;
}
export function settleAtFirst(r, bats) {
  const path = groundPath(r);
  // 홈 12m 안에서 멈추는 빗맞은 공은 투수가 달려 나와 잡는다(실제로는 포수·투수 공이다. 3루수가 25m를 달려와 잡으면 늘 내야 안타였다)
  if (path.dist(path.tStop) < 12 && r.fielder.pos !== '투수') { r.fielder = INFIELDERS.find((x) => x.pos === '투수'); r.name = '투수 땅볼'; }
  const race = computeRace(r, bats);
  r.race = race;
  if (race.safe) {
    Object.assign(r, { kind: 'single', hit: true, infield: true, name: `${race.pos} 내야 안타`, points: POINTS.single });
    r.reason = !race.arrive ? '느린 타구라 던질 틈이 없었어요' : `${race.how === 'dive' ? '몸을 날려 잡았지만 ' : ''}1루에 ${(-race.margin).toFixed(2)}초 먼저 닿았어요`;
  } else if (race.margin < 0.15) r.reason = `간발의 차로 아웃 · ${race.margin.toFixed(2)}초`;
}
// 1루 경주를 잰다(r는 바꾸지 않는다). 그림(fieldPlay)이 판정 없이 만든 시험용 결과에도 쓴다
export function computeRace(r, bats) {
  const path = groundPath(r);
  const f = r.fielder, pos = f.pos, isP = pos === '투수', [top, tau] = isP ? FIELD_SPEED.p : FIELD_SPEED.in, react = isP ? FIELD_REACT.p : FIELD_REACT.in;
  const home = fieldHome(f), hd = Math.hypot(home[0], home[1]), runner = RUN_TO_1B[bats === 'L' ? 'L' : 'R'];
  const toB1 = (at) => Math.hypot(at[0] - BASE1[0], at[1] - BASE1[1]), lane = (at) => Math.abs(at[0] - at[1]) / Math.SQRT2;   // lane: 1루선(주자 길목)에서 떨어진 거리
  // 잡는 방법마다 잡는 때·자리. 다이빙은 달려서 안 닿을 때만 본다. 수비 자리보다 5m 넘게 뒤(외야 쪽)로는 쫓지 않는다
  const cands = [], maxD = hd + 5;
  const set = reachGround(path, home, react, top, tau, SET_REACH, SET_SLACK, maxD);
  if (set) cands.push({ how: 'set', ...set });
  const run = reachGround(path, home, react, top, tau, RUN_REACH, 0, maxD);
  if (run) {
    const m = Math.hypot(run.at[0] - home[0], run.at[1] - home[1]), u = m > 0.01 ? [(run.at[0] - home[0]) / m, (run.at[1] - home[1]) / m] : [-home[0] / hd, -home[1] / hd];
    const d1 = toB1(run.at), w = [(BASE1[0] - run.at[0]) / d1, (BASE1[1] - run.at[1]) / d1], charge = -(u[0] * home[0] + u[1] * home[1]) / hd;   // charge: 홈 쪽으로 달려 나온 정도
    // 1루 반대쪽으로 몸이 가면(유격수·3루수의 백핸드, 2루수의 2루 쪽) 발을 디뎌 멈추고 던진다. 달려 나오거나 1루 쪽으로 가면 그대로 던진다
    cands.push({ how: charge < 0.5 && u[0] * w[0] + u[1] * w[1] < -0.25 ? 'plant' : 'run', charge: charge >= 0.5, ...run });
  } else {
    const dive = reachDive(path, home, react, top, tau, maxD);
    if (dive) cands.push({ how: 'dive', ...dive });
  }
  if (!cands.length) { const ic = interceptGround(path, home, react, top, tau); cands.push({ how: 'dive', forced: true, t: ic.t, at: ic.at }); }
  // 잡은 뒤 공이 1루에 닿는 때(1루수는 직접 밟거나 투수에게 토스하거나 오는 주자를 태그한다)
  const finish = (c) => {
    if (pos === '1루수') {
      if (c.how !== 'dive' && lane(c.at) < 2.5 && c.t + 0.3 <= runnerTimeAt(c.at, bats)) return { release: c.t, arrive: c.t + 0.3, to: 'tag' };   // 주자 길목에서 먼저 잡으면 오는 주자를 태그한다
      const gather = c.how === 'dive' ? 1.0 : EXCHANGE[pos], d = toB1(c.at), self = c.t + gather + sprintTime(Math.max(0, d - 0.5), top, tau);
      const flight = clamp(d / 12, 0.3, 0.6), toss = Math.max(FIELD_REACT.p + sprintTime(PCOVER_LEN, ...FIELD_SPEED.p), c.t + gather + flight + TOSS_STEP);
      if (self <= toss || d < 8) return { release: c.t + gather, arrive: self, to: 'self' };   // 베이스가 가까우면 직접 밟는다
      return { release: toss - TOSS_STEP - flight, arrive: toss, to: 'P' };
    }
    const ex = c.how === 'set' ? EXCHANGE[pos] : PLAY_EX[c.how], speed = THROW_SPEED[pos] * (c.how === 'set' ? 1 : PLAY_SPEED[c.how]);
    return { release: c.t + ex, arrive: c.t + ex + Math.max(0.15, (toB1(c.at) - 0.9) / speed), to: '1B' };
  };
  for (const c of cands) Object.assign(c, finish(c));
  const pick = cands.find((c) => c.how === 'set' && c.arrive <= runner - 0.3) ?? cands.reduce((a, b) => (b.arrive < a.arrive ? b : a));
  const margin = Math.round((runner - pick.arrive) * 1000) / 1000;   // 양수면 송구가 먼저(아웃). ms로 반올림해 기기마다 같게
  return { pos, how: pick.how, charge: !!pick.charge, field: { t: pick.t, at: pick.at }, release: { t: pick.release }, arrive: margin < -0.6 ? null : { t: pick.arrive, to: pick.to }, runner, margin, safe: margin <= 0 };
}
