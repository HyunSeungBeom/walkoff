// 구종과 공 순서: 구종의 물리(빠르기·휘는 양), 공 만들기, 판마다 공 순서·투수 손·날짜 시드, 존에서 빠진 거리.
// 랭킹 서버도 같은 공 순서로 점수를 검사한다(서버 worker/src/pitches.js에 아직 복사본이 있고 tests/core가 같은지 본다). 바꾸면 서버도 다시 배포한다
import { lerp, mulberry32, pickWeighted } from './math.js';
import { RELEASE, ZONE } from './field.js';

export const REACH_M = 0.2;     // 존 밖으로 이만큼 넘게 빠지면 배트가 닿지 않음

// 구종: 빠르기(km/h), 휘는 양(m, 우투수 기준), 끝에서 휘는 정도(late), 발사각 보정(la), 잘 맞히면 덜 깔리는 정도(lift). 이름·색은 view/text.js
export const PITCHES = {
  fastball: { kmh: [146, 153], brk: { x: 0.02, y: 0.06 },  late: 2.0, la: 4 },
  slider:   { kmh: [134, 140], brk: { x: 0.32, y: -0.08 }, late: 2.6, la: -3 },
  curve:    { kmh: [116, 124], brk: { x: 0.16, y: -0.55 }, late: 2.0, la: -6, lift: 6 },
  change:   { kmh: [125, 131], brk: { x: -0.14, y: -0.24 }, late: 2.2, la: -7, lift: 6 },
  fork:     { kmh: [132, 138], brk: { x: 0.0, y: -0.5 },   late: 3.0, la: -14, lift: 9 },
};

// 실제 150km 직구는 0.4초 남짓이지만 게임에서는 0.75초쯤으로 늦춘다
export const flightTime = (kmh) => 112 / kmh;

// 투구 순서는 40개를 미리 만든다. 볼이 30개 넘게 나올 일은 사실상 없고, 다 쓰면 판을 끝낸다
export const SEQ_LEN = 40;

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
// 오늘의 10구 시드: 한국 시간 날짜로 정해서 같은 날에는 누구나 같은 공을 친다. 오늘의 10구는 2026-10-30에 없앴고, 서버가 그날까지 친 판을 검사할 때만 쓴다
export function dailySeed(date) {
  let h = 2166136261;
  for (const ch of 'walkoff-' + date) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}

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
// 판정은 그대로 두고, '걸쳐 보였는데 볼' 같은 공이 실제로 얼마나 빠졌는지 숫자로 알려 준다(2026-10-30). side는 low·high·in(몸쪽)·out(바깥쪽), 글은 view/text.js
export function zoneOff(p, bats) {
  const sides = [['low', ZONE.bottom - p.ty], ['high', p.ty - ZONE.top], [bats === 'L' ? 'out' : 'in', ZONE.left - p.tx], [bats === 'L' ? 'in' : 'out', p.tx - ZONE.right]];
  const [side, m] = sides.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { side, cm: Math.max(1, Math.round(m * 100)) };
}
