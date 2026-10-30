// 공 순서(2026-10-30). 게임(index.html)의 makeSequence·pitcherHand·dailySeed와 같은 코드라 같은 시드면 같은 공이 나온다.
// 테스트(tests/walkoff.spec.js '랭킹 규칙')가 게임과 맞춰 보므로, 게임의 공 만드는 코드를 바꾸면 여기도 같이 바꾼다.
// 서버는 이걸로 그 판의 공 순서를 다시 만들어, 보낸 전광판이 실제로 나올 수 있는지와 낼 수 있는 최고 점수를 계산한다(rules.js)
export const SEQ_LEN = 40, CHANCES = 10;
export const ZONE = { left: -0.25, right: 0.25, bottom: 0.5, top: 1.1 };   // 공 반지름까지 넣은 스트라이크 존
export const REACH_M = 0.2;   // 존 밖으로 이만큼 넘게 빠지면 배트가 닿지 않음
export const POINTS = { hr: 1000, double: 500, single: 300, ball: 100 };
export const PERFECT_BONUS = 100;
// 연속 홈런 보너스(2026-10-30): 두 번째 연속은 +500, 세 번째부터 +1,000씩. 게임의 hrStreakBonus와 같아야 하고 테스트가 맞춰 본다
export const hrStreakBonus = (n) => (n >= 3 ? 1000 : n === 2 ? 500 : 0);

const PITCHES = { fastball: { kmh: [146, 153] }, slider: { kmh: [134, 140] }, curve: { kmh: [116, 124] }, change: { kmh: [125, 131] }, fork: { kmh: [132, 138] } };
const PITCH_MIX = { fastball: 3, slider: 2, curve: 1.5, change: 2, fork: 1.5 };
const lerp = (a, b, t) => a + (b - a) * t;
const flightTime = (kmh) => 112 / kmh;

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

function pickWeighted(rnd, weights) {
  const keys = Object.keys(weights);
  let r = rnd() * keys.reduce((s, k) => s + weights[k], 0);
  for (const k of keys) { r -= weights[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

// 공 하나. inZone 확률로 존 안에 넣고, 빠질 때는 구종마다 빠지는 쪽이 다르다(우투수 기준)
function makePitch(rnd, type, inZone, extra = {}) {
  const def = PITCHES[type];
  const kmh = Math.round(lerp(def.kmh[0], def.kmh[1], rnd()));
  let tx, ty;
  if (rnd() < inZone) {
    tx = lerp(-0.2, 0.2, rnd()); ty = lerp(0.58, 1.02, rnd());
  } else if (type === 'slider') {
    tx = lerp(0.33, 0.5, rnd()); ty = lerp(0.45, 0.95, rnd());
  } else if (type === 'fastball') {
    if (rnd() < 0.6) { tx = lerp(-0.2, 0.2, rnd()); ty = lerp(1.17, 1.32, rnd()); }
    else { tx = lerp(-0.5, -0.33, rnd()); ty = lerp(0.6, 1.0, rnd()); }
  } else {
    tx = lerp(-0.22, 0.22, rnd()); ty = lerp(0.2, 0.42, rnd());
  }
  return { type, kmh, tx: extra.lefty ? -tx : tx, ty, T: flightTime(kmh), ...extra };
}

// 1~2구는 직구, 3구부터 변화구를 섞는다. 같은 시드면 n번째 공은 누구에게나 같다
export function makeSequence(seed, lefty = false) {
  const rnd = mulberry32(seed);
  return Array.from({ length: SEQ_LEN }, (_, i) => {
    const type = i < 2 ? 'fastball' : i === 2 ? (rnd() < 0.5 ? 'fastball' : 'slider') : pickWeighted(rnd, PITCH_MIX);
    return makePitch(rnd, type, i < 3 ? 0.8 : 0.6, { n: i + 1, lefty });
  });
}

// 판마다 상대 투수의 손(좌완 35%). 공 순서와 다른 난수를 쓴다
export const pitcherHand = (seed) => (mulberry32((seed ^ 0x9e3779b9) >>> 0)() < 0.35 ? 'L' : 'R');

// 오늘의 10구 시드: 한국 시간 날짜로 정해서 같은 날에는 누구나 같은 공을 친다
export function dailySeed(date) {
  let h = 2166136261;
  for (const ch of 'walkoff-' + date) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}

// 존에서 빠진 거리(m). 0이면 존 안
export function zoneMiss(p) {
  return Math.max(ZONE.left - p.tx, p.tx - ZONE.right, ZONE.bottom - p.ty, p.ty - ZONE.top, 0);
}
