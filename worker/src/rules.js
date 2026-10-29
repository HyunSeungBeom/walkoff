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

// 닉네임(10자까지)과 팀
export function validateProfile(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const nick = String(b.nick ?? '').trim(), team = String(b.team ?? '');
  if (!nick || [...nick].length > 10 || /[\u0000-\u001f\u007f]/.test(nick)) return { ok: false, error: 'bad_nick' };
  if (!TEAM_IDS.includes(team)) return { ok: false, error: 'bad_team' };
  return { ok: true, value: { nick, team } };
}

// 10구 판 점수 한 건을 검사한다. 마음먹고 조작한 요청까지 막지는 못하고, 규칙상 나올 수 없는 값만 거른다.
// 사람 ID는 보낸 내용이 아니라 로그인 표에서 꺼낸 값을 받는다
export function validateSubmission(b, nowMs, playerId) {
  if (!/^[a-z0-9-]{8,40}$/.test(String(playerId ?? ''))) return { ok: false, error: 'bad_player' };
  const profile = validateProfile(b);
  if (!profile.ok) return profile;
  const { nick, team } = profile.value;
  const day = String(b.day ?? ''), lights = String(b.lights ?? ''), score = b.score;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad_day' };
  const today = kstDay(nowMs);
  if (day < addDays(today, -2) || day > addDays(today, 1)) return { ok: false, error: 'stale_day' };   // 늦게 보낸 기록은 이틀까지 받는다
  if (!/^[GYR]{10,40}$/.test(lights)) return { ok: false, error: 'bad_lights' };   // 게임은 공을 40개까지 만든다
  // 기회 10번 + 볼 수. 볼은 기회를 쓰지 않는다(2026-10-29부터). 그 전 게임은 볼 5개까지만 기회가 늘어서, 열어 둔 탭을 위해 그 규칙도 받는다
  const balls = lights.split('').filter((c) => c === 'Y').length;
  if (lights.length !== 10 + balls && lights.length !== 10 + Math.min(balls, 5)) return { ok: false, error: 'bad_lights' };
  if (!Number.isInteger(score) || score < 0 || score > maxScoreFor(lights)) return { ok: false, error: 'bad_score' };
  return { ok: true, value: { playerId, nick, team, day, week: weekStart(day), score, lights } };
}

// key가 큰 순서로 줄 세우고, 같은 값은 같은 등수(1, 2, 2, 4)
function rankBy(list, key) {
  list.sort((a, b) => b[key] - a[key]);
  let rank = 0;
  list.forEach((x, i) => { if (i === 0 || x[key] !== list[i - 1][key]) rank = i + 1; x.rank = rank; });
  return list;
}

// 한 주의 기록으로 순위를 매긴다(2026-10-29 사용자 결정: 합계가 아니라 이번 주 최고 기록).
// 사람 점수는 그 주 최고 기록이고 그 기록을 낸 날의 팀으로 간다. 팀 점수는 팀원 최고 기록의 합이다.
// 이름은 가장 최근 기록을 따른다. 밖으로 내보내는 목록에는 사람 ID를 넣지 않는다
export function aggregate(rows, playerId) {
  const byPlayer = new Map(), byTeam = new Map();
  for (const r of rows) {
    const p = byPlayer.get(r.player_id) ?? { id: r.player_id, best: -1, days: 0, last: '' };
    p.days += 1;
    if (r.score > p.best) Object.assign(p, { best: r.score, team: r.team });
    if (r.day >= p.last) Object.assign(p, { last: r.day, nick: r.nick });
    byPlayer.set(r.player_id, p);
  }
  const players = rankBy([...byPlayer.values()], 'best');
  for (const p of players) {
    const t = byTeam.get(p.team) ?? { team: p.team, total: 0, players: 0 };
    t.total += p.best; t.players += 1;
    byTeam.set(p.team, t);
  }
  const teams = rankBy([...byTeam.values()], 'total');
  const mine = playerId ? players.find((p) => p.id === playerId) : null;
  const myTeam = mine ? teams.find((t) => t.team === mine.team) : null;
  return {
    players: players.slice(0, 50).map((p) => ({ rank: p.rank, nick: p.nick, team: p.team, best: p.best, days: p.days, me: p.id === playerId })),
    teams,
    count: players.length,
    me: mine ? { rank: mine.rank, best: mine.best, days: mine.days, team: mine.team } : null,
    myTeam: myTeam ? { rank: myTeam.rank, total: myTeam.total, team: myTeam.team } : null,
  };
}
