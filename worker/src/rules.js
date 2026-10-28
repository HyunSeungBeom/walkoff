// 랭킹 규칙. 게임(index.html)도 같은 팀 목록과 주 계산을 써야 해서, 테스트로 둘이 같은지 맞춰 본다
export const TEAM_IDS = ['kia', 'kt', 'lg', 'nc', 'ssg', 'doosan', 'lotte', 'samsung', 'kiwoom', 'hanwha'];   // KBO 10개 구단(게임의 TEAMS와 같은 순서)
const DAY_MS = 864e5;

// 한국 시간 날짜(YYYY-MM-DD)
export const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// 그 날짜가 든 주의 월요일. 랭킹은 한국 시간 월요일 0시에 새로 시작한다
export function weekStart(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();   // 0 일요일 … 6 토요일
  return addDays(day, -((dow + 6) % 7));
}

// 전광판 한 칸이 낼 수 있는 가장 큰 점수: 안타 칸은 홈런과 정타 보너스, 볼은 100, 나머지도 정타 보너스 100까지
const LIGHT_MAX = { G: 1100, Y: 100, R: 100 };
export function maxScoreFor(lights) {
  const each = lights.split('').map((c) => LIGHT_MAX[c]);
  return each.reduce((a, b) => a + b, 0) + Math.max(...each);   // 마지막 기회 한 공은 점수 2배
}

// 오늘의 10구 점수 한 건을 검사한다. 마음먹고 조작한 요청까지 막지는 못하고, 규칙상 나올 수 없는 값만 거른다
export function validateSubmission(b, nowMs) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const playerId = String(b.playerId ?? ''), nick = String(b.nick ?? '').trim(), team = String(b.team ?? '');
  const day = String(b.day ?? ''), lights = String(b.lights ?? ''), score = b.score;
  if (!/^[a-z0-9-]{8,40}$/.test(playerId)) return { ok: false, error: 'bad_player' };
  if (!nick || [...nick].length > 10 || /[\u0000-\u001f\u007f]/.test(nick)) return { ok: false, error: 'bad_nick' };
  if (!TEAM_IDS.includes(team)) return { ok: false, error: 'bad_team' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad_day' };
  const today = kstDay(nowMs);
  if (day < addDays(today, -2) || day > addDays(today, 1)) return { ok: false, error: 'stale_day' };   // 늦게 보낸 기록은 이틀까지 받는다
  if (!/^[GYR]{10,15}$/.test(lights)) return { ok: false, error: 'bad_lights' };
  const balls = lights.split('').filter((c) => c === 'Y').length;
  if (lights.length !== 10 + Math.min(balls, 5)) return { ok: false, error: 'bad_lights' };   // 볼을 골라낼 때마다 기회 +1, 최대 +5
  if (!Number.isInteger(score) || score < 0 || score > maxScoreFor(lights)) return { ok: false, error: 'bad_score' };
  return { ok: true, value: { playerId, nick, team, day, week: weekStart(day), score, lights } };
}

// 같은 점수는 같은 등수(1, 2, 2, 4)
function rankBy(list) {
  list.sort((a, b) => b.total - a.total);
  let rank = 0;
  list.forEach((x, i) => { if (i === 0 || x.total !== list[i - 1].total) rank = i + 1; x.rank = rank; });
  return list;
}

// 한 주의 기록을 사람별·팀별로 더한다. 이름과 팀은 그 사람의 가장 최근 기록을 따르고,
// 팀 점수는 기록을 낸 날의 팀으로 간다. 밖으로 내보내는 목록에는 사람 ID를 넣지 않는다
export function aggregate(rows, playerId) {
  const byPlayer = new Map(), byTeam = new Map();
  for (const r of rows) {
    const p = byPlayer.get(r.player_id) ?? { id: r.player_id, total: 0, days: 0, last: '' };
    p.total += r.score; p.days += 1;
    if (r.day >= p.last) Object.assign(p, { last: r.day, nick: r.nick, team: r.team });
    byPlayer.set(r.player_id, p);
    const t = byTeam.get(r.team) ?? { team: r.team, total: 0, ids: new Set() };
    t.total += r.score; t.ids.add(r.player_id);
    byTeam.set(r.team, t);
  }
  const players = rankBy([...byPlayer.values()]);
  const teams = rankBy([...byTeam.values()].map((t) => ({ team: t.team, total: t.total, players: t.ids.size })));
  const mine = playerId ? players.find((p) => p.id === playerId) : null;
  const myTeam = mine ? teams.find((t) => t.team === mine.team) : null;
  return {
    players: players.slice(0, 50).map((p) => ({ rank: p.rank, nick: p.nick, team: p.team, total: p.total, days: p.days, me: p.id === playerId })),
    teams,
    count: players.length,
    me: mine ? { rank: mine.rank, total: mine.total, days: mine.days, team: mine.team } : null,
    myTeam: myTeam ? { rank: myTeam.rank, total: myTeam.total, team: myTeam.team } : null,
  };
}
