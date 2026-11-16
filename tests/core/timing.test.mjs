// 10구 끝 화면의 타이밍 습관(js/view/text.js timingOf·timingText·addTiming·suggestCalib)을 브라우저 없이 본다(2026-11-12).
// 판 결과는 게임과 같이 core judgeSwing·judgeTake로 만든다(시드 42 공 순서). 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing, judgeTake, PERFECT_MS } from '../../js/core/judge.js';
import { makeSequence } from '../../js/core/pitches.js';
import { addTiming, suggestCalib, timingOf, timingText, TIMING } from '../../js/view/text.js';

const seq = makeSequence(42, false);
// 공마다 휘두른 때(ms, 보정 뺀 값). null은 지켜본 공
const play = (dts) => dts.map((dt, i) => (dt == null ? judgeTake(seq[i]) : judgeSwing(seq[i], dt, 'R')));

test('타이밍 습관: 휘두른 공의 가운데값이고, 지켜본 공과 300ms 넘게 벗어난 헛스윙은 빼며, 3번 아래면 없다', () => {
  assert.equal(timingOf(play([40, null, 55, -420, 30])), 40);           // 지켜본 공·크게 빠른 헛스윙을 빼면 30·40·55
  assert.equal(play([-420])[0].kind, 'whiff');
  assert.equal(timingOf(play([40, 55, null, null])), null);             // 휘두른 공이 둘뿐
  assert.equal(timingOf(play([40, 500, 55])), null);                    // 크게 늦은 헛스윙을 빼면 둘
  assert.equal(timingOf(play([200, 40, 50])), 50);                      // 300ms 안의 헛스윙(늦게 휘두름)은 넣는다
  assert.equal(play([200])[0].kind, 'whiff');
  assert.equal(timingOf(play([10, 20, 31, 40])), 26);                   // 짝수면 가운데 둘의 평균을 반올림
  assert.equal(timingOf(play([-60, -45, -50, null, -70])), -55);
  assert.equal(timingOf([]), null);
});

test('타이밍 습관 글: 15ms(정타) 안이면 잘 맞았다, 밖이면 보통 몇 ms 늦게·빠르게', () => {
  assert.equal(PERFECT_MS, 15);
  assert.deepEqual([0, 15, -15].map(timingText), ['타이밍 잘 맞았어요', '타이밍 잘 맞았어요', '타이밍 잘 맞았어요']);
  assert.equal(timingText(16), '보통 16ms 늦게 쳤어요');
  assert.equal(timingText(-40), '보통 40ms 빠르게 쳤어요');
});

test('타이밍 기록: 최근 5판만 남기고, 저장소 값이 망가졌으면 새로 시작한다', () => {
  assert.equal(TIMING.keep, 5);
  assert.deepEqual(addTiming([1, 2, 3, 4, 5], 6), [2, 3, 4, 5, 6]);
  assert.deepEqual(addTiming([10, 'x', null, 20], 30), [10, 20, 30]);
  for (const bad of [null, undefined, '{}', { a: 1 }, 7]) assert.deepEqual(addTiming(bad, 42), [42]);
});

test('타이밍 보정 권하기: 최근 3판이 모두 같은 쪽으로 40ms를 넘을 때만', () => {
  assert.equal(suggestCalib([50, 45, 41]), true);
  assert.equal(suggestCalib([-50, -60, -41]), true);
  assert.equal(suggestCalib([50, 45, 40]), false);                      // 40ms는 넘지 않았다
  assert.equal(suggestCalib([50, -50, 60]), false);                     // 쪽이 다르다
  assert.equal(suggestCalib([50, 60]), false);                          // 아직 두 판
  assert.equal(suggestCalib([-90, 50, 45, 41]), true);                  // 최근 3판만 본다
  assert.equal(suggestCalib([50, 45, 41, -90]), false);
  assert.equal(suggestCalib([]), false);
});
