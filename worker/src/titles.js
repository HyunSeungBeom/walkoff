// 칭호·업적(2026-11-05 유저 피드백, 규칙은 게임과 같은 js/core/titles.js). 10구 도전 판을 받을 때(/scores) 그 판의 전광판·공 순서·점수로
// 쌓는 수를 내 계정(accounts.counts, JSON)에 더하고, 정한 수에 닿은 칭호를 계정(accounts.titles, JSON 배열)에 더한다(2026-11-06부터 쌓아서 받는다).
// 같은 칭호는 한 번만 들어간다. 게임이 '받았다'고 알리는 방식은 꾸미기 쉬워서 쓰지 않는다
import { TITLE_IDS, countsOf, addCounts, cleanCounts, titlesFor, topTitle } from '../../js/core/titles.js';
import { pitcherHand } from '../../js/core/pitches.js';
import { seqOf } from './rules.js';
export { topTitle };

// 계정 칸의 값(JSON 글)을 칭호 id 목록(TITLES 순서)으로. 모르는 값·망가진 값은 버린다
export function titlesIn(raw) {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? TITLE_IDS.filter((id) => v.includes(id)) : []; } catch { return []; }
}
// 계정 칸의 값(JSON 글)을 쌓은 수로. 망가진 값은 빈 것으로
export function countsIn(raw) {
  try { return cleanCounts(JSON.parse(raw ?? '{}')); } catch { return {}; }
}
// 검사를 마친 10구 판(validateSubmission의 value: lights·seed·score)으로 쌓는 수
export const gameCounts = (s) => countsOf(s.lights, seqOf(s.seed), pitcherHand(s.seed) === 'L', s.score);

// 그 판에서 쌓은 수(inc)를 계정에 더하고, 닿은 칭호 가운데 처음 받는 것을 더해 { added: 새로 받은 것, titles: 받은 칭호 모두, counts: 쌓은 수 }를 돌려준다.
// 읽은 값 그대로일 때만 고쳐 써서, 같은 사람의 두 판이 동시에 와도 한쪽 수가 지워지지 않는다(어긋나면 다시 읽어 두 번 더)
export async function grantTitles(db, playerId, inc) {
  let have = [], counts = {};
  for (let k = 0; k < 3; k++) {
    const row = await db.prepare('SELECT titles, counts FROM accounts WHERE player_id = ?').bind(playerId).first();
    if (!row) return { added: [], titles: [], counts: {} };
    have = titlesIn(row.titles); counts = countsIn(row.counts);
    if (!Object.keys(cleanCounts(inc)).length) return { added: [], titles: have, counts };   // 쌓을 것이 없는 판(예전 게임 G)
    const next = addCounts(counts, inc), added = titlesFor(next).filter((id) => !have.includes(id));
    const titles = TITLE_IDS.filter((id) => have.includes(id) || added.includes(id));
    const r = await db.prepare('UPDATE accounts SET titles = ?, counts = ? WHERE player_id = ? AND counts = ? AND titles = ?')
      .bind(JSON.stringify(titles), JSON.stringify(next), playerId, row.counts, row.titles).run();
    if (r.meta.changes > 0) return { added, titles, counts: next };
  }
  return { added: [], titles: have, counts };
}
