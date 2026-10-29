import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kstDay, weekStart, addDays, maxScoreFor, validateSubmission, aggregate } from '../src/rules.js';

test('한국 시간 날짜와 월요일 0시 주 경계', () => {
  assert.equal(kstDay(Date.parse('2026-10-25T14:59:59Z')), '2026-10-25');   // 한국 시간 일요일 23:59:59
  assert.equal(kstDay(Date.parse('2026-10-25T15:00:00Z')), '2026-10-26');   // 한국 시간 월요일 0:00
  assert.equal(weekStart('2026-10-25'), '2026-10-19');   // 일요일은 그 전 월요일 주
  assert.equal(weekStart('2026-10-26'), '2026-10-26');   // 월요일은 새 주
  assert.equal(weekStart('2026-11-01'), '2026-10-26');
  assert.equal(weekStart('2027-01-03'), '2026-12-28');   // 해가 바뀌는 주
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('전광판으로 낼 수 있는 최대 점수', () => {
  assert.equal(maxScoreFor('G'.repeat(10)), 12100);   // 홈런+정타 10번에 마지막 공 2배
  assert.equal(maxScoreFor('R'.repeat(10)), 1100);    // 아웃이어도 정타 보너스 100씩
});

const NOW = Date.parse('2026-10-28T03:00:00Z');   // 한국 시간 2026-10-28 12:00(수)
const PID = 'p-1234abcd';   // 로그인 표에서 꺼낸 사람 ID
const base = { nick: '타자1234', team: 'lg', day: '2026-10-28', lights: 'GGRRGGRRGR', score: 3000 };
const check = (patch, playerId = PID) => validateSubmission({ ...base, ...patch }, NOW, playerId);

test('맞는 점수는 받고 그 주 월요일을 붙인다', () => {
  assert.deepEqual(check({}), { ok: true, value: { playerId: PID, ...base, week: '2026-10-26' } });
  assert.equal(check({ playerId: 'someone-else' }).value.playerId, PID);   // 보낸 내용의 ID는 쓰지 않는다
  assert.equal(check({ day: '2026-10-26' }).ok, true);                         // 이틀 전까지 받는다
  assert.equal(check({ day: '2026-10-29' }).ok, true);                         // 기기 시계가 조금 빨라도 받는다
  assert.equal(check({ lights: 'GGGGGGGGGGY', score: 1000 }).ok, true);        // 볼 1개면 11칸
  assert.equal(check({ lights: 'YYYYYYGGGGGGGGGG', score: 1000 }).ok, true);   // 볼 6개면 16칸(볼은 기회를 안 쓴다)
  assert.equal(check({ lights: `${'Y'.repeat(12)}${'G'.repeat(10)}`, score: 1000 }).ok, true);   // 볼 12개, 22칸
  assert.equal(check({ lights: 'YYYYYYGGGGGGGGG', score: 1000 }).ok, true);    // 예전 게임(볼 5개까지만 기회가 늘던 때)의 15칸
  assert.equal(check({ nick: '가나다라마바사아자차' }).ok, true);                // 한글 10자
  assert.equal(check({ nick: '  공백  ' }).value?.nick, '공백');
});

test('규칙상 나올 수 없는 값은 거절한다', () => {
  const cases = {
    bad_team: { team: 'comets' },             // 예전 가상 팀 id
    bad_lights: { lights: 'GGGGGGGGGGG' },          // 볼이 없는데 11칸
    bad_score: { score: maxScoreFor(base.lights) + 1 },
    stale_day: { day: '2026-10-25' },               // 사흘 전
    bad_nick: { nick: '가나다라마바사아자차카' },      // 11자
  };
  for (const [error, patch] of Object.entries(cases)) assert.deepEqual(check(patch), { ok: false, error }, error);
  assert.equal(check({ day: '2026-10-30' }).error, 'stale_day');   // 이틀 뒤
  assert.equal(check({ lights: 'GGGGGGGGGX' }).error, 'bad_lights');
  assert.equal(check({ lights: 'YYYYYYGGGGGGGGGGG' }).error, 'bad_lights');   // 볼 6개인데 17칸(어느 규칙에도 안 맞는다)
  assert.equal(check({ lights: `${'Y'.repeat(31)}${'G'.repeat(10)}` }).error, 'bad_lights');   // 41칸
  assert.equal(check({ score: 10.5 }).error, 'bad_score');
  assert.equal(check({ score: -1 }).error, 'bad_score');
  assert.equal(check({ nick: '' }).error, 'bad_nick');
  assert.equal(check({ nick: 'a\u0007b' }).error, 'bad_nick');
  assert.equal(check({}, 'ABC').error, 'bad_player');
  assert.equal(check({}, '').error, 'bad_player');
  assert.equal(validateSubmission(null, NOW, PID).error, 'bad_body');
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
  assert.deepEqual(aggregate([], null), { players: [], teams: [], count: 0, me: null, myTeam: null });
});
