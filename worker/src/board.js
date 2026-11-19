// 주마다 사람별 요약을 JSON 한 줄로 모아 둔다(2026-11-04, D1 무료 읽기 하루 500만 줄 대비).
// 전에는 점수를 받을 때마다 그 주와 지난주 기록(사람 × 친 날)을 다 읽어서, 하루 이용자가 120~170명이면 한도를 넘을 만큼 읽었다.
// 이제 점수 한 번에 그 사람의 그 주 기록(7줄까지)과 요약 한 줄만 읽고, 랭킹은 요약 한 줄(지난주까지 두 줄)만 읽는다.
// 원본은 daily_scores이고 요약은 언제든 다시 만들 수 있다: 없거나 BOARD_TTL_MS가 지났으면 그 주 기록으로 다시 만든다
// (손으로 고친 기록도 저절로 맞춰진다). 요약 한 사람 몫은 [최고 기록, 그 기록을 낸 날의 팀, 친 날 수, 가장 최근 날, 그날 닉네임]
import { addDays, summarize } from './rules.js';

export const BOARD_TTL_MS = 6 * 3600e3;

const pathOf = (playerId) => `$."${playerId}"`;   // 사람 ID는 [a-z0-9-]뿐이라(validateSubmission) 그대로 JSON 경로에 넣는다
const toList = (players) => Object.entries(JSON.parse(players)).map(([id, [best, team, days, last, nick]]) => ({ id, best, team, days, last, nick }));

// 숨긴 판(hidden, 2026-11-19 공개 화면 지키기)은 요약에 넣지 않는다. 주간 순위와 팀 순위가 모두 이 요약으로 매기므로 둘 다에서 한 번에 빠진다
async function weekRows(db, week) {
  const { results } = await db.prepare('SELECT player_id, day, nick, team, score FROM daily_scores WHERE week = ? AND hidden = 0').bind(week).all();
  return results;
}

// 같은 사람·같은 날은 그날 가장 높은 판만 남긴다(주간 순위는 이번 주 최고 기록). play는 그 판을 다시 돌릴 재료(2026-11-19 rules.js, 타이밍 없이 온 판은 NULL)
export const saveDaily = (db, s) => db.prepare(`INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights, play) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (player_id, day) DO UPDATE SET score = excluded.score, lights = excluded.lights, play = excluded.play, nick = excluded.nick, team = excluded.team
  WHERE excluded.score > daily_scores.score`).bind(s.playerId, s.day, s.week, s.nick, s.team, s.score, s.lights, s.play ?? null);

// 요약에서 한 사람 몫을 그 주 기록으로 다시 계산해 넣는다(saveDaily와 같은 묶음 뒤에). SQL 안에서 계산해서 동시에 온 점수끼리 덮어쓰지 않는다.
// 팀·닉네임은 summarize와 같은 규칙: 최고 기록 가운데 먼저 넣은 줄의 팀, 가장 최근 날의 닉네임. 요약 줄이 아직 없으면 바꾸지 않는다(읽을 때 만든다).
// 숨긴 판은 빼고 세고, 그 주에 보이는 판이 하나도 없으면(그날 숨긴 판보다 낮은 점수만 보냈다) 요약에서 뺀다.
// 하위 질의에서 나온 json_array 값은 json()으로 한 번 더 감싼다. 새 SQLite(Node 24.22.3에 든 것)는 하위 질의를 지나면 JSON 표시를 잃어서
// json_set이 배열 대신 따옴표 친 글자로 넣었다(요약을 읽으면 최고 기록이 '[' 한 글자, 2026-11-19 CI). D1이 SQLite를 올려도 같게 돈다
export function updateBoard(db, week, playerId) {
  const range = [playerId, week, addDays(week, 6)];   // (player_id, day) 기본 키로 그 주 7일만 읽는다
  return db.prepare(`UPDATE weekly_boards SET players = CASE
      WHEN EXISTS (SELECT 1 FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? AND hidden = 0) THEN json_set(players, ?, json((
        SELECT json_array(MAX(score),
          (SELECT team FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? AND hidden = 0 ORDER BY score DESC, rowid ASC LIMIT 1),
          COUNT(*), MAX(day),
          (SELECT nick FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? AND hidden = 0 ORDER BY day DESC LIMIT 1))
        FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? AND hidden = 0)))
      ELSE json_remove(players, ?) END
    WHERE week = ?`).bind(...range, pathOf(playerId), ...range, ...range, ...range, pathOf(playerId), week);
}

// 한 주의 요약(사람마다 { id, best, team, days, last, nick }, 처음 친 순서). 없거나 오래됐으면 그 주 기록으로 다시 만들어 남긴다
export async function readBoard(db, week, now) {
  const row = await db.prepare('SELECT players, built_at FROM weekly_boards WHERE week = ?').bind(week).first();
  if (row && now - row.built_at < BOARD_TTL_MS) return toList(row.players);
  const list = summarize(await weekRows(db, week));
  const players = JSON.stringify(Object.fromEntries(list.map((p) => [p.id, [p.best, p.team, p.days, p.last, p.nick]])));
  await db.prepare(`INSERT INTO weekly_boards (week, players, built_at) VALUES (?, ?, ?)
    ON CONFLICT (week) DO UPDATE SET players = excluded.players, built_at = excluded.built_at`).bind(week, players, now).run();
  return list;
}

// 닉네임을 바꾸면 지난 기록에도 고쳐 쓰므로(PUT /me) 요약에서도 바꾼다. 기록을 지우면(DELETE /me) 모든 주의 요약에서 뺀다
export const renameInBoards = (db, playerId, nick) => db.prepare('UPDATE weekly_boards SET players = json_set(players, ?, ?) WHERE json_type(players, ?) IS NOT NULL')
  .bind(`${pathOf(playerId)}[4]`, nick, pathOf(playerId));
export const removeFromBoards = (db, playerId) => db.prepare('UPDATE weekly_boards SET players = json_remove(players, ?) WHERE json_type(players, ?) IS NOT NULL')
  .bind(pathOf(playerId), pathOf(playerId));
