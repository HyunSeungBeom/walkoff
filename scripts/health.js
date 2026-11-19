// @ts-check
// 상태 알림(2026-11-18 사용자 '운영 준비', 작업 글 walkoff-ops.md): 게임 주소와 랭킹 서버가 살아 있는지 본다. GitHub Actions가 15분마다 돌리고
// (.github/workflows/health.yml) 하나라도 죽었으면 잡이 실패해 GitHub가 메일을 보낸다. 이 컴퓨터에서도 돌린다: node scripts/health.js
// 게임: index.html이 200에 배포한 커밋 번호가 있고, 거기 적힌 게임 모듈(script·modulepreload)을 모두 받을 수 있는지(HEAD). 서버: /rankings가 200에 순위 모양인지.
// 새 주소(walkoff.kr)는 옛 주소 넘기기를 켜기 전(site.js MOVE_ON)에는 아직 안 붙었을 수 있어 실패해도 경고만 남긴다. 잠깐 끊긴 것은 30초 뒤 한 번 더 본다.
// EXTRA_URL(손으로 돌릴 때만, 실패 메일 시험용)을 주면 그 주소도 200인지 본다. 출력은 공개 레포의 실행 기록에 남아서 주소·커밋·상태만 찍는다
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 20_000, RETRY_MS = 30_000;
const get = (url, method = 'GET') => fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } });

// index.html에 적힌 게임 모듈 주소(script·modulepreload, 겹치는 것은 한 번)
function gameFiles(html) {
  return [...new Set([...html.matchAll(/<script type="module" src="([^"]+)"|<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
}

async function checkGame(site) {
  const res = await get(site);
  if (res.status !== 200) throw new Error(`index.html ${res.status}`);
  const html = await res.text(), build = /<div id="build">([0-9a-f]{7})<\/div>/.exec(html)?.[1], files = gameFiles(html);
  if (!build) throw new Error('배포한 커밋 번호가 없다(배포 단계가 index.html을 못 바꿨다)');
  if (!files.some((f) => f.endsWith('/main.js'))) throw new Error('게임 모듈(main.js)이 index.html에 없다');
  const bad = (await Promise.all(files.map(async (f) => [f, (await get(new URL(f, site).href, 'HEAD')).status]))).filter(([, s]) => s !== 200);
  if (bad.length) throw new Error(`모듈을 못 받는다: ${bad.map(([f, s]) => `${f} ${s}`).join(', ')}`);
  return `판 ${build}, 모듈 ${files.length}개`;
}

async function checkApi(api) {
  const res = await get(`${api}/rankings`);
  if (res.status !== 200) throw new Error(`/rankings ${res.status}`);
  const data = await res.json();
  if (typeof data.week !== 'string' || !Array.isArray(data.players)) throw new Error('/rankings 답의 모양이 다르다');
  return `이번 주 ${data.week}`;
}

async function checkUrl(url) {
  if (!/^https:\/\//.test(url)) throw new Error('https 주소만 본다');
  const res = await get(url);
  if (res.status !== 200) throw new Error(`${res.status}`);
  return '200';
}

// 꼭 살아 있어야 하는 주소는 한 번 실패하면 RETRY_MS 뒤 한 번 더 본다(망이 잠깐 끊긴 것으로 메일이 가지 않게). 경고만 남기는 주소는 바로 끝낸다
async function attempt(run, retry) {
  try { return { ok: true, note: await run() }; } catch (first) {
    if (!retry) return { ok: false, note: first.cause?.code ?? first.message };
    await new Promise((r) => setTimeout(r, RETRY_MS));
    try { return { ok: true, note: `${await run()} (한 번 더 봐서 됨: ${first.message})` }; } catch (e) { return { ok: false, note: e.cause?.code ?? e.message }; }
  }
}

async function main() {
  const { MOVE_ON, NEW_SITE, OLD_SITE } = await import('../js/infra/site.js');
  const api = /\|\| '(https:\/\/[^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'js', 'infra', 'api.js'), 'utf8'))?.[1];
  if (!api) throw new Error('js/infra/api.js에서 서버 주소를 못 찾았다');
  const checks = [
    { name: '옛 주소', url: OLD_SITE, run: () => checkGame(OLD_SITE), must: true },
    { name: '새 주소', url: NEW_SITE, run: () => checkGame(NEW_SITE), must: MOVE_ON },
    { name: '서버', url: `${api}/rankings`, run: () => checkApi(api), must: true },
  ];
  const extra = process.env.EXTRA_URL?.trim();
  if (extra) checks.push({ name: '시험 주소', url: extra, run: () => checkUrl(extra), must: true });
  const results = await Promise.all(checks.map(async (c) => ({ ...c, ...(await attempt(c.run, c.must)) })));
  const rows = results.map((r) => `${r.ok ? '✓' : r.must ? '✗' : '!'} ${r.name} ${r.url} · ${r.note}`);
  console.log(rows.join('\n'));
  for (const r of results.filter((x) => !x.ok)) console.log(`::${r.must ? 'error' : 'warning'} title=${r.name}::${r.url} ${r.note}${r.must ? '' : ' (옛 주소 넘기기를 켜기 전이라 경고만)'}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['| 상태 | 이름 | 주소 | 내용 |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : r.must ? '✗' : '!'} | ${r.name} | ${r.url} | ${r.note} |`)].join('\n') + '\n');
  if (results.some((r) => !r.ok && r.must)) process.exit(1);
}

module.exports = { gameFiles };
if (require.main === module) main().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
