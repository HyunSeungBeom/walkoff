// 10구 도전 진행(2026-11-19 랭킹 점수 검사 강화): 게임과 서버가 같은 core 함수(playChallenge·addStreak·pitchGain)로 점수·전광판을 낸다.
// 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing, judgeTake } from '../../js/core/judge.js';
import { makeSequence, pitcherHand, zoneMiss, STYLE_ORDER } from '../../js/core/pitches.js';
import { POINTS, hitStreakBonus, hrStreakBonus } from '../../js/core/score.js';
import { addStreak, lightCode, pitchGain, playChallenge } from '../../js/core/challenge.js';
import { mulberry32 } from '../../js/core/math.js';

const seqFor = (seed, style = 'classic') => makeSequence(seed, pitcherHand(seed) === 'L', style);
const HITS = ['single', 'double', 'triple', 'hr'];
const res = (kind, extra = {}) => ({ kind, hit: HITS.includes(kind), points: POINTS[kind] ?? 0, ...extra });

// 게임(main.js swing·finish·challengeOver)이 하는 순서대로 따로 짠 10구 한 판. 공마다 판정하고, 안타면 앞의 결과를 거꾸로 세어(볼은 건너뜀)
// 연속 홈런·연속 안타 보너스 중 큰 쪽을 더하고, (점수 + 정타 100) × (남은 기회 1번이면 2)를 쌓고, 볼이 아니면 기회를 하나 쓴다. 기회가 0이거나 공을 다 쓰면 끝
function playLikeGame(seq, bats, pick) {
  const results = [], moves = [];
  let left = 10, score = 0;
  for (let i = 0; i < seq.length && left > 0; i++) {
    const p = seq[i], dt = pick(p, i), r = dt === null ? judgeTake(p) : judgeSwing(p, dt, bats);
    moves.push(dt);
    if (r.hit) {
      let hits = 1, hrs = 1;
      for (let j = i - 1; j >= 0 && (results[j].kind === 'ball' || results[j].hit); j--) if (results[j].hit) hits++;
      for (let j = i - 1; j >= 0 && (results[j].kind === 'ball' || results[j].kind === 'hr'); j--) if (results[j].kind === 'hr') hrs++;
      r.points += Math.max(r.kind === 'hr' ? hrStreakBonus(hrs) : 0, hitStreakBonus(hits));
    }
    score += (r.points + (r.perfect ? 100 : 0)) * (left === 1 ? 2 : 1);
    if (r.kind !== 'ball') left--;
    results.push(r);
  }
  return { moves, score, lights: results.map((r) => ({ single: 'S', double: 'D', triple: 'T', hr: 'H', ball: 'Y' })[r.kind] ?? 'R').join('') };
}

test('다시 돌린 판은 게임 순서대로 따로 짠 판과 점수·전광판이 같다(유형 넷, 좌·우타, 사람처럼 치는 타자 1,600판)', () => {
  let games = 0, hits = 0;
  for (const style of STYLE_ORDER) for (let seed = 1; seed <= 200; seed++) for (const bats of ['R', 'L']) {
    const me = mulberry32(seed * 7919 + bats.charCodeAt(0)), seq = seqFor(seed, style);
    // 존 안 공은 85%, 밖은 30% 휘두르고, 타이밍은 ±100ms 안(정타·파울·헛스윙이 다 나온다)
    const g = playLikeGame(seq, bats, (p) => (me() < (zoneMiss(p) === 0 ? 0.85 : 0.3) ? Math.round((me() - 0.5) * 200) : null));
    const out = playChallenge(seq, g.moves, bats);
    assert.deepEqual({ score: out?.score, lights: out?.lights }, { score: g.score, lights: g.lights }, `${style} ${seed} ${bats}`);
    games++; hits += [...g.lights].filter((c) => 'SDTH'.includes(c)).length;
  }
  assert.equal(games, 1600);
  assert.ok(hits > 1600 * 2, `안타가 판당 2개는 넘게 나온다(${hits})`);
});

test('볼은 기회를 쓰지 않고, 남은 기회가 1번이면 볼까지 2배. 마지막 공에서 판이 끝나야 한다', () => {
  const seed = 2, seq = seqFor(seed);   // 존 밖 공이 많은 시드
  const takes = playLikeGame(seq, 'R', () => null);   // 한 번도 안 친다: 존 안 공은 루킹 스트라이크, 밖은 볼
  let left = 10, want = 0;
  for (const p of seq) { if (!left) break; if (zoneMiss(p) > 0) want += 100 * (left === 1 ? 2 : 1); else left--; }
  const out = playChallenge(seq, takes.moves, 'R');
  assert.deepEqual([out.score, out.lights, out.lights.replace(/Y/g, '')], [want, takes.lights, 'R'.repeat(10)]);
  assert.ok(out.lights.includes('Y'));
  assert.equal(playChallenge(seq, takes.moves.slice(0, -1), 'R'), null);   // 기회가 남았는데 공이 끝났다
  assert.equal(playChallenge(seq, [...takes.moves, null], 'R'), null);      // 기회를 다 쓴 뒤에도 공이 있다
  assert.equal(playChallenge(seq, [], 'R'), null);
  assert.deepEqual(playChallenge(seq.slice(0, 3), [null, null, null], 'R')?.lights.length, 3);   // 미리 만든 공을 다 쓰면 기회가 남아도 끝난다
});

test('연속 보너스: 연속 홈런과 연속 안타 중 큰 쪽 하나, 볼은 끊지 않고 다른 결과는 끊는다', () => {
  const at = (before, r) => addStreak(before, before.length, r);
  assert.deepEqual(at([res('hr'), res('ball')], res('hr')), { ...res('hr'), points: 1500, streak: 2, streakBonus: 500 });   // 백투백 +500(연속 안타 +300보다 크다)
  assert.deepEqual(at([res('hr'), res('hr')], res('hr')), { ...res('hr'), points: 2000, streak: 3, streakBonus: 1000 });
  assert.deepEqual(at([res('single'), res('double')], res('hr')), { ...res('hr'), points: 1500, streak: 1, streakBonus: 0, hitStreak: 3, hitBonus: 500 });
  assert.deepEqual(at([res('single'), res('single'), res('single')], res('single')), { ...res('single'), points: 1100, streakBonus: 0, hitStreak: 4, hitBonus: 800 });
  assert.deepEqual(at([res('hr'), res('strike')], res('hr')), { ...res('hr'), points: 1000, streak: 1, streakBonus: 0 });   // 루킹 스트라이크가 끊는다
  assert.deepEqual(at([res('hr')], res('out')), res('out'));   // 안타가 아니면 그대로
  assert.deepEqual([pitchGain(res('hr'), false), pitchGain(res('hr', { perfect: true }), false), pitchGain(res('hr', { perfect: true }), true), pitchGain(res('ball'), true)], [1000, 1100, 2200, 200]);
  assert.deepEqual(['single', 'double', 'triple', 'hr', 'ball', 'strike', 'out', 'foul', 'whiff'].map((k) => lightCode(res(k))).join(''), 'SDTHYRRRR');
});
