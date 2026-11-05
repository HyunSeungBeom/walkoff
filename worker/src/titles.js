// 칭호·업적(2026-11-05 유저 피드백, 규칙은 게임과 같은 js/core/titles.js). 10구 도전 판을 받을 때(/scores) 그 판의 전광판으로 정해
// 계정(accounts.titles, JSON 배열)에 더한다. 같은 칭호는 한 번만 들어간다. 게임이 '받았다'고 알리는 방식은 꾸미기 쉬워서 쓰지 않는다
import { TITLE_IDS, titlesOf, topTitle } from '../../js/core/titles.js';
export { titlesOf, topTitle };

// 계정 칸의 값(JSON 글)을 칭호 id 목록(TITLES 순서)으로. 모르는 값·망가진 값은 버린다
export function titlesIn(raw) {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? TITLE_IDS.filter((id) => v.includes(id)) : []; } catch { return []; }
}

// 그 판(lights)으로 받은 칭호 가운데 처음 받는 것을 계정에 더하고 { added: 새로 받은 것, titles: 받은 칭호 모두 }를 돌려준다.
// 읽은 값 그대로일 때만 고쳐 써서, 같은 사람의 두 판이 동시에 와도 한쪽 칭호가 지워지지 않는다(어긋나면 다시 읽어 한 번 더)
export async function grantTitles(db, playerId, lights) {
  const earned = titlesOf(lights);
  let have = [];
  for (let k = 0; k < 3; k++) {
    const row = await db.prepare('SELECT titles FROM accounts WHERE player_id = ?').bind(playerId).first();
    if (!row) return { added: [], titles: [] };
    have = titlesIn(row.titles);
    const added = earned.filter((id) => !have.includes(id));
    if (!added.length) return { added, titles: have };
    const titles = TITLE_IDS.filter((id) => have.includes(id) || added.includes(id));
    const r = await db.prepare('UPDATE accounts SET titles = ? WHERE player_id = ? AND titles = ?').bind(JSON.stringify(titles), playerId, row.titles).run();
    if (r.meta.changes > 0) return { added, titles };
  }
  return { added: [], titles: have };
}
