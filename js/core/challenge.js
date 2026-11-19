// 10구 도전 진행(2026-11-19 랭킹 점수 검사 강화): 공마다 판정에 연속 보너스를 붙이고, 정타 보너스·끝내기 찬스 2배로 점수를 내고, 기회를 센다.
// 게임(main.js)이 공마다 같은 함수를 부르고, 랭킹 서버(worker/src/rules.js)는 게임이 보낸 공마다 타이밍으로 판을 처음부터 다시 돌려
// 그 판의 점수와 전광판을 정한다(게임이 보낸 점수는 쓰지 않는다). 그래서 이 파일이나 판정(judge.js)을 바꾸면 서버도 같이 배포한다
import { judgeSwing, judgeTake } from './judge.js';
import { CHANCES, PERFECT_BONUS, hitStreakBefore, hitStreakBonus, hrStreakBefore, hrStreakBonus } from './score.js';

// 전광판 글자: 단타 S·2루타 D·3루타 T·홈런 H·볼 Y·그 밖(아웃·파울·헛스윙·루킹 스트라이크) R
const HIT_CODE = { single: 'S', double: 'D', triple: 'T', hr: 'H' };
export const lightCode = (r) => (r.hit ? HIT_CODE[r.kind] : r.kind === 'ball' ? 'Y' : 'R');

// 안타에 연속 홈런·연속 안타 보너스 중 큰 쪽 하나를 붙인다(r.points에 더하고, 화면이 쓰는 streak·streakBonus·hitStreak·hitBonus를 적는다).
// results는 이번 공 앞까지의 결과다
export function addStreak(results, i, r) {
  if (!r.hit) return r;
  const hits = hitStreakBefore(results, i) + 1, hb = hitStreakBonus(hits);
  if (r.kind === 'hr') { r.streak = hrStreakBefore(results, i) + 1; r.streakBonus = hrStreakBonus(r.streak); }
  if (hb > (r.streakBonus ?? 0)) { r.streakBonus = 0; r.hitStreak = hits; r.hitBonus = hb; }
  r.points += (r.streakBonus ?? 0) + (r.hitBonus ?? 0);
  return r;
}

// 이 공으로 얻는 점수: 결과 점수(연속 보너스 포함)와 정타 보너스. 남은 기회가 1번(끝내기 찬스)이면 2배
export const pitchGain = (r, lastChance) => (r.points + (r.perfect ? PERFECT_BONUS : 0)) * (lastChance ? 2 : 1);

// 한 판을 처음부터 다시 돌린다. seq는 그 판의 공 순서(makeSequence), moves는 공마다 judgeSwing에 넣은 타이밍(ms, 타이밍 보정을 뺀 정수)이나
// 그냥 보낸 공 null, bats는 'R'·'L'. 볼은 기회를 쓰지 않고, 기회 10번을 다 쓰거나 미리 만든 공을 다 쓰면 판이 끝난다(main.js challengeOver와 같다).
// 마지막 공에서 판이 끝나야 한다: 끝난 뒤에 공이 더 있거나, 다 돌려도 안 끝나면 null
export function playChallenge(seq, moves, bats) {
  const results = [];
  let left = CHANCES, score = 0, lights = '';
  for (let i = 0; i < moves.length; i++) {
    const p = seq[i];
    if (!p || left === 0) return null;
    const r = addStreak(results, i, moves[i] === null ? judgeTake(p) : judgeSwing(p, moves[i], bats));
    score += pitchGain(r, left === 1);
    if (r.kind !== 'ball') left -= 1;
    results.push(r);
    lights += lightCode(r);
  }
  return left === 0 || moves.length === seq.length ? { score, lights, results } : null;
}
