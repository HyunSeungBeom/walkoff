import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { sign, verify, allowedReturn } from '../src/auth.js';
import { kstDay, maxScoreFor } from '../src/rules.js';
import { makeSequence, pitcherHand, zoneMiss } from '../src/pitches.js';
import { SEED_TTL_MS, SEEDS_PER_HOUR } from '../src/seeds.js';
import { memoryD1 } from './d1.js';

const SITE = 'https://hyunseungbeom.github.io/walkoff/';
const N = 'nonce-0123456789';
const KAKAO = { c1: 111, c2: 111, c3: 222 };   // 인가 코드 → 카카오 회원번호. c1과 c2는 같은 사람이 다른 기기에서 받은 코드
const realFetch = globalThis.fetch;
let env, kakaoCalls;

beforeEach(() => {
  env = { DB: memoryD1(), SESSION_SECRET: 'test-session-secret', ID_SALT: 'test-id-salt', KAKAO_REST_KEY: 'rest-key', KAKAO_CLIENT_SECRET: 'client-secret' };
  kakaoCalls = [];
  globalThis.fetch = async (input, init = {}) => {   // 가짜 카카오
    const url = String(input);
    kakaoCalls.push({ url, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    if (url === 'https://kauth.kakao.com/oauth/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('client_secret') !== 'client-secret' || !(p.get('code') in KAKAO)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `at-${p.get('code')}` });
    }
    if (url === 'https://kapi.kakao.com/v2/user/me') return Response.json({ id: KAKAO[init.headers.authorization.slice('Bearer at-'.length)] });
    throw new Error(`예상하지 못한 요청 ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (method, path, { token, body } = {}) => worker.fetch(new Request(`https://api.test${path}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const start = (params) => call('GET', `/auth/kakao/start?${new URLSearchParams({ n: N, return: SITE, ...params })}`);

// 게임이 하는 대로 로그인한다: start → (카카오) → callback. 돌아온 게임 주소의 # 뒤를 읽는다
async function login(code, pid = '') {
  const kakao = new URL((await start({ pid })).headers.get('location'));
  const cb = await call('GET', `/auth/kakao/callback?${new URLSearchParams({ code, state: kakao.searchParams.get('state') })}`);
  const back = new URL(cb.headers.get('location'));
  return { kakao, back, hash: Object.fromEntries(new URLSearchParams(back.hash.slice(1))) };
}
const me = async (token) => (await call('GET', '/me', { token })).json();
const profile = ({ ok, playerId, nick, team }) => ({ ok, playerId, nick, team });   // /me에서 지갑을 뺀 계정 정보
// 실제 공 순서대로 친 전광판: 존 밖 공은 골라내고(Y), 존 안 공은 쳐서 안타(G). 서버가 그 판의 공 순서로 맞춰 본다
const played = (seed) => {
  let out = '', left = 10;
  for (const p of makeSequence(seed, pitcherHand(seed) === 'L')) { if (!left) break; if (zoneMiss(p) > 0) out += 'Y'; else { out += 'G'; left--; } }
  return out;
};
// 10구 도전 한 판은 /seeds로 받은 표의 시드로 친다. 서버는 한 판 칠 시간이 지나야 받으므로 10분 전에 받은 것처럼 받은 시각을 당긴다
async function seeded(token) {
  const t = await (await call('POST', '/seeds', { token })).json();
  await env.DB.prepare('UPDATE seed_tokens SET issued_at = issued_at - 600000 WHERE id = ?').bind(t.token).run();
  return t;
}
const score = (t, patch = {}) => ({ nick: '민성', team: 'lg', day: kstDay(Date.now()), mode: 'challenge', token: t.token, seed: t.seed, lights: played(t.seed), score: 3000, ...patch });
const NO_TICKET = { token: 'no-such-token', seed: 42 };   // 로그인부터 막히는 요청에 넣는 아무 표

test('로그인 시작: 카카오로 보내고, 허용하지 않은 돌아갈 주소는 거절한다', async () => {
  const { kakao } = await login('c1');
  assert.equal(`${kakao.origin}${kakao.pathname}`, 'https://kauth.kakao.com/oauth/authorize');
  assert.equal(kakao.searchParams.get('client_id'), 'rest-key');
  assert.equal(kakao.searchParams.get('redirect_uri'), 'https://api.test/auth/kakao/callback');
  assert.equal(kakao.searchParams.get('response_type'), 'code');
  for (const back of ['https://evil.example/walkoff/', 'https://hyunseungbeom.github.io/other/', `${SITE}#x`, 'javascript:alert(1)', 'http://evil.example/']) {
    assert.equal((await start({ return: back })).status, 400, back);
  }
  assert.ok(allowedReturn('http://127.0.0.1:8000/index.html?api=http://127.0.0.1:8787'));   // 이 컴퓨터에서 띄운 게임
  assert.equal((await start({ n: 'short' })).status, 400);   // 확인값이 너무 짧다
  delete env.KAKAO_REST_KEY;   // 카카오 키를 아직 안 넣었으면 게임으로 돌려보낸다
  assert.equal((await start()).headers.get('location'), `${SITE}#login_error=not_ready&n=${N}`);
});

test('첫 로그인은 이 브라우저 ID를 이어 쓰고, 다른 기기에서 로그인하면 같은 계정이다', async () => {
  const first = await login('c1', 'p-device-0001');
  assert.equal(first.hash.n, N);
  assert.deepEqual(kakaoCalls.find((c) => c.url.endsWith('/oauth/token')).body,
    { grant_type: 'authorization_code', client_id: 'rest-key', redirect_uri: 'https://api.test/auth/kakao/callback', code: 'c1', client_secret: 'client-secret' });
  const fresh = await me(first.hash.login);
  assert.deepEqual(profile(fresh), { ok: true, playerId: 'p-device-0001', nick: null, team: null });
  assert.deepEqual([fresh.coins, fresh.owned, fresh.look.bat], [0, [], 'bat-wood']);   // 새 계정은 코인 0, 기본 물건

  const second = await login('c2', 'p-device-0002');   // 같은 카카오 계정, 다른 기기
  assert.equal((await me(second.hash.login)).playerId, 'p-device-0001');

  const other = await login('c3', 'p-device-0001');    // 다른 사람이 이미 계정에 묶인 ID를 보내면 새 ID
  const otherId = (await me(other.hash.login)).playerId;
  assert.notEqual(otherId, 'p-device-0001');
  assert.match(otherId, /^[a-z0-9-]{8,40}$/);

  const keys = env.DB.rows('SELECT kakao_key FROM accounts').map((r) => r.kakao_key);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.length === 43 && k !== '111' && k !== '222'));   // 회원번호를 그대로 두지 않는다
});

test('로그인 실패: 취소, 카카오 오류, 망가진 확인 표', async () => {
  const state = (await login('c1')).kakao.searchParams.get('state');
  const back = async (params) => (await call('GET', `/auth/kakao/callback?${new URLSearchParams({ state, ...params })}`)).headers.get('location');
  assert.equal(await back({ error: 'access_denied' }), `${SITE}#login_error=canceled&n=${N}`);
  assert.equal(await back({ code: 'unknown' }), `${SITE}#login_error=kakao&n=${N}`);
  const [body, sig] = state.split('.');
  const forged = await call('GET', `/auth/kakao/callback?${new URLSearchParams({ code: 'c1', state: `${body}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}` })}`);
  assert.equal(forged.status, 400);
  assert.match(forged.headers.get('content-type'), /text\/html/);
});

test('점수는 로그인해야 받고, 사람 ID는 로그인 표에서 꺼낸다. 그날 가장 높은 판만 남는다', async () => {
  assert.equal((await call('POST', '/scores', { body: score(NO_TICKET, { playerId: 'someone-else' }) })).status, 401);
  assert.equal((await call('POST', '/scores', { body: score(NO_TICKET), token: 'forged.token' })).status, 401);
  const token = (await login('c1', 'p-device-0001')).hash.login;
  const res = await (await call('POST', '/scores', { body: score(await seeded(token), { playerId: 'someone-else' }), token })).json();
  assert.equal(res.accepted, true);
  assert.deepEqual(res.me, { rank: 1, best: 3000, total: 3000, days: 1, team: 'lg' });
  assert.equal((await (await call('POST', '/scores', { body: score(await seeded(token), { score: 2000 }), token })).json()).accepted, false);   // 더 낮은 판은 그대로
  const higher = await (await call('POST', '/scores', { body: score(await seeded(token), { score: 5000 }), token })).json();   // 더 높은 판은 바로 갱신
  assert.deepEqual([higher.accepted, higher.me], [true, { rank: 1, best: 5000, total: 5000, days: 1, team: 'lg' }]);
  assert.deepEqual(env.DB.rows('SELECT player_id, score FROM daily_scores'), [{ player_id: 'p-device-0001', score: 5000 }]);
  assert.deepEqual(profile(await me(token)), { ok: true, playerId: 'p-device-0001', nick: '민성', team: 'lg' });   // 다른 기기에서 이어 줄 팀·닉네임
});

test('그 판의 공 순서로 나올 수 없는 점수는 거절한다(2026-10-30 조작 사례)', async () => {
  const token = (await login('c1', 'p-device-0001')).hash.login;
  const post = async (t, patch) => { const r = await call('POST', '/scores', { token, body: score(t, patch) }); return [r.status, (await r.json()).error ?? 'ok']; };
  const t = await seeded(token);
  assert.deepEqual(await post(t, { score: 15100, lights: `${'G'.repeat(10)}${'Y'.repeat(30)}` }), [400, 'bad_lights']);   // 안타 10개 뒤에 볼 30개
  assert.deepEqual(await post(t, { score: 99999 }), [400, 'bad_score']);
  assert.deepEqual(await post(t), [200, 'ok']);   // 거절된 판은 표를 쓰지 않는다
  assert.equal(env.DB.rows('SELECT score FROM daily_scores').length, 1);   // 거절된 판은 남지 않는다
});

test('10구 도전은 서버가 내준 표로만 받는다: 표 하나에 한 번, 내 표만, 기한 안, 한 판 칠 시간이 지나야', async () => {
  assert.equal((await call('POST', '/seeds')).status, 401);   // 표는 로그인해야 받는다
  const token = (await login('c1', 'p-device-0001')).hash.login, other = (await login('c3')).hash.login;
  const post = async (body, as = token) => { const r = await call('POST', '/scores', { token: as, body }); return [r.status, (await r.json()).error ?? 'ok']; };
  const res = await call('POST', '/seeds', { token });
  const fresh = await res.json();
  assert.equal(res.status, 200);
  assert.match(fresh.token, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isInteger(fresh.seed) && fresh.seed > 0 && fresh.seed < 2 ** 31, String(fresh.seed));
  assert.deepEqual(await post(score(fresh)), [400, 'too_fast']);   // 받자마자 낸 판(한 판 칠 시간이 안 지났다)

  const t = await seeded(token);
  const { seed: _, token: __, ...noTicket } = score(t);
  assert.deepEqual(await post(noTicket), [400, 'seed_required']);   // 게임이 정한 시드만 보낸 판(예전 게임, ?seed= 판)
  assert.deepEqual(await post({ ...score(t), token: crypto.randomUUID() }), [400, 'bad_seed']);   // 서버에 없는 표
  assert.deepEqual(await post(score(t), other), [400, 'bad_seed']);   // 남이 받은 표
  // 게임이 보낸 시드는 쓰지 않는다. 표의 시드는 무작위라 다른 시드를 7로 고정하면 그 전광판이 우연히 표의 공 순서에도 들어맞아
  // 12%쯤 실패했다(2026-10-30 CI). 표의 공 순서로는 나올 수 없는 전광판을 내는 시드를 고른다
  const seqOfTicket = makeSequence(t.seed, pitcherHand(t.seed) === 'L');
  const otherSeed = Array.from({ length: 40 }, (_, i) => i + 7).find((s) => maxScoreFor(played(s), seqOfTicket) === null);
  assert.deepEqual(await post(score(t, { seed: otherSeed, lights: played(otherSeed) })), [400, 'bad_lights']);
  assert.deepEqual(await post(score(t)), [200, 'ok']);
  assert.deepEqual(await post(score(t)), [400, 'seed_used']);   // 같은 표로 또
  assert.deepEqual(env.DB.rows('SELECT used_at IS NOT NULL AS used FROM seed_tokens WHERE id = ?', t.token), [{ used: 1 }]);

  const old = await seeded(token);
  await env.DB.prepare('UPDATE seed_tokens SET issued_at = ? WHERE id = ?').bind(Date.now() - SEED_TTL_MS - 1000, old.token).run();
  assert.deepEqual(await post(score(old)), [400, 'seed_expired']);
});

test('표는 한 시간에 정한 수까지만 주고, 기한이 지난 표는 새 표를 줄 때 지운다', async () => {
  const token = (await login('c1', 'p-device-0001')).hash.login, now = Date.now();
  const add = (n, at) => { for (let i = 0; i < n; i++) env.DB.prepare('INSERT INTO seed_tokens (id, player_id, seed, issued_at) VALUES (?, ?, 1, ?)').bind(crypto.randomUUID(), 'p-device-0001', at).run(); };
  add(5, now - SEED_TTL_MS - 1000);   // 기한이 지난 표
  add(SEEDS_PER_HOUR - 1, now - 60e3);
  assert.equal((await call('POST', '/seeds', { token })).status, 200);   // 한 시간 안에 받은 표가 정한 수에 닿았다
  const over = await call('POST', '/seeds', { token });
  assert.deepEqual([over.status, (await over.json()).error], [429, 'too_many_seeds']);
  assert.equal(env.DB.rows('SELECT 1 FROM seed_tokens WHERE issued_at < ?', now - SEED_TTL_MS).length, 0);
  await env.DB.prepare('UPDATE seed_tokens SET issued_at = issued_at - 3600000').run();   // 한 시간이 지난 것처럼
  assert.equal((await call('POST', '/seeds', { token })).status, 200);
});

test('팀·닉네임 바꾸기와 기록 지우기', async () => {
  const token = (await login('c1', 'p-device-0001')).hash.login;
  await call('POST', '/scores', { body: score(await seeded(token)), token });
  await seeded(token);   // 아직 안 쓴 표
  assert.equal((await call('PUT', '/me', { token, body: { nick: '새이름', team: 'kt' } })).status, 200);
  assert.equal((await call('PUT', '/me', { token, body: { nick: '새이름', team: 'comets' } })).status, 400);
  const ranking = await (await call('GET', '/rankings?player=p-device-0001')).json();
  assert.deepEqual(ranking.players.map((p) => [p.nick, p.team]), [['새이름', 'lg']]);   // 이름은 바로 바뀌고, 그날 친 팀은 그대로
  assert.deepEqual([ranking.players[0].best, ranking.players[0].total, ranking.me.total], [3000, 3000, 3000]);   // 예전 게임이 읽는 total도 같은 값
  assert.equal((await call('DELETE', '/me', { token })).status, 200);
  assert.equal(env.DB.rows('SELECT * FROM daily_scores').length, 0);
  assert.equal(env.DB.rows('SELECT * FROM accounts').length, 0);
  assert.equal(env.DB.rows('SELECT * FROM seed_tokens').length, 0);
  assert.equal((await call('GET', '/me', { token })).status, 401);   // 지운 계정의 표는 더 못 쓴다
  assert.equal((await call('POST', '/scores', { body: score(NO_TICKET), token })).status, 401);
  assert.equal((await call('POST', '/seeds', { token })).status, 401);
});

test('코인: 판마다 점수의 1/100, 20초 안에 또 보내면 주지 않는다', async () => {
  const token = (await login('c1', 'p-device-0001')).hash.login;
  const send = async (patch) => (await call('POST', '/scores', { token, body: score(await seeded(token), patch) })).json();
  const wait20s = () => env.DB.prepare('UPDATE accounts SET coin_at = 0').run();   // 20초가 지난 것처럼
  assert.deepEqual(await send({ score: 3050 }).then((r) => [r.earned, r.coins]), [30, 30]);
  assert.deepEqual(await send({ score: 4000 }).then((r) => [r.earned, r.coins]), [0, 30]);   // 20초 안에 또 왔다(점수는 받는다)
  await wait20s();
  assert.deepEqual(await send({ score: 4000 }).then((r) => [r.earned, r.coins, r.accepted]), [40, 70, false]);   // 같은 4,000점이라 그날 기록은 그대로
  assert.equal((await me(token)).coins, 70);
});

test('상점: 산 것만 입고, 코인이 모자라거나 이미 있으면 못 산다', async () => {
  assert.equal((await call('POST', '/shop/buy', { body: { item: 'bat-red' } })).status, 401);
  const token = (await login('c1', 'p-device-0001')).hash.login;
  await env.DB.prepare('UPDATE accounts SET coins = 500').run();
  const buy = async (item) => { const r = await call('POST', '/shop/buy', { token, body: { item } }); return [r.status, await r.json()]; };
  const equip = async (body) => { const r = await call('POST', '/shop/equip', { token, body }); return [r.status, await r.json()]; };
  const [st, ok] = await buy('bat-red');
  assert.deepEqual([st, ok.coins, ok.owned], [200, 350, ['bat-red']]);
  assert.deepEqual((await buy('bat-red')).map((x, i) => (i ? x.error : x)), [400, 'already_owned']);
  assert.deepEqual((await buy('bat-gold')).map((x, i) => (i ? x.error : x)), [400, 'not_enough_coins']);
  assert.equal((await buy('bat-wood'))[1].error, 'free_item');
  assert.equal((await buy('no-such'))[1].error, 'unknown_item');
  assert.equal((await me(token)).coins, 350);   // 거절된 것은 코인을 빼지 않았다

  assert.equal((await equip({ item: 'bat-gold' }))[1].error, 'not_owned');
  assert.equal((await equip({ item: 'bat-red' }))[1].look.bat, 'bat-red');
  assert.equal((await equip({ item: 'helmet-team' }))[1].look.helmet, 'helmet-team');   // 기본 물건은 사지 않아도 입는다
  assert.equal((await equip({ item: 'number-on', number: 7 }))[1].error, 'not_owned');
  assert.equal((await buy('number-on'))[1].coins, 50);
  assert.equal((await equip({ item: 'number-on', number: 100 }))[1].error, 'bad_number');
  const [, eq] = await equip({ item: 'number-on', number: 7 });
  assert.deepEqual([eq.look.number, eq.look.no, eq.look.bat], ['number-on', 7, 'bat-red']);
  const mine = await me(token);
  assert.deepEqual([mine.coins, mine.owned, mine.look.bat, mine.look.no], [50, ['bat-red', 'number-on'], 'bat-red', 7]);   // 다른 기기에서도 그대로
});

test('다른 주소의 게임이 로그인 표를 보낼 수 있다(CORS)', async () => {
  const res = await call('OPTIONS', '/me');
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(res.headers.get('access-control-allow-methods'), /DELETE/);
});

test('로그인 표: 서명, 종류, 기한을 모두 본다', async () => {
  const t = await sign('s1', { t: 's', p: 'p-1', exp: 2000 });
  assert.equal((await verify('s1', t, 's', 1000)).p, 'p-1');
  assert.equal(await verify('s1', t, 's', 3000), null);    // 기한이 지났다
  assert.equal(await verify('s1', t, 'st', 1000), null);   // 다른 종류(로그인 시작 표)
  assert.equal(await verify('s2', t, 's', 1000), null);    // 다른 비밀값
  assert.equal(await verify('s1', 'abc', 's', 1000), null);
  assert.equal(await verify('s1', `${t}x`, 's', 1000), null);
});
