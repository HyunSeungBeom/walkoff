// 점수: 결과별 점수, 기회 수, 정타 보너스, 연속 홈런·연속 안타 보너스, 서버가 쓰는 점수 상한(maxScoreFor).
// 점수 규칙과 상한을 한 파일에 두어 같이 바꾼다(랭킹 서버 worker/src/rules.js가 이 파일을 그대로 가져다 쓴다)
import { REACH_M, zoneMiss } from './pitches.js';

export const POINTS = { hr: 1000, triple: 800, double: 500, single: 300, ball: 100 };

// 기회 10번. 볼(존 밖 공을 참음)은 기회를 쓰지 않는다(2026-10-29 사용자 결정으로 추가 기회 상한 5번을 없앰).
export const CHANCES = 10;
export const PERFECT_BONUS = 100;
// 연속 홈런(2026-10-30 사용자 결정, 사용자 목소리 '연속 홈런 시 추가점'): 두 번째 연속(백투백)은 +500, 세 번째부터는 +1,000씩.
// 골라낸 볼은 기회를 쓰지 않아서 연속을 끊지 않고, 끝내기 찬스면 보너스도 2배다. 서버도 이 값으로 점수 상한을 잰다
export const hrStreakBonus = (n) => (n >= 3 ? 1000 : n === 2 ? 500 : 0);
// 이번 공 앞으로 이어진 홈런 수. 볼은 건너뛰고, 다른 결과(안타·아웃·파울·헛스윙·루킹 스트라이크)가 나오면 끊긴다
export function hrStreakBefore(results, i) {
  let n = 0;
  for (let j = i - 1; j >= 0; j--) { const kind = results[j]?.kind; if (kind === 'ball') continue; if (kind !== 'hr') break; n++; }
  return n;
}
// 연속 안타(2026-11-03 사용자 결정 '연속 안타 보너스, 밸런스 있게', 같은 날 유저 피드백 '연속 안타 점수 더 올려 달라'로 사용자가 B를 골라 올림):
// 두 번째 연속 +300, 세 번째 +500, 네 번째부터 +800씩(전에는 +100·200·300). 보통 실력(공마다 안타 40%)이면 연속 안타로 받는 점수가 한 판 평균 201 → 557점(356점 더). 홈런·2루타·내야 안타도 안타다.
// 연속 홈런처럼 골라낸 볼은 끊지 않고 다른 결과는 끊는다. 홈런이면 연속 홈런 보너스와 더하지 않고 큰 쪽만 준다. 그래서 n번째마다 연속 홈런
// 보너스보다 작거나 같아, 서버 점수 상한(전광판 안타를 모두 홈런·연속 홈런 보너스로 본다)을 넘지 않는다
export const hitStreakBonus = (n) => (n >= 4 ? 800 : n === 3 ? 500 : n === 2 ? 300 : 0);
export function hitStreakBefore(results, i) {
  let n = 0;
  for (let j = i - 1; j >= 0; j--) { const r = results[j]; if (r?.kind === 'ball') continue; if (!r?.hit) break; n++; }
  return n;
}

// 전광판이 그 판의 공 순서(seq)로 실제로 나올 수 있는지 한 칸씩 따라가 보고, 나올 수 있으면 그 전광판으로 낼 수 있는
// 가장 큰 점수를 돌려준다(나올 수 없으면 null).
// - 볼(Y)은 존 밖 공을 그냥 보냈을 때만 나오고 기회를 쓰지 않는다. 안타(G)는 배트가 닿는 공(존에서 REACH_M 안)에만 나온다.
// - 기회 10번을 다 쓰면 판이 끝나서 그 뒤에는 공이 없다. 기회가 남은 채 끝나는 건 공을 다 썼을 때뿐이다.
// - 남은 기회가 1번일 때(끝내기 찬스)는 볼까지 점수가 2배다. 안타는 홈런+정타 보너스, 나머지 스윙은 정타 보너스까지 준다.
// - 안타(G)는 모두 홈런일 수 있다고 보고 연속 홈런 보너스(hrStreakBonus)까지 준다. 볼(Y)은 연속을 끊지 않고 다른 결과(R)는 끊는다(2026-10-30).
// 2026-10-30 전에는 칸 수와 칸별 상한만 봐서, 안타 10개 뒤에 볼 30개를 붙인 전광판으로 15,100점이 들어왔다
// 전광판으로 낼 수 있는 점수의 { min, max }(그 판의 공 순서로 나올 수 없는 전광판이면 null). 서버가 받은 점수를 이 사이인지 본다(2026-11-05 칭호·업적).
// 게임은 안타 종류(S 단타·D 2루타·T 3루타·H 홈런)를 보내서 결과 점수, 연속 홈런·연속 안타 보너스(큰 쪽 하나), 끝내기 찬스 2배가 전광판으로 정해지고,
// 모르는 것은 정타 보너스뿐이다. 정타는 존 안 공(zoneMiss 0)의 안타에만 나와서(judge.js) 그 공들만 +100을 더할 수 있다.
// 예전 게임의 G(어떤 안타인지 모름)는 하한 없이 지금까지처럼 상한(maxScoreFor)만 본다
const HIT_POINTS = { S: POINTS.single, D: POINTS.double, T: POINTS.triple, H: POINTS.hr };
export function scoreRange(lights, seq) {
  if (lights.includes('G')) { const max = maxScoreFor(lights, seq); return max === null ? null : { min: 0, max }; }
  let left = CHANCES, min = 0, max = 0, hits = 0, hrs = 0;
  for (let i = 0; i < lights.length; i++) {
    const p = seq[i];
    if (!p || left === 0) return null;
    const c = lights[i], miss = zoneMiss(p), k = left === 1 ? 2 : 1;
    if (c === 'Y') {
      if (miss === 0) return null;
      min += POINTS.ball * k; max += POINTS.ball * k;
      continue;
    }
    left -= 1;
    if (c === 'R') { hits = 0; hrs = 0; continue; }
    if (!(c in HIT_POINTS) || miss > REACH_M) return null;
    hits += 1; hrs = c === 'H' ? hrs + 1 : 0;
    const bonus = c === 'H' ? Math.max(hrStreakBonus(hrs), hitStreakBonus(hits)) : hitStreakBonus(hits);
    min += (HIT_POINTS[c] + bonus) * k;
    max += (HIT_POINTS[c] + bonus + (miss === 0 ? PERFECT_BONUS : 0)) * k;
  }
  return left === 0 || lights.length === seq.length ? { min, max } : null;
}

export function maxScoreFor(lights, seq) {
  let left = CHANCES, total = 0, streak = 0;
  for (let i = 0; i < lights.length; i++) {
    const p = seq[i];
    if (!p || left === 0) return null;
    const c = lights[i], miss = zoneMiss(p), k = left === 1 ? 2 : 1;
    if (c === 'Y') {
      if (miss === 0) return null;
      total += POINTS.ball * k;
      continue;
    }
    if (c === 'G' && miss > REACH_M) return null;
    streak = c === 'G' ? streak + 1 : 0;
    total += (c === 'G' ? POINTS.hr + PERFECT_BONUS + hrStreakBonus(streak) : miss <= REACH_M ? PERFECT_BONUS : 0) * k;
    left -= 1;
  }
  return left === 0 || lights.length === seq.length ? total : null;
}
