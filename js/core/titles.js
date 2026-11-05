// 칭호·업적(2026-11-05 유저 피드백 '칭호·업적과 랭킹에 칭호 표시', 사용자 승인 계획 ~/.claude/plans/walkoff-feedback-123.md).
// 10구 도전 한 판의 전광판(lights, 공마다 S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R 그 밖)만으로 정한다. 랭킹 서버(worker /scores)가 판마다 정해 계정에 남기고,
// 로그인 안 했으면 게임이 이 기기에서 같은 함수로 정한다. 연속은 게임 점수 규칙(연속 홈런·연속 안타)처럼 골라낸 볼(Y)은 끊지 않고 다른 결과는 끊는다.
// 예전 게임의 G(어떤 안타인지 모름)로는 안타 종류가 드는 칭호를 줄 수 없다. 목록 순서가 랭킹에 보이는 대표 칭호(topTitle)의 우선순위다.
// short는 폰 랭킹 줄의 배지(2~4글자)
import { CHANCES } from './score.js';

export const TITLES = [
  { id: 'cycle', name: '사이클링 히트', short: '사이클', desc: '한 판에 단타·2루타·3루타·홈런' },
  { id: 'hrking', name: '홈런왕', short: '홈런왕', desc: '한 판에 연속 홈런 5번' },
  { id: 'walkoff', name: '끝내기 홈런', short: '끝내기', desc: '마지막 기회(끝내기 찬스)에 홈런' },
  { id: 'eye', name: '선구안', short: '선구안', desc: '한 판에 볼 5개 골라내기' },
  { id: 'firsthr', name: '첫 홈런', short: '첫 홈런', desc: '홈런 1번' },
  { id: 'outking', name: '아웃왕', short: '아웃왕', desc: '한 판에 연속 아웃 5번' },
];
export const TITLE_IDS = TITLES.map((t) => t.id);
export const titleById = (id) => TITLES.find((t) => t.id === id) ?? null;

// 연속 기록: 볼은 건너뛰고 code가 이어지는 가장 긴 길이(다른 결과가 나오면 끊는다)
function longestRun(lights, code) {
  let best = 0, n = 0;
  for (const c of lights) { if (c === 'Y') continue; n = c === code ? n + 1 : 0; best = Math.max(best, n); }
  return best;
}

// 한 판의 전광판으로 받은 칭호 id들(TITLES 순서)
export function titlesOf(lights) {
  const s = String(lights ?? ''), has = (c) => s.includes(c), got = new Set();
  if (has('S') && has('D') && has('T') && has('H')) got.add('cycle');
  if (longestRun(s, 'H') >= 5) got.add('hrking');
  let left = CHANCES;   // 마지막 기회(남은 기회 1번)에 친 공이 홈런. 볼은 기회를 쓰지 않는다
  for (const c of s) { if (c === 'Y') continue; if (left === 1 && c === 'H') got.add('walkoff'); left -= 1; if (left <= 0) break; }
  if ([...s].filter((c) => c === 'Y').length >= 5) got.add('eye');
  if (has('H')) got.add('firsthr');
  if (longestRun(s, 'R') >= 5) got.add('outking');
  return TITLE_IDS.filter((id) => got.has(id));
}

// 받은 칭호 가운데 가장 앞(우선순위가 높은) 것. 없으면 null
export const topTitle = (ids) => TITLE_IDS.find((id) => (ids ?? []).includes(id)) ?? null;
