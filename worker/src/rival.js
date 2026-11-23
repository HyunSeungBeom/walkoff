// 모르는 사람과 대결(2026-11-23 사용자 '모르는 사람과 대결'). 다른 사람이 최근 7일 동안 친 10구의 하루 최고 판(daily_scores. 2026-11-19부터 그 판을
// 다시 돌릴 재료 play가 남는다) 가운데 내 최근 최고 점수와 가까운 판 하나를 골라, 그 판의 공 순서(시드·투수 유형)·타석·점수·전광판·닉네임·팀만 내준다.
// 공마다 휘두른 타이밍(play.moves)·계정 번호·#번호는 내보내지 않는다. 게임은 도전장(js/game/duel.js)처럼 같은 공으로 겨루고 랭킹·코인·칭호·연속에는 넣지 않는다.
// 로그인 없이 받는다(사용자 '로그인 없이도', 횟수는 IP마다 index.js LIMITERS). 처리방침 5절에 알린 날 + 7일(RIVAL_FROM)부터 내준다
// (사용자 '7일 뒤 열기', 처리방침 16절 '영향이 큰 변경은 7일 전에 알림')
import { addDays, kstDay, weekStart } from './rules.js';
import { checkNick } from '../../js/core/nick.js';
import { isStyle } from '../../js/core/pitches.js';
import { TEAM_IDS } from '../../js/core/catalog.js';

export const RIVAL_FROM = '2026-12-01';   // 상대를 내주는 첫날(한국 시간). 게임 js/game/rival.js RIVAL_FROM과 같다
export const RIVAL_DAYS = 7;              // 오늘까지 7일 안에 친 판에서 고른다
export const RIVAL_POOL = 3;              // 점수가 가장 가까운 세 사람 가운데 하나를 무작위로 고른다(같은 상대만 나오지 않게)
export const RIVAL_RECENT = 3;            // 이 기기가 최근에 친 공 셋의 주인은 그 사람의 다른 날 판까지 뺀다(방금 만난 사람을 바로 또 만나지 않게)
export const SEEN_MAX = 30;               // 게임이 보내는 이미 친 공 수(js/game/duel.js DUEL_KEEP)
const SEED_MAX = 2147483647;              // 서버 시드(seeds.js)는 1 ~ 2^31-1
const LIGHTS = /^[SDTHYR]{1,40}$/;

// 게임이 보내는 값(GET /rival?score=&seen=&player=). score는 내 최근 최고 점수(없으면 빈 값), seen은 이 기기가 이미 친 공 순서의 시드
// (36진수를 쉼표로, 최근 것부터), player는 이 브라우저의 랭킹 번호(로그인했으면 계정 번호와 같아서 내 판을 뺀다). score·player가 틀리면 error.
// seen은 고르는 데 참고만 하는 값이라 앞 SEEN_MAX개만 보고 시드가 아닌 것은 버린다(도전장 기록에는 ?seed= 판처럼 서버 시드 범위 밖의 공도 있다)
export function parseRivalQuery(params) {
  const score = params.get('score') ?? '', seen = params.get('seen') ?? '', player = params.get('player') ?? '';
  if (score !== '' && !/^\d{1,7}$/.test(score)) return { ok: false, error: 'bad_score' };
  if (player !== '' && !/^[a-z0-9-]{8,40}$/.test(player)) return { ok: false, error: 'bad_player' };
  const seeds = seen.split(',').slice(0, SEEN_MAX).map((s) => (/^[0-9a-z]{1,7}$/.test(s) ? parseInt(s, 36) : NaN)).filter((s) => s >= 1 && s <= SEED_MAX);
  return { ok: true, value: { target: score === '' ? null : Number(score), seen: seeds, player } };
}

// daily_scores.play(JSON {seed, style, bats, moves})에서 공 순서와 타석만 꺼낸다. 망가졌으면 null
function playOf(json) {
  let p;
  try { p = JSON.parse(json); } catch { return null; }
  const seed = p?.seed, style = p?.style ?? 'classic', bats = p?.bats;
  if (!Number.isInteger(seed) || seed < 1 || seed > SEED_MAX || !isStyle(style) || (bats !== 'L' && bats !== 'R')) return null;
  return { seed, style, bats };
}

// 후보 줄(findRival이 읽은 최근 판, 사람·날마다 한 줄)에서 상대 판 하나를 고른다. rand는 0 이상 1 미만(테스트가 정한다).
// 빼는 것: 나, 닉네임 규칙(core/nick.js)에 어긋난 이름, 팀·전광판·재료가 망가진 줄, 이 기기가 이미 친 공. 최근 친 공 셋의 주인은 다른 날 판까지 빼고,
// 그러면 아무도 안 남을 때만 이미 친 공만 뺀다. 사람마다 내 점수와 가장 가까운 판 하나로 줄 세워 앞 RIVAL_POOL명 가운데 고른다(점수 차가 같으면 높은 판, 그다음 시드 순).
// 내 점수를 모르면(처음 온 사람) 남은 판 점수의 가운데 값(짝수 개면 낮은 쪽)과 견준다. 아무도 없으면 null
export function pickRival(rows, { target = null, seen = [], player = '' } = {}, rand = Math.random) {
  const games = [];
  for (const r of rows) {
    const nick = checkNick(r.nick), play = playOf(r.play);
    if (r.player_id === player || !nick.ok || !play || !TEAM_IDS.includes(r.team) || !LIGHTS.test(String(r.lights)) || !Number.isInteger(r.score)) continue;
    games.push({ who: r.player_id, ...play, score: r.score, lights: r.lights, nick: nick.nick, team: r.team });
  }
  const done = new Set(seen), last = new Set(seen.slice(0, RIVAL_RECENT));
  const recent = new Set(games.filter((g) => last.has(g.seed)).map((g) => g.who));
  const fresh = games.filter((g) => !done.has(g.seed)), others = fresh.filter((g) => !recent.has(g.who)), pool = others.length ? others : fresh;
  if (!pool.length) return null;
  const scores = pool.map((g) => g.score).sort((a, b) => a - b), at = target ?? scores[Math.floor((scores.length - 1) / 2)];
  const gap = (g) => Math.abs(g.score - at), closest = new Map();
  for (const g of pool) if (!closest.has(g.who) || gap(g) < gap(closest.get(g.who))) closest.set(g.who, g);
  const near = [...closest.values()].sort((a, b) => gap(a) - gap(b) || b.score - a.score || a.seed - b.seed).slice(0, RIVAL_POOL);
  const { who: _, ...pick } = near[Math.min(near.length - 1, Math.floor(rand() * near.length))];   // 계정 번호는 빼고 내보낸다
  return pick;
}

// 최근 7일의 판(숨기지 않았고 다시 돌릴 재료가 있는 판)을 그 주와 앞 주의 색인(daily_scores_week)으로 읽는다. 한 번에 읽는 줄은 두 주 판 수(사람 × 친 날)만큼이다
// (2026-11-23 운영 DB: 최근 7일 6판·4명. 하루 30명이 치면 약 420줄). 자리: 앞 주 월요일, 이번 주 월요일, 첫날
export const RIVAL_SQL = `SELECT player_id, score, lights, nick, team, play FROM daily_scores
  WHERE week IN (?, ?) AND day >= ? AND hidden = 0 AND play IS NOT NULL`;
export async function findRival(db, query, now, rand) {
  const today = kstDay(now), from = addDays(today, 1 - RIVAL_DAYS);
  const { results } = await db.prepare(RIVAL_SQL).bind(weekStart(from), weekStart(today), from).all();
  return pickRival(results, query, rand);
}
