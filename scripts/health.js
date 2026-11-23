// @ts-check
// 상태 알림(2026-11-18 사용자 '운영 준비', 작업 글 walkoff-ops.md): 게임 주소와 랭킹 서버가 살아 있는지 본다. GitHub Actions가 15분마다 돌리고
// (.github/workflows/health.yml) 하나라도 죽었으면 잡이 실패해 GitHub가 메일을 보낸다. 이 컴퓨터에서도 돌린다: node scripts/health.js
// 2026-11-20부터 첫째 감시는 Cloudflare Worker(worker/health, 5분마다 메일)이고 이것은 두 번째 감시다. 판정은 둘이 같은 코드(worker/health/src/checks.js)를 쓴다
// 게임: index.html이 200에 배포한 커밋 번호가 있고, 거기 적힌 게임 모듈(script·modulepreload)을 모두 받을 수 있는지(HEAD). 서버: /rankings가 200에 순위 모양인지.
// 새 주소(walkoff.kr)는 옛 주소 넘기기를 켜기 전(site.js MOVE_ON)에는 아직 안 붙었을 수 있어 실패해도 경고만 남긴다. 잠깐 끊긴 것은 30초 뒤 한 번 더 본다.
// EXTRA_URL(손으로 돌릴 때만, 실패 메일 시험용)을 주면 그 주소도 200인지 본다. 출력은 공개 레포의 실행 기록에 남아서 주소·커밋·상태만 찍는다
const fs = require('fs');
const path = require('path');

const RETRY_MS = 30_000;

async function main() {
  const { MOVE_ON, NEW_SITE, OLD_SITE } = await import('../js/infra/site.js');
  const { opener, checkGame, checkApi, checkUrl, attempt } = await import('../worker/health/src/checks.js');
  const get = opener(fetch);
  const api = /\|\| '(https:\/\/[^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'js', 'infra', 'api.js'), 'utf8'))?.[1];
  if (!api) throw new Error('js/infra/api.js에서 서버 주소를 못 찾았다');
  const checks = [
    { name: '옛 주소', url: OLD_SITE, run: () => checkGame(get, OLD_SITE), must: true },
    { name: '새 주소', url: NEW_SITE, run: () => checkGame(get, NEW_SITE), must: MOVE_ON },
    { name: '서버', url: `${api}/rankings`, run: () => checkApi(get, api), must: true },
  ];
  const extra = process.env.EXTRA_URL?.trim();
  if (extra) checks.push({ name: '시험 주소', url: extra, run: () => checkUrl(get, extra), must: true });
  const results = await Promise.all(checks.map(async (c) => ({ ...c, ...(await attempt(c.run, { retry: c.must, wait: RETRY_MS })) })));
  const rows = results.map((r) => `${r.ok ? '✓' : r.must ? '✗' : '!'} ${r.name} ${r.url} · ${r.note}`);
  console.log(rows.join('\n'));
  for (const r of results.filter((x) => !x.ok)) console.log(`::${r.must ? 'error' : 'warning'} title=${r.name}::${r.url} ${r.note}${r.must ? '' : ' (옛 주소 넘기기를 켜기 전이라 경고만)'}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['| 상태 | 이름 | 주소 | 내용 |', '|---|---|---|---|', ...results.map((r) => `| ${r.ok ? '✓' : r.must ? '✗' : '!'} | ${r.name} | ${r.url} | ${r.note} |`)].join('\n') + '\n');
  if (results.some((r) => !r.ok && r.must)) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
