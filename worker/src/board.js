// 주마다 사람별 요약을 JSON 한 줄로 모아 둔다(2026-11-04, D1 무료 읽기 하루 500만 줄 대비).
// 전에는 점수를 받을 때마다 그 주와 지난주 기록(사람 × 친 날)을 다 읽어서, 하루 이용자가 120~170명이면 한도를 넘을 만큼 읽었다.
// 이제 점수 한 번에 그 사람의 그 주 기록(7줄까지)과 요약 한 줄만 읽고, 랭킹은 요약 한 줄(지난주까지 두 줄)만 읽는다.
// 원본은 daily_scores이고 요약은 언제든 다시 만들 수 있다: 없거나 BOARD_TTL_MS가 지났으면 그 주 기록으로 다시 만든다
// (손으로 고친 기록도 저절로 맞춰진다). 요약 한 사람 몫은 [최고 기록, 그 기록을 낸 날의 팀, 친 날 수, 가장 최근 날, 그날 닉네임]
import { addDays, summarize } from './rules.js';

export const BOARD_TTL_MS = 6 * 3600e3;

const pathOf = (playerId) => `$."${playerId}"`;   // 사람 ID는 [a-z0-9-]뿐이라(validateSubmission) 그대로 JSON 경로에 넣는다
const toList = (players) => Object.entries(JSON.parse(players)).map(([id, [best, team, days, last, nick]]) => ({ id, best, team, days, last, nick }));

async function weekRows(db, week) {
  const { results } = await db.prepare('SELECT player_id, day, nick, team, score FROM daily_scores WHERE week = ?').bind(week).all();
  return results;
}

// 같은 사람·같은 날은 그날 가장 높은 판만 남긴다(주간 순위는 이번 주 최고 기록)
export const saveDaily = (db, s) => db.prepare(`INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (player_id, day) DO UPDATE SET score = excluded.score, lights = excluded.lights, nick = excluded.nick, team = excluded.team
  WHERE excluded.score > daily_scores.score`).bind(s.playerId, s.day, s.week, s.nick, s.team, s.score, s.lights);

// 요약에서 한 사람 몫을 그 주 기록으로 다시 계산해 넣는다(saveDaily와 같은 묶음 뒤에). SQL 안에서 계산해서 동시에 온 점수끼리 덮어쓰지 않는다.
// 팀·닉네임은 summarize와 같은 규칙: 최고 기록 가운데 먼저 넣은 줄의 팀, 가장 최근 날의 닉네임. 요약 줄이 아직 없으면 바꾸지 않는다(읽을 때 만든다)
export function updateBoard(db, week, playerId) {
  const range = [playerId, week, addDays(week, 6)];   // (player_id, day) 기본 키로 그 주 7일만 읽는다
  return db.prepare(`UPDATE weekly_boards SET players = json_set(players, ?, (
      SELECT json_array(MAX(score),
        (SELECT team FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? ORDER BY score DESC, rowid ASC LIMIT 1),
        COUNT(*), MAX(day),
        (SELECT nick FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ? ORDER BY day DESC LIMIT 1))
      FROM daily_scores WHERE player_id = ? AND day BETWEEN ? AND ?))
    WHERE week = ?`).bind(pathOf(playerId), ...range, ...range, ...range, week);
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
