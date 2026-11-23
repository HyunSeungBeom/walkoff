// @ts-check
// 옛 주소(github.io)에서 새 주소(walkoff.kr)로 이 기기 기록을 넘기는 일(2026-11-17 주소 옮기기, js/infra/move.js·site.js)을 실제 브라우저로 본다.
// 두 주소는 Playwright가 가로채 이 컴퓨터의 게임 파일로 답한다. 그래서 출처가 달라 저장소가 따로인 것과 주소를 옮길 때 넘어온 곳(referrer)이 실제와 같다.
// 넘기기 스위치(site.js MOVE_ON)는 켠 파일·끈 파일로 답해서 켠 판·끈 판을 모두 본다(레포의 site.js에서 그 한 줄만 바꾼다. 2026-11-20부터 레포는 켠 판)
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const LOCAL = `http://127.0.0.1:${process.env.WALKOFF_PORT || 4173}/`;   // playwright.config.js의 webServer(scripts/serve.js, @min이면 줄인 js)
const OLD = 'https://hyunseungbeom.github.io/walkoff/', NEW = 'https://walkoff.kr/';
const API = 'https://walkoff-api.walkoff-api.workers.dev';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' };
const SESSION = 'moved-session', ACCOUNT_ID = 'p-account-0001';
const EMPTY_RANKING = { week: '2026-11-16', nextWeek: '2026-11-23', players: [], teams: [], count: 0, me: null, myTeam: null, lastWeek: { player: null, team: null } };
// 옛 주소에 쌓인 이 기기 기록(게임이 쓰는 모양 그대로). loginNonce는 그 주소에서만 쓰는 값이라 넘기지 않는다
const OLD_VALUES = {
  team: 'lg', nick: '명은', bats: 'L', offset: '-24', newsSeen: '2026-11-17a', session: SESSION, playerId: ACCOUNT_ID, device: 'd-device-0001',
  'played.2026-11-15': '1', 'played.2026-11-16': '1', duels: '[{"seed":42,"tries":2,"first":3100}]', loginNonce: 'n-old-nonce',
};
const site = () => import(pathToFileURL(path.join(ROOT, 'js', 'infra', 'site.js')).href);
const duel = () => import(pathToFileURL(path.join(ROOT, 'js', 'game', 'duel.js')).href);

test.skip(({ isMobile }) => isMobile, '주소와 저장소는 화면 크기와 상관없어서 PC에서만 본다');

// 옛·새 주소를 이 컴퓨터의 게임 파일로 답한다. site.js는 on이면 넘기기를 켠 파일, 아니면 끈 파일로 답한다. blank.html은 게임 없이 그 주소의 저장소를 읽을 빈 페이지
async function serveSites(context, { on }) {
  const siteJs = fs.readFileSync(path.join(ROOT, 'js', 'infra', 'site.js'), 'utf8'), SWITCH = /^export const MOVE_ON = (?:true|false);$/m;
  expect(siteJs, 'site.js의 넘기기 스위치 줄').toMatch(SWITCH);
  const served = siteJs.replace(SWITCH, `export const MOVE_ON = ${on};`);
  for (const base of [OLD, NEW]) {
    await context.route(`${base}**`, async (route) => {
      const rel = new URL(route.request().url()).pathname.slice(new URL(base).pathname.length) || 'index.html';
      if (rel === 'blank.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' });
      if (/^js(-[0-9a-f]{7})?\/infra\/site\.js$/.test(rel)) return route.fulfill({ contentType: 'text/javascript', body: served });
      return route.fulfill({ response: await route.fetch({ url: LOCAL + rel }) });
    });
  }
}

// 랭킹 서버를 가로채 가짜로 답한다. 받은 요청(경로·로그인 표·보낸 출처)을 돌려주는 배열에 쌓는다
async function mockApi(context) {
  const calls = [];
  await context.route(`${API}/**`, async (route) => {
    const req = route.request(), url = new URL(req.url()), auth = req.headers().authorization ?? null;
    const reply = (body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    calls.push({ path: url.pathname, method: req.method(), auth, origin: await req.headerValue('origin') });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (['/me', '/seeds'].includes(url.pathname) && auth !== `Bearer ${SESSION}`) return reply({ ok: false, error: 'login_required' }, 401);
    if (url.pathname === '/me' && req.method() === 'GET') {
      return reply({ ok: true, playerId: ACCOUNT_ID, nick: '명은', team: 'lg', coins: 120, owned: [], look: {}, titles: [], counts: {}, title: null, games: 3, giftsLeft: 3, gifts: [] });
    }
    if (url.pathname === '/seeds') return reply({ ok: true, token: '00000000-0000-4000-8000-000000000001', seed: 42 });
    if (url.pathname === '/rankings') return reply(EMPTY_RANKING);
    return reply({ ok: true });
  });
  return calls;
}

// 그 출처의 저장소에 처음 한 번만 값을 넣는다(게임보다 먼저 돈다). 표시는 walkoff. 밖에 둬서 넘기는 값에 섞이지 않는다
async function seed(context, origin, values) {
  await context.addInitScript(({ origin, values }) => {
    if (location.origin !== origin || localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    for (const [k, v] of Object.entries(values)) localStorage.setItem(`walkoff.${k}`, v);
  }, { origin, values });
}

const stored = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('walkoff.')).map((k) => [k.slice(8), localStorage.getItem(k)])));
// 그 주소의 저장소를 게임 없이 읽는다
async function storedAt(context, base) {
  const p = await context.newPage();
  await p.goto(`${base}blank.html`);
  const values = await stored(p);
  await p.close();
  return values;
}
// 이 탭이 거쳐 간 주소(# 조각 포함)를 차례로 남긴다
function trail(page) {
  const urls = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url()); });
  return urls;
}
// 통계를 켜고(테스트 브라우저는 안 보내서 사람이 연 것처럼) 보내는 묶음을 window.__beacons에 모은다. at은 두 주소 페이지의 지금(한국 시간):
// 첫 주 숫자는 2026-11-30부터 세서(js/infra/stats.js FUNNEL_FROM) 실제 날짜에 따라 결과가 바뀌지 않게 정한다(시계는 그대로 흐른다). 돌려주는 값은 그날
async function catchBeacons(context, at = '2026-11-30T12:00:00+09:00') {
  await context.addInitScript((shift) => {
    const Real = Date;
    window.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [Real.now() + shift])); } static now() { return Real.now() + shift; } };
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.__beacons = [];
    navigator.sendBeacon = (url, body) => { window.__beacons.push({ url: String(url), body: JSON.parse(String(body)) }); return true; };
  }, Date.parse(at) - Date.now());
  return at.slice(0, 10);
}
// 주소를 열고, 옮겨 간 주소(to)에서 게임이 뜰 때까지 기다린다(옛 주소는 열자마자 새 주소로 간다)
async function openAt(page, url, to = url) {
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForURL(to);
  await page.waitForFunction(() => !!window.walkoff);
}

test('옛 주소에서 열면 이 기기 기록(로그인 포함)을 새 주소로 한 번 넘기고(옛 주소의 로그인 표는 지운다), 물음표 뒤는 그대로 들고 간다. 두 번째부터는 기록 없이 바로 간다 @min', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serveSites(context, { on: true });
  const calls = await mockApi(context);
  await seed(context, 'https://hyunseungbeom.github.io', OLD_VALUES);
  const urls = trail(page);
  await openAt(page, `${OLD}index.html?seed=7&fps=1`, `${NEW}?seed=7&fps=1`);   // 물음표 뒤는 그대로, # 조각은 받자마자 지웠다
  expect(urls.filter((u) => u.startsWith(`${NEW}?seed=7&fps=1#move=`))).toHaveLength(1);   // 기록은 # 조각으로 왔다(서버로 가지 않는다)
  // 옛 주소에서는 게임을 띄우지 않는다: 서버에 아무것도 보내지 않았고, 멈춘 까닭만 남았다
  expect(calls.filter((c) => c.origin !== 'https://walkoff.kr')).toEqual([]);
  expect(errors.length).toBeGreaterThan(0);
  expect(new Set(errors)).toEqual(new Set(['walkoff는 새 주소로 옮겼어요']));

  const { loginNonce, ...moved } = OLD_VALUES;
  expect(await stored(page)).toEqual(expect.objectContaining(moved));
  expect(Object.keys(await stored(page))).not.toContain('loginNonce');
  expect(Object.keys(await stored(page))).not.toContain('moved');
  // 게임이 처음 읽을 때 이미 들어 있었다: 타석·팀·닉네임·타이밍 보정·연속 기록, 다시 로그인하지 않아도 계정이 이어진다
  expect(await page.evaluate(() => [walkoff.settings.bats, walkoff.settings.team, walkoff.settings.nick, walkoff.settings.offset, walkoff.auth.token])).toEqual(['L', 'lg', '명은', -24, SESSION]);
  expect(await page.evaluate(() => walkoff.playStreak('2026-11-17'))).toBe(2);
  await expect.poll(() => calls.some((c) => c.path === '/me' && c.auth === `Bearer ${SESSION}`)).toBe(true);
  // 옛 주소에는 로그인 표만 지우고(옛 출처는 블로그와 같이 쓴다) 나머지 기록과 넘긴 표시를 남긴다
  const { session, ...kept } = OLD_VALUES, old = await storedAt(context, OLD);
  expect(old).toEqual(expect.objectContaining(kept));
  expect(old.session).toBeUndefined();
  expect(Number(old.moved)).toBeGreaterThan(0);

  // 두 번째는 기록 없이 바로 간다: 새 주소에서 바꾼 팀, 로그아웃해서 지운 표가 옛 값으로 돌아오지 않는다. 이미 보낸 도전장 링크도 새 주소에서 열린다
  await page.evaluate(() => { localStorage.setItem('walkoff.team', 'doosan'); localStorage.removeItem('walkoff.session'); });
  const { duelCode } = await duel(), dare = { seed: 42, score: 0, lights: 'RRRRRRRRRR', team: 'lg', bats: 'R', n: 1, nick: '테스트' }, code = duelCode(dare);
  const before = urls.length;
  await openAt(page, `${OLD}?vs=${code}`, `${NEW}?vs=${code}`);
  expect(urls.slice(before).filter((u) => u.includes('#'))).toEqual([]);
  const after = await stored(page);
  expect([after.team, after.session]).toEqual(['doosan', undefined]);
  expect(await page.evaluate(() => walkoff.game.duel)).toEqual(expect.objectContaining({ seed: 42, nick: '테스트' }));
});

// 로그인하면 계정의 팀·닉네임으로 맞추므로(main.js syncAccount) 여기서는 로그인 안 한 기록으로 넘기기만 본다
test('새 주소에 이미 있는 값은 덮지 않고, 없는 값만 채운다', async ({ page, context }) => {
  const { session, playerId, ...values } = OLD_VALUES;
  await serveSites(context, { on: true });
  await mockApi(context);
  await seed(context, 'https://hyunseungbeom.github.io', values);
  await seed(context, 'https://walkoff.kr', { team: 'doosan', nick: '민성', 'played.2026-11-17': '1', offset: '30' });   // 새 주소를 먼저 열어 쳐 본 사람
  await openAt(page, `${OLD}?seed=7`, `${NEW}?seed=7`);
  const got = await stored(page);
  expect([got.team, got.nick, got.offset, got['played.2026-11-17']]).toEqual(['doosan', '민성', '30', '1']);   // 그대로
  expect([got.bats, got['played.2026-11-15'], got['played.2026-11-16'], got.newsSeen, got.device, got.duels]).toEqual(['L', '1', '1', '2026-11-17a', values.device, values.duels]);   // 채움
  expect(await page.evaluate(() => [walkoff.settings.team, walkoff.settings.offset, walkoff.playStreak('2026-11-17')])).toEqual(['doosan', 30, 3]);   // 두 주소에서 친 날이 이어진다
});

// 통계 보강(B, 새 기기 수로 홍보 효과를 본다)이 옮겨 온 사람을 새 기기로 세지 않게(2026-11-17 사용자). 테스트 브라우저는 통계를 안 보내서 사람이 연 것처럼 켜고 보내는 묶음을 모은다
test('통계용 기기 번호도 같이 넘어가 옮겨 온 사람이 새 기기로 잡히지 않는다: 새 주소의 통계 묶음이 옛 번호로 가고, 옛 주소에서 못 보낸 묶음과 옮긴 기기 수(move)도 그 번호다', async ({ page, context }) => {
  const day = await catchBeacons(context);
  await serveSites(context, { on: true });
  await mockApi(context);
  const { session, playerId, ...values } = OLD_VALUES;   // 로그인 없이 본다
  await seed(context, 'https://hyunseungbeom.github.io', { ...values, statsQueue: JSON.stringify({ day, counts: { challenge: { starts: 2, ends: 1 } }, n: 3 }) });
  await openAt(page, `${OLD}?seed=7`, `${NEW}?seed=7`);
  expect(await page.evaluate(() => walkoff.store.get('device', null))).toBe(values.device);
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));   // 화면을 떠날 때 모은 묶음을 보낸다
  const beacons = await page.evaluate(() => window.__beacons);
  expect(beacons.map((b) => [b.url, b.body.device, b.body.day, b.body.counts])).toEqual([
    [`${API}/events`, values.device, day, { challenge: { starts: 2, ends: 1 } }],   // 옛 주소에서 못 보낸 묶음(열자마자 보낸다)
    [`${API}/events`, values.device, day, { move: { starts: 1, ends: 0 } }],
  ]);
  // 첫 주 숫자(2026-11-19): 옮겨 온 기기는 들어온 길 move로 세고 처음 온 사람(그냥 링크·도전장 주소)으로 세지 않는다. 옛 주소에서 못 보낸 묶음에는 싣지 않는다
  expect(beacons.map((b) => b.body.first)).toEqual([undefined, { path: 'move', steps: 1 }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('walkoff.arrival')))).toEqual({ day, path: 'move', steps: 1 });
});

// 첫 주 숫자(2026-11-23): 들어온 길의 '옛 주소에서 옮겨 옴'은 새 주소에 처음 온 기기만이다. 새 주소에 와 본 기기(이 주소의 기기 번호가 있음)가
// 나중에 옛 주소의 기록을 받아 와도 처음 온 기기로 다시 세지 않는다(옮긴 기기 수 move는 그대로 센다)
test('새 주소에 와 본 기기가 옛 주소의 기록을 받아 오면 옮긴 기기 수는 세지만 처음 온 기기(들어온 길)로는 세지 않고, 이 주소의 기기 번호를 그대로 쓴다', async ({ page, context }) => {
  const day = await catchBeacons(context);
  await serveSites(context, { on: true });
  await mockApi(context);
  const { session, playerId, ...values } = OLD_VALUES;
  await seed(context, 'https://walkoff.kr', { device: 'd-here-0001' });   // 전에 새 주소로 바로 와 본 기기
  await seed(context, 'https://hyunseungbeom.github.io', values);
  await openAt(page, `${OLD}?seed=7`, `${NEW}?seed=7`);
  expect(await page.evaluate(() => [walkoff.store.get('device', null), walkoff.settings.team])).toEqual(['d-here-0001', 'lg']);   // 번호는 그대로, 없던 값(팀)은 받았다
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  const beacons = await page.evaluate(() => window.__beacons);
  expect(beacons.map((b) => [b.body.device, b.body.day, b.body.counts, b.body.first])).toEqual([['d-here-0001', day, { move: { starts: 1, ends: 0 } }, undefined]]);
  expect(await page.evaluate(() => localStorage.getItem('walkoff.arrival'))).toBe(null);
});

// 2026-11-18 보안 검토: 표만 빼면 남이 심은 닉네임·팀이 로그인할 때 계정에 올라가고(syncAccount → PUT /me), 타이밍 보정은 판정을 흔든다
test('옛 주소에서 넘어올 때만 받는다: 남이 만든 #move= 주소로는 아무 값도 넣지 않고 옮긴 기기로도 세지 않으며, # 조각은 지운다', async ({ page, context }) => {
  await catchBeacons(context);   // 통계를 켜서 옮긴 기기 수(move)가 안 가는 것까지 본다
  const { packMove } = await site();
  await serveSites(context, { on: true });
  const calls = await mockApi(context);
  const planted = { session: SESSION, team: 'kia', nick: '남', offset: '250', profileDirty: '1', device: 'd-planted' };
  await openAt(page, `${NEW}?seed=3#move=${packMove(planted)}`, `${NEW}?seed=3`);   // 다른 곳(카톡 링크)에서 바로 연 주소
  const got = await stored(page);
  for (const [k, v] of Object.entries(planted)) expect(got[k], k).not.toBe(v);
  expect(await page.evaluate(() => [walkoff.auth.token, walkoff.settings.offset])).toEqual([null, 0]);
  expect(calls.filter((c) => c.auth)).toEqual([]);
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  expect((await page.evaluate(() => window.__beacons)).filter((b) => b.body.counts?.move)).toEqual([]);
  expect((await page.evaluate(() => window.__beacons)).map((b) => b.body.first?.path)).toEqual(['link']);   // 받은 값이 없으니 처음 온 기기(옮겨 온 기기가 아니다)
  // 망가진 조각도 지우고 아무것도 넣지 않는다
  await openAt(page, `${NEW}?seed=4#move=!!!`, `${NEW}?seed=4`);
});

test('넘기기를 켜기 전에는 옛 주소에서도 게임이 그대로 뜨고, 공유 글·카드에는 지금 열린 주소가 실린다', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serveSites(context, { on: false });
  await mockApi(context);
  await seed(context, 'https://hyunseungbeom.github.io', { team: 'lg', nick: '명은' });
  const shared = () => page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, seen = [];
    proto.fillText = function (str, ...rest) { seen.push(String(str)); return fill.call(this, str, ...rest); };
    try { walkoff.drawShareCard({ score: 2350, hr: 1, hits: 3, balls: 2, far: 118, lights: 'GRYGRRYGRRRR', bats: 'R' }, 'challenge'); } finally { proto.fillText = fill; }
    return { text: walkoff.shareText({ bats: 'R', lights: 'GRY', score: 3200, hr: 2, far: 131 }).split('\n').at(-1), card: seen.at(-1) };
  });
  await openAt(page, `${OLD}?seed=42`);
  expect(await shared()).toEqual({ text: OLD, card: 'walkoff · hyunseungbeom.github.io/walkoff' });
  expect(Object.keys(await stored(page))).not.toContain('moved');
  await openAt(page, `${NEW}?seed=42`);
  expect(await shared()).toEqual({ text: NEW, card: 'walkoff · walkoff.kr' });
  expect(errors).toEqual([]);
});
