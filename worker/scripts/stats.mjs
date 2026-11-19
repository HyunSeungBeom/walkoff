// 이용 통계를 원격 D1에서 표로 뽑는다: worker 폴더에서 npm run stats. 원격 DB는 읽기만 한다
// 날짜별 기기·판 수와 스윙 결과(src/stats.js, 2026-11-05 조준 타격 실험)에 더해 다시 온 비율·새 기기·도전장·주별 요약·무료 한도 어림(2026-11-18 통계 보강, stats-tables.js).
// 다시 온 비율·도전장 표의 날 수는 npm run stats -- --days 21처럼 바꾼다. 표는 한 번에 묻고(wrangler --json) 여기서 글자 표로 찍어서 터미널이 아닌 곳에서도 같다
import { spawnSync } from 'node:child_process';
import { STATS_SQL, SWING_SQL } from '../src/stats.js';
import { kstDay } from '../src/rules.js';
import { DAYS, deviceBackSql, playerBackSql, duelSql, weeklySql, withStyle, GAMES_SQL, limits, table } from './stats-tables.js';

const at = process.argv.indexOf('--days'), days = at > 0 ? Math.min(90, Math.max(2, Math.trunc(Number(process.argv[at + 1])) || DAYS)) : DAYS;
const wrangler = (args) => spawnSync('npx', ['wrangler', ...args], {
  encoding: 'utf8', maxBuffer: 64 << 20,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },   // 사용 통계는 보내지 않는다
});

// [제목, SQL, 아래 설명 줄, 줄 다듬기]
const TABLES = [
  ['날짜별 판(최근 7일)', STATS_SQL],
  ['스윙 결과(최근 7일)', SWING_SQL],
  [`다시 온 비율 · 기기(최근 ${days}일)`, deviceBackSql(days), [
    '*: 기간이 아직 안 끝나 늘 수 있음. 웹게임은 처음 온 기기의 다음 날이 10~15%면 잘 되는 편(CrazyGames)',
    '아이폰 사파리는 7일 넘게 안 연 사이트의 저장소를 지워서 같은 사람이 새 기기로 셀 수 있음(아래 계정 기준과 견준다)']],
  [`다시 온 비율 · 로그인 계정(최근 ${days}일, 10구 랭킹 점수를 낸 날)`, playerBackSql(days), ['기기를 바꿔도 같은 계정이면 같은 사람으로 센다']],
  [`도전장(최근 ${days}일)`, duelSql(days), ['보냄은 공유 단추를 누른 수, 도전장 판은 다시 친 판도 센다. 도전장으로 처음 온 기기는 지금 표로 못 센다']],
  ['주별 요약(랭킹 주, 한국 시간 월~일)', weeklySql(), [
    '*: 이번 주(안 끝남). 다음 날은 다음 날이 끝난 날만 센다. 최고 평균은 사람마다 그 주 최고 점수의 평균',
    '랭킹 판 수는 남지 않아서(사람마다 하루 최고 한 판) 10구는 로그인 안 한 판까지 센다'], withStyle],
];

const out = wrangler(['d1', 'execute', 'walkoff', '--remote', '--json', '--command', [...TABLES.map((t) => t[1]), GAMES_SQL].join(';\n')]);
let sets = null;
try { sets = JSON.parse(out.stdout).map((s) => s.results); } catch { /* 로그인이 풀렸거나 SQL 오류: wrangler가 낸 글을 그대로 보인다 */ }
if (out.status || sets?.length !== TABLES.length + 1) {
  process.stderr.write(`${out.stdout ?? ''}${out.stderr ?? ''}`);
  process.exit(out.status || 1);
}
TABLES.forEach(([title, , notes = [], shape = (rows) => rows], i) => {
  console.log(`\n■ ${title}\n${table(shape(sets[i]))}`);
  for (const n of notes) console.log(`  ${n}`);
});

// 무료 한도: 실제 줄 수는 d1 insights(지난 7일 쿼리마다 합계, 읽기만). 못 읽으면 그 칸만 '못 읽음'
const ins = wrangler(['d1', 'insights', 'walkoff', '--time-period', '7d', '--sort-by', 'writes', '--limit', '500', '--json']);
let used = null;
try { const list = JSON.parse(ins.stdout); if (Array.isArray(list)) used = list; } catch { /* 위 주석 */ }
const { rows, note } = limits(sets[TABLES.length], used, kstDay(Date.now()));
console.log(`\n■ 무료 한도 어림(하루)\n${table(rows)}`);
console.log(`  ${note}. 판당은 로그인한 10구 판 기준 어림(코드에서 셈)`);
console.log('  실제는 d1 insights 지난 7일의 하루 평균(손으로 돌린 조회 포함). 서버 요청 실제 수는 Cloudflare 대시보드(Workers)에서 본다');
