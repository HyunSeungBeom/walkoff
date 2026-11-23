import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { addDays, kstDay, weekStart, seqOf } from '../src/rules.js';
import { RIVAL_FROM, RIVAL_POOL, RIVAL_SQL, SEEN_MAX, pickRival, parseRivalQuery } from '../src/rival.js';
import { playChallenge } from '../../js/core/challenge.js';
import { makeSequence, pitcherHand, zoneMiss } from '../../js/core/pitches.js';
import { scoreRange } from '../../js/core/score.js';
import { memoryD1 } from './d1.js';

// 모르는 사람과 대결(2026-11-23, src/rival.js). 시계는 대결을 여는 날(RIVAL_FROM) 한국 시간 낮 12시부터 흐르게 두고, 여는 날 전은 clockTo로 옮겨 본다.
// 게임과 여는 날이 같은지, 게임(js/game/rival.js parseRival)이 이 답을 받는지는 게임 테스트(tests/walkoff.spec.js '모르는 사람과 대결')가 본다(서버 배포 사본에는 js/game이 없다)
const realClock = Date.now;
let shift = 0;
Date.now = () => realClock() + shift;
const clockTo = (iso) => { shift = Date.parse(iso) - realClock(); };
clockTo(`${RIVAL_FROM}T12:00:00+09:00`);

// 실제 서버가 남기는 판(rules.js replaySubmission): 존 밖 공은 보내고 존 안 공은 DTS 차례로 휘두른 타이밍을 core로 다시 돌린 점수·전광판과 그 재료(play)
const DTS = [0, -30, 25, -55, 70, -15, 40, -80, 10, 5];
function played(seed, style = 'classic', bats = 'R') {
  const seq = seqOf(seed, style), moves = [];
  let left = 10, k = 0;
  for (const p of seq) { if (!left) break; if (zoneMiss(p) > 0) moves.push(null); else { moves.push(DTS[k++ % DTS.length]); left--; } }
  const g = playChallenge(seq, moves, bats);
  return { score: g.score, lights: g.lights, play: JSON.stringify({ seed, style, bats, moves }) };
}
const today = () => kstDay(Date.now());
// daily_scores 한 줄. 점수·전광판·재료를 안 주면 그 시드로 실제로 친 판
function addRow(db, { player, day = today(), nick = '골든', team = 'lotte', seed = 1001, style = 'classic', bats = 'R', hidden = 0, ...patch }) {
  const g = { ...played(seed, style, bats), ...patch };
  db.rows(`INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights, play, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING player_id`,
    player, day, weekStart(day), nick, team, g.score, g.lights, g.play, hidden);
  return g;
}
const rival = (env, query = '', ip = '1.1.1.1') => worker.fetch(new Request(`https://api.test/rival${query}`, { headers: { 'cf-connecting-ip': ip } }), env);
// 고르기 시험용 줄(점수·전광판은 아무 값, 재료는 시드만 맞게)
const row = (player_id, score, seed, patch = {}) => ({ player_id, score, lights: 'SRRRRRRRRR', nick: `타자${seed % 1000}`, team: 'lg', play: JSON.stringify({ seed, style: 'classic', bats: 'R', moves: [] }), ...patch });

test('상대 고르기: 사람마다 내 점수와 가장 가까운 판 하나로 줄 세워 앞 세 사람 가운데 고른다(같은 차면 높은 판). 계정 번호는 안 내보낸다', () => {
  const rows = [row('p-a', 1000, 11), row('p-b', 5000, 12), row('p-c', 9000, 13), row('p-d', 10000, 14), row('p-e', 15000, 15), row('p-c', 3000, 16)];
  const at = (r) => pickRival(rows, { target: 9500 }, () => r);
  assert.equal(RIVAL_POOL, 3);
  assert.deepEqual([at(0), at(0.4), at(0.99)].map((g) => g.score), [10000, 9000, 5000]);   // 9000·10000은 500점 차로 같아 높은 판이 먼저, 그다음 5000(15000보다 가깝다)
  assert.deepEqual(at(0), { seed: 14, style: 'classic', bats: 'R', score: 10000, lights: 'SRRRRRRRRR', nick: '타자14', team: 'lg' });
  assert.equal(pickRival(rows, { target: 2900 }, () => 0).seed, 16);   // 같은 사람(p-c)의 두 판 가운데 가까운 판
  assert.equal(pickRival(rows, {}, () => 0).score, 5000);   // 내 점수를 모르면 판 점수의 가운데 값(여섯 판이라 낮은 쪽 5000)과 견준다
  assert.equal(pickRival([], { target: 100 }), null);
});

test('상대 고르기: 나·닉네임 규칙에 어긋난 이름·망가진 줄·이미 친 공은 빼고, 최근 친 공 셋의 주인은 다른 날 판까지 빼되 그 사람만 남으면 이미 친 공만 뺀다', () => {
  const bad = [
    row('p-me', 9000, 21),
    row('p-x', 9000, 22, { nick: '씨발' }), row('p-x', 9000, 23, { nick: '운영자' }), row('p-x', 9000, 24, { nick: '' }),
    row('p-y', 9000, 25, { play: '{' }), row('p-y', 9000, 26, { play: JSON.stringify({ seed: 0, bats: 'R' }) }), row('p-y', 9000, 27, { play: JSON.stringify({ seed: 27, bats: 'X' }) }),
    row('p-y', 9000, 28, { play: JSON.stringify({ seed: 28, style: 'knuckle', bats: 'R' }) }), row('p-z', 9000, 29, { team: 'giants' }), row('p-z', 9000, 30, { lights: 'GGRR' }),
  ];
  assert.equal(pickRival([...bad, row('p-ok', 100, 31)], { target: 9000, player: 'p-me' }, () => 0).seed, 31);   // 점수가 멀어도 남은 한 판
  const rows = [row('p-a', 9000, 41), row('p-a', 8000, 42), row('p-b', 5000, 43), row('p-c', 7000, 44)];
  const pick = (seen) => pickRival(rows, { target: 9000, seen }, () => 0)?.seed;
  assert.equal(pick([]), 41);
  assert.equal(pick([41]), 44);   // 방금 친 p-a는 다른 날 판(42)도 빼고 남은 사람 가운데 가까운 p-c
  assert.equal(pick([43, 9, 9, 41]), 42);   // 최근 셋(43, 9, 9)의 주인(p-b)만 사람째 빼고, 넷째(41)는 그 공만 뺀다(p-a의 다른 판 42는 된다)
  assert.equal(pick([41, 44, 43]), 42);   // 남은 사람이 모두 최근에 만난 사람이면 이미 친 공만 뺀다
  assert.equal(pick([41, 42, 43, 44]), undefined);   // 다 쳤으면 없다
});

test('게임이 보내는 값: 점수·랭킹 번호가 틀리면 거절하고, 이미 친 공은 앞 30개의 시드만 본다', () => {
  const q = (s) => parseRivalQuery(new URLSearchParams(s));
  assert.deepEqual(q(''), { ok: true, value: { target: null, seen: [], player: '' } });
  assert.deepEqual(q('score=12300&seen=16,zz,-1,0,1a2b3c4d,abc&player=p-device-0001'), { ok: true, value: { target: 12300, seen: [42, 1295, 13368], player: 'p-device-0001' } });
  assert.equal(q(`seen=${Array.from({ length: SEEN_MAX + 5 }, (_, i) => (i + 1).toString(36)).join(',')}`).value.seen.length, SEEN_MAX);
  for (const s of ['score=-5', 'score=1.5', 'score=abc', 'score=12345678']) assert.deepEqual(q(s), { ok: false, error: 'bad_score' });
  for (const s of ['player=P-UPPER-0001', 'player=short', `player=${'a'.repeat(41)}`]) assert.deepEqual(q(s), { ok: false, error: 'bad_player' });
});

test('GET /rival: 여는 날 전에는 403 not_yet, 그 뒤에는 최근 7일 다른 사람의 숨기지 않은 타이밍 판 하나를 타이밍·계정 번호 없이 주고, 그 공 순서로 낼 수 있는 점수다', async () => {
  const env = { DB: memoryD1() };
  const ok = addRow(env.DB, { player: 'p-golden-0001', seed: 1001, style: 'power', bats: 'L', day: addDays(today(), -6) });
  addRow(env.DB, { player: 'p-me-000001', seed: 1002 });
  addRow(env.DB, { player: 'p-hidden-0001', seed: 1003, hidden: 1 });
  addRow(env.DB, { player: 'p-hidden-0002', seed: 1004, hidden: 2 });
  addRow(env.DB, { player: 'p-noplay-0001', seed: 1005, play: null });
  addRow(env.DB, { player: 'p-old-000001', seed: 1006, day: addDays(today(), -7) });   // 오늘까지 7일보다 하루 앞
  addRow(env.DB, { player: 'p-badnick-01', seed: 1007, nick: '씨발' });
  clockTo(`${addDays(RIVAL_FROM, -1)}T23:59:00+09:00`);
  let res = await rival(env, '?player=p-me-000001');
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: 'not_yet', from: RIVAL_FROM });
  clockTo(`${RIVAL_FROM}T12:00:00+09:00`);
  res = await rival(env, '?score=0&player=p-me-000001');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const text = await res.text(), body = JSON.parse(text);
  assert.deepEqual(body, { ok: true, rival: { seed: 1001, style: 'power', bats: 'L', score: ok.score, lights: ok.lights, nick: '골든', team: 'lotte' } });
  assert.equal(/moves|player|p-golden/.test(text), false);   // 타이밍과 계정 번호는 답에 없다
  const range = scoreRange(ok.lights, makeSequence(1001, pitcherHand(1001) === 'L', 'power'));   // 게임이 받을 때 하는 검사(js/game/duel.js checkDuel)와 같은 core 검사
  assert.ok(range && ok.score >= range.min && ok.score <= range.max);
  res = await rival(env, `?seen=${(1001).toString(36)}&player=p-me-000001`);
  assert.deepEqual(await res.json(), { ok: true, rival: null });   // 이미 친 공뿐이면 없다
  assert.equal((await rival(env, '?score=x')).status, 400);
});

test('GET /rival: 최근 두 주만 색인(daily_scores_week)으로 읽는다(한 번에 읽는 줄이 두 주 판 수를 넘지 않는다)', () => {
  const db = memoryD1(), from = addDays(today(), -6);
  const plan = db.rows(`EXPLAIN QUERY PLAN ${RIVAL_SQL}`, weekStart(from), weekStart(today()), from).map((r) => r.detail).join(' / ');
  assert.match(plan, /USING INDEX daily_scores_week/);
});

test('GET /rival 횟수 제한: IP마다 세고 넘으면 429(CORS 머리글, 60초 뒤 다시)', async () => {
  const seen = new Map(), env = { DB: memoryD1(), RIVAL_LIMIT: { limit: async ({ key }) => { seen.set(key, (seen.get(key) ?? 0) + 1); return { success: seen.get(key) <= 2 }; } } };
  const r = [];
  for (let i = 0; i < 3; i++) r.push((await rival(env, '', '1.1.1.1')).status);
  assert.deepEqual(r, [200, 200, 429]);
  assert.equal((await rival(env, '', '2.2.2.2')).status, 200);
  const over = await rival(env, '', '1.1.1.1');
  assert.equal(over.headers.get('access-control-allow-origin'), '*');
  assert.equal(over.headers.get('retry-after'), '60');
  assert.deepEqual(await over.json(), { ok: false, error: 'rate_limited' });
});
