// @ts-check
// 상태 알림의 판정(2026-11-18 운영 준비, 2026-11-20 사용자 'Cloudflare 예약 실행'으로 나눔, 작업 글 walkoff-health-cron.md). 두 곳이 같이 쓴다:
// worker/health(Cloudflare가 5분마다 보고 메일을 보낸다)와 scripts/health.js(GitHub Actions의 두 번째 감시, 이 컴퓨터).
// 주소를 여는 get(url, method)은 부르는 쪽이 opener로 만들어 준다(시험은 가짜 fetch). 화면·저장소를 쓰지 않는다

export const TIMEOUT_MS = 20_000;

// GET·HEAD를 20초 안에, 캐시 없이 여는 get. fetch는 부르는 쪽 것(Node·Worker)
export const opener = (fetchFn) => (url, method = 'GET') => fetchFn(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'cache-control': 'no-cache', 'user-agent': 'walkoff-health' } });

// index.html에 적힌 게임 모듈 주소(script·modulepreload, 겹치는 것은 한 번)
export function gameFiles(html) {
  return [...new Set([...html.matchAll(/<script type="module" src="([^"]+)"|<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
}

// 게임: index.html이 200에 배포한 커밋 번호가 있고, 거기 적힌 게임 모듈(script·modulepreload)을 모두 받을 수 있는지(HEAD).
// mainOnly면 main.js 하나만 HEAD로 본다(Cloudflare 무료 Worker는 한 번 실행에 바깥 요청 50번까지라, 모듈 36개를 두 주소에 다 보면 넘는다)
export async function checkGame(get, site, { mainOnly = false } = {}) {
  const res = await get(site);
  if (res.status !== 200) throw new Error(`index.html ${res.status}`);
  const html = await res.text(), build = /<div id="build">([0-9a-f]{7})<\/div>/.exec(html)?.[1], files = gameFiles(html);
  if (!build) throw new Error('배포한 커밋 번호가 없다(배포 단계가 index.html을 못 바꿨다)');
  const main = files.filter((f) => f.endsWith('/main.js'));
  if (!main.length) throw new Error('게임 모듈(main.js)이 index.html에 없다');
  const want = mainOnly ? main : files;
  const bad = (await Promise.all(want.map(async (f) => [f, (await get(new URL(f, site).href, 'HEAD')).status]))).filter(([, s]) => s !== 200);
  if (bad.length) throw new Error(`모듈을 못 받는다: ${bad.map(([f, s]) => `${f} ${s}`).join(', ')}`);
  return `판 ${build}, 모듈 ${want.length}개`;
}

// 서버: /rankings가 200에 순위 모양(이번 주 week, players 목록)인지
export async function checkApi(get, api) {
  const res = await get(`${api}/rankings`);
  if (res.status !== 200) throw new Error(`/rankings ${res.status}`);
  const data = await res.json();
  if (typeof data.week !== 'string' || !Array.isArray(data.players)) throw new Error('/rankings 답의 모양이 다르다');
  return `이번 주 ${data.week}`;
}

// 손으로 넣은 주소(health.js EXTRA_URL, 실패 메일 시험용)가 200인지
export async function checkUrl(get, url) {
  if (!/^https:\/\//.test(url)) throw new Error('https 주소만 본다');
  const res = await get(url);
  if (res.status !== 200) throw new Error(`${res.status}`);
  return '200';
}

// 실패 까닭 한 줄: 시간 초과는 몇 초, 망 오류는 코드(ENOTFOUND 등), 나머지는 글
export const why = (e) => (e?.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000}초 안에 답이 없다` : e?.cause?.code ?? e?.message ?? String(e));

// 한 번 실패하면 wait 뒤 한 번 더 본다(망이 잠깐 끊긴 것으로 알림이 가지 않게). retry가 거짓이면 바로 끝낸다(health.js의 경고만 남기는 주소)
export async function attempt(run, { wait, retry = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  try { return { ok: true, note: await run() }; } catch (first) {
    if (!retry) return { ok: false, note: why(first) };
    await sleep(wait);
    try { return { ok: true, note: `${await run()} (한 번 더 봐서 됨: ${why(first)})` }; } catch (e) { return { ok: false, note: why(e) }; }
  }
}
