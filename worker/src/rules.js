// 랭킹 규칙. 공 순서·10구 다시 돌리기(playChallenge)·점수 상한(maxScoreFor)·팀 목록은 게임과 같은 파일(js/core)을 그대로 가져다 쓴다(2026-11-03 코드 나누기.
// 전에는 worker/src/pitches.js와 이 파일에 복사본을 두고 테스트로 둘이 같은지 맞춰 봤다). 주 계산은 게임도 같은 규칙이라 테스트가 맞춰 본다
import { makeSequence, pitcherHand, dailySeed, styleOn, SEQ_LEN } from '../../js/core/pitches.js';
import { maxScoreFor, scoreRange } from '../../js/core/score.js';
import { playChallenge } from '../../js/core/challenge.js';
import { TEAM_IDS, TEAM_TOP } from '../../js/core/catalog.js';
import { checkNick } from '../../js/core/nick.js';
import { ticketError } from './seeds.js';
import { MOVE_MS } from './scenario.js';
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

// 이번 주 투수(js/core/pitches.js styleOn): 시드 표를 내준 때의 한국 시간 주로 정한다. /seeds가 표와 같이 알려 주고 게임은 그 유형으로 친다
// (기기 시계가 어긋나도 서버와 같은 공). 일요일 밤에 받은 표로 자정을 넘겨 끝낸 판은 새 주 랭킹에 들어가지만 지난주 투수로 친 판이다
export const styleAt = (ms) => styleOn(kstDay(ms));

// 그 판의 공 순서를 만들 시드와 투수 유형. 오늘의 10구는 날짜로 정해지고(자정을 넘겨 끝난 판을 위해 전날 순서도 본다), mode가 없는 예전 게임도
// 오늘의 10구로 본다. 2026-10-30에 없어져서 그날까지 친 판만 받는다(열어 둔 예전 탭, 투수 유형이 생기기 전이라 정통파).
// 10구 도전은 서버가 내준 표(seeds.js, ticket)의 시드와 그 표를 내준 주의 유형으로만 본다. 게임이 보낸 시드는 쓰지 않는다
function seedsFor(b, day, ticket, playerId, pitches, nowMs) {
  const mode = b.mode ?? 'daily';
  if (mode === 'daily') return day > DAILY_LAST_DAY ? { error: 'mode_removed' } : { seeds: [dailySeed(day), dailySeed(addDays(day, -1))], style: 'classic' };
  if (mode !== 'challenge') return { error: 'bad_mode' };
  const error = ticketError(b.token, ticket, playerId, nowMs, pitches);
  return error ? { error } : { seeds: [ticket.seed], style: styleAt(ticket.issued_at) };
}
export const seqOf = (seed, style = 'classic') => makeSequence(seed, pitcherHand(seed) === 'L', style);

// 닉네임과 팀. 닉네임은 게임과 같은 규칙(js/core/nick.js: 한글·영문·숫자 10자까지, 욕·사칭 목록, 2026-11-19)이고,
// 걸린 까닭은 돌려주지 않는다(bad_nick 하나). 점수 올리기(/scores)와 닉네임 바꾸기(PUT /me)가 같이 쓴다
export function validateProfile(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const nick = checkNick(b.nick), team = String(b.team ?? '');
  if (!nick.ok) return { ok: false, error: 'bad_nick' };
  if (!TEAM_IDS.includes(team)) return { ok: false, error: 'bad_team' };
  return { ok: true, value: { nick: nick.nick, team } };
}

// 10구 판 점수 한 건을 검사한다(다시 돌리기, 2026-11-19 사용자 '랭킹 점수 검사 강화'에서 (나)를 고름). 게임이 공마다 judgeSwing에 넣은 타이밍
// (moves, 그냥 보낸 공 null)과 타석(bats)을 보내면 서버가 표의 시드로 같은 판을 처음부터 다시 돌려(js/core/challenge.js playChallenge) 그 점수·전광판을
// 저장한다. 게임이 보낸 score·lights는 쓰지 않고, 다르면 어긋남(mismatch)으로 알리기만 한다(사용자 결정 '서버 점수로 올림': 거절·숨김 없이 올려서
// 꾸민 숫자는 버려지고, 판정을 바꾸는 배포 몇 분 동안 옛 게임으로 친 정상 판도 손해가 없다). 다시 돌리는 데 판당 평균 0.15ms다.
// 타이밍은 여전히 게임이 재서 보내므로, core로 공마다 좋은 타이밍을 계산해 보내는 봇까지는 막지 못한다. 그래서 그날 최고 판의 재료(play)를 남겨 둔다.
// 타이밍이 없는 옛 게임(열어 둔 탭, 남겨 둔 판)은 MOVES_FROM 전까지만 아래 범위 검사로 받는다. 전광판은 공마다 S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R
// 그 밖이고(2026-11-05), 그 전 게임은 안타가 모두 G다. 종류를 알면 점수가 정타 보너스만큼만 열려 하한·상한을 다 보고, G는 상한만 본다(scoreRange).
// 범위 검사는 닿는 공이면 홈런을 받아서, 어떤 타이밍으로든 홈런이 나는 공이 40%뿐인데도 꾸민 전광판이 통과했다(2026-11-18 서버 지키기에서 잼).
// 사람 ID는 보낸 내용이 아니라 로그인 표에서 꺼낸 값을 받는다. ticket은 10구 도전 점수와 함께 온 표를 DB에서 꺼낸 줄(없으면 null)
export const MOVES_FROM = Date.parse('2026-11-22T15:00:00Z');   // 한국 시간 2026-11-23(월) 0시. 홍보 주부터는 타이밍 없는 판을 받지 않는다(그 뒤 범위 검사 길은 지워도 된다)
export const SAME_SWINGS = 5;   // 휘두른 공이 5개 이상인데 타이밍이 모두 같은 판은 거절한다. 사람은 사실상 못 치고, 요청의 타이밍을 모두 0으로 고치면 이렇게 된다
export function validateSubmission(b, nowMs, playerId, ticket = null) {
  if (!/^[a-z0-9-]{8,40}$/.test(String(playerId ?? ''))) return { ok: false, error: 'bad_player' };
  const profile = validateProfile(b);
  if (!profile.ok) return profile;
  const { nick, team } = profile.value;
  const day = String(b.day ?? ''), lights = String(b.lights ?? ''), score = b.score;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad_day' };
  const today = kstDay(nowMs);
  if (day < addDays(today, -2) || day > addDays(today, 1)) return { ok: false, error: 'stale_day' };   // 늦게 보낸 기록은 이틀까지 받는다
  if (b.moves !== undefined || nowMs >= MOVES_FROM) return replaySubmission(b, { playerId, nick, team, day }, nowMs, ticket);
  if (!/^[GSDTHYR]{1,40}$/.test(lights) || (lights.includes('G') && /[SDTH]/.test(lights))) return { ok: false, error: 'bad_lights' };   // 게임은 공을 40개까지 만든다
  const found = seedsFor(b, day, ticket, playerId, lights.length, nowMs);
  if (found.error) return { ok: false, error: found.error };
  const ranges = found.seeds.map((seed) => ({ seed, r: scoreRange(lights, seqOf(seed, found.style)) })).filter((x) => x.r);
  if (!ranges.length) return { ok: false, error: 'bad_lights' };
  const hit = Number.isInteger(score) && score >= 0 ? ranges.find(({ r }) => score >= r.min && score <= r.max) : null;
  if (!hit) return { ok: false, error: 'bad_score' };
  return { ok: true, value: { playerId, nick, team, day, week: weekStart(day), score, lights, seed: hit.seed, style: found.style } };   // seed·style: 칭호를 쌓을 때 공 순서를 다시 만든다
}

// 타이밍으로 판을 다시 돌려 받는다(위 validateSubmission). 타이밍이 없으면 moves_required, 모양이 틀리거나 판이 마지막 공에서 끝나지 않으면 bad_moves.
// play는 그 판을 다시 돌릴 재료(시드·투수 유형·타석·공마다 타이밍)이고 그날 최고 판이면 daily_scores에 남는다(board.js saveDaily).
// results는 다시 돌린 공마다 결과이고 오늘의 미션을 센다(missions.js, 저장하지 않는다)
function replaySubmission(b, who, nowMs, ticket) {
  const { moves, bats } = b;
  if (moves === undefined) return { ok: false, error: 'moves_required' };
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > SEQ_LEN || (bats !== 'R' && bats !== 'L')
    || !moves.every((m) => m === null || (Number.isInteger(m) && Math.abs(m) <= MOVE_MS))) return { ok: false, error: 'bad_moves' };
  const swings = moves.filter((m) => m !== null);
  if (swings.length >= SAME_SWINGS && swings.every((m) => m === swings[0])) return { ok: false, error: 'bad_moves' };
  const found = seedsFor(b, who.day, ticket, who.playerId, moves.length, nowMs);
  if (found.error) return { ok: false, error: found.error };
  const [seed] = found.seeds, { style } = found, game = playChallenge(seqOf(seed, style), moves, bats);
  if (!game) return { ok: false, error: 'bad_moves' };
  const sent = { score: Number.isInteger(b.score) ? b.score : null, lights: String(b.lights ?? '').slice(0, SEQ_LEN) };
  const mismatch = sent.score !== game.score || sent.lights !== game.lights ? sent : null;   // 게임이 보낸 값(로그에만 남긴다)
  return { ok: true, value: { ...who, week: weekStart(who.day), score: game.score, lights: game.lights, seed, style, play: JSON.stringify({ seed, style, bats, moves }), results: game.results, mismatch } };
}

// 앞 key가 큰 순서로 줄 세우고(같으면 다음 key), 모든 key가 같으면 같은 등수(1, 2, 2, 4). 같은 줄끼리는 목록 순서 그대로다
function rankBy(list, ...keys) {
  const cmp = (a, b) => { for (const k of keys) if (a[k] !== b[k]) return b[k] - a[k]; return 0; };
  list.sort(cmp);
  let rank = 0;
  list.forEach((x, i) => { if (i === 0 || cmp(x, list[i - 1]) !== 0) rank = i + 1; x.rank = rank; });
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
// 사람 점수는 그 주 최고 기록이고 그 기록을 낸 날의 팀으로 간다. 팀 점수는 팀원 최고 기록 가운데 위 TEAM_TOP(5)명의 합이고(2026-11-23 팀 대항전,
// 전에는 팀원 전부의 합), 같으면 친 사람(players)이 많은 팀이 위다. 그 주에 아무도 안 친 팀은 teams에 없다(게임이 '참가 없음'으로 채운다).
// 이름은 가장 최근 기록을 따른다. 밖으로 내보내는 목록에는 사람 ID를 넣지 않는다. 같은 점수는 목록 순서대로 늘어선다.
// withIds면 목록과 같은 순서의 사람 ID(ids)를 따로 붙인다. 서버가 입은 물건을 찾을 때만 쓰고 응답에서는 뺀다
export function rankSummary(list, playerId, { withIds = false } = {}) {
  const byTeam = new Map();
  const players = rankBy(list.map((p) => ({ ...p })), 'best');
  for (const p of players) {   // 최고 기록 순서라 팀마다 먼저 온 TEAM_TOP명이 위 5명이다
    const t = byTeam.get(p.team) ?? { team: p.team, total: 0, players: 0 };
    if (t.players < TEAM_TOP) t.total += p.best;
    t.players += 1;
    byTeam.set(p.team, t);
  }
  const teams = rankBy([...byTeam.values()], 'total', 'players');
  const mine = playerId ? players.find((p) => p.id === playerId) : null;
  const myTeam = mine ? teams.find((t) => t.team === mine.team) : null, top = players.slice(0, 50);
  // 10구 끝 화면 '한 판 더' 줄(2026-11-16): 내 바로 위(나보다 높은 기록 가운데 가장 낮은)와, 1위면 바로 아래(나보다 낮은 기록 가운데 가장 높은)의
  // 등수·기록. 50위 밖이어도 이 둘만 준다(이름·ID 없이)
  const above = mine ? players.filter((p) => p.best > mine.best).pop() : null, below = mine?.rank === 1 ? players.find((p) => p.best < mine.best) : null;
  const near = (p) => (p ? { rank: p.rank, best: p.best } : null);
  const out = {
    players: top.map((p) => ({ rank: p.rank, nick: p.nick, team: p.team, best: p.best, days: p.days, me: p.id === playerId })),
    teams,
    count: players.length,
    me: mine ? { rank: mine.rank, best: mine.best, days: mine.days, team: mine.team } : null,
    myTeam: myTeam ? { rank: myTeam.rank, total: myTeam.total, team: myTeam.team } : null,
    near: mine ? { above: near(above), below: near(below) } : null,
  };
  if (withIds) out.ids = top.map((p) => p.id);
  return out;
}

// 한 주의 기록으로 바로 순위를 매긴다(서버는 board.js의 주별 요약으로 rankSummary를 부른다. 테스트가 둘이 같은지 본다)
export const aggregate = (rows, playerId, opts) => rankSummary(summarize(rows), playerId, opts);
