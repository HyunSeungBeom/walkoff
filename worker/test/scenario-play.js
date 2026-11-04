// 테스트에서 끝내기 상황 한 판을 게임(js/main.js)이 하는 순서대로 친다. startGame이 시드로 상황과 첫 공을 만들고(nextScenarioPitch),
// finish가 공마다 판정을 상황에 반영하고(applyScenario), 판이 안 끝났으면 next가 다음 공을 만든다. 서버(replayScenario)와 따로 짠 순서다
import { judgeSwing, judgeTake } from '../../js/core/judge.js';
import { pitcherHand, zoneMiss } from '../../js/core/pitches.js';
import { applyScenario, makeScenario, scenarioPitch, scenarioPoints, SCENARIOS } from '../../js/core/scenario.js';
import { mulberry32 } from '../../js/core/math.js';

// pick(p, i)는 i번째 공에 넣을 타이밍(ms)이나 지켜봄(null). 돌려주는 k는 makeScenario가 처음 뽑는 수로 따로 셈한 상황 번호다
export function playScenario(seed, bats, pick) {
  const rnd = mulberry32(seed), scn = makeScenario(rnd), lefty = pitcherHand(seed) === 'L';
  const k = Math.floor(mulberry32(seed)() * SCENARIOS.length), seq = [scenarioPitch(rnd, scn.count, 1, lefty)], moves = [];
  let points = 0;
  for (let i = 0; ; i++) {
    const p = seq[i], dt = pick(p, i), r = dt === null ? judgeTake(p) : judgeSwing(p, dt, bats);
    moves.push(dt);
    points += scenarioPoints(r);
    applyScenario(scn, r);
    if (scn.end || moves.length >= 300) break;
    seq.push(scenarioPitch(rnd, scn.count, seq.length + 1, lefty));
  }
  return { k, end: scn.end, points, moves };
}

// 사람처럼 치는 무작위 타자: 존 안 공은 85%, 밖은 30% 휘두르고 타이밍은 ±60ms
export const randomBatter = (seed) => { const me = mulberry32(seed + 1); return (p) => (me() < (zoneMiss(p) === 0 ? 0.85 : 0.3) ? Math.round((me() - 0.5) * 120) : null); };
export const perfectBatter = (p) => (zoneMiss(p) === 0 ? 0 : null);   // 존 안 공만 제때(정타), 밖은 지켜본다
export const whiffBatter = () => 1000;                                 // 늘 헛스윙
