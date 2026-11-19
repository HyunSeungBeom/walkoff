// npm run stats에 더한 표(2026-11-18 통계 보강, 사용자 '통계 보강'): 다시 온 비율(기기·로그인 계정)과 새 기기, 도전장, 주별 요약, 무료 한도 어림.
// 홍보(11-23) 전에 넣은 것들이 사람을 데려오고 다시 오게 하는지를 끝까지 치는 비율·다음 날 다시 오는 비율로 본다(사용자 2026-11-04 기준).
// 원격 DB를 읽기만 하고 표를 새로 만들지 않는다. 서버 코드(src/)를 바꾸면 서버 배포가 따라서 표는 여기 두고 stats.mjs가 돌린다.
// 날짜는 한국 시간으로 센다(src/stats.js STATS_SQL과 같은 date('now', '+9 hours'))
import { styleOn } from '../../js/core/pitches.js';
import { addDays } from '../src/rules.js';

export const DAYS = 14;   // 다시 온 비율·도전장 표의 날 수(npm run stats -- --days 21). '7일 안'까지 끝난 날이 보이려면 8일보다 길어야 한다
export const WEEKS = 8;   // 주별 요약의 주 수
const TODAY = "date('now', '+9 hours')";
const monday = (day) => `date(${day}, '-6 days', 'weekday 1')`;   // 그 날짜가 든 주의 월요일(src/rules.js weekStart와 같다)
const NOT_PLAYS = "('invite', 'move')";   // 판이 아닌 모드(src/stats.js와 같다: 도전장 보낸 수, 옛 주소에서 옮긴 기기)
// 투수 유형 이름(js/view/text.js STYLE_NAMES와 같다. 서버 쪽은 js/core만 가져다 쓴다)
const STYLE_NAMES = { classic: '정통파', power: '강속구형', finesse: '기교파', forkball: '포크볼러' };

// 비율 칸 '43% (3)': base 가운데 hit의 비율과 수. after일 기간이 아직 안 끝났으면 *(오늘이 끝나면 늘 수 있다), 다음 날이 아직 안 왔거나 base가 0이면 빈칸
const rate = (hit, base, after) => `CASE WHEN day >= today OR ${base} = 0 THEN '' ELSE printf('%d%% (%d)', CAST(ROUND(100.0 * ${hit} / ${base}) AS INTEGER), ${hit})
  || CASE WHEN date(day, '+${after} days') >= today THEN '*' ELSE '' END END`;
const pct = (hit, base) => `CASE WHEN COALESCE(${base}, 0) = 0 THEN '' ELSE CAST(ROUND(100.0 * COALESCE(${hit}, 0) / ${base}) AS INTEGER) || '%' END`;
// 온 날마다 그 기기(사람)가 다음에 온 날(next)과 처음 온 날(first). 날짜 범위를 고르기 전에 표 전체로 센다(범위 앞에 온 적이 있으면 새 기기가 아니다)
const visits = (table, id) => `SELECT ${id} AS id, day, LEAD(day) OVER (PARTITION BY ${id} ORDER BY day) AS next, MIN(day) OVER (PARTITION BY ${id}) AS first FROM ${table}`;

// 날짜마다 온 수와 그중 다음 날·7일 안에 다시 온 비율, 그날 처음 온 수와 그중 다시 온 비율
function backSql(table, id, [who, fresh], days) {
  return `WITH t AS (SELECT ${TODAY} AS today), v AS (${visits(table, id)}),
c AS (SELECT day, COUNT(*) AS n, COUNT(CASE WHEN next = date(day, '+1 day') THEN 1 END) AS b1, COUNT(CASE WHEN next <= date(day, '+7 days') THEN 1 END) AS b7,
  COUNT(CASE WHEN first = day THEN 1 END) AS f, COUNT(CASE WHEN first = day AND next = date(day, '+1 day') THEN 1 END) AS f1,
  COUNT(CASE WHEN first = day AND next <= date(day, '+7 days') THEN 1 END) AS f7
  FROM v, t WHERE day >= date(today, '-${days - 1} days') GROUP BY day)
SELECT day AS "날짜", n AS "${who}", ${rate('b1', 'n', 1)} AS "다음 날", ${rate('b7', 'n', 7)} AS "7일 안",
  f AS "${fresh}", ${rate('f1', 'f', 1)} AS "그중 다음 날", ${rate('f7', 'f', 7)} AS "그중 7일 안"
FROM c, t ORDER BY day DESC`;
}
// 기기(play_devices, 게임이 기기에 저장한 무작위 번호). 아이폰 사파리는 7일 넘게 안 연 사이트의 저장소를 지워서(2020 WebKit) 같은 사람이 새 기기로 셀 수 있다
export const deviceBackSql = (days = DAYS) => backSql('play_devices', 'device', ['기기', '새 기기'], days);
// 로그인 계정(daily_scores, 10구 랭킹 점수를 낸 날). 기기를 바꾸거나 저장소가 지워져도 같은 사람으로 센다. 기기 쪽과 잇지 않는다
export const playerBackSql = (days = DAYS) => backSql('daily_scores', 'player_id', ['낸 사람', '처음 낸 사람'], days);

// 도전장(2026-11-16): 날짜마다 보낸 수(invite, 공유 단추를 누른 수) → 도전장 판 시작·끝(duel, 다시 친 판도 센다), 맨 아래 합계.
// 기기마다 모드가 남지 않아서 '도전장으로 처음 온 기기'는 이 표들로 못 센다(표에 칸을 더해야 한다)
export const duelSql = (days = DAYS) => `WITH t AS (SELECT ${TODAY} AS today),
c AS (SELECT day, COALESCE(SUM(CASE mode WHEN 'invite' THEN starts END), 0) AS sent, COALESCE(SUM(CASE mode WHEN 'duel' THEN starts END), 0) AS played,
  COALESCE(SUM(CASE mode WHEN 'duel' THEN ends END), 0) AS done FROM play_stats, t WHERE mode IN ('invite', 'duel') AND day >= date(today, '-${days - 1} days') GROUP BY day),
r AS (SELECT day, sent, played, done FROM c UNION ALL SELECT '합계', SUM(sent), SUM(played), SUM(done) FROM c GROUP BY 1)
SELECT day AS "날짜", sent AS "보냄", played AS "도전장 판", done AS "끝까지", CASE WHEN sent = 0 THEN '' ELSE printf('%.1f', 1.0 * played / sent) END AS "판/보냄",
  ${pct('done', 'played')} AS "끝까지%"
FROM r ORDER BY day = '합계', day DESC`;

// 주별 요약(랭킹 주, 한국 시간 월~일): 기기·새 기기·다음 날 다시 온 비율(다음 날이 끝난 날만), 10구 시작과 끝까지 친 비율, 랭킹 점수를 낸 사람과
// 사람마다 그 주 최고 점수의 평균·1등 점수. 이번 주는 *. 랭킹 판 수는 남지 않아서(daily_scores는 사람마다 하루 최고 한 판) 10구는 로그인 안 한 판까지 센다
export const weeklySql = (weeks = WEEKS) => `WITH t AS (SELECT ${TODAY} AS today), v AS (${visits('play_devices', 'device')}),
dw AS (SELECT ${monday('day')} AS week, COUNT(DISTINCT id) AS devices, COUNT(CASE WHEN first = day THEN 1 END) AS fresh,
  COUNT(CASE WHEN date(day, '+1 day') < today THEN 1 END) AS b, COUNT(CASE WHEN date(day, '+1 day') < today AND next = date(day, '+1 day') THEN 1 END) AS b1
  FROM v, t GROUP BY 1),
pw AS (SELECT ${monday('day')} AS week, SUM(CASE mode WHEN 'challenge' THEN starts END) AS cs, SUM(CASE mode WHEN 'challenge' THEN ends END) AS ce FROM play_stats GROUP BY 1),
bw AS (SELECT week, COUNT(*) AS players, CAST(ROUND(AVG(best)) AS INTEGER) AS mean, MAX(best) AS top FROM (SELECT week, MAX(score) AS best FROM daily_scores GROUP BY week, player_id) GROUP BY week)
SELECT dw.week || CASE WHEN dw.week = ${monday('today')} THEN '*' ELSE '' END AS "주", devices AS "기기", fresh AS "새 기기", ${pct('b1', 'b')} AS "다음 날",
  COALESCE(cs, 0) AS "10구", ${pct('ce', 'cs')} AS "끝까지", COALESCE(players, 0) AS "랭킹 사람", mean AS "최고 평균", top AS "1등"
FROM dw CROSS JOIN t LEFT JOIN pw ON pw.week = dw.week LEFT JOIN bw ON bw.week = dw.week ORDER BY dw.week DESC LIMIT ${weeks}`;
// 주별 요약의 '주' 다음에 그 주 투수 유형(js/core styleOn: 11-23부터 월요일마다 바뀐다)을 넣는다. 11-23부터 유형끼리 견준다
export const withStyle = (rows) => rows.map(({ 주: week, ...rest }) => ({ 주: week, 투수: STYLE_NAMES[styleOn(week.slice(0, 10))], ...rest }));

// ===== 무료 한도 어림 =====
// 판 하나가 쓰는 서버 요청과 D1 줄(2026-11-18 코드에서 셈). 로그인한 10구 판 기준이라 넉넉한 쪽이다(로그인 안 한 판·연습은 통계 묶음뿐).
// 요청: 시드 표 POST /seeds 1 + 점수 POST /scores 1 + 그 둘의 OPTIONS 2(access-control-max-age 동안 브라우저가 답을 들고 있어 실제로는 덜 온다)
//   + 통계 묶음 POST /events 1(신호 20개마다·화면을 떠날 때, 판 하나에 시작·끝·스윙 신호 10여 개) + 랭킹 GET /rankings 1(랭킹 화면·메뉴를 열 때, 메뉴는 1분에 한 번까지) = 6
// 쓰기: /scores 묶음의 그날 기록 1~3(그날 첫 판이면 표·기본 키·주 색인) + 주간 요약 1 + 계정 닉네임·판 수 2(닉네임 색인) + 쓴 표 1 + 기한 지난 표 지우기 1
//   + 코인 1 + 칭호 1, 통계 묶음 3~4(기기·모드·스윙, 그날 처음이면 줄마다 색인 하나 더) ≈ 13(2026-11-18 d1 insights 쿼리별 줄 수와 맞춰 봄)
// 읽기: /scores 약 50(그 사람의 그 주 기록·역대 최고, 요약), /rankings 약 60(요약 2줄, 목록 50명의 입은 물건), 통계 묶음 4 ≈ 120 → 넉넉히 150
export const PER_GAME = { requests: 6, writes: 13, reads: 150 };
// 무료 플랜 하루 한도(2026-11-18 공식 문서, CLAUDE-rules.md '서버 자세히'). 넘으면 과금 없이 그날 오류, 한국 시간 오전 9시에 풀린다
export const FREE = { requests: 100000, writes: 100000, reads: 5000000 };
const LIMIT_NAMES = { requests: '서버 요청', writes: 'D1 쓰기', reads: 'D1 읽기' };
// 날짜마다 판 수(시작한 판, 판이 아닌 모드는 뺀다)
export const GAMES_SQL = `SELECT day, SUM(starts) AS games FROM play_stats WHERE mode NOT IN ${NOT_PLAYS} GROUP BY day ORDER BY day`;

const comma = (n) => Math.round(n).toLocaleString('en-US');
const share = (x, limit) => { const p = (100 * x) / limit; return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`; };
const busiest = (list) => list.reduce((a, g) => (g.games > (a?.games ?? -1) ? g : a), null);

// 무료 한도 표: games는 GAMES_SQL 줄, used는 d1 insights 지난 7일(쿼리마다 totalRowsWritten·totalRowsRead, 못 읽었으면 null), today는 한국 시간 오늘.
// 판 수는 최근 7일·지금까지 가장 많이 친 날에 판당 값을 곱한다. 실제는 insights 합계를 7로 나눈 하루 평균(손으로 돌린 조회도 든다)
export function limits(games, used, today) {
  const week = busiest(games.filter((g) => g.day >= addDays(today, -6))), ever = busiest(games);
  const total = (k) => used.reduce((s, q) => s + (Number(q[k]) || 0), 0);
  const actual = { writes: used && total('totalRowsWritten') / 7, reads: used && total('totalRowsRead') / 7 };
  const rows = Object.entries(LIMIT_NAMES).map(([k, name]) => ({
    무엇: name, '하루 한도': FREE[k], 판당: PER_GAME[k], '한도에 닿는 판': Math.floor(FREE[k] / PER_GAME[k]),
    '최근 7일 최다 날': week ? share(week.games * PER_GAME[k], FREE[k]) : '', '지금까지 최다 날': ever ? share(ever.games * PER_GAME[k], FREE[k]) : '',
    '실제 하루 평균': k === 'requests' ? '대시보드에서' : used ? `${comma(actual[k])}줄 · ${share(actual[k], FREE[k])}` : '못 읽음',
  }));
  const at = (g) => (g ? `${comma(g.games)}판(${g.day.slice(5)})` : '없음');
  return { rows, note: `판 수: 최근 7일 가장 많은 날 ${at(week)}, 지금까지 가장 많은 날 ${at(ever)}` };
}

// ===== 글자 표 =====
// 터미널에서 한글·전각 글자는 두 칸이다
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const width = (s) => [...s].reduce((w, c) => w + (WIDE.test(c) ? 2 : 1), 0);
const text = (v) => (v == null ? '' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const NUMERIC = /^[-\d,.%() *<]*$/;
// 줄 목록을 칸을 맞춘 글자 표로. 첫 칸(날짜·주)은 왼쪽, 나머지는 모두 숫자 꼴(숫자·%·괄호·*)이면 오른쪽에 붙인다. 줄이 없으면 '(없음)'
export function table(rows) {
  if (!rows.length) return '(없음)';
  const keys = Object.keys(rows[0]), body = rows.map((r) => keys.map((k) => text(r[k])));
  const w = keys.map((k, i) => Math.max(width(k), ...body.map((r) => width(r[i]))));
  const right = keys.map((k, i) => i > 0 && body.every((r) => NUMERIC.test(r[i])));
  const line = (cells) => cells.map((s, i) => (right[i] ? ' '.repeat(w[i] - width(s)) + s : s + ' '.repeat(w[i] - width(s)))).join('  ').trimEnd();
  return [line(keys), ...body.map(line)].join('\n');
}
