// 그리기 품질 단계(2026-11-17 느린 폰 자동 품질, 작업 글 ~/.claude/plans/walkoff-quality.md). 기기가 치기 전 장면(시작 화면·와인드업)을
// 3초쯤 스스로 재서 느릴 때만 한 단계 낮춘다. 단추는 두지 않는다(사용자 '버튼이 많으면 나쁘다'). 맨 위 단계가 지금 그림 그대로라
// 빠른 기기(PC, 최근 아이폰)는 바뀌지 않는다. 판정·공 길·수비 계산은 단계와 상관없고 그리기만 바뀐다.
// 느림은 장면 간격(rAF 사이)으로 본다. 폰 CPU 4배(소프트웨어 그리기)에서 update + render는 4ms인데 화면은 초당 24장면이었다.
// 화소를 칠하는 일이 그 바깥에서 들기 때문이고, 그리기 배율 2 → 1.5 → 1에 장면 간격이 41 → 17 → 8ms로 줄었다(얼굴·자세함·조명·잔디 무늬는 거의 그대로).
// 아이폰 저전력 모드는 초당 30장면으로 묶여서(WebKit 215745) 간격만 보면 느린 기기와 같아 보인다. 그래서 낮춰 본 뒤 간격이 줄지 않으면
// 되돌리고 그날은 다시 낮춰 보지 않는다. 올려 본 뒤 느려지면 되돌리고 그날은 다시 올려 보지 않는다(열 때마다 오르내리지 않게).
// 기준은 첫 안이다. 실제 폰에서 ?fps=1로 잰 숫자를 보고 맞춘다

// dpr: 그리기 배율 상한, glow: 글자·단추·불의 번짐 그림자(shadowBlur, 폰·사파리에서 무겁다)
export const QUALITY = [
  { dpr: 1, glow: false },   // 0
  { dpr: 1.5, glow: true },  // 1
  { dpr: 2, glow: true },    // 2: 지금 그대로
];
export const QUALITY_TOP = QUALITY.length - 1;
export const QUALITY_WINDOW_MS = 3000;   // 한 번 정할 때 모으는 치기 전 장면 시간
export const QUALITY_MIN_FRAMES = 60;    // 그리고 적어도 이만큼 모은다(초당 20장면이면 3초)
export const QUALITY_SLOW_GAP = 28;      // 장면 간격 느린 쪽 5%가 이것보다 길면 느리다(60Hz 화면에서 한 장면을 건너뛰면 33ms)
export const QUALITY_FAST_GAP = 20;      // 올려 볼 때: 장면 간격 느린 쪽 5%가 이것보다 짧고(건너뛴 장면이 5% 아래)
export const QUALITY_FAST_WORK = 8;      // 한 장면 일한 시간(update + render) 느린 쪽 5%도 이것보다 짧다
export const QUALITY_BETTER = 0.85;      // 낮춘 뒤 장면 간격(가운데나 느린 쪽 5%)이 이만큼으로 줄어야 낮춘 보람이 있다

// 느린 쪽 p(0~1) 자리 값(작은 것부터 늘어놓은 자리 floor(p × 개수), ?fps=1 화면과 같다)
export function quantile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
// 모은 장면들(장면 간격 gaps, 일한 시간 works, ms)의 요약
export const qualityStats = (gaps, works) => ({ gapMid: quantile(gaps, 0.5), gap95: quantile(gaps, 0.95), work95: quantile(works, 0.95) });
export const qualitySlow = (m) => m.gap95 > QUALITY_SLOW_GAP;
const fast = (m) => m.gap95 < QUALITY_FAST_GAP && m.work95 < QUALITY_FAST_WORK;
const better = (m, before) => m.gapMid <= before.gapMid * QUALITY_BETTER || m.gap95 <= before.gap95 * QUALITY_BETTER;

// 이 기기에 적힌 값({ level, noDown, noUp }, 막은 날 'YYYY-MM-DD')에서 오늘의 시작 상태. 값이 아니면 맨 위 단계
export function qualityStart(saved, day) {
  const level = Number.isInteger(saved?.level) && saved.level >= 0 && saved.level <= QUALITY_TOP ? saved.level : QUALITY_TOP;
  return { level, first: true, trial: null, noDown: saved?.noDown === day, noUp: saved?.noUp === day };
}

// 한 번 정하기. s: qualityStart로 시작한 상태(trial은 지난번에 바꿔 본 것 { dir, from, before }), m: 이번에 모은 요약(qualityStats).
// 새 상태를 돌려준다. failed는 되돌린 쪽(down·up)이고, 그 쪽은 오늘 다시 해 보지 않는다(noDown·noUp)
export function nextQuality(s, m) {
  const out = { level: s.level, first: false, trial: null, noDown: s.noDown, noUp: s.noUp, failed: null }, t = s.trial;
  if (t?.dir === 'down' && qualitySlow(m) && !better(m, t.before)) return { ...out, level: t.from, noDown: true, failed: 'down' };   // 낮춰도 그대로(저전력 모드 등)
  if (t?.dir === 'up' && qualitySlow(m)) return { ...out, level: t.from, noUp: true, failed: 'up' };   // 올렸더니 느리다
  if (qualitySlow(m) && s.level > 0 && !s.noDown) return { ...out, level: s.level - 1, trial: { dir: 'down', from: s.level, before: m } };
  if (s.first && fast(m) && s.level < QUALITY_TOP && !s.noUp) return { ...out, level: s.level + 1, trial: { dir: 'up', from: s.level } };
  return out;
}
