// 칭호·업적(js/core/titles.js)과 전광판으로 낼 수 있는 점수 범위(js/core/score.js scoreRange)를 브라우저 없이 본다.
// 기대값은 규칙(연속은 볼이 안 끊음, 마지막 기회, 점수표)에서 손으로 낸 값이다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLES, TITLE_IDS, COUNT_KEYS, countsOf, addCounts, cleanCounts, titlesFor, topTitle } from '../../js/core/titles.js';
import { maxScoreFor, scoreRange } from '../../js/core/score.js';

// 가짜 공: 존 안 직구(기본), 존 밖(0.35m 옆), 구종만 바꾼 공
const P = (type = 'fastball', more = {}) => ({ type, kmh: 148, tx: 0, ty: 0.8, ...more });
const seqOf = (types) => types.map((t) => (typeof t === 'string' ? P(t) : t));

test('칭호: 한 판에서 쌓는 수(개수와 그 일이 일어난 판)를 내고, 연속은 골라낸 볼(Y)이 끊지 않으며 다른 결과는 끊는다', () => {
  const R = (n) => 'R'.repeat(n);
  assert.deepEqual(countsOf('H' + R(9)), { hr: 1, hit: 1, xbh: 1, firstHr: 1, g_out5: 1, g_choke: 1 });   // 아웃 9번 연속은 연속 아웃 5번·새가슴에도 든다
  assert.deepEqual(countsOf(R(9) + 'H'), { hr: 1, hit: 1, xbh: 1, lastHr: 1, lastHit: 1, g_out5: 1 });   // 남은 기회 1번(끝내기 찬스)
  assert.equal(countsOf(R(9) + 'YYH').lastHr, 1);                                             // 볼은 기회를 안 써서 그 뒤 공도 마지막 기회
  assert.equal(countsOf('HHYHHH' + R(5)).g_hr3run, 1);                                         // 볼을 사이에 둬도 연속 홈런
  assert.equal(countsOf('HHSHH' + R(5)).g_hr3run, undefined);                                  // 단타가 끊는다
  const c = countsOf('SDTH' + 'RRRRR' + 'S');
  assert.deepEqual([c.g_cycle, c.g_natural, c.g_out5, c.g_choke, c.hit, c.xbh, c.d2, c.t3], [1, 1, 1, undefined, 5, 3, 1, 1]);
  assert.equal(countsOf('HTDS' + R(6)).g_natural, undefined);                                  // 내추럴은 단타 → 2루타 → 3루타 → 홈런 순서
  assert.equal(countsOf('HTDS' + R(6)).g_cycle, 1);
  assert.deepEqual([countsOf('YYY' + 'S'.repeat(10)).g_ball3, countsOf('YYRY' + 'S'.repeat(9)).g_ball3], [1, undefined]);   // 볼 3개를 잇달아
  assert.equal(countsOf('H'.repeat(10)).g_hr10, 1);                                            // 야구의신
  assert.equal(countsOf('H'.repeat(9) + 'S').g_hr10, undefined);
  assert.deepEqual([countsOf('S'.repeat(10)).g_hit10, countsOf('S'.repeat(10)).g_singles], [1, 1]);
  assert.deepEqual([countsOf('HRHR' + R(6)).g_coaster, countsOf('HRRH' + R(6)).g_coaster], [1, undefined]);
  assert.deepEqual([countsOf(R(5) + 'SSSSR').g_late, countsOf('SSSSR' + R(5)).g_fade], [1, 1]);
  assert.deepEqual([countsOf('HH' + R(8)).g_boom, countsOf('HHS' + R(7)).g_boom], [1, undefined]);
  assert.deepEqual([countsOf(R(10)).g_zero, countsOf('YYYYY' + R(10)).g_watch], [1, 1]);
  assert.equal(countsOf(R(9)).g_zero, undefined);                                              // 기회를 다 쓰지 않은 판은 안 센다
  assert.equal(countsOf('S' + R(9), [], false, 5000).g_5k, 1);
  assert.equal(countsOf('S' + R(9), [], false, 4999).g_5k, undefined);
  // 예전 게임의 G(어떤 안타인지 모름)는 쌓지 않는다
  assert.deepEqual(countsOf('GGGGGGGGGG'), {});
  assert.deepEqual(countsOf(''), {});
});

test('칭호: 공 순서로 구종·존 밖 공·빠른 직구·좌완 판을 센다(볼과 아웃은 안 센다)', () => {
  const far = P('fastball', { tx: 0.35 }), fast = P('fastball', { kmh: 152 });
  const c = countsOf('YHHSDTSR' + 'RR', seqOf([far, 'curve', 'fork', 'slider', 'change', fast, 'curve', 'fork', 'fastball', 'fastball']), true);
  assert.deepEqual([c.curveHr, c.forkHr, c.breakHit, c.fbHr, c.fastHr, c.badHr, c.leftyHr], [1, 1, 5, undefined, undefined, undefined, 2]);
  assert.equal(c.g_five, 1);                                                                   // 커브·포크·슬라이더·체인지업·직구(152km 단타)
  const d = countsOf('HH' + 'R'.repeat(8), seqOf([far, fast]));
  assert.deepEqual([d.badHr, d.fbHr, d.fastHr, d.leftyHr, d.g_five], [1, 2, 1, undefined, undefined]);
});

test('칭호: 쌓인 수가 정한 수에 닿으면 받고, 대표 칭호는 등급 순서(⭐야구의신⭐이 맨 위)로 가장 높은 것 하나', () => {
  assert.equal(TITLES.length, 50);
  assert.equal(new Set(TITLE_IDS).size, 50);
  for (const t of TITLES) {
    assert.ok([...t.short].length >= 2 && [...t.short].length <= 4, `${t.id} 배지는 2~4글자`);
    assert.ok(COUNT_KEYS.includes(t.key) && Number.isInteger(t.need) && t.need >= 1, t.id);
  }
  const order = ['legend', 'rare', 'normal', 'fun'];
  assert.deepEqual(TITLES.map((t) => order.indexOf(t.tier)), TITLES.map((t) => order.indexOf(t.tier)).sort((a, b) => a - b));   // 등급 순서
  assert.equal(TITLES[0].id, 'god');
  assert.deepEqual(titlesFor({ hr: 1 }), ['firsthr']);
  assert.deepEqual(titlesFor({ hr: 999 }), ['firsthr']);
  assert.deepEqual(titlesFor({ hr: 1000 }), ['factory', 'firsthr']);                           // 홈런 공장장은 1,000개, 홈런왕은 2,000개
  assert.deepEqual(titlesFor({ hr: 2000, g_out5: 200 }), ['hrking', 'factory', 'firsthr', 'outking']);
  assert.deepEqual(titlesFor({ g_out5: 199 }), []);                                            // 아웃왕은 200판
  assert.deepEqual(titlesFor({}), []);
  assert.equal(topTitle(['outking', 'firsthr', 'god']), 'god');
  assert.equal(topTitle(['outking', 'firsthr']), 'firsthr');
  assert.equal(topTitle([]), null);
  assert.equal(topTitle(null), null);
  assert.deepEqual(addCounts({ hr: 3, x: 5, ball: -1 }, { hr: 2, ball: 1, g_hr2: 1 }), { hr: 5, ball: 1, g_hr2: 1 });   // 모르는 칸·음수는 버린다
  assert.deepEqual(cleanCounts('망가진 값'), {});
  // 판마다 쌓으면 한 판에 하나씩만 판 수가 오른다
  let total = {};
  for (let i = 0; i < 3; i++) total = addCounts(total, countsOf('HHRRRRRRRR'));
  assert.deepEqual([total.hr, total.g_hr2, total.g_b2b, total.firstHr], [6, 3, 3, 3]);
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
