import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstDay, weekStart, addDays, maxScoreFor, validateSubmission, aggregate, DAILY_LAST_DAY, styleAt, MOVES_FROM, SAME_SWINGS } from '../src/rules.js';
import { SEED_TTL_MS, MIN_PITCH_MS } from '../src/seeds.js';
import { makeSequence, pitcherHand, dailySeed, zoneMiss } from '../../js/core/pitches.js';
import { playChallenge } from '../../js/core/challenge.js';

test('한국 시간 날짜와 월요일 0시 주 경계', () => {
  assert.equal(kstDay(Date.parse('2026-10-25T14:59:59Z')), '2026-10-25');   // 한국 시간 일요일 23:59:59
  assert.equal(kstDay(Date.parse('2026-10-25T15:00:00Z')), '2026-10-26');   // 한국 시간 월요일 0:00
  assert.equal(weekStart('2026-10-25'), '2026-10-19');   // 일요일은 그 전 월요일 주
  assert.equal(weekStart('2026-10-26'), '2026-10-26');   // 월요일은 새 주
  assert.equal(weekStart('2026-11-01'), '2026-10-26');
  assert.equal(weekStart('2027-01-03'), '2026-12-28');   // 해가 바뀌는 주
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

// 가짜 공: 존 가운데, 존 밖이지만 배트가 닿는 공, 배트가 닿지 않는 공
const IN = { tx: 0, ty: 0.8 }, BALL = { tx: 0.4, ty: 0.8 }, FAR = { tx: 0.6, ty: 0.8 };
const seqOf = (s) => s.split('').map((c) => ({ i: IN, b: BALL, f: FAR }[c]));

test('연속 홈런 보너스: 볼은 연속을 끊지 않고, 다른 결과는 끊는다(2026-10-30)', () => {
  const tenIn = seqOf('i'.repeat(40)), base = 1100;
  // G G R G G G R R R R: 두 번째 +500, 끊긴 뒤 다시 두 번째 +500, 세 번째 +1,000. 아웃(R)은 정타 보너스 100, 마지막 공은 2배
  assert.equal(maxScoreFor('GGRGGGRRRR', tenIn), base + (base + 500) + 100 + base + (base + 500) + (base + 1000) + 100 * 3 + 200);
  // G Y G: 볼(Y) 사이에 두고도 백투백이다
  assert.equal(maxScoreFor(`GYG${'R'.repeat(8)}`, seqOf(`ibi${'i'.repeat(37)}`)), base + 100 + (base + 500) + 100 * 7 + 200);
});

test('전광판이 그 공 순서로 나올 수 있을 때만 최대 점수를 준다', () => {
  // 홈런+정타 10번에 마지막 공 2배, 연속 홈런 보너스(두 번째 +500, 세 번째부터 +1,000)까지: 1100 + 1600 + 2100×7 + 2100×2
  assert.equal(maxScoreFor('G'.repeat(10), seqOf('i'.repeat(40))), 1100 + 1600 + 2100 * 7 + 2100 * 2);
  assert.equal(maxScoreFor('R'.repeat(10), seqOf('i'.repeat(40))), 1100);    // 아웃이어도 정타 보너스 100씩
  assert.equal(maxScoreFor('YG', seqOf(`bi${'i'.repeat(38)}`)), null);      // 기회가 남았는데 판이 끝날 수 없다
  // 마지막 기회(남은 기회 1번)의 볼은 2배. 예전 상한(볼은 100)으로는 이런 정상 판이 거절됐다
  // 볼은 연속 홈런을 끊지 않아서 마지막 G도 10번째 연속 홈런(+1,000)이다
  assert.equal(maxScoreFor(`${'G'.repeat(9)}YYG`, seqOf(`${'i'.repeat(9)}bbi${'i'.repeat(28)}`)), 1100 + 1600 + 2100 * 7 + 2 * 200 + 2100 * 2);
  assert.equal(maxScoreFor('Y', seqOf('i')), null);                         // 존 안 공은 볼이 될 수 없다
  assert.equal(maxScoreFor(`G${'R'.repeat(9)}`, seqOf(`f${'i'.repeat(39)}`)), null);   // 배트가 닿지 않는 공은 안타가 될 수 없다
  assert.equal(maxScoreFor(`R${'R'.repeat(9)}`, seqOf(`f${'i'.repeat(39)}`)), 8 * 100 + 200);   // 닿지 않는 공에 휘두르면 헛스윙(0점), 마지막 공은 2배
  assert.equal(maxScoreFor(`${'G'.repeat(10)}${'Y'.repeat(30)}`, seqOf('b'.repeat(40))), null);   // 2026-10-30 조작: 10번째 기회 뒤에 볼 30개
  assert.equal(maxScoreFor('YYYGG', seqOf('bbbii')), 3 * 100 + 1100 + 1600);   // 공을 다 쓰면 기회가 남아도 끝난다(가짜 5개짜리 순서). 두 번째 G는 백투백 +500
});

const NOW = Date.parse('2026-10-28T03:00:00Z');   // 한국 시간 2026-10-28 12:00(수)
const PID = 'p-1234abcd';   // 로그인 표에서 꺼낸 사람 ID
// 실제 공 순서대로 친 전광판: 존 밖 공은 골라내고(Y), 존 안 공은 쳐서 안타(G). 기회 10번을 다 쓰면 끝
const played = (seed, style = 'classic') => {
  let out = '', left = 10;
  for (const p of makeSequence(seed, pitcherHand(seed) === 'L', style)) { if (!left) break; if (zoneMiss(p) > 0) out += 'Y'; else { out += 'G'; left--; } }
  return out;
};
const DAY = '2026-10-28', LIGHTS = played(dailySeed(DAY));
const base = { nick: '타자1234', team: 'lg', day: DAY, lights: LIGHTS, score: 3000 };
const check = (patch, playerId = PID) => validateSubmission({ ...base, ...patch }, NOW, playerId);
// 10구 도전: 서버가 내준 표(seed_tokens 한 줄)와 함께 검사한다. 기본은 1분 전에 받은 아직 안 쓴 표
const ticket = (seed, patch = {}) => ({ id: 'tk', player_id: PID, seed, issued_at: NOW - 60e3, used_at: null, ...patch });
const challenge = (seed, patch = {}, tk = ticket(seed)) => validateSubmission({ ...base, mode: 'challenge', token: 'tk', lights: played(seed), ...patch }, NOW, PID, tk);
// 다시 돌리기(2026-11-19)에 보내는 공마다 타이밍: 존 밖 공은 보내고(null), 존 안 공은 pick(존 안 공 차례)로 휘두르거나(ms) 지켜본다(null). 기회 10번을 다 쓰면 끝
const DTS = [0, -30, 25, -55, 70, -15, 40, -80, 10, 5];
const movesBy = (seed, style = 'classic', pick = (k) => DTS[k % DTS.length]) => {
  const out = [];
  let left = 10, k = 0;
  for (const p of makeSequence(seed, pitcherHand(seed) === 'L', style)) { if (!left) break; if (zoneMiss(p) > 0) out.push(null); else { out.push(pick(k++)); left--; } }
  return out;
};
const replayOf = (seed, moves, style = 'classic', bats = 'R') => playChallenge(makeSequence(seed, pitcherHand(seed) === 'L', style), moves, bats);

test('맞는 점수는 받고 그 주 월요일을 붙인다', () => {
  assert.deepEqual(check({}), { ok: true, value: { playerId: PID, ...base, week: '2026-10-26', seed: dailySeed(DAY), style: 'classic' } });   // mode가 없는 예전 게임은 오늘의 10구로 본다(seed는 맞은 공 순서의 시드)
  assert.equal(check({ mode: 'daily' }).ok, true);
  assert.equal(check({ playerId: 'someone-else' }).value.playerId, PID);   // 보낸 내용의 ID는 쓰지 않는다
  assert.equal(check({ day: '2026-10-26', lights: played(dailySeed('2026-10-26')) }).ok, true);   // 이틀 전까지 받는다
  assert.equal(check({ day: '2026-10-29', lights: LIGHTS }).ok, true);   // 자정을 넘겨 끝난 판은 전날 공 순서로 본다
  assert.equal(challenge(42).ok, true);   // 10구 도전은 서버가 내준 표의 시드로 본다
  assert.equal(check({ nick: '가나다라마바사아자차' }).ok, true);                // 한글 10자
  assert.equal(check({ nick: '  공백  ' }).value?.nick, '공백');
});

test('규칙상 나올 수 없는 값은 거절한다', () => {
  // 오늘의 10구는 자정을 넘긴 판을 위해 전날 순서도 보므로, 두 날짜 모두에서 나올 수 없어야 거절된다
  const seqs = [DAY, addDays(DAY, -1)].map((d) => makeSequence(dailySeed(d), pitcherHand(dailySeed(d)) === 'L'));
  const maxOf = (lights) => Math.max(...seqs.map((q) => maxScoreFor(lights, q)).filter((m) => m !== null));
  const inBoth = seqs[0].findIndex((p, i) => zoneMiss(p) === 0 && zoneMiss(seqs[1][i]) === 0);
  const cases = {
    bad_team: { team: 'comets' },             // 예전 가상 팀 id
    bad_lights: { lights: `${'G'.repeat(10)}${'Y'.repeat(30)}` },   // 2026-10-30 조작: 10번째 기회 뒤에 볼 30개
    bad_score: { score: maxOf(LIGHTS) + 1 },
    stale_day: { day: '2026-10-25' },               // 사흘 전
    bad_nick: { nick: '가나다라마바사아자차카' },      // 11자
    seed_required: { mode: 'challenge', seed: 42, lights: played(42) },   // 10구 도전인데 서버가 내준 표가 없다(게임이 정한 시드만 있다)
    bad_mode: { mode: 'scenario' },
  };
  for (const [error, patch] of Object.entries(cases)) assert.deepEqual(check(patch), { ok: false, error }, error);
  assert.equal(check({ lights: `${'R'.repeat(inBoth)}Y${'R'.repeat(10 - inBoth)}` }).error, 'bad_lights');   // 존 안 공에 볼
  assert.equal(check({ lights: `${'Y'.repeat(30)}${'G'.repeat(10)}` }).error, 'bad_lights');   // 순서를 바꿔도 실제 공 순서와 안 맞는다
  assert.equal(check({ day: '2026-10-30' }).error, 'stale_day');   // 이틀 뒤
  assert.equal(check({ lights: 'GGGGGGGGGX' }).error, 'bad_lights');
  assert.equal(check({ lights: '' }).error, 'bad_lights');
  assert.equal(check({ score: 10.5 }).error, 'bad_score');
  assert.equal(check({ score: -1 }).error, 'bad_score');
  assert.equal(check({ nick: '' }).error, 'bad_nick');
  assert.equal(check({ nick: 'a\u0007b' }).error, 'bad_nick');
  assert.equal(check({}, 'ABC').error, 'bad_player');
  assert.equal(check({}, '').error, 'bad_player');
  assert.equal(validateSubmission(null, NOW, PID).error, 'bad_body');
});

test('10구 도전은 서버가 내준 표의 시드로만 보고, 표는 내 것이고 안 썼고 기한 안이고 한 판 칠 시간이 지나야 한다', () => {
  assert.equal(challenge(42, { seed: 7 }).ok, true);   // 게임이 보낸 시드는 쓰지 않는다
  assert.equal(challenge(42, { lights: played(7) }).error, played(7) === played(42) ? undefined : 'bad_lights');   // 다른 판의 전광판
  assert.equal(challenge(42, {}, null).error, 'bad_seed');   // 서버에 없는 표
  assert.equal(challenge(42, {}, ticket(42, { player_id: 'p-someone-else' })).error, 'bad_seed');   // 남이 받은 표
  assert.equal(challenge(42, {}, ticket(42, { used_at: NOW - 1000 })).error, 'seed_used');
  assert.equal(challenge(42, {}, ticket(42, { issued_at: NOW - SEED_TTL_MS })).ok, true);
  assert.equal(challenge(42, {}, ticket(42, { issued_at: NOW - SEED_TTL_MS - 1 })).error, 'seed_expired');
  const pitches = played(42).length, fastest = pitches * MIN_PITCH_MS;   // 공 하나에 1.5초는 걸린다
  assert.equal(challenge(42, {}, ticket(42, { issued_at: NOW - fastest })).ok, true);
  assert.equal(challenge(42, {}, ticket(42, { issued_at: NOW - fastest + 1 })).error, 'too_fast');
  assert.equal(challenge(42, { token: '' }).error, 'seed_required');
});

test('오늘의 10구는 없어진 날(2026-10-30)까지 친 판만 받는다', () => {
  const later = Date.parse('2026-10-31T03:00:00Z');   // 한국 시간 2026-10-31 12:00
  const daily = (day, patch = {}) => validateSubmission({ ...base, day, lights: played(dailySeed(day)), ...patch }, later, PID);
  assert.equal(DAILY_LAST_DAY, '2026-10-30');
  assert.equal(daily('2026-10-30').ok, true);   // 열어 둔 예전 탭이 자정 전에 친 판
  assert.equal(daily('2026-10-31').error, 'mode_removed');   // mode가 없는 예전 게임
  assert.equal(daily('2026-10-31', { mode: 'daily' }).error, 'mode_removed');
});

test('이번 주 투수(2026-11-16): 표를 내준 주의 유형 공 순서로 검사하고, 주 경계는 한국 시간 월요일 0시다', () => {
  assert.equal(styleAt(Date.parse('2026-11-22T14:59:59Z')), 'classic');   // 한국 시간 11-22(일) 23:59:59까지는 정통파
  assert.equal(styleAt(Date.parse('2026-11-22T15:00:00Z')), 'power');     // 11-23(월) 0시부터 강속구형
  assert.equal(styleAt(Date.parse('2026-11-29T14:59:59Z')), 'power');
  assert.equal(styleAt(Date.parse('2026-11-29T15:00:00Z')), 'finesse');   // 11-30(월) 기교파
  const now = Date.parse('2026-11-24T03:00:00Z'), day = '2026-11-24';   // 한국 시간 11-24(화) 12:00, 강속구형 주
  const tk = (seed, issued = now - 60e3) => ({ id: 'tk', player_id: PID, seed, issued_at: issued, used_at: null });
  // 11-23부터는 타이밍을 보내야 받는다(MOVES_FROM). 서버가 그 타이밍을 표를 내준 주의 유형 공 순서로 다시 돌린다
  const send = (seed, moves, t = tk(seed), at = now, d = day) => validateSubmission({ ...base, day: d, mode: 'challenge', token: 'tk', moves, bats: 'R' }, at, PID, t);
  // 정통파 공 순서로 친 타이밍이 강속구형 공 순서로는 다른 판이 되는 시드(시드 1~40 가운데 처음 것)
  const seed = Array.from({ length: 40 }, (_, i) => i + 1).find((s) => replayOf(s, movesBy(s), 'power')?.lights !== replayOf(s, movesBy(s)).lights);
  assert.ok(seed, '유형이 바뀌면 공 순서가 달라진다');
  const ok = send(seed, movesBy(seed, 'power'));
  assert.deepEqual([ok.ok, ok.value?.style, ok.value?.week, ok.value?.lights], [true, 'power', '2026-11-23', replayOf(seed, movesBy(seed, 'power'), 'power').lights]);
  const classic = send(seed, movesBy(seed));   // 정통파 순서로 친 타이밍도 강속구형 공 순서로 다시 돌린다(판이 안 맞으면 bad_moves)
  assert.equal(classic.value?.lights ?? classic.error, replayOf(seed, movesBy(seed), 'power')?.lights ?? 'bad_moves');
  // 일요일 밤(정통파 주)에 받은 표로 자정을 넘겨 끝낸 판: 정통파로 다시 돌려 받는다. 날짜가 월요일이라 새 주 랭킹에 들어간다
  const late = send(seed, movesBy(seed), tk(seed, Date.parse('2026-11-22T14:58:00Z')), Date.parse('2026-11-22T15:01:00Z'), '2026-11-23');
  assert.deepEqual([late.ok, late.value?.style, late.value?.week, late.value?.lights], [true, 'classic', '2026-11-23', replayOf(seed, movesBy(seed)).lights]);
});

test('다시 돌리기(2026-11-19): 서버가 공마다 타이밍으로 판을 다시 돌려 그 점수·전광판을 받고, 게임이 보낸 점수·전광판은 쓰지 않는다', () => {
  const seed = 42, moves = movesBy(seed), game = replayOf(seed, moves);
  const send = (patch = {}, tk = ticket(seed)) => validateSubmission({ ...base, mode: 'challenge', token: 'tk', moves, bats: 'R', lights: game.lights, score: game.score, ...patch }, NOW, PID, tk);
  assert.deepEqual(send(), { ok: true, value: { playerId: PID, nick: base.nick, team: base.team, day: DAY, week: '2026-10-26', score: game.score, lights: game.lights, seed, style: 'classic',
    play: JSON.stringify({ seed, style: 'classic', bats: 'R', moves }), results: game.results, mismatch: null } });   // results: 오늘의 미션을 세는 공마다 결과(2026-11-23)
  // 숫자만 고친 요청(2026-10-30 조작처럼): 서버가 다시 돌린 값으로 받고, 보낸 값은 어긋남으로 알린다(로그에만 남는다)
  const forged = send({ score: 99999, lights: 'H'.repeat(10) });
  assert.deepEqual([forged.ok, forged.value.score, forged.value.lights, forged.value.mismatch], [true, game.score, game.lights, { score: 99999, lights: 'H'.repeat(10) }]);
  assert.deepEqual(send({ score: undefined, lights: undefined }).value.mismatch, { score: null, lights: '' });
  const lefty = send({ bats: 'L' }), asLefty = replayOf(seed, moves, 'classic', 'L');   // 왼손 타자로 친 판은 왼손으로 다시 돌린다
  assert.deepEqual([lefty.value.score, lefty.value.lights], [asLefty.score, asLefty.lights]);
  assert.equal(send({ seed: 7 }).value.seed, seed);   // 게임이 보낸 시드는 쓰지 않는다
  // 표 검사는 그대로다. 한 판 칠 시간은 보낸 공 수 × 1.5초
  assert.equal(send({}, ticket(seed, { issued_at: NOW - moves.length * MIN_PITCH_MS })).ok, true);
  assert.equal(send({}, ticket(seed, { issued_at: NOW - moves.length * MIN_PITCH_MS + 1 })).error, 'too_fast');
  assert.equal(send({}, null).error, 'bad_seed');
  assert.equal(send({}, ticket(seed, { used_at: NOW - 1000 })).error, 'seed_used');
});

test('다시 돌리기: 타이밍 모양이 틀리거나, 판이 마지막 공에서 끝나지 않거나, 휘두른 타이밍이 모두 같으면 bad_moves', () => {
  const seed = 42, moves = movesBy(seed), last = (v) => moves.map((m, i) => (i === moves.length - 1 ? v : m));
  const send = (patch) => validateSubmission({ ...base, mode: 'challenge', token: 'tk', moves, bats: 'R', ...patch }, NOW, PID, ticket(seed)).error ?? 'ok';
  for (const bad of ['x', null, {}, [], Array(41).fill(null), last(1.5), last('0'), last(5001), moves.slice(0, -1), [...moves, null]]) assert.equal(send({ moves: bad }), 'bad_moves', JSON.stringify(bad));
  for (const bats of [undefined, 'X', 'r']) assert.equal(send({ bats }), 'bad_moves', String(bats));
  assert.equal(send({ moves: last(5000) }), 'ok');   // 아주 늦게 휘두른 헛스윙도 MOVE_MS까지는 받는다
  // 휘두른 공 5개 이상의 타이밍이 모두 같은 판(요청의 타이밍을 모두 0으로 고친 판). 사람은 사실상 이렇게 못 친다
  assert.equal(SAME_SWINGS, 5);
  assert.equal(send({ moves: movesBy(seed, 'classic', () => 0) }), 'bad_moves');
  assert.equal(send({ moves: movesBy(seed, 'classic', (k) => (k < 4 ? 0 : null)) }), 'ok');   // 4번만 휘둘렀다(나머지는 지켜본 스트라이크)
  assert.equal(send({ moves: movesBy(seed, 'classic', (k) => (k === 9 ? 1 : 0)) }), 'ok');   // 하나라도 다르면 받는다
});

test('타이밍 없는 옛 게임 판은 한국 시간 2026-11-23(월) 0시 전까지만 범위 검사로 받는다', () => {
  assert.equal(MOVES_FROM, Date.parse('2026-11-22T15:00:00Z'));
  const seed = 42, tk = (at) => ticket(seed, { issued_at: at - 60e3 });
  const old = (at, day = '2026-11-22') => validateSubmission({ ...base, day, mode: 'challenge', token: 'tk', lights: played(seed), score: 3000 }, at, PID, tk(at));
  assert.equal(old(MOVES_FROM - 1).ok, true);   // 11-22(일) 23:59:59.999에 온 옛 게임 판
  assert.equal(old(MOVES_FROM).error, 'moves_required');
  assert.equal(old(MOVES_FROM, '2026-11-23').error, 'moves_required');
  const moves = movesBy(seed), now = validateSubmission({ ...base, day: '2026-11-23', mode: 'challenge', token: 'tk', moves, bats: 'R' }, MOVES_FROM, PID, tk(MOVES_FROM));
  assert.deepEqual([now.ok, now.value.score], [true, replayOf(seed, moves).score]);
});

test('주간 순위: 이번 주 최고 기록으로 줄 세우고, 같은 점수는 같은 등수, 팀 점수는 팀원 최고 기록의 합', () => {
  const rows = [
    { player_id: 'a', day: '2026-10-26', nick: '처음이름', team: 'lotte', score: 3000 },
    { player_id: 'a', day: '2026-10-27', nick: '바꾼이름', team: 'lg', score: 2000 },   // 더 낮은 판은 순위에 안 들어간다
    { player_id: 'b', day: '2026-10-26', nick: '비', team: 'lotte', score: 5000 },
    { player_id: 'c', day: '2026-10-27', nick: '씨', team: 'lg', score: 4000 },
    { player_id: 'd', day: '2026-10-28', nick: '디', team: 'kt', score: 4000 },
  ];
  const r = aggregate(rows, 'a');
  assert.deepEqual(r.players.map((p) => [p.rank, p.nick, p.team, p.best]), [[1, '비', 'lotte', 5000], [2, '씨', 'lg', 4000], [2, '디', 'kt', 4000], [4, '바꾼이름', 'lotte', 3000]]);
  assert.deepEqual(r.teams.map((t) => [t.rank, t.team, t.total, t.players]), [[1, 'lotte', 8000, 2], [2, 'lg', 4000, 1], [2, 'kt', 4000, 1]]);   // a의 최고 기록은 롯데 때 낸 것
  assert.deepEqual(r.me, { rank: 4, best: 3000, days: 2, team: 'lotte' });
  assert.deepEqual(r.myTeam, { rank: 1, total: 8000, team: 'lotte' });
  assert.equal(r.players.some((p) => 'id' in p), false);   // 사람 ID는 밖으로 내보내지 않는다
  assert.deepEqual(aggregate([], null), { players: [], teams: [], count: 0, me: null, myTeam: null, near: null });
});

test("10구 끝 화면 '한 판 더' 줄의 near: 나보다 높은 기록 가운데 가장 낮은 사람, 1위면 나보다 낮은 기록 가운데 가장 높은 사람의 등수·기록만(같은 점수는 같은 등수)", () => {
  const rows = [
    { player_id: 'a', day: '2026-10-26', nick: '에이', team: 'lotte', score: 3000 },
    { player_id: 'b', day: '2026-10-26', nick: '비', team: 'lotte', score: 5000 },
    { player_id: 'c', day: '2026-10-27', nick: '씨', team: 'lg', score: 4000 },
    { player_id: 'd', day: '2026-10-28', nick: '디', team: 'kt', score: 4000 },
  ];
  assert.deepEqual(aggregate(rows, 'a').near, { above: { rank: 2, best: 4000 }, below: null });
  assert.deepEqual(aggregate(rows, 'c').near, { above: { rank: 1, best: 5000 }, below: null });   // 같은 점수(디)는 위가 아니다
  assert.deepEqual(aggregate(rows, 'b').near, { above: null, below: { rank: 2, best: 4000 } });
  const tie = [...rows, { player_id: 'e', day: '2026-10-28', nick: '이', team: 'nc', score: 5000 }];   // 공동 1위면 바로 아래는 3위
  assert.deepEqual(aggregate(tie, 'e').near, { above: null, below: { rank: 3, best: 4000 } });
  assert.deepEqual(aggregate([rows[0]], 'a').near, { above: null, below: null });   // 혼자
  assert.equal(aggregate(rows, null).near, null);
  assert.equal(aggregate(rows, 'zz').near, null);   // 이번 주에 안 친 사람
});
