// 운영 명령(2026-11-19 사용자 '공개 화면 지키기'): 화면 없이 이상한 점수·닉네임을 바로 내린다. worker 폴더에서
//   npm run mod -- find 골든 | '#4821' | 골든#4821 | id:계정ID          사람 찾기와 그 사람의 이번 주·지난주 판
//   npm run mod -- hide-scores '#4821' [--week 2026-11-16 | --day 2026-11-19]   그 주(기본 이번 주)나 그날 판을 랭킹에서 숨긴다
//   npm run mod -- show-scores '#4821' [--week … | --day …]                     숨긴 판을 다시 보인다
//   npm run mod -- reset-nick '#4821'                                             닉네임을 기본 닉네임(타자1234 꼴)으로 바꾼다
//   npm run mod -- hide-player '#4821'                                            계정을 랭킹에서 숨긴다(지난 판까지, 다시 못 올린다)
//   npm run mod -- show-player '#4821'                                            계정 숨김을 푼다
//   npm run mod -- hidden                                                         숨긴 계정·판 목록
// 바꾸는 명령은 처음에는 바뀔 판과 SQL만 보이고 --yes를 붙여야 쓴다. 기본은 로컬 DB(npm run db:local로 만든 것)이고,
// --remote면 운영 DB다(운영 DB 쓰기는 돌릴 때마다 사용자 승인, CLAUDE-rules.md '서버 자세히')
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { addDays, kstDay, weekStart } from '../src/rules.js';
import { checkNick } from '../../js/core/nick.js';
import { findSql, hiddenSql, hidePlayer, hideScores, inline, parseTarget, resetNick, rowsSql, showPlayer, showScores } from './mod-sql.js';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const [cmd, rawTarget] = argv.filter((a, i) => !a.startsWith('--') && !['--week', '--day'].includes(argv[i - 1]));
const remote = argv.includes('--remote'), yes = argv.includes('--yes');
const fail = (msg) => { console.error(msg); process.exit(1); };

// 문장들을 한 번에 보내고 문장마다 결과 줄을 돌려준다
function d1(statements) {
  const sql = statements.map(inline).join(';\n');
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'walkoff', remote ? '--remote' : '--local', '--json', '--command', sql], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },   // 사용 통계는 보내지 않는다
  });
  if (r.status) fail(r.stderr || r.stdout);
  return JSON.parse(r.stdout).map((x) => x.results ?? []);
}

const tagText = (tag) => (tag == null ? '' : `#${String(tag).padStart(4, '0')}`);
const who = (a) => `${a.nick ?? '-'}${tagText(a.tag)} (id:${a.player_id}${a.hidden_at != null ? `, 계정 숨김 ${new Date(a.hidden_at).toISOString()}` : ''})`;
const HIDDEN = ['보임', '판 숨김', '계정 숨김'];
function showRows(rows) {
  if (!rows.length) { console.log('  (판 없음)'); return; }
  console.table(rows.map((r) => ({ 날: r.day, 점수: r.score, 닉네임: r.nick, 팀: r.team, 불: r.lights, 숨김: HIDDEN[r.hidden] ?? r.hidden })));
}

// 바꿀 사람 한 명. 닉네임만으로는 같은 닉네임이 여럿일 수 있어 바꾸지 않는다. 계정이 없는 예전 기록은 id:로 고른다
function onePlayer(t) {
  if (!t || (t.tag == null && !t.id)) fail("바꾸는 명령은 '#번호', '닉네임#번호', 'id:계정ID'로 한 사람을 고른다(먼저 find로 찾는다)");
  const [found] = d1([findSql(t)]);
  if (found.length === 1) return found[0];
  if (t.id && !found.length) {
    const [rows] = d1([rowsSql(t.id)]);
    if (rows.length) return { player_id: t.id, nick: rows.at(-1).nick, tag: null, hidden_at: null };
  }
  return fail(found.length ? '여러 사람이 걸렸다' : '그런 사람이 없다');
}

// 바꾸는 명령: 바뀌기 전 판을 보이고, --yes면 쓰고 바뀐 뒤 판을 보인다
function change(player, statements, weeks) {
  console.log(`대상: ${who(player)}`);
  showRows(d1([rowsSql(player.player_id, weeks)])[0]);
  console.log(`\n보낼 SQL(DB: ${remote ? '운영(--remote)' : '로컬'}):\n${statements.map(inline).join(';\n')}`);
  if (!yes) { console.log('\n아직 쓰지 않았다. 쓰려면 --yes를 붙인다'); return; }
  d1(statements);
  console.log('\n바꾼 뒤:');
  const [after] = d1([findSql({ id: player.player_id })]);
  if (after[0]) console.log(`  ${who(after[0])}`);
  showRows(d1([rowsSql(player.player_id, weeks)])[0]);
}

const thisWeek = weekStart(kstDay(Date.now()));
const t = parseTarget(rawTarget);
if (cmd === 'find') {
  if (!t) fail('찾을 닉네임이나 번호를 적는다');
  const [found] = d1([findSql(t)]);
  if (!found.length) console.log('계정 없음(계정이 없는 예전 기록이면 id:로 찾는다)');
  for (const a of found.slice(0, 5)) { console.log(who(a)); showRows(d1([rowsSql(a.player_id, [thisWeek, addDays(thisWeek, -7)])])[0]); }
  if (t.id && !found.length) showRows(d1([rowsSql(t.id)])[0]);
  if (found.length > 5) console.log(`… 그 밖에 ${found.length - 5}명(#번호로 고른다)`);
} else if (cmd === 'hidden') {
  const [players, rows] = d1(hiddenSql());
  console.log(`숨긴 계정 ${players.length}`); for (const a of players) console.log(`  ${who(a)}`);
  console.log(`숨긴 판(최근 50)`); console.table(rows.map((r) => ({ id: r.player_id, 날: r.day, 닉네임: r.nick, 점수: r.score, 숨김: HIDDEN[r.hidden] })));
} else if (cmd === 'hide-scores' || cmd === 'show-scores') {
  const p = onePlayer(t), day = opt('day'), week = day ? weekStart(day) : weekStart(opt('week') ?? thisWeek);
  change(p, (cmd === 'hide-scores' ? hideScores : showScores)({ playerId: p.player_id, week, day }), [week]);
} else if (cmd === 'reset-nick') {
  const p = onePlayer(t), nick = `타자${randomInt(1000, 10000)}`;   // 게임 defaultNick과 같은 꼴(늘 checkNick을 통과한다, tests/core/nick.test.mjs)
  if (!checkNick(nick).ok) fail(`기본 닉네임이 규칙에 걸림: ${nick}`);
  console.log(`새 닉네임: ${nick}`);
  change(p, resetNick({ playerId: p.player_id, nick }), [thisWeek, addDays(thisWeek, -7)]);
} else if (cmd === 'hide-player' || cmd === 'show-player') {
  const p = onePlayer(t);
  change(p, cmd === 'hide-player' ? hidePlayer({ playerId: p.player_id, now: Date.now() }) : showPlayer({ playerId: p.player_id }), [thisWeek, addDays(thisWeek, -7)]);
} else {
  fail('명령: find · hide-scores · show-scores · reset-nick · hide-player · show-player · hidden (쓰는 법은 이 파일 맨 위)');
}
