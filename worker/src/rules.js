// 랭킹 규칙. 게임(index.html)도 같은 팀 목록과 주 계산을 써야 해서, 테스트로 둘이 같은지 맞춰 본다
import { makeSequence, pitcherHand, dailySeed, zoneMiss, CHANCES, REACH_M, POINTS, PERFECT_BONUS, hrStreakBonus } from './pitches.js';
import { SEED_TTL_MS, MIN_PITCH_MS } from './seeds.js';
export const TEAM_IDS = ['kia', 'kt', 'lg', 'nc', 'ssg', 'doosan', 'lotte', 'samsung', 'kiwoom', 'hanwha'];   // KBO 10개 구단(게임의 TEAMS와 같은 순서)
const DAY_MS = 864e5;
export const DAILY_LAST_DAY = '2026-10-30';   // 오늘의 10구가 없어진 날. 그날까지 친 판만 받는다

// 한국 시간 날짜(YYYY-MM-DD)
export const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// 그 날짜가 든 주의 월요일. 랭킹은 한국 시간 월요일 0시에 새로 시작한다
export function weekStart(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();   // 0 일요일 … 6 토요일
  return addDays(day, -((dow + 6) % 7));
}

// 전광판이 그 판의 공 순서(seq)로 실제로 나올 수 있는지 한 칸씩 따라가 보고, 나올 수 있으면 그 전광판으로 낼 수 있는
// 가장 큰 점수를 돌려준다(나올 수 없으면 null).
// - 볼(Y)은 존 밖 공을 그냥 보냈을 때만 나오고 기회를 쓰지 않는다. 안타(G)는 배트가 닿는 공(존에서 REACH_M 안)에만 나온다.
// - 기회 10번을 다 쓰면 판이 끝나서 그 뒤에는 공이 없다. 기회가 남은 채 끝나는 건 공을 다 썼을 때뿐이다.
// - 남은 기회가 1번일 때(끝내기 찬스)는 볼까지 점수가 2배다. 안타는 홈런+정타 보너스, 나머지 스윙은 정타 보너스까지 준다.
// - 안타(G)는 모두 홈런일 수 있다고 보고 연속 홈런 보너스(hrStreakBonus)까지 준다. 볼(Y)은 연속을 끊지 않고 다른 결과(R)는 끊는다(2026-10-30).
// 2026-10-30 전에는 칸 수와 칸별 상한만 봐서, 안타 10개 뒤에 볼 30개를 붙인 전광판으로 15,100점이 들어왔다
export function maxScoreFor(lights, seq) {
  let left = CHANCES, total = 0, streak = 0;
  for (let i = 0; i < lights.length; i++) {
    const p = seq[i];
    if (!p || left === 0) return null;
    const c = lights[i], miss = zoneMiss(p), k = left === 1 ? 2 : 1;
    if (c === 'Y') {
      if (miss === 0) return null;
      total += POINTS.ball * k;
      continue;
    }
    if (c === 'G' && miss > REACH_M) return null;
    streak = c === 'G' ? streak + 1 : 0;
    total += (c === 'G' ? POINTS.hr + PERFECT_BONUS + hrStreakBonus(streak) : miss <= REACH_M ? PERFECT_BONUS : 0) * k;
    left -= 1;
  }
  return left === 0 || lights.length === seq.length ? total : null;
}

// 그 판의 공 순서를 만들 시드. 오늘의 10구는 날짜로 정해지고(자정을 넘겨 끝난 판을 위해 전날 순서도 본다), mode가 없는 예전 게임도
// 오늘의 10구로 본다. 2026-10-30에 없어져서 그날까지 친 판만 받는다(열어 둔 예전 탭).
// 10구 도전은 서버가 내준 표(seeds.js, ticket)의 시드로만 본다. 게임이 보낸 시드는 쓰지 않는다
function seedsFor(b, day, ticket, playerId, pitches, nowMs) {
  const mode = b.mode ?? 'daily';
  if (mode === 'daily') return day > DAILY_LAST_DAY ? { error: 'mode_removed' } : { seeds: [dailySeed(day), dailySeed(addDays(day, -1))] };
  if (mode !== 'challenge') return { error: 'bad_mode' };
  if (!b.token) return { error: 'seed_required' };
  if (!ticket || ticket.player_id !== playerId) return { error: 'bad_seed' };   // 없는 표이거나 남의 표
  if (ticket.used_at != null) return { error: 'seed_used' };
  if (nowMs - ticket.issued_at > SEED_TTL_MS) return { error: 'seed_expired' };
  if (nowMs - ticket.issued_at < pitches * MIN_PITCH_MS) return { error: 'too_fast' };   // 표를 받고 나서 그 판을 칠 시간도 지나지 않았다
  return { seeds: [ticket.seed] };
}
const seqOf = (seed) => makeSequence(seed, pitcherHand(seed) === 'L');

// 닉네임(10자까지)과 팀
export function validateProfile(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const nick = String(b.nick ?? '').trim(), team = String(b.team ?? '');
  if (!nick || [...nick].length > 10 || /[\u0000-\u001f\u007f]/.test(nick)) return { ok: false, error: 'bad_nick' };
  if (!TEAM_IDS.includes(team)) return { ok: false, error: 'bad_team' };
  return { ok: true, value: { nick, team } };
}

// 10구 판 점수 한 건을 검사한다. 그 판의 공 순서로 나올 수 없는 전광판과, 그 전광판으로 낼 수 없는 점수를 거른다.
// 타이밍은 게임이 재서 보내므로 사람이 친 것인지까지는 가릴 수 없다(정타만 쳤다고 꾸민 점수는 막지 못한다).
// 사람 ID는 보낸 내용이 아니라 로그인 표에서 꺼낸 값을 받는다. ticket은 10구 도전 점수와 함께 온 표를 DB에서 꺼낸 줄(없으면 null)
export function validateSubmission(b, nowMs, playerId, ticket = null) {
  if (!/^[a-z0-9-]{8,40}$/.test(String(playerId ?? ''))) return { ok: false, error: 'bad_player' };
  const profile = validateProfile(b);
  if (!profile.ok) return profile;
  const { nick, team } = profile.value;
  const day = String(b.day ?? ''), lights = String(b.lights ?? ''), score = b.score;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad_day' };
  const today = kstDay(nowMs);
  if (day < addDays(today, -2) || day > addDays(today, 1)) return { ok: false, error: 'stale_day' };   // 늦게 보낸 기록은 이틀까지 받는다
  if (!/^[GYR]{1,40}$/.test(lights)) return { ok: false, error: 'bad_lights' };   // 게임은 공을 40개까지 만든다
  const found = seedsFor(b, day, ticket, playerId, lights.length, nowMs);
  if (found.error) return { ok: false, error: found.error };
  const maxes = found.seeds.map((s) => maxScoreFor(lights, seqOf(s))).filter((m) => m !== null);
  if (!maxes.length) return { ok: false, error: 'bad_lights' };
  if (!Number.isInteger(score) || score < 0 || score > Math.max(...maxes)) return { ok: false, error: 'bad_score' };
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
