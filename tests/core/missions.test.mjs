// 오늘의 미션(js/core/missions.js)을 브라우저 없이 본다: 날짜로 고르는 세 개, 한 판에서 세는 수, 그날 진행과 보상.
// 기대값은 규칙(칸마다 하나, 볼은 기회를 안 써서 연속을 안 끊음, 10번째 기회가 끝내기 찬스, 화면 비거리)에서 손으로 낸 값이다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MISSIONS, TIER_COINS, ALL_BONUS, MAIN_PITCH, LONG_HR_M, missionsOn, gameFacts, missionGain, advanceMissions, cleanMissionState } from '../../js/core/missions.js';
import { styleOn } from '../../js/core/pitches.js';

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const days = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
const familyOf = (id) => MISSIONS.find((m) => m.id === id).family;

// 가짜 공과 결과: 공은 구종만, 결과는 판정이 내는 칸(kind·hit·perfect·spray·bats, 홈런은 화면 비거리 carry)만 둔다
const P = (type = 'fastball') => ({ type, kmh: 148, tx: 0, ty: 0.8 });
const out = { kind: 'out', hit: false, perfect: false, spray: 0, bats: 'R' };
const ball = { kind: 'ball', took: true };
const single = (more = {}) => ({ kind: 'single', hit: true, perfect: false, spray: 0, bats: 'R', ...more });
const hr = (carry, more = {}) => ({ kind: 'hr', hit: true, perfect: false, spray: 0, bats: 'R', carry, ...more });
const facts = (rows, score = 0) => gameFacts(rows.map(([r]) => r), rows.map(([, p]) => p ?? P()), score);

test('미션 고르기: 같은 날이면 같은 세 개이고, 쉬움·보통·어려움 칸에서 하나씩이다', () => {
  assert.deepEqual(missionsOn('2026-11-23'), missionsOn('2026-11-23'));
  for (const day of days('2026-11-23', 60)) assert.deepEqual(missionsOn(day).map((m) => m.tier), [0, 1, 2], day);
  assert.equal(MISSIONS.length, 15);
  for (const tier of [0, 1, 2]) assert.equal(MISSIONS.filter((m) => m.tier === tier).length, 5);
});

test('미션 고르기: 칸마다 같은 미션이 이틀 잇달아 나오지 않고, 닷새 묶음마다 다섯 개가 한 번씩 나오며, 같은 날 세 개는 무리가 다르다', () => {
  const list = days('2026-11-01', 365 * 10);   // 10년
  list.forEach((day, i) => {
    const today = missionsOn(day);
    assert.equal(new Set(today.map((m) => m.family)).size, 3, `${day} ${today.map((m) => m.id)}`);
    if (i) missionsOn(list[i - 1]).forEach((m, t) => assert.notEqual(m.id, today[t].id, `${day} 칸 ${t}`));
  });
  // 닷새 묶음은 1970-01-01부터 센 날 수를 5로 나눈 몫이다. 2026-11-23이 묶음 첫날(20,780일)
  for (let c = 0; c < 40; c++) {
    const cycle = days(addDays('2026-11-23', c * 5), 5).map(missionsOn);
    for (const tier of [0, 1, 2]) assert.equal(new Set(cycle.map((d) => d[tier].id)).size, 5, `묶음 ${c} 칸 ${tier}`);
  }
});

test('미션 고르기: 주무기 미션은 그 주 투수 유형의 구종과 목표를 쓴다', () => {
  assert.deepEqual(MAIN_PITCH, { classic: { pitch: 'slider', need: 3 }, power: { pitch: 'fastball', need: 8 }, finesse: { pitch: 'change', need: 3 }, forkball: { pitch: 'fork', need: 4 } });
  let seen = 0;
  for (const day of days('2026-11-23', 56)) {
    const main = missionsOn(day).find((m) => m.id === 'main');
    if (!main) continue;
    seen += 1;
    assert.deepEqual({ pitch: main.pitch, need: main.need }, MAIN_PITCH[styleOn(day)], day);
  }
  assert.ok(seen >= 10);   // 56일이면 닷새에 한 번 나온다
});

test('한 판에서 세는 수: 안타·정타·볼·밀어 친 안타·홈런·구종별 안타·변화구 홈런·화면 비거리 홈런', () => {
  const f = facts([
    [single({ perfect: true, spray: 20 }), P('slider')],   // 우타가 1루 쪽(+)으로: 밀어 친 안타
    [ball],
    [single({ spray: -20 }), P('slider')],                 // 우타가 3루 쪽: 당겨 친 안타
    [single({ spray: 8 })],                                // 가운데 ±8도 안은 밀어 친 안타가 아니다
    [single({ spray: -20, bats: 'L' })],                   // 좌타는 3루 쪽이 미는 쪽
    [hr(LONG_HR_M, { perfect: true }), P('curve')],        // 비거리가 딱 목표면 든다
    [hr(LONG_HR_M - 0.6)],                                 // 화면에는 반올림해 139m
    [out], [ball], [out], [out], [out],
  ]);
  assert.deepEqual({ hits: f.hits, perfect: f.perfect, balls: f.balls, oppo: f.oppo, hr: f.hr, longHr: f.longHr, breakHr: f.breakHr },
    { hits: 6, perfect: 2, balls: 2, oppo: 2, hr: 2, longHr: 1, breakHr: 1 });
  assert.deepEqual(f.hitsBy, { slider: 2, fastball: 3, curve: 1 });
});

test('한 판에서 세는 수: 연속 안타는 볼이 안 끊고, 끝내기 찬스는 볼을 빼고 10번째 기회다', () => {
  assert.equal(facts([[single()], [ball], [single()], [single()], [out], [single()]]).hitRun, 3);
  assert.equal(facts([[single()], [out], [single()], [single()]]).hitRun, 2);
  const nine = Array.from({ length: 9 }, () => [out]);
  assert.equal(facts([...nine, [ball], [ball], [single()]]).lastHit, 1);   // 볼 둘 뒤 공도 10번째 기회
  assert.equal(facts([...nine, [out]]).lastHit, 0);
  assert.equal(facts([[single()], ...nine.slice(1), [out]]).lastHit, 0);   // 첫 공 안타는 끝내기 찬스가 아니다
  assert.equal(facts(nine.slice(0, 5).concat([[single()]])).lastHit, 0);   // 공을 다 써서 기회가 남은 채 끝난 판
});

test('미션마다 이 판으로 오른 수: 목표를 넘겨도 판에서 센 수 그대로, 한 판 미션은 해내면 1', () => {
  const byId = (id, more = {}) => ({ ...MISSIONS.find((m) => m.id === id), ...more });
  const f = facts([[single({ perfect: true })], [single()], [single()], [single()], [single()], [hr(150)], [out], [out], [out], [out]], 6000);
  assert.deepEqual(missionGain([byId('play2'), byId('hit10'), byId('run3')], f), [1, 6, 1]);
  assert.deepEqual(missionGain([byId('score6k'), byId('score8k'), byId('run5')], f), [1, 0, 1]);
  assert.deepEqual(missionGain([byId('main', { pitch: 'fastball', need: 8 }), byId('perfect3'), byId('longHr2')], f), [6, 1, 1]);
  assert.deepEqual(missionGain([byId('score6k')], facts([[out]], 5900)), [0]);
});

test('그날 진행: 칸 값만큼 코인을 한 번씩 주고, 셋 다 하면 한 번 더 주며, 날이 바뀌면 처음부터', () => {
  const day = '2026-11-23', list = missionsOn(day), need = list.map((m) => m.need);
  const a = advanceMissions(null, day, [1, 0, 0]);
  assert.deepEqual(a.state, { day, n: [Math.min(1, need[0]), 0, 0], paid: need[0] === 1 ? 1 : 0 });
  const b = advanceMissions(a.state, day, need);   // 셋 다 채운다(넘친 수는 목표에서 멈춘다)
  assert.deepEqual(b.state.n, need);
  const first = need[0] === 1 ? 0 : TIER_COINS[0];
  assert.equal(b.coins, first + TIER_COINS[1] + TIER_COINS[2] + ALL_BONUS);
  assert.equal(b.bonus, ALL_BONUS);
  assert.deepEqual(b.done, need[0] === 1 ? [1, 2] : [0, 1, 2]);
  const c = advanceMissions(b.state, day, need);   // 같은 날 또 해도 더 안 준다
  assert.deepEqual([c.coins, c.done, c.bonus, c.state], [0, [], 0, b.state]);
  const d = advanceMissions(b.state, addDays(day, 1), [0, 0, 0]);   // 다음 날은 새 미션
  assert.deepEqual(d.state, { day: addDays(day, 1), n: [0, 0, 0], paid: 0 });
  assert.equal(TIER_COINS.reduce((s, x) => s + x, 0) + ALL_BONUS, 350);   // 하루 최대(2026-11-23 사용자가 고름)
});

test('그날 진행 다듬기: 망가지거나 다른 날 값은 그날 빈 진행으로, 목표를 넘는 수는 목표로', () => {
  const day = '2026-11-23', empty = { day, n: [0, 0, 0], paid: 0 }, need = missionsOn(day).map((m) => m.need);
  for (const bad of [null, undefined, 'x', 3, [], {}, { day: '2026-11-22', n: [1, 1, 1], paid: 1 }, { day, n: [1, 1], paid: 0 }, { day, n: [-1, 0, 0], paid: 0 },
    { day, n: [0.5, 0, 0], paid: 0 }, { day, n: [0, 0, 0], paid: 16 }, { day, n: [0, 0, 0], paid: -1 }]) assert.deepEqual(cleanMissionState(bad, day), empty, JSON.stringify(bad));
  assert.deepEqual(cleanMissionState({ day, n: [99, 0, 1], paid: 9 }, day), { day, n: [need[0], 0, Math.min(1, need[2])], paid: 9 });
});
