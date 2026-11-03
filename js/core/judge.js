// 스윙·볼 판정과 타구 분류. 무작위 없이 타이밍·공 위치·구종으로 계산하고 결과 코드만 돌려준다: 종류(kind)·타구 종류(type)·
// 타구 속도·발사각·방향·비거리, 잡은 수비수(fielder)·빠져나간 곳(gap)·담장(wall)·정타라 수비 사이로(split)·1루 경주(race)·내야 안타(infield).
// 결과 이름('좌중간 2루타')과 이유 문장은 view/text.js가 붙인다(2026-11-03 코드 나누기 2단계)
import { clamp, lerp } from './math.js';
import { fenceDist, INFIELDERS, nearest, OUTFIELDERS } from './field.js';
import { PITCHES, REACH_M, zoneMiss } from './pitches.js';
import { POINTS } from './score.js';
import { computeRace, groundPath } from './race.js';

export const FAIR_MS = 90;      // 타이밍 차이가 이 안이면 앞으로 가는 타구
export const FOUL_MS = 140;     // 이 안이면 파울, 넘으면 헛스윙
export const PERFECT_MS = 15;   // 정타

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

// 스윙 판정. dt는 스윙 시각 - 공 도착 시각(ms), 음수면 빠름. 무작위 없이 계산한다
export function judgeSwing(p, dt, bats = 'R') {
  const def = PITCHES[p.type];
  const miss = zoneMiss(p);
  const adt = Math.abs(dt);
  const r = { kind: 'whiff', hit: false, points: 0, dt, ev: 0, la: 0, spray: 0, dist: 0, perfect: false, bats };

  if (miss > REACH_M) return r;   // 배트가 닿지 않는 공
  if (adt > FOUL_MS) return r;    // 너무 빠르거나 늦게 휘둘렀다

  const tq = 1 - Math.pow(Math.min(adt, FAIR_MS) / FAIR_MS, 1.6);
  const reach = 1 - miss / REACH_M;
  const q = tq * (0.35 + 0.65 * reach);
  r.ev = Math.round(75 + 100 * Math.pow(q, 1.2) + (p.kmh - 135) * 0.25);
  // 높은 공은 뜨고, 빠르면 덮어 친다. 커브·체인지업·포크는 잘 맞힐수록(tq의 세제곱) lift만큼 덜 깔린다(2026-11-03 유저 목소리 '포크·체인지업은 홈런이 안 나온다', 커브는 사용자 결정.
  // 전에는 정타여도 포크 홈런 0%, 체인지업 4%, 커브 3%였다. 세제곱이라 빗맞은 포크는 그대로 땅볼이 많다(45% → 38%))
  // 빨리 쳐도 세게 맞은 공은 덜 덮어 친다(타구 속도 140→160km/h에 걸쳐 1ms에 0.2도 → 0.05도). 전에는 빨리 칠수록 깔려서 당겨 친 뜬공·홈런이 거의 없었다
  // (2026-11-03 유저 목소리 '당겨 치는·밀어 치는 홈런이 없다'). 약하게 빨리 친 공은 그대로 땅볼이 되어 1루 승부·내야 안타는 그대로다(모두 덜 깔리게 하면 땅볼이 13% → 9%)
  r.la = Math.round(24 + (p.ty - 0.8) * 40 + def.la + (def.lift ?? 0) * tq * tq * tq + dt * (dt < 0 ? lerp(0.2, 0.05, clamp((r.ev - 140) / 20, 0, 1)) : 0.2));
  // 빠르면 당겨치고 늦으면 밀어친다. 당기는 쪽이 우타는 3루 쪽(음수), 좌타는 1루 쪽(양수).
  // 세게 뜬 공(타구 속도 140→160km/h, 발사각 18→26도에 걸쳐 섞는다)은 좌·우익수 쪽까지 넓게 가고(당긴 쪽이 더 넓다) ±44도 안에서 부드럽게 멈춘다.
  // 전에는 홈런의 94%가 가운데 ±15도로 가고 좌·우익수 쪽 홈런은 0%였다(2026-11-03 유저 목소리). 땅볼·약한 타구는 그대로라 수비 사이로 빠지는 안타는 그대로다
  const side = bats === 'L' ? -1 : 1;
  const narrow = side * dt / FAIR_MS * 42 + p.tx * 40, wide = 44 * Math.tanh((side * dt / FAIR_MS * (dt < 0 ? 85 : 70) + p.tx * 60) / 44);
  r.spray = Math.round(lerp(narrow, wide, clamp((r.ev - 140) / 20, 0, 1) * clamp((r.la - 18) / 8, 0, 1)));

  if (adt > FAIR_MS) {
    r.kind = 'foul'; r.type = 'foul';
    r.ev = Math.round(95 + (FOUL_MS - adt) * 0.8);
    r.la = clamp(r.la, -5, 55);
    r.spray = side * Math.sign(dt) * Math.round(48 + (adt - FAIR_MS) * 0.4);
    r.dist = Math.max(20, carry(r.ev, Math.max(r.la, 15)));
    return r;
  }

  r.perfect = adt <= PERFECT_MS && miss === 0;
  r.dist = carry(r.ev, r.la);
  classify(r);
  if (r.perfect && r.kind === 'out') throughGap(r);
  if (r.kind === 'out' && r.type === 'ground') settleAtFirst(r, bats);   // 1루 경주: 늦으면 내야 안타
  return r;
}

// 정타는 아웃이 되지 않는다(2026-10-30 사용자 결정, 사용자 목소리 '정타를 쳤는데 아웃'). 정타는 타이밍이 맞아 가운데로 가는데
// 가운데에는 중견수가 있고 담장도 가장 멀어서, 존 안 정타의 28%가 중견수 직선타·담장 앞 뜬공으로 잡혔다(같은 공을 30ms 늦게 치면 2루타였다).
// 잡힐 정타만 가장 가까운 수비 빈틈으로 보내 다시 판정한다. 빈틈은 수비 위치의 가운데: 땅볼은 3유간·투수 옆·1·2루간, 뜬 타구는 좌중간·우중간
export const between = (list) => list.slice(1).map((f, i) => (list[i].a + f.a) / 2);
export const GAPS = { ground: between(INFIELDERS.slice(0, 4)), air: between(OUTFIELDERS) };
export function throughGap(r) {
  const gaps = r.type === 'ground' ? GAPS.ground : GAPS.air;
  r.spray = gaps.reduce((best, g) => (Math.abs(g - r.spray) < Math.abs(best - r.spray) ? g : best));
  Object.assign(r, { dist: carry(r.ev, r.la), fielder: undefined, gap: undefined, wall: undefined, split: true });
  classify(r);
}

// 앞으로 간 타구를 타구 속도(ev)·발사각(la)·방향(spray)·비거리(dist)와 수비 위치로 나눈다. 이름은 view/text.js(resultName)
export function classify(r) {
  const s = r.spray, ev = r.ev, la = r.la;
  const single = () => { r.kind = 'single'; r.hit = true; };
  const double = () => { r.kind = 'double'; r.hit = true; };
  // 3루타(2026-11-03 사용자 결정): 담장을 맞은 2루타 가운데 가장 가까운 외야수에게서 12도 넘게 먼 공(좋은 타구의 3%쯤). 800점
  const triple = () => { r.kind = 'triple'; r.hit = true; };
  const homeRun = () => { r.kind = 'hr'; r.hit = true; };
  const outBy = (f) => { r.kind = 'out'; r.fielder = f; };
  const infield4 = INFIELDERS.slice(0, 4);

  if (la < 8) {
    r.type = 'ground';
    const fielders = ev < 110 ? INFIELDERS : infield4;          // 느린 땅볼은 투수도 잡는다
    const cover = 7 + 8 * clamp((150 - ev) / 60, 0, 1);         // 느릴수록 수비가 따라간다
    const f = nearest(fielders, s);
    if (Math.abs(f.a - s) <= cover || ev < 85) { outBy(f); r.dist = f.d; }
    else if (Math.abs(s) > 33 && ev >= 140) { double(); r.dist = 78; }
    else { single(); r.dist = 62; r.gap = s < -13 ? '3유간' : s > 13 ? '1·2루간' : '투수 옆'; }
  } else if (la < 22) {
    r.type = 'line';
    const fi = nearest(infield4, s), fo = nearest(OUTFIELDERS, s);
    if (r.dist < 28) { if (Math.abs(fi.a - s) <= 7) outBy(fi); else single(); }
    else if (r.dist >= fenceDist(s)) homeRun();
    else if (Math.abs(fo.a - s) <= 7 && r.dist > 55 && r.dist < 98) outBy(fo);
    else if (r.dist >= 82) double();
    else single();
  } else if (la < 50) {
    r.type = 'fly';
    const fence = fenceDist(s), fo = nearest(OUTFIELDERS, s);
    if (r.dist >= fence) homeRun();
    else if (r.dist >= fence - 6) { if (Math.abs(fo.a - s) > 12) triple(); else double(); r.wall = true; }
    else if (r.dist < 38) outBy(nearest(infield4, s));
    else if (r.dist < 58) single();                                // 내야와 외야 사이에 떨어진다
    else if (Math.abs(fo.a - s) > 10 && r.dist >= 80) double();    // 외야수 사이를 가른다
    else outBy(fo);
  } else {
    r.type = 'pop';
    outBy(nearest(infield4, s));
    r.dist = Math.min(r.dist, 30);
  }
  r.points = POINTS[r.kind] || 0;
}

// 홈런은 정점을 지나 내려올 때 덜 떨어져 끝에서 쭉 뻗는다(2026-11-03 사용자 '홈런이 마지막에 쭉쭉 뻗어 가는 느낌'). 타구 속도 159 → 180km/h에 따라
// k 0 → 1, 내려오는 시간은 1/√(1 − 0.4k)배(최대 1.29배)이고 그동안 4 + 16k m 더 가서 관중석 깊이 꽂힌다. 홈런이 되는지(dist ≥ 담장)와 점수는 그대로다
export const hrLiftK = (ev) => clamp((ev - 159) / 21, 0, 1);
export const hrExtra = (ev) => 4 + 16 * hrLiftK(ev);

// 공을 그냥 보냈을 때: 존 안이면 루킹 스트라이크, 밖이면 볼(선구안 보너스)
export function judgeTake(p) {
  return zoneMiss(p) === 0 ? { kind: 'strike', points: 0, took: true } : { kind: 'ball', points: POINTS.ball, took: true };
}

// 땅볼 아웃을 1루 경주(race.js computeRace)로 다시 정한다. 주자가 먼저 1루를 밟으면 내야 안타(300점)
export function settleAtFirst(r, bats) {
  const path = groundPath(r);
  // 홈 12m 안에서 멈추는 빗맞은 공은 투수가 달려 나와 잡는다(실제로는 포수·투수 공이다. 3루수가 25m를 달려와 잡으면 늘 내야 안타였다)
  if (path.dist(path.tStop) < 12 && r.fielder.pos !== '투수') r.fielder = INFIELDERS.find((x) => x.pos === '투수');
  const race = computeRace(r, bats);
  r.race = race;
  if (race.safe) Object.assign(r, { kind: 'single', hit: true, infield: true, points: POINTS.single });
}
