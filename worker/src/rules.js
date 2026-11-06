// 랭킹 규칙. 공 순서·점수 상한(maxScoreFor)·팀 목록은 게임과 같은 파일(js/core)을 그대로 가져다 쓴다(2026-11-03 코드 나누기.
// 전에는 worker/src/pitches.js와 이 파일에 복사본을 두고 테스트로 둘이 같은지 맞춰 봤다). 주 계산은 게임도 같은 규칙이라 테스트가 맞춰 본다
import { makeSequence, pitcherHand, dailySeed } from '../../js/core/pitches.js';
import { maxScoreFor, scoreRange } from '../../js/core/score.js';
import { TEAM_IDS } from '../../js/core/catalog.js';
import { ticketError } from './seeds.js';
export { TEAM_IDS, maxScoreFor, scoreRange };   // 서버 테스트와 게임 테스트가 여기서 가져간다
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

// 그 판의 공 순서를 만들 시드. 오늘의 10구는 날짜로 정해지고(자정을 넘겨 끝난 판을 위해 전날 순서도 본다), mode가 없는 예전 게임도
// 오늘의 10구로 본다. 2026-10-30에 없어져서 그날까지 친 판만 받는다(열어 둔 예전 탭).
// 10구 도전은 서버가 내준 표(seeds.js, ticket)의 시드로만 본다. 게임이 보낸 시드는 쓰지 않는다
function seedsFor(b, day, ticket, playerId, pitches, nowMs) {
  const mode = b.mode ?? 'daily';
  if (mode === 'daily') return day > DAILY_LAST_DAY ? { error: 'mode_removed' } : { seeds: [dailySeed(day), dailySeed(addDays(day, -1))] };
  if (mode !== 'challenge') return { error: 'bad_mode' };
  const error = ticketError(b.token, ticket, playerId, nowMs, pitches);
  return error ? { error } : { seeds: [ticket.seed] };
}
export const seqOf = (seed) => makeSequence(seed, pitcherHand(seed) === 'L');

// 닉네임(10자까지)과 팀
export function validateProfile(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const nick = String(b.nick ?? '').trim(), team = String(b.team ?? '');
  if (!nick || [...nick].length > 10 || /[\u0000-\u001f\u007f]/.test(nick)) return { ok: false, error: 'bad_nick' };
  if (!TEAM_IDS.includes(team)) return { ok: false, error: 'bad_team' };
  return { ok: true, value: { nick, team } };
}

// 10구 판 점수 한 건을 검사한다. 그 판의 공 순서로 나올 수 없는 전광판과, 그 전광판으로 낼 수 없는 점수를 거른다.
// 전광판은 공마다 S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R 그 밖이고(2026-11-05, 칭호를 정하려고 안타 종류를 받는다), 예전 게임은 안타가 모두 G다.
// 한 판에 G와 종류를 섞지는 않는다. 종류를 알면 점수가 정타 보너스만큼만 열려 하한·상한을 다 보고, G는 지금까지처럼 상한만 본다(scoreRange).
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
  if (!/^[GSDTHYR]{1,40}$/.test(lights) || (lights.includes('G') && /[SDTH]/.test(lights))) return { ok: false, error: 'bad_lights' };   // 게임은 공을 40개까지 만든다
  const found = seedsFor(b, day, ticket, playerId, lights.length, nowMs);
  if (found.error) return { ok: false, error: found.error };
  const ranges = found.seeds.map((seed) => ({ seed, r: scoreRange(lights, seqOf(seed)) })).filter((x) => x.r);
  if (!ranges.length) return { ok: false, error: 'bad_lights' };
  const hit = Number.isInteger(score) && score >= 0 ? ranges.find(({ r }) => score >= r.min && score <= r.max) : null;
  if (!hit) return { ok: false, error: 'bad_score' };
  return { ok: true, value: { playerId, nick, team, day, week: weekStart(day), score, lights, seed: hit.seed } };   // seed: 칭호를 쌓을 때 공 순서를 다시 만든다
}

// key가 큰 순서로 줄 세우고, 같은 값은 같은 등수(1, 2, 2, 4)
function rankBy(list, key) {
  list.sort((a, b) => b[key] - a[key]);
  let rank = 0;
  list.forEach((x, i) => { if (i === 0 || x[key] !== list[i - 1][key]) rank = i + 1; x.rank = rank; });
  return list;
}

// 한 주의 기록(사람·날짜마다 한 줄, 넣은 순서)을 사람마다 한 줄로: 그 주 최고 기록과 그 기록을 낸 날의 팀(같은 점수면 먼저 넣은 줄),
// 친 날 수, 가장 최근 날과 그날 닉네임. 주마다 모아 두는 board.js가 SQL로 같은 값을 계산한다
export function summarize(rows) {
  const byPlayer = new Map();
  for (const r of rows) {
    const p = byPlayer.get(r.player_id) ?? { id: r.player_id, best: -1, days: 0, last: '' };
    p.days += 1;
    if (r.score > p.best) Object.assign(p, { best: r.score, team: r.team });
    if (r.day >= p.last) Object.assign(p, { last: r.day, nick: r.nick });
    byPlayer.set(r.player_id, p);
  }
  return [...byPlayer.values()];
}

// 사람마다 한 줄(summarize)로 순위를 매긴다(2026-10-29 사용자 결정: 합계가 아니라 이번 주 최고 기록).
// 사람 점수는 그 주 최고 기록이고 그 기록을 낸 날의 팀으로 간다. 팀 점수는 팀원 최고 기록의 합이다.
// 이름은 가장 최근 기록을 따른다. 밖으로 내보내는 목록에는 사람 ID를 넣지 않는다. 같은 점수는 목록 순서대로 늘어선다.
// withIds면 목록과 같은 순서의 사람 ID(ids)를 따로 붙인다. 서버가 입은 물건을 찾을 때만 쓰고 응답에서는 뺀다
export function rankSummary(list, playerId, { withIds = false } = {}) {
  const byTeam = new Map();
  const players = rankBy(list.map((p) => ({ ...p })), 'best');
  for (const p of players) {
    const t = byTeam.get(p.team) ?? { team: p.team, total: 0, players: 0 };
    t.total += p.best; t.players += 1;
    byTeam.set(p.team, t);
  }
  const teams = rankBy([...byTeam.values()], 'total');
  const mine = playerId ? players.find((p) => p.id === playerId) : null;
  const myTeam = mine ? teams.find((t) => t.team === mine.team) : null, top = players.slice(0, 50);
  const out = {
    players: top.map((p) => ({ rank: p.rank, nick: p.nick, team: p.team, best: p.best, days: p.days, me: p.id === playerId })),
    teams,
    count: players.length,
    me: mine ? { rank: mine.rank, best: mine.best, days: mine.days, team: mine.team } : null,
    myTeam: myTeam ? { rank: myTeam.rank, total: myTeam.total, team: myTeam.team } : null,
  };
  if (withIds) out.ids = top.map((p) => p.id);
  return out;
}

// 한 주의 기록으로 바로 순위를 매긴다(서버는 board.js의 주별 요약으로 rankSummary를 부른다. 테스트가 둘이 같은지 본다)
export const aggregate = (rows, playerId, opts) => rankSummary(summarize(rows), playerId, opts);
