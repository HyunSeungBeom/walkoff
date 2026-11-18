// 그리기 품질 단계 정하기(js/view/quality.js, 2026-11-17 느린 폰 자동 품질)를 브라우저 없이 본다.
// 장면 간격 느린 쪽 5%가 기준보다 길 때만 한 단계 낮추고, 낮춰도 간격이 줄지 않으면(아이폰 저전력 모드의 초당 30장면 고정 등) 되돌리고 그날은 다시 낮추지 않는다.
// 올리기는 열고 처음 정할 때만 한 단계이고, 올렸더니 느리면 되돌리고 그날은 다시 올리지 않는다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQuality, QUALITY, QUALITY_FAST_GAP, QUALITY_FAST_WORK, QUALITY_SLOW_GAP, QUALITY_TOP, qualitySlow, qualityStart, qualityStats, quantile } from '../../js/view/quality.js';

// 3초 동안 모은 장면: 간격 gap(ms)인 장면에 느린 장면 slow개(slowGap)를 섞는다. 일한 시간은 work
const frames = (gap, work = 3, slow = 0, slowGap = 50) => {
  const n = Math.round(3000 / gap), gaps = Array.from({ length: n }, (_, i) => (i < slow ? slowGap : gap));
  return qualityStats(gaps, gaps.map(() => work));
};
const DAY = '2026-11-17';
// 정하기를 차례로: 단계마다 그 단계에서 잰 요약을 주는 기기(at)로 n번
function run(s, at, n) {
  const levels = [];
  for (let k = 0; k < n; k++) { s = { ...s, ...nextQuality(s, at(s.level)) }; levels.push(s.level); }
  return { s, levels };
}

test('단계: 맨 위가 지금 그림(배율 2배, 번짐 있음)이고 내려갈수록 배율이 줄어든다', () => {
  assert.equal(QUALITY_TOP, QUALITY.length - 1);
  assert.deepEqual(QUALITY[QUALITY_TOP], { dpr: 2, glow: true });
  for (let l = 1; l <= QUALITY_TOP; l++) assert.ok(QUALITY[l - 1].dpr < QUALITY[l].dpr, `${l - 1}단계 배율이 ${l}단계보다 작다`);
});

test('빠른 기기(60·120Hz, 가끔 끊김)는 맨 위 그대로이고 바꿔 보지도 않는다', () => {
  for (const m of [frames(16.7), frames(8.3), frames(16.7, 2, 3, 50), frames(11.1, 1.5, 10, 33.4)]) {
    assert.equal(qualitySlow(m), false, JSON.stringify(m));
    assert.deepEqual(run(qualityStart(null, DAY), () => m, 5).levels, [2, 2, 2, 2, 2]);
  }
});

test('느린 기기: 낮춰서 간격이 줄면 그 단계에 머물고, 그래도 느리면 한 단계 더', () => {
  const sw4 = { 2: frames(40.9), 1: frames(17.5, 3, 5, 25), 0: frames(8.4) };   // 폰 CPU 4배 소프트웨어 그리기에서 잰 간격(가운데)
  assert.deepEqual(run(qualityStart(null, DAY), (l) => sw4[l], 4).levels, [1, 1, 1, 1]);
  const slower = { 2: frames(50), 1: frames(33.4), 0: frames(16.7) };
  const r = run(qualityStart(null, DAY), (l) => slower[l], 4);
  assert.deepEqual(r.levels, [1, 0, 0, 0], '33ms로 줄어도 아직 느리면 더 낮춘다');
  assert.equal(r.s.noDown, false);
});

test('낮춰도 그대로(초당 30장면 고정): 되돌리고 오늘은 다시 낮추지 않는다', () => {
  const capped = () => frames(33.4, 2);
  const r = run(qualityStart(null, DAY), capped, 5);
  assert.deepEqual(r.levels, [1, 2, 2, 2, 2]);
  assert.equal(r.s.noDown, true);
  assert.equal(nextQuality(qualityStart({ level: 2 }, DAY), capped()).level, 1, '적힌 막은 날이 없으면 다시 해 본다');
  assert.equal(nextQuality(qualityStart({ level: 2, noDown: DAY }, DAY), capped()).level, 2, '오늘 막았으면 그대로');
  assert.equal(nextQuality(qualityStart({ level: 2, noDown: '2026-11-16' }, DAY), capped()).level, 1, '어제 막은 것은 오늘 다시 해 본다');
});

test('올리기: 열고 처음 정할 때 빠르면 한 단계만, 올렸더니 느리면 되돌리고 오늘은 다시 올리지 않는다', () => {
  const fast = () => frames(16.7, 2);
  assert.ok(frames(16.7, 2).gap95 < QUALITY_FAST_GAP && 2 < QUALITY_FAST_WORK);
  assert.deepEqual(run(qualityStart({ level: 0 }, DAY), fast, 4).levels, [1, 1, 1, 1], '열 때마다 한 단계');
  assert.deepEqual(run(qualityStart({ level: 1 }, DAY), () => frames(16.7, 9), 2).levels, [1, 1], '일한 시간이 길면(CPU에 여유가 없으면) 올리지 않는다');
  assert.deepEqual(run(qualityStart({ level: 1 }, DAY), () => frames(22), 2).levels, [1, 1], '간격이 기준(낮추기)과 올리기 기준 사이면 그대로');
  const top = { 2: frames(40), 1: frames(16.7, 2), 0: frames(8.3, 1) };
  const r = run(qualityStart({ level: 1 }, DAY), (l) => top[l], 3);
  assert.deepEqual(r.levels, [2, 1, 1]);
  assert.equal(r.s.noUp, true);
  assert.equal(nextQuality(qualityStart({ level: 1, noUp: DAY }, DAY), fast()).level, 1, '오늘 막았으면 올려 보지 않는다');
});

test('가끔 느린 장면: 5% 아래는 버티고 그보다 많으면 낮춘다', () => {
  const n = Math.round(3000 / 16.7), allowed = n - Math.floor(n * 0.95) - 1;   // ?fps=1 화면의 95%와 같은 자리 값
  assert.equal(qualitySlow(frames(16.7, 3, allowed, 50)), false, `느린 장면 ${allowed}개`);
  assert.equal(qualitySlow(frames(16.7, 3, allowed + 1, 50)), true, `느린 장면 ${allowed + 1}개`);
  assert.equal(qualitySlow(frames(16.7, 3, 30, QUALITY_SLOW_GAP)), false, '기준과 같으면 느리지 않다');
});

test('적힌 값: 단계가 아니면 맨 위, 막은 날은 오늘 것만', () => {
  for (const v of [null, undefined, 1, '1', {}, { level: -1 }, { level: 3 }, { level: 1.5 }, { level: '1' }]) assert.equal(qualityStart(v, DAY).level, QUALITY_TOP, JSON.stringify(v));
  assert.deepEqual(qualityStart({ level: 0, noDown: DAY, noUp: '2026-11-01' }, DAY), { level: 0, first: true, trial: null, noDown: true, noUp: false });
});

test('느린 쪽 자리 값', () => {
  assert.equal(quantile([], 0.95), 0);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile(Array.from({ length: 100 }, (_, i) => i), 0.95), 95);
  assert.equal(quantile([5], 0.95), 5);
});
