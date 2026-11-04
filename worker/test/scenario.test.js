// 끝내기 상황 코인(scenario.js): 서버가 게임과 같은 순서로 판을 다시 돌려 끝·점수를 내고, 코인은 점수의 1/100 + 이기면 상황별 보너스
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScenario, replayScenario, MAX_MOVES, WIN_BONUS } from '../src/scenario.js';
import { SEED_TTL_MS } from '../src/seeds.js';
import { SCENARIOS } from '../../js/core/scenario.js';
import { perfectBatter, playScenario, randomBatter, whiffBatter } from './scenario-play.js';

const NOW = Date.parse('2026-11-04T05:00:00Z'), PID = 'p-test-0001';
const ticket = (seed, patch = {}) => ({ id: 't-1', player_id: PID, seed, issued_at: NOW - 600_000, used_at: null, ...patch });

test('다시 돌린 판은 게임 순서로 친 판과 끝·점수·상황이 같고, 끝난 뒤 공이 더 있거나 안 끝난 판은 받지 않는다', () => {
  const ends = {}, ks = new Set();
  for (let seed = 1; seed <= 600; seed++) {
    const bats = seed % 2 ? 'R' : 'L', g = playScenario(seed, bats, randomBatter(seed));
    assert.ok(g.end, `시드 ${seed}: 300구 안에 끝나야 한다`);
    assert.deepEqual(replayScenario(seed, g.moves, bats), { k: g.k, end: g.end, points: g.points }, `시드 ${seed}`);
    assert.equal(replayScenario(seed, [...g.moves, null], bats), null);
    if (g.moves.length > 1) assert.equal(replayScenario(seed, g.moves.slice(0, -1), bats), null);
    ends[g.end] = (ends[g.end] ?? 0) + 1; ks.add(g.k);
  }
  assert.ok(ends.win > 100 && ends.lose > 100, JSON.stringify(ends));
  assert.equal(ks.size, SCENARIOS.length);   // 상황 여섯 개가 모두 나왔다
  assert.equal(WIN_BONUS.length, SCENARIOS.length);
});

test('코인: 점수의 1/100, 이기면 상황별 보너스를 더한다(지거나 비기면 점수 코인만)', () => {
  let won = 0, lost = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const g = playScenario(seed, 'R', randomBatter(seed)), c = checkScenario({ token: 't-1', bats: 'R', moves: g.moves }, NOW, PID, ticket(seed));
    assert.ok(c.ok, c.error);
    const bonus = g.end === 'win' ? WIN_BONUS[g.k] : 0;
    assert.deepEqual(c.value, { k: g.k, end: g.end, points: g.points, bonus, coins: Math.floor(g.points / 100) + bonus });
    if (g.end === 'win') won++; else if (g.points >= 100) lost++;
  }
  assert.ok(won > 50 && lost > 10, `${won} ${lost}`);
  const seed = Array.from({ length: 500 }, (_, i) => i + 1).find((s) => playScenario(s, 'R', perfectBatter).k === 4);   // 2아웃 주자 없음
  const g = playScenario(seed, 'R', perfectBatter);
  assert.equal(g.end, 'win');
  assert.equal(checkScenario({ token: 't-1', bats: 'R', moves: g.moves }, NOW, PID, ticket(seed)).value.bonus, 30);
  const k = playScenario(seed, 'R', whiffBatter);   // 늘 헛스윙: 삼진으로 지고 점수 0
  assert.deepEqual(checkScenario({ token: 't-1', bats: 'R', moves: k.moves }, NOW, PID, ticket(seed)).value, { k: 4, end: 'lose', points: 0, bonus: 0, coins: 0 });
});

test('틀린 본문과 표: 모양, 표 하나에 한 번·내 표만·기한 안·공 수만큼 시간이 지나야, 좌·우타가 다르면 다른 판', () => {
  const seed = 11, g = playScenario(seed, 'R', randomBatter(seed)), body = { token: 't-1', bats: 'R', moves: g.moves };
  const check = (b, t = ticket(seed)) => { const c = checkScenario(b, NOW, PID, t); return c.ok ? 'ok' : c.error; };
  assert.equal(check(body), 'ok');
  assert.equal(check(null), 'bad_body');
  for (const moves of [undefined, 'x', [], [1.5], ['0'], [5001], [NaN], Array(MAX_MOVES + 1).fill(null)]) assert.equal(check({ ...body, moves }), 'bad_moves', JSON.stringify(moves));
  assert.equal(check({ ...body, bats: 'X' }), 'bad_moves');
  assert.equal(check({ ...body, token: undefined }), 'seed_required');
  assert.equal(check(body, null), 'bad_seed');
  assert.equal(check(body, ticket(seed, { player_id: 'p-other-0001' })), 'bad_seed');
  assert.equal(check(body, ticket(seed, { used_at: NOW - 1000 })), 'seed_used');
  assert.equal(check(body, ticket(seed, { issued_at: NOW - SEED_TTL_MS - 1 })), 'seed_expired');
  assert.equal(check(body, ticket(seed, { issued_at: NOW - g.moves.length * 1500 + 1 })), 'too_fast');
  assert.equal(check(body, ticket(seed, { issued_at: NOW - g.moves.length * 1500 })), 'ok');
  // 같은 타이밍이라도 좌타면 타구 방향이 달라 다른 판이다. 한 시드라도 달라지는지 본다
  const differs = Array.from({ length: 60 }, (_, i) => i + 1).some((s) => {
    const r = playScenario(s, 'R', randomBatter(s)), l = replayScenario(s, r.moves, 'L');
    return !l || l.end !== r.end || l.points !== r.points;
  });
  assert.ok(differs);
});
