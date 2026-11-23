// 오늘의 미션(2026-11-23 사용자 '오늘의 미션', 작업 글 ~/.claude/plans/walkoff-missions.md). 처음 온 기기가 다음 날 다시 오는 비율이 거의 0이라
// 매일 올 이유를 하나 더 둔다. 한국 시간 날마다 모두 같은 세 개를 쉬움·보통·어려움 칸에서 하나씩 날짜로 고르고(missionsOn), 10구 랭킹 판마다
// 공마다 결과로 센 수(gameFacts → missionGain)를 그날 진행에 더해 다 채운 미션의 코인을 한 번씩 준다(advanceMissions).
// 랭킹 서버(worker/src/missions.js)는 /scores에서 다시 돌린 판(js/core/challenge.js playChallenge)으로 세고, 게임이 보낸 결과는 믿지 않는다.
// 로그인 안 했으면 게임이 이 기기에서 같은 함수로 세어 보이기만 한다(보상 없음). 판정은 바꾸지 않고 판정이 이미 가르는 결과로만 센다.
// 풀 15개·목표·보상(쉬움 50·보통 80·어려움 120, 셋 다 +100)은 2026-11-23 사용자가 골랐다. 목표는 실제 판 타이밍과 스윙 통계에 맞춘 모의 타자로 잰
// 끝나는 판 수(보통 사람 1~3판, 처음 온 사람 1~5판)로 정했다
import { CHANCES } from './score.js';
import { mulberry32 } from './math.js';
import { dayNo, styleOn } from './pitches.js';
import { carryOf } from './flight.js';

export const TIER_COINS = [50, 80, 120];   // 쉬움·보통·어려움
export const ALL_BONUS = 100;              // 그날 셋 다 하면 한 번 더
export const LONG_HR_M = 140;              // 비거리 미션: 화면에 보이는 비거리(carryOf 반올림). 홈런 가운데값이 142m라 한 판에 보통 1.15개
export const OPPO_DEG = 8;                 // 밀어 친 안타: 가운데 ±8도 밖으로 민 쪽(view/text.js 이유 글과 같은 선)
// 주무기 미션: 이번 주 투수 유형(pitches.js PITCHER_STYLES)이 많이 던지는 공. 강속구형은 직구가 절반이고, 나머지는 변화구 가운데 가장 많은 것.
// 목표는 한 판에 나오는 안타 수에 맞춰 보통 사람이 2~3판에 채우게 했다(구종을 못 박으면 커브가 한 판 0.2개뿐인 포크볼러 주에는 못 채운다)
export const MAIN_PITCH = { classic: { pitch: 'slider', need: 3 }, power: { pitch: 'fastball', need: 8 }, finesse: { pitch: 'change', need: 3 }, forkball: { pitch: 'fork', need: 4 } };

// [id, 칸, 무리, 목표(주무기는 그 주 MAIN_PITCH)]. 무리가 같은 미션은 같은 날 나오지 않는다(정타 3개와 정타 5개 등).
// 칸마다 앞 셋은 닷새 묶음의 첫날에, 뒤 둘은 끝날에 올 수 있어서 묶음이 바뀌는 날에도 같은 미션이 이틀 잇달아 나오지 않는다(arrange)
const ROWS = [
  ['play2', 0, 'play', 2], ['hit10', 0, 'hit', 10], ['perfect3', 0, 'perfect', 3], ['run3', 0, 'run', 1], ['clutch', 0, 'clutch', 1],
  ['ball4', 1, 'eye', 4], ['oppo2', 1, 'oppo', 2], ['hr3', 1, 'hr', 3], ['main', 1, 'pitch', null], ['score6k', 1, 'score', 1],
  ['perfect5', 2, 'perfect', 5], ['longHr2', 2, 'hr', 2], ['score8k', 2, 'score', 1], ['breakHr', 2, 'hr', 1], ['run5', 2, 'run', 1],
];
export const MISSIONS = ROWS.map(([id, tier, family, need]) => ({ id, tier, family, need }));
const TIERS = [0, 1, 2].map((t) => MISSIONS.filter((m) => m.tier === t));
// 한 판에서 세는 수(f는 gameFacts, m은 그날 미션). 한 판 미션(목표 1)은 그 판에 해내면 1
const COUNT = {
  play2: () => 1, hit10: (f) => f.hits, perfect3: (f) => f.perfect, run3: (f) => +(f.hitRun >= 3), clutch: (f) => f.lastHit,
  ball4: (f) => f.balls, oppo2: (f) => f.oppo, hr3: (f) => f.hr, main: (f, m) => f.hitsBy[m.pitch] ?? 0, score6k: (f) => +(f.score >= 6000),
  perfect5: (f) => f.perfect, longHr2: (f) => f.longHr, score8k: (f) => +(f.score >= 8000), breakHr: (f) => f.breakHr, run5: (f) => +(f.hitRun >= 5),
};

// 닷새 묶음(1970-01-01부터 센 날 수 ÷ 5) c의 칸별 차례. 묶음마다 시드로 섞고, 같은 날 세 칸의 무리가 겹치면 다시 섞는다(대개 몇 번 안에 된다).
// 끝내 못 찾으면 목록 차례 그대로(이 차례는 무리가 안 겹친다. 10년 치를 테스트가 본다)
const CYCLE = 5;
function arrange(list, rnd) {
  const pick = (a) => a.splice(Math.floor(rnd() * a.length), 1)[0];
  const head = list.slice(0, 3), tail = list.slice(3), first = pick(head), last = pick(tail), mid = [...head, ...tail];
  for (let i = mid.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mid[i], mid[j]] = [mid[j], mid[i]]; }
  return [first, ...mid, last];
}
function cycleOf(c) {
  const rnd = mulberry32(Math.imul(c, 0x9e3779b1) ^ 0x5eed);
  for (let k = 0; k < 500; k++) {
    const perms = TIERS.map((list) => arrange(list, rnd));
    if (perms[0].every((_, d) => new Set(perms.map((p) => p[d].family)).size === perms.length)) return perms;
  }
  return TIERS;
}

// 한국 시간 날짜 'YYYY-MM-DD'의 미션 셋 [{ id, tier, family, need, pitch? }](쉬움·보통·어려움 차례). 주무기는 그 날짜가 든 주의 투수 유형으로
export function missionsOn(day) {
  const n = dayNo(day), c = Math.floor(n / CYCLE), main = MAIN_PITCH[styleOn(day)];
  return cycleOf(c).map((p) => { const m = p[n - c * CYCLE]; return m.id === 'main' ? { ...m, ...main } : { ...m }; });
}

// 한 판(공마다 결과 results, 그 판 공 순서 seq, 점수 score)에서 세는 수. 볼은 기회를 안 써서 연속 안타를 끊지 않고(score.js 연속 보너스와 같다),
// 끝내기 찬스는 볼을 뺀 10번째 기회다. 밀어 친 안타는 우타가 1루 쪽, 좌타가 3루 쪽으로 OPPO_DEG 넘게 간 안타, 비거리는 화면과 같은 carryOf
export function gameFacts(results, seq, score) {
  const f = { hits: 0, perfect: 0, balls: 0, oppo: 0, hr: 0, longHr: 0, breakHr: 0, hitsBy: {}, hitRun: 0, lastHit: 0, score };
  let run = 0, chances = 0;
  results.forEach((r, i) => {
    if (r.kind === 'ball') { f.balls += 1; return; }
    chances += 1;
    if (r.perfect) f.perfect += 1;
    run = r.hit ? run + 1 : 0;
    f.hitRun = Math.max(f.hitRun, run);
    if (!r.hit) return;
    const type = seq[i]?.type;
    f.hits += 1;
    f.hitsBy[type] = (f.hitsBy[type] ?? 0) + 1;
    if ((r.bats === 'L' ? 1 : -1) * r.spray < -OPPO_DEG) f.oppo += 1;
    if (chances === CHANCES) f.lastHit = 1;
    if (r.kind !== 'hr') return;
    f.hr += 1;
    if (type !== 'fastball') f.breakHr += 1;
    if (Math.round(carryOf(r)) >= LONG_HR_M) f.longHr += 1;
  });
  return f;
}
// 그날 미션(list)마다 이 판으로 오른 수
export const missionGain = (list, facts) => list.map((m) => COUNT[m.id](facts, m));

// 그날 진행 { day, n: 미션마다 채운 수(목표에서 멈춤), paid: 받은 보상(1·2·4는 미션, 8은 셋 다) }. 망가졌거나 다른 날 값은 그날 빈 진행으로
export function cleanMissionState(v, day) {
  const need = missionsOn(day).map((m) => m.need);
  const ok = v && typeof v === 'object' && v.day === day && Array.isArray(v.n) && v.n.length === need.length && v.n.every((x) => Number.isInteger(x) && x >= 0)
    && Number.isInteger(v.paid) && v.paid >= 0 && v.paid <= 15;
  return ok ? { day, n: v.n.map((x, i) => Math.min(x, need[i])), paid: v.paid } : { day, n: need.map(() => 0), paid: 0 };
}
// 그날 진행(prev, 다른 날이면 처음부터)에 이 판으로 오른 수(gain)를 더한다. 새로 채운 미션은 칸 값, 셋 다 채운 첫 판은 ALL_BONUS를 더 준다.
// { state: 새 진행, done: 이 판으로 채운 미션 차례, coins: 이 판으로 받을 코인, bonus }
export function advanceMissions(prev, day, gain) {
  const list = missionsOn(day), base = cleanMissionState(prev, day);
  const n = list.map((m, i) => Math.min(m.need, base.n[i] + Math.max(0, gain[i] ?? 0)));
  let paid = base.paid, coins = 0, bonus = 0;
  const done = [];
  list.forEach((m, i) => { if (n[i] >= m.need && !(paid & (1 << i))) { paid |= 1 << i; coins += TIER_COINS[m.tier]; done.push(i); } });
  if (n.every((x, i) => x >= list[i].need) && !(paid & 8)) { paid |= 8; bonus = ALL_BONUS; coins += bonus; }
  return { state: { day, n, paid }, done, coins, bonus };
}
