import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstDay, addDays, weekStart, TEAM_IDS } from '../src/rules.js';
import { styleOn } from '../../js/core/pitches.js';
import { STYLE_NAMES } from '../../js/view/text.js';
import { deviceBackSql, playerBackSql, duelSql, weeklySql, withStyle, funnelSql, pathSql, buildSql, quitSql, GAMES_SQL, limits, table } from '../scripts/stats-tables.js';
import { STEPS } from '../src/stats.js';
import { memoryD1 } from './d1.js';

// npm run stats에 더한 표(2026-11-18 통계 보강, scripts/stats-tables.js). 날짜는 오늘(한국 시간)에서 며칠 전으로 넣는다
const today = kstDay(Date.now()), ago = (n) => addDays(today, -n);
const seen = (db, device, ...days) => Promise.all(days.map((day) => db.prepare('INSERT INTO play_devices (day, device, mobile, events) VALUES (?, ?, 1, 14)').bind(day, device).run()));
const played = (db, day, mode, starts, ends) => db.prepare('INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, ?, ?)').bind(day, mode, starts, ends).run();
const scored = (db, player, day, score) => db.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(player, day, weekStart(day), '골든', TEAM_IDS[0], score, 'SRDRRYRRHRR').run();

test('다시 온 비율(기기): 날짜마다 온 기기 가운데 다음 날·7일 안에 다시 온 비율, 그날 처음 온 기기는 따로. 안 끝난 기간은 *, 오늘은 빈칸', async () => {
  const db = memoryD1();
  await seen(db, 'd-device-0001', ago(9), ago(8));    // 다음 날 다시
  await seen(db, 'd-device-0002', ago(9), ago(3));    // 6일 뒤 다시(7일 안)
  await seen(db, 'd-device-0003', ago(9), ago(1));    // 8일 뒤라 7일 안이 아니다
  await seen(db, 'd-device-0004', ago(20), ago(9));   // 범위(14일) 앞에 온 적이 있어서 새 기기가 아니다
  await seen(db, 'd-device-0005', ago(1), today);     // 어제 처음 와서 오늘 다시(오늘이 안 끝나서 *)
  const blank = { '다음 날': '', '7일 안': '' }, noNew = { '새 기기': 0, '그중 다음 날': '', '그중 7일 안': '' };
  assert.deepEqual(db.rows(deviceBackSql()), [
    { 날짜: today, 기기: 1, ...blank, ...noNew },
    { 날짜: ago(1), 기기: 2, '다음 날': '50% (1)*', '7일 안': '50% (1)*', '새 기기': 1, '그중 다음 날': '100% (1)*', '그중 7일 안': '100% (1)*' },
    { 날짜: ago(3), 기기: 1, '다음 날': '0% (0)', '7일 안': '0% (0)*', ...noNew },
    { 날짜: ago(8), 기기: 1, '다음 날': '0% (0)', '7일 안': '0% (0)', ...noNew },
    { 날짜: ago(9), 기기: 4, '다음 날': '25% (1)', '7일 안': '50% (2)', '새 기기': 3, '그중 다음 날': '33% (1)', '그중 7일 안': '67% (2)' },
  ]);
  assert.deepEqual(db.rows(deviceBackSql(9)).map((r) => r['날짜']), [today, ago(1), ago(3), ago(8)]);   // --days 9
});

test('다시 온 비율(로그인 계정): 10구 랭킹 점수를 낸 날로 같은 규칙으로 센다', async () => {
  const db = memoryD1();
  await scored(db, 'p-0001', ago(5), 1200);
  await scored(db, 'p-0001', ago(4), 900);
  await scored(db, 'p-0002', ago(5), 15000);
  await scored(db, 'p-0003', ago(30), 800);   // 전에 낸 적이 있어서 처음 낸 사람이 아니다
  await scored(db, 'p-0003', ago(5), 2000);
  const rows = db.rows(playerBackSql());
  assert.deepEqual(rows.map((r) => r['날짜']), [ago(4), ago(5)]);
  assert.deepEqual(rows[1], { 날짜: ago(5), '낸 사람': 3, '다음 날': '33% (1)', '7일 안': '33% (1)*', '처음 낸 사람': 2, '그중 다음 날': '50% (1)', '그중 7일 안': '50% (1)*' });
});

test('도전장 표: 날짜마다 보낸 수 → 도전장 판 → 끝까지, 맨 아래 합계. 다른 모드와 범위 밖 날은 세지 않는다', async () => {
  const db = memoryD1();
  assert.deepEqual(db.rows(duelSql()), []);   // 도전장이 없으면 합계 줄도 없다
  await played(db, ago(2), 'invite', 2, 0);
  await played(db, ago(2), 'duel', 3, 2);
  await played(db, ago(2), 'challenge', 9, 5);
  await played(db, ago(1), 'invite', 1, 0);
  await played(db, today, 'duel', 1, 0);
  await played(db, ago(20), 'invite', 5, 0);
  assert.deepEqual(db.rows(duelSql()), [
    { 날짜: today, 보냄: 0, '도전장 판': 1, 끝까지: 0, '판/보냄': '', '끝까지%': '0%' },
    { 날짜: ago(1), 보냄: 1, '도전장 판': 0, 끝까지: 0, '판/보냄': '0.0', '끝까지%': '' },
    { 날짜: ago(2), 보냄: 2, '도전장 판': 3, 끝까지: 2, '판/보냄': '1.5', '끝까지%': '67%' },
    { 날짜: '합계', 보냄: 3, '도전장 판': 4, 끝까지: 2, '판/보냄': '1.3', '끝까지%': '50%' },
  ]);
});

test('주별 요약: 월~일로 묶어 기기·새 기기·다음 날, 10구와 끝까지 친 비율, 랭킹 낸 사람과 사람마다 그 주 최고의 평균·1등. 이번 주는 *', async () => {
  const db = memoryD1(), mon = weekStart(today), w2 = addDays(mon, -14);   // 두 주 전은 다음 날까지 모두 끝났다
  await seen(db, 'd-device-0001', w2, addDays(w2, 1));
  await seen(db, 'd-device-0002', addDays(w2, 6));   // 일요일도 그 주
  await seen(db, 'd-device-0003', mon);
  await played(db, w2, 'challenge', 10, 7);
  await played(db, addDays(w2, 6), 'invite', 4, 0);   // 판이 아니다
  await played(db, mon, 'challenge', 4, 1);
  await scored(db, 'p-0001', w2, 1200);
  await scored(db, 'p-0001', addDays(w2, 1), 1500);
  await scored(db, 'p-0002', addDays(w2, 3), 900);
  const [now, old, ...rest] = db.rows(weeklySql());
  assert.equal(rest.length, 0);   // 기기가 없는 주(지난주)는 줄이 없다
  assert.deepEqual(old, { 주: w2, 기기: 2, '새 기기': 2, '다음 날': '33%', '10구': 10, 끝까지: '70%', '랭킹 사람': 2, '최고 평균': 1200, '1등': 1500 });
  assert.deepEqual([now['주'], now['기기'], now['새 기기'], now['10구'], now['끝까지'], now['랭킹 사람'], now['1등']], [`${mon}*`, 1, 1, 4, '25%', 0, null]);
});

// 첫 주 숫자(2026-11-19): 처음 온 기기의 첫날 줄(play_devices.path·steps)과 10구 판의 끝맺음(build_stats, 게임 판별)
const { open, swing, end, again } = STEPS;
const arrived = (db, device, day, path, steps) => db.prepare('INSERT INTO play_devices (day, device, mobile, events, path, steps) VALUES (?, ?, 1, 3, ?, ?)').bind(day, device, path, steps).run();
const tenGames = (db, day, build, mode, [starts, ends, restarts, leaves, backs]) => db.prepare('INSERT INTO build_stats (day, build, mode, starts, ends, restarts, leaves, backs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(day, build, mode, starts, ends, restarts, leaves, backs).run();

test('처음 온 기기 단계: 날짜마다 도전장 주소·그냥 링크로 처음 온 기기와 그중 첫 스윙·첫 10구 끝·한 판 더·다음 날 비율. 옛 주소에서 옮긴 기기와 첫날이 아닌 줄은 안 센다. 오늘은 *', async () => {
  const db = memoryD1();
  await arrived(db, 'd-device-0001', ago(3), 'link', open);   // 열기만
  await arrived(db, 'd-device-0002', ago(3), 'link', open | swing);
  await arrived(db, 'd-device-0003', ago(3), 'duel', open | swing | end | again);
  await seen(db, 'd-device-0003', ago(2));   // 다음 날 다시 쳤다(첫날 값은 없다)
  await arrived(db, 'd-device-0004', ago(3), 'move', open | swing | end);   // 옛 주소에서 옮김: 새 사람이 아니다
  await seen(db, 'd-device-0005', ago(3));   // 전부터 온 기기
  await arrived(db, 'd-device-0006', today, 'link', open | swing | end);
  assert.deepEqual(db.rows(funnelSql()), [
    { 날짜: `${today}*`, '처음 온 기기': 1, '첫 스윙': '100% (1)', '첫 10구 끝': '100% (1)', '한 판 더': '0% (0)', '다음 날': '' },
    { 날짜: ago(3), '처음 온 기기': 3, '첫 스윙': '67% (2)', '첫 10구 끝': '33% (1)', '한 판 더': '33% (1)', '다음 날': '33% (1)' },
  ]);
  assert.deepEqual(db.rows(funnelSql(3)).map((r) => r['날짜']), [`${today}*`]);   // --days 3
});

test('들어온 길: 길마다 처음 온 기기와 첫 스윙·첫 10구 끝 비율, 다음 날 다시 친 비율(다음 날이 끝난 기기만), 맨 아래 처음 온 사람 합계', async () => {
  const db = memoryD1();
  assert.deepEqual(db.rows(pathSql()), []);   // 처음 온 기기가 없으면 합계 줄도 없다
  await arrived(db, 'd-device-0001', ago(3), 'link', open | swing);
  await seen(db, 'd-device-0001', ago(2));
  await arrived(db, 'd-device-0002', ago(3), 'link', open);
  await arrived(db, 'd-device-0003', ago(1), 'link', open | swing | end);   // 다음 날(오늘)이 안 끝나서 다음 날 칸에서 뺀다
  await arrived(db, 'd-device-0004', ago(2), 'duel', open | swing | end);
  await seen(db, 'd-device-0004', ago(1));
  await arrived(db, 'd-device-0005', ago(2), 'move', open | swing);
  await arrived(db, 'd-device-0006', ago(30), 'link', open);   // 범위(14일) 밖
  assert.deepEqual(db.rows(pathSql()), [
    { '들어온 길': '그냥 링크', '처음 온 기기': 3, '첫 스윙': '67% (2)', '첫 10구 끝': '33% (1)', '다음 날': '50% (1/2)' },
    { '들어온 길': '도전장 주소', '처음 온 기기': 1, '첫 스윙': '100% (1)', '첫 10구 끝': '100% (1)', '다음 날': '100% (1/1)' },
    { '들어온 길': '옛 주소에서 옮김', '처음 온 기기': 1, '첫 스윙': '100% (1)', '첫 10구 끝': '0% (0)', '다음 날': '0% (0/1)' },
    { '들어온 길': '처음 온 사람 합계', '처음 온 기기': 4, '첫 스윙': '75% (3)', '첫 10구 끝': '50% (2)', '다음 날': '67% (2/3)' },
  ]);
});

test('판별 10구: 판·모드마다 처음·마지막 날, 시작과 그중 끝까지·다시 시작·나감(숨김 - 돌아옴) 비율과 그 밖. 새 판이 위, 같은 판은 붙여 둔다', async () => {
  const db = memoryD1();
  await tenGames(db, ago(3), 'abc1234', 'challenge', [10, 3, 4, 3, 1]);
  await tenGames(db, ago(2), 'abc1234', 'challenge', [10, 4, 3, 2, 0]);
  await tenGames(db, ago(2), 'def5678', 'challenge', [6, 3, 1, 1, 0]);
  await tenGames(db, ago(1), 'def5678', 'duel', [2, 1, 0, 1, 1]);
  await tenGames(db, ago(30), 'f00d000', 'challenge', [9, 9, 0, 0, 0]);   // 범위 밖
  assert.deepEqual(db.rows(buildSql()), [
    { 판: 'def5678', 모드: '10구', '처음 본 날': ago(2), '마지막 날': ago(2), 시작: 6, 끝까지: '50% (3)', '다시 시작': '17% (1)', 나감: '17% (1)', '그 밖': 1 },
    { 판: 'def5678', 모드: '도전장', '처음 본 날': ago(1), '마지막 날': ago(1), 시작: 2, 끝까지: '50% (1)', '다시 시작': '0% (0)', 나감: '0% (0)', '그 밖': 1 },
    { 판: 'abc1234', 모드: '10구', '처음 본 날': ago(3), '마지막 날': ago(2), 시작: 20, 끝까지: '35% (7)', '다시 시작': '35% (7)', 나감: '20% (4)', '그 밖': 2 },
  ]);
});

test('10구 다시 시작·나감: 날짜·모드마다 판을 합쳐 시작과 그중 끝까지·다시 시작·나감 비율, 숨겼다 돌아온 수, 그 밖. 오늘은 *', async () => {
  const db = memoryD1();
  await tenGames(db, ago(3), 'abc1234', 'challenge', [10, 3, 4, 3, 1]);
  await tenGames(db, ago(2), 'abc1234', 'challenge', [10, 4, 3, 2, 0]);
  await tenGames(db, ago(2), 'def5678', 'challenge', [6, 3, 1, 1, 0]);
  await tenGames(db, ago(1), 'def5678', 'duel', [2, 1, 0, 1, 1]);
  await tenGames(db, today, 'def5678', 'challenge', [0, 0, 0, 1, 0]);   // 숨김만 온 날
  assert.deepEqual(db.rows(quitSql()), [
    { 날짜: `${today}*`, 모드: '10구', 시작: 0, 끝까지: '', '다시 시작': '', 나감: '', '숨겼다 돌아옴': 0, '그 밖': -1 },
    { 날짜: ago(1), 모드: '도전장', 시작: 2, 끝까지: '50% (1)', '다시 시작': '0% (0)', 나감: '0% (0)', '숨겼다 돌아옴': 1, '그 밖': 1 },
    { 날짜: ago(2), 모드: '10구', 시작: 16, 끝까지: '44% (7)', '다시 시작': '25% (4)', 나감: '19% (3)', '숨겼다 돌아옴': 0, '그 밖': 2 },
    { 날짜: ago(3), 모드: '10구', 시작: 10, 끝까지: '30% (3)', '다시 시작': '40% (4)', 나감: '20% (2)', '숨겼다 돌아옴': 1, '그 밖': 1 },
  ]);
});

test('주별 요약: 주 다음 칸에 그 주 투수 유형을 넣는다(11-23 강속구형부터 월요일마다, 이름은 게임 화면 글과 같다)', () => {
  const rows = withStyle([{ 주: '2026-11-30', 기기: 1 }, { 주: '2026-11-23*', 기기: 2 }, { 주: '2026-11-16', 기기: 3 }]);
  assert.deepEqual(rows, [{ 주: '2026-11-30', 투수: '기교파', 기기: 1 }, { 주: '2026-11-23*', 투수: '강속구형', 기기: 2 }, { 주: '2026-11-16', 투수: '정통파', 기기: 3 }]);
  assert.deepEqual(Object.keys(rows[0]), ['주', '투수', '기기']);
  for (const r of rows) assert.equal(r['투수'], STYLE_NAMES[styleOn(r['주'].slice(0, 10))]);
});

test('무료 한도: 판 수는 판이 아닌 모드(도전장 보냄·주소 옮김)를 빼고 센다', async () => {
  const db = memoryD1();
  await played(db, ago(1), 'challenge', 12, 9);
  await played(db, ago(1), 'duel', 2, 1);
  await played(db, ago(1), 'invite', 3, 0);
  await played(db, ago(1), 'move', 1, 0);
  await played(db, ago(2), 'practice', 4, 0);
  assert.deepEqual(db.rows(GAMES_SQL), [{ day: ago(2), games: 4 }, { day: ago(1), games: 14 }]);
});

test('무료 한도: 최근 7일·지금까지 가장 많이 친 날에 판당 값을 곱해 한도의 몇 %인지, 실제는 d1 insights 7일 합계의 하루 평균', () => {
  const games = [{ day: ago(10), games: 1756 }, { day: ago(7), games: 40 }, { day: ago(6), games: 16 }, { day: ago(1), games: 13 }];   // 7일 전은 최근 7일이 아니다
  const used = [{ totalRowsWritten: 1400, totalRowsRead: 20000 }, { totalRowsWritten: 97, totalRowsRead: 5360 }];
  const { rows, note } = limits(games, used, today);
  assert.deepEqual(rows, [
    { 무엇: '서버 요청', '하루 한도': 100000, 판당: 6, '한도에 닿는 판': 16666, '최근 7일 최다 날': '<0.1%', '지금까지 최다 날': '10.5%', '실제 하루 평균': '대시보드에서' },
    { 무엇: 'D1 쓰기', '하루 한도': 100000, 판당: 14, '한도에 닿는 판': 7142, '최근 7일 최다 날': '0.2%', '지금까지 최다 날': '24.6%', '실제 하루 평균': '214줄 · 0.2%' },   // 14: 10구 판별 줄(2026-11-19)
    { 무엇: 'D1 읽기', '하루 한도': 5000000, 판당: 150, '한도에 닿는 판': 33333, '최근 7일 최다 날': '<0.1%', '지금까지 최다 날': '5.3%', '실제 하루 평균': '3,623줄 · <0.1%' },
  ]);
  assert.equal(note, `판 수: 최근 7일 가장 많은 날 16판(${ago(6).slice(5)}), 지금까지 가장 많은 날 1,756판(${ago(10).slice(5)})`);
  const none = limits([], null, today);   // 판이 없고 insights를 못 읽었을 때
  assert.deepEqual(none.rows.map((r) => [r['최근 7일 최다 날'], r['실제 하루 평균']]), [['', '대시보드에서'], ['', '못 읽음'], ['', '못 읽음']]);
  assert.equal(none.note, '판 수: 최근 7일 가장 많은 날 없음, 지금까지 가장 많은 날 없음');
});

test('글자 표: 한글은 두 칸으로 재서 칸을 맞추고, 첫 칸과 글 칸은 왼쪽·숫자 칸은 오른쪽에 붙인다', () => {
  assert.equal(table([{ 주: '2026-11-16*', 기기: 3 }, { 주: '2026-11-09', 기기: 15 }]), [
    `주${' '.repeat(11)}기기`,
    `2026-11-16*${' '.repeat(5)}3`,
    `2026-11-09${' '.repeat(5)}15`,
  ].join('\n'));
  assert.equal(table([{ 날짜: '2026-11-18', 기기: 3, '다음 날': '50% (1)*', 투수: '정통파' }, { 날짜: '합계', 기기: 12, '다음 날': '', 투수: '강속구형' }]), [
    '날짜        기기   다음 날  투수',
    '2026-11-18     3  50% (1)*  정통파',
    `합계${' '.repeat(10)}12${' '.repeat(12)}강속구형`,
  ].join('\n'));
  assert.equal(table([{ 무엇: 'D1 쓰기', 한도: 100000 }]), `무엇${' '.repeat(8)}한도\nD1 쓰기  100,000`);
  assert.equal(table([]), '(없음)');
});
