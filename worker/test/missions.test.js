// 오늘의 미션(2026-11-23, src/missions.js): 서버가 다시 돌린 10구 랭킹 판으로 그날 미션을 세고, 채운 미션의 코인을 한 번씩 준다.
// 게임이 보낸 점수·전광판은 쓰지 않고, 같은 표로 두 번 와도 한 번만 세며, 한국 시간 날이 바뀌면 새 미션이다. 실행: node --test 'worker/test/*.test.js'
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { kstDay, styleAt } from '../src/rules.js';
import { signSeed } from '../src/seeds.js';
import { makeSequence, pitcherHand, zoneMiss } from '../../js/core/pitches.js';
import { playChallenge } from '../../js/core/challenge.js';
import { missionsOn, gameFacts, missionGain, advanceMissions, TIER_COINS, ALL_BONUS } from '../../js/core/missions.js';
import { memoryD1 } from './d1.js';

// 시계: 실제 날짜와 상관없이 한국 시간 2026-11-24(화) 12시부터 흐른다(clockTo로 옮긴다). 그날 미션은 아래 테스트가 먼저 확인한다
const realClock = Date.now;
let clockShift = 0;
Date.now = () => realClock() + clockShift;
const clockTo = (iso) => { clockShift = Date.parse(iso) - realClock(); };
const later = (ms) => { clockShift += ms; };

const SITE = 'https://hyunseungbeom.github.io/walkoff/', N = 'nonce-0123456789', KAKAO = { c1: 111, c2: 222 };
const realFetch = globalThis.fetch;
let env;
beforeEach(() => {
  clockTo('2026-11-24T03:00:00Z');
  env = { DB: memoryD1(), SESSION_SECRET: 'test-session-secret', ID_SALT: 'test-id-salt', KAKAO_REST_KEY: 'rest-key', KAKAO_CLIENT_SECRET: 'client-secret' };
  globalThis.fetch = async (input, init = {}) => {   // 가짜 카카오
    const url = String(input);
    if (url === 'https://kauth.kakao.com/oauth/token') return Response.json({ access_token: `at-${new URLSearchParams(init.body).get('code')}` });
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
async function login(code, pid) {   // 게임이 하는 대로 start → (카카오) → callback, 돌아온 주소 # 뒤의 로그인 표
  const kakao = new URL((await call('GET', `/auth/kakao/start?${new URLSearchParams({ n: N, return: SITE, pid })}`)).headers.get('location'));
  const cb = await call('GET', `/auth/kakao/callback?${new URLSearchParams({ code, state: kakao.searchParams.get('state') })}`);
  return new URLSearchParams(new URL(cb.headers.get('location')).hash.slice(1)).get('login');
}
const me = async (token) => (await call('GET', '/me', { token })).json();
// 시드를 정한 표(10분 전에 받은 것처럼, 서버가 내주는 것과 같은 서명)
const ticket = async (playerId, seed) => { const at = Date.now() - 600000; return { token: await signSeed(env.SESSION_SECRET, playerId, seed, at), seed, style: styleAt(at) }; };
// 존 안 공을 정타 범위(±15ms) 안에서 조금씩 다른 타이밍으로 친다(모두 같은 타이밍이면 서버가 봇으로 보고 거절한다, rules.js SAME_SWINGS)
const PERFECT = [0, 6, -6, 12, -12, 3, -3, 9, -9, 1], perfectish = (p, k) => PERFECT[k % PERFECT.length];
// 그 표의 공 순서대로 친 판: 존 밖 공은 보내고(볼) 존 안 공은 swing(p, 몇 번째 스윙) 타이밍으로 휘두른다. 점수·전광판은 core로 다시 돌린 값, game은 다시 돌린 판
function played(t, swing = perfectish) {
  const seq = makeSequence(t.seed, pitcherHand(t.seed) === 'L', t.style), moves = [];
  let left = 10;
  for (const p of seq) {
    if (!left) break;
    const out = zoneMiss(p) > 0;
    moves.push(out ? null : swing(p, 10 - left));
    if (!out) left -= 1;
  }
  const game = playChallenge(seq, moves, 'R');
  return { body: { nick: '민성', team: 'lg', day: kstDay(Date.now()), mode: 'challenge', token: t.token, seed: t.seed, moves, bats: 'R', lights: game.lights, score: game.score }, game, seq };
}
const post = (token, body) => call('POST', '/scores', { token, body });
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };   // 어긋난 점수 로그를 감춘다
const gainOf = (day, { game, seq }) => missionGain(missionsOn(day), gameFacts(game.results, seq, game.score));

test('미션: 로그인 안 하면 판을 받지 않고, 로그인하면 내 계정이 오늘(한국 시간) 빈 진행을 준다', async () => {
  assert.equal((await post(null, { mode: 'challenge' })).status, 401);
  assert.equal((await call('GET', '/me')).status, 401);
  const token = await login('c1', 'p-device-0001');
  assert.deepEqual((await me(token)).missions, { day: '2026-11-24', n: [0, 0, 0], paid: 0 });
});

test('미션: 서버가 다시 돌린 판으로 세고 게임이 보낸 점수·전광판은 쓰지 않는다', async () => {
  clockTo('2026-11-25T03:00:00Z');
  assert.deepEqual(missionsOn('2026-11-25').map((m) => m.id), ['perfect3', 'ball4', 'score8k']);
  const token = await login('c1', 'p-device-0001');
  const late = played(await ticket('p-device-0001', 42), (p, k) => 110 + (k % 3) * 10);   // 110~130ms 늦게 휘둘러 파울만, 존 밖 공은 골라낸다
  const balls = late.body.moves.filter((m) => m === null).length;
  assert.ok(late.game.score < 8000 && balls >= 1, `${late.game.score} ${balls}`);
  const res = await quiet(async () => (await post(token, { ...late.body, score: 50000, lights: 'H'.repeat(10) })).json());   // 숫자만 고친 요청
  assert.equal(res.ok, true);
  assert.deepEqual(res.missions, { day: '2026-11-25', n: [0, Math.min(4, balls), 0], paid: balls >= 4 ? 2 : 0, done: balls >= 4 ? [1] : [], earned: balls >= 4 ? TIER_COINS[1] : 0, bonus: 0 });
  assert.deepEqual((await me(token)).missions, { day: '2026-11-25', n: [0, Math.min(4, balls), 0], paid: balls >= 4 ? 2 : 0 });
});

test('미션: 채우면 칸 값만큼, 셋 다 채우면 100을 더 주고, 그날 더 쳐도 미션 코인은 더 없다', async () => {
  const day = '2026-11-24';
  assert.deepEqual(missionsOn(day).map((m) => [m.id, m.need]), [['play2', 2], ['hr3', 3], ['run5', 1]]);
  const token = await login('c1', 'p-device-0001');
  let state = null, missionCoins = 0, gameCoins = 0;
  for (const seed of [42, 7, 99]) {
    const p = played(await ticket('p-device-0001', seed)), want = advanceMissions(state, day, gainOf(day, p));
    const res = await (await post(token, p.body)).json();
    assert.deepEqual(res.missions, { day, ...want.state, done: want.done, earned: want.coins, bonus: want.bonus }, `시드 ${seed}`);
    state = want.state; missionCoins += want.coins; gameCoins += res.earned;
    assert.equal(res.coins, gameCoins + missionCoins);   // 지갑 = 판 코인 + 미션 코인
    later(30000);   // 판 코인은 20초 간격(COIN_GAP_MS)
  }
  assert.deepEqual(state, { day, n: [2, 3, 1], paid: 15 });   // 정타만 친 두 판이면 셋 다 찬다(시드 42·7)
  assert.equal(missionCoins, TIER_COINS[0] + TIER_COINS[1] + TIER_COINS[2] + ALL_BONUS);
});

test('미션: 같은 표로 다시 보내거나 동시에 두 번 보내도 한 번만 센다', async () => {
  const day = '2026-11-24', token = await login('c1', 'p-device-0001');
  const once = played(await ticket('p-device-0001', 42)), want = advanceMissions(null, day, gainOf(day, once));
  const both = await Promise.all([post(token, once.body), post(token, once.body)]);
  assert.ok(both.some((r) => r.status === 200));
  assert.deepEqual((await me(token)).missions, { day, ...want.state });
  const again = await post(token, once.body);   // 다 끝난 뒤 다시 보낸 같은 판
  assert.deepEqual([again.status, (await again.json()).error], [400, 'seed_used']);
  const after = await me(token);
  assert.deepEqual(after.missions, { day, ...want.state });
  assert.equal(after.coins, Math.floor(once.game.score / 100) + want.coins);
});

test('미션: 거절된 판(망가진 타이밍·남의 표·너무 빨리 끝낸 판)은 세지 않는다', async () => {
  const token = await login('c1', 'p-device-0001'), good = played(await ticket('p-device-0001', 42));
  const mine = await ticket('p-device-0002', 42), atNow = { token: await signSeed(env.SESSION_SECRET, 'p-device-0001', 42, Date.now()) };
  for (const [body, error] of [
    [{ ...good.body, moves: good.body.moves.slice(0, 3) }, 'bad_moves'],          // 판이 마지막 공에서 끝나지 않는다
    [{ ...good.body, moves: good.body.moves.map(() => 0.5) }, 'bad_moves'],       // 정수가 아닌 타이밍
    [{ ...good.body, token: mine.token }, 'bad_seed'],                             // 남의 표
    [{ ...good.body, token: atNow.token }, 'too_fast'],                            // 표를 받자마자 끝낸 판
  ]) {
    const res = await post(token, body);
    assert.deepEqual([res.status, (await res.json()).error], [400, error]);
  }
  assert.deepEqual((await me(token)).missions, { day: '2026-11-24', n: [0, 0, 0], paid: 0 });
});

test('미션: 한국 시간 0시에 새 미션으로 바뀌고 지난날 진행·보상 표시는 이어지지 않는다', async () => {
  const token = await login('c1', 'p-device-0001');
  const p = played(await ticket('p-device-0001', 42));
  assert.equal((await (await post(token, p.body)).json()).missions.day, '2026-11-24');
  clockTo('2026-11-24T14:59:59Z');   // 한국 시간 23:59:59
  assert.equal((await me(token)).missions.day, '2026-11-24');
  assert.notDeepEqual((await me(token)).missions.n, [0, 0, 0]);
  clockTo('2026-11-24T15:00:00Z');   // 한국 시간 11-25 0시
  assert.deepEqual((await me(token)).missions, { day: '2026-11-25', n: [0, 0, 0], paid: 0 });
  const next = played(await ticket('p-device-0001', 7)), want = advanceMissions(null, '2026-11-25', gainOf('2026-11-25', next));
  assert.deepEqual((await (await post(token, next.body)).json()).missions, { day: '2026-11-25', ...want.state, done: want.done, earned: want.coins, bonus: want.bonus });
});
