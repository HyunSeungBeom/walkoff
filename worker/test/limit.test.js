import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { kstDay } from '../src/rules.js';
import { memoryD1 } from './d1.js';

// 로그인 없이 받는 경로의 횟수 제한(wrangler.toml [[ratelimits]]). Cloudflare 바인딩처럼 key마다 limit번까지 success를 돌려주는 가짜
const fakeLimiter = (limit) => {
  const seen = new Map();
  return { keys: seen, limit: async ({ key }) => { seen.set(key, (seen.get(key) ?? 0) + 1); return { success: seen.get(key) <= limit }; } };
};
const batch = () => JSON.stringify({ device: 'd-device-0001', mobile: true, day: kstDay(Date.now()), counts: { challenge: { starts: 1, ends: 0 } } });
const events = (env, ip) => worker.fetch(new Request('https://api.test/events', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': ip }, body: batch() }), env);
const rankings = (env, ip) => worker.fetch(new Request('https://api.test/rankings', { headers: { 'cf-connecting-ip': ip } }), env);

test('횟수 제한: 통계(/events)와 랭킹(/rankings)은 IP마다 세고, 넘으면 429(게임이 읽을 수 있게 CORS 머리글, 60초 뒤 다시)이며 넘친 통계는 세지 않는다', async () => {
  const env = { DB: memoryD1(), EVENTS_LIMIT: fakeLimiter(2), RANKINGS_LIMIT: fakeLimiter(3) };
  const e = [];
  for (let i = 0; i < 3; i++) e.push((await events(env, '1.1.1.1')).status);
  assert.deepEqual(e, [204, 204, 429]);
  assert.equal((await events(env, '2.2.2.2')).status, 204);   // 다른 IP는 따로 센다
  const over = await events(env, '1.1.1.1');
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('access-control-allow-origin'), '*');
  assert.equal(over.headers.get('retry-after'), '60');
  assert.deepEqual(await over.json(), { ok: false, error: 'rate_limited' });
  assert.deepEqual(env.DB.rows('SELECT starts FROM play_stats'), [{ starts: 3 }]);   // 받은 묶음 셋만
  const r = [];
  for (let i = 0; i < 4; i++) r.push((await rankings(env, '1.1.1.1')).status);
  assert.deepEqual(r, [200, 200, 200, 429]);   // 랭킹은 통계와 따로 센다
  assert.equal((await rankings(env, '2.2.2.2')).status, 200);
  assert.deepEqual([...env.RANKINGS_LIMIT.keys.keys()], ['1.1.1.1', '2.2.2.2']);
});

test('횟수 제한: 로그인한 요청과 미리 묻는 요청(OPTIONS)은 세지 않고, 바인딩이 없으면(로컬 dev) 막지 않는다', async () => {
  const env = { DB: memoryD1(), EVENTS_LIMIT: fakeLimiter(0), RANKINGS_LIMIT: fakeLimiter(0) };
  assert.equal((await worker.fetch(new Request('https://api.test/events', { method: 'OPTIONS', headers: { 'cf-connecting-ip': '1.1.1.1' } }), env)).status, 204);
  assert.equal((await worker.fetch(new Request('https://api.test/seeds', { method: 'POST', headers: { 'cf-connecting-ip': '1.1.1.1' } }), env)).status, 401);   // 로그인이 필요한 경로는 그대로
  assert.equal(env.EVENTS_LIMIT.keys.size + env.RANKINGS_LIMIT.keys.size, 0);
  const plain = { DB: memoryD1() };
  for (let i = 0; i < 30; i++) assert.equal((await events(plain, '1.1.1.1')).status, 204);
  assert.equal((await rankings(plain, '1.1.1.1')).status, 200);
});
