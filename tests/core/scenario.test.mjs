// 끝내기 상황 주루 플레이(2026-11-04): 홈 승부·태그업·병살을 판정 결과와 상황만으로 정하고, 서버가 같은 순서로 다시 돌려 같은 판이 나온다.
// 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing, judgeTake } from '../../js/core/judge.js';
import { makeSequence, pitcherHand, zoneMiss, makePitch, PITCH_MIX } from '../../js/core/pitches.js';
import { applyScenario, doublePlay, homePlay, makeScenario, RUNNER_ROUTES, RUNNER_TIMES, scenarioPitch, scenarioPoints, slideTime, SCENARIOS, tagUp } from '../../js/core/scenario.js';
import { clamp, mulberry32, pickWeighted } from '../../js/core/math.js';
import { scenarioMessage } from '../../js/view/text.js';

const hit = (seed, i, dt, bats = 'R') => judgeSwing(makeSequence(seed, pitcherHand(seed) === 'L')[i], dt, bats);
const scn = (k) => ({ ...SCENARIOS[k], bases: [...SCENARIOS[k].bases], count: { b: 0, s: 0 }, pa: [], end: null });

test('끝내기 공은 core의 scenarioPitch로 만들고, 예전 게임(main.js nextScenarioPitch)과 같은 공이 같은 순서로 나온다', () => {
  for (const seed of [1, 7, 42, 20261104]) {
    const a = mulberry32(seed), b = mulberry32(seed), sa = makeScenario(a), sb = makeScenario(b), lefty = pitcherHand(seed) === 'L';
    assert.deepEqual(sa, sb);
    for (let n = 1; n <= 12; n++) {
      const count = { b: n % 4, s: n % 3 }, p = scenarioPitch(a, count, n, lefty);
      const inZone = clamp(0.6 + (count.b === 3 ? 0.25 : 0) - (count.s === 2 && count.b < 2 ? 0.2 : 0), 0.3, 0.9);   // 예전 nextScenarioPitch 그대로
      assert.deepEqual(p, makePitch(b, pickWeighted(b, PITCH_MIX), inZone, { n, lefty }));
    }
  }
});

test('끝내기 점수: 안타·홈런마다 결과 점수 + 정타 보너스, 볼·아웃은 0', () => {
  assert.equal(scenarioPoints({ hit: true, kind: 'single', perfect: false }), 300);
  assert.equal(scenarioPoints({ hit: true, kind: 'hr', perfect: true }), 1100);
  assert.equal(scenarioPoints({ kind: 'ball', points: 100 }), 0);
  assert.equal(scenarioPoints({ kind: 'out' }), 0);
});

test('단타 홈 승부: 외야수가 주우면 2루 주자는 홈으로 뛰고 공이 먼저 닿아 태그하면 아웃, 얕은 안타를 내야수가 주우면 3루에서 멈춘다', () => {
  const safe = hit(1, 0, -70), out = hit(1, 2, -40), shallow = hit(1, 0, -90);
  for (const r of [safe, out, shallow]) assert.equal(r.kind, 'single');
  const s1 = scn(1);   // 1아웃 2루, 3:4
  assert.equal(scenarioMessage(s1, applyScenario(s1, safe)), '1점! 동점');
  assert.ok(safe.scnPlay.home.safe && safe.scnPlay.home.margin < 0);
  const s2 = scn(1), ev2 = applyScenario(s2, out);
  assert.equal(ev2.play, 'out-home'); assert.equal(s2.outs, 2); assert.equal(s2.home, 3); assert.deepEqual(s2.bases, [true, false, false]);
  assert.equal(scenarioMessage(s2, ev2), '홈에서 아웃 · 2아웃');
  assert.ok(out.scnPlay.home.margin > 0 && out.scnPlay.home.arrive + 0.2 < out.scnPlay.home.runner);   // 공이 먼저 닿아 태그한다
  const s3 = scn(1), ev3 = applyScenario(s3, shallow);
  assert.equal(ev3.play, 'hold'); assert.equal(s3.outs, 1); assert.deepEqual(s3.bases, [true, false, true]);
  assert.equal(scenarioMessage(s3, ev3), '3루에서 멈춤 · 1·3루');
});

test('태그업: 외야 뜬공이 잡히면 2루 주자가 넉넉히 살 때만 3루로 간다. 3루 주자는 예전처럼 희생플라이로 들어온다', () => {
  const fly = hit(1, 0, 25), t = tagUp(fly);
  assert.equal(fly.kind, 'out'); assert.equal(fly.type, 'fly');
  assert.ok(t.go && t.runner + 0.1 < t.arrive + 0.2);
  const s = scn(1), ev = applyScenario(s, fly);   // 1아웃 2루
  assert.equal(ev.play, 'tag-up'); assert.equal(s.outs, 2); assert.deepEqual(s.bases, [false, false, true]);
  const s4 = scn(5), ev4 = applyScenario(s4, fly);   // 1아웃 3루: 희생플라이
  assert.equal(ev4.play, 'sac-fly'); assert.equal(s4.home, 6);
});

test('병살: 1루 주자·아웃 2개 미만·내야 땅볼이면 2루에서 잡고 1루로 던진다. 타자가 먼저면 2루 한 명(야수 선택), 2루가 늦으면 1루에서 타자만', () => {
  const dp = hit(1, 3, -65), fc = hit(1, 2, -85), late = hit(1, 2, -90);
  const a = scn(3), evA = applyScenario(a, dp);   // 0아웃 1루, 0:2
  assert.equal(evA.play, 'dp'); assert.equal(a.outs, 2); assert.deepEqual(a.bases, [false, false, false]);
  assert.equal(scenarioMessage(a, evA), '병살 · 2아웃');
  const b = scn(3), evB = applyScenario(b, fc);
  assert.equal(evB.play, 'fc'); assert.equal(b.outs, 1); assert.deepEqual(b.bases, [true, false, false]);
  assert.ok(fc.scnPlay.dp.out2 && fc.scnPlay.dp.margin < 0);
  const c = scn(3), evC = applyScenario(c, late);
  assert.equal(evC.play, 'out'); assert.equal(c.outs, 1); assert.deepEqual(c.bases, [false, true, false]);   // 1루 주자는 2루로 밀린다
  const d = scn(0), evD = applyScenario(d, dp);   // 2아웃이면 병살 상황이 아니다: 타자 아웃으로 끝
  assert.equal(d.end, 'lose'); assert.equal(evD.play, 'out'); assert.equal(dp.scnPlay?.dp?.pos ?? null, '3루수');
});

test('주자 시간은 그림과 같은 길·같은 1/120초 계산(runArrive)이고, 같은 판을 다시 돌리면 같은 끝이 나온다(서버 다시 계산)', () => {
  for (const [k, route] of Object.entries(RUNNER_ROUTES)) assert.equal(RUNNER_TIMES[k], slideTime(route));
  const play = (seed) => {
    const rnd = mulberry32(seed), s = makeScenario(rnd), lefty = pitcherHand(seed) === 'L', me = mulberry32(seed + 1), log = [];
    for (let n = 1; n < 80 && !s.end; n++) {
      const p = scenarioPitch(rnd, s.count, n, lefty), swing = me() < (zoneMiss(p) === 0 ? 0.85 : 0.3);
      const r = swing ? judgeSwing(p, Math.round((me() - 0.5) * 120), seed % 2 ? 'R' : 'L') : judgeTake(p);
      log.push(JSON.stringify(applyScenario(s, r)), r.kind);
    }
    return { end: s.end, home: s.home, outs: s.outs, log: log.join('|') };
  };
  for (let seed = 1; seed <= 300; seed++) assert.deepEqual(play(seed), play(seed));
});
