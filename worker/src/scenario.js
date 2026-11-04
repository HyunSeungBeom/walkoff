// 끝내기 상황 코인(2026-11-04 사용자 결정 '친 공마다 점수 + 이기면 보너스, 10구와 비슷하게'). 판이 끝나면 게임이 공마다 친 타이밍을 보내고,
// 서버가 표(seeds.js)의 시드로 같은 판을 처음부터 다시 돌려(js/core) 끝(win·tie·lose)과 점수를 낸다. 끝내기 공과 주루 판정은 judgeSwing 결과와
// 상황만으로 정해져서(core/scenario.js) 같은 시드·같은 타이밍이면 게임과 같은 판이 나온다. 그래서 core 판정을 바꾸면 서버도 같이 배포한다.
// 타이밍은 게임이 재서 보내므로 10구 도전처럼 꾸민 판까지는 막지 못한다. 표 하나에 한 번, 공 수 × 1.5초가 지나야 받고, 코인은 /scores와 같이 20초 간격이다
import { mulberry32 } from '../../js/core/math.js';
import { pitcherHand } from '../../js/core/pitches.js';
import { judgeSwing, judgeTake } from '../../js/core/judge.js';
import { SCENARIOS, makeScenario, scenarioPitch, scenarioPoints, applyScenario } from '../../js/core/scenario.js';
import { coinsFor } from './shop.js';
import { ticketError } from './seeds.js';

// 이기면 더 주는 코인(SCENARIOS 순서). 승률이 낮은 상황일수록 많이 줘서 승률 × 보너스가 7~9코인으로 비슷하다
// (2026-11-03 게임 세션이 잰 승률, 타이밍 오차 표준편차 40ms: 2아웃 1·2루 44%, 1아웃 2루 68%, 2아웃 만루 43%, 무사 1루 68%, 2아웃 주자 없음 25%, 1아웃 3루 68%)
export const WIN_BONUS = [20, 10, 20, 10, 30, 10];
export const MAX_MOVES = 300;   // 한 판의 공. 실제 판은 길어야 수십 개다
export const MOVE_MS = 5000;    // 받는 타이밍(ms) 범위. 게임은 공을 놓은 뒤부터 140ms 늦게까지만 휘두를 수 있다

// 한 판을 처음부터 다시 돌린다. 게임과 같은 순서: 시드 → 상황 → 공마다 (지금 볼카운트로) 공 만들기 → 판정 → 점수 → 상황 반영.
// moves는 공마다 judgeSwing에 넣은 타이밍(ms, 타이밍 보정을 뺀 값) 또는 지켜본 공 null.
// 마지막 공에서 판이 끝나야 한다. 중간에 끝났는데 공이 더 있거나, 다 돌려도 안 끝나면 null
export function replayScenario(seed, moves, bats) {
  const rnd = mulberry32(seed), s = makeScenario(rnd), lefty = pitcherHand(seed) === 'L';
  const k = SCENARIOS.findIndex((x) => x.outs === s.outs && x.away === s.away && x.home === s.home && x.bases.every((b, i) => b === s.bases[i]));
  let points = 0;
  for (let i = 0; i < moves.length; i++) {
    if (s.end) return null;
    const p = scenarioPitch(rnd, s.count, i + 1, lefty), r = moves[i] === null ? judgeTake(p) : judgeSwing(p, moves[i], bats);
    points += scenarioPoints(r);
    applyScenario(s, r);
  }
  return s.end ? { k, end: s.end, points } : null;
}

// 끝내기 판 하나를 검사한다. b는 게임이 보낸 본문, ticket은 함께 온 표를 DB에서 꺼낸 줄(없으면 null).
// 통과하면 끝·점수와 줄 코인(점수의 1/100 + 이기면 상황별 보너스, 져도 점수 코인은 준다)
export function checkScenario(b, nowMs, playerId, ticket) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const { moves, bats } = b;
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > MAX_MOVES || (bats !== 'R' && bats !== 'L')
    || !moves.every((m) => m === null || (Number.isInteger(m) && Math.abs(m) <= MOVE_MS))) return { ok: false, error: 'bad_moves' };
  const error = ticketError(b.token, ticket, playerId, nowMs, moves.length);
  if (error) return { ok: false, error };
  const game = replayScenario(ticket.seed, moves, bats);
  if (!game) return { ok: false, error: 'replay_mismatch' };
  const bonus = game.end === 'win' ? WIN_BONUS[game.k] ?? 0 : 0;
  return { ok: true, value: { ...game, bonus, coins: coinsFor(game.points) + bonus } };
}
