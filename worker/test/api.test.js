import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { sign, verify, allowedReturn, newSession } from '../src/auth.js';
import { kstDay, weekStart, addDays, maxScoreFor } from '../src/rules.js';
import { DEFAULTS } from '../src/shop.js';
import { makeSequence, pitcherHand, zoneMiss } from '../../js/core/pitches.js';
import { scoreRange } from '../../js/core/score.js';
import { SEED_TTL_MS, SEEDS_PER_HOUR } from '../src/seeds.js';
import { GIFTS_PER_DAY, GIFT_MIN_GAMES } from '../src/gifts.js';
import { memoryD1 } from './d1.js';
import { perfectBatter, playScenario, randomBatter, whiffBatter } from './scenario-play.js';

const SITE = 'https://hyunseungbeom.github.io/walkoff/';
const N = 'nonce-0123456789';
const KAKAO = { c1: 111, c2: 111, c3: 222, c4: 333, c5: 444 };   // 인가 코드 → 카카오 회원번호. c1과 c2는 같은 사람이 다른 기기에서 받은 코드
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
// 2026-11-05부터 게임이 보내는 전광판: 안타 종류(S 단타·D 2루타·T 3루타·H 홈런)를 담는다. 존 안 공을 모두 code 안타로 친 판과, 그 판으로 낼 수 있는 점수 범위
const playedAs = (seed, code) => played(seed).replace(/G/g, code);
const rangeOf = (seed, lights) => scoreRange(lights, makeSequence(seed, pitcherHand(seed) === 'L'));
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

test('끝내기 상황 코인: 서버가 표의 시드로 판을 다시 돌려 점수의 1/100 + 이기면 보너스. 표 하나에 한 번, 코인은 10구와 같이 20초 간격', async () => {
  assert.equal((await call('POST', '/scenario', { body: { token: NO_TICKET.token, bats: 'R', moves: [0] } })).status, 401);
  const token = (await login('c1', 'p-device-0001')).hash.login, other = (await login('c3')).hash.login;
  const post = async (body, as = token) => { const r = await call('POST', '/scenario', { token: as, body }); const j = await r.json(); return r.status === 200 ? j : [r.status, j.error]; };
  const ticketWith = async (seed) => { const t = await seeded(token); await env.DB.prepare('UPDATE seed_tokens SET seed = ? WHERE id = ?').bind(seed, t.token).run(); return t.token; };
  const wait20s = () => env.DB.prepare('UPDATE accounts SET coin_at = 0').run();
  // 2아웃 주자 없음(이기면 30코인)에서 존 안 공만 정타로 쳐 이긴 판
  const seed = Array.from({ length: 500 }, (_, i) => i + 1).find((s) => { const g = playScenario(s, 'R', perfectBatter); return g.k === 4 && g.end === 'win'; });
  const win = playScenario(seed, 'R', perfectBatter), got = Math.floor(win.points / 100) + 30;
  const t1 = await ticketWith(seed);
  assert.deepEqual(await post({ token: t1, bats: 'R', moves: win.moves }), { ok: true, end: 'win', points: win.points, earned: got, bonus: 30, coins: got });
  assert.equal((await me(token)).coins, got);
  assert.deepEqual(await post({ token: t1, bats: 'R', moves: win.moves }), [400, 'seed_used']);   // 같은 표로 또
  assert.deepEqual(env.DB.rows('SELECT used_at IS NOT NULL AS used FROM seed_tokens WHERE id = ?', t1), [{ used: 1 }]);
  const again = await post({ token: await ticketWith(seed), bats: 'R', moves: win.moves });   // 20초 안에 또 이긴 판: 받지만 코인은 0
  assert.deepEqual([again.end, again.earned, again.bonus, again.coins], ['win', 0, 0, got]);
  await wait20s();
  const k = playScenario(seed, 'R', whiffBatter);   // 늘 헛스윙으로 진 판: 점수가 없어 코인도 없다
  assert.deepEqual(await post({ token: await ticketWith(seed), bats: 'R', moves: k.moves }), { ok: true, end: 'lose', points: 0, earned: 0, bonus: 0, coins: got });
  const lostSeed = Array.from({ length: 500 }, (_, i) => i + 1).find((s) => { const g = playScenario(s, 'L', randomBatter(s)); return g.end === 'lose' && g.points >= 300; });
  const lost = playScenario(lostSeed, 'L', randomBatter(lostSeed));   // 져도 친 점수만큼은 받는다
  assert.deepEqual(await post({ token: await ticketWith(lostSeed), bats: 'L', moves: lost.moves }), { ok: true, end: 'lose', points: lost.points, earned: Math.floor(lost.points / 100), bonus: 0, coins: got + Math.floor(lost.points / 100) });

  const t2 = await ticketWith(seed);
  for (const moves of [undefined, [], [1.5], ['0'], [6000]]) assert.deepEqual(await post({ token: t2, bats: 'R', moves }), [400, 'bad_moves']);
  assert.deepEqual(await post({ token: t2, bats: 'X', moves: win.moves }), [400, 'bad_moves']);
  assert.deepEqual(await post({ bats: 'R', moves: win.moves }), [400, 'seed_required']);
  assert.deepEqual(await post({ token: crypto.randomUUID(), bats: 'R', moves: win.moves }), [400, 'bad_seed']);
  assert.deepEqual(await post({ token: t2, bats: 'R', moves: win.moves }, other), [400, 'bad_seed']);   // 남이 받은 표
  assert.deepEqual(await post({ token: t2, bats: 'R', moves: [...win.moves, null] }), [400, 'replay_mismatch']);   // 끝난 뒤에 공이 더 있다
  assert.deepEqual(await post({ token: t2, bats: 'R', moves: win.moves.slice(0, -1) }), [400, 'replay_mismatch']);   // 안 끝난 판
  const fresh = (await (await call('POST', '/seeds', { token })).json()).token;
  assert.deepEqual(await post({ token: fresh, bats: 'R', moves: win.moves }), [400, 'too_fast']);   // 받자마자 낸 판
  await env.DB.prepare('UPDATE seed_tokens SET issued_at = ? WHERE id = ?').bind(Date.now() - SEED_TTL_MS - 1000, t2).run();
  assert.deepEqual(await post({ token: t2, bats: 'R', moves: win.moves }), [400, 'seed_expired']);
  assert.equal((await me(token)).coins, got + Math.floor(lost.points / 100));   // 거절한 판은 코인이 그대로
});

test('랭킹: 목록의 사람마다 입은 물건(look)을 같이 보내고, 계정 ID는 보내지 않는다', async () => {
  const a = (await login('c1', 'p-device-0001')).hash.login, b = (await login('c3', 'p-device-0002')).hash.login;
  const day = kstDay(Date.now());   // 로그인 없이 올리던 때의 예전 기록(계정이 없다). 주간 요약(board.js)보다 먼저 있던 줄이다
  await env.DB.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('p-legacy-0001', day, weekStart(day), '다온', 'kt', 3000, 'G').run();
  await call('POST', '/scores', { token: a, body: score(await seeded(a), { nick: '가람', score: 5000 }) });
  await call('POST', '/scores', { token: b, body: score(await seeded(b), { nick: '나래', score: 4000 }) });
  // 가람은 곰 헬멧·불꽃 배트·등번호 7을 사서 입었고, 사지 않은 금색 신발도 입은 것으로 적혀 있다(산 물건만 입은 것으로 본다)
  await env.DB.prepare('UPDATE accounts SET owned = ?, equipped = ? WHERE player_id = ?')
    .bind(JSON.stringify(['helmet-bear', 'bat-fire', 'number-on']), JSON.stringify({ helmet: 'helmet-bear', bat: 'bat-fire', number: 'number-on', no: 7, shoe: 'shoe-gold' }), 'p-device-0001').run();
  const text = await (await call('GET', '/rankings?player=p-device-0002')).text(), ranking = JSON.parse(text);
  assert.deepEqual(ranking.players.map((p) => [p.nick, p.look]), [
    ['가람', { ...DEFAULTS, helmet: 'helmet-bear', bat: 'bat-fire', number: 'number-on', no: 7 }],
    ['나래', { ...DEFAULTS, number: 'number-none' }],
    ['다온', null],
  ]);
  for (const id of ['p-device-0001', 'p-device-0002', 'p-legacy-0001']) assert.ok(!text.includes(id), `${id}가 응답에 있다`);
  assert.equal(ranking.ids, undefined);
  assert.deepEqual([ranking.me.rank, ranking.count], [2, 3]);   // 내 순위는 그대로
  const sent = await (await call('POST', '/scores', { token: b, body: score(await seeded(b), { nick: '나래', score: 4500 }) })).json();
  assert.deepEqual([sent.ok, sent.players, sent.me.best], [true, undefined, 4500]);   // 점수를 보낸 답에는 목록이 없다(내 순위만)
});

test('역대 최고(allTime): 그 사람이 계정으로 친 10구 점수 전체의 최고를 /rankings?player=와 /scores 답에 준다(이번 주에 친 판이 없어도, 남의 기록은 섞지 않는다)', async () => {
  const a = (await login('c1', 'p-device-0001')).hash.login;
  const today = kstDay(Date.now()), week = weekStart(today), lastWeek = weekStart(addDays(week, -7)), monthAgo = addDays(today, -30);
  const put = (pid, day, s) => env.DB.prepare('INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(pid, day, weekStart(day), '가람', 'lg', s, 'G').run();
  await put('p-device-0001', monthAgo, 17600);   // 한 달 전(다른 기기에서 친 판도 같은 계정이면 여기 있다)
  await put('p-device-0001', lastWeek, 9000);
  await put('p-other-0001', today, 30000);       // 남의 기록
  const r1 = await (await call('GET', '/rankings?player=p-device-0001')).json();
  assert.deepEqual([r1.me, r1.allTime], [null, 17600]);   // 이번 주는 아직 안 쳤어도 역대는 준다
  const sent = await (await call('POST', '/scores', { token: a, body: score(await seeded(a), { score: 5000 }) })).json();
  assert.deepEqual([sent.ok, sent.me.best, sent.allTime], [true, 5000, 17600]);
  await put('p-device-0001', addDays(lastWeek, 1), 21000);   // 지난주에 다른 기기에서 더 높게 친 판
  const r2 = await (await call('GET', '/rankings?player=p-device-0001')).json();
  assert.equal(r2.allTime, 21000);
  assert.equal((await (await call('GET', '/rankings?player=p-nobody-0001')).json()).allTime, null);   // 기록이 없는 사람
  assert.ok(!('allTime' in await (await call('GET', '/rankings')).json()));   // player가 없으면 주지 않는다
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

test('점수 검사(2026-11-05): 안타 종류를 담은 전광판은 점수 하한·상한을 모두 본다. 예전 G 전광판은 그대로(상한만) 받고, G와 종류를 섞으면 거절한다', async () => {
  const a = (await login('c1', 'p-device-0001')).hash.login;
  const send = async (patch) => { const t = await seeded(a), lights = patch.lights?.(t.seed) ?? playedAs(t.seed, 'S'), r = rangeOf(t.seed, lights); return [r, await call('POST', '/scores', { token: a, body: score(t, { lights, score: patch.score(r) }) })]; };
  const [r, ok] = await send({ score: (x) => x.min });
  assert.ok(r.max > r.min);   // 존 안 공 안타마다 정타 +100만 모른다
  assert.equal(ok.status, 200);
  assert.equal((await send({ score: (x) => x.max }))[1].status, 200);
  for (const bad of [(x) => x.min - 100, (x) => x.max + 100]) {
    const [, res] = await send({ score: bad });
    assert.deepEqual([res.status, (await res.json()).error], [400, 'bad_score']);
  }
  const [, mixed] = await send({ lights: (seed) => playedAs(seed, 'S').replace('S', 'G'), score: () => 3000 });
  assert.deepEqual([mixed.status, (await mixed.json()).error], [400, 'bad_lights']);
  const legacy = await call('POST', '/scores', { token: a, body: score(await seeded(a)) });   // 예전 게임(G, 상한만 본다)
  assert.equal(legacy.status, 200);
});

test('칭호(2026-11-06 쌓아서 받기): 10구 판마다 전광판·공 순서·점수로 쌓는 수를 계정에 더하고, 정한 수에 닿은 칭호만 준다(같은 칭호는 한 번). /me와 /rankings(대표 칭호 하나)에 보인다', async () => {
  const a = (await login('c1', 'p-device-0001')).hash.login, b = (await login('c3', 'p-device-0002')).hash.login;
  const hit = async (token, code, nick) => { const t = await seeded(token), lights = playedAs(t.seed, code); return (await call('POST', '/scores', { token, body: score(t, { nick, lights, score: rangeOf(t.seed, lights).min }) })).json(); };
  const first = await hit(a, 'H', '가람');   // 존 안 공을 모두 홈런: 기회 10번 모두 홈런(⭐야구의신⭐)
  assert.equal(first.ok, true);
  for (const id of ['god', 'hit10', 'firsthr']) assert.ok(first.newTitles.includes(id), `${id}를 받는다`);
  for (const id of ['hrking', 'factory', 'walkoff', 'outking', 'cycle']) assert.ok(!first.newTitles.includes(id), `${id}는 아직(쌓아야 받는다)`);
  assert.deepEqual(first.titles, first.newTitles);
  assert.deepEqual([first.counts.hr, first.counts.g_hr10, first.counts.lastHr], [10, 1, 1]);
  const again = await hit(a, 'H', '가람');   // 이미 받은 칭호는 다시 주지 않고, 수는 쌓인다
  assert.deepEqual([again.ok, again.newTitles.filter((id) => first.titles.includes(id)), again.counts.hr, again.counts.g_hr10], [true, [], 20, 2]);
  const mine = await me(a);
  assert.deepEqual([mine.titles, mine.counts.hr], [again.titles, 20]);
  // 정한 수에 닿는 판에서 받는다(홈런 공장장 1,000개·홈런왕 2,000개)
  await env.DB.prepare('UPDATE accounts SET counts = ? WHERE player_id = ?').bind(JSON.stringify({ ...again.counts, hr: 1995 }), mine.playerId).run();
  const big = await hit(a, 'H', '가람');
  assert.deepEqual([big.counts.hr, ['hrking', 'factory'].every((id) => big.newTitles.includes(id))], [2005, true]);
  const legacy = await (await call('POST', '/scores', { token: a, body: score(await seeded(a), { nick: '가람' }) })).json();   // 예전 게임(G)은 쌓지 않는다
  assert.deepEqual([legacy.ok, legacy.newTitles, legacy.counts.hr], [true, [], 2005]);
  const plain = await hit(b, 'S', '나래');   // 단타만 10번: 10할 타자만(똑딱이는 50판)
  assert.deepEqual([plain.newTitles, plain.counts.g_singles, plain.counts.hr], [['hit10'], 1, undefined]);
  const ranking = await (await call('GET', '/rankings')).json();
  const titleOf = (nick) => ranking.players.find((p) => p.nick === nick).title;
  assert.deepEqual([titleOf('가람'), titleOf('나래')], ['god', 'hit10']);   // 대표 칭호는 받은 것 가운데 등급이 가장 높은 것
});

test('대표 칭호 고르기(2026-11-10): 받은 칭호만 달고(안 받은·모르는 칭호는 거절), 안 고르면 가장 높은 것, 물건을 갈아입어도 남고, null이면 자동으로 돌아간다. /me와 /rankings에 보인다', async () => {
  assert.equal((await call('POST', '/title', { body: { title: 'god' } })).status, 401);
  const a = (await login('c1', 'p-device-0001')).hash.login, t = await seeded(a), lights = playedAs(t.seed, 'H');
  const first = await (await call('POST', '/scores', { token: a, body: score(t, { nick: '가람', lights, score: rangeOf(t.seed, lights).min }) })).json();   // 기회 10번 모두 홈런: god·hit10·firsthr
  assert.deepEqual([first.ok, ['god', 'hit10', 'firsthr'].every((id) => first.titles.includes(id)), first.titles.includes('hrking')], [true, true, false]);
  const pick = async (title) => { const r = await call('POST', '/title', { token: a, body: { title } }); return [r.status, await r.json()]; };
  const shown = async () => [(await me(a)).title, (await (await call('GET', '/rankings')).json()).players.find((p) => p.nick === '가람').title];   // [/me의 고른 칭호, 랭킹 배지]
  assert.deepEqual(await shown(), [null, 'god']);   // 안 고르면 가장 높은 것
  assert.deepEqual(await pick('firsthr'), [200, { ok: true, title: 'firsthr', shown: 'firsthr' }]);
  assert.deepEqual(await shown(), ['firsthr', 'firsthr']);
  assert.deepEqual((await pick('hrking')).map((x, i) => (i ? x.error : x)), [400, 'not_earned']);   // 안 받은 칭호
  assert.deepEqual((await pick('no-such-title')).map((x, i) => (i ? x.error : x)), [400, 'unknown_title']);
  assert.deepEqual(await shown(), ['firsthr', 'firsthr']);   // 거절하면 그대로
  await env.DB.prepare('UPDATE accounts SET coins = 500').run();   // 물건을 사서 갈아입어도 고른 칭호는 남는다(전에는 /shop/equip이 칸을 통째로 다시 썼다)
  await call('POST', '/shop/buy', { token: a, body: { item: 'bat-red' } });
  assert.equal((await (await call('POST', '/shop/equip', { token: a, body: { item: 'bat-red' } })).json()).look.bat, 'bat-red');
  assert.deepEqual(await shown(), ['firsthr', 'firsthr']);
  assert.deepEqual(await pick(null), [200, { ok: true, title: null, shown: 'god' }]);   // 다시 자동으로
  assert.deepEqual(await shown(), [null, 'god']);
  assert.equal((await me(a)).look.bat, 'bat-red');   // 칭호를 바꿔도 입은 물건은 그대로
});

// ===== 선물하기와 #번호(2026-11-10, src/gifts.js) =====
const pad = (tag) => String(tag).padStart(4, '0');   // 게임이 보이는 번호(4자리)
const named = async (code, pid, nick) => { const token = (await login(code, pid)).hash.login; await call('PUT', '/me', { token, body: { nick, team: 'lg' } }); return token; };
// 번호 뽑기를 정해 둔 차례로(겹침을 일부러 만든다). 끝나면 원래대로
function fixedRandom(values) {
  const real = crypto.getRandomValues;
  crypto.getRandomValues = (arr) => { arr[0] = values.shift() ?? 0; return arr; };
  return () => { crypto.getRandomValues = real; };
}
const fillTags = (n) => env.DB.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ${n - 1})
  INSERT INTO accounts (kakao_key, player_id, tag) SELECT 'fill-' || i, 'p-fill-' || i, i FROM k`).run();   // 번호 0 ~ n-1을 다른 계정이 쓰는 중

test('#번호: 새 계정은 로그인할 때, 번호 없는 계정(옛 서버가 만든)은 처음 불러올 때 받고, 닉네임을 바꾸거나 다른 기기에서 들어와도 그대로다. 랭킹 사람에게도 붙는다', async () => {
  const a = (await login('c1', 'p-device-0001')).hash.login, tagA = (await me(a)).tag;
  assert.ok(Number.isInteger(tagA) && tagA >= 0 && tagA < 10000, `4자리 번호 ${tagA}`);
  assert.equal(env.DB.rows("SELECT tag FROM accounts WHERE player_id = 'p-device-0001'")[0].tag, tagA);   // 로그인할 때 이미 받았다
  await call('PUT', '/me', { token: a, body: { nick: '새이름', team: 'kt' } });
  assert.equal((await me(a)).tag, tagA);
  assert.equal((await me((await login('c2', 'p-device-0009')).hash.login)).tag, tagA);   // 같은 카카오 계정, 다른 기기
  await env.DB.prepare('INSERT INTO accounts (kakao_key, player_id, nick, team) VALUES (?, ?, ?, ?)').bind('old-key', 'p-old-00001', '옛사람', 'kt').run();
  const old = await newSession(env, 'p-old-00001', Date.now());
  const tagOld = (await me(old)).tag;
  assert.ok(Number.isInteger(tagOld) && tagOld !== tagA);
  assert.equal((await me(old)).tag, tagOld);   // 한 번만 준다
  await call('POST', '/scores', { token: a, body: score(await seeded(a), { nick: '새이름' }) });
  const ranking = await (await call('GET', '/rankings')).json();
  assert.deepEqual(ranking.players.map((p) => [p.nick, p.tag]), [['새이름', tagA]]);
});

test('#번호: 뽑은 번호가 이미 있으면 다시 뽑고, 4자리가 80% 넘게 차면 5자리로 준다', async () => {
  await fillTags(1);   // 번호 0을 누가 쓰는 중
  let undo = fixedRandom([0, 0, 4821]);
  const a = (await login('c1', 'p-device-0001')).hash.login;
  undo();
  assert.equal((await me(a)).tag, 4821);   // 0, 0은 겹쳐서 버렸다
  env.DB.rows('DELETE FROM accounts');
  await fillTags(7999);   // 4자리 7,999개(80% 아래): 세 번 겹쳐도 4자리에서 계속 뽑는다
  undo = fixedRandom([1, 2, 3, 9000]);
  const b = (await login('c3', 'p-device-0002')).hash.login;
  undo();
  assert.equal((await me(b)).tag, 9000);
  undo = fixedRandom([4, 5, 6, 777]);   // 이제 8,000개(80%): 세 번 겹치면 5자리
  const c = (await login('c4', 'p-device-0003')).hash.login;
  undo();
  assert.equal((await me(c)).tag, 10777);
  const tags = env.DB.rows('SELECT tag FROM accounts').map((r) => r.tag);
  assert.equal(new Set(tags).size, tags.length);   // 겹치지 않는다
});

test('받는 사람 찾기: 같은 닉네임을 모두(나는 빼고), 닉네임#번호면 그 한 명, 없는 번호면 빈 목록. 로그인해야 쓰고 계정 ID는 보내지 않는다', async () => {
  const a = await named('c1', 'p-device-0001', '가람'), b = await named('c3', 'p-device-0002', '골든'), c = await named('c4', 'p-device-0003', '골든');
  await named('c5', 'p-device-0004', '골든이');   // 닉네임이 다르면 안 나온다
  const tagB = (await me(b)).tag, tagC = (await me(c)).tag;
  const find = async (token, nick) => { const r = await call('GET', `/players?nick=${encodeURIComponent(nick)}`, { token }); return [r.status, await r.json()]; };
  assert.equal((await call('GET', '/players?nick=골든')).status, 401);
  const [st, all] = await find(a, '골든');
  assert.equal(st, 200);
  assert.deepEqual(all.players.map((p) => [p.nick, p.tag, p.team]).sort((x, y) => x[1] - y[1]), [['골든', tagB, 'lg'], ['골든', tagC, 'lg']].sort((x, y) => x[1] - y[1]));
  assert.deepEqual([all.players[0].look.bat, all.players[0].title], ['bat-wood', null]);   // 입은 모습·대표 칭호
  assert.ok(!JSON.stringify(all).includes('p-device-'));
  assert.deepEqual((await find(a, '  골든  '))[1].players.length, 2);   // 앞뒤 빈칸은 뺀다
  assert.deepEqual((await find(a, `골든#${pad(tagB)}`))[1].players.map((p) => p.tag), [tagB]);
  assert.deepEqual((await find(a, `골든 #${pad(tagC)}`))[1].players.map((p) => p.tag), [tagC]);
  const missing = [...Array(10000).keys()].find((t) => t !== tagB && t !== tagC);
  assert.deepEqual((await find(a, `골든#${pad(missing)}`))[1].players, []);   // 없는 번호
  assert.deepEqual((await find(a, `가람#${pad(tagB)}`))[1].players, []);   // 닉네임과 번호가 다른 사람이면 없다
  assert.deepEqual((await find(b, '골든'))[1].players.map((p) => p.tag), [tagC]);   // 나는 빼고
  assert.deepEqual((await find(a, '골'))[1].players, []);   // 정확히 같은 닉네임만
  assert.equal((await find(a, ''))[0], 400);
});

test('선물하기: 보낸 사람 코인에서 상점 값이 빠지고 받는 사람 물건이 된다(입지는 않는다). 자기 자신·기본 물건·없는 번호·랭킹 판 10판 이하·하루 3번 넘김·코인 부족·이미 가진 물건은 거절한다', async () => {
  const a = await named('c1', 'p-device-0001', '가람'), b = await named('c3', 'p-device-0002', '골든');
  const tagA = (await me(a)).tag, tagB = (await me(b)).tag;
  const gift = async (token, to, item) => { const r = await call('POST', '/shop/gift', { token, body: { to, item } }); return [r.status, await r.json()]; };
  const err = async (...x) => { const [st, d] = await gift(...x); return [st, d.error]; };
  assert.equal((await call('POST', '/shop/gift', { body: { to: tagB, item: 'bat-red' } })).status, 401);
  await env.DB.prepare("UPDATE accounts SET coins = 2000 WHERE player_id = 'p-device-0001'").run();
  for (let i = 0; i < GIFT_MIN_GAMES; i++) {   // 10구 랭킹 판 10판: 아직 못 보낸다(10판 넘게 친 계정만)
    await call('POST', '/scores', { token: a, body: score(await seeded(a), { nick: '가람' }) });
    await env.DB.prepare("UPDATE accounts SET coin_at = 0, coins = 2000 WHERE player_id = 'p-device-0001'").run();
  }
  assert.equal((await me(a)).games, GIFT_MIN_GAMES);
  const [, few] = await gift(a, tagB, 'bat-red');
  assert.deepEqual([few.error, few.games, few.coins], ['not_enough_games', GIFT_MIN_GAMES, 2000]);
  await call('POST', '/scores', { token: a, body: score(await seeded(a), { nick: '가람' }) });
  await env.DB.prepare("UPDATE accounts SET coins = 2000 WHERE player_id = 'p-device-0001'").run();
  assert.deepEqual(await err(a, tagA, 'bat-red'), [400, 'self']);
  assert.deepEqual(await err(a, tagB, 'bat-wood'), [400, 'free_item']);
  assert.deepEqual(await err(a, tagB, 'no-such'), [400, 'unknown_item']);
  assert.deepEqual(await err(a, (tagB + 1) % 10000 === tagA ? (tagB + 2) % 10000 : (tagB + 1) % 10000, 'bat-red'), [404, 'no_player']);
  assert.deepEqual(await err(a, String(tagB), 'bat-red'), [404, 'no_player']);   // 번호는 숫자로
  assert.deepEqual(await err(a, tagB, 'bat-phoenix'), [400, 'not_enough_coins']);   // 8,000코인

  const [st, ok] = await gift(a, tagB, 'bat-red');
  assert.deepEqual([st, ok.ok, ok.coins, ok.to, ok.giftsLeft, ok.owned], [200, true, 1850, { nick: '골든', tag: tagB }, GIFTS_PER_DAY - 1, []]);
  const got = await me(b);
  assert.deepEqual([got.owned, got.look.bat, got.coins], [['bat-red'], 'bat-wood', 0]);   // 받은 물건은 내 것, 입는 것은 직접
  assert.deepEqual(got.gifts.map((g) => [g.item, g.from]), [['bat-red', { nick: '가람', tag: tagA }]]);
  assert.deepEqual(await err(a, tagB, 'bat-red'), [400, 'already_owned']);
  assert.equal((await me(a)).coins, 1850);   // 거절된 것은 코인을 빼지 않았다
  assert.deepEqual((await gift(a, tagB, 'helmet-black'))[1].giftsLeft, 1);
  assert.deepEqual((await gift(a, tagB, 'glove-black'))[1].giftsLeft, 0);
  assert.deepEqual(await err(a, tagB, 'shoe-white'), [400, 'daily_limit']);
  const mine = await me(a);
  assert.deepEqual([mine.coins, mine.owned, mine.giftsLeft], [1850 - 150 - 100, [], 0]);
  await env.DB.prepare("UPDATE gifts SET day = '2000-01-01'").run();   // 다음 날이면 다시 보낸다
  assert.equal((await gift(a, tagB, 'shoe-white'))[0], 200);

  // 받는 쪽: 안 본 선물은 새것부터, 띠를 누르면 본 것으로(남의 선물은 못 바꾼다). 받은 물건은 입을 수 있다
  const inbox = (await me(b)).gifts;
  assert.deepEqual(inbox.map((g) => g.item), ['shoe-white', 'glove-black', 'helmet-black', 'bat-red']);
  assert.deepEqual(await (await call('POST', '/gifts/seen', { token: a, body: { ids: inbox.map((g) => g.id) } })).json(), { ok: true, seen: 0 });
  assert.deepEqual(await (await call('POST', '/gifts/seen', { token: b, body: { ids: inbox.slice(1).map((g) => g.id) } })).json(), { ok: true, seen: 3 });
  assert.deepEqual((await me(b)).gifts.map((g) => g.item), ['shoe-white']);
  assert.equal((await (await call('POST', '/shop/equip', { token: b, body: { item: 'bat-red' } })).json()).look.bat, 'bat-red');
  // 보낸 사람이 기록을 지우면 주고받은 선물 기록도 지우고, 받은 물건은 그대로
  assert.equal((await call('DELETE', '/me', { token: a })).status, 200);
  assert.deepEqual([env.DB.rows('SELECT * FROM gifts').length, (await me(b)).owned.length, (await me(b)).gifts], [0, 4, []]);
});

test('선물하기: 같은 물건을 동시에 두 번 보내도 한 번만 가고 코인도 한 번만 빠진다', async () => {
  const a = await named('c1', 'p-device-0001', '가람'), b = await named('c3', 'p-device-0002', '골든'), tagB = (await me(b)).tag;
  await env.DB.prepare("UPDATE accounts SET coins = 1000, games = 11 WHERE player_id = 'p-device-0001'").run();
  const res = await Promise.all([0, 1].map(() => call('POST', '/shop/gift', { token: a, body: { to: tagB, item: 'bat-silver' } })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 400]);
  assert.deepEqual([(await me(a)).coins, (await me(b)).owned, env.DB.rows('SELECT * FROM gifts').length], [600, ['bat-silver'], 1]);
});
