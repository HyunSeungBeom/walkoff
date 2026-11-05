// 칭호·업적(js/core/titles.js)과 전광판으로 낼 수 있는 점수 범위(js/core/score.js scoreRange)를 브라우저 없이 본다.
// 기대값은 규칙(연속은 볼이 안 끊음, 마지막 기회, 점수표)에서 손으로 낸 값이다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLES, titlesOf, topTitle } from '../../js/core/titles.js';
import { maxScoreFor, scoreRange } from '../../js/core/score.js';

test('칭호: 한 판의 전광판으로 정하고, 연속은 골라낸 볼(Y)이 끊지 않으며 다른 결과는 끊는다', () => {
  const R9 = 'R'.repeat(9);
  assert.deepEqual(titlesOf('SDTH' + 'RRRR' + 'SS'), ['cycle', 'firsthr']);                   // 단타·2루타·3루타·홈런(아웃은 4번 연속이라 아웃왕은 아니다)
  assert.ok(titlesOf('HHYHHH' + 'R'.repeat(5)).includes('hrking'));                         // 볼을 사이에 둬도 연속 홈런 5번
  assert.ok(!titlesOf('HHHHSH' + 'R'.repeat(4)).includes('hrking'));                         // 단타가 끊어 가장 긴 연속은 4번
  assert.ok(titlesOf(R9 + 'H').includes('walkoff'));                                          // 남은 기회 1번(끝내기 찬스)에 홈런
  assert.ok(titlesOf(R9 + 'YYH').includes('walkoff'));                                        // 볼은 기회를 안 써서 그 뒤 공도 끝내기 찬스
  assert.ok(!titlesOf('H' + R9).includes('walkoff'));                                         // 첫 공 홈런은 끝내기가 아니다
  assert.deepEqual(titlesOf('YYYYY' + 'S'.repeat(10)), ['eye']);                              // 볼 5개
  assert.ok(!titlesOf('YYYY' + 'S'.repeat(10)).includes('eye'));
  assert.deepEqual(titlesOf('RRYRRR' + 'SSSS'), ['outking']);                                // 볼을 사이에 둬도 연속 아웃 5번
  assert.ok(!titlesOf('RRRRSR' + 'SSSS').includes('outking'));
  assert.deepEqual(titlesOf('S'.repeat(10)), []);
  // 예전 게임의 G(어떤 안타인지 모름)로는 안타 종류가 드는 칭호를 못 받는다
  assert.deepEqual(titlesOf('GGGGGGGGGG'), []);
  assert.deepEqual(titlesOf('YYYYY' + 'RRRRR' + 'GGGGG'), ['eye', 'outking']);
});

test('대표 칭호는 목록 순서(사이클링 > 홈런왕 > 끝내기 홈런 > 선구안 > 첫 홈런 > 아웃왕)로 가장 높은 것 하나', () => {
  assert.deepEqual(TITLES.map((t) => t.id), ['cycle', 'hrking', 'walkoff', 'eye', 'firsthr', 'outking']);
  assert.equal(topTitle(['outking', 'firsthr']), 'firsthr');
  assert.equal(topTitle(['eye', 'cycle']), 'cycle');
  assert.equal(topTitle([]), null);
  assert.equal(topTitle(null), null);
  for (const t of TITLES) assert.ok([...t.short].length >= 2 && [...t.short].length <= 4, `${t.id} 배지는 2~4글자`);
});

test('점수 범위(서버 점수 검사): 안타 종류를 알면 결과 점수·연속 보너스(큰 쪽)·끝내기 찬스 2배가 정해지고, 모르는 것은 존 안 공 안타의 정타 +100뿐이다', () => {
  // 가짜 공: 존 안, 존 밖이지만 배트가 닿음(0.10m 빠짐), 닿지 않음(0.25m 빠짐). 나머지는 존 안
  const IN = { tx: 0, ty: 0.8 }, NEAR = { tx: 0.35, ty: 0.8 }, FAR = { tx: 0.5, ty: 0.8 };
  const seq = (...head) => [...head, ...Array(40).fill(IN)].slice(0, 40), R = (n) => 'R'.repeat(n);
  assert.deepEqual(scoreRange('H' + R(9), seq()), { min: 1000, max: 1100 });                 // 홈런 1,000 + 정타면 100
  assert.deepEqual(scoreRange(R(9) + 'H', seq()), { min: 2000, max: 2200 });                 // 남은 기회 1번(끝내기 찬스)은 2배
  assert.deepEqual(scoreRange('HH' + R(8), seq()), { min: 2500, max: 2700 });                // 둘째 연속 홈런 +500(연속 안타 +300보다 크다)
  assert.deepEqual(scoreRange('HYH' + R(8), seq(IN, FAR)), { min: 2600, max: 2800 });         // 볼은 연속을 끊지 않고 100점
  assert.deepEqual(scoreRange('SD' + R(8), seq()), { min: 1100, max: 1300 });                // 단타 300 + 2루타 500 + 연속 안타 300
  assert.deepEqual(scoreRange('SD' + R(8), seq(NEAR)), { min: 1100, max: 1200 });            // 존 밖 공의 안타는 정타가 될 수 없다
  assert.deepEqual(scoreRange('SRS' + R(7), seq()), { min: 600, max: 800 });                 // 아웃이 연속 안타를 끊는다
  assert.deepEqual(scoreRange(R(9) + 'YR', seq(...Array(9).fill(IN), FAR)), { min: 200, max: 200 });   // 끝내기 찬스의 볼도 2배
  assert.equal(scoreRange('Y' + R(10), seq(IN)), null);       // 존 안 공은 볼이 될 수 없다
  assert.equal(scoreRange('H' + R(9), seq(FAR)), null);       // 배트가 닿지 않는 공은 안타가 될 수 없다
  assert.equal(scoreRange('H' + R(8), seq()), null);          // 기회가 남았는데 끝난 판
  assert.equal(scoreRange(R(10) + 'R', seq()), null);         // 기회를 다 쓴 뒤의 공
  // 예전 게임의 G는 하한 없이 지금까지의 상한만 본다
  assert.deepEqual(scoreRange('G' + R(9), seq()), { min: 0, max: maxScoreFor('G' + R(9), seq()) });
});
