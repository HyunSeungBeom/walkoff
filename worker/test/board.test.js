// 주간 요약(board.js): 점수를 받을 때마다 고친 요약으로 매긴 순위가 그 주 기록 전체로 매긴 순위(예전 방식)와 같은지 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TTL_MS, readBoard, removeFromBoards, renameInBoards, saveDaily, updateBoard } from '../src/board.js';
import { addDays, aggregate, rankSummary, TEAM_IDS } from '../src/rules.js';
import { mulberry32 } from '../../js/core/math.js';
import { memoryD1 } from './d1.js';

const WEEK = '2026-11-02', NOW = Date.parse('2026-11-05T03:00:00Z');
const rowsOf = (db, week) => db.rows('SELECT player_id, day, nick, team, score FROM daily_scores WHERE week = ?', week);
const send = (db, s) => db.batch([saveDaily(db, { week: WEEK, lights: 'G', ...s }), updateBoard(db, WEEK, s.playerId)]);
const same = async (db, ids, what) => {
  const list = await readBoard(db, WEEK, NOW), rows = rowsOf(db, WEEK);
  for (const id of [null, ...ids]) assert.deepEqual(rankSummary(list, id, { withIds: true }), aggregate(rows, id, { withIds: true }), `${what} · ${id}`);
};

test('점수를 받을 때마다 고친 주간 요약은 그 주 기록 전체로 매긴 순위와 같다(같은 날 낮은 점수, 늦게 온 앞날 기록, 팀·닉네임 바꾸기)', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const db = memoryD1(), rnd = mulberry32(seed), pick = (a) => a[Math.floor(rnd() * a.length)];
    const ids = Array.from({ length: 12 }, (_, i) => `p-test-${String(i).padStart(4, '0')}`);
    await readBoard(db, WEEK, NOW);   // 빈 요약을 먼저 만들어 두고 점수마다 고친다(updateBoard)
    for (let i = 0; i < 300; i++) {
      const playerId = pick(ids), day = addDays(WEEK, Math.floor(rnd() * 7));
      await send(db, { playerId, day, team: pick(TEAM_IDS), nick: pick(['가람', '나래', '다온', '라온']) + playerId.slice(-2), score: 100 * Math.floor(rnd() * 60) });
      if (i % 25 === 24) await same(db, ids, `시드 ${seed} · ${i + 1}번째 점수`);
    }
    const renamed = pick(ids);   // 닉네임 바꾸기는 지난 기록과 요약을 같이 고친다(PUT /me)
    await db.batch([db.prepare('UPDATE daily_scores SET nick = ? WHERE player_id = ?').bind('새이름', renamed), renameInBoards(db, renamed, '새이름')]);
    await same(db, ids, `시드 ${seed} · 닉네임 바꾼 뒤`);
    const gone = pick(ids.filter((id) => id !== renamed));   // 기록 지우기(DELETE /me)
    await db.batch([db.prepare('DELETE FROM daily_scores WHERE player_id = ?').bind(gone), removeFromBoards(db, gone)]);
    await same(db, ids, `시드 ${seed} · 기록 지운 뒤`);
    assert.ok(!db.rows('SELECT players FROM weekly_boards')[0].players.includes(gone));
  }
});

test('요약이 없거나 6시간이 지나면 그 주 기록으로 다시 만든다(손으로 고친 기록도 맞춰진다)', async () => {
  const db = memoryD1(), legacy = { playerId: 'p-legacy-0001', day: WEEK, team: 'kt', nick: '다온', score: 3000 };
  await db.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(legacy.playerId, legacy.day, WEEK, legacy.nick, legacy.team, legacy.score, 'G').run();
  assert.deepEqual((await readBoard(db, WEEK, NOW)).map((p) => [p.id, p.best]), [['p-legacy-0001', 3000]]);   // 처음 읽을 때 만든다
  await db.prepare('UPDATE daily_scores SET score = 9000 WHERE player_id = ?').bind(legacy.playerId).run();   // 손으로 고침(요약은 모른다)
  assert.equal((await readBoard(db, WEEK, NOW + BOARD_TTL_MS - 1))[0].best, 3000);
  assert.equal((await readBoard(db, WEEK, NOW + BOARD_TTL_MS))[0].best, 9000);   // 6시간이 지나 다시 만들었다
  await db.prepare('UPDATE daily_scores SET score = 7000 WHERE player_id = ?').bind(legacy.playerId).run();
  await db.prepare('DELETE FROM weekly_boards WHERE week = ?').bind(WEEK).run();   // 요약 줄을 지우면 바로 다시 만든다
  assert.equal((await readBoard(db, WEEK, NOW + BOARD_TTL_MS))[0].best, 7000);
  await send(db, { playerId: 'p-test-0001', day: WEEK, team: 'lg', nick: '가람', score: 100 });   // 요약이 없는 주는 고치지 않고 읽을 때 만든다
  assert.deepEqual((await readBoard(db, addDays(WEEK, 7), NOW)), []);
});

test('기록을 지우면 지난 주들의 요약에서도 빠진다(다른 사람 몫은 그대로)', async () => {
  const db = memoryD1(), weeks = [WEEK, addDays(WEEK, -7), addDays(WEEK, -14)];
  for (const week of weeks) for (const playerId of ['p-test-0001', 'p-test-0002']) {
    await db.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(playerId, week, week, '이름', 'lg', 1000, 'G').run();
  }
  for (const week of weeks) await readBoard(db, week, NOW);
  await db.batch([db.prepare('DELETE FROM daily_scores WHERE player_id = ?').bind('p-test-0001'), removeFromBoards(db, 'p-test-0001')]);
  for (const week of weeks) assert.deepEqual((await readBoard(db, week, NOW)).map((p) => p.id), ['p-test-0002'], week);
  assert.ok(db.rows('SELECT players FROM weekly_boards').every((r) => !r.players.includes('p-test-0001')));
});
