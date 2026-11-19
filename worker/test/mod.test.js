// 운영 명령(scripts/mod-sql.js, 2026-11-19 공개 화면 지키기): 숨기고 풀면 주간 요약(랭킹)이 바로 따라오는지, 다른 사람 몫은 그대로인지 본다.
// mod.mjs가 wrangler로 보내는 문장과 같은 문장을 테스트용 D1에 돌린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoard } from '../src/board.js';
import { addDays, rankSummary } from '../src/rules.js';
import { hidePlayer, hideScores, inline, parseTarget, resetNick, rowsSql, showPlayer, showScores, findSql } from '../scripts/mod-sql.js';
import { memoryD1 } from './d1.js';

const WEEK = '2026-11-16', LAST = addDays(WEEK, -7), NOW = Date.parse('2026-11-19T03:00:00Z');
const run = (db, list) => db.batch(list.map(({ sql, args }) => db.prepare(sql).bind(...args)));
const board = async (db, week = WEEK) => rankSummary(await readBoard(db, week, NOW), null).players.map((p) => [p.nick, p.best]);
const teams = async (db) => rankSummary(await readBoard(db, WEEK, NOW), null).teams.map((t) => [t.team, t.total]);

// 조작한 사람(p-cheat): 이번 주 월요일 정상 판, 화요일 꾸민 판, 지난주 판. 다른 두 사람은 이번 주 한 판씩
async function seeded() {
  const db = memoryD1();
  await db.prepare("INSERT INTO accounts (kakao_key, player_id, nick, team, tag) VALUES ('k1', 'p-cheat-0001', '골든', 'lg', 4821), ('k2', 'p-good-0001', '가람', 'lg', 77), ('k3', 'p-good-0002', '나래', 'kt', 1234)").run();
  const put = (id, day, nick, team, score) => db.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, day, day >= WEEK ? WEEK : LAST, nick, team, score, 'SSSSSSSSSS').run();
  await put('p-cheat-0001', WEEK, '골든', 'lg', 2000);
  await put('p-cheat-0001', addDays(WEEK, 1), '골든', 'lg', 15100);
  await put('p-cheat-0001', LAST, '골든', 'lg', 9000);
  await put('p-good-0001', WEEK, '가람', 'lg', 4000);
  await put('p-good-0002', addDays(WEEK, 2), '나래', 'kt', 3000);
  await put('p-good-0002', LAST, '나래', 'kt', 1000);
  await readBoard(db, WEEK, NOW); await readBoard(db, LAST, NOW);   // 요약을 먼저 만들어 둔다(운영 명령은 있는 요약을 고친다)
  return db;
}

test('대상 고르기: #번호, 닉네임#번호, id:계정ID, 닉네임만(찾기에만)', () => {
  assert.deepEqual(parseTarget('#4821'), { tag: 4821 });
  assert.deepEqual(parseTarget('#0077'), { tag: 77 });
  assert.deepEqual(parseTarget(' 골든 #4821 '), { nick: '골든', tag: 4821 });
  assert.deepEqual(parseTarget('id:p-cheat-0001'), { id: 'p-cheat-0001' });
  assert.deepEqual(parseTarget('골든'), { nick: '골든' });
  assert.equal(parseTarget(''), null);
  assert.deepEqual(parseTarget('id:Bad ID'), { nick: 'id:Bad ID' });   // 계정 ID 꼴이 아니면 닉네임으로 보고 바꾸는 명령은 거절한다(mod.mjs onePlayer)
});

test('wrangler로 보낼 때 값을 SQL 글자로 넣는다: 작은따옴표는 두 번, null은 NULL, 값 수가 다르면 멈춘다', () => {
  assert.equal(inline(findSql({ nick: "골'든" })), "SELECT player_id, nick, tag, team, games, hidden_at FROM accounts WHERE nick = '골''든' ORDER BY games DESC, tag LIMIT 20");
  assert.equal(inline({ sql: 'UPDATE a SET x = ?, y = ? WHERE id = ?', args: [null, 3, 'p'] }), "UPDATE a SET x = NULL, y = 3 WHERE id = 'p'");
  assert.throws(() => inline({ sql: 'SELECT ?', args: [] }));
  assert.throws(() => inline({ sql: 'SELECT ?', args: [NaN] }));
  for (const list of [hideScores({ playerId: 'p-x-0001', week: WEEK }), hidePlayer({ playerId: 'p-x-0001', now: NOW }), resetNick({ playerId: 'p-x-0001', nick: '타자1234' })]) {
    for (const s of list) assert.doesNotThrow(() => inline(s));   // 모든 문장의 ?와 값 수가 맞다
  }
  assert.throws(() => hideScores({ playerId: 'p-x-0001', day: '11-19' }));
});

test('판 숨김: 이번 주 판을 숨기면 랭킹과 팀 점수에서 바로 빠지고, 풀면 돌아온다. 지난주와 다른 사람 몫은 그대로', async () => {
  const db = await seeded();
  assert.deepEqual(await board(db), [['골든', 15100], ['가람', 4000], ['나래', 3000]]);
  await run(db, hideScores({ playerId: 'p-cheat-0001', week: WEEK }));
  assert.deepEqual(await board(db), [['가람', 4000], ['나래', 3000]]);
  assert.deepEqual(await teams(db), [['lg', 4000], ['kt', 3000]]);
  assert.deepEqual(await board(db, LAST), [['골든', 9000], ['나래', 1000]]);
  assert.deepEqual(db.rows("SELECT day, hidden FROM daily_scores WHERE player_id = 'p-cheat-0001' ORDER BY day"), [{ day: LAST, hidden: 0 }, { day: WEEK, hidden: 1 }, { day: addDays(WEEK, 1), hidden: 1 }]);
  await run(db, showScores({ playerId: 'p-cheat-0001', week: WEEK }));
  assert.deepEqual(await board(db), [['골든', 15100], ['가람', 4000], ['나래', 3000]]);
  // 그날 판 하나만(--day): 꾸민 화요일 판만 숨기면 월요일 정상 판으로 남는다
  await run(db, hideScores({ playerId: 'p-cheat-0001', day: addDays(WEEK, 1) }));
  assert.deepEqual(await board(db), [['가람', 4000], ['나래', 3000], ['골든', 2000]]);
  // 요약을 다시 만들어도(6시간 뒤) 같다
  await db.prepare('DELETE FROM weekly_boards').run();
  assert.deepEqual(await board(db), [['가람', 4000], ['나래', 3000], ['골든', 2000]]);
});

test('계정 숨김: 모든 주에서 빠지고, 풀면 계정 숨김에 딸린 판만 돌아온다(따로 숨긴 판은 그대로)', async () => {
  const db = await seeded();
  await run(db, hideScores({ playerId: 'p-cheat-0001', day: addDays(WEEK, 1) }));   // 꾸민 판 하나는 먼저 숨겨 두었다
  await run(db, hidePlayer({ playerId: 'p-cheat-0001', now: NOW }));
  assert.deepEqual(await board(db), [['가람', 4000], ['나래', 3000]]);
  assert.deepEqual(await board(db, LAST), [['나래', 1000]]);
  assert.equal(db.rows("SELECT hidden_at FROM accounts WHERE player_id = 'p-cheat-0001'")[0].hidden_at, NOW);
  await run(db, hidePlayer({ playerId: 'p-cheat-0001', now: NOW + 1 }));   // 두 번 숨겨도 처음 시각 그대로
  assert.equal(db.rows("SELECT hidden_at FROM accounts WHERE player_id = 'p-cheat-0001'")[0].hidden_at, NOW);
  await run(db, showPlayer({ playerId: 'p-cheat-0001' }));
  assert.equal(db.rows("SELECT hidden_at FROM accounts WHERE player_id = 'p-cheat-0001'")[0].hidden_at, null);
  assert.deepEqual(await board(db), [['가람', 4000], ['나래', 3000], ['골든', 2000]]);   // 꾸민 판(1)은 숨긴 채
  assert.deepEqual(await board(db, LAST), [['골든', 9000], ['나래', 1000]]);
  assert.deepEqual(db.rows("SELECT hidden FROM daily_scores WHERE player_id = 'p-cheat-0001' ORDER BY day").map((r) => r.hidden), [0, 0, 1]);
});

test('닉네임 기본값으로: 계정·지난 기록·모든 주의 요약이 같이 바뀐다(PUT /me와 같은 문장)', async () => {
  const db = await seeded();
  await run(db, resetNick({ playerId: 'p-cheat-0001', nick: '타자5555' }));
  assert.deepEqual(await board(db), [['타자5555', 15100], ['가람', 4000], ['나래', 3000]]);
  assert.deepEqual(await board(db, LAST), [['타자5555', 9000], ['나래', 1000]]);
  assert.deepEqual(db.rows("SELECT DISTINCT nick FROM daily_scores WHERE player_id = 'p-cheat-0001'"), [{ nick: '타자5555' }]);
  assert.equal(db.rows("SELECT nick FROM accounts WHERE player_id = 'p-cheat-0001'")[0].nick, '타자5555');
  assert.deepEqual(db.rows("SELECT DISTINCT nick FROM daily_scores WHERE player_id != 'p-cheat-0001' ORDER BY nick").map((r) => r.nick), ['가람', '나래']);
});

test('찾기 문장: 번호·닉네임#번호·id·닉네임, 판 목록은 그 주들만', async () => {
  const db = await seeded();
  const one = (t) => db.rows(findSql(t).sql, ...findSql(t).args).map((a) => a.player_id);
  assert.deepEqual(one({ tag: 4821 }), ['p-cheat-0001']);
  assert.deepEqual(one({ nick: '골든', tag: 4821 }), ['p-cheat-0001']);
  assert.deepEqual(one({ nick: '가람', tag: 4821 }), []);   // 닉네임과 번호가 다른 사람
  assert.deepEqual(one({ id: 'p-good-0002' }), ['p-good-0002']);
  assert.deepEqual(one({ nick: '나래' }), ['p-good-0002']);
  const rows = rowsSql('p-cheat-0001', [WEEK]);
  assert.deepEqual(db.rows(rows.sql, ...rows.args).map((r) => r.score), [2000, 15100]);
});
