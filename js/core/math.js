// 계산 도구: 자르기·섞기·각도, 시드 난수(mulberry32)와 가중치 뽑기.
// core/는 판정 규칙이다. 화면·저장소·시간·무작위(Math.random)를 모르는 순수한 계산이라 게임·분석 스크립트·서버가 같이 쓴다(scripts/layers.js가 본다)

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
export const DEG = Math.PI / 180;

// 마당 좌표(m): x는 1루 쪽(+), z는 홈에서 투수 쪽(+). a는 홈에서 본 각도(도, 음수가 3루 쪽)
export const polar = (a, d) => [d * Math.sin(a * DEG), d * Math.cos(a * DEG)];

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
