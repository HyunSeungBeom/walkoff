import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { kstDay, addDays } from '../src/rules.js';
import { BATCH_MAX, BATCH_KEYS, DEVICE_DAYS, EVENT_CAP, LATE_DAYS, STATS_SQL, SWING_SQL, ERRORS_SQL, cleanErrorMessage } from '../src/stats.js';
import { memoryD1 } from './d1.js';

// 게임이 sendBeacon으로 보내는 것처럼 text/plain 본문으로 보낸다
const send = (env, body, type = 'text/plain;charset=UTF-8') => worker.fetch(new Request('https://api.test/events', {
  method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), env);
const ev = (patch) => ({ device: 'd-device-0001', mode: 'challenge', type: 'start', mobile: true, ...patch });

test('이용 통계: 날짜·모드별로 시작과 끝을 세고, 기기는 하루에 한 번만 센다', async () => {
  const env = { DB: memoryD1() };
  for (const e of [ev(), ev({ type: 'end' }), ev(), ev({ mode: 'daily' }), ev({ device: 'd-device-0002', mobile: false })]) {
    assert.equal((await send(env, e)).status, 204);
  }
  assert.equal((await send(env, ev({ mode: 'practice' }), 'application/json')).status, 204);   // JSON으로 와도 받는다
  const day = kstDay(Date.now());
  assert.deepEqual(env.DB.rows('SELECT day, mode, starts, ends FROM play_stats ORDER BY mode'), [
    { day, mode: 'challenge', starts: 3, ends: 1 },
    { day, mode: 'daily', starts: 1, ends: 0 },
    { day, mode: 'practice', starts: 1, ends: 0 },
  ]);
  assert.deepEqual(env.DB.rows('SELECT device, mobile, events FROM play_devices ORDER BY device'), [
    { device: 'd-device-0001', mobile: 1, events: 5 },
    { device: 'd-device-0002', mobile: 0, events: 1 },
  ]);
});

test('이용 통계: 규칙에 없는 신호는 거절하고 세지 않는다', async () => {
  const env = { DB: memoryD1() };
  const bad = [
    ['not json', 'bad_body'],
    [ev({ device: 'x' }), 'bad_device'],
    [ev({ device: "d'); DROP TABLE play_stats; --" }), 'bad_device'],
    [ev({ device: 'D-DEVICE-0001' }), 'bad_device'],   // 게임이 만드는 번호는 소문자다
    [ev({ mode: 'ranked' }), 'bad_mode'],
    [ev({ type: 'pause' }), 'bad_type'],
  ];
  for (const [body, error] of bad) {
    const r = await send(env, body);
    assert.deepEqual([r.status, (await r.json()).error], [400, error], String(error));
  }
  assert.equal(env.DB.rows('SELECT * FROM play_stats').length, 0);
  assert.equal(env.DB.rows('SELECT * FROM play_devices').length, 0);
});

test(`이용 통계: 한 기기가 하루에 ${EVENT_CAP}번을 넘게 보내면 더 세지 않는다`, async () => {
  const env = { DB: memoryD1() };
  await send(env, ev());
  await env.DB.prepare('UPDATE play_devices SET events = ?').bind(EVENT_CAP - 1).run();
  await send(env, ev());   // 상한 바로 전까지는 센다
  assert.equal((await send(env, ev())).status, 204);   // 넘긴 신호도 받기는 받지만
  assert.deepEqual(env.DB.rows('SELECT starts FROM play_stats'), [{ starts: 2 }]);   // 판 수는 그대로다
  assert.equal((await send(env, ev({ device: 'd-device-0002' }))).status, 204);   // 다른 기기는 그대로 센다
  assert.deepEqual(env.DB.rows('SELECT starts FROM play_stats'), [{ starts: 3 }]);
});

test('npm run stats 표: 최근 7일만, 날짜마다 한 줄', async () => {
  const env = { DB: memoryD1() };
  for (const e of [ev(), ev({ type: 'end' }), ev({ mode: 'daily' }), ev({ device: 'd-device-0002', mobile: false, mode: 'scenario' })]) await send(env, e);
  const today = kstDay(Date.now()), old = addDays(today, -7);
  await env.DB.prepare("INSERT INTO play_devices (day, device, mobile, events) VALUES (?, 'd-old-0001', 1, 1)").bind(old).run();
  await env.DB.prepare("INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, 'daily', 5, 5)").bind(old).run();
  assert.deepEqual(env.DB.rows(STATS_SQL), [{
    날짜: today, 기기: 2, '터치 기기': 1, '시작한 판': 3, '끝낸 판': 1,
    '10구 도전': 1, '끝내기 상황': 1, 연습: 0, '조준 실험': 0, '도전장 판': 0, '도전장 끝': 0, '도전장 보냄': 0, '옛 주소에서 옮김': 0,
  }]);
});

// 친구 도전장(2026-11-16): 도전장으로 연 10구 판(duel)은 판으로 세고, 도전장을 보낸 수(invite)는 starts에만 세어 판 합계에서 뺀다
test('npm run stats 표: 도전장 판의 시작·끝과 보낸 수를 따로 보이고, 보낸 수는 시작한 판·끝낸 판에 넣지 않는다', async () => {
  const env = { DB: memoryD1() }, today = kstDay(Date.now());
  assert.equal((await send(env, { device: 'd-device-0001', mobile: true, day: today, counts: { duel: { starts: 3, ends: 2 }, invite: { starts: 4, ends: 0 }, challenge: { starts: 5, ends: 1 } } })).status, 204);
  assert.equal((await send(env, ev({ mode: 'duel', type: 'end' }))).status, 204);   // 한 건씩 보내는 꼴도 받는다
  assert.deepEqual(env.DB.rows(STATS_SQL), [{
    날짜: today, 기기: 1, '터치 기기': 1, '시작한 판': 8, '끝낸 판': 4,
    '10구 도전': 5, '끝내기 상황': 0, 연습: 0, '조준 실험': 0, '도전장 판': 3, '도전장 끝': 3, '도전장 보냄': 4, '옛 주소에서 옮김': 0,
  }]);
});

// 주소 옮기기(2026-11-17, js/infra/move.js): 옛 주소의 기록을 새 주소로 가져온 기기(move)는 starts에만 세고 판 합계에서 뺀다
test('npm run stats 표: 옛 주소에서 기록을 가져온 기기 수를 따로 보이고, 판 합계에는 넣지 않는다', async () => {
  const env = { DB: memoryD1() }, today = kstDay(Date.now());
  assert.equal((await send(env, { device: 'd-device-0001', mobile: true, day: today, counts: { move: { starts: 1, ends: 0 }, challenge: { starts: 2, ends: 1 } } })).status, 204);
  assert.equal((await send(env, { device: 'd-device-0002', mobile: false, day: today, counts: { move: { starts: 1, ends: 0 } } })).status, 204);
  const [row] = env.DB.rows(STATS_SQL);
  assert.deepEqual([row['기기'], row['시작한 판'], row['끝낸 판'], row['10구 도전'], row['옛 주소에서 옮김']], [2, 2, 1, 2, 2]);
});

// 게임이 모아 보내는 묶음(2026-11-04, js/infra/stats.js): { device, mobile, day, counts: { 모드: { starts, ends } } }
const batch = (patch) => ({ device: 'd-device-0001', mobile: true, day: kstDay(Date.now()), counts: { challenge: { starts: 12, ends: 3 }, scenario: { starts: 2, ends: 1 } }, ...patch });

test('이용 통계 묶음: 모드별 시작·끝을 한 번에 더하고, 기기의 그날 신호 수에도 묶음 수만큼 더한다', async () => {
  const env = { DB: memoryD1() }, today = kstDay(Date.now());
  assert.equal((await send(env, batch())).status, 204);
  assert.equal((await send(env, ev())).status, 204);   // 예전 게임의 한 건도 같이 받는다
  assert.equal((await send(env, batch({ counts: { practice: { starts: 1, ends: 0 }, scenario: { starts: 0, ends: 0 } } }))).status, 204);   // 0인 모드는 건너뛴다
  assert.deepEqual(env.DB.rows('SELECT day, mode, starts, ends FROM play_stats ORDER BY mode'), [
    { day: today, mode: 'challenge', starts: 13, ends: 3 },
    { day: today, mode: 'practice', starts: 1, ends: 0 },
    { day: today, mode: 'scenario', starts: 2, ends: 1 },
  ]);
  assert.deepEqual(env.DB.rows('SELECT device, mobile, events FROM play_devices'), [{ device: 'd-device-0001', mobile: 1, events: 20 }]);
});

test(`이용 통계 묶음: 모은 날로 세되 서버 날짜보다 뒤면 오늘로, ${LATE_DAYS}일 넘게 지난 묶음은 받지 않는다`, async () => {
  const env = { DB: memoryD1() }, today = kstDay(Date.now()), one = { challenge: { starts: 1, ends: 0 } };
  for (const [day, status] of [[addDays(today, -1), 204], [addDays(today, -LATE_DAYS), 204], [addDays(today, 1), 204], [addDays(today, -LATE_DAYS - 1), 400], ['bad', 204]]) {
    assert.equal((await send(env, batch({ day, counts: one }))).status, status, day);
  }
  assert.deepEqual(env.DB.rows('SELECT day, starts FROM play_stats ORDER BY day'), [
    { day: addDays(today, -LATE_DAYS), starts: 1 }, { day: addDays(today, -1), starts: 1 }, { day: today, starts: 2 },   // 내일·모양이 틀린 날짜는 오늘로
  ]);
});

test('이용 통계 묶음: 규칙에 없는 묶음은 거절하고 세지 않는다', async () => {
  const env = { DB: memoryD1() };
  const bad = [
    [batch({ counts: [] }), 'bad_counts'],
    [batch({ counts: null }), 'bad_counts'],
    [batch({ counts: { ranked: { starts: 1, ends: 0 } } }), 'bad_mode'],
    [batch({ counts: { challenge: { starts: -1, ends: 2 } } }), 'bad_counts'],
    [batch({ counts: { challenge: { starts: 1.5, ends: 0 } } }), 'bad_counts'],
    [batch({ counts: { challenge: { starts: '3', ends: 0 } } }), 'bad_counts'],
    [batch({ counts: { challenge: { starts: 0, ends: 0 } } }), 'bad_counts'],   // 빈 묶음
    [batch({ counts: { challenge: { starts: BATCH_MAX, ends: 1 } } }), 'bad_counts'],
    [batch({ device: 'x' }), 'bad_device'],
  ];
  for (const [body, error] of bad) {
    const r = await send(env, body);
    assert.deepEqual([r.status, (await r.json()).error], [400, error], JSON.stringify(body.counts));
  }
  assert.equal(env.DB.rows('SELECT * FROM play_stats').length, 0);
  assert.equal(env.DB.rows('SELECT * FROM play_devices').length, 0);
});

test(`이용 통계 묶음: 그날 ${EVENT_CAP}번을 넘긴 기기의 묶음은 세지 않는다`, async () => {
  const env = { DB: memoryD1() };
  await send(env, batch());
  await env.DB.prepare('UPDATE play_devices SET events = ?').bind(EVENT_CAP).run();
  assert.equal((await send(env, batch())).status, 204);
  assert.deepEqual(env.DB.rows('SELECT mode, starts FROM play_stats ORDER BY mode'), [{ mode: 'challenge', starts: 12 }, { mode: 'scenario', starts: 2 }]);
});

// 스윙 결과 수(2026-11-05 조준 타격 실험): 묶음에 swings: { '모드|입력': { swings, contacts, hits, perfect, near, edge, miss } }
const sw = (patch) => ({ swings: 10, contacts: 7, hits: 3, perfect: 1, near: 4, edge: 3, miss: 3, ...patch });
test('스윙 묶음: 모드·입력마다 더하고(같은 날·모드·입력은 합친다), 스윙도 기기의 그날 신호 수에 든다. swings가 없는 예전 묶음도 그대로 받는다', async () => {
  const env = { DB: memoryD1() }, day = kstDay(Date.now());
  assert.equal((await send(env, batch({ swings: { 'aim|touch': sw(), 'challenge|key': sw({ near: 0, edge: 0, miss: 0 }) } }))).status, 204);
  assert.equal((await send(env, batch({ counts: {}, swings: { 'aim|touch': sw({ swings: 2, contacts: 1, hits: 1, perfect: 0, near: 1, edge: 0, miss: 1 }) } }))).status, 204);   // 스윙만 있는 묶음
  assert.equal((await send(env, batch())).status, 204);   // 예전 묶음(swings 없음)
  assert.deepEqual(env.DB.rows('SELECT day, mode, input, swings, contacts, hits, perfect, near, edge, miss FROM swing_stats ORDER BY mode, input'), [
    { day, mode: 'aim', input: 'touch', swings: 12, contacts: 8, hits: 4, perfect: 1, near: 5, edge: 3, miss: 4 },
    { day, mode: 'challenge', input: 'key', swings: 10, contacts: 7, hits: 3, perfect: 1, near: 0, edge: 0, miss: 0 },
  ]);
  assert.deepEqual(env.DB.rows('SELECT mode, starts FROM play_stats ORDER BY mode'), [{ mode: 'challenge', starts: 24 }, { mode: 'scenario', starts: 4 }]);
  assert.deepEqual(env.DB.rows('SELECT events FROM play_devices'), [{ events: (18 + 20) + 2 + 18 }]);   // 판 시작·끝 + 스윙
  const t = env.DB.rows(SWING_SQL);   // npm run stats 둘째 표
  assert.deepEqual(t.map((x) => [x['모드'], x['입력'], x['스윙'], x['맞힘%'], x['과녁 밖%']]), [['조준 실험', 'touch', 12, 66.7, 33.3], ['10구', 'key', 10, 70, null]]);
  assert.equal(env.DB.rows(STATS_SQL)[0]['조준 실험'], 0);
});

test('스윙 묶음: 규칙에 없는 값(음수, 맞힘 > 스윙, 안타 > 맞힘, 조준 합 > 스윙, 모르는 모드·입력)은 묶음째 거절한다', async () => {
  const env = { DB: memoryD1() };
  const bad = [
    { 'aim|touch': sw({ swings: -1 }) }, { 'aim|touch': sw({ contacts: 11 }) }, { 'aim|touch': sw({ hits: 8 }) }, { 'aim|touch': sw({ perfect: 8 }) },
    { 'aim|touch': sw({ near: 5, edge: 5, miss: 1 }) }, { 'aim|touch': sw({ hits: 1.5 }) }, { 'aim|touch': sw({ hits: '3' }) }, { 'aim|thumb': sw() },
    { 'practice|key': sw() }, { 'aim|touch|x': sw() }, { aim: sw() }, [sw()], null,
  ];
  for (const swings of bad) {
    const r = await send(env, batch({ swings }));
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_swings'], JSON.stringify(swings));
  }
  assert.equal(env.DB.rows('SELECT * FROM swing_stats').length, 0);
  assert.equal(env.DB.rows('SELECT * FROM play_stats').length, 0);
  assert.equal((await send(env, batch({ counts: { aim: { starts: 1, ends: 1 } } }))).status, 204);   // 조준 실험 판 수
  assert.deepEqual(env.DB.rows('SELECT mode, starts, ends FROM play_stats'), [{ mode: 'aim', starts: 1, ends: 1 }]);
});

test(`스윙 묶음: 그날 ${EVENT_CAP}번을 넘긴 기기의 스윙은 세지 않는다`, async () => {
  const env = { DB: memoryD1() };
  await send(env, batch({ swings: { 'aim|mouse': sw() } }));
  await env.DB.prepare('UPDATE play_devices SET events = ?').bind(EVENT_CAP).run();
  assert.equal((await send(env, batch({ swings: { 'aim|mouse': sw() } }))).status, 204);
  assert.deepEqual(env.DB.rows('SELECT swings FROM swing_stats'), [{ swings: 10 }]);
});

test(`이용 통계 묶음: 모드·스윙 칸이 합쳐 ${BATCH_KEYS}칸을 넘으면 받지 않는다(칸마다 DB에 한 줄을 써서 묶음 하나가 쓰는 줄을 묶는다)`, async () => {
  const env = { DB: memoryD1() };
  const counts = Object.fromEntries(['challenge', 'scenario', 'practice', 'aim', 'duel'].map((m) => [m, { starts: 1, ends: 0 }]));   // 모드 5칸
  const swings = { 'challenge|touch': sw(), 'aim|touch': sw() };   // 스윙 2칸, 합 7칸(정상 묶음은 2~4칸)
  assert.equal((await send(env, batch({ counts, swings }))).status, 204);
  for (const over of [{ counts, swings: { ...swings, 'challenge|mouse': sw() } }, { counts: { ...counts, invite: { starts: 1, ends: 0 } }, swings: { ...swings, 'challenge|key': sw() } }]) {
    const r = await send(env, batch(over));   // 합 8칸, 9칸
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_counts']);
  }
  assert.equal(env.DB.rows('SELECT 1 FROM play_stats').length, 5);   // 받은 묶음 하나만 셌다
  assert.equal(env.DB.rows('SELECT 1 FROM swing_stats').length, 2);
});

// 오류 종류(2026-11-18 운영 준비): 묶음에 errors: [{ build, src, line, col, name, message, os, browser }]. 서버는 그날 그 오류를 낸 기기 수만 센다
const er = (patch) => ({ build: '86f966f', src: 'main.js', line: 1, col: 48213, name: 'TypeError', message: "Cannot read properties of undefined (reading 'x')", os: 'ios', browser: 'kakao', ...patch });
test('오류 묶음: 판·자리·오류·메시지·기기·브라우저마다 그 오류를 낸 기기 수를 세고 기기 번호는 남기지 않는다. 오류도 그날 신호 수에 든다', async () => {
  const env = { DB: memoryD1() }, day = kstDay(Date.now());
  assert.equal((await send(env, batch({ errors: [er()] }))).status, 204);
  assert.equal((await send(env, batch({ device: 'd-device-0002', counts: {}, errors: [er(), er({ os: 'android', browser: 'samsung' })] }))).status, 204);   // 오류만 있는 묶음(판을 못 열었을 때)
  assert.equal((await send(env, batch())).status, 204);   // 오류 없는 묶음(예전 게임)
  assert.deepEqual(env.DB.rows('SELECT day, build, src, line, col, name, message, os, browser, devices FROM error_stats ORDER BY os'), [
    { ...er({ os: 'android', browser: 'samsung' }), day, devices: 1 },
    { ...er(), day, devices: 2 },
  ]);
  assert.deepEqual(env.DB.rows('SELECT device, events FROM play_devices ORDER BY device'), [{ device: 'd-device-0001', events: 19 + 18 }, { device: 'd-device-0002', events: 2 }]);
  assert.ok(!env.DB.rows("SELECT name FROM pragma_table_info('error_stats')").some((c) => /device$/.test(c.name)));   // 기기 번호 칸이 없다
  const t = env.DB.rows(ERRORS_SQL);   // npm run stats 셋째 표: 같은 오류는 기기·브라우저가 달라도 한 줄로 모은다
  assert.deepEqual(t.map((x) => [x['마지막 날'], x['판'], x['자리'], x['오류'], x['기기 수'], x['기기'].split(',').sort(), x['브라우저'].split(',').sort()]),
    [[day, '86f966f', 'main.js:1:48213', 'TypeError', 3, ['android', 'ios'], ['kakao', 'samsung']]]);
});

test('오류 묶음: 메시지는 서버가 한 번 더 지운다(주소·물음표 뒤·메일·큰따옴표 안·이름이 아닌 작은따옴표 안·한글·네 자리 넘는 숫자, 80자까지). 지운 것은 다시 지워도 그대로다', async () => {
  const env = { DB: memoryD1() };
  const raw = '닉네임 홍길동 https://walkoff-api.walkoff-api.workers.dev/me?player=p-123 kim@naver.com seed 1234567 "{"nick":"kimbo"}"';
  assert.equal((await send(env, batch({ errors: [er({ message: raw })] }))).status, 204);
  assert.deepEqual(env.DB.rows('SELECT message FROM error_stats'), [{ message: '… seed # "…"' }]);
  const cases = [
    ["Cannot read properties of undefined (reading 'nick')", "Cannot read properties of undefined (reading 'nick')"],   // 이름은 그대로(어디서 났는지 알게)
    ["undefined is not an object (evaluating 'a.b.c')", "undefined is not an object (evaluating 'a.b.c')"],
    ["Can't find variable: foo", "Can't find variable: foo"],
    ['Failed to fetch https://walkoff-api.walkoff-api.workers.dev/rankings?player=abc', 'Failed to fetch …'],
    [`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, `Unexpected token '…', "…"... is not valid JSON`],
    [`Unexpected token 'k', "{"nick":"kimbo"}" is not valid JSON`, `Unexpected token 'k', "…" is not valid JSON`],   // JSON 조각 안 닉네임
    ["Invalid nick '홍길동 1'", "Invalid nick '…'"],
    ['Quota exceeded for seed 20261118 by kim.b@naver.com', 'Quota exceeded for seed # by …'],
    ['line1\n  line2\ttab', 'line1 line2 tab'],
    ['x'.repeat(300), 'x'.repeat(80)],
    [undefined, ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(cleanErrorMessage(input), want, String(input));
    assert.equal(cleanErrorMessage(want), want, want);
  }
});

test('오류 묶음: 모양이 틀린 오류 칸(판·파일·줄·칸·이름·메시지·기기·브라우저)은 묶음째 거절하고 아무것도 세지 않는다', async () => {
  const env = { DB: memoryD1() };
  const bad = [
    er({ build: 'HEAD' }), er({ build: '86f966' }), er({ src: '../worker/src/index.js' }), er({ src: 'https://x.test/a.js' }), er({ src: 'Main.js' }), er({ src: 'a/b/c.js' }),
    er({ line: -1 }), er({ col: 1.5 }), er({ col: '3' }), er({ line: 1e8 }), er({ name: 'Type Error' }), er({ name: '<b>' }), er({ name: '' }),
    er({ message: 'x'.repeat(201) }), er({ message: 3 }), er({ os: 'linux' }), er({ browser: 'opera' }), null, [er()], 'TypeError',
  ];
  for (const x of bad) {
    const r = await send(env, batch({ errors: [x] }));
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_errors'], JSON.stringify(x));
  }
  for (const errors of [er(), {}, Array.from({ length: BATCH_KEYS + 1 }, (_, i) => er({ col: i }))]) {
    const r = await send(env, batch({ counts: {}, errors }));
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_errors']);
  }
  assert.equal(env.DB.rows('SELECT 1 FROM error_stats').length, 0);
  assert.equal(env.DB.rows('SELECT 1 FROM play_stats').length, 0);
  assert.equal(env.DB.rows('SELECT 1 FROM play_devices').length, 0);
});

test(`오류 묶음: 오류 칸도 모드·스윙 칸과 합쳐 ${BATCH_KEYS}칸까지만 받고(묶음 하나가 쓰는 줄 상한 그대로), 그날 ${EVENT_CAP}번을 넘긴 기기의 오류는 세지 않는다`, async () => {
  const env = { DB: memoryD1() };
  const counts = Object.fromEntries(['challenge', 'scenario', 'practice', 'aim', 'duel'].map((m) => [m, { starts: 1, ends: 0 }]));   // 모드 5칸
  assert.equal((await send(env, batch({ counts, swings: { 'challenge|touch': sw() }, errors: [er()] }))).status, 204);   // 합 7칸
  const r = await send(env, batch({ counts, swings: { 'challenge|touch': sw() }, errors: [er(), er({ col: 7 })] }));   // 합 8칸
  assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_counts']);
  await env.DB.prepare('UPDATE play_devices SET events = ?').bind(EVENT_CAP).run();
  assert.equal((await send(env, batch({ counts: {}, errors: [er({ col: 9 })] }))).status, 204);
  assert.deepEqual(env.DB.rows('SELECT col, devices FROM error_stats'), [{ col: 48213, devices: 1 }]);
});

test('이용 통계: 기기별 줄(무작위 번호)은 90일이 지나면 묶음을 받을 때 지우고, 날짜별 합계는 그대로 둔다. 지울 때 표를 다 훑지 않는다', async () => {
  const env = { DB: memoryD1() }, day = kstDay(Date.now());
  const old = [[DEVICE_DAYS + 30, 'd-old-0001'], [DEVICE_DAYS + 1, 'd-old-0002'], [DEVICE_DAYS, 'd-keep-0001'], [1, 'd-keep-0002']];
  for (const [ago, device] of old) {
    await env.DB.prepare('INSERT INTO play_devices (day, device, mobile, events) VALUES (?, ?, 0, 3)').bind(addDays(day, -ago), device).run();
    await env.DB.prepare('INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, 3, 2)').bind(addDays(day, -ago), 'challenge').run();
  }
  assert.equal((await send(env, ev())).status, 204);
  assert.deepEqual(env.DB.rows('SELECT device FROM play_devices ORDER BY day').map((r) => r.device), ['d-keep-0001', 'd-keep-0002', 'd-device-0001']);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM play_stats')[0].n, old.length + 1);
  // 늦게 온 묶음(이틀 전 날짜)은 그 날짜로 재서 지운다: 90일째 줄은 남는다
  assert.equal((await send(env, ev({ day: addDays(day, -LATE_DAYS), device: 'd-device-0002' }))).status, 204);
  assert.deepEqual(env.DB.rows('SELECT device FROM play_devices WHERE day < ?', addDays(day, -2)).map((r) => r.device), ['d-keep-0001']);
  const plan = env.DB.rows('EXPLAIN QUERY PLAN DELETE FROM play_devices WHERE day < ?', addDays(day, -DEVICE_DAYS)).map((r) => r.detail).join(' | ');
  assert.match(plan, /SEARCH play_devices USING (?:PRIMARY KEY|INDEX sqlite_autoindex_play_devices_1) \(day<\?\)/);
});
