// 운영 명령(scripts/mod.mjs, 2026-11-19 공개 화면 지키기)이 보내는 SQL. 지우지 않고 숨긴다(daily_scores.hidden·accounts.hidden_at, migrations/0013).
// 주간 요약은 서버와 같은 문장으로 고치려고 board.js의 updateBoard·renameInBoards·removeFromBoards를 받아 적는 가짜 DB(take)에 불러 { sql, args }로 받는다.
// 테스트(test/mod.test.js)는 이 문장들을 테스트용 D1에 그대로 돌리고, mod.mjs는 값을 SQL에 넣어(inline) wrangler로 보낸다
import { removeFromBoards, renameInBoards, updateBoard } from '../src/board.js';
import { weekStart } from '../src/rules.js';

const take = { prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }) };
const stmt = (sql, ...args) => ({ sql, args });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// 대상: '#4821'(번호), '골든#4821'(닉네임과 번호가 둘 다 맞아야), 'id:계정ID'(계정이 없는 예전 기록도). 닉네임만 적으면 찾기(find)에만 쓴다
export function parseTarget(raw) {
  const s = String(raw ?? '').trim();
  let m;
  if ((m = /^id:([a-z0-9-]{8,40})$/.exec(s))) return { id: m[1] };
  if ((m = /^#(\d{4,5})$/.exec(s))) return { tag: Number(m[1]) };
  if ((m = /^(.+?)\s*#(\d{4,5})$/.exec(s))) return { nick: m[1].trim(), tag: Number(m[2]) };
  return s ? { nick: s } : null;
}

const ACCOUNT = 'SELECT player_id, nick, tag, team, games, hidden_at FROM accounts';
export function findSql(t) {
  if (t.id) return stmt(`${ACCOUNT} WHERE player_id = ?`, t.id);
  if (t.tag != null) return t.nick ? stmt(`${ACCOUNT} WHERE tag = ? AND nick = ?`, t.tag, t.nick) : stmt(`${ACCOUNT} WHERE tag = ?`, t.tag);
  return stmt(`${ACCOUNT} WHERE nick = ? ORDER BY games DESC, tag LIMIT 20`, t.nick);
}
// 그 사람의 판(그 주들만, 없으면 모두)
export const rowsSql = (playerId, weeks = []) => (weeks.length
  ? stmt(`SELECT day, week, nick, team, score, lights, hidden FROM daily_scores WHERE player_id = ? AND week IN (${weeks.map(() => '?').join(', ')}) ORDER BY day`, playerId, ...weeks)
  : stmt('SELECT day, week, nick, team, score, lights, hidden FROM daily_scores WHERE player_id = ? ORDER BY day', playerId));

// 숨길 범위: day(그날 판)나 week(그 주 판). 요약은 그 주의 그 사람 몫만 다시 센다(보이는 판이 없으면 요약에서 빠진다)
function scope({ week, day }) {
  if (day != null) { if (!DAY.test(day)) throw new Error(`날짜는 YYYY-MM-DD: ${day}`); return { col: 'day', value: day, week: weekStart(day) }; }
  if (!DAY.test(week ?? '')) throw new Error(`주는 그 주 월요일 YYYY-MM-DD: ${week}`);
  return { col: 'week', value: weekStart(week), week: weekStart(week) };
}
export function hideScores({ playerId, week, day }) {
  const s = scope({ week, day });
  return [stmt(`UPDATE daily_scores SET hidden = 1 WHERE player_id = ? AND ${s.col} = ? AND hidden = 0`, playerId, s.value), updateBoard(take, s.week, playerId)];
}
export function showScores({ playerId, week, day }) {
  const s = scope({ week, day });
  return [stmt(`UPDATE daily_scores SET hidden = 0 WHERE player_id = ? AND ${s.col} = ? AND hidden = 1`, playerId, s.value), updateBoard(take, s.week, playerId)];
}
// 닉네임 바꾸기는 PUT /me와 같다: 계정, 지난 기록, 모든 주의 요약. 게임은 다음에 열 때 계정 닉네임을 받아 간다(syncAccount)
export const resetNick = ({ playerId, nick }) => [
  stmt('UPDATE accounts SET nick = ? WHERE player_id = ?', nick, playerId),
  stmt('UPDATE daily_scores SET nick = ? WHERE player_id = ?', nick, playerId),
  renameInBoards(take, playerId, nick),
];
// 계정 숨김: 계정에 시각을 적고 아직 보이는 판을 모두 2로 숨기고 모든 주의 요약에서 뺀다. 풀면 2만 다시 보이고(따로 숨긴 판 1은 그대로),
// 그 사람이 있던 주의 요약은 지워서 다음에 읽을 때 다시 만든다
export const hidePlayer = ({ playerId, now }) => [
  stmt('UPDATE accounts SET hidden_at = ? WHERE player_id = ? AND hidden_at IS NULL', now, playerId),
  stmt('UPDATE daily_scores SET hidden = 2 WHERE player_id = ? AND hidden = 0', playerId),
  removeFromBoards(take, playerId),
];
export const showPlayer = ({ playerId }) => [
  stmt('UPDATE accounts SET hidden_at = NULL WHERE player_id = ?', playerId),
  stmt('UPDATE daily_scores SET hidden = 0 WHERE player_id = ? AND hidden = 2', playerId),
  stmt('DELETE FROM weekly_boards WHERE week IN (SELECT DISTINCT week FROM daily_scores WHERE player_id = ?)', playerId),
];
export const hiddenSql = () => [
  stmt('SELECT player_id, nick, tag, hidden_at FROM accounts WHERE hidden_at IS NOT NULL ORDER BY hidden_at DESC'),
  stmt('SELECT player_id, day, nick, score, hidden FROM daily_scores WHERE hidden != 0 ORDER BY day DESC LIMIT 50'),
];

// wrangler d1 execute --command는 값을 따로 받지 않아서 ?에 값을 글자로 넣는다(문장 안에 '?'가 든 글자는 없다). 글자는 작은따옴표를 두 번 써서 감싼다
export function inline({ sql, args }) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    const v = args[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`숫자가 아님: ${v}`); return String(v); }
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  if (i !== args.length) throw new Error(`값 수가 다름: ${sql}`);
  return out;
}
