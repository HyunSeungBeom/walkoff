// 판정 규칙(js/core)과 화면 글(js/view/text.js)을 브라우저 없이 본다(2026-11-03 코드 나누기 2단계). 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM, airCatcher, judgeSwing, judgeTake, PERFECT_MS } from '../../js/core/judge.js';
import { OUTFIELDERS } from '../../js/core/field.js';
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

test('외야 판정은 수비수가 닿는지로 정한다(2026-11-04 사용자 결정 \'판정도 실제처럼\'): 외야수가 잡은 뜬 타구는 닿는 공이고, 45m 넘게 떨어진 외야 뜬 안타(홈런 빼고)는 아무도 못 닿는다', () => {
  let caught = 0, hits = 0;
  for (const { p, dt, bats } of grid()) {
    const r = judgeSwing(p, dt, bats);
    if (r.type !== 'fly' && r.type !== 'line') continue;
    if (r.kind === 'out' && OUTFIELDERS.includes(r.fielder)) { caught++; assert.ok(airCatcher(r), `${r.type} ${r.dist}m ${r.spray}도: 외야수가 잡았으면 닿는 공`); }
    else if (r.hit && r.kind !== 'hr' && r.dist >= 45) { hits++; assert.equal(airCatcher(r), null, `${r.kind} ${r.dist}m ${r.spray}도: 안타면 아무도 못 닿는다`); }
  }
  assert.ok(caught > 1000 && hits > 1000, `${caught} ${hits}`);
});

test('조준 타격: aim이 없거나 {0,0}이면 지금과 같고, 과녁 밖은 헛스윙, 공 위를 치면 깔리고 아래를 치면 뜨며, 가장자리는 약하고, 정타는 과녁 가운데(sweet)에서만 나온다', () => {
  const strip = ({ aimZone, ...rest }) => rest;
  let fair = 0, weaker = 0, edgePerfect = 0, nearPerfect = 0, perfect = 0;
  for (const { p, dt, bats } of grid()) {
    const r0 = judgeSwing(p, dt, bats), z = judgeSwing(p, dt, bats, { x: 0, y: 0 });
    assert.deepEqual(strip(z), r0);   // {0,0}은 지금과 같다(조준 자리 'near'만 붙는다)
    assert.equal(z.aimZone, 'near');
    if (r0.kind === 'whiff') continue;
    const out = judgeSwing(p, dt, bats, { x: 0.8, y: 0.7 });   // d 1.06
    assert.deepEqual([out.kind, out.aimMiss, out.aimZone], ['whiff', true, 'miss']);   // 타이밍이 맞아도 과녁 밖은 헛스윙
    if (r0.kind === 'foul') continue;
    fair++;
    const top = judgeSwing(p, dt, bats, { x: 0, y: 0.3 }), low = judgeSwing(p, dt, bats, { x: 0, y: -0.3 });
    assert.ok(top.la < r0.la && low.la > r0.la, `위를 치면 깔리고 아래를 치면 뜬다 ${r0.la} ${top.la} ${low.la}`);
    const edge = judgeSwing(p, dt, bats, { x: 0.9, y: 0 });
    assert.equal(edge.aimZone, 'edge');
    assert.ok(edge.ev <= r0.ev);
    if (edge.ev < r0.ev) weaker++;
    if (r0.perfect) { perfect++; if (judgeSwing(p, dt, bats, { x: AIM.sweet * 0.9, y: 0 }).perfect) nearPerfect++; }
    if (judgeSwing(p, dt, bats, { x: AIM.sweet * 1.1, y: 0 }).perfect) edgePerfect++;
  }
  assert.ok(fair > 1000, `앞으로 간 타구 ${fair}`);
  assert.ok(weaker / fair > 0.9, `가장자리는 거의 늘 약하다 ${weaker}/${fair}`);
  assert.ok(perfect > 0 && nearPerfect === perfect, '과녁 가운데 안이면 정타는 그대로');
  assert.equal(edgePerfect, 0, 'sweet 밖에서는 정타가 없다');
});
