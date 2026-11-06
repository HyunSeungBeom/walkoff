// 칭호·업적(2026-11-05 유저 피드백 '칭호·업적과 랭킹에 칭호 표시', 사용자 승인 계획 ~/.claude/plans/walkoff-feedback-123.md).
// 2026-11-06 사용자 '한 번 쳤다고 주면 좀 그렇지 않나, 100번 정도는 해야 칭호 줘야지, 전체적으로 횟수 난이도 올려줘'로 쌓아서 받는 칭호 50개로 바꿨다
// (목록 ~/.claude/plans/walkoff-titles-more.md). 10구 도전 판마다 그 판의 전광판(lights, 공마다 S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R 그 밖)과
// 공 순서(구종·존·투수 손), 점수로 쌓는 수(countsOf)를 내고, 쌓인 수가 칭호마다 정한 수(need)에 닿으면 준다(titlesFor).
// 랭킹 서버(worker /scores)가 판마다 쌓아 계정에 남기고, 로그인 안 했으면 게임이 이 기기에서 같은 함수로 쌓는다.
// 연속은 게임 점수 규칙(연속 홈런·연속 안타)처럼 골라낸 볼(Y)이 끊지 않는다. 예전 게임의 G(어떤 안타인지 모름)는 쌓지 않는다.
// 목록 순서가 랭킹에 보이는 대표 칭호(topTitle)의 우선순위라서 등급(전설 → 희귀 → 보통 → 웃음) 순서로 둔다. short는 랭킹 줄의 배지(2~4글자).
// key는 쌓는 수의 이름이다. g_로 시작하면 그 일이 일어난 판의 수(한 판에 여러 번 나와도 1)이고, 아니면 개수다
import { CHANCES } from './score.js';
import { PITCHES, zoneMiss } from './pitches.js';

export const TIERS = [['legend', '전설'], ['rare', '희귀'], ['normal', '보통'], ['fun', '웃음']];
const T = (tier, list) => list.map(([id, name, short, key, need, desc]) => ({ id, name, short, key, need, desc, tier }));
export const TITLES = [
  ...T('legend', [
    ['god', '⭐야구의신⭐', '⭐신⭐', 'g_hr10', 1, '한 판에 기회 10번 모두 홈런'],   // 이름의 별은 사용자가 정했다(2026-11-06)
    ['hit10', '10할 타자', '10할', 'g_hit10', 1, '기회 10번 모두 안타인 판 1판'],
    ['k30', '3만 클럽', '3만점', 'g_30k', 1, '30,000점 이상인 판 1판'],
    ['natural', '내추럴 사이클', '내추럴', 'g_natural', 5, '단타·2루타·3루타·홈런을 이 순서로 친 판 5판'],
    ['cycle', '사이클링 히트', '사이클', 'g_cycle', 50, '단타·2루타·3루타·홈런을 다 친 판 50판'],
    ['derby', '홈런 더비', '더비왕', 'g_hr7', 5, '홈런 7개 이상 친 판 5판'],
    ['machine', '타격 기계', '타격기계', 'g_run8', 10, '연속 안타 8번이 나온 판 10판'],
    ['dash', '질주 본능', '질주', 'g_t2', 10, '3루타 2개 이상 친 판 10판'],
    ['eyes', '눈야구', '눈야구', 'g_ball10', 5, '볼 10개 이상 골라낸 판 5판'],
    ['firstlast', '처음과 끝', '처음끝', 'g_firstLast', 20, '첫 기회와 마지막 기회 모두 홈런인 판 20판'],
    ['k20', '2만 클럽', '2만점', 'g_20k', 20, '20,000점 이상인 판 20판'],
    ['hrking', '홈런왕', '홈런왕', 'hr', 2000, '홈런 2,000개'],
    ['hr3run', '3연속 홈런', '3연포', 'g_hr3run', 50, '연속 홈런 3번이 나온 판 50판'],
    ['hit7', '맹타', '맹타', 'g_hit7', 50, '안타 7개 이상 친 판 50판'],
    ['five', '오색 안타', '오색', 'g_five', 50, '다섯 구종 모두 안타인 판 50판'],
  ]),
  ...T('rare', [
    ['walkoff', '끝내기 홈런', '끝내기', 'lastHr', 100, '마지막 기회(끝내기 찬스) 홈런 100번'],
    ['hitking', '안타왕', '안타왕', 'hit', 5000, '안타 5,000개'],
    ['slugger', '장타자', '장타자', 'xbh', 2000, '장타(2루타·3루타·홈런) 2,000개'],
    ['breaking', '변화구 킬러', '변화구', 'breakHit', 2000, '변화구(슬라이더·커브·체인지업·포크) 안타 2,000개'],
    ['factory', '홈런 공장장', '공장장', 'hr', 1000, '홈런 1,000개'],
    ['eye', '선구안', '선구안', 'ball', 1000, '볼 1,000개 골라내기'],
    ['fbkill', '직구 킬러', '직구킬러', 'fbHr', 500, '직구 홈런 500개'],
    ['d2king', '2루타왕', '2루타왕', 'd2', 500, '2루타 500개'],
    ['lefty', '좌완 킬러', '좌완킬러', 'leftyHr', 300, '좌완 투수 판에서 홈런 300개'],
    ['b2b', '백투백', '백투백', 'g_b2b', 200, '연속 홈런 2번이 나온 판 200판'],
    ['curve', '커브 저격수', '저격수', 'curveHr', 200, '커브 홈런 200개'],
    ['heat', '강속구 격파', '강속구', 'fastHr', 200, '151km 넘는 직구 홈런 200개'],
    ['lucky7', '럭키 세븐', '럭키7', 'seventhHr', 177, '7번째 기회 홈런 177번'],
    ['leadoff', '리드오프 홈런', '리드오프', 'firstHr', 100, '첫 기회 홈런 100번'],
    ['fork', '포크 장인', '포크장인', 'forkHr', 100, '포크 홈런 100개'],
    ['k10', '만점 클럽', '1만점', 'g_10k', 100, '10,000점 이상인 판 100판'],
    ['patience', '인내심', '인내심', 'g_ball3', 100, '볼 3개를 잇달아 골라낸 판 100판'],
    ['badball', '배드볼 히터', '배드볼', 'badHr', 50, '존 밖 공 홈런 50개'],
    ['t3', '3루타 장인', '3루타', 't3', 50, '3루타 50개'],
    ['hr3', '홈런 3방', '3홈런', 'g_hr3', 50, '홈런 3개 이상 친 판 50판'],
    ['run5', '안타 제조기', '제조기', 'g_run5', 50, '연속 안타 5번이 나온 판 50판'],
    ['xbh3', '연속 장타', '연속장타', 'g_xbh3', 50, '장타 3번 연속이 나온 판 50판'],
    ['coaster', '롤러코스터', '롤코', 'g_coaster', 50, '홈런·아웃을 번갈아 4번인 판 50판'],
    ['late', '대기만성', '대기만성', 'g_late', 20, '앞 5번 모두 아웃, 뒤 5번에 안타 4개 이상인 판 20판'],
  ]),
  ...T('normal', [
    ['multi', '멀티포', '멀티포', 'g_hr2', 200, '홈런 2개 이상 친 판 200판'],
    ['clutch', '해결사', '해결사', 'lastHit', 200, '마지막 기회 안타 200번'],
    ['k5', '5천 클럽', '5천점', 'g_5k', 200, '5,000점 이상인 판 200판'],
    ['firsthr', '첫 홈런', '첫 홈런', 'hr', 1, '홈런 1번'],
  ]),
  ...T('fun', [
    ['outking', '아웃왕', '아웃왕', 'g_out5', 200, '연속 아웃 5번이 나온 판 200판'],
    ['choke', '새가슴', '새가슴', 'g_choke', 200, '마지막 기회 세 번 모두 아웃인 판 200판'],
    ['silent', '침묵의 방망이', '침묵', 'g_zero', 100, '안타 0개인 판 100판'],
    ['boom', '공갈포', '공갈포', 'g_boom', 50, '홈런 2개 이상, 나머지 기회는 모두 아웃인 판 50판'],
    ['tick', '똑딱이', '똑딱이', 'g_singles', 50, '단타만 5개 이상(장타 0개)인 판 50판'],
    ['fade', '용두사미', '용두사미', 'g_fade', 50, '앞 5번에 안타 4개 이상, 뒤 5번 모두 아웃인 판 50판'],
    ['watch', '방망이는 거들 뿐', '거들뿐', 'g_watch', 20, '볼 5개 이상 골라내고 안타 0개인 판 20판'],
  ]),
];
export const TITLE_IDS = TITLES.map((t) => t.id);
export const titleById = (id) => TITLES.find((t) => t.id === id) ?? null;
export const COUNT_KEYS = [...new Set(TITLES.map((t) => t.key))];

const isHit = (r) => r === 'S' || r === 'D' || r === 'T' || r === 'H';
// 볼을 뺀 결과(res)에서 pred가 이어지는 가장 긴 길이
function longest(res, pred) {
  let best = 0, n = 0;
  for (const r of res) { n = pred(r) ? n + 1 : 0; best = Math.max(best, n); }
  return best;
}

// 한 판으로 쌓는 수(COUNT_KEYS 가운데 0이 아닌 것만). seq는 그 판의 공 순서(lights와 같은 차례), lefty는 상대가 좌완인지, score는 그 판 점수
export function countsOf(lights, seq = [], lefty = false, score = 0) {
  const s = String(lights ?? '');
  if (!s || s.includes('G')) return {};
  const out = {}, add = (k, n = 1) => { if (n > 0) out[k] = (out[k] ?? 0) + n; }, flag = (k, on) => { if (on) out[k] = 1; };
  const chances = [];   // 기회(볼이 아닌 공)마다 결과와 그 공. 판은 기회 10번에서 끝난다
  let balls = 0, ballRun = 0, ballBest = 0;
  [...s].forEach((r, i) => {
    if (r === 'Y') { balls += 1; ballRun += 1; ballBest = Math.max(ballBest, ballRun); return; }
    ballRun = 0;
    if (chances.length < CHANCES) chances.push({ r, p: seq[i] });
  });
  const res = chances.map((c) => c.r), num = (r) => res.filter((x) => x === r).length, full = res.length === CHANCES, last = full ? res[CHANCES - 1] : null;
  const hits = res.filter(isHit).length, hr = num('H'), d2 = num('D'), t3 = num('T'), singles = num('S'), xbh = d2 + t3 + hr, hitsIn = (a) => a.filter(isHit).length;
  add('hr', hr); add('hit', hits); add('xbh', xbh); add('d2', d2); add('t3', t3); add('ball', balls);
  flag('g_hr10', full && hr === CHANCES); flag('g_hit10', full && hits === CHANCES);
  flag('g_cycle', singles && d2 && t3 && hr); flag('g_natural', /S.*D.*T.*H/.test(res.filter(isHit).join('')));
  flag('g_hr2', hr >= 2); flag('g_hr3', hr >= 3); flag('g_hr7', hr >= 7);
  const hrRun = longest(res, (r) => r === 'H');
  flag('g_b2b', hrRun >= 2); flag('g_hr3run', hrRun >= 3);
  flag('g_run5', longest(res, isHit) >= 5); flag('g_run8', longest(res, isHit) >= 8); flag('g_xbh3', longest(res, (r) => r === 'D' || r === 'T' || r === 'H') >= 3);
  flag('g_out5', longest(res, (r) => r === 'R') >= 5);
  flag('g_hit7', hits >= 7); flag('g_t2', t3 >= 2); flag('g_ball3', ballBest >= 3); flag('g_ball10', balls >= 10);
  if (res[0] === 'H') add('firstHr');
  if (res[6] === 'H') add('seventhHr');
  if (last === 'H') add('lastHr');
  if (last && isHit(last)) add('lastHit');
  flag('g_firstLast', res[0] === 'H' && last === 'H');
  flag('g_coaster', /HRHR|RHRH/.test(res.join('')));
  const front = res.slice(0, 5), back = res.slice(5);
  flag('g_late', full && hitsIn(front) === 0 && hitsIn(back) >= 4);
  flag('g_fade', full && hitsIn(front) >= 4 && hitsIn(back) === 0);
  flag('g_5k', score >= 5000); flag('g_10k', score >= 10000); flag('g_20k', score >= 20000); flag('g_30k', score >= 30000);
  flag('g_boom', full && hr >= 2 && hr + num('R') === CHANCES);
  flag('g_singles', singles >= 5 && xbh === 0);
  flag('g_choke', full && res.slice(-3).every((r) => r === 'R'));
  flag('g_zero', full && hits === 0);
  flag('g_watch', full && balls >= 5 && hits === 0);
  // 구종·존·투수: 친 공(안타)이 무엇이었는지
  const types = new Set();
  for (const { r, p } of chances) {
    if (!p || !isHit(r)) continue;
    types.add(p.type);
    if (p.type !== 'fastball') add('breakHit');
    if (r !== 'H') continue;
    if (zoneMiss(p) > 0) add('badHr');
    if (p.type === 'fastball') { add('fbHr'); if (p.kmh > 151) add('fastHr'); }
    if (p.type === 'curve') add('curveHr');
    if (p.type === 'fork') add('forkHr');
    if (lefty) add('leftyHr');
  }
  flag('g_five', types.size === Object.keys(PITCHES).length);
  return out;
}

// 쌓인 수를 정리한다(모르는 칸·0보다 작은 값·정수가 아닌 값은 버린다)
export function cleanCounts(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of COUNT_KEYS) if (Number.isSafeInteger(v[k]) && v[k] > 0) out[k] = v[k];
  return out;
}
// 쌓인 수 a에 한 판(b)을 더한다
export function addCounts(a, b) {
  const out = cleanCounts(a), inc = cleanCounts(b);
  for (const [k, n] of Object.entries(inc)) out[k] = (out[k] ?? 0) + n;
  return out;
}
// 쌓인 수로 받을 칭호 id들(TITLES 순서)
export const titlesFor = (counts) => TITLES.filter((t) => (counts?.[t.key] ?? 0) >= t.need).map((t) => t.id);

// 받은 칭호 가운데 가장 앞(등급이 높은) 것. 없으면 null
export const topTitle = (ids) => TITLE_IDS.find((id) => (ids ?? []).includes(id)) ?? null;
