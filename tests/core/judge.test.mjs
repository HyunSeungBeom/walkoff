// 판정 규칙(js/core)과 화면 글(js/view/text.js)을 브라우저 없이 본다(2026-11-03 코드 나누기 2단계). 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing, judgeTake, PERFECT_MS } from '../../js/core/judge.js';
import { makeSequence, pitcherHand, zoneMiss, zoneOff } from '../../js/core/pitches.js';
import { makeScenario, applyScenario } from '../../js/core/scenario.js';
import { labelSwing, labelTake, zoneOffText, scenarioMessage, scenarioLabel } from '../../js/view/text.js';
import { mulberry32 } from '../../js/core/math.js';

const grid = function* () {
  for (let seed = 1; seed <= 40; seed++) {
    const seq = makeSequence(seed, pitcherHand(seed) === 'L');
    for (let i = 0; i < 16; i++) for (let dt = -150; dt <= 150; dt += 6) for (const bats of ['R', 'L']) yield { p: seq[i], dt, bats };
  }
};

test('core 판정은 결과 코드만 돌려주고, 이름·이유 글은 view/text.js가 붙인다', () => {
  const kinds = new Set();
  for (const { p, dt, bats } of grid()) {
    const r = judgeSwing(p, dt, bats);
    assert.ok(!('name' in r) && !('reason' in r), '판정 결과에 글이 없다');
    kinds.add(r.kind);
    labelSwing(r, p);
    assert.ok(r.name && r.reason, `${r.kind}에 이름과 이유가 붙는다`);
  }
  for (const k of ['whiff', 'foul', 'out', 'single', 'double', 'hr']) assert.ok(kinds.has(k), `${k}도 나온다`);
  const p = makeSequence(5)[0], take = judgeTake(p);
  assert.ok(!('name' in take));
  assert.deepEqual(Object.keys(labelTake(take, p, 'R')).sort(), ['kind', 'name', 'points', 'reason', 'took']);
});

test('정타는 아웃이 되지 않는다(존 안 공, 타이밍 차이 15ms 안)', () => {
  let perfect = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const seq = makeSequence(seed, pitcherHand(seed) === 'L');
    for (const p of seq.slice(0, 16)) if (zoneMiss(p) === 0) for (let dt = -PERFECT_MS; dt <= PERFECT_MS; dt += 3) for (const bats of ['R', 'L']) {
      const r = judgeSwing(p, dt, bats);
      assert.ok(r.perfect && r.kind !== 'out', `${seed} ${p.type} ${dt} ${bats}: ${r.kind}`);
      perfect++;
    }
  }
  assert.ok(perfect > 1000);
});

test('존 밖 거리는 방향 코드로 돌려주고, 글은 좌타·우타에 따라 몸쪽·바깥쪽이 바뀐다', () => {
  const inside = { tx: -0.36, ty: 0.8 }, low = { tx: 0, ty: 0.42 };
  assert.deepEqual(zoneOff(inside, 'R'), { side: 'in', cm: 11 });
  assert.deepEqual(zoneOff(inside, 'L'), { side: 'out', cm: 11 });
  assert.deepEqual(zoneOffText(inside, 'R'), { dir: '몸쪽', cm: 11 });
  assert.deepEqual(zoneOffText(low, 'L'), { dir: '아래', cm: 8 });
  const ball = { type: 'fastball', ...inside };
  assert.equal(labelTake(judgeTake(ball), ball, 'R').reason, '존 몸쪽으로 11cm 빠졌어요 · 선구안 보너스');
});

test('끝내기 상황: 역전하는 순간 끝내기 승리, 3아웃이면 끝, 글은 view/text.js', () => {
  const s = makeScenario(() => 0);   // 2아웃 1·2루, 3:2
  assert.equal(scenarioLabel(s), '9회말 2아웃 1·2루 · 1점 차');
  assert.equal(scenarioMessage(s, applyScenario(s, { kind: 'single' })), '1점! 동점');
  assert.equal(s.end, null);
  assert.equal(scenarioMessage(s, applyScenario(s, { kind: 'double' })), '끝내기! 4-3 승리');
  assert.equal(s.end, 'win');
  const t = makeScenario(() => 0.99);   // 1아웃 3루, 6:5
  assert.equal(scenarioMessage(t, applyScenario(t, { kind: 'out', type: 'fly' })), '희생플라이 · 1점! 동점');
  for (let k = 0; k < 3; k++) applyScenario(t, { kind: 'whiff' });
  assert.equal(t.end, 'tie');
  // 끝날 때까지 아무렇게나 쳐도 아웃은 3을 넘지 않고, 끝이 정해지면 win·tie·lose 가운데 하나다
  const pool = ['ball', 'strike', 'whiff', 'foul', 'out', 'single', 'double', 'hr'];
  for (let g = 1; g <= 500; g++) {
    const rnd = mulberry32(g), sc = makeScenario(rnd);
    for (let k = 0; k < 400 && !sc.end; k++) applyScenario(sc, { kind: pool[Math.floor(rnd() * pool.length)], type: 'ground' });
    assert.ok(sc.outs <= 3 && ['win', 'tie', 'lose'].includes(sc.end), `${g}: ${JSON.stringify(sc)}`);
  }
});
