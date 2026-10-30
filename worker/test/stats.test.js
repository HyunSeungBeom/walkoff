import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { kstDay, addDays } from '../src/rules.js';
import { EVENT_CAP, STATS_SQL } from '../src/stats.js';
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
    '10구 도전': 1, '끝내기 상황': 1, 연습: 0,
  }]);
});
