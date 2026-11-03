// @ts-check
// 골든 기록(2026-11-03 코드 나누기의 안전장치): 정해진 판과 화면을 시간·무작위를 고정해 똑같이 돌리며 줄마다 기록한다.
// 나누기 단계마다 다시 돌려 한 줄이라도 다르면 멈춘다. 기록: 10장면마다 판 상태 요약과 화면 해시, 사건(소리·진동·통계),
// 서버 요청(방법·경로·본문), 저장소 쓰기. 이 컴퓨터에서 같은 브라우저로 견준다(화면 해시는 컴퓨터마다 다를 수 있다).
// 사용: node scripts/golden.js <저장 폴더> [포트 4173]   그다음  diff -r <앞 폴더> <저장 폴더>
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const [outDir, port = '4173'] = process.argv.slice(2);
if (!outDir) { console.error('사용: node scripts/golden.js <저장 폴더> [포트]'); process.exit(1); }
const API = 'http://127.0.0.1:8787';   // ?api=로 바꾼 서버(가짜). 이 주소면 통계 신호도 보낸다
const PAGE = `http://127.0.0.1:${port}/index.html`;
const SWINGS = [0, -30, 25, -55, null, 70, -15, null, 40, -80];   // 공마다 휘두르는 때(ms, null은 그냥 보낸다)

// 브라우저 안: 시간·무작위 고정, 바깥으로 나가는 것(소리·진동·통계·요청·저장소) 기록
function setup({ store }) {
  let now = 1000; const base = new Date('2026-11-03T12:00:00+09:00').getTime();
  performance.now = () => now;
  const RealDate = Date;
  // @ts-ignore
  window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [base + now])); } static now() { return base + now; } };
  let seed = 20261103; Math.random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  let uuid = 0;   // 기기 번호·랭킹 ID·로그인 확인값도 정해진 값으로
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
  crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; };
  // 게임이 window.walkoff를 만드는 순간 멈춘다(그 전에 실제 시간으로 한 장면이라도 돌면 기록이 달라진다)
  let w; Object.defineProperty(window, 'walkoff', { configurable: true, get: () => w, set: (v) => { v.paused = true; w = v; } });
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  const log = []; let frame = 0;
  Object.assign(window, { __log: log, __advance: (ms) => { now += ms; }, __now: () => now, __setFrame: (f) => { frame = f; } });
  const put = (kind, data) => log.push({ f: frame, kind, ...data });
  navigator.vibrate = (p) => { put('진동', { p }); return true; };
  navigator.sendBeacon = (url, body) => { put('통계', { url: String(url).replace(/^https?:\/\/[^/]+/, ''), body: String(body) }); return true; };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opt = {}) => { const u = String(url); if (!u.endsWith('.mp3')) put('요청', { method: opt.method ?? 'GET', url: u.replace(/^https?:\/\/[^/]+/, ''), body: opt.body ?? null, auth: !!opt.headers?.authorization }); return realFetch(url, opt); };
  const setItem = Storage.prototype.setItem, removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { put('저장', { k, v }); return setItem.call(this, k, v); };
  Storage.prototype.removeItem = function (k) { put('지움', { k }); return removeItem.call(this, k); };
  localStorage.clear();
  for (const [k, v] of Object.entries(store)) setItem.call(localStorage, k, v);
}

// 가짜 랭킹 서버(같은 요청에는 늘 같은 답)
function mock(page) {
  let seeds = 0;
  return page.route(`${API}/**`, async (route) => {
    const req = route.request(), u = new URL(req.url()), auth = !!req.headers().authorization;
    const json = (status, body) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return json(204, {});
    if (u.pathname === '/me') return auth ? json(200, { nick: '골든', team: 'lg', coins: 1234, owned: ['bat-fire', 'helmet-tiger'], look: { bat: 'bat-fire', helmet: 'helmet-tiger' } }) : json(401, { error: 'login' });
    if (u.pathname === '/seeds') return auth ? json(200, { seed: 4242 + seeds, token: `tok-${seeds++}` }) : json(401, {});
    if (u.pathname === '/scores') return json(200, { ok: true, earned: 12, newBest: true, me: { rank: 3, best: 4200, days: 2, team: 'lg' }, team: { rank: 2 } });
    if (u.pathname === '/rankings') return json(200, { week: '2026-11-02', nextWeek: '2026-11-09', count: 3, me: null, myTeam: null, lastWeek: { player: null, team: null },
      players: [{ rank: 1, nick: '명은', team: 'lotte', best: 12100, days: 3, me: false, look: { bat: 'bat-fire', helmet: 'helmet-tiger', number: 'number-on', no: 7 } }, { rank: 2, nick: '민성', team: 'lg', best: 9100, days: 2, me: false, look: null }],
      teams: [{ rank: 1, team: 'lotte', total: 12100, players: 1 }, { rank: 2, team: 'lg', total: 9100, players: 1 }] });
    if (u.pathname.startsWith('/shop/')) return json(200, { coins: 1000, owned: ['bat-fire', 'helmet-tiger', 'bat-maple'], look: { bat: 'bat-maple' } });
    return json(200, {});
  });
}

// 브라우저 안: n장면을 1/30초씩 돌린다. 10장면마다 상태 요약과 화면 해시를 남기고, 판이면 SWINGS대로 휘두르고 결과 뒤에는 다음 공으로 넘긴다
function drive({ n, play, swings }) {
  const w = /** @type {any} */ (window).walkoff, g = w.game, W = /** @type {any} */ (window);
  for (let k = 0; k < n; k++) {
    const f = (W.__frameNo = (W.__frameNo ?? 0) + 1);
    W.__setFrame(f);
    if (play) {
      const p = g.seq?.[g.i], dt = swings[g.i % swings.length];
      if (g.state === 'pitch' && g.swingAt == null && dt != null && w.ballTime() + 1 / 30 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000);
      if (g.state === 'result' && g.resultT > Math.max(0.35, g.revealAt) + 1.2 && (!w.boardMoment() || g.resultT > w.boardMoment().t1 + 0.4)) w.tap(W.__now());
    }
    W.__advance(1000 / 30);
    w.update(1 / 30);
    w.render(W.__now() / 1000);
    if (f % 10 === 0) {
      const c = document.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261; for (let i = 0; i < d.length; i += 28) { h ^= d[i]; h = Math.imul(h, 16777619); }
      const o = g.outcome, s = g.scn;
      W.__log.push({ f, kind: '장면', state: g.state, mode: g.mode, i: g.i, score: g.score, left: g.left, rt: Math.round((g.resultT ?? 0) * 100) / 100,
        out: o ? [o.kind, o.name, o.points, o.perfect ?? null] : null, scn: s ? [s.away, s.home, s.outs, s.bases.map(Number).join(''), s.end ?? null] : null,
        cam: [w.cam.x, w.cam.y, w.cam.z].map((v) => Math.round(v * 100) / 100), buttons: w.ui.buttons.map((b) => b.label).join('|'), hash: (h >>> 0).toString(16) });
    }
    if (play && g.state === 'over' && (W.__overAt ??= f) + 30 <= f) break;
  }
}

const SCENES = [
  { name: '처음-온-사람', store: {}, steps: async (p, run) => {
    await run(20);
    await p.evaluate(() => { const w = /** @type {any} */ (window).walkoff; w.ui.buttons.find((b) => /두산/.test(b.label)).onTap(); });
    await run(10);
    await p.evaluate(() => { const i = /** @type {HTMLInputElement} */ (document.querySelector('input')); if (i) { i.value = '골든'; i.dispatchEvent(new Event('input')); } });
    await p.evaluate(() => { const w = /** @type {any} */ (window).walkoff; (w.ui.buttons.find((b) => b.label === '나중에 로그인하기') ?? w.ui.buttons.find((b) => /시작|확인|저장/.test(b.label)))?.onTap(); });
    await run(30);
  } },
  { name: '10구-도전-로그인-안함', query: '&seed=42', store: { 'walkoff.team': '"doosan"', 'walkoff.nick': '"골든"', 'walkoff.loginLater': '"2026-11-03"' }, steps: async (p, run) => {
    await p.evaluate(() => /** @type {any} */ (window).walkoff.startGame('challenge'));
    await run(6000, true);
  } },
  { name: '10구-도전-로그인', store: { 'walkoff.team': '"lg"', 'walkoff.nick': '"골든"', 'walkoff.session': '"golden-session"', 'walkoff.playerId': '"p-golden"' }, steps: async (p, run) => {
    await run(10);
    await p.evaluate(() => /** @type {any} */ (window).walkoff.startGame('challenge'));
    await run(6000, true);
  } },
  { name: '끝내기-상황', query: '&seed=10', store: { 'walkoff.team': '"kia"', 'walkoff.nick': '"골든"' }, steps: async (p, run) => {
    await p.evaluate(() => /** @type {any} */ (window).walkoff.startGame('scenario'));
    await run(4000, true);
  } },
  { name: '연습', query: '&seed=7', store: { 'walkoff.team': '"ssg"', 'walkoff.nick': '"골든"', 'walkoff.bats': '"L"' }, steps: async (p, run) => {
    await p.evaluate(() => /** @type {any} */ (window).walkoff.startGame('practice'));
    await run(900, true);
    for (const code of ['Digit3', 'KeyS', 'KeyL']) await p.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })), code);
    await run(900, true);
  } },
  { name: '타이밍-보정', store: { 'walkoff.team': '"nc"', 'walkoff.nick': '"골든"' }, steps: async (p, run) => {
    await p.evaluate(() => /** @type {any} */ (window).walkoff.startCalib());
    for (let k = 0; k < 9; k++) {   // 박자마다 조금씩 늦게 누른다
      await run(15);
      await p.evaluate((k) => { const W = /** @type {any} */ (window); W.walkoff.tap(W.__now() + 20 + 7 * k); }, k);
    }
    await run(60);
  } },
  { name: '화면들', store: { 'walkoff.team': '"hanwha"', 'walkoff.nick': '"골든"', 'walkoff.session': '"golden-session"', 'walkoff.playerId': '"p-golden"' }, steps: async (p, run) => {
    const tap = (label) => p.evaluate((l) => { const w = /** @type {any} */ (window).walkoff, b = w.ui.buttons.find((x) => x.label === l || (l.startsWith('/') && new RegExp(l.slice(1)).test(x.label))); if (b) b.onTap(); return !!b; }, label);
    await run(20);
    for (const step of ['메뉴', '/기록', null, '메뉴', '/상점', '/헬멧', '/신발', '/공 꼬리', '/내 물건', null, '메뉴', '/이번 주 랭킹', '랭킹 줄 1', '‹ 랭킹으로', '팀', null, '메뉴', '/내 계정', null]) {
      if (step == null) await p.evaluate(() => /** @type {any} */ (window).walkoff.goTitle());
      else await tap(step);
      await run(20);
    }
  } },
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const [vp, opts] of [['pc', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }], ['mo', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
    for (const sc of SCENES) {
      const ctx = await browser.newContext(opts), page = await ctx.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await mock(page);
      await page.addInitScript(setup, { store: sc.store });
      await page.goto(`${PAGE}?api=${encodeURIComponent(API)}${sc.query ?? ''}`);
      await page.waitForFunction(() => !!(/** @type {any} */ (window).walkoff));
      await page.evaluate(() => { /** @type {any} */ (window).walkoff.paused = true; });
      await page.waitForTimeout(300);   // 열 때 보낸 요청(계정·시드)의 답을 받는다
      const run = async (n, play = false) => { for (let k = 0; k < n; k += 30) { await page.evaluate(drive, { n: Math.min(30, n - k), play, swings: SWINGS }); if (play && await page.evaluate(() => /** @type {any} */ (window).__overAt != null && /** @type {any} */ (window).__frameNo >= /** @type {any} */ (window).__overAt + 30)) break; await page.waitForTimeout(5); } };
      await sc.steps(page, run);
      const log = await page.evaluate(() => /** @type {any} */ (window).__log);
      if (errors.length) log.push({ kind: '오류', errors });
      fs.writeFileSync(path.join(outDir, `${sc.name}-${vp}.jsonl`), log.map((l) => JSON.stringify(l)).join('\n') + '\n');
      console.log(`${vp} ${sc.name}: ${log.length}줄${errors.length ? ` · 오류 ${errors.length}` : ''}`);
      await ctx.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
