// 팀 대항전(2026-11-23): 팀 점수는 팀원 최고 기록 위 5명(TEAM_TOP)의 합이고 같으면 친 사람이 많은 팀이 위다(rules.js rankSummary).
// 지난주 1등 팀에서 친 사람이 이번 주에도 그 팀으로 치면 /rankings 목록의 그 줄에 champ가 붙는다(index.js rankings, CHAMP_FROM 주부터)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { readBoard } from '../src/board.js';
import { rankSummary } from '../src/rules.js';
import { hidePlayer } from '../scripts/mod-sql.js';
import { CHAMP_FROM, TEAM_TOP } from '../../js/core/catalog.js';
import { memoryD1 } from './d1.js';

const summaryOf = (rows) => rows.map(([id, team, best]) => ({ id, team, best, days: 1, last: '2026-11-24', nick: id }));
const teamsOf = (r) => r.teams.map((t) => [t.rank, t.team, t.total, t.players]);
const put = (db, id, day, week, team, score) => db.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(id, day, week, id, team, score, 'SSSSSSSSSS').run();
const rankingAt = async (env, iso, query = '') => {
  const realNow = Date.now;
  Date.now = () => Date.parse(iso);
  try { return await (await worker.fetch(new Request(`https://api.test/rankings${query}`), env)).json(); } finally { Date.now = realNow; }
};

test('팀 점수는 팀원 최고 기록 위 5명의 합이고(넣은 순서와 상관없이), 5명이 안 되는 팀은 모두 더한다. 인원은 친 사람 모두이고 안 친 팀은 없다', () => {
  assert.equal(TEAM_TOP, 5);
  const lg = [3000, 9000, 4000, 8000, 7000, 5000, 6000].map((s, i) => [`lg-${i}`, 'lg', s]);   // 위 5명 9000+8000+7000+6000+5000
  const r = rankSummary(summaryOf([...lg, ['kt-0', 'kt', 20000], ['kt-1', 'kt', 10000]]), 'lg-0');
  assert.deepEqual(teamsOf(r), [[1, 'lg', 35000, 7], [2, 'kt', 30000, 2]]);   // 전에는 lg가 팀원 전부의 합 42,000
  assert.deepEqual(r.myTeam, { rank: 1, total: 35000, team: 'lg' });   // 위 5명에 못 든 사람(lg-0, 3000)도 팀 순위는 받는다
  assert.equal(r.players.length, 9);   // 사람 순위는 그대로 모두
});

test('팀 점수가 같으면 친 사람이 많은 팀이 위고, 점수와 인원이 모두 같으면 같은 등수다(끝 화면의 우리 팀 순위도 같다)', () => {
  const rows = [['a', 'kia', 6000], ['b', 'lg', 4000], ['c', 'lg', 2000], ['d', 'kt', 6000], ['e', 'doosan', 1000]];
  assert.deepEqual(teamsOf(rankSummary(summaryOf(rows), null)), [[1, 'lg', 6000, 2], [2, 'kia', 6000, 1], [2, 'kt', 6000, 1], [4, 'doosan', 1000, 1]]);
  assert.deepEqual(rankSummary(summaryOf(rows), 'c').myTeam, { rank: 1, total: 6000, team: 'lg' });
  assert.deepEqual(rankSummary(summaryOf(rows), 'd').myTeam, { rank: 2, total: 6000, team: 'kt' });
  // 6명 넘는 팀은 위 5명 합이 같아도 인원으로 앞선다
  const many = [...[5000, 5000, 5000, 5000, 5000, 100].map((s, i) => [`m-${i}`, 'ssg', s]), ...[5000, 5000, 5000, 5000, 5000].map((s, i) => [`n-${i}`, 'nc', s])];
  assert.deepEqual(teamsOf(rankSummary(summaryOf(many), null)), [[1, 'ssg', 25000, 6], [2, 'nc', 25000, 5]]);
});

test('숨긴 계정은 팀 점수와 인원에서 빠지고, 그 자리에 다음 팀원이 위 5명에 든다', async () => {
  const db = memoryD1(), WEEK = '2026-11-23', NOW = Date.parse('2026-11-25T03:00:00Z');
  for (const [i, s] of [9000, 8000, 7000, 6000, 5000, 4000].entries()) await put(db, `p-lg-000${i}`, '2026-11-24', WEEK, 'lg', s);
  await put(db, 'p-kt-0000', '2026-11-24', WEEK, 'kt', 32000);
  assert.deepEqual(teamsOf(rankSummary(await readBoard(db, WEEK, NOW), null)), [[1, 'lg', 35000, 6], [2, 'kt', 32000, 1]]);
  await db.batch(hidePlayer({ playerId: 'p-lg-0000', now: NOW }).map(({ sql, args }) => db.prepare(sql).bind(...args)));   // 운영 명령(npm run mod)과 같은 문장
  assert.deepEqual(teamsOf(rankSummary(await readBoard(db, WEEK, NOW), null)), [[1, 'kt', 32000, 1], [2, 'lg', 30000, 5]]);   // 8000+7000+6000+5000+4000
});

test('/rankings: 한국 시간 월요일 0시에 새 주가 되고, 지난주 1등 팀에서 친 사람이 이번 주에도 그 팀이면 champ. CHAMP_FROM(12-01 화) 전에는 표시가 없다', async () => {
  assert.equal(CHAMP_FROM, '2026-12-01');
  const env = { DB: memoryD1() };
  await put(env.DB, 'p-d1-0001', '2026-11-20', '2026-11-16', 'doosan', 3000);   // 11-16 주 1등은 두산(그 주 1등은 표시하지 않는다)
  await put(env.DB, 'p-d1-0001', '2026-11-24', '2026-11-23', 'doosan', 9000);
  await put(env.DB, 'p-d2-0001', '2026-11-29', '2026-11-23', 'doosan', 8000);   // 일요일 판
  await put(env.DB, 'p-l1-0001', '2026-11-25', '2026-11-23', 'lg', 10000);
  await put(env.DB, 'p-d1-0001', '2026-11-30', '2026-11-30', 'doosan', 5000);   // 그대로 두산: 표시
  await put(env.DB, 'p-d2-0001', '2026-11-30', '2026-11-30', 'lg', 7000);       // 지난주 두산이었는데 lg로 옮김: 표시 없음
  await put(env.DB, 'p-l1-0001', '2026-11-30', '2026-11-30', 'lg', 6000);       // 지난주 2등 팀
  await put(env.DB, 'p-n1-0001', '2026-11-30', '2026-11-30', 'doosan', 4000);   // 지난주에 안 친 두산 팬
  const sunday = await rankingAt(env, '2026-11-29T14:59:59Z');   // 한국 시간 11-29(일) 23:59:59
  assert.equal(sunday.week, '2026-11-23');
  assert.deepEqual(teamsOf(sunday), [[1, 'doosan', 17000, 2], [2, 'lg', 10000, 1]]);
  assert.deepEqual(sunday.players.map((p) => p.champ), [false, false, false]);   // 11-16 주 1등 두산 팬이 이번 주에도 두산이지만 CHAMP_FROM 전
  assert.ok(!('champs' in sunday.lastWeek));
  const monday = await rankingAt(env, '2026-11-30T14:59:59Z');   // 한국 시간 11-30(월) 23:59:59: 새 주지만 아직 CHAMP_FROM 전
  assert.equal(monday.week, '2026-11-30');
  assert.deepEqual(teamsOf(monday), [[1, 'lg', 13000, 2], [2, 'doosan', 9000, 2]]);   // 지난주 판은 안 든다
  assert.deepEqual([monday.lastWeek.team.team, 'champs' in monday.lastWeek, monday.players.some((p) => p.champ)], ['doosan', false, false]);
  const tuesday = await rankingAt(env, '2026-11-30T15:00:00Z');   // 한국 시간 12-01(화) 0시
  assert.deepEqual([tuesday.week, tuesday.lastWeek.champs], ['2026-11-30', ['doosan']]);
  assert.deepEqual(tuesday.players.map((p) => [p.nick, p.team, p.champ]), [['p-d2-0001', 'lg', false], ['p-l1-0001', 'lg', false], ['p-d1-0001', 'doosan', true], ['p-n1-0001', 'doosan', false]]);
  assert.ok(!('champs' in (await rankingAt(env, '2026-11-30T15:00:00Z', '?week=2026-11-23')).lastWeek));   // CHAMP_FROM이 든 주보다 앞 주는 그 뒤에 물어도 없다
});

test('/rankings: 지난주 1등 팀이 점수와 인원까지 같아 여럿이면 모두 champs이고, 지난주에 아무도 안 쳤으면 champs가 비어 있다', async () => {
  const env = { DB: memoryD1() };
  await put(env.DB, 'p-k1-0001', '2026-12-08', '2026-12-07', 'kia', 6000);
  await put(env.DB, 'p-t1-0001', '2026-12-09', '2026-12-07', 'kt', 6000);
  await put(env.DB, 'p-k1-0001', '2026-12-15', '2026-12-14', 'kia', 1000);
  await put(env.DB, 'p-t1-0001', '2026-12-15', '2026-12-14', 'kt', 2000);
  const r = await rankingAt(env, '2026-12-16T03:00:00Z');
  assert.deepEqual(r.lastWeek.champs, ['kia', 'kt']);
  assert.deepEqual(r.players.map((p) => [p.team, p.champ]), [['kt', true], ['kia', true]]);
  const next = await rankingAt(env, '2026-12-16T03:00:00Z', '?week=2026-12-21');   // 12-21 주의 지난주는 12-14 주(kt 1등)
  assert.deepEqual([next.lastWeek.champs, next.players], [['kt'], []]);
  const none = await rankingAt(env, '2026-12-16T03:00:00Z', '?week=2026-12-28');
  assert.deepEqual([none.lastWeek.team, none.lastWeek.champs, none.players], [null, [], []]);
});
