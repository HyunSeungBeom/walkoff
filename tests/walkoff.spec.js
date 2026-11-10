// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const HOST = `127.0.0.1:${process.env.WALKOFF_PORT || 4173}`;
const PAGE = `http://${HOST}/index.html`;   // playwright.config.js의 webServer(scripts/serve.js)
const API = 'https://walkoff-api.walkoff-api.workers.dev';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' };
const SESSION = 'test-session';         // 가짜 서버가 받아 주는 로그인 표
const ACCOUNT_ID = 'p-account-0001';    // 가짜 서버의 계정 ID
const EMPTY_RANKING = { week: '2026-10-26', nextWeek: '2026-11-02', players: [], teams: [], count: 0, me: null, myTeam: null, lastWeek: { player: null, team: null } };
const SAMPLE_RANKING = {
  ...EMPTY_RANKING,
  players: [
    { rank: 1, nick: '명은', team: 'lotte', best: 12100, days: 3, me: false },
    { rank: 2, nick: '민성', team: 'lg', best: 9100, days: 2, me: true },
  ],
  teams: [{ rank: 1, team: 'lotte', total: 12100, players: 1 }, { rank: 2, team: 'lg', total: 9100, players: 1 }],
  count: 2, me: { rank: 2, best: 9100, days: 2, team: 'lg' }, myTeam: { rank: 2, total: 9100, team: 'lg' },
  lastWeek: { player: { rank: 1, nick: '명은', team: 'lotte', best: 11800, days: 7, me: false }, team: { rank: 1, team: 'lotte', total: 20000, players: 1 } },
};
// 이번 주 랭킹 답을 실제 서버의 순위 계산(worker/src/rules.js rankSummary)으로 만든다. rows: [닉네임, 팀, 점수, 대표 칭호?], mine: 내 닉네임.
// 실제 /rankings(worker/src/index.js)처럼 사람은 상위 50명만 오고 total·look·title이 붙으며, 팀 합계·인원은 50위 밖까지 모두로 센다
async function rankingOf(rows, mine = null) {
  const { rankSummary } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
  const list = rows.map(([nick, team, best], i) => ({ id: `p-${i}`, best, team, days: 1 + (i % 3), last: '2026-10-28', nick }));
  const me = rows.findIndex((r) => r[0] === mine), { ids, ...cur } = rankSummary(list, me >= 0 ? `p-${me}` : null, { withIds: true });
  const titles = new Map(rows.map((r, i) => [`p-${i}`, r[3] ?? null]));
  return { ...EMPTY_RANKING, ...cur, players: cur.players.map((p, i) => ({ ...p, total: p.best, look: null, title: titles.get(ids[i]) })), me: cur.me && { ...cur.me, total: cur.me.best } };
}

// 테스트가 실제 랭킹 서버에 닿지 않도록 서버 주소를 가로채 가짜로 답한다. 받은 요청은 돌려주는 배열에 쌓인다.
// account: 로그인한 계정에 이미 있는 팀·닉네임(다른 기기에서 쓰던 계정을 흉내 낸다).
// scoreReply: 'best'(보낸 점수가 이번 주 최고 기록) | 'lower'(이번 주에 더 높은 기록이 있다). 테스트 중에 바꿀 수 있게 요청 때 읽는다.
// seed: /seeds가 내주는 10구 도전 시드(기본 42). 표는 요청마다 새로 만들어 돌려주는 배열의 tickets에 쌓는다(받은 시각 at).
// seedFail: /seeds가 서버 오류로 답한다. seedExpired: /seeds만 로그인이 풀린 것처럼 401로 답한다(계정 확인 /me는 된다).
// seedHold: /seeds 답을 테스트가 calls.releaseSeeds()로 풀 때까지 잡아 둔다(풀면 그 뒤 요청은 바로 답한다). scoreFail: /scores가 서버 오류로 답한다.
// /scores는 실제 서버처럼 10구 도전에 표가 없거나 모르는 표, 이미 쓴 표면 거절한다.
// 상점은 실제 서버(worker/src/shop.js)의 가격으로 코인·산 물건·착용을 기억한다. account.coins·owned·look으로 처음 지갑을 준다.
// account.allTime: 계정의 역대 최고(다른 기기에서 친 판 포함). 실제 서버처럼 /rankings?player=와 /scores 답에 allTime으로 주고, 받은 점수로 올린다
// account.titles·counts: 계정이 받은 칭호와 쌓은 수. 실제 서버처럼 /scores가 받은 전광판·표의 공 순서·점수로 수를 쌓아(core countsOf) 닿은 칭호를
// newTitles·titles·counts로 주고, /me에도 titles·counts를 준다
async function mockApi(page, opts = {}) {
  const { rankings = EMPTY_RANKING, fail = false, account = {} } = opts;
  const { ITEMS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'shop.js')).href);
  const { replayScenario, WIN_BONUS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'scenario.js')).href);
  const { TITLE_IDS, countsOf, addCounts, titlesFor } = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'core', 'titles.js')).href);
  const { makeSequence, pitcherHand } = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'core', 'pitches.js')).href);
  const shop = { coins: account.coins ?? 0, owned: [...(account.owned ?? [])], look: { ...(account.look ?? {}) } };
  const wallet = () => ({ coins: shop.coins, owned: [...shop.owned], look: { ...shop.look } });
  const calls = [], tickets = [], heldSeeds = [], record = { allTime: account.allTime ?? null, titles: [...(account.titles ?? [])], counts: { ...(account.counts ?? {}) } };
  await page.route(`${API}/**`, (route) => {
    const req = route.request(), url = new URL(req.url()), auth = req.headers().authorization ?? null;
    const reply = (body, status = 200) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ method: req.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), auth, body: req.postData() ? JSON.parse(req.postData()) : null });
    if (url.pathname.startsWith('/auth/')) {   // 카카오로 가는 길. 실제 서버처럼 조금 있다 빈 페이지로 답하고, 돌아오는 것은 loginReturn으로 흉내 낸다
      // 0초에 요청을 끊으면 게임이 방금 저장한 확인값이 브라우저에 넘어가기 전에 페이지가 닫혀 값이 사라질 때가 있었다(CI)
      return new Promise((done) => setTimeout(done, 300)).then(() => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>kakao</title>' }));
    }
    if (fail) return reply({ ok: false, error: 'server_error' }, 500);
    if (['/seeds', '/me', '/scores', '/scenario', '/shop/buy', '/shop/equip'].includes(url.pathname) && auth !== `Bearer ${SESSION}`) return reply({ ok: false, error: 'login_required' }, 401);
    if (url.pathname === '/scenario') {   // 끝내기 상황: 실제 서버 코드(replayScenario)로 표의 시드로 판을 다시 돌려 끝·점수를 정하고 코인을 준다
      if (opts.scenarioFail) return reply({ ok: false, error: 'server_error' }, 500);
      const { token, bats, moves } = JSON.parse(req.postData() || '{}'), ticket = tickets.find((t) => t.token === token);
      if (!ticket || ticket.used) return reply({ ok: false, error: ticket ? 'seed_used' : 'bad_seed' }, 400);
      ticket.used = true;
      const g = replayScenario(ticket.seed, moves, bats);
      if (!g) return reply({ ok: false, error: 'replay_mismatch' }, 400);
      const bonus = g.end === 'win' ? WIN_BONUS[g.k] ?? 0 : 0, earned = Math.floor(g.points / 100) + bonus;
      shop.coins += earned;
      return reply({ ok: true, end: g.end, points: g.points, earned, bonus, coins: shop.coins });
    }
    if (url.pathname === '/seeds') {
      if (opts.seedFail) return reply({ ok: false, error: 'server_error' }, 500);
      if (opts.seedExpired) return reply({ ok: false, error: 'login_required' }, 401);
      const t = { token: `00000000-0000-4000-8000-${String(tickets.length + 1).padStart(12, '0')}`, seed: opts.seed ?? 42 };
      tickets.push({ ...t, at: Date.now(), used: false });
      return (opts.seedHold ? new Promise((done) => heldSeeds.push(done)) : Promise.resolve()).then(() => reply({ ok: true, ...t }));
    }
    if (url.pathname === '/me' && req.method() === 'PUT' && opts.failProfile) return reply({ ok: false, error: 'server_error' }, 500);   // 팀·닉네임 저장 실패(테스트 중에 바꿀 수 있게 요청 때 읽는다)
    if (url.pathname === '/me') return reply(req.method() === 'GET' ? { ok: true, playerId: ACCOUNT_ID, nick: account.nick ?? null, team: account.team ?? null, ...wallet(), titles: [...record.titles], counts: { ...record.counts } } : { ok: true });
    if (url.pathname === '/scores') {
      if (opts.scoreFail) return reply({ ok: false, error: 'server_error' }, 500);
      const { score, mode, token, lights } = JSON.parse(req.postData() || '{}'), lower = opts.scoreReply === 'lower';
      const ticket = tickets.find((t) => t.token === token);
      if (mode === 'challenge' && !token) return reply({ ok: false, error: 'seed_required' }, 400);
      if (mode === 'challenge' && (!ticket || ticket.used)) return reply({ ok: false, error: ticket ? 'seed_used' : 'bad_seed' }, 400);
      if (ticket) ticket.used = true;
      const earned = opts.earned ?? Math.floor(score / 100), best = lower ? score + 1000 : score;
      shop.coins += earned;
      record.allTime = Math.max(record.allTime ?? 0, best);
      const lefty = !!ticket && pitcherHand(ticket.seed) === 'L', seq = ticket ? makeSequence(ticket.seed, lefty) : [];
      record.counts = addCounts(record.counts, countsOf(lights, seq, lefty, score));
      const newTitles = titlesFor(record.counts).filter((id) => !record.titles.includes(id));
      record.titles = TITLE_IDS.filter((id) => record.titles.includes(id) || newTitles.includes(id));
      return reply({ ok: true, accepted: !lower, week: '2026-10-26', me: { rank: 3, best, days: 1, team: 'lg' }, myTeam: { rank: 2, total: 9000, team: 'lg' }, count: 5, allTime: record.allTime, coins: shop.coins, earned, newTitles, titles: [...record.titles], counts: { ...record.counts } });
    }
    if (url.pathname === '/shop/buy') {
      const it = ITEMS.find((i) => i.id === JSON.parse(req.postData() || '{}').item);
      if (!it || it.price === 0) return reply({ ok: false, error: it ? 'free_item' : 'unknown_item' }, 400);
      if (shop.owned.includes(it.id)) return reply({ ok: false, error: 'already_owned', ...wallet() }, 400);
      if (shop.coins < it.price) return reply({ ok: false, error: 'not_enough_coins', ...wallet() }, 400);
      shop.coins -= it.price; shop.owned.push(it.id);
      return reply({ ok: true, ...wallet() });
    }
    if (url.pathname === '/shop/equip') {
      const b = JSON.parse(req.postData() || '{}'), it = ITEMS.find((i) => i.id === b.item);
      if (!it || (it.price > 0 && !shop.owned.includes(it.id))) return reply({ ok: false, error: 'not_owned' }, 400);
      if (it.id === 'number-on' && !(Number.isInteger(b.number) && b.number >= 0 && b.number <= 99)) return reply({ ok: false, error: 'bad_number' }, 400);
      shop.look[it.slot] = it.id;
      if (it.id === 'number-on') shop.look.no = b.number;
      return reply({ ok: true, ...wallet() });
    }
    return reply(url.searchParams.get('player') ? { ...rankings, allTime: record.allTime } : rankings);
  });
  Object.defineProperty(calls, 'tickets', { value: tickets });   // 받은 요청 목록과 비교할 때 걸리지 않게 숨긴 속성으로 둔다
  Object.defineProperty(calls, 'releaseSeeds', { value: () => { opts.seedHold = false; heldSeeds.splice(0).forEach((done) => done()); } });
  return calls;
}

// team: 처음부터 고른 팀(null이면 처음 온 사람). login: 카카오로 로그인한 상태로 연다. api: mockApi 설정
async function open(page, query = '?seed=42', { team = 'lg', login = false, api } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = await mockApi(page, api ?? {});
  await page.addInitScript(({ team, login, session, host }) => {
    if (location.host !== host) return;   // 게임 페이지에서만(로그인 흉내 중에 지나가는 빈 페이지·서버 페이지는 빼고)
    if (localStorage.getItem('walkoff.seeded')) return;   // 새로고침해도 처음 값으로 되돌리지 않는다
    localStorage.setItem('walkoff.seeded', '1');
    if (team) { localStorage.setItem('walkoff.team', team); localStorage.setItem('walkoff.nick', '테스트'); }
    if (login) localStorage.setItem('walkoff.session', session);
  }, { team, login, session: SESSION, host: HOST });
  await page.goto(PAGE + query);
  await page.waitForFunction(() => !!window.walkoff);
  Object.defineProperty(errors, 'calls', { value: calls });   // expect(errors).toEqual([])에 걸리지 않게 숨긴 속성으로 둔다
  return errors;
}
const sentScores = (errors) => errors.calls.filter((c) => c.method === 'POST' && c.path === '/scores');
const seedCalls = (errors) => errors.calls.filter((c) => c.path === '/seeds');
// 로그인한 10구 도전은 서버 시드를 받아 둔 뒤에 바로 시작한다(받는 중이면 startGame이 받을 때까지 기다렸다가 시작한다)
const seedReady = (page) => page.waitForFunction(() => !!walkoff.seedTicket.ready);
// 서버의 seed_tokens 한 줄처럼 만든 표. 가짜 서버가 내준 표(t)를 실제 서버 검사(worker/src/rules.js)에 넣을 때 쓴다
const ticketRow = (t, playerId, patch = {}) => ({ id: t.token, player_id: playerId, seed: t.seed, issued_at: t.at, used_at: null, ...patch });

// 게임이 카카오 로그인으로 떠난 요청(서버 /auth/kakao/start)을 기다려 그 값을 돌려준다. 그 페이지가 다 열린 뒤에 돌려줘서
// 다음 페이지 이동과 부딪히지 않게 한다
async function kakaoStart(errors, page) {
  await expect.poll(() => errors.calls.some((c) => c.path === '/auth/kakao/start')).toBe(true);
  await page.waitForURL(/\/auth\/kakao\/start/, { timeout: 10_000 });
  return errors.calls.find((c) => c.path === '/auth/kakao/start').query;
}

// 카카오 로그인을 마치고 게임으로 돌아온 것처럼 연다. n은 돌려줄 확인값, stored는 게임이 적어 뒀어야 할 확인값.
// 크롬은 저장소에 쓴 값을 새로 연 페이지에 조금 늦게 알릴 때가 있어서(느린 CI에서 실패했다), 새 페이지에서 그 값이 보인 뒤에 돌아온다
async function loginReturn(page, query, n, { error, stored = n } = {}) {
  await page.waitForTimeout(300);   // 테스트가 방금 저장소에 쓴 값이 넘어갈 틈
  await page.goto('about:blank');
  await page.goto(`${PAGE}${query}`);
  await page.waitForFunction((v) => localStorage.getItem('walkoff.loginNonce') === v, stored, { timeout: 10_000 });
  await page.goto('about:blank');
  await page.goto(`${PAGE}${query}#${error ? `login_error=${error}` : `login=${SESSION}`}&n=${n}`);
  await page.waitForFunction(() => !!window.walkoff);
}

// 저장한 값이 새로고침한 페이지에 보일 때까지 몇 번 새로고침한다. 크롬은 저장소에 쓴 값을 새 페이지에 조금 늦게 알릴 때가 있고,
// 쓰자마자 페이지를 닫으면 값이 사라질 때도 있어서 먼저 잠깐 기다린다(사람은 그렇게 빨리 새로고침하지 않는다)
async function reloadUntil(page, fn) {
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await page.waitForFunction(() => !!window.walkoff);
    if (await page.evaluate(fn)) return;
    await page.waitForTimeout(300);
  }
}

// 버튼은 그릴 때마다 다시 모으므로, 화면이 막 바뀌었으면 다음 그림에서 나타날 때까지 잠깐 기다린다
const tap = async (page, label) => {
  await page.waitForFunction((l) => walkoff.ui.buttons.some((b) => b.label === l), label, { timeout: 3000 }).catch(() => {});
  const r = await page.evaluate((l) => walkoff.ui.buttons.find((b) => b.label === l)?.r, label);
  if (!r) throw new Error(`버튼이 없다: ${label}`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
};

// 지금 화면에 그린 글자들. 캔버스라 DOM에 없어서 다음 그림 세 장 동안 fillText로 그린 글자를 모은다
const drawnTexts = (page) => page.evaluate(() => new Promise((resolve) => {
  const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, seen = new Set();
  proto.fillText = function (s, ...rest) { seen.add(String(s)); return fill.call(this, s, ...rest); };
  let k = 0;
  const next = () => { if (++k < 3) requestAnimationFrame(next); else { proto.fillText = fill; resolve([...seen]); } };
  requestAnimationFrame(next);
}));
// 지금 화면을 한 번 그리며 칠한 둥근 네모(색·자리)와 쓴 글자(자리)를 그린 차례대로 모은다. 막대 길이·금색 줄처럼 글자만으로는 못 보는 것을 본다.
// 둥근 네모는 moveTo·arcTo로 그려서 그 점들의 테두리가 네모 자리다. 색은 캔버스가 바꿔 적는 꼴(#a1b2c3, rgba(1, 2, 3, 0.5))이라 norm으로 맞춘다
const drawnOps = (page) => page.evaluate(() => {
  const proto = CanvasRenderingContext2D.prototype, keep = {}, ops = [];
  let pts = [];
  const hook = (name, fn) => { keep[name] = proto[name]; proto[name] = function (...a) { fn.call(this, ...a); return keep[name].apply(this, a); }; };
  hook('beginPath', () => { pts = []; });
  hook('moveTo', (x, y) => pts.push([x, y]));
  hook('arcTo', (x1, y1, x2, y2) => pts.push([x1, y1], [x2, y2]));
  hook('fill', function () {
    if (!pts.length || typeof this.fillStyle !== 'string') return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x = Math.min(...xs), y = Math.min(...ys);
    ops.push({ t: 'fill', style: this.fillStyle, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  });
  hook('fillText', (s, x, y) => ops.push({ t: 'text', s: String(s), x, y }));
  try { walkoff.render(performance.now() / 1000); } finally { Object.assign(proto, keep); }
  return ops;
});
const norm = (page, color) => page.evaluate((c) => { const g = document.createElement('canvas').getContext('2d'); g.fillStyle = c; return g.fillStyle; }, color);
// 메뉴 의견 띠의 만든 사람 한마디가 잘리지 않고 다 보이는지(PC는 한 줄, 폰은 두 줄로 나눠 그린다. 줄은 그린 차례대로 모인다)
const NOTE = '만든 사람이 의견을 하나하나 읽고 고쳐요. 패들렛에 남겨 주세요!';
const noteShown = (texts) => texts.includes(NOTE) || texts.some((s, i) => `${s} ${texts[i + 1]}` === NOTE);

// 가운데 전광판(투수판)은 바뀔 때만 작은 그림(scoreboardCache)에 다시 그려서, 한 번 다시 그리게 하고 그 그림에 쓴 글자와 크기(px)·좌우 끝을 모은다
const boardGlyphs = (page) => page.evaluate(() => new Promise((resolve) => {
  const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, out = [];
  proto.fillText = function (s, x, ...rest) {
    if (this.canvas === walkoff.scoreboardCache.canvas) {
      const w = this.measureText(s).width, left = this.textAlign === 'center' ? x - w / 2 : this.textAlign === 'right' ? x - w : x;
      out.push({ s: String(s), size: Number(/(\d+)px/.exec(this.font)[1]), left, right: left + w });
    }
    return fill.call(this, s, x, ...rest);
  };
  walkoff.scoreboardCache.key = '';
  requestAnimationFrame(() => requestAnimationFrame(() => { proto.fillText = fill; resolve(out); }));
}));
const boardWords = async (page) => (await boardGlyphs(page)).map((g) => g.s);

// 10구 도전을 끝까지 친 날을 이 브라우저 기록(played.날짜)으로 둔다. ago는 며칠 전에 쳤는지(0은 오늘).
// legacy는 그 날들을 없앤 오늘의 10구 기록(daily.날짜)으로 둔다(예전 기록도 연속 기록에 들어간다)
const setPlayedDays = (page, ago, legacy = []) => page.evaluate(({ ago, legacy }) => {
  for (const k of [...walkoff.store.keys('played.'), ...walkoff.store.keys('daily.')]) walkoff.store.remove(k);
  const t = Date.parse(walkoff.today() + 'T00:00:00Z'), day = (n) => new Date(t - n * 864e5).toISOString().slice(0, 10);
  for (const n of ago) walkoff.store.set('played.' + day(n), 1);
  for (const n of legacy) walkoff.store.set('daily.' + day(n), { score: 1500, lights: 'GGRYGRRRRRR', bats: 'R', date: day(n) });
}, { ago, legacy });

// 지금 공이 홈플레이트에 닿는 시각보다 dt(ms) 늦게(-면 빠르게) 스페이스를 누른다. 파울(90~140ms)처럼 폭이 좁은 판정을 노릴 때 쓴다.
// 게임은 한 화면에 시간을 0.05초까지만 보내서(frame의 dt) 화면이 느리면 게임 시간이 실제 시간보다 늦게 간다. 그래서 실제 시간으로
// 재서 누르면 부하에 따라 늦거나(2026-10-30 CI, 115ms가 140ms를 넘어 헛스윙) 빨라졌다(같은 날 로컬, 안타). 게임 시간이 목표 0.08초
// 앞까지 오기를 화면마다 보고, 마지막 화면 뒤로 남은 만큼만 기다렸다가 누른다(키를 누른 시각은 마지막 화면 시각부터 실제 시간으로 더한다)
const pressAt = (page, dt) => page.evaluate((dt) => new Promise((resolve) => {
  const g = walkoff.game, target = g.seq[g.i].T + dt / 1000;
  const tick = () => {
    if (walkoff.ballTime() < target - 0.08) { requestAnimationFrame(tick); return; }
    const at = g.clockAt + (target - walkoff.ballTime()) * 1000;
    while (performance.now() < at) { /* 누를 시각까지 기다린다 */ }
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); resolve();
  };
  requestAnimationFrame(tick);
}), dt);

// 공이 홈플레이트에 닿는 시각보다 dt(ms)만큼 빠르게(-)/늦게(+) 스페이스를 보낸다. dt가 null이면 치지 않는다
async function playPitch(page, dt) {
  await page.waitForFunction(() => ['windup', 'pitch'].includes(walkoff.game.state));
  if (dt != null) {
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await page.evaluate((dt) => new Promise((resolve) => {
      const g = walkoff.game, p = g.seq[g.i];
      const now = walkoff.ballTime() + (performance.now() - g.clockAt) / 1000;
      setTimeout(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); resolve(); }, Math.max(0, (p.T - now) * 1000 + dt));
    }), dt);
  }
  await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
  const outcome = await page.evaluate(() => ({ kind: walkoff.game.outcome.kind, name: walkoff.game.outcome.name }));
  await page.keyboard.press('Space');
  return outcome;
}

async function playUntilOver(page, dt, max = 40) {
  for (let k = 0; k < max; k++) {
    if (await page.evaluate(() => walkoff.game.state === 'over')) return;
    await playPitch(page, dt);
  }
  await page.waitForFunction(() => walkoff.game.state === 'over');
}

test.describe('판정 계산', () => {
  test('커브·체인지업·포크도 잘 맞히면 홈런이 나오고(전에는 정타여도 포크 0%·체인지업 4%·커브 3%), 빗맞은 포크는 여전히 땅볼이 많다', async ({ page }) => {
    const errors = await open(page);
    const t = await page.evaluate(() => {
      const t = {};
      for (let sd = 1; sd <= 120; sd++) {
        const seq = walkoff.makeSequence(sd, false);
        for (let i = 0; i < 16; i++) for (let dt = -60; dt <= 60; dt += 3) for (const bats of ['R', 'L']) {
          const p = seq[i];
          if (p.type !== 'fork' && p.type !== 'change' && p.type !== 'curve') continue;
          const r = walkoff.judgeSwing(p, dt, bats), c = (t[p.type] ??= { perfect: 0, hr: 0, mis: 0, gb: 0 });
          if (r.kind === 'whiff' || r.kind === 'foul') continue;
          if (r.perfect) { c.perfect++; if (r.kind === 'hr') c.hr++; }
          if (Math.abs(dt) > 30) { c.mis++; if (r.type === 'ground') c.gb++; }
        }
      }
      return t;
    });
    expect(t.change.hr / t.change.perfect).toBeGreaterThan(0.18);
    expect(t.curve.hr / t.curve.perfect).toBeGreaterThan(0.15);
    expect(t.fork.hr / t.fork.perfect).toBeGreaterThan(0.06);
    expect(t.fork.gb / t.fork.mis).toBeGreaterThan(0.25);
    expect(errors).toEqual([]);
  });

  test.skip(({ isMobile }) => isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');

  test('가운데 직구를 정타로 치면 홈런, 체인지업을 직구 타이밍에 치면 파울이나 헛스윙', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const fast = { type: 'fastball', kmh: 150, tx: 0, ty: 0.85 };
      const change = { type: 'change', kmh: 128, tx: 0, ty: 0.85 };
      return {
        perfect: walkoff.judgeSwing(fast, 0).kind,
        changeEarly: walkoff.judgeSwing(change, Math.round((112 / 150 - 112 / 128) * 1000)).kind,
        farOutside: walkoff.judgeSwing({ type: 'slider', kmh: 137, tx: 0.6, ty: 0.8 }, 0).kind,
      };
    });
    expect(r.perfect).toBe('hr');
    expect(['foul', 'whiff']).toContain(r.changeEarly);
    expect(r.farOutside).toBe('whiff');
  });

  test('좌타는 당기는 방향이 우타와 반대다', async ({ page }) => {
    await open(page);
    const s = await page.evaluate(() => {
      const p = { type: 'fastball', kmh: 150, tx: 0, ty: 0.85 };
      return { R: walkoff.judgeSwing(p, -40, 'R').spray, L: walkoff.judgeSwing(p, -40, 'L').spray };
    });
    expect(s.R).toBeLessThan(0);
    expect(s.L).toBe(-s.R);
  });

  // 2026-10-30 사용자 목소리 '정타를 쳤는데 아웃': 정타는 가운데(중견수 정면, 담장이 가장 먼 쪽)로 가서 존 안 정타의 28%가 잡혔다
  test('정타(존 안 공, ±15ms)는 아웃이 되지 않는다. 잡힐 타구만 수비가 못 닿는 곳(땅볼은 내야 빈틈, 뜬 타구는 빈틈에서 가장 가까운 못 닿는 방향)으로 가고, 정타가 아닌 타구는 그대로 잡힌다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const res = { perfect: 0, outs: [], moved: new Set(), otherOuts: 0 }, round = (v) => Math.round(v * 100) / 100;
      for (const [type, def] of Object.entries(walkoff.PITCHES)) for (const kmh of def.kmh)
        for (let i = 0; i <= 10; i++) for (let j = 0; j <= 12; j++) for (let dt = -45; dt <= 45; dt += 3) for (const bats of ['R', 'L']) {
          const p = { type, kmh, tx: round(-0.25 + i * 0.05), ty: round(0.5 + j * 0.05) }, x = walkoff.judgeSwing(p, dt, bats);
          if (x.perfect) {
            res.perfect++;
            if (x.kind === 'out') res.outs.push(`${type} ${kmh}km ${p.tx},${p.ty} ${dt}ms ${bats} ${x.name}`);
            if (x.split) res.moved.add(`${x.type === 'ground' ? 'ground' : 'air'}:${x.spray}`);
          } else if (Math.abs(dt) > 15 && x.kind === 'out') res.otherOuts++;
        }
      return { ...res, moved: [...res.moved] };
    });
    expect(r.perfect).toBeGreaterThan(30000);   // 존 안 공 격자 전체(구종·속도 양끝·좌우·높이·±15ms·좌우타)
    expect(r.outs).toEqual([]);
    const moved = (t) => r.moved.filter((m) => m.startsWith(t)).map((m) => Number(m.split(':')[1]));
    expect([...new Set(moved('ground'))].sort((a, b) => a - b)).toEqual([-23, 0, 23]);   // 땅볼: 3유간·투수 옆·1·2루간(수비 위치의 가운데)
    expect(moved('air').every((a) => Math.abs(a) <= 43)).toBe(true);   // 뜬 타구: 외야수가 못 닿는 방향(2026-11-04부터 좌중간·우중간에 닿으면 그 옆)
    expect(r.otherOuts).toBeGreaterThan(1000);   // 정타가 아니면 지금처럼 잡힌다
  });

  test('가운데 낮은 커브를 정타로 치면 중견수 직선타가 될 공이 좌중간 2루타가 된다. 30ms 늦게 친 우중간 2루타는 그대로다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const curve = { type: 'curve', kmh: 120, tx: 0, ty: 0.6 };   // 2026-11-03부터 커브도 잘 맞히면 떠서, 가운데 높이(0.8m)는 중견수 머리를 넘는다
      const pick = (x) => ({ kind: x.kind, name: x.name, spray: x.spray, reason: x.reason, split: !!x.split });
      return { perfect: pick(walkoff.judgeSwing(curve, 0, 'R')), late: pick(walkoff.judgeSwing(curve, 30, 'R')) };
    });
    expect(r.perfect).toEqual({ kind: 'double', name: '좌중간 2루타', spray: -14, reason: '정타라 수비 사이로 빠졌어요', split: true });
    expect(r.late).toEqual({ kind: 'double', name: '우중간 2루타', spray: 15, reason: '늦어서 밀어친 타구예요', split: false });   // 2026-11-03부터 세게 뜬 공은 조금 더 넓게 간다(14 → 15도)
  });

  test('존 밖 공을 정확한 타이밍으로 치면 칩이 "타이밍 정확 · 존 밖 공"이다(정타 칩과 헷갈리지 않게)', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('practice'));
    await page.evaluate(() => {
      const g = walkoff.game, p = { ...g.seq[g.i], type: 'slider', kmh: 137, tx: 0.33, ty: 0.8 };   // 존 밖이지만 배트가 닿는 공
      const r = walkoff.judgeSwing(p, 0);
      g.seq[g.i] = p;
      Object.assign(g, { state: 'result', outcome: r, resultT: 3, flightT: 3, revealAt: 0, swingAt: p.T, replayed: true });
    });
    const texts = await drawnTexts(page);
    expect(texts).toContain('타이밍 정확 · 존 밖 공');
    expect(texts).not.toContain('정타!');
    expect(errors).toEqual([]);
  });

  test('같은 시드는 같은 공 순서다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => ({
      sameSeed: JSON.stringify(walkoff.makeSequence(7)) === JSON.stringify(walkoff.makeSequence(7)),
      otherSeed: JSON.stringify(walkoff.makeSequence(7)) !== JSON.stringify(walkoff.makeSequence(8)),
      length: walkoff.makeSequence(7).length,
    }));
    expect(r).toEqual({ sameSeed: true, otherSeed: true, length: 40 });   // 볼은 기회를 안 써서 공을 40개 미리 만든다
  });

  test('끝내기 상황: 밀어내기, 희생플라이, 2스트라이크 파울, 끝내기 홈런', { tag: '@min' }, async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const mk = (outs, bases, away, home, b = 0, s = 0) => ({ outs, bases, away, home, count: { b, s }, pa: [], end: null });
      const walk = mk(2, [true, true, true], 4, 3, 3, 0); walkoff.applyScenario(walk, { kind: 'ball' });
      const sac = mk(1, [false, false, true], 3, 2); walkoff.applyScenario(sac, { kind: 'out', type: 'fly' });
      const sac3 = mk(2, [false, false, true], 3, 2); walkoff.applyScenario(sac3, { kind: 'out', type: 'fly' });
      const foul = mk(0, [false, false, false], 1, 0, 0, 2); walkoff.applyScenario(foul, { kind: 'foul' });
      const hr = mk(2, [true, true, false], 4, 2); walkoff.applyScenario(hr, { kind: 'hr' });
      return { walk: [walk.home, walk.end], sac: [sac.home, sac.outs], sac3: [sac3.home, sac3.end], foul: foul.count.s, hr: [hr.home, hr.end] };
    });
    expect(r.walk).toEqual([4, null]);     // 만루 밀어내기로 동점
    expect(r.sac).toEqual([3, 2]);         // 희생플라이로 동점, 2아웃
    expect(r.sac3).toEqual([2, 'lose']);   // 3아웃이면 득점 없이 끝
    expect(r.foul).toBe(2);                // 2스트라이크 뒤 파울은 세지 않는다
    expect(r.hr).toEqual([5, 'win']);      // 끝내기 홈런
  });

  test('공유 글 형식', async ({ page }) => {
    await open(page);
    const text = await page.evaluate(() => walkoff.shareText({ bats: 'L', lights: 'GYRRG', score: 2100, hr: 1, far: 128 }));
    expect(text.split('\n')).toEqual([
      'walkoff 10구 도전 (좌타)',
      '🟢🟡🔴🔴🟢',
      '2,100점 · 홈런 1 · 최장 128m',
      'https://hyunseungbeom.github.io/walkoff/',
    ]);
    // 안타 종류를 담은 불: 홈런만 별, 단타·2루타·3루타는 초록
    const kinds = await page.evaluate(() => walkoff.shareText({ bats: 'R', lights: 'SYHRDTH', score: 3900, hr: 2, far: 131 }));
    expect(kinds.split('\n')[1]).toBe('🟢🟡⭐🔴🟢🟢⭐');
  });

  test('공유 글 형식: 10구 도전과 끝내기 상황은 첫 줄에 모드가 적힌다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => ({
      challenge: walkoff.shareText({ bats: 'R', lights: 'GRY', score: 3200, hr: 2, far: 131, newBest: true }, 'challenge'),
      scenario: walkoff.shareText({ bats: 'L', end: 'win', away: 4, home: 5, pa: 'RGG', label: '2사 1·2루, 1점 차' }, 'scenario'),
    }));
    expect(r.challenge.split('\n')).toEqual([
      'walkoff 10구 도전 (우타)',
      '🟢🔴🟡',
      '3,200점 · 새 최고 기록 · 홈런 2 · 최장 131m',
      'https://hyunseungbeom.github.io/walkoff/',
    ]);
    expect(r.scenario.split('\n')).toEqual([
      'walkoff 끝내기 상황 (좌타)',
      '끝내기 승리! 원정 4 : 5 홈',
      '🔴🟢🟢',
      '처음 상황: 2사 1·2루, 1점 차',
      'https://hyunseungbeom.github.io/walkoff/',
    ]);
  });

  test('좌투수는 공 위치와 궤적이 우투수와 좌우 대칭이다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const R = walkoff.makeSequence(7, false), L = walkoff.makeSequence(7, true);
      const mirrored = R.every((p, i) => p.type === L[i].type && p.kmh === L[i].kmh && Math.abs(p.tx + L[i].tx) < 1e-9 && p.ty === L[i].ty && L[i].lefty && !p.lefty);
      const a = walkoff.ballPos(R[3], 0.5), b = walkoff.ballPos(L[3], 0.5);
      const hands = Array.from({ length: 400 }, (_, s) => walkoff.pitcherHand(s + 1));
      return { mirrored, path: Math.abs(a.x + b.x) < 1e-9 && a.y === b.y && a.z === b.z, leftyShare: hands.filter((h) => h === 'L').length / hands.length };
    });
    expect(r.mirrored).toBe(true);
    expect(r.path).toBe(true);
    expect(r.leftyShare).toBeGreaterThan(0.25);   // 좌완은 35% 안팎
    expect(r.leftyShare).toBeLessThan(0.45);
  });
});

test.describe('한 판 끝까지', () => {
  test.skip(({ isMobile }) => isMobile, '오래 걸려서 PC에서만 본다');

  test('실제로 친 10구 도전은 서버 검사(서버가 내준 시드의 공 순서·점수 상한·한 판 칠 시간)를 통과한다', { tag: '@min' }, async ({ page }) => {
    test.slow();
    const rules = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    const errors = await open(page, '', { login: true, api: { seed: 7 } });
    await seedReady(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    const plan = [null, 0, -40, null, 60, 0, null, -120, 0, 30];   // 그냥 보내기(볼·스트라이크), 정타, 조금 빠름·늦음, 헛스윙을 섞는다
    for (let k = 0; k < 40 && !(await page.evaluate(() => walkoff.game.state === 'over')); k++) await playPitch(page, plan[k % plan.length]);
    await page.waitForFunction(() => walkoff.game.state === 'over');
    await expect.poll(() => sentScores(errors).length).toBe(1);
    const body = sentScores(errors)[0].body, [t] = errors.calls.tickets;
    expect([body.mode, body.seed, body.token]).toEqual(['challenge', 7, t.token]);
    expect(rules.validateSubmission(body, Date.now(), 'p-test-0001', ticketRow(t, 'p-test-0001'))).toMatchObject({ ok: true });
    expect(rules.validateSubmission({ ...body, score: body.score + 100000 }, Date.now(), 'p-test-0001', ticketRow(t, 'p-test-0001')).error).toBe('bad_score');
    expect(rules.validateSubmission(body, Date.now(), 'p-test-0001', ticketRow(t, 'p-test-0001', { issued_at: Date.now() })).error).toBe('too_fast');
    expect(errors).toEqual([]);
  });

  test('가장 빨리 친 판(공을 놓자마자 휘두르고 바로 다음 공)도 서버의 한 판 칠 시간 검사에 걸리지 않는다', { tag: '@min' }, async ({ page }) => {
    test.slow();
    const rules = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    const { MIN_PITCH_MS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'seeds.js')).href);
    const errors = await open(page, '', { login: true });
    await seedReady(page);
    const startedAt = Date.now();   // 서버가 시작하는 순간에 표를 내줬다고 보고 잰다(실제로는 미리 받아 둬서 더 일찍이다)
    await page.evaluate(() => walkoff.startGame('challenge'));
    for (let k = 0; k < 40; k++) {
      await page.waitForFunction(() => ['pitch', 'over'].includes(walkoff.game.state));
      if (await page.evaluate(() => walkoff.game.state === 'over')) break;
      await page.keyboard.press('Space');   // 공을 놓자마자 휘두른다(대개 헛스윙. 키가 늦게 가서 맞으면 결과가 늦게 뜬다)
      await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > Math.max(0.35, walkoff.game.revealAt) + 0.01);
      await page.keyboard.press('Space');   // 넘길 수 있게 되자마자 다음 공
    }
    await expect.poll(() => sentScores(errors).length).toBe(1);
    const body = sentScores(errors)[0].body, took = Date.now() - startedAt;
    expect(took).toBeGreaterThan(body.lights.length * MIN_PITCH_MS);
    const row = ticketRow(errors.calls.tickets[0], 'p-test-0001', { issued_at: startedAt });
    expect(rules.validateSubmission(body, Date.now(), 'p-test-0001', row)).toMatchObject({ ok: true });
    expect(errors).toEqual([]);
  });

  test('10구 도전: 볼을 골라내면 기회를 쓰지 않고, 늘어나는 기회에 상한이 없다', async ({ page }) => {
    test.slow();
    const errors = await open(page, '?seed=2');   // 존 밖 공이 많은 시드(예전 상한 5번을 넘는다)
    await page.evaluate(() => walkoff.startGame('challenge'));
    await playUntilOver(page, null);   // 한 번도 치지 않는다: 존 안 공은 스트라이크(기회 -1), 존 밖 공은 볼(기회 그대로)
    const end = await page.evaluate(() => ({
      pitches: walkoff.game.results.length, extra: walkoff.game.extra, left: walkoff.game.left,
      balls: walkoff.game.results.filter((r) => r.kind === 'ball').length, lights: walkoff.game.summary.lights,
    }));
    expect(end.extra).toBeGreaterThan(5);
    expect(end).toMatchObject({ left: 0, balls: end.extra, pitches: 10 + end.extra });
    expect(end.lights).toHaveLength(10 + end.extra);   // 서버 검사 규칙(전광판 칸 수 = 10 + 볼 수)과 맞는다
    expect(errors).toEqual([]);
  });

  test('시작 화면에서 누르면 늘 10구 도전이고, 끝까지 치면 점수를 보내고 연속 기록이 이어진다(어제도 쳤으면 2일 연속)', async ({ page }) => {
    test.slow();
    const errors = await open(page, '', { login: true });
    await setPlayedDays(page, [1]);   // 어제도 쳤다
    await page.keyboard.press('Space');   // 오늘의 10구는 2026-10-30에 없앴다
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('challenge');
    await playUntilOver(page, 0);
    // 점수가 로그인 표와 서버가 내준 시드(표)를 붙여 랭킹 서버로 한 번 가고, 끝 화면에 이번 주 순위가 붙는다
    await expect.poll(() => sentScores(errors).length).toBe(1);
    const sent = sentScores(errors)[0], today = await page.evaluate(() => walkoff.today()), [t] = errors.calls.tickets;
    // 불은 안타 종류(S 단타·D 2루타·T 3루타·H 홈런)를 담아 보낸다(2026-11-05 칭호 서버부터)
    const game = await page.evaluate(() => ({ score: walkoff.game.score, lights: walkoff.game.summary.lights }));
    expect(game.lights).toMatch(/^[SDTHYR]+$/);
    expect(sent.auth).toBe(`Bearer ${SESSION}`);
    expect(sent.body).toEqual({ nick: '테스트', team: 'lg', day: today, ...game, mode: 'challenge', seed: 42, token: t.token });   // 사람 ID는 서버가 로그인 표에서 꺼낸다
    const rules = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    expect(rules.validateSubmission(sent.body, Date.now(), 'p-test-0001', ticketRow(t, 'p-test-0001'))).toMatchObject({ ok: true });   // 실제로 친 판은 서버 검사를 통과한다
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain('이번 주 최고 기록! 3위 · 랭킹 보기 ›');
    expect(await drawnTexts(page)).toContain('10구 도전 · 2일 연속');   // 방금 친 판까지 세서 제목 옆에 붙는다
    expect(await page.evaluate(() => walkoff.store.get('played.' + walkoff.today(), 0))).toBe(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');   // 다시 눌러도 10구 도전(하루 한 판 제한이 없다)
    expect(await page.evaluate(() => [walkoff.game.mode, walkoff.game.state])).toEqual(['challenge', 'windup']);
    expect(errors).toEqual([]);
  });
});

test.describe('화면', () => {
  test('시작 화면은 좌타·우타·메뉴만 있고, 빈 곳을 누르면 시작한다. 나머지는 메뉴 안에 있다', async ({ page }) => {
    const errors = await open(page);
    const labels = await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label));
    expect(labels.sort()).toEqual(['메뉴', '우타', '좌타'].sort());
    const menu = await page.evaluate(() => walkoff.ui.buttons.find((b) => b.label === '메뉴').r);
    await page.mouse.click(menu.x + menu.w / 2, menu.y + menu.h / 2);
    await page.waitForFunction(() => walkoff.game.state === 'menu');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '기록'));
    const items = await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label));
    for (const want of [/^끝내기 상황$/, /^연습$/, /^타이밍 보정/, /^기록$/, /^이번 주 랭킹$/, /^팀·닉네임$/, /^카카오 로그인$/, /^닫기$/]) {
      expect(items.some((l) => want.test(l)), String(want)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => walkoff.game.state === 'title' && walkoff.ui.buttons.some((b) => b.label === '좌타'));
    const vp = page.viewportSize();
    await page.mouse.click(20, vp.height - 20);   // 버튼이 없는 왼쪽 아래 빈 곳
    expect(await page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');   // 로그인 안 했으면 10구 도전 전에 로그인을 권한다
    await tap(page, '나중에 하기');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'challenge' });
    expect(errors).toEqual([]);
  });

  test('로그인 안 한 사람은 10구 도전 전에 하루 한 번 카카오 로그인을 권한다', async ({ page }) => {
    const errors = await open(page);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '나중에 하기'));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label).sort())).toEqual(['나중에 하기', '카카오로 로그인']);
    await page.keyboard.press('Escape');   // 닫으면 시작 화면. 다시 시작하면 또 묻는다
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');
    await tap(page, '나중에 하기');
    await expect.poll(() => page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'challenge' });
    await reloadUntil(page, () => walkoff.store.get('loginLater', '') === walkoff.today());   // 다시 열어도 남아 있다
    await page.keyboard.press('Space');   // 나중에 하기를 누른 날은 다시 묻지 않는다
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('windup');
    await page.evaluate(() => { walkoff.store.set('loginLater', '2000-01-01'); walkoff.goTitle(); });   // 다른 날이 되면 다시 묻는다
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');
    await tap(page, '카카오로 로그인');
    expect((await kakaoStart(errors, page)).pid).toMatch(/^[a-z0-9-]{8,40}$/);
    expect(errors).toEqual([]);
  });

  test('타자 몸이 화면 안에 보인다(폭이 좁은 폰, 우타·좌타)', async ({ page }) => {
    const errors = await open(page);
    const check = async (label) => {
      for (const bats of ['R', 'L']) {
        await page.evaluate((b) => walkoff.setBats(b), bats);
        const sp = await page.evaluate(() => walkoff.batterSpan());
        expect(sp.min, `${label} ${bats} 왼쪽`).toBeGreaterThanOrEqual(0);
        expect(sp.max, `${label} ${bats} 오른쪽`).toBeLessThanOrEqual(sp.w);
      }
    };
    await check(String(page.viewportSize().width));
    await page.setViewportSize({ width: 360, height: 780 });   // 폭이 좁은 폰(예전에는 타자가 거의 화면 밖이었다)
    await page.waitForFunction(() => walkoff.batterSpan().w === 360);
    await check('360');
    expect(errors).toEqual([]);
  });

  test('연속 기록: 시작 화면 아래 줄과 10구 도전 끝 화면 제목에 이어 친 날 수가 나오고, 하루 빠지면 끊긴다(없앤 오늘의 10구 기록도 센다)', async ({ page }) => {
    const errors = await open(page);   // ?seed=42: 첫 공이 스트라이크라 공 하나로 끝난다(시드가 무작위면 첫 공이 볼일 때 판이 안 끝났다)
    const titleLine = async () => (await drawnTexts(page)).find((t) => t.endsWith('주간 랭킹은 이번 주 최고 기록이에요') || t.includes('오늘 치면'));
    await setPlayedDays(page, [2, 3]);   // 어제를 걸러서 끊겼다
    expect(await titleLine()).toBe('주간 랭킹은 이번 주 최고 기록이에요');
    await setPlayedDays(page, [1, 3]);
    expect(await titleLine()).toBe('오늘 치면 2일 연속');
    await setPlayedDays(page, [1], [2]);   // 그저께는 없앤 오늘의 10구로 쳤다
    expect(await titleLine()).toBe('2일 연속 중 · 오늘 치면 3일');
    await setPlayedDays(page, [0, 1, 2]);
    expect(await titleLine()).toBe('3일 연속 · 주간 랭킹은 이번 주 최고 기록이에요');
    // 끝 화면은 제목 옆에 붙는다(어제·그저께 친 뒤 오늘 한 판을 끝까지 쳤다)
    await setPlayedDays(page, [1, 2]);
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝낸다
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    expect(await drawnTexts(page)).toContain('10구 도전 · 3일 연속');
    await setPlayedDays(page, [0, 2]);   // 어제를 걸렀으면 붙지 않는다
    expect((await drawnTexts(page)).some((t) => t.includes('일 연속'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('좌타/우타는 눌러도 경기가 시작되지 않고, 새로고침해도 남는다', async ({ page }) => {
    const errors = await open(page);
    const left = await page.evaluate(() => walkoff.ui.buttons.find((b) => b.label === '좌타').r);
    await page.mouse.click(left.x + left.w / 2, left.y + left.h / 2);
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');   // 버튼을 눌러도 경기는 시작하지 않는다
    await reloadUntil(page, () => walkoff.settings.bats === 'L');
    expect(await page.evaluate(() => walkoff.settings.bats)).toBe('L');
    expect(errors).toEqual([]);
  });

  test('처음 온 사람은 열자마자 팀과 닉네임을 고르고, 로그인 없이도 시작할 수 있다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { team: null });
    const nick = page.locator('input[aria-label="닉네임"]');
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');   // 누르지 않아도 팀 고르기부터
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 시작'));
    await tap(page, '나중에 로그인하기');   // 팀을 안 고르면 넘어가지 않는다
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');
    await tap(page, '한화 이글스');
    expect(await page.evaluate(() => walkoff.batterColors().accent)).toBe('#1b1b1b');   // 고르는 중에도 유니폼을 미리 입혀 본다
    await nick.fill('명은');
    await nick.press('Enter');   // 처음 화면에서 엔터는 키보드만 닫는다(카카오 로그인으로 넘어가지 않는다)
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');
    await tap(page, '나중에 로그인하기');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, team: walkoff.settings.team, nick: walkoff.settings.nick })))
      .toEqual({ state: 'title', team: 'hanwha', nick: '명은' });   // 시작 화면에서 규칙과 좌타·우타를 보고 시작한다
    await expect(nick).toBeHidden();
    const vp = page.viewportSize();
    await page.mouse.click(20, vp.height - 20);
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'challenge' });
    expect(await page.evaluate(() => walkoff.game.opponent !== 'hanwha' && walkoff.pitcherColors().navy !== '#1d2f5c')).toBe(true);   // 투수는 상대 팀 색
    await reloadUntil(page, () => walkoff.settings.team === 'hanwha');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, team: walkoff.settings.team, nick: walkoff.settings.nick, jersey: walkoff.batterColors().jersey })))
      .toEqual({ state: 'title', team: 'hanwha', nick: '명은', jersey: '#e65c00' });   // 한화 상의 #ff6600을 조명에 맞춰 0.9배
    expect(errors.calls).toEqual([]);   // 로그인하지 않으면 서버에 아무것도 보내지 않는다
    expect(errors).toEqual([]);
  });

  test('카카오로 시작: 다른 기기에서 쓰던 계정이면 그 팀·닉네임으로 이어 간다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { team: null, api: { account: { team: 'lg', nick: '민성' } } });
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 시작'));
    const pid = await page.evaluate(() => walkoff.settings.playerId);
    await tap(page, '두산 베어스');
    await tap(page, '카카오로 시작');
    const start = await kakaoStart(errors, page);
    expect(start).toEqual({ n: expect.stringMatching(/^n[0-9a-f]{32}$/), pid, return: `${PAGE}?seed=42` });
    await loginReturn(page, '?seed=42', start.n);
    await page.waitForFunction(() => walkoff.settings.team === 'lg');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, team: walkoff.settings.team, nick: walkoff.settings.nick, playerId: walkoff.settings.playerId, toast: walkoff.game.toast?.text, hash: location.hash })))
      .toEqual({ state: 'title', team: 'lg', nick: '민성', playerId: ACCOUNT_ID, toast: '이어서 해요 · LG 민성', hash: '' });
    expect(errors.calls.filter((c) => c.method === 'PUT')).toEqual([]);   // 계정에 이미 팀이 있으면 덮어쓰지 않는다
    expect(errors).toEqual([]);
  });

  test('카카오 로그인에서 돌아올 때: 취소했거나 확인값이 다르면 로그인하지 않는다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => localStorage.setItem('walkoff.loginNonce', 'nabc12345678'));
    await loginReturn(page, '?seed=42', 'nabc12345678', { error: 'canceled' });
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, toast: walkoff.game.toast?.text, nonce: localStorage.getItem('walkoff.loginNonce') })))
      .toEqual({ token: null, toast: '카카오 로그인을 취소했어요', nonce: null });
    await page.evaluate(() => localStorage.setItem('walkoff.loginNonce', 'nabc12345678'));
    await loginReturn(page, '?seed=42', 'nabc12345678', { error: 'server_error' });   // 취소가 아닌 실패
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, toast: walkoff.game.toast?.text, nonce: localStorage.getItem('walkoff.loginNonce') })))
      .toEqual({ token: null, toast: '카카오 로그인을 하지 못했어요. 잠시 뒤 다시 해 주세요', nonce: null });
    await page.evaluate(() => localStorage.setItem('walkoff.loginNonce', 'nabc12345678'));
    await loginReturn(page, '?seed=42', 'nother1234567', { stored: 'nabc12345678' });   // 다른 사람이 만든 로그인 주소
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, session: localStorage.getItem('walkoff.session'), hash: location.hash })))
      .toEqual({ token: null, session: null, hash: '' });
    expect(errors.calls.filter((c) => c.path === '/me')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('다음 판 시드를 받다가 로그인이 풀린 것을 알면(서버 401) 로그아웃하고 알린다', async ({ page }) => {
    const errors = await open(page, '', { login: true, api: { seedExpired: true } });
    await expect.poll(() => page.evaluate(() => walkoff.game.toast?.text)).toBe('로그인이 풀렸어요. 메뉴에서 다시 로그인해 주세요');
    expect(await page.evaluate(() => ({ loggedIn: walkoff.loggedIn(), session: localStorage.getItem('walkoff.session'), ready: walkoff.seedTicket.ready })))
      .toEqual({ loggedIn: false, session: null, ready: null });
    expect(seedCalls(errors).length).toBe(1);
    expect(errors).toEqual([]);
  });

  test('?api=는 이 컴퓨터 주소만 받는다. 다른 주소를 주면 무시해서 로그인 표가 랭킹 서버 말고는 가지 않는다', async ({ page, isMobile }) => {
    test.skip(isMobile, '주소 검사는 화면 크기와 상관없어서 PC에서만 본다');
    const elsewhere = [], local = [];   // 다른 주소, 이 컴퓨터의 wrangler dev(8787)로 간 요청. 둘 다 가로채서 밖으로 나가지 않는다
    await page.route((url) => url.hostname.endsWith('other.example'), (route) => { elsewhere.push(route.request().url()); return route.abort(); });
    await page.route((url) => url.port === '8787' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'), (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      local.push({ url: req.url(), auth: req.headers().authorization ?? null });
      return route.abort();
    });
    const errors = await open(page, `?api=${encodeURIComponent('https://other.example')}`, { login: true });
    const sent = (p) => errors.calls.some((c) => c.path === p && c.auth === `Bearer ${SESSION}`);
    await expect.poll(() => sent('/me') && sent('/seeds')).toBe(true);   // 열자마자 보내는 계정 확인과 다음 판 시드는 랭킹 서버로 간다
    expect(await page.evaluate(() => walkoff.RANKING_API)).toBe(API);
    for (const raw of ['http://127.0.0.1.other.example:8787', 'https://other.example/?to=http://127.0.0.1:8787', 'not a url']) {
      await page.goto(`${PAGE}?api=${encodeURIComponent(raw)}`);
      await page.waitForFunction(() => !!window.walkoff);
      expect(await page.evaluate(() => walkoff.RANKING_API), raw).toBe(API);
    }
    expect(elsewhere).toEqual([]);
    for (const [raw, used] of [['http://127.0.0.1:8787', 'http://127.0.0.1:8787'], ['http://localhost:8787/', 'http://localhost:8787']]) {   // worker 폴더의 wrangler dev
      await page.goto(`${PAGE}?api=${encodeURIComponent(raw)}`);
      await page.waitForFunction(() => !!window.walkoff);
      expect(await page.evaluate(() => walkoff.RANKING_API), raw).toBe(used);
      await expect.poll(() => local.some((r) => r.url === `${used}/me` && r.auth === `Bearer ${SESSION}`)).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test('로그인하지 않고 친 판은 랭킹에 보내지 않고, 끝 화면에서 로그인해도 그 판은 올리지 않는다(다음 판부터)', async ({ page }) => {
    const errors = await open(page);   // ?seed=42: 첫 공이 스트라이크라 공 하나로 끝난다
    const legacy = { nick: '테스트', team: 'lg', day: await page.evaluate(() => walkoff.today()), score: 9000, lights: 'G', mode: 'challenge', seed: 42 };
    await page.evaluate((b) => walkoff.store.set('pending', b), legacy);   // 예전 게임이 남겨 둔 로그인 전 판(서버 시드가 없다)
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝낸다
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    expect(await page.evaluate(() => walkoff.store.get('pending', null))).toEqual(legacy);   // 방금 친 판은 남기지 않는다
    expect([sentScores(errors), seedCalls(errors)]).toEqual([[], []]);   // 로그인 전에는 시드도 받지 않는다
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 로그인하면 다음 판부터 랭킹에 올라가요 ›'));
    await tap(page, '카카오로 로그인하면 다음 판부터 랭킹에 올라가요 ›');
    await loginReturn(page, '', (await kakaoStart(errors, page)).n);   // 주소에 ?seed=가 없는 게임으로 돌아온다
    await page.waitForFunction(() => walkoff.settings.playerId === 'p-account-0001' && !!walkoff.seedTicket.ready);   // 로그인하면 다음 판 시드를 받아 둔다
    await expect.poll(() => page.evaluate(() => walkoff.store.get('pending', null))).toBe(null);   // 서버 시드 없이 친 판은 보내지 않고 버린다
    expect(sentScores(errors)).toEqual([]);
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, toast: walkoff.game.toast?.text }))).toEqual({ token: SESSION, toast: '카카오로 로그인했어요' });
    expect(errors.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg' }]);   // 새 계정에 팀·닉네임을 올린다
    expect(errors).toEqual([]);
  });

  test('10구 도전도 판이 끝나면 보내고, 이번 주 최고 기록이면 끝 화면에 바로 보인다', async ({ page }) => {
    const api = { scoreReply: 'best' };
    const errors = await open(page, '', { login: true, api });
    const endChallenge = async () => {
      await seedReady(page);
      await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝낸다
      await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
      await page.keyboard.press('Space');
      await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.game.rankInfo?.status === 'ok');
      return page.evaluate(() => ({ score: walkoff.game.score, labels: walkoff.ui.buttons.map((b) => b.label) }));
    };
    const first = await endChallenge();
    // 서버가 내준 시드로 치고, 서버가 그 시드로 공 순서를 다시 만들어 맞춰 볼 수 있게 표(token)를 함께 보낸다
    expect(sentScores(errors).map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg', day: await page.evaluate(() => walkoff.today()), score: first.score, lights: expect.stringMatching(/^[SDTHYR]$/), mode: 'challenge', seed: 42, token: errors.calls.tickets[0].token }]);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주')));
    expect((await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label)))).toContain('이번 주 최고 기록! 3위 · 랭킹 보기 ›');
    api.scoreReply = 'lower';   // 이번에는 이번 주에 더 높은 기록이 있다
    const second = await endChallenge();
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주 최고 ')));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain(`이번 주 최고 ${(second.score + 1000).toLocaleString()}점 · 3위 · 랭킹 보기 ›`);
    expect(sentScores(errors).map((c) => c.body.token)).toEqual(errors.calls.tickets.slice(0, 2).map((t) => t.token));   // 판마다 새 시드
    expect(errors).toEqual([]);
  });

  // 끝 화면 '최고 기록'(2026-11-05 사용자 결정 '계정 기준으로'): 로그인했으면 계정 역대 최고와 견주고 /scores 답의 allTime으로 고친다
  const holdScores = async (page) => {   // /scores 답을 풀 때까지 잡아 둔다
    let release;
    const held = new Promise((done) => { release = done; });
    await page.route(`${API}/scores`, async (route) => { if (route.request().method() !== 'OPTIONS') await held; await route.fallback(); });
    return release;
  };
  const endOnePitch = async (page) => {   // 서버 시드 42의 첫 공을 정확히 쳐서(홈런) 공 하나로 끝낸다
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    return page.evaluate(() => walkoff.game.score);
  };

  test("끝 화면 '최고 기록'은 로그인했으면 계정 역대 최고다: 다른 기기에서 더 높게 쳤으면 이 기기 기록을 넘어도 '새 최고 기록!'이 안 뜬다", async ({ page }) => {
    const errors = await open(page, '', { login: true, api: { account: { allTime: 50000 } } });   // 다른 기기에서 친 50,000점
    await page.evaluate(() => walkoff.store.set('accountBest', { week: walkoff.weekStartOf(walkoff.today()), best: null, allTime: 500 }));   // 남겨 둔 값은 그 판을 치기 전
    await seedReady(page);
    const release = await holdScores(page);
    const score = await endOnePitch(page);
    expect(score).toBeGreaterThan(500);
    const waiting = await drawnTexts(page);
    expect(waiting).toContain('최고 기록 확인 중…');   // 남겨 둔 값을 넘었으면 서버 답까지 기다린다
    expect(waiting.join(' ')).not.toContain('새 최고 기록');
    release();
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    const after = await drawnTexts(page);
    expect(after).toContain(`최고 기록 50,000점 · +${Math.floor(score / 100)}코인`);
    expect(after.join(' ')).not.toContain('새 최고 기록');
    expect(await page.evaluate(() => walkoff.shareText(walkoff.game.summary))).not.toContain('새 최고 기록');
    expect(await page.evaluate(() => [walkoff.store.get('best', 0), walkoff.allTimeBest()])).toEqual([score, 50000]);   // 이 기기 값은 남기고, 메뉴 '역대'는 계정 값
    expect(errors).toEqual([]);
  });

  test("끝 화면 '최고 기록': 계정 역대 최고를 넘으면 서버 답 뒤에 '새 최고 기록!'이고 공유 글에도 붙는다. 로그인 안 했으면 이 기기 최고와 견준다", async ({ page }) => {
    const errors = await open(page, '', { login: true, api: { account: { allTime: 300 } } });
    await seedReady(page);
    const release = await holdScores(page);
    const score = await endOnePitch(page);
    expect(await drawnTexts(page)).toContain('최고 기록 확인 중…');   // 계정 값을 아직 모른다(메뉴를 안 열었다)
    release();
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(await drawnTexts(page)).toContain(`새 최고 기록! · +${Math.floor(score / 100)}코인`);
    expect(await page.evaluate(() => walkoff.shareText(walkoff.game.summary))).toContain(`${score.toLocaleString()}점 · 새 최고 기록`);
    // 로그인 안 했으면(?seed=42 판) 이 기기 최고와 견준다: 같은 점수는 새 기록이 아니다
    await page.evaluate(() => { walkoff.store.remove('session'); walkoff.store.set('best', 100); });
    await page.goto(PAGE + '?seed=42');
    await page.waitForFunction(() => !!window.walkoff && !walkoff.loggedIn());
    expect(await endOnePitch(page)).toBe(score);
    expect(await drawnTexts(page)).toContain('새 최고 기록!');
    await page.evaluate(() => walkoff.goTitle());
    expect(await endOnePitch(page)).toBe(score);
    expect(await drawnTexts(page)).toContain(`최고 기록 ${score.toLocaleString()}점`);
    expect(errors).toEqual([]);
  });

  // 칭호(2026-11-05): 공 하나로 끝내는 판(endOnePitch)은 첫 공 홈런이라 '첫 홈런'을 받는다(남은 기회를 줄인 시험 판이라 끝내기 찬스는 아니다)
  test("칭호: 로그인했으면 서버가 정한 새 칭호를 끝 화면 위 띠로 띄우고(같은 칭호는 한 번), 메뉴 카드 닉네임 옆에 대표 칭호, 메뉴 '칭호' 화면에 받은 것과 조건을 보인다", async ({ page }) => {
    const errors = await open(page, '', { login: true });
    await seedReady(page);
    await endOnePitch(page);
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(sentScores(errors)[0].body.lights).toBe('H');   // 안타 종류를 담아 보낸다
    expect(await drawnTexts(page)).toContain('새 칭호: 첫 홈런!');
    await page.evaluate(() => walkoff.openMenu());
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '칭호'));
    expect(await drawnTexts(page)).toEqual(expect.arrayContaining(['첫 홈런', '1 / 50']));   // 닉네임 옆 배지와 '칭호' 줄의 값
    await tap(page, '칭호');
    expect(await drawnTexts(page)).toEqual(expect.arrayContaining(['칭호', '1 / 50 · 받은 칭호 가운데 등급이 가장 높은 것이 랭킹에 보여요', '전설 · 0 / 15', '보통 · 1 / 4', '첫 홈런', '홈런 1번', '받음',
      '홈런왕', '홈런 2,000개', '1 / 2,000', '⭐야구의신⭐', '끝내기 홈런', '아웃왕', '0 / 200']));   // 서버가 쌓은 수(홈런 1개)로 얼마나 남았는지
    await page.keyboard.press('Escape');
    await seedReady(page);
    await endOnePitch(page);   // 같은 칭호는 다시 '새 칭호'로 띄우지 않는다
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect((await drawnTexts(page)).some((t) => t.startsWith('새 칭호'))).toBe(false);
    expect(await page.evaluate(() => walkoff.store.get('accountTitles', null))).toEqual(['firsthr']);
    expect(errors).toEqual([]);
  });

  test('칭호: 로그인 안 했으면 이 기기에서 정해 끝 화면 위에 띄우고 칭호 화면에 보인다(랭킹에는 계정 칭호만)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await endOnePitch(page);
    expect(await drawnTexts(page)).toContain('새 칭호: 첫 홈런!');
    expect(await page.evaluate(() => walkoff.store.get('titles', null))).toEqual(['firsthr']);
    await page.evaluate(() => walkoff.openMenu());
    await tap(page, '칭호');
    expect(await drawnTexts(page)).toEqual(expect.arrayContaining(['1 / 50 · 로그인하면 칭호가 랭킹에 보여요', '첫 홈런', '1 / 2,000']));
    expect(await page.evaluate(() => walkoff.store.get('titleCounts', null))).toMatchObject({ hr: 1, firstHr: 1 });   // 이 기기에 쌓는다
    await page.evaluate(() => walkoff.goTitle());
    await endOnePitch(page);
    expect((await drawnTexts(page)).some((t) => t.startsWith('새 칭호'))).toBe(false);   // 이미 받은 칭호
    expect(errors).toEqual([]);
  });

  test('칭호(2026-11-06 쌓아서 받기): 한 판으로 받던 옛 칭호는 한 번만 지우고(첫 홈런만 남김), 50개 칭호 화면은 넘치면 끌어 넘기며 쌓은 수가 정한 수에 닿으면 받는다', async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('walkoff.titleRules')) localStorage.setItem('walkoff.titles', JSON.stringify(['cycle', 'firsthr', 'outking'])); });
    const errors = await open(page, '?seed=42');
    expect(await page.evaluate(() => [walkoff.store.get('titles', null), walkoff.store.get('titleRules', null)])).toEqual([['firsthr'], 2]);
    await page.evaluate(() => walkoff.store.set('titles', ['firsthr', 'eye']));   // 지운 뒤에 받은 칭호는 다시 지우지 않는다
    await reloadUntil(page, () => walkoff.store.get('titles', []).includes('eye'));
    expect(await page.evaluate(() => walkoff.store.get('titles', null))).toEqual(['firsthr', 'eye']);
    // 홈런 1,999개 쌓인 기기에서 홈런 한 판: 홈런 공장장(1,000)은 이미 닿았고 홈런왕(2,000)에 닿는다
    await page.evaluate(() => walkoff.store.set('titleCounts', { hr: 1999 }));
    await endOnePitch(page);
    expect(await page.evaluate(() => walkoff.store.get('titles', null))).toEqual(['hrking', 'factory', 'eye', 'firsthr']);   // 등급 순서
    expect((await drawnTexts(page)).some((t) => t.startsWith('새 칭호') && t.includes('홈런왕') && t.includes('홈런 공장장'))).toBe(true);
    await page.evaluate(() => { walkoff.goTitle(); walkoff.openMenu(); });
    await tap(page, '칭호');
    await page.waitForFunction(() => walkoff.game.state === 'titles' && walkoff.titleList.key === 'titles');
    await expect.poll(() => page.evaluate(() => walkoff.titleList.max)).toBeGreaterThan(500);   // 50줄은 어느 화면에도 다 안 들어간다
    await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 100000, cancelable: true })));
    expect(await page.evaluate(() => walkoff.titleList.scroll === walkoff.titleList.max)).toBe(true);
    await tap(page, '처음으로');   // 넘칠 때는 뗄 때 누른다
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
    expect(errors).toEqual([]);
  });

  test('칭호: 랭킹 줄에 대표 칭호 배지(폰은 이름 뒤에 자리가 있을 때만), 사람을 누르면 칭호 이름이 맨 앞에 나온다', async ({ page }) => {
    const rankings = { ...SAMPLE_RANKING, players: [{ ...SAMPLE_RANKING.players[0], title: 'hrking' }, { ...SAMPLE_RANKING.players[1], title: null }] };
    const errors = await open(page, '?seed=42', { api: { rankings } });
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 줄 1'));
    const texts = await drawnTexts(page);
    expect(texts).toContain('홈런왕');   // 2~4글자 배지
    expect(texts.filter((t) => ['사이클', '끝내기', '선구안', '첫 홈런', '아웃왕'].includes(t))).toEqual([]);   // 칭호가 없는 사람은 배지가 없다
    await tap(page, '랭킹 줄 1');
    await page.waitForTimeout(150);
    expect((await drawnTexts(page)).some((t) => t.startsWith('홈런왕 · '))).toBe(true);
    expect(errors).toEqual([]);
  });

  // 끝내기 상황 한 판을 끝까지 친다(공마다 공이 오는 때에 휘두르고, 결과가 나오면 다음 공). 끝날 때의 요약과 남긴 moves를 돌려준다
  const playScenario = (page) => page.evaluate(() => {
    const w = walkoff, g = w.game;
    w.startGame('scenario'); w.paused = true;
    for (let k = 0; k < 120000 && g.state !== 'over'; k++) {
      if (g.state === 'pitch' && g.swingAt == null) { const p = g.seq[g.i]; if (w.ballTime() + 1 / 60 >= p.T) w.swing(g.clockAt + Math.max(0, p.T - w.ballTime()) * 1000); }
      if (g.state === 'result' && g.resultT > g.revealAt + 1.5 && g.flightT > (g.outcome.hit ? w.fieldPlay(g.outcome).end + 1 : 0)) w.tap(g.clockAt);
      g.clockAt += 1000 / 60; w.update(1 / 60);
    }
    w.paused = false;
    return { state: g.state, end: g.summary?.end, score: g.summary?.score, moves: g.moves.slice(), pitches: g.seq.length, token: g.ticket?.token ?? null };
  });
  const sentScenarios = (errors) => errors.calls.filter((c) => c.method === 'POST' && c.path === '/scenario');

  test('끝내기 코인: 로그인하고 친 끝내기는 서버 시드로 치고, 끝나면 공마다 휘두른 때를 보내 서버가 다시 돌린 끝·점수가 게임과 같고, 받은 코인이 끝 화면과 지갑에 들어간다', async ({ page }) => {
    const errors = await open(page, '', { login: true });
    await seedReady(page);
    const g = await playScenario(page);
    expect(g.state).toBe('over');
    expect(g.token).toBe(errors.calls.tickets[0].token);
    expect(g.moves).toHaveLength(g.pitches);   // 공마다 하나(휘두르면 ms, 지켜보면 null)
    await page.waitForFunction(() => walkoff.game.scnCoin?.status === 'ok');
    expect(sentScenarios(errors).map((c) => c.body)).toEqual([{ token: g.token, bats: 'R', moves: g.moves }]);
    // 가짜 서버는 실제 서버 코드(replayScenario)로 판을 다시 돌려 끝·점수를 정한다. 게임과 다르면 replay_mismatch로 거절해 status가 ok가 안 된다
    const { replayScenario, WIN_BONUS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'scenario.js')).href), rep = replayScenario(42, g.moves, 'R');
    expect(rep).toMatchObject({ end: g.end, points: g.score });
    const bonus = g.end === 'win' ? WIN_BONUS[rep.k] : 0, earned = Math.floor(g.score / 100) + bonus;
    expect(await page.evaluate(() => ({ coin: walkoff.game.scnCoin, wallet: walkoff.wallet.coins }))).toEqual({ coin: { status: 'ok', earned, bonus }, wallet: earned });
    const texts = await drawnTexts(page);
    expect(texts).toContain(`점수 ${g.score.toLocaleString()} · +${earned}코인${bonus ? ` (승리 보너스 ${bonus})` : ''}`);
    expect(errors).toEqual([]);
  });

  test('끝내기 코인: 서버 오류면 남겨 두고 다음에 열 때 다시 보낸다. 로그인 안 하고 친 판은 보내지 않고 로그인하라는 줄', async ({ page }) => {
    const api = { scenarioFail: true };
    const errors = await open(page, '', { login: true, api });
    await seedReady(page);
    const g = await playScenario(page);
    await page.waitForFunction(() => walkoff.game.scnCoin?.status === 'error');
    expect(await drawnTexts(page)).toContain(`점수 ${g.score.toLocaleString()} · 연결하지 못해 다음에 열 때 보낼게요`);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('walkoff.scnPending')))).toEqual({ token: g.token, bats: 'R', moves: g.moves });
    api.scenarioFail = false;
    await page.reload(); await page.waitForFunction(() => !!window.walkoff);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('walkoff.scnPending'))).toBeNull();
    expect(sentScenarios(errors).map((c) => c.body.token)).toEqual([g.token, g.token]);
    const { replayScenario, WIN_BONUS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'scenario.js')).href), rep = replayScenario(42, g.moves, 'R');
    expect(await page.evaluate(() => walkoff.wallet.coins)).toBe(Math.floor(g.score / 100) + (rep.end === 'win' ? WIN_BONUS[rep.k] : 0));
    // 로그아웃하고 친 판: 시드를 받지 않고 보내지 않는다
    await page.evaluate(() => { localStorage.removeItem('walkoff.session'); });
    await page.reload(); await page.waitForFunction(() => !!window.walkoff);
    const before = sentScenarios(errors).length, h = await playScenario(page);
    expect(h.token).toBeNull();
    expect(sentScenarios(errors)).toHaveLength(before);
    expect(await drawnTexts(page)).toContain(`점수 ${h.score.toLocaleString()} · 카카오로 로그인하면 코인을 받아요 ›`);
    expect(errors).toEqual([]);
  });

  test("새 소식: 처음 온 사람은 표시가 없고, 쳐 본 사람은 '≡ 메뉴'에 NEW가 떴다가 읽으면 사라지며, 더 새 소식이 오면 다시 뜬다", { tag: '@min' }, async ({ page }) => {
    const errors = await open(page);   // 처음 온 사람(이 기기에 친 기록이 없음)
    expect(await page.evaluate(() => ({ unread: walkoff.newsUnread(), seen: localStorage.getItem('walkoff.newsSeen') === walkoff.NEWS[0].id }))).toEqual({ unread: false, seen: true });
    // 쳐 본 사람이 처음 이 기능을 만나면(읽은 기록 없음) 첫 소식부터 점이 뜬다
    await page.evaluate(() => { localStorage.removeItem('walkoff.newsSeen'); localStorage.setItem('walkoff.best', '1500'); });
    await reloadUntil(page, () => walkoff.newsUnread());
    await page.evaluate(() => { walkoff.game.state = 'menu'; });
    await expect.poll(() => page.evaluate(() => walkoff.ui.buttons.some((b) => b.label === '새 소식'))).toBe(true);   // 메뉴 맨 위 카드 아래 띠
    await page.evaluate(() => walkoff.ui.buttons.find((b) => b.label === '새 소식').onTap());
    const n = await page.evaluate(() => walkoff.NEWS[0]), texts = await drawnTexts(page);
    expect(texts).toContain('새 소식');
    expect(texts).toContain(n.label);
    expect(await page.evaluate(() => ({ state: walkoff.game.state, unread: walkoff.newsUnread() }))).toEqual({ state: 'news', unread: false });
    // 작은 폰(360×640)에서는 소식이 화면보다 길어 휠·끌어 올리기로 넘긴다(끝까지만)
    await page.setViewportSize({ width: 360, height: 640 });
    await expect.poll(() => page.evaluate(() => walkoff.news.max)).toBeGreaterThan(100);
    await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true })));
    expect(await page.evaluate(() => walkoff.news.scroll)).toBe(120);
    await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 5000, cancelable: true })));
    expect(await page.evaluate(() => walkoff.news.scroll === walkoff.news.max)).toBe(true);
    const box = await page.locator('canvas').boundingBox();   // 끌어 내리면 다시 위로(맨 위에서 더 끌어도 0). 넘길 길이는 글꼴과 소식 수에 따라 450px를 넘을 수 있어 세 번 끈다(CI 우분투 글꼴에서 608px)
    for (let i = 0; i < 3; i++) { await page.mouse.move(box.x + 180, box.y + 150); await page.mouse.down(); await page.mouse.move(box.x + 180, box.y + 600, { steps: 6 }); await page.mouse.up(); }
    expect(await page.evaluate(() => ({ scroll: walkoff.news.scroll, state: walkoff.game.state }))).toEqual({ scroll: 0, state: 'news' });
    await page.reload(); await page.waitForFunction(() => !!window.walkoff);
    expect(await page.evaluate(() => walkoff.newsUnread())).toBe(false);   // 읽은 기록은 남는다
    await page.evaluate(() => walkoff.NEWS.unshift({ id: '2099-01-01', label: '1/1', items: ['더 새 소식'] }));   // 다음 업데이트
    expect(await page.evaluate(() => walkoff.newsUnread())).toBe(true);
    expect(errors).toEqual([]);
  });

  test("메뉴 단추: 시작 화면 오른쪽 위 '≡ 메뉴'(누르는 자리 48px)는 안 읽은 새 소식이 있을 때만 NEW를 달고, 메뉴를 한 번도 안 연 쳐 본 사람에게만 말풍선을 띄운다(누르면 메뉴, 열면 사라짐)", async ({ page }) => {
    const BUBBLE = '끝내기 상황·연습·랭킹은 여기 있어요';
    const errors = await open(page);   // 처음 온 사람: NEW도 말풍선도 없다
    const title = () => page.evaluate(() => ({ labels: walkoff.ui.buttons.map((b) => b.label), menu: walkoff.ui.buttons.find((b) => b.label === '메뉴')?.r, bubble: walkoff.ui.buttons.find((b) => b.label === '메뉴 안내')?.r ?? null, w: walkoff.view.w }));
    let t = await title(), texts = await drawnTexts(page);
    expect(t.bubble).toBe(null);
    expect(texts).toContain('메뉴');
    expect(texts.some((s) => s === 'NEW' || s === BUBBLE)).toBe(false);
    expect(t.menu.h).toBeGreaterThanOrEqual(48);   // 손가락으로 누르기 좋게
    expect(t.menu.x + t.menu.w).toBeLessThanOrEqual(t.w);
    expect(t.menu.x).toBeGreaterThan(t.w * 0.6);   // 오른쪽 위
    // 쳐 본 사람(최고 기록이 있음)이 아직 안 읽은 소식이 있고 메뉴를 한 번도 안 열었으면
    await page.evaluate(() => { localStorage.setItem('walkoff.best', '1500'); localStorage.setItem('walkoff.newsSeen', '2026-01-01'); });
    await reloadUntil(page, () => walkoff.newsUnread() && walkoff.ui.buttons.some((b) => b.label === '메뉴 안내'));
    t = await title(); texts = await drawnTexts(page);
    expect(texts).toEqual(expect.arrayContaining(['NEW', BUBBLE]));
    expect(t.bubble.y).toBeGreaterThanOrEqual(t.menu.y + t.menu.h);   // 단추 아래, 누르는 자리가 안 겹친다
    await tap(page, '메뉴 안내');   // 말풍선을 눌러도 메뉴
    await expect.poll(() => page.evaluate(() => [walkoff.game.state, localStorage.getItem('walkoff.menuSeen')])).toEqual(['menu', '1']);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => walkoff.game.state === 'title');
    texts = await drawnTexts(page);
    expect(texts).toContain('NEW');               // 소식은 아직 안 읽었다
    expect(texts).not.toContain(BUBBLE);          // 말풍선은 한 번 열면 다시 안 뜬다
    await page.reload(); await page.waitForFunction(() => !!window.walkoff);
    expect(await page.evaluate(() => walkoff.ui.buttons.some((b) => b.label === '메뉴 안내'))).toBe(false);
    await tap(page, '메뉴');
    await tap(page, '새 소식');
    await tap(page, '메뉴로');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => walkoff.game.state === 'title');
    expect(await drawnTexts(page)).not.toContain('NEW');   // 읽으면 사라진다
    expect(errors).toEqual([]);
  });

  test('메뉴 화면: 내 정보 카드(팀·닉네임·최고 기록·코인)와 새 소식 띠, 놀기·기록·내 것·설정 묶음의 줄마다 원래 화면으로 가고, 닫기(X)·Esc로 닫는다', { tag: '@min' }, async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true, api: { account: { coins: 1250, allTime: 17600 } } });   // 계정 역대 최고는 다른 기기에서 친 17,600
    await page.evaluate(() => localStorage.setItem('walkoff.best', '5200'));
    await page.waitForFunction(() => walkoff.wallet.coins === 1250);
    await tap(page, '메뉴');
    await page.waitForFunction(() => walkoff.game.state === 'menu' && walkoff.store.get('accountBest', null)?.allTime === 17600);
    const texts = await drawnTexts(page);
    for (const s of ['LG', '테스트', '역대 ', '17,600', '1,250', '새 소식', '놀기', '기록', '내 것', '설정', '9회말 역전 승부', '구종 골라 치기', '역대 최고 17,600', '내 순위 보기', 'LG · 테스트', '코인 1,250', '카카오 로그인됨', '0ms']) expect(texts, s).toContain(s);
    expect(texts).not.toContain('5,200');   // 로그인했으면 이 기기 최고가 아니라 계정 기록
    expect(texts).not.toContain('이번 주 ');   // 이번 주 기록이 없으면 칩을 감춘다
    expect(texts.some((s) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s))).toBe(false);   // 이모지는 쓰지 않는다
    const go = async (label) => {   // 메뉴를 다시 열고 그 줄을 누른 뒤 간 화면
      await page.evaluate(() => { walkoff.goTitle(); walkoff.openMenu(); });
      await tap(page, label);
      return page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }));
    };
    expect(await go('기록')).toMatchObject({ state: 'records' });
    expect(await go('이번 주 랭킹')).toMatchObject({ state: 'ranking' });
    expect(await go('팀·닉네임')).toMatchObject({ state: 'onboard' });
    expect(await go('상점 · 내 물건')).toMatchObject({ state: 'shop' });
    expect(await go('내 계정')).toMatchObject({ state: 'account' });
    expect(await go('타이밍 보정 0ms')).toMatchObject({ state: 'calib' });
    expect(await go('새 소식')).toMatchObject({ state: 'news' });
    expect(await go('연습')).toMatchObject({ state: 'windup', mode: 'practice' });
    expect(await go('닫기')).toMatchObject({ state: 'title' });
    await page.evaluate(() => { walkoff.goTitle(); walkoff.openMenu(); });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
    expect(errors).toEqual([]);
  });

  test('의견 보내기: 메뉴 줄과 조준 판 끝 화면 링크가 패들렛을 새 탭으로 열고(게임 탭은 그대로, 폰은 손가락을 뗄 때), 10구 끝 화면에는 링크가 없다', async ({ page, isMobile }) => {
    const FEEDBACK = 'https://padlet.com/ghtgrz4s5s/walkoff-s02561vkamvtbvubw2oe';
    await page.context().route('https://padlet.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>padlet</title>' }));   // 실제 패들렛에는 가지 않는다
    const errors = await open(page);
    const popups = [];
    page.on('popup', (p) => popups.push(p));
    const rect = (label) => page.evaluate((l) => walkoff.ui.buttons.find((b) => b.label === l)?.r, label);
    const opened = async (act) => {   // act로 연 새 탭의 주소. 게임 탭은 그 화면 그대로다
      const [popup] = await Promise.all([page.waitForEvent('popup'), act()]);
      await popup.waitForLoadState();
      const url = popup.url();
      await popup.close();
      popups.length = 0;
      return url;
    };
    const touchEv = (type, x, y) => page.evaluate(({ type, x, y }) => document.querySelector('canvas').dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: x, clientY: y })), { type, x, y });
    const openLink = async (label) => {   // PC는 클릭, 폰은 누를 때는 안 열고(브라우저가 터치를 누를 때 연 새 탭은 막는다) 링크 위에서 뗄 때 연다
      const r = await rect(label);
      if (!isMobile) return opened(() => tap(page, label));
      await touchEv('pointerdown', r.x + r.w / 2, r.y + r.h / 2);
      await page.waitForTimeout(300);
      await touchEv('pointerup', r.x + r.w / 2, r.y - 60);   // 끌어서 링크 밖에서 떼면 안 연다
      await page.waitForTimeout(300);
      expect(popups, label).toEqual([]);
      return opened(() => page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2));
    };
    // 메뉴: 새 소식 띠 바로 아래 '의견 보내기' 띠(만든 사람 한마디와 바깥 화살표)
    await page.evaluate(() => walkoff.openMenu());
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '의견 보내기'));
    expect(noteShown(await drawnTexts(page)), '만든 사람 한마디가 잘리지 않고 다 보인다').toBe(true);
    expect(await openLink('의견 보내기')).toBe(FEEDBACK);
    expect(await page.evaluate(() => walkoff.game.state)).toBe('menu');
    // 끝 화면: 10구에는 없고 조준 판에만 있다(공 하나로 끝나는 판)
    const finish = async (aim) => {
      await page.evaluate((aim) => { walkoff.startGame('challenge', false, { aim }); Object.assign(walkoff.game, { left: 1, extra: 99 }); }, aim);
      await page.waitForFunction(() => walkoff.game.state === 'pitch');
      await pressAt(page, 0);
      await page.waitForFunction(() => walkoff.game.state === 'result');
      await page.evaluate(() => { const g = walkoff.game; g.resultT = Math.max(g.resultT, g.revealAt) + 1; walkoff.tap(g.clockAt); });
      await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.ui.buttons.some((b) => b.label === '처음으로'));
      return page.evaluate(() => walkoff.ui.buttons.filter((b) => b.href).map((b) => [b.label, b.href]));
    };
    expect(await finish(false)).toEqual([]);
    expect(await finish(true)).toEqual([['조준 타격 어땠나요? 의견 보내기', FEEDBACK]]);
    expect(await openLink('조준 타격 어땠나요? 의견 보내기')).toBe(FEEDBACK);
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.aim])).toEqual(['over', true]);
    expect(errors).toEqual([]);
  });

  test("메뉴 칩 '이번 주'는 랭킹과 같은 숫자다: 로그인 안 했으면 이 기기에서 이번 주에 끝낸 10구 최고(?seed= 판·조준 판은 빼고), 로그인했으면 서버가 돌려준 이번 주 최고. 주가 바뀌면 감춘다", async ({ page }) => {
    const play = (aim = false) => page.evaluate((aim) => {   // 공 하나로 끝나는 판(seed 42 첫 공을 정확히 치면 홈런 1,100점)
      walkoff.startGame('challenge', false, { aim }); Object.assign(walkoff.game, { left: 1, extra: 99 }); walkoff.game.seq[0] = walkoff.makeSequence(42, false)[0];
    }, aim);
    const finish = async () => {
      await page.waitForFunction(() => walkoff.game.state === 'pitch');
      await pressAt(page, 0);
      await page.waitForFunction(() => walkoff.game.state === 'result');
      await page.evaluate(() => { const g = walkoff.game; g.resultT = Math.max(g.resultT, g.revealAt) + 1; walkoff.tap(g.clockAt); });
      await page.waitForFunction(() => walkoff.game.state === 'over');
    };
    const chips = async () => { await page.evaluate(() => walkoff.openMenu()); await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '새 소식')); return drawnTexts(page); };
    const errors = await open(page, '');   // ?seed= 없이(무작위 공 순서)
    await play(); await finish();
    const score = await page.evaluate(() => walkoff.game.summary.score);
    expect(score).toBeGreaterThan(0);
    expect(await page.evaluate(() => walkoff.weekBest())).toBe(score);
    expect(await chips()).toEqual(expect.arrayContaining(['이번 주 ', score.toLocaleString(), '역대 ']));
    await play(true); await page.evaluate(() => { walkoff.game.seq[0] = walkoff.makeSequence(42, false)[0]; }); await page.mouse.move(1, 1);
    await page.evaluate(() => walkoff.store.set('weekBest', { week: walkoff.weekStartOf(walkoff.today()), best: 10 }));
    await finish();   // 조준 판은 세지 않는다
    expect(await page.evaluate(() => walkoff.weekBest())).toBe(10);
    await page.evaluate(() => walkoff.store.set('weekBest', { week: '2026-10-26', best: 9999 }));   // 지난주 기록
    expect(await page.evaluate(() => walkoff.weekBest())).toBe(null);
    expect(await chips()).not.toContain('이번 주 ');
    expect(errors).toEqual([]);
  });

  test("메뉴 칩 '이번 주': ?seed=로 공 순서를 정한 판은 세지 않는다", async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => [walkoff.game.fixedSeed, walkoff.game.recorded, walkoff.weekBest()])).toEqual([true, true, null]);
    expect(errors).toEqual([]);
  });

  test("메뉴 칩 '이번 주': 로그인했으면 서버가 돌려준 이번 주 최고(다른 기기 포함, 랭킹과 같은 숫자)로 맞춘다", async ({ page }) => {
    const errors = await open(page, '', { login: true, api: { scoreReply: 'lower' } });   // 서버에는 이 판보다 1,000점 높은 이번 주 기록이 있다
    await page.waitForFunction(() => walkoff.seedTicket.ready);
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    await expect.poll(() => page.evaluate(() => walkoff.game.rankInfo?.status)).toBe('ok');
    const r = await page.evaluate(() => ({ score: walkoff.game.summary.score, wb: walkoff.weekBest(), me: walkoff.game.rankInfo.me.best }));
    expect(r.wb).toBe(r.me);
    expect(r.wb).toBe(r.score + 1000);
    expect(errors).toEqual([]);
  });

  test("메뉴 '이번 주'·'역대'와 기록 화면: 로그인했으면 계정 기록(서버)만 보인다. 이 기기 최고가 더 높아도 계정 값, 받은 적이 없으면 감추고, 실패·429면 남겨 둔 값, 로그아웃하면 이 기기 값. 두 번째 기기도 계정 ID로 묻는다", async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('walkoff.playerId')) localStorage.setItem('walkoff.playerId', JSON.stringify('p-device-9999')); });   // 이 기기 ID(계정과 다르다)
    const errors = await open(page, '?seed=42', { login: true, api: { account: { coins: 10, allTime: 17600 } } });
    await page.waitForFunction(() => walkoff.wallet.coins === 10 && walkoff.settings.playerId === 'p-account-0001');   // 로그인하면 계정 ID를 이어 쓴다
    const week = await page.evaluate(() => walkoff.weekStartOf(walkoff.today()));
    await page.unroute(`${API}/**`);   // 이번 주 기록이 12,000인 계정으로 다시 띄운다
    const calls = await mockApi(page, { account: { allTime: 17600 }, rankings: { ...EMPTY_RANKING, week, me: { rank: 2, best: 12000, days: 1, team: 'lg' } } });
    await page.evaluate(() => { walkoff.store.set('best', 30000); walkoff.store.set('weekBest', { week: walkoff.weekStartOf(walkoff.today()), best: 30000 }); });   // 이 기기 기록이 더 높다(로그인 전 판 등)
    const chips = async () => { await page.waitForTimeout(50); return (await drawnTexts(page)).filter((s) => /^\d{1,3}(,\d{3})*$/.test(s) || ['이번 주 ', '역대 '].includes(s)); };
    await page.evaluate(() => walkoff.openMenu());
    await page.waitForFunction(() => walkoff.store.get('accountBest', null)?.allTime === 17600);
    expect(calls.filter((c) => c.path === '/rankings').map((c) => c.query.player)).toEqual(['p-account-0001']);   // 계정 ID로 물었다
    expect(await chips()).toEqual(expect.arrayContaining(['이번 주 ', '12,000', '역대 ', '17,600']));
    expect(await chips()).not.toContain('30,000');
    await page.evaluate(() => { walkoff.game.state = 'records'; });
    expect(await drawnTexts(page)).toContain('17,600점');   // 기록 화면도 계정 역대 최고
    // 1분 안에 다시 열면 묻지 않는다. 랭킹 화면은 늘 새로 묻는데, 서버가 429면 남겨 둔 값 그대로
    await page.evaluate(() => { walkoff.goTitle(); walkoff.openMenu(); });
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.path === '/rankings')).toHaveLength(1);
    await page.route(`${API}/rankings**`, (route) => route.fulfill({ status: 429, headers: CORS, contentType: 'application/json', body: '{"ok":false,"error":"rate_limited"}' }));
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'error');
    expect(await page.evaluate(() => walkoff.store.get('accountBest', null))).toEqual({ week, best: 12000, allTime: 17600 });
    await page.unroute(`${API}/rankings**`);
    // 로그아웃하면 이 기기 값
    await page.evaluate(() => walkoff.openAccount());
    await tap(page, '로그아웃');
    await page.evaluate(() => walkoff.openMenu());
    expect(await chips()).toEqual(expect.arrayContaining(['이번 주 ', '30,000', '역대 ']));
    expect(await chips()).not.toContain('17,600');
    expect(errors).toEqual([]);
  });

  test("메뉴 '역대': 로그인했는데 계정 값을 아직 못 받았으면(서버 오류) 이 기기 값을 잠깐 보이지 않고 칩을 감춘다", async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true, api: { fail: true } });
    await page.evaluate(() => { walkoff.store.set('best', 30000); walkoff.store.remove('accountBest'); walkoff.openMenu(); });
    await expect.poll(() => errors.calls.some((c) => c.path === '/rankings')).toBe(true);
    await page.waitForTimeout(200);
    const texts = await drawnTexts(page);
    expect(texts).not.toContain('역대 ');
    expect(texts).not.toContain('30,000');
    expect(texts).toContain('아직 없음');   // 기록 줄
    expect(errors).toEqual([]);
  });

  test('메뉴 크기: 390×844·1440×900·1920×1080에서 줄이 화면 안이고 안 겹치며 시작 화면 코인과 메뉴 단추도(360×640도) 안 겹친다. 더 낮으면(360×640·360×480) 끌어 넘기고, 끄는 동안에는 줄이 안 눌린다', async ({ page, isMobile }) => {
    test.skip(isMobile, '창 크기를 바꿔 가며 보므로 PC에서만 본다');
    const errors = await open(page, '?seed=42', { login: true, api: { account: { coins: 123456 } } });   // 코인 자리가 가장 넓을 때
    await page.waitForFunction(() => walkoff.wallet.coins === 123456);
    const overlaps = (list) => { const out = []; list.forEach((a, i) => list.slice(i + 1).forEach((b) => { if (a.r.x < b.r.x + b.r.w - 0.5 && b.r.x < a.r.x + a.r.w - 0.5 && a.r.y < b.r.y + b.r.h - 0.5 && b.r.y < a.r.y + a.r.h - 0.5) out.push(`${a.label}/${b.label}`); })); return out; };
    const buttons = () => page.evaluate(() => walkoff.ui.buttons.map((b) => ({ label: b.label, r: { ...b.r } })));
    for (const [w, h] of [[360, 640], [390, 844], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => walkoff.goTitle());
      await page.waitForFunction((w) => walkoff.view.w === w && walkoff.ui.buttons.some((b) => b.label === '코인'), w);
      expect(overlaps(await buttons()), `시작 화면 ${w}×${h}`).toEqual([]);
      if (h < 700) continue;   // 360×640 메뉴는 의견 보내기 띠(2026-11-05)가 더해져 조금 넘쳐서 아래에서 끌어 넘겨 본다
      await page.evaluate(() => walkoff.openMenu());
      await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '새 소식'));
      const list = await buttons();
      expect(list.filter((b) => b.r.x < 0 || b.r.y < 0 || b.r.x + b.r.w > w || b.r.y + b.r.h > h).map((b) => b.label), `${w}×${h}`).toEqual([]);
      expect(overlaps(list), `${w}×${h}`).toEqual([]);
      expect(await page.evaluate(() => walkoff.menu.max), `${w}×${h}`).toBe(0);   // 넘기지 않아도 다 들어간다
      expect(list.filter((b) => !['닫기', '새 소식', '의견 보내기'].includes(b.label)).every((b) => b.r.h >= (w < 640 ? 44 : 34)), `${w}×${h}`).toBe(true);   // 폰은 줄을 44px 아래로 줄이지 않는다
    }
    // 작은 폰(실제 브라우저 높이): 줄은 44px 그대로 두고 넘치면 끌어 넘긴다. 아래에 더 있으면 아래, 위로 넘겼으면 위 가장자리가 흐리다
    for (const [w, h] of [[320, 460], [360, 560], [375, 548], [360, 640], [390, 664]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => { walkoff.goTitle(); walkoff.openMenu(); });
      await page.waitForFunction((w) => walkoff.view.w === w && walkoff.ui.buttons.some((b) => b.label === '새 소식'), w);
      await page.waitForTimeout(50);
      const list = await buttons(), rows = list.filter((b) => !['닫기', '새 소식', '의견 보내기'].includes(b.label)), fb = list.find((b) => b.label === '의견 보내기').r;
      expect(rows.every((b) => b.r.h >= 44), `${w}×${h}`).toBe(true);
      expect(fb.y >= 0 && fb.y + fb.h <= h - 40, `${w}×${h} 의견 보내기 띠는 끌지 않아도 다 보인다(아래 흐림 위)`).toBe(true);
      if (w >= 360) expect(noteShown(await drawnTexts(page)), `${w}×${h} 만든 사람 한마디가 두 줄에 다 들어간다`).toBe(true);   // 320은 글꼴(CI 우분투)에 따라 끝이 줄어들 수 있다
      const m = await page.evaluate(() => ({ max: walkoff.menu.max, fade: walkoff.menu.fade }));
      if (m.max === 0) { expect(m.fade, `${w}×${h}`).toEqual({ top: false, bottom: false }); continue; }
      expect(m.fade, `${w}×${h} 처음`).toEqual({ top: false, bottom: true });
      await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 5000, cancelable: true })));
      await page.waitForTimeout(80);
      const end = await page.evaluate(() => ({ at: walkoff.menu.scroll === walkoff.menu.max, fade: walkoff.menu.fade, last: walkoff.ui.buttons.find((b) => b.label.startsWith('타이밍 보정')).r }));
      expect(end.at, `${w}×${h}`).toBe(true);
      expect(end.fade, `${w}×${h} 끝`).toEqual({ top: true, bottom: false });
      expect(end.last.y + end.last.h, `${w}×${h} 마지막 줄이 화면 안`).toBeLessThanOrEqual(h);
    }
    expect(await page.evaluate(() => [walkoff.view.w, walkoff.menu.max])).toEqual([390, 60]);   // 390×664(아이폰 사파리)는 의견 보내기 띠·칭호 줄(2026-11-05)을 더해 한 줄쯤 넘친다(PC라 진동 줄이 없어 10줄)
    await page.setViewportSize({ width: 360, height: 480 });   // 카카오톡 안 브라우저처럼 낮은 폰(PC라 진동 줄이 없어 9줄)
    await expect.poll(() => page.evaluate(() => walkoff.menu.max)).toBeGreaterThan(0);
    const box = await page.locator('canvas').boundingBox(), row = (await buttons()).find((b) => b.label === '연습').r;
    await page.mouse.move(box.x + row.x + 40, box.y + row.y + row.h / 2); await page.mouse.down();
    await page.mouse.move(box.x + row.x + 40, box.y + row.y + row.h / 2 - 200, { steps: 6 }); await page.mouse.up();
    expect(await page.evaluate(() => ({ state: walkoff.game.state, scroll: walkoff.menu.scroll === walkoff.menu.max }))).toEqual({ state: 'menu', scroll: true });   // 끌면 넘어가고 줄은 안 눌린다
    await tap(page, '기록');   // 누르고 바로 떼면 그 줄
    expect(await page.evaluate(() => walkoff.game.state)).toBe('records');
    expect(errors).toEqual([]);
  });

  test('못 보낸 판은 서버 시드로 친 판만, 가장 높은 판 하나만 남겨 둔다(이틀 지난 판과 서버 시드가 없는 판은 버린다)', async ({ page }) => {
    const errors = await open(page);
    const keep = (body) => page.evaluate((b) => { walkoff.keepPending(b); return walkoff.store.get('pending', null)?.score ?? null; }, body);
    const day = await page.evaluate(() => walkoff.today());
    const old = await page.evaluate(() => new Date(Date.now() + 9 * 3600e3 - 3 * 864e5).toISOString().slice(0, 10));
    const body = (score, patch = {}) => ({ nick: '테스트', team: 'lg', day, score, lights: 'G', mode: 'challenge', seed: 42, token: `token-${score}`, ...patch });
    expect(await keep(body(5000, { token: undefined }))).toBe(null);   // 서버 시드를 못 받고 친 판
    expect(await keep(body(5000))).toBe(5000);
    expect(await keep(body(3000))).toBe(5000);   // 낮은 판은 남기지 않는다
    expect(await keep(body(6000))).toBe(6000);
    await page.evaluate((b) => walkoff.store.set('pending', b), body(9000, { day: old }));
    expect(await keep(body(1000))).toBe(1000);   // 서버가 안 받는 사흘 전 판은 버린다
    await page.evaluate((b) => walkoff.store.set('pending', b), body(9000, { token: undefined }));
    expect(await keep(body(1000))).toBe(1000);   // 예전 게임이 남긴 로그인 전 판도 버린다
    expect(sentScores(errors)).toEqual([]);   // 로그인하지 않았으면 보내지 않는다
    expect(errors).toEqual([]);
  });

  test('보내다 서버 오류가 나면 남겨 뒀다가 다음에 열 때 보낸다', async ({ page }) => {
    const api = { scoreFail: true };
    const errors = await open(page, '', { login: true, api });
    await seedReady(page);
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.game.rankInfo?.status === 'error');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 서버에 연결하지 못했어요 · 랭킹 보기 ›'));
    const pending = await page.evaluate(() => walkoff.store.get('pending', null));
    expect(pending).toEqual(sentScores(errors)[0].body);
    expect(pending.token).toBe(errors.calls.tickets[0].token);
    api.scoreFail = false;
    await page.waitForTimeout(300);   // 저장한 값이 넘어갈 틈
    await page.reload();
    await page.waitForFunction(() => !!window.walkoff);
    await expect.poll(() => page.evaluate(() => walkoff.store.get('pending', null))).toBe(null);
    expect(sentScores(errors).map((c) => c.body)).toEqual([pending, pending]);
    await expect.poll(() => page.evaluate(() => walkoff.game.toast?.text)).toBe('기록을 랭킹에 올렸어요');
    expect(errors).toEqual([]);
  });

  test('로그인했으면 서버가 내준 시드로 친다. 막 열어서 받는 중에 누르면 받은 뒤에 시작하고, 그동안 누른 것은 받지 않는다', async ({ page }) => {
    // 시드 답은 테스트가 확인을 마치고 풀 때까지 잡아 둔다. 전에는 1.5초 뒤에 답해서 느린 CI에서 확인하기 전에 판이 시작됐다(8e091ed CI 첫 시도).
    // 게임은 받는 중에 누르면 3초(SEED_WAIT_MS)까지 기다리므로 그 안에 푼다
    const errors = await open(page, '', { login: true, api: { seed: 7, seedHold: true } });
    await page.keyboard.press('Space');   // 시드를 받는 중에 시작한다
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.waitingSeed])).toEqual(['title', true]);
    await expect.poll(() => page.evaluate(() => walkoff.game.toast?.text)).toBe('공을 받는 중…');
    await page.keyboard.press('Space');   // 기다리는 동안 또 눌러도 한 판만 시작한다
    await tap(page, '메뉴');   // 다른 버튼도 받지 않는다(메뉴가 열리면 시작하지 않게 돼 있다)
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.waitingSeed])).toEqual(['title', true]);
    errors.calls.releaseSeeds();
    await page.waitForFunction(() => walkoff.game.state === 'windup', null, { timeout: 5000 });
    expect(await page.evaluate(() => ({ seed: walkoff.game.seed, token: walkoff.game.ticket?.token, throws: walkoff.game.throws === walkoff.pitcherHand(7), waiting: walkoff.game.waitingSeed, toast: walkoff.game.toast?.text ?? null })))
      .toEqual({ seed: 7, token: errors.calls.tickets[0].token, throws: true, waiting: false, toast: null });
    await expect.poll(() => seedCalls(errors).length).toBe(2);   // 다음 판 시드를 바로 받기 시작한다
    expect(errors).toEqual([]);
  });

  test('서버 시드를 못 받으면 기다리다 이 기기 시드로 치고, 끝 화면에 랭킹에 안 올라간 까닭이 나온다', async ({ page }) => {
    const api = { seedFail: true };
    const errors = await open(page, '', { login: true, api });
    await expect.poll(() => seedCalls(errors).length).toBe(1);   // 열자마자 받으려다 실패했다
    await page.evaluate(() => { walkoff.startGame('challenge'); });   // 시작할 때 한 번 더 받아 보고, 또 실패하면 그냥 시작한다
    await page.waitForFunction(() => walkoff.game.state === 'windup', null, { timeout: 5000 });
    expect(await page.evaluate(() => walkoff.game.ticket)).toBe(null);
    expect(seedCalls(errors).length).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => Object.assign(walkoff.game, { left: 1 }));
    api.seedFail = false;
    await playUntilOver(page, null);   // 이 기기 시드라 공 순서가 판마다 다르다. 존 밖 공은 기회를 안 쓰므로 스트라이크가 나올 때까지 그냥 보낸다
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'rejected');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 서버에 연결하지 못해 안 올라갔어요 · 랭킹 보기 ›'));
    expect(sentScores(errors).map((c) => c.body.token)).toEqual([undefined]);   // 시드를 못 받은 판은 표 없이 가서 서버가 거절한다
    expect(await page.evaluate(() => walkoff.store.get('pending', null))).toBe(null);
    await page.waitForFunction(() => walkoff.game.resultT > 0.7);   // 끝 화면은 잠깐 뒤부터 스페이스바를 받는다
    await page.keyboard.press('Space');   // 서버가 살아나면 다음 판은 서버 시드로 친다
    await page.waitForFunction(() => walkoff.game.state === 'windup' && !!walkoff.game.ticket, null, { timeout: 5000 });
    expect(await page.evaluate(() => walkoff.game.seed)).toBe(42);
    expect(errors).toEqual([]);
  });

  test('주소에 ?seed=를 붙인 판은 서버 시드를 받지 않고 랭킹에도 보내지 않는다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true });
    await page.waitForFunction(() => walkoff.settings.playerId === 'p-account-0001');
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    expect(await page.evaluate(() => [walkoff.game.seed, walkoff.game.ticket, walkoff.game.fixedSeed])).toEqual([42, null, true]);
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '주소로 정한 공은 랭킹에 안 올라가요 · 랭킹 보기 ›'));
    expect([sentScores(errors), seedCalls(errors)]).toEqual([[], []]);
    expect(errors).toEqual([]);
  });

  test('10구 도전은 공을 보고 처음부터 다시 할 수 있고(새 서버 시드), 끝내지 않은 판은 보내지 않는다', async ({ page }) => {
    const errors = await open(page, '', { login: true });
    const resultShown = () => page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await seedReady(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    await resultShown();   // 초구를 그냥 보낸다
    await tap(page, '처음부터');
    await expect.poll(() => page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode, i: walkoff.game.i, results: walkoff.game.results.length, score: walkoff.game.score })))
      .toEqual({ state: 'windup', mode: 'challenge', i: 0, results: 0, score: 0 });
    expect(await page.evaluate(() => walkoff.game.ticket?.token)).toBe(errors.calls.tickets[1].token);   // 시작할 때 받아 둔 다음 시드
    expect(sentScores(errors)).toEqual([]);
    expect(errors).toEqual([]);
  });

  // 2026-10-30 사용자 '10구 다 치면 코인': 전에는 '결과 보기'를 눌러야 기록돼서, 마지막 결과 화면의 처음부터·Esc로 나가면 다 친 판이 빠졌다
  test('기회를 다 쓰면 결과 보기를 누르기 전에 기록된다(점수·코인·연속 기록·최고 기록). 마지막 결과 화면의 버튼은 "다시 하기"이고, 다시 하기나 Esc로 나가도 판마다 한 번씩 보낸다', async ({ page }) => {
    const errors = await open(page, '', { login: true });
    const playLast = async () => {   // 지금 판의 남은 기회를 1번으로 줄이고 정타로 친 뒤 결과 화면을 기다린다(결과 보기는 누르지 않는다)
      await page.evaluate(() => { walkoff.game.left = 1; });
      await page.waitForFunction(() => walkoff.game.state === 'pitch');
      await pressAt(page, 0);
      await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
      return page.evaluate(() => ({ token: walkoff.game.ticket.token, score: walkoff.game.score }));
    };
    await seedReady(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    const first = await playLast();
    await expect.poll(() => sentScores(errors).length).toBe(1);   // 결과 보기를 누르기 전에 보냈다
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(first.score).toBeGreaterThan(0);
    expect(await page.evaluate(() => [walkoff.wallet.coins, walkoff.store.get('played.' + walkoff.today(), 0), walkoff.store.get('best', 0)]))
      .toEqual([Math.floor(first.score / 100), 1, first.score]);   // 코인(가짜 서버는 점수의 1/100), 연속 기록, 최고 기록
    const labels = await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label));
    expect(labels).toEqual(expect.arrayContaining(['다시 하기', '결과 보기']));
    expect(labels).not.toContain('처음부터');
    await tap(page, '다시 하기');
    await expect.poll(() => page.evaluate(() => [walkoff.game.i, walkoff.game.results.length, walkoff.game.recorded])).toEqual([0, 0, false]);   // 새 판
    const second = await playLast();
    await page.keyboard.press('Escape');   // 마지막 결과 화면에서 바로 나가도
    await expect.poll(() => sentScores(errors).map((c) => c.body.token)).toEqual([first.token, second.token]);
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
    expect(errors).toEqual([]);
  });

  test('진동이 되는 폰(안드로이드)에서는 맞히면 울리고, 메뉴에서 끌 수 있다', async ({ page, isMobile }) => {
    test.skip(!isMobile, '진동은 터치 화면 폰에서만 쓴다');
    await page.addInitScript(() => { window.__vibes = []; navigator.vibrate = (p) => { window.__vibes.push(p); return true; }; });
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    const o = await playPitch(page, 0);   // 시드 42의 첫 공(가운데 직구)을 정확한 타이밍에 친다
    expect(o.kind).not.toBe('whiff');
    expect(await page.evaluate(() => window.__vibes)).toEqual([o.kind === 'hr' ? [50, 40, 110] : o.kind === 'foul' ? 15 : 30]);
    await page.keyboard.press('Escape');
    await tap(page, '메뉴');
    await tap(page, '진동 켜짐');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '진동 꺼짐'));
    expect(await page.evaluate(() => ({ on: walkoff.settings.vibrate, saved: localStorage.getItem('walkoff.vibrate') }))).toEqual({ on: false, saved: 'false' });
    await page.evaluate(() => { window.__vibes = []; walkoff.startGame('challenge'); });
    await playPitch(page, 0);
    expect(await page.evaluate(() => window.__vibes)).toEqual([]);   // 끄면 울리지 않는다
    expect(errors).toEqual([]);
  });

  test('진동이 안 되는 기기(아이폰, PC)에는 메뉴에 진동 항목이 없다', async ({ page, isMobile }) => {
    if (isMobile) await page.addInitScript(() => { delete Navigator.prototype.vibrate; });   // 아이폰 사파리처럼 진동 함수가 없다
    const errors = await open(page);
    await tap(page, '메뉴');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '기록'));
    expect((await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).some((l) => l.startsWith('진동'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('로그인 안 하면 상점은 구경만 한다: 미리 입어 보고, 로그인을 권한다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.openShop('shop'));
    await tap(page, '금색');   // 배트 칸이 먼저 열린다
    expect(await page.evaluate(() => walkoff.batterColors().bat)).toBe('#eebf2c');   // 고른 배트를 미리 입힌다
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 로그인'));
    expect((await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).some((l) => l.startsWith('사기'))).toBe(false);
    await tap(page, '닫기');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, bat: walkoff.batterColors().bat }))).toEqual({ state: 'title', bat: '#c8955a' });   // 닫으면 원래 배트
    expect(errors.calls.filter((c) => c.path.startsWith('/shop'))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('상점: 사면 바로 입고, 내 물건에서 바꿔 입는다. 등번호는 사고 번호를 골라 단다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true, api: { account: { coins: 500 } } });
    await page.waitForFunction(() => walkoff.wallet.coins === 500);
    await page.evaluate(() => walkoff.openShop('shop'));
    await tap(page, '빨강');
    await tap(page, '사기 · 150코인');
    await expect.poll(() => page.evaluate(() => ({ coins: walkoff.wallet.coins, bat: walkoff.wallet.look.bat }))).toEqual({ coins: 350, bat: 'bat-red' });
    expect(errors.calls.filter((c) => c.path.startsWith('/shop')).map((c) => [c.path, c.body])).toEqual([['/shop/buy', { item: 'bat-red' }], ['/shop/equip', { item: 'bat-red' }]]);
    await tap(page, '닫기');
    expect(await page.evaluate(() => walkoff.batterColors().bat)).toBe('#c8202c');   // 상점을 닫아도 입은 배트

    await page.evaluate(() => walkoff.openShop('shop'));
    await tap(page, '내 물건');
    await page.waitForFunction(() => walkoff.game.shop.view === 'inventory');
    // 버튼 목록은 다음 그림에서 바뀌어서, 바로 읽으면 상점 탭의 배트가 그대로 보일 때가 있다(CI에서 실패)
    const batItems = () => page.evaluate(() => walkoff.ui.buttons.map((b) => b.label).filter((l) => walkoff.SHOP_ITEMS.some((i) => i.slot === 'bat' && i.name === l)));
    await expect.poll(batItems).toEqual(['원목', '빨강']);   // 가진 것만
    await tap(page, '원목');
    await tap(page, '착용하기');
    await expect.poll(() => page.evaluate(() => walkoff.wallet.look.bat)).toBe('bat-wood');

    await tap(page, '상점');
    await tap(page, '등번호');
    await tap(page, '등번호 달기');
    await tap(page, '사기 · 300코인');
    await expect.poll(() => page.evaluate(() => walkoff.wallet.coins)).toBe(50);
    const no = page.locator('input[aria-label="등번호"]');
    await expect(no).toBeVisible();
    await no.fill('23');
    await no.press('Enter');
    await expect.poll(() => page.evaluate(() => [walkoff.wallet.look.number, walkoff.wallet.look.no])).toEqual(['number-on', 23]);
    await tap(page, '배트');
    await tap(page, '금색');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '코인이 모자라요'));   // 50코인으로는 금색 배트(1,000)를 못 산다

    await reloadUntil(page, () => walkoff.wallet.coins === 50);   // 다시 열어도 서버에서 지갑과 착용을 받는다
    expect(await page.evaluate(() => ({ bat: walkoff.wallet.look.bat, no: walkoff.wallet.look.no, owned: walkoff.wallet.owned }))).toEqual({ bat: 'bat-wood', no: 23, owned: ['bat-red', 'number-on'] });
    expect(errors).toEqual([]);
  });

  test('상점: 물건을 하나씩 골라 미리 입혀 봐도 오류가 없고, 물건이 가장 많은 탭도 닫기까지 화면에 들어간다(폰은 키가 작은 360×640)', { tag: '@min' }, async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 360, height: 640 });
    const errors = await open(page);
    await page.evaluate(() => walkoff.openShop('shop'));
    for (const [slot, label] of await page.evaluate(() => walkoff.SHOP_SLOTS)) {
      await tap(page, label);
      const names = await page.evaluate((slot) => walkoff.SHOP_ITEMS.filter((i) => i.slot === slot).map((i) => i.name), slot);
      await expect.poll(() => page.evaluate((names) => walkoff.ui.buttons.filter((b) => names.includes(b.label)).length, names)).toBe(names.length);
      for (const name of names) {   // 누른 칸의 물건이 골라져야 한다(칸 자리가 맞는지)
        await tap(page, name);
        await expect.poll(() => page.evaluate(() => walkoff.SHOP_ITEMS.find((i) => i.id === walkoff.game.shop.sel)?.name)).toBe(name);
      }
      const fit = await page.evaluate(() => {
        const close = walkoff.ui.buttons.find((b) => b.label === '닫기').r;
        return { close: close.y + close.h <= innerHeight, inside: walkoff.ui.buttons.every((b) => b.r.x >= 0 && b.r.x + b.r.w <= innerWidth + 0.5) };
      });
      expect(fit, label).toEqual({ close: true, inside: true });
    }
    expect(errors).toEqual([]);
  });

  test('파울 뒤 다시 보기를 누르면 화면이 타석으로 돌아오고, 다시 보기가 끝나도 파울공을 다시 따라가지 않는다', async ({ page, isMobile }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 115);   // 115ms 늦게 휘두르면 파울(90~140ms)
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => walkoff.game.outcome.kind)).toBe('foul');
    await page.waitForFunction(() => Math.hypot(walkoff.view.panX, walkoff.view.panY) > 300, null, { timeout: 5000 });   // 화면이 파울공을 따라 돌아갔다
    await tap(page, isMobile ? '다시 보기' : '다시 보기 (R)');
    expect(await page.evaluate(() => [walkoff.game.replay != null, walkoff.view.panX, walkoff.view.panY])).toEqual([true, 0, 0]);
    await page.waitForFunction(() => walkoff.game.replay == null, null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => Math.hypot(walkoff.view.panX, walkoff.view.panY))).toBeLessThan(1);   // 다시 보기가 끝나도 타석에 머문다
    expect(errors).toEqual([]);
  });

  test('타자는 팔로스루에서 두 팔꿈치가 몸 앞쪽에 있어 등 위로 팔이 그려지지 않는다', async ({ page }) => {
    const errors = await open(page);
    for (const tau of [0.15, 0.22, 0.3, 0.45, 0.7]) {
      const k = await page.evaluate((tau) => { const k = walkoff.batterSkeleton(tau); return { chest: k.chest[2], l: k.elbows.l[2], r: k.elbows.r[2] }; }, tau);
      expect(k.r, `${tau}초 뒷팔`).toBeGreaterThan(k.chest);   // 포수 시점에서 몸보다 멀다(예전에는 뒤로 꺾여 아래팔이 등을 가로질렀다)
      expect(k.l, `${tau}초 앞팔`).toBeGreaterThan(k.chest);
    }
    expect(errors).toEqual([]);
  });

  test('투수는 공을 놓는 순간 손이 공이 출발하는 자리에 있다(투구 동작을 바꿔도 공 궤적은 그대로)', async ({ page }) => {
    const errors = await open(page);
    const hand = await page.evaluate(() => walkoff.pitcherHandAt(1.0));
    expect(hand.x).toBeCloseTo(-0.55, 6); expect(hand.y).toBeCloseTo(1.75, 6); expect(hand.z).toBeCloseTo(17.0, 6);   // RELEASE
    expect(await page.evaluate(() => walkoff.pitcherHandAt(0.8).y)).toBeGreaterThan(1.9);   // 발을 디딜 때 공 쥔 손은 머리 뒤로 올라가 있다
    expect(errors).toEqual([]);
  });

  test('관중: 외야 관중석을 채우고 투수 뒤 가운데는 비운다. 1루 쪽은 내 팀 색이 많고, 그림은 화면·팀이 바뀔 때만 다시 만든다', async ({ page }) => {
    const errors = await open(page);   // LG를 고른 상태
    await page.waitForFunction(() => walkoff.crowd.people.length > 0);
    const look = (team) => page.evaluate((team) => {
      const c = walkoff.crowd, main = walkoff.teamById(team).main, share = (arr) => arr.filter((q) => q.shirt === main).length / arr.length;
      return { n: c.people.length, center: c.people.filter((q) => Math.abs(q.a) < 4).length, home: share(c.people.filter((q) => q.a > 0)), away: share(c.people.filter((q) => q.a < 0)), builds: c.builds };
    }, team);
    const lg = await look('lg');
    expect(lg.n).toBeGreaterThan(2000);
    expect(lg.center).toBe(0);   // 공을 놓는 곳 뒤는 비운다(관중에 공이 묻히지 않게)
    expect(lg.home).toBeGreaterThan(0.25);   // 1루 쪽(오른쪽)은 내 팀 옷
    expect(lg.away).toBeLessThan(0.05);
    await page.waitForTimeout(500);
    expect((await look('lg')).builds).toBe(lg.builds);   // 매 화면 다시 만들지 않는다
    await page.evaluate(() => { walkoff.settings.team = 'kia'; });
    await expect.poll(async () => (await look('kia')).builds).toBe(lg.builds + 1);   // 팀을 바꾸면 한 번 다시 만든다
    expect((await look('kia')).home).toBeGreaterThan(0.25);
    expect(errors).toEqual([]);
  });

  test('연속 홈런이면 백투백 +500을 더하고 끝내기만큼 환호한다(seed 42는 첫 두 공을 정확히 치면 둘 다 홈런)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => {
      window.roars = [];
      const roar = walkoff.Sound.roar;
      walkoff.Sound.roar = (level) => { window.roars.push(level); roar(level); };
      walkoff.startGame('challenge');
    });
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => [walkoff.game.outcome.kind, walkoff.game.outcome.streak, walkoff.game.outcome.streakBonus])).toEqual(['hr', 1, 0]);
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.4);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    const r = await page.evaluate(() => { const o = walkoff.game.outcome; return { kind: o.kind, streak: o.streak, bonus: o.streakBonus, perfect: o.perfect, gained: walkoff.game.gained }; });
    expect(r).toMatchObject({ kind: 'hr', streak: 2, bonus: 500 });
    expect(r.gained).toBe(1000 + (r.perfect ? 100 : 0) + 500);
    // 결과 카드는 가운데 전광판이 HOMERUN을 띄운 뒤에 나온다(홈런은 따라가는 카메라가 돌아온 뒤)
    await expect.poll(async () => { const t = await drawnTexts(page); return t.includes('백투백 홈런!') && t.includes('연속 홈런 +500'); }, { timeout: 12_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.roars)).toEqual([2, 3]);   // 백투백은 끝내기만큼 큰 함성
    expect(errors).toEqual([]);
  });

  test('연속 홈런은 볼을 골라내도 이어지고, 다른 결과가 나오면 끊긴다. 세 번째부터는 +1,000', async ({ page }) => {
    const errors = await open(page);
    const before = (kinds) => page.evaluate((kinds) => { walkoff.game.results = kinds.map((kind) => ({ kind })); return walkoff.hrStreakBefore(kinds.length); }, kinds);
    expect(await before(['hr', 'ball', 'hr'])).toBe(2);
    expect(await before(['hr', 'out', 'hr'])).toBe(1);
    expect(await before(['hr', 'hr', 'strike'])).toBe(0);
    expect(await before(['single', 'hr', 'ball', 'ball', 'hr'])).toBe(2);
    expect(await page.evaluate(() => [1, 2, 3, 4, 10].map(walkoff.hrStreakBonus))).toEqual([0, 500, 1000, 1000, 1000]);
    expect(errors).toEqual([]);
  });

  test('연속 안타는 볼을 골라내도 이어지고 다른 결과는 끊는다. 2연속 +300, 3연속 +500, 4연속부터 +800', async ({ page }) => {
    const errors = await open(page);
    const before = (rs) => page.evaluate((rs) => { walkoff.game.results = rs.map((kind) => ({ kind, hit: ['single', 'double', 'hr'].includes(kind) })); return walkoff.hitStreakBefore(rs.length); }, rs);
    expect(await before(['single', 'ball', 'double'])).toBe(2);
    expect(await before(['single', 'out', 'double'])).toBe(1);
    expect(await before(['hr', 'single', 'foul'])).toBe(0);
    expect(await before(['out', 'hr', 'single', 'ball', 'double'])).toBe(3);
    expect(await page.evaluate(() => [1, 2, 3, 4, 10].map(walkoff.hitStreakBonus))).toEqual([0, 300, 500, 800, 800]);
    expect(errors).toEqual([]);
  });

  test('실제 판: 안타 뒤 안타면 연속 안타 +300 칩, 홈런은 연속 홈런 보너스와 더하지 않고 큰 쪽만(seed 42 첫 두 공은 홈런)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);                                                          // 첫 공 홈런
    await page.waitForFunction(() => walkoff.game.state === 'result');
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.4);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);                                                          // 둘째 공도 홈런: 연속 홈런 +500(연속 안타 +300보다 크다)
    await page.waitForFunction(() => walkoff.game.state === 'result');
    const r = await page.evaluate(() => { const o = walkoff.game.outcome; return { kind: o.kind, streakBonus: o.streakBonus, hitBonus: o.hitBonus ?? 0, gained: walkoff.game.gained, perfect: o.perfect }; });
    expect(r).toMatchObject({ kind: 'hr', streakBonus: 500, hitBonus: 0 });
    expect(r.gained).toBe(1000 + (r.perfect ? 100 : 0) + 500);
    expect(errors).toEqual([]);
  });

  test('존 밖 공을 지켜보면 판정한 자리에 동그라미와 몇 cm 빠졌는지 보여 준다(seed 10의 첫 공은 몸쪽으로 11cm)', async ({ page }) => {
    const errors = await open(page, '?seed=10');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'result', null, { timeout: 10_000 });   // 휘두르지 않으면 공이 지나간 뒤 판정한다
    expect(await page.evaluate(() => walkoff.game.outcome.kind)).toBe('ball');
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.3);
    const texts = await drawnTexts(page);
    expect(texts).toContain('몸쪽 11cm');          // 큰 화면의 동그라미 옆
    expect(texts).toContain('존 밖 · 몸쪽 11cm');   // 결과의 작은 존
    expect(await page.evaluate(() => walkoff.judgeTake(walkoff.game.seq[0]).reason)).toBe('존 몸쪽으로 11cm 빠졌어요 · 선구안 보너스');
    // 좌타자에게는 같은 공이 바깥쪽이다
    expect(await page.evaluate(() => walkoff.zoneOff(walkoff.game.seq[0], 'L'))).toEqual({ dir: '바깥쪽', cm: 11 });
    expect(errors).toEqual([]);
  });

  test('투수는 키 장면에서 멈칫하지 않고 이어서 던진다(공을 놓는 손은 RELEASE 그대로)', async ({ page }) => {
    const errors = await open(page);
    const speed = await page.evaluate(() => {
      const sp = (t) => { const a = walkoff.pitcherHandAt(t - 0.005), c = walkoff.pitcherHandAt(t + 0.005); return Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) / 0.01; };
      return [0.55, 0.78, 0.9, 1.0].map(sp);   // 손 빼기·디딤·머리 위·놓기. 전에는 키 장면마다 0.1~0.4m/s로 멈칫했다
    });
    for (const v of speed) expect(v).toBeGreaterThan(1.5);
    expect(errors).toEqual([]);
  });

  test('타자는 투수가 공을 놓으면 손을 당기고 앞발을 내디뎠다가, 공을 그냥 보내면 푼다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const p = { T: 0.8 }, pre = (tb) => walkoff.batterPre(tb, p, 0).load;
      const k0 = walkoff.batterSkeleton(null, { idle: 0, load: 0 }), k1 = walkoff.batterSkeleton(null, { idle: 0, load: 1 });
      return { before: pre(-0.3), half: pre(0.4), passed: pre(0.8 + 0.4), handBack: k1.hand[2] - k0.hand[2], stride: k1.feet.l[2] - k0.feet.l[2] };
    });
    expect([r.before, r.half, r.passed]).toEqual([0, 1, 0]);   // 놓기 전 0, 공이 반쯤 오면 다 당김, 지나가고 0.35초 뒤 다 풂
    expect(r.handBack).toBeLessThan(-0.05);   // 손을 포수 쪽으로
    expect(r.stride).toBeGreaterThan(0.1);    // 앞발을 투수 쪽으로
    expect(errors).toEqual([]);
  });

  test('친 타자는 결과대로 뛴다: 땅볼 아웃은 송구가 먼저 닿고, 뜬공은 잡히면 멈추고, 단타는 1루를 돌았다 돌아오고, 2루타는 미끄러져 2루에 서고, 홈런은 홈까지 돈다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const seq = walkoff.makeSequence(1, false), out = (n, dt) => walkoff.judgeSwing(seq[n - 1], dt, 'R');
      const near = (q, b) => Math.hypot(q.x - b[0], q.z - b[1]);
      const ground = out(3, -80), fly = out(1, -55), single = out(1, -80), double = out(3, -20), hr = out(1, -25), foul = out(1, -120);   // 뜬공은 좌익수 76m(2026-11-04 판정을 실제처럼 바꾼 뒤 -65ms는 좌익수 앞 단타)
      // 처음 멈추는 때(아웃은 멈췄다가 더그아웃으로 걸어간다. 2026-11-03부터)
      const stopAt = (x, from) => { for (let t = from; t < from + 6; t += 1 / 60) if (walkoff.runnerAt(x, t)?.speed === 0) return t; return null; };
      const g1 = walkoff.runnerAt(ground, walkoff.fieldPlay(ground).end), g8 = walkoff.runnerAt(ground, stopAt(ground, walkoff.fieldPlay(ground).end));
      let hrHome = Infinity;
      for (let t = 15; t < 40; t += 1 / 30) { const q = walkoff.runnerAt(hr, t); hrHome = Math.min(hrHome, Math.hypot(q.x, q.z)); }
      return {
        kinds: [ground.kind + ':' + ground.type, fly.kind, single.kind, double.kind, hr.kind, foul.kind],
        notYet: walkoff.runnerAt(hr, 0.2), foul: walkoff.runnerAt(foul, 2),
        groundAtThrow: near(g1, walkoff.BASE1), groundEnd: { speed: g8.speed, past: near(g8, walkoff.BASE1) },
        flyStopped: stopAt(fly, walkoff.fieldPlay(fly).end) - walkoff.fieldPlay(fly).end,
        single: (() => {   // 1루를 지나 2루 쪽으로 간 거리(가장 멀 때)와 돌아온 뒤
          const B1 = walkoff.BASE1, B2 = walkoff.BASE2, u = [B2[0] - B1[0], B2[1] - B1[1]], n = Math.hypot(u[0], u[1]);
          let past = 0; for (let t = 4; t < 14; t += 0.05) { const q = walkoff.runnerAt(single, t); past = Math.max(past, ((q.x - B1[0]) * u[0] + (q.z - B1[1]) * u[1]) / n); }
          return { past, back: near(walkoff.runnerAt(single, 14), B1) };
        })(),
        double: near(walkoff.runnerAt(double, 11), walkoff.BASE2),
        slide: (() => {   // 2루를 밟는 때: 엉덩이를 낮춰 미끄러지며 왼발로 베이스를 짚는다
          const t = walkoff.runnerReach(double, walkoff.BASE2), k = walkoff.runnerSkeleton(walkoff.runnerAt(double, t)), B2 = walkoff.BASE2;
          return { pelvisY: k.pelvis[1], footToBag: Math.hypot(k.feet.l[0] - B2[0], k.feet.l[2] - B2[1]), upLater: walkoff.runnerSkeleton(walkoff.runnerAt(double, t + 1.5)).pelvis[1] };
        })(),
        infield: (() => {   // 여유 있는 내야 안타는 1루를 지나쳐 멈췄다가 돌아온다(간발이면 머리부터 미끄러져 들어간다, 아래 '1루 머리부터 슬라이딩')
          let r = null; for (let sd = 1; sd < 30 && !r; sd++) { const q = walkoff.makeSequence(sd, false); for (let n = 0; n < 16 && !r; n++) for (let dt = -90; dt <= 90; dt += 3) { const x = walkoff.judgeSwing(q[n], dt, 'R'); if (x.infield && x.race.margin < -0.15) { r = x; break; } } }
          return { past: near(walkoff.runnerAt(r, 6), walkoff.BASE1), back: near(walkoff.runnerAt(r, 12), walkoff.BASE1) };
        })(),
        hr10: walkoff.runnerAt(hr, 10).dist, hrHome,
        camera: (() => {   // 화면은 주자 몸이 아니라 주자가 가는 베이스 쪽을 앞서 잡는다
          const q = walkoff.runnerAt(hr, 8), c = walkoff.cameraFocus(hr, 8), g = q.goals.find((x) => x.at > q.dist + 0.3).p, far = (a) => Math.hypot(a[0] - g[0], a[1] - g[1]);
          return { lead: Math.hypot(c.x - q.x, c.z - q.z), closer: far([c.x, c.z]) < far([q.x, q.z]) };
        })(),
      };
    });
    expect(r.kinds).toEqual(['out:ground', 'out', 'single', 'double', 'hr', 'foul']);
    expect(r.notYet).toBeNull();             // 방망이를 내려놓기 전(0.35초)
    expect(r.foul).toBeNull();               // 파울은 뛰지 않는다
    expect(r.groundAtThrow).toBeGreaterThan(0.3);   // 송구가 1루에 닿을 때 아직 1루 전(1루 경주대로 반 박자 차이)
    expect(r.groundEnd.speed).toBe(0);
    expect(r.groundEnd.past).toBeLessThan(7);     // 1루를 지나쳐 달려 나가 짧은 걸음으로 멈춘다
    expect(r.flyStopped).toBeLessThan(2.5);       // 뜬공은 잡히면 줄여 멈춘다(그 뒤는 더그아웃으로 걸어간다)
    expect(r.single.past).toBeGreaterThan(3.5);   // 1루를 돌아 2루 쪽으로 4.5m 나갔다가
    expect(r.single.back).toBeLessThan(0.6);      // 외야수가 공을 던지면 1루로 돌아와 선다
    expect(r.double).toBeLessThan(0.5);      // 2루에 선다
    expect(r.slide.pelvisY).toBeLessThan(0.4);    // 미끄러져 들어가
    expect(r.slide.footToBag).toBeLessThan(0.35); // 왼발로 베이스를 짚고
    expect(r.slide.upLater).toBeGreaterThan(0.8); // 일어선다
    expect(r.infield.past).toBeGreaterThan(3);    // 내야 안타는 1루를 지나쳐 달렸다가
    expect(r.infield.back).toBeLessThan(0.6);     // 돌아온다
    expect(r.hr10).toBeGreaterThan(27.43);   // 1루를 지났다
    expect(r.hrHome).toBeLessThan(0.5);      // 홈까지 돈다(밟은 뒤에는 더그아웃으로 걸어간다)
    expect(r.camera.lead).toBeGreaterThan(1);   // 공이 넘어간 뒤 화면은 주자보다 앞(가는 베이스 쪽)을 잡아서, 주자가 화면 안을 달려 나간다
    expect(r.camera.closer).toBe(true);         // (주자 몸을 잡으면 화면 끝에 붙어 제자리에서 뛰는 것처럼 보였다)
    expect(errors).toEqual([]);
  });

  test('주자의 두 발은 늘 다리가 닿는 곳에 있고(전에는 오른발을 반 걸음 앞에 디뎌 다리를 쩍 벌렸다), 홈런 공은 관중석에 떨어지면 감춘다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const seq = walkoff.makeSequence(1, false), ground = walkoff.judgeSwing(seq[2], -80, 'R'), hr = walkoff.judgeSwing(seq[0], -25, 'R');
      let reach = 0;
      for (let t = 0.55; t < 14; t += 0.02) {   // 우타는 0.52초에 뛰기 시작한다. 멈춘 뒤 돌아서 더그아웃으로 걷는 것까지
        const k = walkoff.runnerSkeleton(walkoff.runnerAt(ground, t));
        for (const s of ['l', 'r']) reach = Math.max(reach, Math.hypot(k.feet[s][0] - k.hips[s][0], k.feet[s][1] - k.hips[s][1], k.feet[s][2] - k.hips[s][2]));
      }
      for (let t = 20; t < 34; t += 0.02) {   // 홈런: 홈을 밟으며 손을 들고, 돌아서 더그아웃으로 걷는다
        const k = walkoff.runnerSkeleton(walkoff.runnerAt(hr, t));
        for (const s of ['l', 'r']) reach = Math.max(reach, Math.hypot(k.feet[s][0] - k.hips[s][0], k.feet[s][1] - k.hips[s][1], k.feet[s][2] - k.hips[s][2]));
      }
      const double = walkoff.judgeSwing(seq[2], -20, 'R'), t2 = walkoff.runnerReach(double, walkoff.BASE2);
      for (let t = t2 - 1; t < t2 + 1.5; t += 0.02) {   // 2루타 슬라이딩과 일어서기
        const k = walkoff.runnerSkeleton(walkoff.runnerAt(double, t));
        for (const s of ['l', 'r']) reach = Math.max(reach, Math.hypot(k.feet[s][0] - k.hips[s][0], k.feet[s][1] - k.hips[s][1], k.feet[s][2] - k.hips[s][2]));
      }
      const play = walkoff.fieldPlay(hr);
      return { reach, flying: !!play.ball(0.5).hidden, landed: !!play.ball(walkoff.flightDuration(hr)).hidden };
    });
    expect(r.reach).toBeLessThan(0.95);   // 넓적다리 0.46 + 정강이 0.45
    expect(r.flying).toBe(false);         // 날아가는 동안은 보이고
    expect(r.landed).toBe(true);          // 관중석에 떨어지면 감춘다(전에는 관중석 그림 위에 공이 그대로 보였다)
    expect(errors).toEqual([]);
  });

  test('뛰는 폼: 딛는·떼는 순간에도 무릎이 조금 굽고, 무릎은 140도 넘게 접히지 않고 옆으로 꺾이지 않으며, 발끝으로 차고 차올린 발은 밑창이 뒤를 본다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const seq = walkoff.makeSequence(1, false), ground = walkoff.judgeSwing(seq[2], -80, 'R'), hr = walkoff.judgeSwing(seq[0], -25, 'R');
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = (a) => Math.hypot(...a);
      const out = { stanceMin: 180, flexMax: 0, side: 0, toeOff: 0, soleBack: 0 };
      const look = (run) => {
        const k = walkoff.runnerSkeleton(run), l = [-run.dir[1], 0, run.dir[0]], f = [run.dir[0], 0, run.dir[1]];
        for (const s of ['l', 'r']) {
          const a = sub(k.hips[s], k.knees[s]), c = sub(k.feet[s], k.knees[s]), flex = 180 - Math.acos(dot(a, c) / len(a) / len(c)) * 180 / Math.PI;
          out.flexMax = Math.max(out.flexMax, flex);
          if (k.feet[s][1] < 0.065) out.stanceMin = Math.min(out.stanceMin, flex);   // 발이 땅에 붙어 있을 때(뒤꿈치를 들기 전)
          out.side = Math.max(out.side, Math.abs(dot(sub(k.knees[s], k.hips[s]), l) - dot(sub(k.feet[s], k.hips[s]), l) / 2));   // 무릎이 엉덩이·발목 사이에서 옆으로 벗어난 거리
          if (k.feet[s][1] < 0.2 && k.feetDir[s][1] < -0.5) out.toeOff++;   // 떼기 직전 발끝으로 선다
          if (k.feet[s][1] > 0.5 && dot(k.feetDir[s], f) < -0.3) out.soleBack++;   // 뒤꿈치를 차올린 발은 발끝이 뒤를 본다
        }
      };
      for (let t = 1.6; t < 5; t += 1 / 120) look(walkoff.runnerAt(ground, t));   // 전력 질주(출발 뒤)
      for (let t = 8; t < 16; t += 1 / 120) look(walkoff.runnerAt(hr, t));       // 홈런 조깅
      return out;
    });
    expect(r.stanceMin).toBeGreaterThan(15);   // 전에는 딛는·떼는 순간 다리가 쭉 펴져(7도) 다리를 찢은 것처럼 보였다
    expect(r.flexMax).toBeLessThan(140);       // 전에는 뒤꿈치를 차올릴 때 172도까지 접혔다
    expect(r.side).toBeLessThan(0.06);         // 뒤에서 볼 때 정강이가 옆으로 벌어지지 않는다
    expect(r.toeOff).toBeGreaterThan(20);
    expect(r.soleBack).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  test('주루 다듬기: 몸은 0.35초에 걸쳐 돌고(전에는 한 장면 만에 180도), 베이스에 선 주자 옆으로 수비수가 비켜 서고, 아웃은 고개를 숙이고 파울 지역으로, 홈런은 손을 들고 홈을 밟은 뒤 더그아웃으로 뛰어 나간다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const w = walkoff, seq = w.makeSequence(1, false), out = (n, dt) => w.judgeSwing(seq[n - 1], dt, 'R');
      const find = (pred) => { for (let sd = 1; sd < 40; sd++) { const q = w.makeSequence(sd, false); for (let n = 0; n < 16; n++) for (let dt = -90; dt <= 90; dt += 3) { const x = w.judgeSwing(q[n], dt, 'R'); if (pred(x)) return x; } } return null; };
      const single = out(1, -80), infield = find((x) => x.infield), ground = out(3, -80), fly = out(1, -55), hr = out(1, -25), double = out(3, -20), triple = find((x) => x.kind === 'triple');
      const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180 / Math.PI;
      const maxTurn = (x) => { let m = 0, p = null; for (let t = 0.6; t < 40; t += 1 / 60) { const q = w.runnerAt(x, t); if (q && p) m = Math.max(m, ang(p, q.dir)); p = q ? q.dir : null; } return m; };
      // t초에 주자와 가장 가까운 수비수: 거리와, 홈 뒤 카메라에서 옆으로 떨어진 거리(x)
      const nearest = (x, t) => { const q = w.runnerAt(x, t); return w.fieldersAt(x, t).map((f) => ({ d: Math.hypot(f.spot[0] - q.x, f.spot[1] - q.z), dx: Math.abs(f.spot[0] - q.x) })).sort((a, b) => a.d - b.d)[0]; };
      const settled = (x, b) => Math.max(w.fieldPlay(x).ev.arrive + 0.7, w.runnerReach(x, b) + 1.6);   // 공을 받아 비켜 서고 주자가 일어선 뒤
      const D = w.DUGOUT, toDug = (q) => Math.hypot(q.x - D[0], q.z - D[1]);
      const stopAt = (x, from) => { for (let t = from; t < from + 6; t += 1 / 60) if (w.runnerAt(x, t)?.speed === 0) return t; return null; };
      // 아웃: 멈춘 자리에서 나가는 곳(마지막 목표)으로 4초 동안 3m 넘게 다가가고, 나가는 곳은 1루 쪽 파울 지역(x > z)
      const leaves = (x, t0) => { const a = w.runnerAt(x, t0 + 4), e = a.goals[a.goals.length - 1].p, to = (q) => Math.hypot(q.x - e[0], q.z - e[1]); return { moving: a.speed > 0.5, closer: to(a) < to(w.runnerAt(x, t0)) - 3, foul: e[0] > e[1] }; };
      const gs = stopAt(ground, w.fieldPlay(ground).end), gk = w.runnerSkeleton(w.runnerAt(ground, gs + 4));
      const fs = stopAt(fly, w.fieldPlay(fly).end);
      let raised = -9, home = Infinity;
      for (let t = 15; t < 32; t += 1 / 30) { const q = w.runnerAt(hr, t), h = Math.hypot(q.x, q.z - 0.3); home = Math.min(home, h); if (h < 2) { const k = w.runnerSkeleton(q); raised = Math.max(raised, k.hands.r[1] - k.head[1]); } }
      const h40 = w.runnerAt(hr, 40);
      return {
        kinds: [single.kind, infield?.kind, ground.kind + ':' + ground.type, fly.kind, hr.kind, double.kind, triple?.kind],
        turn: [single, infield, ground, fly, hr].map((x) => Math.round(maxTurn(x))),
        aside: [nearest(single, 10), nearest(infield, 10), nearest(double, settled(double, w.BASE2)), nearest(triple, settled(triple, w.BASE3))].map((n) => ({ d: +n.d.toFixed(2), dx: +n.dx.toFixed(2) })),
        ground: { ...leaves(ground, gs), headDown: gk.brim[1] < gk.head[1] - 0.05 },
        fly: leaves(fly, fs),
        hr: { home: +home.toFixed(2), raised: +raised.toFixed(2), away: toDug(h40) < Math.hypot(h40.x, h40.z) },
      };
    });
    expect(r.kinds).toEqual(['single', 'single', 'out:ground', 'out', 'hr', 'double', 'triple']);
    for (const t of r.turn) expect(t).toBeLessThan(20);   // 1/60초에 20도 아래(전에는 단타·내야 안타 귀루 때 한 장면에 179도)
    for (const n of r.aside) { expect(n.d).toBeGreaterThan(1.4); expect(n.dx).toBeGreaterThan(1.1); }   // 단타·내야 안타는 1루, 2루타·3루타는 그 베이스에 선 주자와 수비수가 겹쳐 보이지 않는다
    expect(r.ground).toEqual({ moving: true, closer: true, foul: true, headDown: true });   // 땅볼 아웃은 멈췄다가 고개를 숙이고 파울 지역으로 나간다
    expect(r.fly).toEqual({ moving: true, closer: true, foul: true });   // 뜬공 아웃도
    expect(r.hr.home).toBeLessThan(0.5);       // 홈런은 홈을 밟으며
    expect(r.hr.raised).toBeGreaterThan(0.2);  // 한 손을 머리 위로 들고
    expect(r.hr.away).toBe(true);              // 그다음 더그아웃 쪽으로 뛰어 나간다
    expect(errors).toEqual([]);
  });

  test('공 회전: 커브는 앞면이 아래로 굴러 떨어지고(앞회전), 직구는 위로, 슬라이더는 가운데를 두고 돌고, 포크는 거의 안 돈다', async ({ page }) => {
    const errors = await open(page);
    // 카메라 쪽(z > 0.5) 실밥 점들이 0.01초 동안 움직인 평균(단위 구 기준, y는 위)
    const motion = (type, lefty = false) => page.evaluate(([type, lefty]) => {
      const a = walkoff.seamPoints({ type, n: 3, t: 0.2, lefty }), b = walkoff.seamPoints({ type, n: 3, t: 0.21, lefty });
      let dx = 0, dy = 0, move = 0, n = 0;
      a.forEach((p, i) => { if (p[2] > 0.5) { dx += b[i][0] - p[0]; dy += b[i][1] - p[1]; move += Math.hypot(b[i][0] - p[0], b[i][1] - p[1]); n++; } });
      return { n, dx: dx / n, dy: dy / n, move: move / n };
    }, [type, lefty]);
    const curve = await motion('curve'), lcurve = await motion('curve', true), fast = await motion('fastball'), slider = await motion('slider'), fork = await motion('fork');
    for (const m of [curve, lcurve, fast, slider, fork]) expect(m.n).toBeGreaterThan(3);
    expect(curve.dy).toBeLessThan(-0.1);                                  // 앞회전: 앞면이 아래로
    expect(Math.abs(curve.dy)).toBeGreaterThan(Math.abs(curve.dx) * 2);
    expect(lcurve.dy).toBeLessThan(-0.1);                                 // 좌완 커브도 앞회전(거울로 뒤집어도)
    expect(fast.dy).toBeGreaterThan(0.1);                                 // 백스핀: 앞면이 위로
    expect(Math.abs(slider.dy)).toBeLessThan(Math.abs(curve.dy) * 0.4);   // 자이로: 위아래로는 거의 안 가고 가운데를 두고 돈다
    expect(slider.move).toBeGreaterThan(0.03);
    expect(fork.move).toBeLessThan(curve.move * 0.2);                     // 포크는 거의 안 돈다
    expect(errors).toEqual([]);
  });

  test('결과 글자가 뜨기 전에는 전광판 불과 점수를 공이 맞기 전 그대로 둔다(1루 간발의 결과가 미리 보이지 않게)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);   // seed 42의 첫 공을 정확히 치면 홈런(1,100점)
    await page.waitForFunction(() => walkoff.game.state === 'result');
    const before = await page.evaluate(() => ({ score: walkoff.game.score, revealAt: walkoff.game.revealAt, resultT: walkoff.game.resultT, view: walkoff.boardView() }));
    expect(before.score).toBeGreaterThan(0);   // 점수는 맞는 순간 들어가 있지만
    expect(before.resultT).toBeLessThan(before.revealAt);
    expect(before.view.score).toBe(0);         // 전광판(7세그먼트 숫자)에는 아직 이전 점수
    expect(before.view.lamps[0]).toBeNull();   // 이번 공 불도 아직 꺼져 있다
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.1);
    const after = await page.evaluate(() => walkoff.boardView());
    expect(after.score).toBe(before.score);
    expect(after.lamps[0]).toBe('H');          // 홈런은 초록 별
    expect(errors).toEqual([]);
  });

  test('관중은 안타·홈런에 일어나 함성을 지르고(홈런이 더 크다), 파울에는 그대로다. 새 물건을 입고 쳐도 오류가 없다', { tag: '@min' }, async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => {
      // 불꽃 배트·호랑이 헬멧·오리발·번개 꼬리·폭탄 소리를 입고 친다(효과를 그리는 길에 오류가 없는지)
      walkoff.setWallet({ look: { bat: 'bat-fire', helmet: 'helmet-tiger', shoe: 'shoe-duck', trail: 'trail-lightning', sound: 'sound-bomb' } });
      window.roars = [];
      const roar = walkoff.Sound.roar;
      walkoff.Sound.roar = (level) => { window.roars.push(level); roar(level); };
    });
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 115);   // 115ms 늦으면 파울
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => [walkoff.game.outcome.kind, walkoff.crowd.power])).toEqual(['foul', 0]);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.roars)).toEqual([]);   // 파울에는 함성이 없다
    await expect.poll(() => page.evaluate(() => walkoff.Sound.crowdReady()), { timeout: 10_000 }).toBe(true);   // 첫 키에 소리를 켜면서 관중 함성 녹음(crowd.mp3)을 받아 둔다
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.4);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);   // 정타(seed 42의 두 번째 공은 가운데라 앞으로 날아간다)
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => [walkoff.crowd.power, window.roars.length])).toEqual([0, 0]);   // 결과 글자 전에는 조용하다(1루 간발의 결과가 미리 들리지 않게)
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.05);
    const r = await page.evaluate(() => ({ kind: walkoff.game.outcome.kind, hit: walkoff.game.outcome.hit, power: walkoff.crowd.power }));
    expect(r.hit).toBe(true);
    expect(r.power).toBe(r.kind === 'hr' ? 2 : 1);
    await expect.poll(() => page.evaluate(() => window.roars)).toEqual([r.kind === 'hr' ? 2 : 1]);   // 결과 글자와 함께 함성
    await page.waitForFunction(() => walkoff.game.flightT > 0.5);   // 번개 꼬리를 단 공이 날아가는 동안에도 오류가 없다
    expect(errors).toEqual([]);
  });

  test('팀을 바꿀 때 기록은 그날 팀으로 남는다고 알리고, 서버 저장이 실패하면 알린 뒤 다음에 열 때 다시 저장한다(옛 팀으로 돌아가지 않는다)', async ({ page }) => {
    const NOTE = '이미 친 기록은 그날 팀으로 남아요 · 새 팀은 다음 판부터';
    const api = { account: { nick: '테스트', team: 'lg' }, failProfile: true };
    const errors = await open(page, '?seed=42', { login: true, api });
    const puts = () => errors.calls.filter((c) => c.method === 'PUT' && c.path === '/me');
    await page.waitForFunction(() => walkoff.wallet.coins != null);   // 계정을 받아 왔다
    await page.evaluate(() => walkoff.openOnboard('menu'));
    expect(await drawnTexts(page)).toContain(NOTE);
    await tap(page, 'KIA 타이거즈');
    await tap(page, '저장');
    await expect.poll(() => page.evaluate(() => walkoff.game.toast?.text ?? '')).toContain('저장하지 못했어요');   // 예전에는 조용히 넘어갔다
    expect(await page.evaluate(() => [walkoff.settings.team, walkoff.store.get('profileDirty', 0)])).toEqual(['kia', 1]);
    const tried = puts().length;
    // 다음에 열면 서버의 옛 팀(LG)으로 덮지 않고 KIA를 다시 보낸다
    await reloadUntil(page, () => walkoff.settings.team === 'kia' && walkoff.store.get('profileDirty', 0) === 1);
    await expect.poll(() => puts().length).toBeGreaterThan(tried);
    expect(await page.evaluate(() => walkoff.settings.team)).toBe('kia');
    api.failProfile = false;   // 서버가 살아나면 저장되고 표시가 지워진다
    await reloadUntil(page, () => walkoff.settings.team === 'kia');
    await expect.poll(() => page.evaluate(() => walkoff.store.get('profileDirty', 0))).toBe(0);
    expect(puts().at(-1).body).toMatchObject({ team: 'kia' });
    await page.evaluate(() => walkoff.openRanking('title'));   // 랭킹 화면에도 같은 안내
    expect(await drawnTexts(page)).toContain(NOTE);
    expect(errors).toEqual([]);
  });

  test('등번호는 두 자리여도 등 폭 안에 들어간다(몸이 돌아도, 우타·좌타)', async ({ page }) => {
    const errors = await open(page);
    let seen = 0;
    for (const bats of ['R', 'L']) {
      await page.evaluate((b) => walkoff.setBats(b), bats);
      for (const no of [7, 25, 88]) for (const tau of [0.25, 0.35, 0.45, 0.6]) {
        const box = await page.evaluate(([no, tau]) => walkoff.backNumberBox(no, tau), [no, tau]);
        if (!box) continue;   // 등이 카메라를 안 보는 자세
        seen++;
        expect(box.textW * box.sx, `${bats} ${no}번 ${tau}초`).toBeLessThanOrEqual(box.backW * 0.8);   // 예전에는 88번이 등보다 넓었다
      }
    }
    expect(seen).toBeGreaterThan(6);   // 등이 보이는 자세를 실제로 봤다
    expect(errors).toEqual([]);
  });

  test('끝 화면에 받은 코인이 붙고, 꾸민 공 꼬리·타격음·등번호로 쳐도 문제없다', async ({ page }) => {
    const look = { trail: 'trail-fire', sound: 'sound-metal', number: 'number-on', no: 9, helmet: 'helmet-gold', uniform: 'uniform-home' };
    const errors = await open(page, '', { login: true, api: { account: { coins: 0, owned: ['trail-fire', 'sound-metal', 'number-on', 'helmet-gold', 'uniform-home'], look }, earned: 64 } });
    await page.waitForFunction(() => walkoff.wallet.look.trail === 'trail-fire');
    await seedReady(page);
    expect(await page.evaluate(() => ({ helmet: walkoff.batterColors().helmet, jersey: walkoff.batterColors().jersey, accent: walkoff.batterColors().accent })))
      .toEqual({ helmet: '#e3b322', jersey: '#eceef2', accent: '#a50034' });   // 홈 유니폼은 흰 바탕에 소매·스타킹은 팀 색(LG)
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    const o = await playPitch(page, 0);
    expect(o.kind).not.toBe('whiff');
    await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.game.rankInfo?.status === 'ok');
    expect(await page.evaluate(() => ({ note: walkoff.coinNote(), coins: walkoff.wallet.coins }))).toEqual({ note: ' · +64코인', coins: 64 });   // 오늘의 10구 2배는 오늘의 10구와 함께 없앴다
    expect(sentScores(errors)[0].body.mode).toBe('challenge');
    expect(errors).toEqual([]);
  });

  test('내 계정: 랭킹 기록 지우기는 한 번 더 묻고, 지우면 로그아웃된다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true });
    await page.waitForFunction(() => walkoff.settings.playerId === 'p-account-0001');
    await tap(page, '메뉴');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '내 계정'));
    await tap(page, '내 계정');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 기록 지우기'));
    await tap(page, '랭킹 기록 지우기');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '지우기'));
    await tap(page, '취소');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 기록 지우기'));
    expect(errors.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    await tap(page, '랭킹 기록 지우기');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '지우기'));
    await tap(page, '지우기');
    await page.waitForFunction(() => walkoff.game.state === 'title');
    expect(errors.calls.filter((c) => c.method === 'DELETE')).toEqual([expect.objectContaining({ path: '/me', auth: `Bearer ${SESSION}` })]);
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, session: localStorage.getItem('walkoff.session'), newId: walkoff.settings.playerId !== 'p-account-0001', toast: walkoff.game.toast?.text })))
      .toEqual({ token: null, session: null, newId: true, toast: '랭킹 기록과 계정을 지웠어요' });
    await page.evaluate(() => walkoff.openAccount());
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 로그인'));   // 로그아웃된 계정 화면
    expect(errors).toEqual([]);
  });

  test('메뉴에서 팀·닉네임을 바꾸고 엔터로 저장한다. 로그인했으면 계정에도 적는다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true });
    await tap(page, '메뉴');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '팀·닉네임'));
    await tap(page, '팀·닉네임');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '저장'));
    await tap(page, 'NC 다이노스');
    const nick = page.locator('input[aria-label="닉네임"]');
    await nick.fill('새이름');
    await nick.press('Enter');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, team: walkoff.settings.team, nick: walkoff.settings.nick })))
      .toEqual({ state: 'title', team: 'nc', nick: '새이름' });
    await expect.poll(() => errors.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContainEqual({ nick: '새이름', team: 'nc' });
    expect(errors).toEqual([]);
  });

  test('랭킹에서 사람을 누르면 그 사람이 입은 모습을 크게 보고(예전 기록은 기본 모습), 닫으면 목록과 내 모습으로 돌아온다', async ({ page }) => {
    const look = { bat: 'bat-fire', helmet: 'helmet-tiger', glove: 'glove-white', shoe: 'shoe-duck', uniform: 'uniform-home', number: 'number-on', no: 7, trail: 'trail-heart', sound: 'sound-bomb' };
    const rankings = { ...SAMPLE_RANKING, players: [{ ...SAMPLE_RANKING.players[0], look }, { ...SAMPLE_RANKING.players[1], look: null }] };
    const errors = await open(page, '?seed=42', { api: { rankings } });
    const mine = await page.evaluate(() => JSON.stringify(walkoff.currentLook()));
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 줄 1'));
    await tap(page, '랭킹 줄 1');
    expect(await page.evaluate(() => walkoff.game.rankView && { nick: walkoff.game.rankView.nick, team: walkoff.game.rankView.team, bat: walkoff.game.rankView.look.bat, no: walkoff.game.rankView.look.no })).toEqual({ nick: '명은', team: 'lotte', bat: 'bat-fire', no: 7 });
    await page.waitForTimeout(150);
    const texts = await drawnTexts(page);
    expect(texts).toContain('명은');
    expect(texts.some((t) => t.includes('등번호 7'))).toBe(true);   // 입은 물건 이름
    expect(await page.evaluate(() => JSON.stringify(walkoff.currentLook()))).toBe(mine);   // 그린 뒤에는 내 모습 그대로
    await page.keyboard.press('Space');                             // 목록으로
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.rankView])).toEqual(['ranking', null]);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '랭킹 줄 2'));
    await tap(page, '랭킹 줄 2');                                   // 예전 기록(look 없음)은 기본 모습
    expect(await page.evaluate(() => walkoff.game.rankView.look.bat)).toBe(await page.evaluate(() => walkoff.cleanLook(null).bat));
    await page.waitForTimeout(150);
    expect(await drawnTexts(page)).toContain('기본 모습');
    await tap(page, '‹ 랭킹으로');
    await page.keyboard.press('Space');                             // 목록에서 한 번 더 누르면 닫힌다
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
    expect(errors).toEqual([]);
  });

  test('랭킹 화면: 순위, 빈 목록, 서버 오류', async ({ page }) => {
    const errors = await open(page, '?seed=42', { api: { rankings: SAMPLE_RANKING } });
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'ok');
    expect(await page.evaluate(() => walkoff.game.ranking.data.me.rank)).toBe(2);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '팀'));
    await tap(page, '팀');
    expect(await page.evaluate(() => walkoff.game.rankTab)).toBe('teams');
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain('카카오로 로그인하면 나도 올라가요 ›');   // 로그인 안 한 사람에게 보인다
    await page.keyboard.press('Space');   // 스페이스로 닫는다
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');

    await page.unroute(`${API}/**`);
    await mockApi(page);   // 아직 아무도 없는 주
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'ok');
    expect(await page.evaluate(() => walkoff.game.ranking.data.players.length)).toBe(0);

    await page.unroute(`${API}/**`);   // 서버가 바뀌기 전의 응답(사람 점수가 total)이어도 그린다
    await mockApi(page, { rankings: { ...SAMPLE_RANKING, players: SAMPLE_RANKING.players.map(({ best, ...p }) => ({ ...p, total: best })) } });
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'ok' && walkoff.game.ranking.data.players[0].total === 12100);
    await page.waitForTimeout(100);   // 한 번 그려 본다

    await page.unroute(`${API}/**`);
    await mockApi(page, { fail: true });
    await page.evaluate(() => walkoff.openRanking('title'));
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'error');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '다시 시도'));
    expect(await drawnTexts(page)).toContain('랭킹을 불러오지 못했어요');
    // 서버 횟수 제한(429)이면 잠시 뒤 다시 하라고 하고, 다시 시도는 그대로 된다
    await page.route(`${API}/rankings**`, (route) => route.fulfill({ status: 429, headers: { ...CORS, 'retry-after': '60' }, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'rate_limited' }) }));
    await tap(page, '다시 시도');
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'error' && walkoff.game.ranking.busy);
    expect(await drawnTexts(page)).toContain('요청이 많아요. 잠시 뒤 다시 해 주세요');
    await page.unroute(`${API}/rankings**`);
    await page.unroute(`${API}/**`);
    await mockApi(page, { rankings: SAMPLE_RANKING });
    await tap(page, '다시 시도');
    await page.waitForFunction(() => walkoff.game.ranking?.status === 'ok');
    expect(errors).toEqual([]);
  });

  // 팀 창(2026-11-06 사용자 '랭킹에서 팀 누르면 누구누구 속해 있는지'): 팀원은 랭킹 서버가 보내는 상위 50명에서 고른다(서버는 그대로)
  const TEAM_ROWS = [['명은', 'lotte', 14800], ['홈런공장장', 'lg', 16200, 'hrking'], ['민성', 'lg', 12000], ['테스트', 'lg', 7200], ['곰돌이', 'doosan', 8700]];
  const UNOFFICIAL_TEXT = 'KBO·각 구단과 관계없는 비공식 팬 게임이에요';
  test('랭킹 팀 창: 팀 줄을 누르면 그 팀 사람만 점수 순으로(팀 안 순위·칭호·점수) 나오고 내 줄이 금색이다. 보탠 몫 막대·%는 없다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { api: { rankings: await rankingOf(TEAM_ROWS, '테스트') } });
    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀');
    expect(await drawnTexts(page)).toContain('팀원들의 이번 주 최고 기록을 더한 순위예요 · 누르면 팀원');
    await tap(page, '팀 줄 lg');
    expect(await page.evaluate(() => walkoff.game.rankTeam)).toBe('lg');
    const gold = await norm(page, 'rgba(242,201,76,0.2)');
    let ops = await drawnOps(page);
    const texts = ops.filter((o) => o.t === 'text'), golds = () => ops.filter((o) => o.t === 'fill' && o.style === gold);
    expect(texts.map((o) => o.s).filter((s) => TEAM_ROWS.some((r) => r[0] === s))).toEqual(['홈런공장장', '민성', '테스트']);   // 그 팀 사람만, 점수 순
    expect(texts.map((o) => o.s)).toEqual(expect.arrayContaining(['LG 트윈스', '이번 주 1위 · 35,400점 · 3명', '1', '2', '3', '16,200점', '12,000점', '7,200점', '홈런왕']));
    expect(texts.map((o) => o.s).filter((s) => s.endsWith('%'))).toEqual([]);   // 사람이 많아지면 몫이 1% 아래라 뺐다
    const [mine] = golds(), inside = (o) => o.y > mine.y && o.y < mine.y + mine.h;
    expect(golds()).toHaveLength(1);
    expect(texts.filter(inside).map((o) => o.s)).toEqual(expect.arrayContaining(['테스트', '7,200점']));   // 금색 줄은 내 줄
    expect(texts.filter(inside).map((o) => o.s)).not.toContain('홈런공장장');
    await tap(page, '‹ 랭킹으로');
    await tap(page, '팀 줄 lotte');   // 내가 없는 팀은 금색 줄이 없다
    ops = await drawnOps(page);
    expect(ops.filter((o) => o.t === 'text').map((o) => o.s).filter((s) => TEAM_ROWS.some((r) => r[0] === s))).toEqual(['명은']);
    expect(golds()).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('랭킹 팀 창: 50명이 넘으면 상위 50명에 없는 팀원은 외 N명으로 묶고, 내가 50위 밖이면 내 줄을 붙인다(팀 안 순위를 모르면 -)', async ({ page }) => {
    // 56명: lg는 1·20·40위와 50위 밖인 51·53(나)·55위, 나머지는 여섯 팀을 돌아가며
    const others = ['lotte', 'doosan', 'kia', 'hanwha', 'ssg', 'nc'], lg = [0, 19, 39, 50, 52, 54];
    const rows = Array.from({ length: 56 }, (_, i) => [i === 52 ? '테스트' : `타자${1000 + i}`, lg.includes(i) ? 'lg' : others[i % others.length], 30000 - i * 100]);
    const rankings = await rankingOf(rows, '테스트'), lgTeam = rankings.teams.find((t) => t.team === 'lg');
    expect([rankings.players.length, rankings.me.rank, lgTeam.players, lgTeam.total]).toEqual([50, 53, 6, 158600]);   // 서버처럼 사람은 50명만 온다
    const errors = await open(page, '?seed=42', { api: { rankings } });
    const shown = async () => (await drawnOps(page)).filter((o) => o.t === 'text').map((o) => o.s);
    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀');
    await tap(page, '팀 줄 lg');
    let texts = await shown();
    expect(texts).toEqual(expect.arrayContaining([`이번 주 ${lgTeam.rank}위 · 158,600점 · 6명`, '타자1000', '타자1019', '타자1039', '테스트', '24,800점', '-', '외 2명 · 49,600점']));
    expect(texts.filter((s) => ['타자1050', '타자1054'].includes(s))).toEqual([]);   // 50위 밖 다른 팀원은 이름을 모른다
    expect(texts.indexOf('테스트')).toBeLessThan(texts.indexOf('외 2명 · 49,600점'));
    await tap(page, '팀원 줄 4');   // 붙인 내 줄도 누르면 입은 모습(전체 순위)
    expect(await page.evaluate(() => { const v = walkoff.game.rankView; return [v.nick, v.rank, v.best]; })).toEqual(['테스트', 53, 24800]);
    expect((await shown()).some((s) => s.includes('이번 주 53위 · 24,800점'))).toBe(true);
    await tap(page, '‹ 팀으로');
    await tap(page, '‹ 랭킹으로');
    await tap(page, '팀 줄 lotte');   // 내가 없는 팀에는 내 줄을 안 붙인다
    expect(await shown()).not.toContain('테스트');

    await page.unroute(`${API}/**`);   // 50위 밖 팀원이 나뿐이면 팀 안 순위를 안다
    await mockApi(page, { rankings: await rankingOf(rows.map((r, i) => (lg.includes(i) && i !== 0 && i !== 52 ? [r[0], 'kt', r[2]] : r)), '테스트') });
    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀 줄 lg');
    texts = await shown();
    expect(texts).toEqual(expect.arrayContaining(['타자1000', '테스트', '1', '2']));
    expect(texts.filter((s) => s === '-' || s.startsWith('외 '))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('랭킹 팀 창: 팀원 → 입은 모습 → 뒤로 팀 창 → 뒤로 팀 탭, Esc·스페이스바도 한 단계씩이고 팀 창에서는 화살표로 탭이 안 바뀐다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { api: { rankings: await rankingOf(TEAM_ROWS, '테스트') } });
    const where = () => page.evaluate(() => [walkoff.game.state, walkoff.game.rankTab, walkoff.game.rankTeam, walkoff.game.rankView?.nick ?? null]);
    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀');
    await tap(page, '팀 줄 lg');
    await tap(page, '팀원 줄 2');
    expect(await where()).toEqual(['ranking', 'teams', 'lg', '민성']);
    await tap(page, '‹ 팀으로');
    expect(await where()).toEqual(['ranking', 'teams', 'lg', null]);
    await tap(page, '‹ 랭킹으로');
    expect(await where()).toEqual(['ranking', 'teams', null, null]);

    await tap(page, '팀 줄 lg');
    await tap(page, '팀원 줄 1');
    await page.keyboard.press('Escape');
    expect(await where()).toEqual(['ranking', 'teams', 'lg', null]);
    await page.keyboard.press('ArrowLeft');   // 팀 창 뒤의 탭은 그대로
    expect(await where()).toEqual(['ranking', 'teams', 'lg', null]);
    await page.keyboard.press('Escape');
    expect(await where()).toEqual(['ranking', 'teams', null, null]);
    await page.keyboard.press('ArrowLeft');   // 목록에서는 화살표로 탭을 바꾼다
    expect(await where()).toEqual(['ranking', 'players', null, null]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');      // 목록에서 Esc는 예전처럼 시작 화면으로
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');

    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀 줄 lg');
    await tap(page, '팀원 줄 3');
    expect(await where()).toEqual(['ranking', 'teams', 'lg', '테스트']);
    await page.keyboard.press('Space');
    expect(await where()).toEqual(['ranking', 'teams', 'lg', null]);
    await page.keyboard.press('Space');
    expect(await where()).toEqual(['ranking', 'teams', null, null]);
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
    expect(errors).toEqual([]);
  });

  test('랭킹 팀 창: 불러오는 중·서버 오류(429 포함)·이번 주 기록 없음에서는 팀 줄이 없어 눌러도 그대로고, 기록 없는 주의 지난주 1위 줄은 안내 글과 안 겹친다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { api: { rankings: await rankingOf(TEAM_ROWS, '테스트') } });
    const vp = page.viewportSize();
    const blocked = async (status) => {   // 팀 줄이 있었을 자리(다시 시도 단추 옆)를 눌러 본다
      expect(await page.evaluate(() => walkoff.ui.buttons.filter((b) => b.label.startsWith('팀 줄')).length), status).toBe(0);
      for (const f of [0.45, 0.55]) await page.mouse.click(vp.width / 2 - 120, vp.height * f);
      expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.rankTeam, walkoff.game.ranking.status]), status).toEqual(['ranking', null, status]);
    };
    const held = [];
    await page.route(`${API}/rankings**`, (route) => { held.push(route); });   // 답을 붙잡아 불러오는 중으로 둔다
    await page.evaluate(() => walkoff.openRanking('title'));
    await tap(page, '팀');
    await blocked('loading');
    await Promise.all(held.map((r) => r.fulfill({ status: 500, headers: CORS, contentType: 'application/json', body: '{"ok":false}' })));
    await page.unroute(`${API}/rankings**`);
    await page.waitForFunction(() => walkoff.game.ranking.status === 'error');
    await blocked('error');
    await page.route(`${API}/rankings**`, (route) => route.fulfill({ status: 429, headers: CORS, contentType: 'application/json', body: '{"ok":false,"error":"rate_limited"}' }));
    await tap(page, '다시 시도');
    await page.waitForFunction(() => walkoff.game.ranking.status === 'error' && walkoff.game.ranking.busy);
    await blocked('error');
    await page.unroute(`${API}/rankings**`);

    await page.unroute(`${API}/**`);   // 새 주 첫날: 이번 주는 비었고 지난주 1위는 있다
    await mockApi(page, { rankings: { ...EMPTY_RANKING, lastWeek: SAMPLE_RANKING.lastWeek } });
    await tap(page, '다시 시도');
    await page.waitForFunction(() => walkoff.game.ranking.status === 'ok');
    await blocked('ok');
    const texts = (await drawnOps(page)).filter((o) => o.t === 'text');
    const note = texts.find((o) => o.s.startsWith('아직 이번 주 기록이 없어요')), last = texts.find((o) => o.s.startsWith('지난주 1위'));
    expect(last.y - note.y).toBeGreaterThanOrEqual(24);   // 전에는 지난주 줄이 안내 글 바로 위에 겹쳤다
    expect(errors).toEqual([]);
  });

  test('랭킹 목록·팀 창이 작은 화면(320×568·375×667·1280×720)을 넘치면 끌어 넘기고(끄는 동안에는 줄이 안 눌린다), 줄 사이 전체가 누르는 자리(폰 36px·팀원 44px)이며 아래 단추·안내 글과 안 겹친다', async ({ page, isMobile }) => {
    test.skip(isMobile, '창 크기를 바꿔 가며 보므로 PC에서만 본다');
    // 16명: 나는 12위, lg 팀원은 8명
    const teams = ['lg', 'lotte', 'lg', 'doosan', 'lg', 'kia', 'lg', 'hanwha', 'lg', 'ssg', 'lg', 'lg', 'nc', 'lg', 'samsung', 'kt'];
    const errors = await open(page, '?seed=42', { api: { rankings: await rankingOf(teams.map((team, i) => [i === 11 ? '테스트' : `타자${1000 + i}`, team, 16000 - i * 500, i % 4 ? null : 'hrking']), '테스트') } });
    const buttons = () => page.evaluate(() => walkoff.ui.buttons.map((b) => ({ label: b.label, r: { ...b.r } })));
    const list = () => page.evaluate(() => { const L = walkoff.rankList; return { top: L.top, bottom: L.bottom, scroll: L.scroll, max: L.max }; });
    const wheelToEnd = () => page.evaluate(() => document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 5000, cancelable: true })));
    for (const [w, h] of [[320, 568], [375, 667], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => { walkoff.goTitle(); walkoff.openRanking('title'); walkoff.game.rankTab = 'players'; });
      await page.waitForFunction((w) => walkoff.view.w === w && walkoff.ui.buttons.some((b) => b.label === '랭킹 줄 1'), w);
      const L = await list(), bs = await buttons(), rows = bs.filter((b) => b.label.startsWith('랭킹 줄'));
      const unofficial = (await drawnOps(page)).find((o) => o.t === 'text' && o.s === UNOFFICIAL_TEXT);
      expect(L.max, `${w}×${h} 넘친다`).toBeGreaterThan(0);
      expect(rows.filter((b) => b.r.y < L.top - 0.5 || b.r.y + b.r.h > L.bottom + 0.5).map((b) => b.label), `${w}×${h} 줄은 목록 안`).toEqual([]);
      expect(bs.filter((b) => ['닫기', '카카오로 로그인하면 나도 올라가요 ›'].includes(b.label)).every((b) => b.r.y >= L.bottom), `${w}×${h} 아래 단추는 목록 밖`).toBe(true);
      expect(unofficial.y - 7, `${w}×${h} 비공식 안내는 목록 밖`).toBeGreaterThanOrEqual(L.bottom);
      expect(rows.slice(0, 3).map((b) => Math.round(b.r.h)), `${w}×${h} 줄 사이 전체`).toEqual(Array(3).fill(w < 640 ? 36 : 34));
      expect(rows.map((b) => b.label), `${w}×${h} 내 줄은 아래에 가려져 있다`).not.toContain('랭킹 줄 12');
      // 끌어 올리면 넘어가고 손가락 밑의 줄은 안 눌린다
      const r0 = rows[rows.length - 1].r, box = await page.locator('canvas').boundingBox(), drag = Math.min(120, r0.y - L.top);
      await page.mouse.move(box.x + r0.x + 60, box.y + r0.y + r0.h / 2); await page.mouse.down();
      await page.mouse.move(box.x + r0.x + 60, box.y + r0.y + r0.h / 2 - drag, { steps: 6 }); await page.mouse.up();
      expect(await page.evaluate(() => walkoff.game.rankView), `${w}×${h}`).toBe(null);
      expect((await list()).scroll, `${w}×${h} 끈 만큼`).toBeCloseTo(Math.min(drag, L.max), 0);
      await wheelToEnd();
      await page.waitForTimeout(50);
      expect((await list()).scroll, `${w}×${h} 휠로 끝까지`).toBe(L.max);
      await tap(page, '랭킹 줄 12');   // 넘칠 때는 뗄 때 누른다
      expect(await page.evaluate(() => walkoff.game.rankView?.nick), `${w}×${h}`).toBe('테스트');
      await page.keyboard.press('Escape');
      expect((await list()).scroll, `${w}×${h} 돌아오면 넘기던 자리`).toBe(L.max);
    }
    await page.setViewportSize({ width: 320, height: 568 });   // 팀원 8명은 320×568에 다 안 들어간다
    await page.evaluate(() => { walkoff.openRanking('title'); walkoff.game.rankTab = 'teams'; });
    await tap(page, '팀 줄 lg');
    await page.waitForFunction(() => walkoff.rankList.key === 'team:lg' && walkoff.ui.buttons.some((b) => b.label === '팀원 줄 1'));   // 팀 창을 한 번 그린 뒤
    const T = await list(), members = (await buttons()).filter((b) => b.label.startsWith('팀원 줄'));
    expect(T.max).toBeGreaterThan(0);
    expect(members.slice(0, 3).map((b) => Math.round(b.r.h))).toEqual([44, 44, 44]);
    expect(members.find((b) => b.label === '팀원 줄 8')?.r.h ?? 0).toBeLessThan(44);   // 마지막 팀원은 다 안 보인다
    await wheelToEnd();
    await tap(page, '팀원 줄 8');
    expect(await page.evaluate(() => walkoff.game.rankView?.nick)).toBe('타자1013');
    expect(errors).toEqual([]);
  });

  test('공 하나 치고 결과 화면까지', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    const o = await playPitch(page, 0);
    expect(o.kind).toBeTruthy();
    expect(await page.evaluate(() => walkoff.game.results.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('수비', () => {
  // 판정이 정한 결과 하나를 놓고 수비 진행(누가 언제 어디 있고 공이 어디 있는지)을 계산해 본다. 화면 크기와 상관없어서 PC에서만
  test.skip(({ isMobile }) => isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');

  const near = (a, b, m) => Math.hypot(a.x - b.x, a.z - b.z) <= m;

  test('유격수 땅볼: 유격수가 굴러온 공을 글러브로 잡아 1루로 던지고, 1루수가 베이스에서 몸을 뻗어 받는 순간 결과 글자가 뜬다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const f = walkoff.FIELDERS.find((x) => x.pos === '유격수'), r = { kind: 'out', type: 'ground', spray: -13, dist: 40, ev: 120, la: 2, fielder: f };
      const pl = walkoff.fieldPlay(r), ev = pl.ev, ss = walkoff.DEFENSE.find((x) => x.pos === '유격수');
      const who = (t, pos) => { const q = walkoff.fieldersAt(r, t).find((x) => x.f.pos === pos); return { x: q.spot[0], z: q.spot[1], pose: q.pose }; };
      const glove = (t) => { const k = walkoff.actorSkeleton(pl, ss, t).hands.l; return { x: k[0], z: k[2] }; };
      return { ev, reveal: pl.reveal, end: pl.end, base1: { x: walkoff.BASE1[0], z: walkoff.BASE1[1] },
        caught: { ball: pl.ball(ev.field + 0.05), glove: glove(ev.field + 0.05) },
        mid: pl.ball((ev.release + ev.arrive) / 2), arrive: { ball: pl.ball(ev.arrive), b1: who(ev.arrive, '1루수') } };
    });
    expect(d.ev.fielder).toBe('유격수');
    expect(d.reveal).toBeCloseTo(d.end, 5);   // 결과 글자는 공이 1루에 닿는 순간
    expect(d.ev.arrive).toBeCloseTo(d.end, 5);
    expect(near(d.caught.ball, d.caught.glove, 0.05)).toBe(true);   // 굴러온 공은 유격수 글러브에
    expect(d.mid.x).toBeGreaterThan(d.caught.ball.x);   // 1루 쪽으로 날아가는 중
    expect(d.mid.x).toBeLessThan(d.base1.x);
    expect(near(d.arrive.ball, d.base1, 1.5)).toBe(true);   // 끝에는 1루 베이스에(뻗은 글러브)
    expect(near(d.arrive.b1, d.base1, 0.6)).toBe(true);   // 1루수도 베이스 위에서
    expect(d.arrive.b1.pose).toBe('stretch');               // 몸을 뻗어 받는다
    expect(errors).toEqual([]);
  });

  test('중견수 뜬공: 떨어지는 자리로 뛰어가 머리 위에서 잡고(결과 글자는 잡을 때, 늦어도 2.6초), 잡은 공은 글러브에 남는다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const f = walkoff.FIELDERS.find((x) => x.pos === '중견수'), r = { kind: 'out', type: 'fly', spray: 5, dist: 92, ev: 140, la: 30, fielder: f };
      const pl = walkoff.fieldPlay(r), tc = pl.ev.catch, cf = walkoff.DEFENSE.find((x) => x.pos === '중견수');
      const at = (t) => { const q = walkoff.fieldersAt(r, t).find((x) => x.f.pos === '중견수'); return { x: q.spot[0], z: q.spot[1], pose: q.pose }; };
      const glove = (t) => { const k = walkoff.actorSkeleton(pl, cf, t).hands.l; return { x: k[0], y: k[1], z: k[2] }; };
      return { tc, reveal: pl.reveal, dur: walkoff.flightDuration(r), home: at(0), atCatch: { ball: pl.ball(tc), glove: glove(tc), cf: at(tc) }, later: { ball: pl.ball(tc + 0.6), glove: glove(tc + 0.6) } };   // 중계수에게 던져 주기(잡고 0.9초) 전
    });
    expect(d.reveal).toBeCloseTo(Math.min(d.tc, 2.6), 5);
    expect(d.tc).toBeLessThanOrEqual(d.dur);
    expect(d.atCatch.ball.y).toBeGreaterThan(1.5);   // 땅에 떨어지기 전에 머리 위 글러브로 잡는다
    expect(Math.hypot(d.atCatch.ball.x - d.atCatch.glove.x, d.atCatch.ball.y - d.atCatch.glove.y, d.atCatch.ball.z - d.atCatch.glove.z)).toBeLessThan(0.5);
    expect(near(d.atCatch.cf, d.home, 1)).toBe(false);   // 제자리에서 기다린 게 아니라 뛰어갔다
    expect(d.atCatch.cf.pose).toBe('catchHigh');
    expect(Math.hypot(d.later.ball.x - d.later.glove.x, d.later.ball.y - d.later.glove.y, d.later.ball.z - d.later.glove.z)).toBeLessThan(0.05);   // 잡은 공은 글러브에 남는다
    expect(errors).toEqual([]);
  });

  test('좌전 안타: 공이 먼저 떨어지고(그때 결과 글자) 튀며 굴러가고, 좌익수가 한 번 튄 공을 주워 2루로 던진다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const r = { kind: 'single', hit: true, type: 'line', spray: -25, dist: 70, ev: 140, la: 15 };
      const pl = walkoff.fieldPlay(r), ev = pl.ev, dur = walkoff.flightDuration(r);
      const who = (t, pos) => { const q = walkoff.fieldersAt(r, t).find((x) => x.f.pos === pos); return { x: q.spot[0], z: q.spot[1], pose: q.pose }; };
      return { dur, ev, reveal: pl.reveal, landed: pl.ball(dur), rolled: pl.ball(dur + 0.4), lfAtLanding: who(dur, '좌익수'), ballAtPickup: pl.ball(ev.pickup), lfAtPickup: who(ev.pickup, '좌익수'),
        end: { ball: pl.ball(pl.end), cover: who(pl.end, '2루수') }, base2: { x: walkoff.BASE2[0], z: walkoff.BASE2[1] } };
    });
    expect(d.reveal).toBeCloseTo(Math.min(d.dur, 2.6), 5);   // 결과 글자는 공이 떨어질 때
    expect(d.landed.y).toBeLessThan(0.1);      // 아무도 못 잡고 떨어진다
    expect(Math.hypot(d.rolled.x - d.landed.x, d.rolled.z - d.landed.z)).toBeGreaterThan(1);   // 떨어진 뒤에도 굴러간다
    expect(d.ev.fielder).toBe('좌익수');
    expect(d.ev.pickup).toBeGreaterThan(d.dur + 0.3);   // 한 번 튄 뒤에 줍는다
    expect(near(d.lfAtLanding, d.landed, 1)).toBe(false);   // 떨어질 때는 아직 공에 못 왔다
    expect(near(d.lfAtPickup, d.ballAtPickup, 1.5)).toBe(true);   // 공 자리에 와서 줍는다
    expect(near(d.end.ball, d.base2, 1.5)).toBe(true);        // 2루로 던진다
    expect(near(d.end.cover, d.base2, 1)).toBe(true);       // 공 반대쪽 2루수가 2루에 들어가 받는다
    expect(errors).toEqual([]);
  });

  test('수비 전원: 3루·유격 쪽 땅볼이면 2루수가 2루·3루수가 3루·우익수가 1루 뒤로 가고, 1·2루 쪽이면 유격수가 2루·투수가 1루 쪽으로 간다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const F = (pos) => walkoff.DEFENSE.find((x) => x.pos === pos), spot = (pl, pos, t) => walkoff.actorState(pl, F(pos), t).spot;
      const left = { kind: 'out', type: 'ground', spray: -13, dist: 40, ev: 120, la: 2, fielder: F('유격수') };
      const right = { kind: 'out', type: 'ground', spray: 14, dist: 40, ev: 120, la: 2, fielder: F('2루수') };
      const a = walkoff.fieldPlay(left), b = walkoff.fieldPlay(right), B1 = walkoff.BASE1, B2 = walkoff.BASE2, B3 = walkoff.BASE3, dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      return {
        left: { b2: dist(spot(a, '2루수', a.end), B2), b3: dist(spot(a, '3루수', a.end), B3), rf: dist(spot(a, '우익수', a.end), B1), rfHome: dist(spot(a, '우익수', 0), B1) },
        right: { ss: dist(spot(b, '유격수', b.end), B2), p: dist(spot(b, '투수', b.end), B1), pHome: dist([0, 16.9], B1) },
      };
    });
    expect(d.left.b2).toBeLessThan(1.5);
    expect(d.left.b3).toBeLessThan(2.5);
    expect(d.left.rf).toBeLessThan(d.left.rfHome - 10);   // 1루 송구 뒤로 백업
    expect(d.right.ss).toBeLessThan(1.5);
    expect(d.right.p).toBeLessThan(d.right.pHome - 8);    // 투수가 1루 쪽으로
    expect(errors).toEqual([]);
  });

  test('수비수는 뛰는 쪽을 보고 뛰고(뒷걸음질 없음), 담장까지 굴러간 2루타 공은 담장을 넘지 않는다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const r = { kind: 'out', type: 'fly', spray: 5, dist: 92, ev: 140, la: 30, fielder: walkoff.FIELDERS.find((x) => x.pos === '중견수') };
      const pl = walkoff.fieldPlay(r), cf = walkoff.DEFENSE.find((x) => x.pos === '중견수');
      let worst = 0;
      for (let t = 0.5; t < pl.ev.catch - 0.4; t += 0.1) {
        const a = walkoff.actorState(pl, cf, t).spot, b = walkoff.actorState(pl, cf, t + 0.05).spot, v = [b[0] - a[0], b[1] - a[1]];
        if (Math.hypot(...v) < 0.1) continue;   // 거의 서 있으면 건너뛴다
        const k = walkoff.actorSkeleton(pl, cf, t), fc = k.axes ? k.axes.fc : k.facing(k.shTurn);
        const cos = (fc[0] * v[0] + fc[2] * v[1]) / Math.hypot(fc[0], fc[2]) / Math.hypot(...v);
        worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI);
      }
      const dbl = { kind: 'double', hit: true, type: 'line', spray: -30, dist: 95, ev: 175, la: 12 }, pd = walkoff.fieldPlay(dbl), fence = 100 + 22 * Math.cos(-30 * 2 * Math.PI / 180);
      let over = -99, low = 9;
      for (let t = 0; t < pd.end; t += 0.05) { const q = pd.ball(t); over = Math.max(over, Math.hypot(q.x, q.z - 0.3) - fence); low = Math.min(low, q.y); }
      return { worst, over, low };
    });
    expect(d.worst).toBeLessThan(30);
    expect(d.over).toBeLessThan(0);
    expect(d.low).toBeGreaterThanOrEqual(0.04 - 1e-9);
    expect(errors).toEqual([]);
  });

  test('1루 경주: 땅볼 아웃은 송구가 1루에 닿는 때와 주자가 1루를 밟는 때로 다시 정하고, 늦으면 내야 안타(300점)가 된다. 판정은 화면(폰)과 상관없다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const kinds = (bats) => { const out = { ground: 0, ifh: 0 }; for (let sd = 1; sd <= 40; sd++) { const seq = walkoff.makeSequence(sd, false); for (let n = 1; n <= 16; n++) for (let dt = -90; dt <= 90; dt += 6) { const r = walkoff.judgeSwing(seq[n - 1], dt, bats); if (r.type !== 'ground') continue; out.ground++; if (r.infield) out.ifh++; } } return out; };
      const R = kinds('R'), L = kinds('L'), mob = walkoff.view.mobile; walkoff.view.mobile = !mob; const R2 = kinds('R'); walkoff.view.mobile = mob;
      const seq = walkoff.makeSequence(1, false), safe = walkoff.judgeSwing(seq[3], -90, 'R'), out = walkoff.judgeSwing(seq[5], -78, 'R');
      return { R, L, R2, safe: { kind: safe.kind, hit: safe.hit, infield: safe.infield, name: safe.name, points: safe.points, reason: safe.reason, margin: safe.race.margin }, out: { kind: out.kind, margin: out.race.margin, reason: out.reason } };
    });
    expect(d.R2).toEqual(d.R);   // 폰 그림 이동과 상관없이 같은 판정
    for (const k of [d.R, d.L]) { expect(k.ifh / k.ground).toBeGreaterThan(0.025); expect(k.ifh / k.ground).toBeLessThan(0.11); }   // 땅볼의 몇 %만 내야 안타
    expect(Math.abs(d.R.ifh / d.R.ground - d.L.ifh / d.L.ground)).toBeLessThan(0.04);   // 우타·좌타가 한쪽으로 쏠리지 않는다
    expect(d.safe).toMatchObject({ kind: 'single', hit: true, infield: true, name: '3루수 내야 안타', points: 300 });   // 느린 땅볼에 달려 나와 맨손으로 잡아 던졌지만 늦었다
    expect(d.safe.margin).toBeLessThanOrEqual(0);
    expect(d.safe.reason).toContain('1루에');
    expect(d.out.kind).toBe('out');
    expect(d.out.margin).toBeGreaterThan(0);
    expect(d.out.reason).toContain('간발의 차로 아웃');
    expect(errors).toEqual([]);
  });

  test('1루 간발: 그림의 송구·주자도 판정한 때에 1루에 닿고, 판정 앞뒤는 느리게 흐르며 1루 위에 세이프·아웃을 띄운다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const seq = walkoff.makeSequence(1, false), one = (r) => {
        const pl = walkoff.fieldPlay(r), c = r.race, B1 = walkoff.BASE1;
        // 간발이면 주자는 머리부터 미끄러져 들어가서, 판정한 때에 베이스에 닿는 것은 뻗은 두 손이다
        const handsAt = (t) => { const k = walkoff.runnerSkeleton(walkoff.runnerAt(r, t)); return Math.hypot((k.hands.l[0] + k.hands.r[0]) / 2 - B1[0], (k.hands.l[2] + k.hands.r[2]) / 2 - B1[1]); };
        const ball = pl.ball(c.arrive.t), ballGap = Math.hypot(ball.x - B1[0], ball.z - B1[1]);
        return { margin: c.margin, end: pl.end, arrive: c.arrive.t, runner: c.runner, ballGap, runnerAtTouch: handsAt(c.runner), before: handsAt(c.runner - 0.1), slow: pl.slow.length, rate: pl.rate(Math.max(c.arrive.t, c.runner) - 0.1), call: pl.calls[0]?.text, revealReal: pl.revealReal, reveal: pl.reveal };
      };
      return { out: one(walkoff.judgeSwing(seq[5], -78, 'R')), safe: one(walkoff.judgeSwing(seq[3], -90, 'R')) };
    });
    for (const [k, v] of Object.entries(d)) {
      expect(v.ballGap, k).toBeLessThan(1.6);           // 송구는 판정한 때에 1루(뻗은 글러브)에 닿는다
      expect(v.runnerAtTouch, k).toBeLessThan(0.3);     // 주자는 판정한 때에 손으로 1루 앞쪽 끝을 짚는다(베이스는 가운데에서 0.35m까지)
      expect(v.before, k).toBeGreaterThan(v.runnerAtTouch + 0.2);   // 0.1초 앞에는 아직 닿기 전이다
      expect(v.slow, k).toBe(1);
      expect(v.rate, k).toBeCloseTo(0.4, 5);            // 판정 앞은 0.4배로 느리다
      expect(v.revealReal, k).toBeGreaterThan(v.reveal);  // 느린 만큼 결과 글자는 실제 시간으로 늦게 뜬다
    }
    expect(d.out.call).toBe('아웃');
    expect(d.safe.call).toBe('세이프');
    expect(errors).toEqual([]);
  });

  test('1루 머리부터 슬라이딩: 간발(느린 화면이 뜨는 공)이면 몸을 날려 엎드려 들어가고 여유 있는 판은 달려 지나간다. 좌타도 손이 판정한 때에 닿고, 세이프면 1루에 서고 아웃이면 파울 지역으로 나간다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const w = walkoff, B1 = w.BASE1, near = (q, b) => Math.hypot(q.x - b[0], q.z - b[1]);
      const close = (x) => !!x.race?.arrive && Math.abs(x.race.margin) < 0.15;
      const find = (bats, pred) => { for (let sd = 1; sd < 40; sd++) { const q = w.makeSequence(sd, false); for (let n = 0; n < 16; n++) for (let dt = -90; dt <= 90; dt += 3) { const x = w.judgeSwing(q[n], dt, bats); if (pred(x)) return x; } } return null; };
      const look = (r) => {
        const c = r.race, sk = (t) => w.runnerSkeleton(w.runnerAt(r, t)), hands = (k) => Math.hypot((k.hands.l[0] + k.hands.r[0]) / 2 - B1[0], (k.hands.l[2] + k.hands.r[2]) / 2 - B1[1]);
        let leg = 0, arm = 0, low = 9;
        for (let t = c.runner - 0.7; t < c.runner + 2.5; t += 0.01) {
          const k = sk(t);
          for (const s of ['l', 'r']) { leg = Math.max(leg, Math.hypot(...[0, 1, 2].map((i) => k.feet[s][i] - k.hips[s][i]))); arm = Math.max(arm, Math.hypot(...[0, 1, 2].map((i) => k.hands[s][i] - k.shoulders[s][i]))); }
          low = Math.min(low, k.pelvis[1]);
        }
        const gone = w.runnerAt(r, c.runner + 6);
        return { dive: !!(w.runnerAt(r, 1), r.runPlan.dive), touch: +hands(sk(c.runner)).toFixed(2), running: +sk(c.runner - 0.6).pelvis[1].toFixed(2), lying: +sk(c.runner + 0.3).pelvis[1].toFixed(2), up: +sk(c.runner + 1.5).pelvis[1].toFixed(2),
          leg: +leg.toFixed(3), arm: +arm.toFixed(3), low: +low.toFixed(2), onBag: +near(gone, B1).toFixed(2), foul: gone.x > gone.z + 3, headDown: sk(c.runner + 6).brim[1] < sk(c.runner + 6).head[1] - 0.05 };
      };
      const safeR = find('R', (x) => x.infield && close(x)), outR = find('R', (x) => x.kind === 'out' && close(x)), safeL = find('L', (x) => x.infield && close(x)), outL = find('L', (x) => x.kind === 'out' && close(x));
      const easy = find('R', (x) => x.kind === 'out' && x.race && x.race.margin > 0.5);
      return { safeR: look(safeR), outR: look(outR), safeL: look(safeL), outL: look(outL), easy: !!(w.runnerAt(easy, 1), easy.runPlan.dive) };
    });
    for (const k of ['safeR', 'outR', 'safeL', 'outL']) {
      const v = d[k];
      expect(v.dive, k).toBe(true);
      expect(v.touch, k).toBeLessThan(0.3);        // 판정한 때에 두 손이 1루 앞쪽 끝을 짚는다
      expect(v.running, k).toBeGreaterThan(0.8);   // 0.6초 앞에는 아직 달린다
      expect(v.lying, k).toBeLessThan(0.35);       // 닿은 뒤 엎드려 있다가
      expect(v.up, k).toBeGreaterThan(0.8);        // 1.5초 뒤에는 일어서 있다(선 주자의 엉덩이는 0.85m쯤)
      expect(v.leg, k).toBeLessThan(0.95);         // 팔다리는 닿는 길이 안(다리 0.91, 팔 0.59)
      expect(v.arm, k).toBeLessThan(0.6);
    }
    for (const k of ['safeR', 'safeL']) expect(d[k].onBag, k).toBeLessThan(0.6);   // 세이프면 1루에 서고
    for (const k of ['outR', 'outL']) expect([d[k].foul, d[k].headDown], k).toEqual([true, true]);   // 아웃이면 고개를 숙이고 파울 지역으로
    expect(d.easy).toBe(false);   // 여유 있는 아웃은 달려 지나간다
    expect(errors).toEqual([]);
  });

  test('잡는 방법: 달려서 닿는 땅볼은 몸을 날리지 않고(다이빙은 판정이 dive일 때만, 땅볼의 6% 안), 달려 나와 잡으면 멈추지 않고 옆으로 던진다(러닝 스로)', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const t = { n: 0, dive: 0, mismatch: 0, hows: {}, close: 0, closeDive: 0 };
      for (let sd = 1; sd <= 20; sd++) {
        const seq = walkoff.makeSequence(sd, false);
        for (let n = 1; n <= 16; n++) for (let dt = -90; dt <= 90; dt += 6) for (const bats of ['R', 'L']) {
          const r = walkoff.judgeSwing(seq[n - 1], dt, bats);
          if (!r.race) continue;
          const pl = walkoff.fieldPlay(r), dives = pl.acts[r.race.pos].some((e) => e.name === 'dive'), how = r.race.how;
          t.n++; if (dives) t.dive++; if (dives !== (how === 'dive') && how !== 'dive') t.mismatch++; t.hows[how] = (t.hows[how] || 0) + 1;
          if (r.race.arrive && Math.abs(r.race.margin) < 0.15) { t.close++; if (dives) t.closeDive++; }
        }
      }
      // 느린 땅볼에 달려 나와 맨손으로 줍는 3루수(간발 세이프)
      const seq = walkoff.makeSequence(1, false), r = walkoff.judgeSwing(seq[3], -90, 'R'), pl = walkoff.fieldPlay(r), f = walkoff.DEFENSE.find((x) => x.pos === r.race.pos);
      const pel = (tt) => walkoff.actorSkeleton(pl, f, tt).pelvis, rel = r.race.release.t, a = pel(rel - 0.05), b = pel(rel + 0.05);
      const hand = walkoff.actorSkeleton(pl, f, rel).hands.r, ball = pl.ball(rel + 0.001), k = walkoff.actorSkeleton(pl, f, rel);
      return { ...t, how: r.race.how, charge: r.race.charge, pos: r.race.pos, pose: walkoff.actorState(pl, f, rel).pose, speedAtRelease: Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.1,
        ballFromHand: Math.hypot(ball.x - hand[0], ball.y - hand[1], ball.z - hand[2]), handHeight: hand[1] - k.pelvis[1] };
    });
    expect(d.mismatch).toBe(0);                          // 판정이 다이빙이 아니면 그림도 몸을 날리지 않는다
    expect(d.dive / d.n).toBeLessThan(0.06);
    expect(d.hows.run / d.n).toBeGreaterThan(0.15);       // 달려 나와(달려가며) 잡아 그대로 던지는 공이 꽤 된다
    expect(d.closeDive / d.close).toBeLessThan(0.3);       // 간발은 대부분 러닝 스로이고 다이빙은 일부
    expect(d).toMatchObject({ how: 'run', charge: true, pos: '3루수', pose: 'runThrow' });
    expect(d.speedAtRelease).toBeGreaterThan(1.5);        // 공을 놓을 때도 몸이 1루 쪽으로 움직인다(멈춰 서서 던지지 않는다)
    expect(d.ballFromHand).toBeLessThan(0.05);           // 공은 판정한 때에 던지는 손에서 나간다
    expect(d.handHeight).toBeLessThan(0.75);             // 머리 위가 아니라 어깨 높이 옆에서 던진다
    expect(errors).toEqual([]);
  });

  test('1루수 토스: 멀리 잡은 1루수는 1루로 뛰어 오는 투수에게 아래로 던져 주고(공은 0.3~0.65초 난다), 투수는 달리며 받아 판정한 때에 베이스를 밟는다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      walkoff.settings.bats = 'L';
      const seq = walkoff.makeSequence(1, false), r = walkoff.judgeSwing(seq[4], -87, 'L'), pl = walkoff.fieldPlay(r), c = r.race, F = (pos) => walkoff.DEFENSE.find((x) => x.pos === pos), P = F('투수'), B1 = walkoff.BASE1;
      const tCatch = c.arrive.t - 0.12, glove = walkoff.actorSkeleton(pl, P, tCatch).hands.l, ball = pl.ball(tCatch);
      const sp = (t) => walkoff.actorState(pl, P, t).spot, a = sp(tCatch - 0.05), b = sp(tCatch + 0.05), atBag = sp(c.arrive.t);
      return { to: c.arrive.to, flight: tCatch - c.release.t, gap: Math.hypot(ball.x - glove[0], ball.y - glove[1], ball.z - glove[2]), pSpeed: Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1,
        bag: Math.hypot(atBag[0] - B1[0], atBag[1] - B1[1]), tossPose: walkoff.actorState(pl, F('1루수'), c.release.t).pose, released: pl.ball(c.release.t + 0.05).y };
    });
    expect(d.to).toBe('P');
    expect(d.tossPose).toBe('toss');              // 위로 세게 던지지 않고 아래로 던져 준다
    expect(d.flight).toBeGreaterThan(0.29);
    expect(d.flight).toBeLessThan(0.66);          // 공이 오래 떠서 투수를 기다리지 않는다(전에는 2초 넘게 떠 있었다)
    expect(d.gap).toBeLessThan(0.1);              // 받는 순간 공은 투수 글러브에
    expect(d.pSpeed).toBeGreaterThan(3);          // 투수는 달리며 받는다
    expect(d.bag).toBeLessThan(0.8);              // 판정한 때(받고 0.12초 뒤)에 베이스 위
    expect(errors).toEqual([]);
  });

  test('다이빙은 어려운 공만: 직선타·뜬공 아웃과 굴러가는 안타 공 줍기에 몸을 날리는 일이 드물고, 수비수는 사람 빠르기로 뛴다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const t = {};
      for (let sd = 1; sd <= 12; sd++) {
        const seq = walkoff.makeSequence(sd, false);
        for (let n = 1; n <= 16; n++) for (let dt = -90; dt <= 90; dt += 6) for (const bats of ['R', 'L']) {
          const r = walkoff.judgeSwing(seq[n - 1], dt, bats);
          if (r.kind === 'whiff' || r.kind === 'foul' || r.kind === 'hr') continue;
          const pl = walkoff.fieldPlay(r), key = `${r.type === 'ground' ? 'ground' : 'air'}/${r.kind === 'out' ? 'out' : 'hit'}`, c = (t[key] ??= { n: 0, dive: 0, top: 0, doubles: 0, miss: 0, missElse: 0 });
          c.n++;
          // 2루타에서 공 앞 외야수가 떨어지는 공에 몸을 날렸다가 놓치는 것(ev.miss)과 공 쪽 키스톤이 뜬 안타를 잡으려다 놓치는 것(ev.tries)은 따로 센다
          const missDive = (pos, e) => (pos === pl.ev.miss && e.t0 < pl.ev.land + 0.3) || !!pl.ev.tries?.some((x) => x.pos === pos && Math.abs(e.t0 - x.t) < 0.6);
          if (Object.entries(pl.acts).some(([pos, l]) => l.some((e) => e.name === 'dive' && !missDive(pos, e)))) c.dive++;
          const xbh = r.kind === 'double' || r.kind === 'triple';
          if (xbh) c.doubles++;
          if (pl.ev.miss) { if (xbh) c.miss++; else c.missElse++; }
          for (const l of Object.values(pl.acts)) for (const e of l) if (e.k === 'move') c.top = Math.max(c.top, e.gait.top);
        }
      }
      return t;
    });
    expect(d['air/out'].dive / d['air/out'].n).toBeLessThan(0.12);       // 전에는 직선타 아웃의 89%가 다이빙
    expect(d['air/hit'].dive / d['air/hit'].n).toBeLessThan(0.03);       // 떨어진 안타 공을 몸을 날려 줍지 않는다(전에는 76%)
    expect(d['air/hit'].missElse).toBe(0);                                 // 몸을 날렸다가 놓치는 것은 2루타·3루타에만
    expect(d['air/hit'].miss).toBeGreaterThan(0);
    expect(d['air/hit'].miss / d['air/hit'].doubles).toBeLessThan(0.3);   // 2루타의 21%쯤(공 앞의 외야수가 너무 일찍 주울 때만)
    expect(d['ground/hit'].dive / d['ground/hit'].n).toBeLessThan(0.2);  // 빠지는 땅볼은 거의 닿을 때 한 명만 몸을 날린다
    for (const c of Object.values(d)) expect(c.top).toBeLessThan(10);     // 초속 10m를 넘게 뛰지 않는다(전에는 11m까지 올려 몸을 날렸다)
    expect(errors).toEqual([]);
  });

  test('3루타: 담장을 맞고 외야수 사이로 빠진 공만 800점, 주자는 1·2루를 돌아 3루에 미끄러져 서고 공은 그 뒤에 3루에 닿는다. 끝내기 상황은 주자가 모두 들어온다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const B3 = walkoff.BASE3, t = { n: 0, triple: 0, notWall: 0, points: new Set(), worst: Infinity, standing: 0, slid: 0 };
      for (let sd = 1; sd <= 30; sd++) {
        const seq = walkoff.makeSequence(sd, false);
        for (let i = 0; i < 16; i++) for (let dt = -60; dt <= 60; dt += 3) for (const bats of ['R', 'L']) {
          const r = walkoff.judgeSwing(seq[i], dt, bats);
          if (r.kind === 'whiff' || r.kind === 'foul') continue;
          t.n++;
          if (r.kind !== 'triple') continue;
          t.triple++; if (!r.wall) t.notWall++; t.points.add(r.points);
          const pl = walkoff.fieldPlay(r), reach = walkoff.runnerReach(r, B3);
          t.worst = Math.min(t.worst, pl.ev.arrive - reach);
          if (walkoff.runnerSkeleton(walkoff.runnerAt(r, reach)).pelvis[1] < 0.4) t.slid++;
          const q = walkoff.runnerAt(r, reach + 1.6); if (Math.hypot(q.x - B3[0], q.z - B3[1]) < 0.5) t.standing++;
        }
      }
      const scn = { outs: 1, bases: [true, true, true], away: 5, home: 3, count: { b: 0, s: 0 }, pa: [] };
      const msg = walkoff.applyScenario(scn, { kind: 'triple', hit: true });
      return { ...t, points: [...t.points], scn: { home: scn.home, bases: scn.bases, end: scn.end, msg } };
    });
    expect(d.triple).toBeGreaterThan(20);
    expect(d.triple / d.n).toBeLessThan(0.03);       // 드물게(좋은 타구의 3%쯤)
    expect(d.notWall).toBe(0);                        // 담장을 맞은 공만
    expect(d.points).toEqual([800]);
    expect(d.worst).toBeGreaterThan(0.44);            // 주자가 먼저 3루를 밟는다
    expect(d.slid).toBe(d.triple);                    // 미끄러져 들어가
    expect(d.standing).toBe(d.triple);                // 일어나 3루에 선다
    expect(d.scn).toMatchObject({ home: 6, bases: [false, false, true], end: 'win' });   // 만루 3루타: 셋 다 들어와 역전
    expect(errors).toEqual([]);
  });

  test('2루타: 공은 주자가 2루를 밟고 0.45초 넘게 지나서 2루에 닿는다(멀면 공 쪽 키스톤이 중계해 돌아 던진다)', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const B2 = walkoff.BASE2, t = { n: 0, worst: Infinity, relay: 0, offBag: 0, waits: [] };
      for (let sd = 1; sd <= 10; sd++) {
        const seq = walkoff.makeSequence(sd, false);
        for (let n = 1; n <= 16; n++) for (let dt = -90; dt <= 90; dt += 6) for (const bats of ['R', 'L']) {
          const r = walkoff.judgeSwing(seq[n - 1], dt, bats);
          if (r.kind !== 'double') continue;
          const pl = walkoff.fieldPlay(r), run = walkoff.runnerReach(r, B2), ball = pl.ball(pl.ev.arrive);
          t.n++; t.worst = Math.min(t.worst, pl.ev.arrive - run); if (pl.ev.relay) t.relay++; t.waits.push(pl.ev.wait);
          if (Math.hypot(ball.x - B2[0], ball.z - B2[1]) > 1.5) t.offBag++;
        }
      }
      return t;
    });
    expect(d.n).toBeGreaterThan(50);
    expect(d.worst).toBeGreaterThan(0.44);    // 주자가 먼저 2루를 밟는다(전에는 2루타의 72%에서 공이 먼저였다)
    expect(d.relay).toBeGreaterThan(d.n / 2); // 멀리서 주운 공은 중계수를 거친다
    expect(d.offBag).toBe(0);                 // 공은 2루에 들어간 사람 글러브에 닿는다
    // 2루로 던질 사람이 주자를 기다리며 공을 들고 서 있는 일이 드물다(공을 일찍 주우면 외야수가 몸을 날렸다가 놓치고 공이 담장까지 구른다).
    // 그렇게 안 하면 2루타의 18%에서 중계수가 공을 2초 넘게 들고 있었다
    expect(d.waits.filter((w) => w > 0.6).length / d.n).toBeLessThan(0.06);
    expect(Math.max(...d.waits)).toBeLessThan(2);
    expect(errors).toEqual([]);
  });

  test('끝내기 주루 플레이: 홈 승부·태그업·병살은 그림의 공과 미끄러지는 주자가 판정(core)이 정한 때에 베이스에 닿고, 정해지기 전에는 상황판·알림이 그대로다', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game, near = (q, b, d) => Math.hypot(q.x - b[0], q.z - b[1]) < d;
      const hit = (k, sd, i, dt) => {
        w.paused = true; w.startGame('scenario'); w.useScenario(k);
        const p = w.makeSequence(sd, w.pitcherHand(sd) === 'L')[i]; g.seq[0] = p;
        for (let n = 0; n < 3000 && g.state !== 'result'; n++) { if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000); g.clockAt += 1000 / 60; w.update(1 / 60); }
        return g.outcome;
      };
      const out = {};
      // 단타 홈 승부(1아웃 2루): 외야수 송구가 홈(포수)에 닿는 때·주자가 홈에 미끄러져 닿는 때가 판정과 같고, 아웃은 정해질 때까지 전광판·알림에 안 보인다
      const a = hit(1, 1, 2, -40), hp = a.scnPlay.home, pa = w.fieldPlay(a), ra = w.scenarioRuns(a)[0];
      g.resultT = g.revealAt + 1;   // 결과 글자는 이미 떴다(안타는 떨어질 때). 아웃은 홈에서 정해질 때 보인다
      const before = (() => { g.flightT = hp.runner - 0.3; return { o: w.boardView().o }; })(), after = (() => { g.flightT = Math.max(hp.arrive + 0.2, hp.runner) + 0.05; return { o: w.boardView().o }; })();
      out.home = { safe: hp.safe, receiver: pa.ev.receiver, ballHome: near(pa.ball(hp.arrive + 0.02), [-0.9, 1.0], 1.2), early: !near(pa.ball(hp.arrive - 0.3), [-0.9, 1.0], 1.2), runner: Math.abs(ra.legs[0].end - hp.runner), before, after, event: g.scnEvent };
      // 얕은 안타(내야수가 주움): 2루 주자는 3루에서 멈추고 포수는 나오지 않는다
      const b = hit(1, 1, 0, -90), rb = w.scenarioRuns(b)[0], endB = rb.legs[0].route.at(-1);
      out.hold = { hold: !!b.scnPlay.home.hold, at3: Math.hypot(endB[0] - w.BASE3[0], endB[1] - w.BASE3[1]) < 1, catcher: '포수' in w.fieldPlay(b).acts, bases: g.scn.bases };
      // 태그업(1아웃 2루, 외야 뜬공): 3루로 던진 공은 주자가 미끄러져 닿은 뒤에 3루에 닿는다
      const c = hit(1, 1, 0, 25), tg = c.scnPlay.tag, pc = w.fieldPlay(c), rc = w.scenarioRuns(c)[0];
      out.tag = { go: tg.go, ball3: near(pc.ball(tg.arrive + 0.02), w.BASE3, 1.5), runner: Math.abs(rc.legs.at(-1).end - tg.runner), first: tg.runner < tg.arrive, bases: g.scn.bases };
      // 병살(0아웃 1루, 3루수 땅볼): 공이 판정한 때에 2루, 다음에 1루에 닿고 1루 주자는 그때 2루에 미끄러져 들어간다
      const d = hit(3, 1, 3, -65), dp = d.scnPlay.dp, pd = w.fieldPlay(d), rd = w.scenarioRuns(d)[0];
      out.dp = { out1: dp.out1, ball2: near(pd.ball(dp.atSecond + 0.02), w.BASE2, 1.5), ball1: near(pd.ball(dp.atFirst + 0.02), w.BASE1, 1.5), runner: Math.abs(rd.legs[0].end - (dp.runner2)), outs: g.scn.outs, event: g.scnEvent };
      w.paused = false;
      return out;
    });
    expect(r.home).toMatchObject({ safe: false, receiver: '포수', ballHome: true, early: true, before: { o: 1 }, after: { o: 2 }, event: '홈에서 아웃 · 2아웃' });
    expect(r.home.runner).toBeLessThan(0.02);   // 그림의 미끄러지기가 판정의 주자 도착과 같다(같은 1/120초 계산)
    expect(r.hold).toEqual({ hold: true, at3: true, catcher: false, bases: [true, false, true] });
    expect(r.tag).toMatchObject({ go: true, ball3: true, first: true, bases: [false, false, true] });
    expect(r.tag.runner).toBeLessThan(0.02);
    expect(r.dp).toMatchObject({ out1: true, ball2: true, ball1: true, outs: 2, event: '병살 · 2아웃' });
    expect(r.dp.runner).toBeLessThan(0.02);
    expect(errors).toEqual([]);
  });

  test('끝내기 상황: 누상 주자가 리드해 서 있다가 결과대로 뛰고, 끝내기 승리는 이긴 점수가 홈을 밟으면 버튼 없이 끝 화면이 된다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('scenario'));
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    const lead = await page.evaluate(() => {
      const g = walkoff.game, B = [walkoff.BASE1, walkoff.BASE2, walkoff.BASE3];
      Object.assign(g.scn, { outs: 2, bases: [true, true, true], away: 3, home: 3, count: { b: 3, s: 0 } });
      g.seq[g.i] = walkoff.makeSequence(7, false).find((q) => walkoff.judgeTake(q).kind === 'ball');   // 존 밖 공: 그냥 보내면 밀어내기 볼넷
      return walkoff.scenarioRunners().map((q, i) => Math.hypot(q.x - B[i][0], q.z - B[i][1]));
    });
    expect(lead).toHaveLength(3);   // 만루면 셋이 서 있다(전에는 전광판에만 주자가 있었다)
    for (const d of lead) { expect(d).toBeGreaterThan(1.5); expect(d).toBeLessThan(3.5); }   // 다음 베이스 쪽으로 리드
    await page.waitForFunction(() => walkoff.game.state === 'result', null, { timeout: 10_000 });
    const res = await page.evaluate(() => ({ end: walkoff.game.scn.end, home: walkoff.game.scn.home, winT: walkoff.walkoffTime(walkoff.game.outcome) }));
    expect(res).toMatchObject({ end: 'win', home: 4 });
    expect(res.winT).toBeGreaterThan(2);   // 3루 주자가 홈까지 걸어 들어올 때
    await page.waitForTimeout(1500);
    const mid = await page.evaluate(() => ({ state: walkoff.game.state, runners: walkoff.scenarioRunners().length }));
    expect(mid).toEqual({ state: 'result', runners: 3 });   // 들어오는 동안은 결과 화면에서 주자가 뛴다
    await page.waitForFunction(() => walkoff.game.state === 'over', null, { timeout: 10_000 });   // 아무것도 누르지 않아도 끝 화면
    expect(await page.evaluate(() => walkoff.game.summary.end)).toBe('win');
    expect(errors).toEqual([]);
  });

  test('끝내기 상황: 끝내기 홈런은 공이 관중석에 들어가고 HOMERUN을 다 띄운 뒤에 끝 화면이 된다(전에는 공이 날아가는 중에 끝났다)', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game; w.paused = true;   // 장면을 1/60초씩 직접 넘긴다
      w.startGame('scenario');
      Object.assign(g.scn, { outs: 2, bases: [true, true, false], away: 3, home: 2, count: { b: 0, s: 0 } });   // 홈런이면 5:3 끝내기
      const p = w.makeSequence(1, false)[0]; g.seq[g.i] = p;   // 4ms 빨리 치면 가운데 130m 홈런
      for (let k = 0; k < 3000 && g.state !== 'result'; k++) {
        if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T - 0.004) w.swing(g.clockAt + Math.max(0, p.T - 0.004 - w.ballTime()) * 1000);
        g.clockAt += 1000 / 60; w.update(1 / 60);
      }
      const name = g.outcome.name, end = w.chaseEnd(g.outcome);
      let lastT = null, t1 = null, moment = 0;
      for (let k = 0; k < 60 * 12 && g.state === 'result'; k++) {
        g.clockAt += 1000 / 60; w.update(1 / 60);
        if (g.state !== 'result') break;
        lastT = g.resultT; t1 = w.boardMoment()?.t1 ?? t1;
        if (w.scoreboardShows() === 'moment') moment += 1 / 60;
      }
      return { name, state: g.state, win: g.summary?.end ?? null, end, lastT, t1, moment };
    });
    expect(r.name).toBe('중월 홈런');
    expect(r).toMatchObject({ state: 'over', win: 'win' });
    expect(r.lastT).toBeGreaterThan(r.end);               // 공이 관중석에 들어가고 카메라가 돌아온 뒤에
    expect(r.lastT).toBeGreaterThanOrEqual(r.t1 - 0.02);  // HOMERUN을 다 띄우고 끝난다
    expect(r.moment).toBeGreaterThan(1.5);                // HOMERUN 1.6초
    expect(errors).toEqual([]);
  });

  test('끝내기 상황의 내야 안타는 밀려서 한 베이스씩만 간다(1·2루면 만루, 점수 없음). 보통 안타는 2루 주자가 들어온다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const mk = () => ({ away: 3, home: 2, outs: 1, bases: [true, true, false], count: { b: 0, s: 0 }, pa: [] });
      const a = mk(), b = mk();
      walkoff.applyScenario(a, { kind: 'single', hit: true, infield: true });
      walkoff.applyScenario(b, { kind: 'single', hit: true });
      return { a: { bases: a.bases, home: a.home }, b: { bases: b.bases, home: b.home } };
    });
    expect(d.a).toEqual({ bases: [true, true, true], home: 2 });
    expect(d.b).toEqual({ bases: [true, true, false], home: 3 });
    expect(errors).toEqual([]);
  });

  test('실제 화면: 땅볼 송구가 1루에 닿는 순간 1루가 화면 안에 있고(카메라가 받는 쪽을 미리 봄), 다시 보기 중에는 수비수가 제자리다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('practice'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    const end = await page.evaluate(() => {   // 판정은 그대로 두고 결과만 넣어 화면이 따라가는지 본다
      const f = walkoff.FIELDERS.find((x) => x.pos === '유격수'), r = { kind: 'out', name: '유격수 땅볼', type: 'ground', spray: -13, dist: 40, ev: 120, la: 2, fielder: f, points: 0, reason: '', dt: 0 };
      Object.assign(walkoff.game, { state: 'result', outcome: r, resultT: 0, flightT: 0, swingAt: walkoff.ballTime(), revealAt: walkoff.fieldPlay(r).reveal });
      return walkoff.fieldPlay(r).end;
    });
    await page.waitForFunction((end) => walkoff.game.flightT >= end, end, { timeout: 10_000 });   // 공이 1루에 닿는 순간(결과 글자가 뜰 때)
    const b = await page.evaluate(() => { const q = walkoff.project(walkoff.BASE1[0], 0, walkoff.BASE1[1]); return { x: q.x, y: q.y, w: walkoff.view.w, h: walkoff.view.h }; });
    expect(b.x).toBeGreaterThan(0); expect(b.x).toBeLessThan(b.w);
    expect(b.y).toBeGreaterThan(0); expect(b.y).toBeLessThan(b.h);
    await page.evaluate(() => walkoff.startReplay());
    const spots = await page.evaluate(() => walkoff.fieldersNow().map((q) => [q.pose, Math.hypot(q.spot[0] - Math.sin(q.f.a * Math.PI / 180) * q.f.d, q.spot[1] - Math.cos(q.f.a * Math.PI / 180) * q.f.d)]));
    expect(spots.every(([pose, off]) => pose === 'ready' && off < 0.01)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('수비 다듬기: 투수 옆을 빠르게 지나는 땅볼에 투수가 움찔하고(멀면 안 함), 뜬공을 잡은 외야수는 중계수에게 가볍게 던져 주고(내야 뜬공은 안 함), 홈런이면 투수가 무릎에 손을 짚었다가 일어난다', async ({ page }) => {
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const w = walkoff, P = w.DEFENSE.find((f) => f.pos === '투수'), F = (pos) => w.DEFENSE.find((f) => f.pos === pos), pHome = [0, 16.94];
      const seq = w.makeSequence(1, w.pitcherHand(1) === 'L'), play = (i, dt) => { const r = w.judgeSwing(seq[i], dt, 'R'); return { r, pl: w.fieldPlay(r) }; };
      const act = (pl, name) => pl.acts['투수'].find((e) => e.name === name), flat = (b, p) => Math.hypot(b.x - p[0], b.z - p[1]);
      const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // 움찔: 유격수 땅볼(시드 1 일곱째 공 -25ms)은 투수 옆으로 지나간다. 가장 높이 뜬 때 공이 투수 옆을 지나고, 두 발이 뜨고, 글러브는 허리 아래로
      const a = play(6, -25), fa = act(a.pl, 'flinch'), top = w.actorSkeleton(a.pl, P, fa.t0 + 0.18), land = w.actorSkeleton(a.pl, P, fa.t1 + 0.3);
      const glove = top.mitt === 'r' ? top.hands.r : top.hands.l;
      const flinch = { name: a.r.name, pass: flat(a.pl.ball(fa.t0 + 0.18), pHome), feet: [top.feet.l[1], top.feet.r[1]], gloveBelow: top.pelvis[1] - glove[1], landFeet: [land.feet.l[1], land.feet.r[1]] };
      const farR = { kind: 'out', type: 'ground', spray: -13, dist: 40, ev: 120, la: 2, fielder: F('유격수') };   // 유격수 정면 땅볼은 투수에게서 4m 넘게 떨어져 지나간다
      const far = !!act(w.fieldPlay(farR), 'flinch');
      // 투수 옆 안타(시드 1 일곱째 공 -10ms): 움찔한 뒤 옆으로 돌아서서 빠져나간 공을 본다(전에는 숙인 자세로 굳었다)
      const b = play(6, -10), fb = act(b.pl, 'flinch'), watchB = b.pl.acts['투수'].find((e) => e.t0 >= fb.t1 && e.name === 'watch');
      // 가볍게 던져 주기: 좌익수 뜬공(시드 1 첫 공 -50ms)을 잡고 0.9초 넘게 지나 유격수에게 높게 던지고, 공은 유격수 글러브에 닿는다
      const c = play(0, -50), L = c.pl.ev.lob, ss = w.actorSkeleton(c.pl, F(L.to), L.arrive + 0.05).hands.l, inGlove = c.pl.ball(L.arrive + 0.05);
      let high = 0; for (let t = L.release; t <= L.arrive; t += 0.02) high = Math.max(high, c.pl.ball(t).y);
      const lob = { name: c.r.name, to: L.to, wait: L.release - c.pl.ev.catch, flight: L.arrive - L.release, high, gap: gap([inGlove.x, inGlove.y, inGlove.z], ss) };
      let pop = null;   // 내야 뜬공은 던져 주지 않는다
      for (let i = 0; i < 16 && !pop; i++) for (let dt = -90; dt <= 90 && !pop; dt += 5) { const r = w.judgeSwing(seq[i], dt, 'R'); if (r.kind === 'out' && r.type === 'pop') pop = { lob: !!w.fieldPlay(r).ev.lob }; }
      // 홈런(시드 1 첫 공 -10ms): 옆으로 돌아서서 보다가, 공이 담장을 넘으면 무릎에 손을 짚고 고개를 숙이고, 일어난 뒤에도 고개를 숙인 채 선다
      const h = play(0, -10), watch = act(h.pl, 'watch'), st = w.actorSkeleton(h.pl, P, watch.t0 + 0.3), s = h.pl.acts['투수'].find((e) => e.name === 'slump' && !e.track), rise = act(h.pl, 'rise');   // st: 서서 공을 보는 때
      const k = w.actorSkeleton(h.pl, P, s.t0 + 0.3), up = w.actorSkeleton(h.pl, P, rise.t1 + 0.3), over = h.pl.ball(s.t0 - 0.7 - 0.2);
      const hr = { name: h.r.name, watchSide: Math.abs(Math.cos(watch.face)), overDist: Math.hypot(over.x, over.z), knees: [gap(k.hands.l, k.knees.l), gap(k.hands.r, k.knees.r)], drop: st.head[1] - k.head[1], down: k.head[1] - k.brim[1], upDrop: st.head[1] - up.head[1], upDown: up.head[1] - up.brim[1] };
      return { flinch, far, b: { name: b.r.name, flinch: !!fb, watchSide: watchB ? Math.abs(Math.cos(watchB.face)) : 0 }, lob, pop, hr };
    });
    expect(d.flinch.name).toBe('유격수 땅볼');
    expect(d.flinch.pass).toBeLessThan(2.2);   // 가장 높이 뜬 때 공이 투수 옆을 지난다
    expect(Math.min(...d.flinch.feet)).toBeGreaterThan(0.2);   // 두 발이 뜬다
    expect(d.flinch.gloveBelow).toBeGreaterThan(0.4);   // 글러브는 공 쪽 아래로
    expect(Math.max(...d.flinch.landFeet)).toBeLessThan(0.08);   // 내려앉아 선다
    expect(d.far).toBe(false);
    expect(d.b).toEqual({ name: '중전 안타', flinch: true, watchSide: expect.any(Number) });
    expect(d.b.watchSide).toBeGreaterThan(0.99);   // 옆으로 돌아선다(홈을 보던 데서 90도)
    expect(d.lob.name).toBe('좌익수 뜬공');
    expect(d.lob.to).toBe('유격수');
    expect(d.lob.wait).toBeGreaterThan(0.9);
    expect(d.lob.flight).toBeGreaterThan(1.2);   // 가볍게(외야 송구보다 느리게, 높게)
    expect(d.lob.high).toBeGreaterThan(2.5);
    expect(d.lob.gap).toBeLessThan(0.05);   // 유격수 글러브에 닿는다
    expect(d.pop).toEqual({ lob: false });
    expect(d.hr.name).toBe('좌중월 홈런');
    expect(d.hr.watchSide).toBeGreaterThan(0.99);   // 옆으로 돌아서서 본다
    expect(d.hr.overDist).toBeGreaterThan(100);   // 공이 담장을 넘은 뒤에 숙인다
    expect(Math.max(...d.hr.knees)).toBeLessThan(0.15);   // 두 손이 무릎에
    expect(d.hr.drop).toBeGreaterThan(0.35);   // 숙였다
    expect(d.hr.down).toBeGreaterThan(0.05);   // 고개를 숙인다
    expect(d.hr.upDrop).toBeLessThan(0.08);   // 일어났다
    expect(d.hr.upDown).toBeGreaterThan(0.05);   // 일어나도 고개는 숙인 채
    expect(errors).toEqual([]);
  });

  // 2026-11-09 사용자 '수비 선수들이 너무 딱딱함'(고른 것 1·2번). 전에는 수비수 시간의 57%가 완전히 멈춰 있었고, 뛰기 시작·멈출 때 장면의 99%에서 몸이 접히며 휙 돌았다
  test('수비 동작: 공을 친 뒤 서 있는 수비수는 숨 쉬듯 움직이며 공 쪽으로 몸을 돌리고, 돌아설 때 몸이 접히지 않는다(치기 전 자세는 그대로)', async ({ page, isMobile }) => {
    test.skip(isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');
    const errors = await open(page, '?seed=1');
    const d = await page.evaluate(() => {
      const w = walkoff, F = (pos) => w.DEFENSE.find((f) => f.pos === pos), J = (k) => [k.pelvis, k.chest, k.head, k.hands.l, k.hands.r, k.feet.l, k.feet.r];
      const moved = (a, b) => Math.max(...J(a).map((p, i) => Math.hypot(p[0] - J(b)[i][0], p[1] - J(b)[i][1], p[2] - J(b)[i][2])));
      const fc = (k) => k.axes?.fc ?? k.facing(k.shTurn), seq = w.makeSequence(1, w.pitcherHand(1) === 'L');
      // 치기 전(수비 일정 없음)에는 3초 동안 한 관절도 안 움직인다(조준 타격 테스트 동안 치기 전 화면은 바꾸지 않는다)
      const before = Math.max(...w.DEFENSE.map((f) => moved(w.actorSkeleton(null, f, 0), w.actorSkeleton(null, f, 3.3))));
      // 좌익수 뜬공(시드 1 첫 공 -54ms): 우익수는 할 일이 없어 내내 제자리 준비 자세다. 맞는 순간은 치기 전 자세 그대로이고, 그 뒤로는 0.25초마다 자세가 바뀐다
      const r = w.judgeSwing(seq[0], -54, 'R'), pl = w.fieldPlay(r), RF = F('우익수'), at = w.actorState(pl, RF, 0).spot;
      const at0 = moved(w.actorSkeleton(pl, RF, 0), w.actorSkeleton(null, RF, 0)), steps = [];
      for (let t = 1; t < 4; t += 0.25) steps.push(moved(w.actorSkeleton(pl, RF, t), w.actorSkeleton(pl, RF, t + 0.25)));
      // 공이 좌익수 쪽에 있을 때 몸(어깨)이 치기 전보다 공 쪽을 본다(수평 방향의 내적 차이)
      const b = pl.ball(2), to = [b.x - at[0], b.z - at[1]], n = Math.hypot(...to), look = (k) => (fc(k)[0] * to[0] + fc(k)[2] * to[1]) / n;
      const toward = look(w.actorSkeleton(pl, RF, 2)) - look(w.actorSkeleton(null, RF, 2));
      // 같은 타구를 다시 만들어도 똑같다(무작위 없음)
      const again = w.fieldPlay(w.judgeSwing(seq[0], -54, 'R')), same = [1.3, 2.7].every((t) => moved(w.actorSkeleton(pl, RF, t), w.actorSkeleton(again, RF, t)) === 0);
      // 시드 1~4 공 3개씩·5가지 타이밍의 수비수 8명(공을 친 뒤 투구 그림인 투수는 빼고): 어깨 폭(0.4m)이 가장 좁을 때, 뛰기·서 있기 중 한 장면(1/60초)에 도는 가장 큰 각
      let minW = 9, maxTurn = 0;
      for (let seed = 1; seed <= 4; seed++) {
        const s = w.makeSequence(seed, w.pitcherHand(seed) === 'L');
        for (let i = 0; i < 3; i++) for (let dt = -48; dt <= 48; dt += 24) {
          const q = w.judgeSwing(s[i], dt, 'R');
          if (!q.ev || q.kind === 'whiff' || q.kind === 'foul') continue;
          const p = w.fieldPlay(q);
          for (const f of w.DEFENSE) {
            let prev = null;
            for (let t = 0; t <= p.end; t += 1 / 60) {
              if (f.pos === '투수' && !p.acts['투수'].some((e) => e.t0 <= t)) continue;
              const k = w.actorSkeleton(p, f, t), sh = k.shoulders, yaw = Math.atan2(sh.l[2] - sh.r[2], sh.l[0] - sh.r[0]), pose = w.actorState(p, f, t).pose;
              minW = Math.min(minW, Math.hypot(sh.l[0] - sh.r[0], sh.l[1] - sh.r[1], sh.l[2] - sh.r[2]));
              if (prev != null && ['run', 'ready', 'watch', 'backup', 'cover'].includes(pose)) maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(yaw - prev), Math.cos(yaw - prev))) * 180 / Math.PI);
              prev = yaw;
            }
          }
        }
      }
      return { before, at0, steps, toward, same, minW, maxTurn };
    });
    expect(d.before).toBe(0);
    expect(d.at0).toBeLessThan(1e-9);
    expect(Math.min(...d.steps)).toBeGreaterThan(0.02);   // 전에는 0(같은 자세로 서 있었다)
    expect(d.toward).toBeGreaterThan(0.1);
    expect(d.same).toBe(true);
    expect(d.minW).toBeGreaterThan(0.3);   // 전에는 0(어깨가 한 점으로 모였다 펴졌다)
    expect(d.maxTurn).toBeLessThan(30);    // 전에는 한 장면에 180도 가까이 휙 돌았다
    expect(errors).toEqual([]);
  });

  test('키스톤 반응: 안타가 된 뜬공·직선타에 공 쪽 2루수·유격수가 뛰어오르거나 몸을 날려 아슬아슬하게 놓치고(공에 닿지 않는다), 아니면 쫓거나 커버·중계 자리로 바로 간다', async ({ page, isMobile }) => {
    test.skip(isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');
    const errors = await open(page);
    const d = await page.evaluate(() => {
      const w = walkoff, t = { air: 0, leap: 0, dive: 0, nearGlove: 0, nearBody: 0, idle: 0, offGlove: 0, throws: 0, kinds: new Set() };
      const d3 = (p, b) => Math.hypot(p[0] - b.x, p[1] - b.y, p[2] - b.z), F = (pos) => w.DEFENSE.find((f) => f.pos === pos);
      for (let sd = 1; sd <= 8; sd++) {
        const seq = w.makeSequence(sd, w.pitcherHand(sd) === 'L');
        for (let i = 0; i < 16; i++) for (let dt = -90; dt <= 90; dt += 6) for (const bats of ['R', 'L']) {
          const r = w.judgeSwing(seq[i], dt, bats);
          if (!(r.type === 'line' || r.type === 'fly') || !['single', 'double', 'triple'].includes(r.kind)) continue;
          const kind = r.kind, pl = w.fieldPlay(r), K = F(Math.max(-43, Math.min(43, r.spray)) < 0 ? '유격수' : '2루수');
          t.air++; if (r.kind !== kind) t.kinds.add(r.kind);   // 수비 그림은 판정을 바꾸지 않는다
          const tr = pl.ev.tries?.[0];
          if (tr) {
            t[tr.how]++;
            let g = Infinity, b = Infinity;
            for (let s = Math.max(0, tr.t - 0.5); s <= tr.t + 0.5; s += 1 / 240) {
              const ball = pl.ball(s); if (s > pl.ev.land) continue;
              const k = w.actorSkeleton(pl, K, s);
              g = Math.min(g, d3(k.hands.l, ball), d3(k.hands.r, ball)); b = Math.min(b, d3(k.pelvis, ball), d3(k.chest, ball), d3(k.head, ball));
            }
            if (g < 0.2) t.nearGlove++;
            if (b < 0.3) t.nearBody++;
          }
          // 맞고 2.4초가 지나도록 첫 동작(뛰기·옆걸음·점프·다이빙)이 없으면 멍하니 선 것(전에는 뜬 안타의 56%)
          const first = pl.acts[K.pos].find((e) => e.k !== 'pose' || e.track);
          if ((first ? first.t0 : pl.end) > 2.4) t.idle++;
          for (const [tt, pos] of [[pl.ev.relayAt, pl.ev.relay], [pl.ev.arrive, pl.ev.receiver]]) {   // 중계·베이스 송구는 받는 글러브에 닿는다
            if (tt == null || !F(pos)) continue;
            t.throws++; if (d3(w.actorSkeleton(pl, F(pos), tt).hands.l, pl.ball(tt)) > 0.3) t.offGlove++;
          }
        }
      }
      return { ...t, kinds: [...t.kinds] };
    });
    expect(d.air).toBeGreaterThan(2000);
    expect((d.leap + d.dive) / d.air).toBeGreaterThan(0.08);   // 전에는 0(머리 위 직선타에도 서 있었다)
    expect((d.leap + d.dive) / d.air).toBeLessThan(0.3);
    expect(d.leap).toBeGreaterThan(20);
    expect(d.dive).toBeGreaterThan(100);
    expect(d.nearGlove).toBe(0);   // 판정이 안타라 글러브·몸은 공에 닿지 않는다
    expect(d.nearBody).toBe(0);
    expect(d.idle / d.air).toBeLessThan(0.02);
    expect(d.throws).toBeGreaterThan(d.air);
    expect(d.offGlove).toBe(0);
    expect(d.kinds).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('결과 공유', () => {
  // 모바일은 공유 창, PC는 클립보드로 나간다. 둘 다 가로채서 나간 글을 window.__shared에 남긴다
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__shared = null;
      navigator.share = async (data) => { window.__shared = data.text; };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__shared = t; } } });
    });
  });

  // 공 하나를 치지 않고 보낸 뒤 판을 끝낸다
  async function endAfterOnePitch(page, mode) {
    await page.evaluate((mode) => {
      walkoff.startGame(mode);
      if (mode !== 'scenario') Object.assign(walkoff.game, { left: 1, extra: 99 });   // 기회 1번, 볼이어도 기회가 늘지 않게
    }, mode);
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    if (mode === 'scenario') await page.evaluate(() => { walkoff.game.scn.end = walkoff.game.scn.end || 'win'; });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
  }

  const MODES = [
    ['10구 도전', 'challenge', /^walkoff 10구 도전 \(우타\)$/, '다시 하기'],
    ['끝내기 상황', 'scenario', /^walkoff 끝내기 상황 \(우타\)$/, '다시 하기'],
  ];
  for (const [name, mode, firstLine, other] of MODES) {
    test(`${name} 끝 화면: 결과 공유하기를 누르면 첫 줄에 모드가 적힌 결과가 나간다`, async ({ page }) => {
      const errors = await open(page);
      await endAfterOnePitch(page, mode);
      await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '결과 공유하기'));
      expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain(other);
      const r = await page.evaluate(() => walkoff.ui.buttons.find((b) => b.label === '결과 공유하기').r);
      await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
      await page.waitForFunction(() => window.__shared != null);
      const lines = (await page.evaluate(() => window.__shared)).split('\n');
      expect(lines[0]).toMatch(firstLine);
      expect(lines.at(-1)).toBe('https://hyunseungbeom.github.io/walkoff/');
      expect(errors).toEqual([]);
    });
  }

  test('모바일에서 그림 공유가 되면 결과 카드 그림(1080x1080)과 공유 글을 함께 보낸다. 안 되면 글만 보내고, 공유 창이 떠 있는 동안 또 눌러도 한 번만 연다', async ({ page, isMobile }) => {
    test.skip(!isMobile, '모바일만 공유 창을 쓴다(PC는 클립보드에 복사)');
    await page.addInitScript(() => {
      window.__calls = []; window.__filesOk = true; window.__close = null;
      navigator.canShare = (d) => !d.files || window.__filesOk;
      navigator.share = (data) => { window.__calls.push(data); return new Promise((resolve) => { window.__close = resolve; }); };   // 공유 창은 닫을 때까지 떠 있다
    });
    const errors = await open(page);
    await endAfterOnePitch(page, 'challenge');
    await page.waitForFunction(() => walkoff.game.shareCard?.file != null);
    await tap(page, '결과 공유하기');
    await tap(page, '결과 공유하기');   // 공유 창이 떠 있는 동안 또 누른다
    expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    const sent = await page.evaluate(async () => {
      const d = window.__calls[0], f = d.files?.[0], img = f && await createImageBitmap(f);
      return { files: d.files?.length ?? 0, type: f?.type, w: img?.width, h: img?.height, text: d.text };
    });
    expect(sent).toMatchObject({ files: 1, type: 'image/png', w: 1080, h: 1080 });
    expect(sent.text.split('\n')[0]).toMatch(/^walkoff 10구 도전 \(우타\)$/);
    expect(sent.text.split('\n').at(-1)).toBe('https://hyunseungbeom.github.io/walkoff/');
    // 그림 공유가 안 되는 브라우저는 예전처럼 글만 보낸다
    await page.evaluate(() => { window.__close(); window.__filesOk = false; });
    await expect.poll(() => page.evaluate(() => walkoff.game.sharing)).toBe(false);
    await tap(page, '결과 공유하기');
    expect(await page.evaluate(() => ({ n: window.__calls.length, files: window.__calls[1].files ?? null, same: window.__calls[1].text === window.__calls[0].text })))
      .toEqual({ n: 2, files: null, same: true });
    expect(errors).toEqual([]);
  });

  test('결과 카드에는 끝 화면의 큰 줄과 주소가 들어간다(10구 도전은 등급·새 최고 기록과 연속 일수, 끝내기 상황은 결과)', async ({ page }) => {
    const errors = await open(page);
    // 카드를 그릴 때 쓴 글자를 차례대로 모은다
    const cardTexts = (s, mode) => page.evaluate(({ s, mode }) => {
      const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, seen = [];
      proto.fillText = function (str, ...rest) { seen.push(String(str)); return fill.call(this, str, ...rest); };
      try { walkoff.drawShareCard(s, mode); } finally { proto.fillText = fill; }
      return seen;
    }, { s, mode });
    await setPlayedDays(page, [0, 1, 2]);
    const base = { score: 2350, hr: 1, hits: 3, balls: 2, far: 118, lights: 'GRYGRRYGRRRR', bats: 'R' };
    expect(await cardTexts(base, 'challenge')).toEqual(['끝내기', 'walkoff', '10구 도전 · 우타', '2,350', '주전 타자 · 3일 연속', '홈런 1 · 안타 3 · 볼 2 · 가장 멀리 118m', 'walkoff · hyunseungbeom.github.io/walkoff']);
    expect((await cardTexts({ ...base, bats: 'L', newBest: true }, 'challenge')).slice(2, 5)).toEqual(['10구 도전 · 좌타', '2,350', '새 최고 기록! · 3일 연속']);
    const scn = await cardTexts({ end: 'win', away: 3, home: 4, pa: 'RGYG', pitches: 9, label: '2아웃 만루', bats: 'R' }, 'scenario');
    expect(scn.slice(2, 6)).toEqual(['끝내기 상황 · 우타', '끝내기 승리!', expect.stringMatching(/^\S+ 3 : 4 \S+ · 9회말$/), '타석 4 · 안타 2 · 볼넷 1 · 투구 9개']);
    expect(errors).toEqual([]);
  });
});

test.describe('랭킹 규칙', () => {
  test.skip(({ isMobile }) => isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');

  test('게임과 서버가 같은 상점 목록(id·종류·가격)을 쓴다', async ({ page }) => {
    const shop = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'shop.js')).href);
    await open(page);
    const game = await page.evaluate(() => ({ items: walkoff.SHOP_ITEMS.map(({ id, slot, price }) => ({ id, slot, price })), slots: walkoff.SHOP_SLOTS.map(([s]) => s) }));
    expect(game.items).toEqual(shop.ITEMS);
    expect(game.slots).toEqual(shop.SLOTS);
  });

  test('연속 안타 보너스는 n번째마다 서버의 연속 홈런 보너스 이하라 서버 점수 상한을 넘지 않는다', async ({ page }) => {
    const srv = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'core', 'score.js')).href);   // 서버가 점수 상한에 쓰는 파일
    await open(page);
    const ns = Array.from({ length: 41 }, (_, i) => i);
    const hit = await page.evaluate((ns) => ns.map(walkoff.hitStreakBonus), ns);
    ns.forEach((n) => expect(hit[n] <= srv.hrStreakBonus(n) || n < 2, `${n}연속`).toBe(true));
  });

  test('게임과 서버가 같은 연속 홈런 보너스를 쓴다(서버는 이걸로 점수 상한을 잰다)', async ({ page }) => {
    const srv = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'core', 'score.js')).href);
    await open(page);
    const ns = [0, 1, 2, 3, 4, 5, 10, 40];
    expect(await page.evaluate((ns) => ns.map(walkoff.hrStreakBonus), ns)).toEqual(ns.map(srv.hrStreakBonus));
  });

  test('게임과 서버가 같은 공 순서를 만든다(서버가 전광판·점수를 그 순서로 맞춰 본다)', async ({ page }) => {
    const srv = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'core', 'pitches.js')).href);   // 서버가 공 순서에 쓰는 파일
    await open(page);
    const days = ['2026-10-28', '2026-10-30', '2027-01-01'];   // 서버는 예전 탭이 보내는 오늘의 10구도 그날 시드로 검사한다
    const seeds = [1, 42, 1793319865, 2147483646, ...days.map(srv.dailySeed)];
    const game = await page.evaluate((seeds) => ({
      hands: seeds.map(walkoff.pitcherHand),
      seqs: seeds.flatMap((s) => [false, true].map((lefty) => walkoff.makeSequence(s, lefty))),
    }), seeds);
    expect(game.hands).toEqual(seeds.map(srv.pitcherHand));
    expect(game.seqs).toEqual(seeds.flatMap((s) => [false, true].map((lefty) => srv.makeSequence(s, lefty))));
  });

  test('게임과 랭킹 서버가 같은 팀 목록과 주 계산(한국 시간 월요일 시작)을 쓴다', async ({ page }) => {
    const rules = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    await open(page);
    const days = Array.from({ length: 400 }, (_, i) => rules.addDays('2026-10-01', i));
    const game = await page.evaluate((days) => ({ ids: walkoff.TEAMS.map((t) => t.id), weeks: days.map((d) => walkoff.weekStartOf(d)) }), days);
    expect(game.ids).toEqual(rules.TEAM_IDS);
    expect(game.weeks).toEqual(days.map((d) => rules.weekStart(d)));
  });
});

test.describe('이용 통계', () => {
  test.skip(({ isMobile }) => isMobile, '보내는 내용은 화면 크기와 상관없어서 PC에서만 본다');

  // 게임이 보낸 신호를 window.__beacons에 남긴다. human이면 사람이 연 브라우저처럼 navigator.webdriver를 끈다
  async function catchBeacons(page, { human }) {
    await page.addInitScript((human) => {
      if (human) Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.__beacons = [];
      navigator.sendBeacon = (url, body) => { window.__beacons.push({ url, body: JSON.parse(body) }); return true; };
    }, human);
  }
  const beacons = (page) => page.evaluate(() => window.__beacons);
  const leave = (page) => page.evaluate(() => window.dispatchEvent(new Event('pagehide')));   // 창을 닫거나 다른 앱으로 갈 때

  // 2026-11-04부터 판 시작·끝을 모아 두었다가 묶음 하나로 보낸다(js/infra/stats.js, 서버 하루 요청·DB 쓰기 한도 때문)
  test('사람이 친 판은 시작·끝을 모아 화면을 떠날 때 묶음 하나로 보내고, 기기 번호·날짜·모드별 수·터치 여부 말고는 보내지 않는다', async ({ page }) => {
    const { MODES, validateEvent } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'stats.js')).href);
    const { kstDay } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    await catchBeacons(page, { human: true });
    const errors = await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝나게
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    for (const mode of ['scenario', 'practice']) await page.evaluate((m) => walkoff.startGame(m), mode);   // 다른 모드는 시작만(오늘의 10구는 없앴다)
    expect(await beacons(page)).toEqual([]);   // 판마다 보내지 않는다
    await leave(page);
    const sent = await beacons(page);
    expect(sent.map((b) => b.url)).toEqual([`${API}/events`]);
    const body = sent[0].body, today = kstDay(Date.now());
    expect(Object.keys(body).sort()).toEqual(['counts', 'day', 'device', 'mobile']);
    expect(body.day).toBe(today);
    expect(body.counts).toEqual({ challenge: { starts: 1, ends: 1 }, scenario: { starts: 1, ends: 0 }, practice: { starts: 1, ends: 0 } });
    for (const mode of Object.keys(body.counts)) expect(MODES).toContain(mode);   // 서버(worker/src/stats.js)가 받는 모드만 보낸다
    expect(validateEvent(body, today)).toMatchObject({ ok: true, value: { n: 4 } });   // 서버가 그대로 받는 모양이다
    const ids = await page.evaluate(() => ({ device: localStorage.getItem('walkoff.device'), player: walkoff.settings.playerId }));
    expect(ids.device).toMatch(/^[a-z0-9-]{8,40}$/);
    expect(body.device).toBe(ids.device);
    expect(ids.device).not.toBe(ids.player);   // 랭킹 ID와 다른 번호라 통계와 랭킹이 이어지지 않는다
    await leave(page);
    expect((await beacons(page)).length).toBe(1);   // 보낸 묶음은 비웠다
    expect(await page.evaluate(() => localStorage.getItem('walkoff.statsQueue'))).toBe(null);
    expect(errors).toEqual([]);
  });

  test('20개가 쌓이면 화면을 떠나기 전에도 보내고, 못 보낸 묶음(보내기가 막혔거나 창을 갑자기 닫음)은 다음에 열 때 보낸다', async ({ page }) => {
    await catchBeacons(page, { human: true });
    await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    for (let i = 0; i < 21; i++) await page.evaluate(() => walkoff.startGame('practice'));
    expect((await beacons(page)).map((b) => b.body.counts)).toEqual([{ practice: { starts: 20, ends: 0 } }]);
    for (let i = 0; i < 2; i++) await page.evaluate(() => walkoff.startGame('scenario'));   // 남은 연습 1 + 끝내기 2는 기기에 적혀 있다
    await page.evaluate(() => { navigator.sendBeacon = () => false; });   // 떠날 때 보내기가 막혔다(새로고침도 떠나는 신호를 내서 막아야 남는다)
    await page.reload();
    await page.waitForFunction(() => !!window.walkoff);
    expect((await beacons(page)).map((b) => b.body.counts)).toEqual([{ practice: { starts: 1, ends: 0 }, scenario: { starts: 2, ends: 0 } }]);
    expect(await page.evaluate(() => localStorage.getItem('walkoff.statsQueue'))).toBe(null);
  });

  test('자동 브라우저(테스트, 봇)는 세지 않는다', async ({ page }) => {
    await catchBeacons(page, { human: false });
    await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    await page.evaluate(() => walkoff.startGame('challenge'));
    await leave(page);
    expect(await beacons(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('walkoff.statsQueue'))).toBe(null);
  });

  test('이 컴퓨터에서 연 게임(?api 없이)은 세지 않는다', async ({ page }) => {
    await catchBeacons(page, { human: true });
    await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    await leave(page);
    expect(await beacons(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('walkoff.statsQueue'))).toBe(null);
  });

  test('스윙 결과 수: 10구(기준선)와 조준 실험의 스윙을 모드·입력별로 묶음에 더하고(맞힘·안타·정타·조준 자리), 조준 판 수는 aim으로 센다. 서버가 그대로 받는 모양이다', async ({ page }) => {
    const { validateEvent } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'stats.js')).href);
    const { kstDay } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    await catchBeacons(page, { human: true });
    const errors = await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    await page.evaluate(() => walkoff.startGame('challenge'));   // 10구: 스페이스바로 정확히(seed 42 첫 공은 홈런)
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    await page.evaluate(() => walkoff.startGame('challenge', false, { aim: true }));   // 조준: 마우스(배트 손잡이)를 공이 지날 자리를 치는 곳에 두고 스페이스바
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    const c = await page.evaluate(() => { const p = walkoff.game.seq[walkoff.game.i], q = walkoff.project(p.tx, p.ty, 0); return walkoff.aimGripFor(q.x, q.y); });
    await page.mouse.move(c.x, c.y);
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    await leave(page);
    const body = (await beacons(page))[0].body, today = kstDay(Date.now());
    expect(body.counts).toEqual({ challenge: { starts: 1, ends: 0 }, aim: { starts: 1, ends: 0 } });
    expect(body.swings).toEqual({ 'challenge|key': { swings: 1, contacts: 1, hits: 1, perfect: 1, near: 0, edge: 0, miss: 0 }, 'aim|key': { swings: 1, contacts: 1, hits: 1, perfect: 1, near: 1, edge: 0, miss: 0 } });
    expect(validateEvent(body, today)).toMatchObject({ ok: true, value: { n: 4 } });
    expect(errors).toEqual([]);
  });
});

test.describe('조준 타격(실험)', () => {
  // 공이 홈플레이트 앞면을 지나는 자리(화면 px). 투구 중에는 화면을 밀지 않아 그대로 쓴다
  const crossAt = (page) => page.evaluate(() => { const p = walkoff.game.seq[walkoff.game.i], c = walkoff.project(p.tx, p.ty, 0); return { x: c.x, y: c.y }; });
  // 지금 공이 닿는 시각보다 dt(ms) 늦게 캔버스에 포인터 이벤트를 보낸다(pressAt과 같은 방식)
  const fireAt = (page, dt, ev) => page.evaluate(({ dt, ev }) => new Promise((resolve) => {
    const g = walkoff.game, target = g.seq[g.i].T + dt / 1000;
    const tick = () => {
      if (walkoff.ballTime() < target - 0.08) { requestAnimationFrame(tick); return; }
      const at = g.clockAt + (target - walkoff.ballTime()) * 1000;
      while (performance.now() < at) { /* 보낼 시각까지 기다린다 */ }
      document.querySelector('canvas').dispatchEvent(new PointerEvent(ev.type, { bubbles: true, pointerId: ev.id ?? 7, pointerType: ev.pointerType, clientX: ev.x, clientY: ev.y }));
      resolve();
    };
    requestAnimationFrame(tick);
  }), { dt, ev });
  const touch = (page, type, x, y, id = 7) => page.evaluate(({ type, x, y, id }) => document.querySelector('canvas').dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y })), { type, x, y, id });
  const outcome = (page) => page.evaluate(() => { const g = walkoff.game, r = g.outcome; return { state: g.state, kind: r?.kind, took: !!r?.took, zone: r?.aimZone ?? null, miss: !!r?.aimMiss, reason: r?.reason, aim: g.aims[g.i] ?? null, swingAt: g.swingAt }; });
  // PC·폰 모두 누른 자리가 배트 손잡이 끝이고 배트는 타자 반대쪽으로 거의 수평이다(2026-11-05 사용자 결정). c(맞힐 자리)를 치려면 마우스·손가락을 둘 자리
  const gripFor = (page, c) => page.evaluate((c) => walkoff.aimGripFor(c.x, c.y), c);
  const nextPitch = async (page) => {   // 결과를 건너뛰고 다음 공
    await page.evaluate(() => { const g = walkoff.game; g.resultT = Math.max(g.resultT, g.revealAt) + 1; walkoff.tap(g.clockAt); });
    await page.waitForFunction(() => ['windup', 'over'].includes(walkoff.game.state));
  };

  test('PC: 메뉴에서 시작하면 10구 규칙의 조준 판이고, 마우스(배트 손잡이)를 공이 지날 자리를 치는 곳에 두고 제때 치면 맞고 멀면 헛스윙이며 클릭은 누른 자리를 손잡이로 친다. 끝까지 쳐도 랭킹·최고·연속 기록에 안 들어가고 조준 최고 기록만 남는다', { tag: '@min' }, async ({ page, isMobile }) => {
    test.skip(isMobile, '마우스는 PC에서 본다');
    const errors = await open(page, '?seed=42', { login: true });
    await tap(page, '메뉴');
    await tap(page, '조준 타격(실험)');
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    expect(await page.evaluate(() => ({ mode: walkoff.game.mode, aim: walkoff.game.aim, ticket: walkoff.game.ticket, left: walkoff.game.left }))).toEqual({ mode: 'challenge', aim: true, ticket: null, left: 10 });
    expect(await page.evaluate(() => walkoff.boardView().label)).toBe('조준 실험');   // 위 전광판 모드 이름(전광판은 미리 그려 둔 그림이라 값으로 본다)
    expect(await drawnTexts(page)).toContain('마우스로 겨누고 클릭 · 랭킹에는 안 올라가요');
    // 1구: 공이 지날 자리를 치는 곳(손잡이)에 마우스를 두고 제때 스페이스바
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    let c = await crossAt(page), k = await gripFor(page, c);
    await page.mouse.move(k.x, k.y);
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    let o = await outcome(page);
    expect(o.kind).not.toBe('whiff');
    expect(o.zone).toBe('near');
    expect(Math.hypot(o.aim.x, o.aim.y)).toBeLessThan(0.1);
    // 2구: 마우스가 공에서 멀면 타이밍이 맞아도 헛스윙
    await nextPitch(page);
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    c = await crossAt(page);
    await page.mouse.move(c.x + 200, c.y);
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    o = await outcome(page);
    expect(o).toMatchObject({ kind: 'whiff', zone: 'miss', miss: true });
    expect(o.reason).toMatch(/^공 오른쪽 \d+cm로 헛스윙$/);
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.3);
    expect(await drawnTexts(page)).toContain('타이밍 정확 · 과녁 밖');   // 공은 존 안이라 '존 밖 공'이 아니다
    // 3구: 마우스는 멀리 있어도 공이 지날 자리를 치는 곳을 제때 클릭하면 그 자리를 손잡이로 친다
    await nextPitch(page);
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    c = await crossAt(page); k = await gripFor(page, c);
    await page.mouse.move(k.x - 300, k.y);
    await fireAt(page, 0, { type: 'pointerdown', pointerType: 'mouse', x: k.x, y: k.y });
    await page.waitForFunction(() => walkoff.game.state === 'result');
    o = await outcome(page);
    expect(o.kind).not.toBe('whiff');
    expect(o.aim.kind).toBe('mouse');
    // 끝까지: 랭킹·최고 기록·연속 기록·기록 화면에 안 들어가고 조준 최고 기록만
    await page.evaluate(() => { walkoff.game.left = 0; });
    await nextPitch(page);
    await page.waitForFunction(() => walkoff.game.state === 'over');
    const saved = await page.evaluate(() => ({ score: walkoff.game.summary.score, aimBest: walkoff.store.get('aimBest', null), best: walkoff.store.get('best', null), played: walkoff.store.get('played.' + walkoff.today(), null), stats: walkoff.store.get('stats', null) }));
    expect(saved.score).toBeGreaterThan(0);
    expect(saved).toEqual({ score: saved.score, aimBest: saved.score, best: null, played: null, stats: null });
    expect(errors.calls.filter((x) => x.path === '/scores')).toEqual([]);
    const texts = await drawnTexts(page), labels = await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label));
    expect(texts).toEqual(expect.arrayContaining(['조준 타격(실험)', '실험판이라 랭킹·코인·연속 기록에는 안 올라가요']));
    expect(labels).toEqual(expect.arrayContaining(['다시 하기', '처음으로']));
    expect(labels).not.toContain('결과 공유하기');
    await tap(page, '다시 하기');
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.aim])).toEqual(['windup', true]);   // 다시 해도 조준 판
    expect(errors).toEqual([]);
  });

  test('폰: 누른 자리가 배트 손잡이 끝이고 맞는 자리는 손가락에서 타자 반대쪽 옆으로 100px쯤이라, 끌어 맞춘 뒤 제때 떼면 맞는다. 와인드업 중에 떼면 아무 일도 없고, 안 떼면 지켜본 공이며, 손가락은 하나만 받는다', async ({ page, isMobile }) => {
    test.skip(!isMobile, '터치는 폰에서 본다');
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge', false, { aim: true }));
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    expect(await drawnTexts(page)).toContain('끌어서 겨누고 떼면 스윙 · 랭킹에는 안 올라가요');
    // 1구: 와인드업 중에 누르고, 다른 손가락은 받지 않고, 끌어 맞는 자리(손가락에서 오른쪽으로 100px쯤)를 맞춘 뒤 제때 뗀다
    let c = await crossAt(page), f = await gripFor(page, c);
    await touch(page, 'pointerdown', f.x - 60, f.y + 70);
    await touch(page, 'pointerdown', f.x + 90, f.y + 140, 8);
    await touch(page, 'pointermove', f.x + 90, f.y + 140, 8);
    await touch(page, 'pointermove', f.x, f.y);
    const cur = await page.evaluate(() => walkoff.aimCursor()), bat = await page.evaluate((cur) => walkoff.aimBatPoints(cur), cur);
    expect(cur).toMatchObject({ kind: 'touch' });
    expect(Math.hypot(cur.x - c.x, cur.y - c.y)).toBeLessThan(0.5);
    expect(Math.hypot(bat.knob.x - f.x, bat.knob.y - f.y)).toBeLessThan(0.5);   // 손잡이 끝이 손가락
    expect(bat.tip.x).toBeGreaterThan(c.x); expect(bat.tip.y).toBeGreaterThanOrEqual(c.y);   // 배트는 손가락에서 오른쪽으로 눕고 굵은 쪽은 내려가거나 수평이다
    expect(Math.hypot(c.x - f.x, c.y - f.y)).toBeGreaterThan(80); expect(Math.hypot(c.x - f.x, c.y - f.y)).toBeLessThan(120);   // 손잡이에서 맞는 자리까지 100px쯤
    expect((await outcome(page)).swingAt).toBe(null);   // 누르기만 해서는 휘두르지 않는다
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await fireAt(page, 0, { type: 'pointerup', pointerType: 'touch', x: f.x, y: f.y });
    await page.waitForFunction(() => walkoff.game.state === 'result');
    let o = await outcome(page);
    expect(o.kind).not.toBe('whiff');
    expect(o).toMatchObject({ zone: 'near' });
    expect(o.aim.kind).toBe('touch');
    // 2구: 와인드업 중에 눌렀다 떼면 아무 일도 없고, 그대로 두면 지켜본 공
    await nextPitch(page);
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    await touch(page, 'pointerdown', 120, 500);
    await touch(page, 'pointerup', 120, 500);
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.swingAt])).toEqual(['windup', null]);
    await page.waitForFunction(() => walkoff.game.state === 'result', null, { timeout: 10_000 });
    expect(await outcome(page)).toMatchObject({ took: true, swingAt: null });
    // 3구: 누른 채로 지켜본 공 판정이 나면 지켜본 공이고, 그 뒤에 떼도 휘두르지 않는다
    await nextPitch(page);
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    f = await gripFor(page, await crossAt(page));
    await touch(page, 'pointerdown', f.x, f.y);
    await page.waitForFunction(() => walkoff.game.state === 'result', null, { timeout: 10_000 });
    await touch(page, 'pointerup', f.x, f.y);
    expect(await outcome(page)).toMatchObject({ took: true, swingAt: null });
    expect(await page.evaluate(() => walkoff.aimPointer.touch)).toBe(null);
    expect(errors).toEqual([]);
  });

  test('배트 커서: PC·폰 모두 누른 자리가 손잡이 끝이고 배트는 타자 반대쪽으로 거의 수평(낮은 공은 굵은 쪽이 내려가고, 좌타는 거울), 손잡이에서 맞는 자리까지 칠 자리 깊이의 0.38m이며, 과녁은 그 배트 축을 따라 rx·수직으로 ry(9cm)로 잰다. 조준 판은 존이 흐리고, 처음 세 판만 \'공이 배트에 닿을 때 치세요\'를 띄운다', async ({ page, isMobile }) => {
    test.skip(isMobile, '판정과 그림 계산은 화면 크기와 상관없어서 PC에서만 본다');
    const errors = await open(page, '?seed=42');
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game; w.paused = true;
      const toPitch = (aim) => { w.startGame('challenge', false, { aim }); const p = g.seq[g.i]; while (!(g.state === 'pitch' && w.ballTime() + 1 / 60 >= p.T)) { g.clockAt += 1000 / 60; w.update(1 / 60); } return p; };
      const tiltAtBall = () => { const p = g.seq[g.i], c = w.project(p.tx, p.ty, 0); return w.aimTilt(w.aimHeight(c.y)); };
      const hit = (along, across, kind = 'mouse') => {   // 공이 지날 자리에서 배트 축을 따라 along m, 수직으로 across m 떨어진 곳을 겨누고 정확한 타이밍에 친다
        const p = toPitch(true), c = w.project(p.tx, p.ty, 0), t = tiltAtBall(), { d, n } = w.aimAxes(t), dx = d.x * along + n.x * across, dy = d.y * along + n.y * across;
        w.swing(g.clockAt + (p.T - w.ballTime()) * 1000, kind, { x: c.x + dx * c.s, y: c.y - dy * c.s, kind, t });
        return { kind: g.outcome.kind, zone: g.outcome.aimZone, x: g.aims[g.i].x, y: g.aims[g.i].y };
      };
      const R = w.AIM_RADIUS.mouse;
      const along = hit(0.97 * R.x, 0), across = hit(0, 1.1 * R.y), tall = hit(0, 0.08);   // 축에 수직으로 8cm: 옛 과녁(6cm) 밖이었다
      const touchAlong = hit(0.97 * R.x, 0, 'touch'), touchAcross = hit(0, 1.1 * R.y, 'touch');
      const inside = hit(0, 0.17), outside = hit(0, 0.19);   // 세로 0.18m 안은 맞고 넘으면 헛스윙(2026-11-05 저녁 2배)
      // 그린 띠(판정 타원과 가운데 몫)의 반지름(m): drawAimBat이 그리는 타원 둘을 잰다
      const band = (() => {
        const proto = CanvasRenderingContext2D.prototype, el = proto.ellipse, seen = [];
        proto.ellipse = function (x, y, rx, ry, ...a) { seen.push([rx, ry]); return el.call(this, x, y, rx, ry, ...a); };
        try { w.drawAimBat({ x: 700, y: 500, kind: 'mouse' }); w.drawAimBat({ x: 700, y: 500, kind: 'touch' }); } finally { proto.ellipse = el; }
        const sc = w.project(0, 0.8, 0).s;
        return seen.map(([a, b]) => [+(a / sc).toFixed(4), +(b / sc).toFixed(4)]);
      })();
      // 그림: 높은 공(존 위끝)과 낮은 공(존 아래끝) 자리에 맞는 자리를 두고 손잡이·끝을 본다(우타·좌타)
      const top = w.project(0, 1.1, 0), low = w.project(0, 0.5, 0), s = w.project(0, 0.8, 0).s;
      const bat = (y) => w.aimBatPoints({ x: 700, y, kind: 'mouse' }), slope = (q) => Math.atan2(q.tip.y - q.knob.y, Math.abs(q.tip.x - q.knob.x)) * 180 / Math.PI;
      const hiR = bat(top.y), loR = bat(low.y);
      w.setBats('L'); const hiL = bat(top.y), loL = bat(low.y); w.setBats('R');
      // 누른 자리 → 맞는 자리(gripSpot)와 그 거꾸로(aimGripFor)가 맞는다
      const k = w.aimGripFor(700, low.y), back = w.gripSpot(k.x, k.y, 'touch'), mouse = w.gripSpot(k.x, k.y, 'mouse');
      // 존(네모) 선의 밝기: 10구와 조준 판을 한 장면씩 그려 존 테두리(strokeRect)의 투명도를 본다
      const zoneAlpha = (aim) => {
        toPitch(aim);
        const proto = CanvasRenderingContext2D.prototype, sr = proto.strokeRect, seen = [];
        proto.strokeRect = function (...a) { const m = /rgba\(255, 255, 255, ([\d.]+)\)/.exec(String(this.strokeStyle)); if (m) seen.push(Number(m[1])); return sr.apply(this, a); };
        try { w.render(g.t); } finally { proto.strokeRect = sr; }
        return Math.max(...seen);
      };
      const zone = { plain: zoneAlpha(false), aim: zoneAlpha(true) };
      // 처음 세 판만 안내(이미 위에서 판을 몇 번 시작해서 저장소 값을 지우고 센다)
      localStorage.removeItem('walkoff.aimHint');
      const shown = [];
      for (let k = 0; k < 4; k++) {
        toPitch(true);
        const proto = CanvasRenderingContext2D.prototype, ft = proto.fillText, texts = [];
        proto.fillText = function (s, ...a) { texts.push(String(s)); return ft.call(this, s, ...a); };
        try { w.render(g.t); } finally { proto.fillText = ft; }
        shown.push(texts.includes('공이 배트에 닿을 때 치세요 · 클릭'));
      }
      return { along, across, tall, touchAlong, touchAcross, inside, outside, band, R: { ...R }, s, hiR, loR, hiL, loL, slope: { hi: slope(hiR), lo: slope(loR), hiL: slope(hiL), loL: slope(loL) },
        reach: Math.hypot(loR.knob.x - 700, loR.knob.y - low.y) / s, batLen: Math.hypot(loR.knob.x - loR.tip.x, loR.knob.y - loR.tip.y) / s,
        round: Math.hypot(back.x - 700, back.y - low.y), mouseKind: mouse.kind, touchKind: back.kind, zone, shown, hintCount: Number(localStorage.getItem('walkoff.aimHint')) };
    });
    expect(r.along.kind).not.toBe('whiff');   // 배트 축 위(rx의 0.97배)는 맞는다
    expect(r.along.zone).toBe('edge');
    expect(Math.hypot(r.along.x, r.along.y)).toBeCloseTo(0.97, 2);
    expect(r.across).toMatchObject({ kind: 'whiff', zone: 'miss' });   // 축에 수직으로 ry를 넘으면 헛스윙
    expect(r.across.y).toBeCloseTo(1.1, 2);
    expect(r.R).toEqual({ x: 0.15, y: 0.18 });   // 2026-11-05 저녁 가로 1.5배·세로 2배(전에는 0.10·0.09)
    expect(r.inside.kind).not.toBe('whiff'); expect(r.outside).toMatchObject({ kind: 'whiff', zone: 'miss' });
    expect(r.band).toEqual([[0.15, 0.18], [0.0525, 0.063], [0.15, 0.18], [0.0525, 0.063]]);   // 그린 띠가 판정 타원과 같고, 안쪽 밝은 몫은 정타가 나는 가운데(0.35배)
    expect(r.tall.kind).not.toBe('whiff'); expect(r.tall.zone).toBe('edge');
    expect(r.touchAlong.kind).not.toBe('whiff'); expect(r.touchAlong.zone).toBe('edge');   // 폰도 같은 배트 축으로 잰다
    expect(r.touchAcross).toMatchObject({ kind: 'whiff', zone: 'miss' });
    expect(r.reach).toBeCloseTo(0.38, 2);    // 손잡이에서 맞는 자리까지 칠 자리 깊이의 0.38m(PC 1440 폭에서 155px쯤)
    expect(r.reach * r.s).toBeGreaterThan(140); expect(r.reach * r.s).toBeLessThan(170);
    expect(r.batLen).toBeCloseTo(0.47, 2);   // 맞는 자리 너머 0.09m까지
    expect(r.hiR.knob.x).toBeLessThan(700); expect(r.hiR.tip.x).toBeGreaterThan(700);   // 우타: 손잡이는 왼쪽, 굵은 쪽은 오른쪽
    expect(r.hiL.knob.x).toBeGreaterThan(700); expect(r.hiL.tip.x).toBeLessThan(700);   // 좌타는 거울
    expect(r.slope.hi).toBeGreaterThan(0); expect(r.slope.hi).toBeLessThan(4);      // 높은 공은 거의 수평(굵은 쪽이 2도 아래)
    expect(r.slope.lo).toBeGreaterThan(15); expect(r.slope.lo).toBeLessThan(26);    // 낮은 공은 굵은 쪽이 내려간다
    expect(r.slope.hiL).toBeCloseTo(r.slope.hi, 5); expect(r.slope.loL).toBeCloseTo(r.slope.lo, 5);
    expect(r.round).toBeLessThan(0.1);       // 손잡이 자리에서 다시 낸 맞는 자리가 처음 자리와 같다
    expect([r.mouseKind, r.touchKind]).toEqual(['mouse', 'touch']);
    expect(r.zone.aim).toBeCloseTo(r.zone.plain * 0.45, 2);   // 조준 판의 존은 흐리게
    expect(r.zone.plain).toBeCloseTo(0.55 * 0.9, 2);          // 10구는 그대로
    expect(r.shown).toEqual([true, true, true, false]);
    expect(r.hintCount).toBe(3);
    expect(errors).toEqual([]);
  });

  test('폰: 360·375·390·430 폭(사파리 높이 548·664)에서 존 네 모서리 공을 손가락이 화면 안에 있는 채로 끌어 맞춰 칠 수 있다(우타·좌타)', async ({ page, isMobile }) => {
    test.skip(!isMobile, '터치는 폰에서 본다');
    const errors = await open(page, '?seed=42');
    const bad = [];
    for (const [w, h] of [[360, 548], [360, 664], [375, 548], [375, 664], [390, 548], [390, 664], [430, 548], [430, 664]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForFunction((w) => walkoff.view.w === w, w);
      const res = await page.evaluate(async () => {
        const { ZONE } = await import('./js/core/field.js');
        const wk = walkoff, g = wk.game, cv = document.querySelector('canvas'), out = [];
        wk.paused = true;
        const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: 'touch', clientX: x, clientY: y }));
        for (const bats of ['R', 'L']) {
          wk.setBats(bats);
          for (const [cx, cy] of [[ZONE.left, ZONE.top], [ZONE.right, ZONE.top], [ZONE.left, ZONE.bottom], [ZONE.right, ZONE.bottom]]) {
            wk.startGame('challenge', false, { aim: true });
            const p = g.seq[g.i];
            Object.assign(p, { tx: cx, ty: cy });   // 이 공은 존 모서리를 지난다
            const c = wk.project(cx, cy, 0), f = wk.aimGripFor(c.x, c.y);   // 그 자리를 치려면 손가락을 둘 자리
            ev('pointerdown', f.x, f.y + 40); ev('pointermove', f.x, f.y);   // 와인드업 중에 누르고 끌어 맞춘다
            while (!(g.state === 'pitch' && wk.ballTime() + 1 / 60 >= p.T)) { g.clockAt += 1000 / 60; wk.update(1 / 60); }
            wk.swing(g.clockAt + (p.T - wk.ballTime()) * 1000, 'touch', wk.aimCursor());   // 제때 뗀다(떼는 자리 = 지금 손가락)
            ev('pointercancel', f.x, f.y);
            out.push({ bats, corner: `${cx},${cy}`, f: { x: Math.round(f.x), y: Math.round(f.y) }, kind: g.outcome.kind, zone: g.outcome.aimZone });
          }
        }
        wk.setBats('R');
        return out;
      });
      for (const o of res) {
        const inside = o.f.x >= 20 && o.f.x <= w - 20 && o.f.y >= 0 && o.f.y <= h - 20;   // 손가락이 화면 가장자리에서 20px 넘게 안쪽
        if (!inside || o.kind === 'whiff' || o.zone !== 'near') bad.push({ w, h, ...o });
      }
    }
    expect(bad).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('배트 커서는 한 색 반투명 그림자다: 상점 배트(무늬·효과)와 상관없이 같은 모양이고, 맞는 자리 둘레만 조금 밝다(PC·폰)', async ({ page, isMobile }) => {
    test.skip(isMobile, '그림 계산은 화면 크기와 상관없어서 PC에서만 본다');
    const errors = await open(page, '?seed=42');
    const r = await page.evaluate(() => {
      const w = walkoff, cv = document.querySelector('canvas'), x = cv.getContext('2d'), dpr = w.view.dpr, box = [300 * dpr, 250 * dpr, 800 * dpr, 500 * dpr];
      w.paused = true;
      const shot = (bat, kind) => {   // 빈 캔버스에 커서만 그린 픽셀(맞는 자리 700, 500 둘레)
        w.wallet.look = { ...w.wallet.look, bat };
        x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height); x.setTransform(dpr, 0, 0, dpr, 0, 0);
        w.drawAimBat({ x: 700, y: 500, kind });
        return x.getImageData(...box).data;
      };
      const out = {};
      for (const kind of ['mouse', 'touch']) {
        const base = shot('bat-wood', kind);
        const same = ['bat-fire', 'bat-lightning', 'bat-ice', 'bat-beam', 'bat-diamond', 'bat-hammer', 'bat-leek', 'bat-gold'].filter((b) => { const d = shot(b, kind); return d.some((v, i) => v !== base[i]); });
        let painted = 0, spread = 0;
        for (let i = 0; i < base.length; i += 4) if (base[i + 3] > 40) { painted++; spread = Math.max(spread, Math.max(base[i], base[i + 1], base[i + 2]) - Math.min(base[i], base[i + 1], base[i + 2])); }
        const alphaAt = (p) => base[((Math.round(p.y * dpr) - box[1]) * box[2] + (Math.round(p.x * dpr) - box[0])) * 4 + 3];
        const { knob } = w.aimBatPoints({ x: 700, y: 500, kind });
        out[kind] = { differs: same, painted, spread, spot: alphaAt({ x: 700, y: 500 }), handle: alphaAt({ x: 700 + (knob.x - 700) * 0.6, y: 500 + (knob.y - 500) * 0.6 }) };
      }
      return out;
    });
    for (const kind of ['mouse', 'touch']) {
      expect(r[kind].differs, kind).toEqual([]);   // 어떤 상점 배트를 입어도 커서는 같다
      expect(r[kind].painted, kind).toBeGreaterThan(300);
      expect(r[kind].spread, kind).toBeLessThan(40);   // 한 색(희뿌연 흰색)
      expect(r[kind].handle, kind).toBeGreaterThan(60); expect(r[kind].handle, kind).toBeLessThan(160);   // 반투명
      expect(r[kind].spot, kind).toBeGreaterThan(r[kind].handle + 30); expect(r[kind].spot, kind).toBeLessThan(255);   // 맞는 자리만 조금 밝다
    }
    expect(errors).toEqual([]);
  });

  test('조준이 아닌 10구는 지금과 같다: 커서 없이 판정하고(aimZone 없음) 클릭한 자리와 상관없이 타이밍만 본다', async ({ page, isMobile }) => {
    test.skip(isMobile, '마우스는 PC에서 본다');
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await fireAt(page, 0, { type: 'pointerdown', pointerType: 'mouse', x: 5, y: 5 });   // 화면 구석을 눌러도
    await page.waitForFunction(() => walkoff.game.state === 'result');
    const o = await outcome(page);
    expect(o).toMatchObject({ zone: null, miss: false, aim: null });
    expect(o.kind).toBe('hr');   // seed 42 첫 공은 정확히 치면 홈런
    expect(errors).toEqual([]);
  });
});

test.describe('따라가는 카메라', () => {
  const atHome = (page) => page.evaluate(() => ['x', 'y', 'z'].every((k) => Math.abs(walkoff.cam[k] - walkoff.CAM_HOME[k]) < 1e-9));

  test('홈런은 카메라가 공 뒤로 날아갔다가(z 40m까지, 관중은 다시 굽지 않음) 공이 관중석에 들어가면 끊어서 타석 시점이고, 다시 보기도 타석 시점이다(seed 42 첫 두 공은 홈런)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    const builds = await page.evaluate(() => walkoff.crowd.builds);
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    expect(await page.evaluate(() => walkoff.game.outcome.kind)).toBe('hr');
    await page.waitForFunction(() => walkoff.cam.z > walkoff.CAM_HOME.z + 5, null, { timeout: 10000 });   // 공 뒤로 날아간다
    let maxZ = -Infinity;
    for (let i = 0; i < 6; i++) { maxZ = Math.max(maxZ, await page.evaluate(() => walkoff.cam.z)); await page.waitForTimeout(120); }
    expect(maxZ).toBeLessThanOrEqual(40.01);                                     // 관중석에 붙지 않게 z 40m까지
    expect(await page.evaluate(() => walkoff.crowd.builds)).toBe(builds);        // 날아가는 동안 관중을 다시 굽지 않는다
    await page.waitForFunction(() => walkoff.game.flightT > walkoff.chaseEnd(walkoff.game.outcome) + 0.05);
    expect(await atHome(page)).toBe(true);                                        // 공이 관중석에 들어가면 돌아오는 장면 없이 끊는다
    await page.waitForFunction(() => walkoff.game.resultT > walkoff.game.revealAt + 0.1);
    await page.keyboard.press('Space');                                           // 다음 공
    await expect.poll(() => atHome(page)).toBe(true);
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.cam.z > walkoff.CAM_HOME.z + 5, null, { timeout: 10000 });
    await page.keyboard.press('KeyR');                                            // 다시 보기
    await expect.poll(() => atHome(page)).toBe(true);
    for (let i = 0; i < 5; i++) { await page.waitForTimeout(100); expect(await atHome(page)).toBe(true); }   // 다시 보기 동안은 따라가지 않는다
    expect(errors).toEqual([]);
  });

  test('따라가는 카메라 다듬기: 공이 떨어질 때까지 멈추지 않고(마지막 자리 z 40m 그대로), 앞으로 가기 전에 위로만 솟지 않으며, 타석 시점에서 화면을 좌우로 미는 빠르기에 상한이 있다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    const rows = await page.evaluate(() => {
      const w = walkoff, g = w.game; w.paused = true;   // 장면을 1/60초씩 직접 넘긴다
      const atHome = () => ['x', 'y', 'z'].every((a) => w.cam[a] === w.CAM_HOME[a]);
      const run = (p, dt) => {
        w.startGame('challenge'); g.seq[0] = p;
        for (let k = 0; k < 3000 && g.state !== 'result'; k++) {
          if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000);
          g.clockAt += 1000 / 60; w.update(1 / 60);
        }
        const land = w.chaseEnd(g.outcome) - w.CHASE.hold, tr = [];
        for (let k = 0; k < 60 * 9 && g.state === 'result'; k++) {
          const px = w.view.panX, home = atHome();
          g.clockAt += 1000 / 60; w.update(1 / 60);
          tr.push({ t: g.flightT, y: w.cam.y - w.CAM_HOME.y, z: w.cam.z, dpx: Math.abs(w.view.panX - px), home: home && atHome() });   // home: 앞뒤 장면 모두 타석 시점(끊는 장면은 빼고)
        }
        const chase = tr.filter((q) => q.t > w.CHASE.start + 0.5 && q.t <= land);
        const still = chase.filter((a) => { const b = chase.find((q) => q.t >= a.t + 1); return b && b.z - a.z < 1; }).length;   // 1초 사이 z가 1m도 안 움직인 장면
        const go = tr.find((q) => q.z > w.CAM_HOME.z + 0.3);
        return { name: g.outcome.name, maxZ: Math.max(...tr.map((q) => q.z)), zLand: chase.at(-1).z, still, riseAtGo: go.y, maxPan: Math.max(...tr.filter((q) => q.home).map((q) => q.dpx)) * 60, f: w.view.f };
      };
      return [run(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0), run(w.makeSequence(1, w.pitcherHand(1) === 'L')[1], 25), run(w.makeSequence(1, false)[0], -44)];
    });
    expect(rows.map((q) => q.name)).toEqual(['중월 홈런', '우중간 2루타', '좌익수 뜬공']);
    for (const q of rows) {
      expect(q.maxZ, q.name).toBeLessThanOrEqual(40.01);         // 마지막 자리는 그대로(관중석에 붙지 않게)
      expect(q.zLand, q.name).toBeGreaterThan(30);               // 공이 떨어질 때쯤 마지막 자리 가까이
      expect(q.still, q.name).toBe(0);                           // 전에는 2초쯤 z 40m에 닿아 1.2~2.8초 서 있었다
      expect(q.riseAtGo, q.name).toBeLessThan(2);                // 앞으로 가기 시작할 때 아직 2m 안(전에는 2.6~4.9m를 먼저 솟았다)
      expect(q.maxPan, q.name).toBeLessThanOrEqual(q.f * 1.01);  // 초당 시야 f까지(전에는 홈런 뒤 폰에서 f의 2.8배)
    }
    expect(errors).toEqual([]);
  });

  test('친 공도 돈다: 뜬공은 백스핀(보이는 면이 아래로), 땅볼은 앞회전(위로)', async ({ page }) => {
    const errors = await open(page);
    const r = await page.evaluate(() => {
      const seq = walkoff.makeSequence(42, false), fly = walkoff.judgeSwing(seq[0], 0, 'R'), ground = walkoff.makeSequence(1, false)[2];
      const g = walkoff.judgeSwing(ground, -80, 'R');
      const dy = (r) => {   // 카메라 쪽(z > 0.5) 실밥 점들이 0.01초 동안 움직인 평균(위가 +)
        const a = walkoff.seamPoints(walkoff.battedSpin(r, 1)), b = walkoff.seamPoints(walkoff.battedSpin(r, 1.01));
        let sum = 0, n = 0; a.forEach((p, i) => { if (p[2] > 0.5) { sum += b[i][1] - p[1]; n++; } });
        return sum / n;
      };
      return { kinds: [fly.kind, g.type], fly: dy(fly), ground: dy(g) };
    });
    expect(r.kinds).toEqual(['hr', 'ground']);
    expect(r.fly).toBeLessThan(-0.05);     // 멀어지는 공의 뒷면이 아래로(윗면이 홈 쪽으로 도는 백스핀)
    expect(r.ground).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
  });

  test('땅볼은 카메라가 타석 시점 그대로다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await page.evaluate(() => {   // 땅볼 아웃 결과로 바꿔 놓고 게임이 그대로 흘러가게 둔다
      const seq = walkoff.makeSequence(1, false), g = walkoff.game, r = walkoff.judgeSwing(seq[2], -80, 'R');
      g.seq[g.i] = seq[2];
      Object.assign(g, { state: 'result', outcome: r, swingAt: seq[2].T - 0.08, flightT: 0, resultT: 0, revealAt: walkoff.fieldPlay(r).revealReal, replay: null, replayed: false });
    });
    expect(await page.evaluate(() => walkoff.game.outcome.type)).toBe('ground');
    for (let i = 0; i < 10; i++) { await page.waitForTimeout(150); expect(await atHome(page)).toBe(true); }
    expect(errors).toEqual([]);
  });
});

test.describe('고가 공 꼬리·타격음', () => {
  test('혜성·용 꼬리는 홈런을 뒤에서 따라가는 화면에서도 공 뒤로 길게 남는다(지난 0.26초 점 꼬리는 공 둘레 몇 px에 몰렸다)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    await pressAt(page, 0);   // seed 42 첫 공은 홈런
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.flightT > 1.2 && walkoff.cam.z > walkoff.CAM_HOME.z + 5, null, { timeout: 10_000 });
    // 멈춘 장면 하나를 꼬리마다 다시 그려(시계·난수도 멈춤) 꼬리 없이 그린 것과 달라진 픽셀 가운데 공에서 가장 먼 거리(화면 높이 비율)
    const reach = await page.evaluate(() => {
      walkoff.paused = true;
      const now = performance.now(), { now: realNow } = performance, realRandom = Math.random;
      performance.now = () => now; Math.random = () => 0.5;
      const g = walkoff.game, c = document.querySelector('canvas'), x2d = c.getContext('2d'), d = c.width / walkoff.view.w;
      const fp = walkoff.fieldPlay(g.outcome).ball(g.flightT), b = walkoff.project(fp.x, fp.y, fp.z);
      const shot = (trail) => { walkoff.wallet.look.trail = trail; walkoff.render(now / 1000); return x2d.getImageData(0, 0, c.width, c.height).data; };
      const base = shot('trail-none'), out = {};
      for (const trail of ['trail-comet', 'trail-dragon']) {
        const img = shot(trail);
        let far = 0;
        for (let i = 0; i < img.length; i += 12) {
          if (Math.abs(img[i] - base[i]) + Math.abs(img[i + 1] - base[i + 1]) + Math.abs(img[i + 2] - base[i + 2]) < 40) continue;
          const p = i / 4; far = Math.max(far, Math.hypot((p % c.width) / d - b.x, Math.floor(p / c.width) / d - b.y));
        }
        out[trail] = far / walkoff.view.h;
      }
      performance.now = realNow; Math.random = realRandom; walkoff.paused = false;
      return out;
    });
    expect(reach['trail-comet']).toBeGreaterThan(0.12);
    expect(reach['trail-dragon']).toBeGreaterThan(0.12);
    await page.waitForFunction(() => walkoff.game.flightT > walkoff.chaseEnd(walkoff.game.outcome) + 0.05);   // 끝까지 오류 없이
    await page.evaluate(() => walkoff.openShop('shop'));   // 상점 미리 보기(공이 꼬리를 달고 날아간다)도
    await tap(page, '공 꼬리');
    for (const name of ['혜성', '용']) { await tap(page, name); await page.waitForTimeout(700); }
    expect(errors).toEqual([]);
  });

  test('천둥·8비트 타격음은 폭탄보다 크지 않고, 천둥은 1초 넘게 우르릉 이어지며 8비트는 짧게 끝난다', async ({ page }) => {
    await page.addInitScript(() => {   // 게임 소리를 그대로 미리 녹음한다(2.4초)
      window.AudioContext = function () { window.__ac = new OfflineAudioContext(1, 44100 * 2.4, 44100); return window.__ac; };
    });
    const errors = await open(page);
    const record = async (style) => {   // 50ms 창 크기(RMS)의 최댓값과, 최댓값의 3% 넘게 들리는 마지막 시각
      await page.reload();
      await page.waitForFunction(() => !!window.walkoff);
      return page.evaluate(async (style) => {
        walkoff.Sound.init(); walkoff.Sound.crack(0.8, style);
        const d = (await window.__ac.startRendering()).getChannelData(0), win = 2205;
        const rms = (i) => { let s = 0; for (let k = i; k < i + win; k++) s += d[k] * d[k]; return Math.sqrt(s / win); };
        let max = 0, last = 0;
        for (let i = 0; i + win <= d.length; i += 441) max = Math.max(max, rms(i));
        for (let i = 0; i + win <= d.length; i += 441) if (rms(i) > max * 0.03) last = (i + win) / 44100;
        return { max, last };
      }, style);
    };
    const bomb = await record('sound-bomb'), thunder = await record('sound-thunder'), chip = await record('sound-8bit');
    expect(thunder.max).toBeLessThanOrEqual(bomb.max);
    expect(chip.max).toBeLessThanOrEqual(bomb.max);
    expect(Math.min(thunder.max, chip.max)).toBeGreaterThan(0.03);   // 들리기는 한다
    expect(thunder.last).toBeGreaterThan(1.0);   // 콰광 뒤 우르릉
    expect(chip.last).toBeLessThan(0.4);         // 띠링
    expect(errors).toEqual([]);
  });
});

test.describe('맞는 순간 효과', () => {
  test('효과 배트로 맞히면(파울 포함) 맞은 자리에서 효과가 터지고, 효과 없는 배트와 헛스윙은 없다(2026-11-03 사용자 전달 요청 "불 방망이면 불, 얼음 방망이면 얼음")', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    const hit = async (bat, dt) => {
      await page.evaluate((bat) => { walkoff.setWallet({ look: { ...walkoff.wallet.look, bat } }); walkoff.goTitle(); walkoff.startGame('challenge'); }, bat);
      await page.waitForFunction(() => walkoff.game.state === 'pitch');
      await pressAt(page, dt);
      await page.waitForFunction(() => walkoff.game.state === 'result');
      return page.evaluate(() => ({ kind: walkoff.game.outcome.kind, burst: walkoff.game.burst?.fx ?? null }));
    };
    expect(await hit('bat-fire', 0)).toEqual({ kind: 'hr', burst: 'fire' });     // seed 42 첫 공은 제때 치면 홈런
    expect(await hit('bat-ice', 115)).toEqual({ kind: 'foul', burst: 'ice' });   // 파울도 맞힌 공이라 터진다
    expect(await hit('bat-wood', 0)).toEqual({ kind: 'hr', burst: null });       // 효과 없는 배트
    expect(await hit('bat-beam', -200)).toEqual({ kind: 'whiff', burst: null }); // 헛스윙
    expect(errors).toEqual([]);
  });
});

test.describe('가운데 큰 전광판', () => {
  test('투구 중에는 움직이지 않고(공이 올 때 깜빡이면 타이밍을 방해한다) 위쪽 점수 패널 아래에 있고, 홈런 결과가 뜨면 HOMERUN이 나온다(seed 42 첫 공은 홈런)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'pitch');
    const snap = () => page.evaluate(() => {   // 전광판 자리 픽셀의 해시
      const R = walkoff.scoreboardRect(), c = document.querySelector('canvas'), d = c.width / walkoff.view.w;
      const img = c.getContext('2d').getImageData(Math.round(R.x * d), Math.round(R.y * d), Math.round(R.w * d), Math.round(R.h * d)).data;
      let h = 0; for (let i = 0; i < img.length; i += 8) h = (h * 31 + img[i]) >>> 0;
      return { h, top: R.y, w: R.w };
    });
    const a = await snap(); await page.waitForTimeout(150); const b = await snap();
    expect(a.h).toBe(b.h);                    // 투구 중 그대로
    expect(a.top).toBeGreaterThan(50);        // 위쪽 점수 패널(폰 60px·PC 74px까지)과 거의 안 겹친다
    expect(a.w).toBeGreaterThan(100);
    await pressAt(page, 0);
    await page.waitForFunction(() => walkoff.game.state === 'result');
    // 홈런은 따라가는 카메라가 타석 시점으로 돌아온 뒤 전광판이 HOMERUN을 한 글자씩 띄우고, 같은 순간 결과 제목('홈런!')이 위쪽 빈자리에 뜬다.
    // 자세한 카드(타구 줄 등)는 전광판 자리를 가려서 HOMERUN이 끝난 뒤에 나온다(2026-11-03 '한 박자로 모으기'. 전에는 제목까지 끝난 뒤에 나왔다)
    await page.waitForFunction(() => { const bm = walkoff.boardMoment(); return bm && walkoff.game.resultT > bm.t0 + 0.5 && walkoff.game.resultT < bm.t1 - 0.2; }, null, { timeout: 12_000 });
    const texts = await drawnTexts(page);
    expect(['H', 'O', 'M', 'E', 'R', 'U', 'N'].every((ch) => texts.includes(ch))).toBe(true);
    expect(texts).toContain('홈런!');
    expect(texts.some((t) => /^타구 \d+km\/h/.test(t))).toBe(false);
    await expect.poll(async () => (await drawnTexts(page)).some((t) => /^타구 \d+km\/h/.test(t)), { timeout: 8_000 }).toBe(true);   // 그 뒤 자세한 카드
    expect(errors).toEqual([]);
  });

  test('투구 중에는 상대 투수를 보여 준다: 첫 공은 팀·선발·등번호·좌완/우완과 이번 판의 직구 최고 구속·주무기, 그 뒤는 큰 등번호·주무기·직전 공', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    expect(await boardWords(page)).toEqual(['WALK', 'OFF']);   // 시작 화면은 그대로(og.png)
    await page.evaluate(() => walkoff.startGame('challenge'));
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    const c = await page.evaluate(() => walkoff.pitcherCard());
    // seed 42(내 팀 LG): 한화 우완, 앞 16구의 직구 최고 151km/h, 변화구는 슬라이더 3·포크 3·커브 1이라 먼저 나온 슬라이더
    expect(c).toMatchObject({ team: { short: '한화' }, hand: '우완', thrown: 0, last: null, profile: { top: 151, main: '슬라이더' } });
    expect(await boardWords(page)).toEqual([`한화 선발 ${c.no} · 우완`, '직구 최고 151', '주무기 슬라이더']);
    await playPitch(page, null);   // 첫 공을 보내면 다음 공부터 직전 공이 나온다
    await page.waitForFunction(() => walkoff.game.state === 'windup' && walkoff.game.i === 1);
    const first = await page.evaluate(() => walkoff.game.seq[0]);
    expect(await boardWords(page)).toEqual(['한화 선발 · 우완', 'No.', String(c.no), '주무기 슬라이더', `직전 직구 ${first.kmh}`]);
    expect(await page.evaluate(() => walkoff.pitcherCard().no)).toBe(c.no);   // 등번호는 판 내내 같다
    expect(errors).toEqual([]);
  });

  test('폰 360폭에서도 투수판 글자는 10px 이상이고 판 밖으로 넘치지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('challenge'));
    for (const i of [0, 1]) {
      await page.waitForFunction((i) => walkoff.game.state === 'windup' && walkoff.game.i === i, i);
      const R = await page.evaluate(() => walkoff.scoreboardRect()), glyphs = await boardGlyphs(page);
      expect(glyphs.length).toBeGreaterThan(2);
      for (const g of glyphs) {
        expect(g.size, g.s).toBeGreaterThanOrEqual(10);
        expect(g.left, g.s).toBeGreaterThanOrEqual(0);
        expect(g.right, g.s).toBeLessThanOrEqual(R.w);
      }
      if (i === 0) await playPitch(page, null);
    }
    expect(errors).toEqual([]);
  });

  test('끝내기 상황은 마무리 투수(첫 공은 9회말 등판), 연습은 직전 공 구속만 보여 준다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(() => walkoff.startGame('scenario'));
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    const no = await page.evaluate(() => walkoff.pitcherCard().no);
    expect(await boardWords(page)).toEqual([`한화 마무리 ${no} · 우완`, '9회말 등판']);
    await page.evaluate(() => { walkoff.goTitle(); walkoff.startGame('practice'); });
    await page.waitForFunction(() => walkoff.game.state === 'windup');
    expect(await boardWords(page)).toEqual(['연습 · 우완', '구속이 여기 떠요']);
    await playPitch(page, null);
    await page.waitForFunction(() => walkoff.game.state === 'windup' && walkoff.game.i === 1);
    expect(await boardWords(page)).toEqual(['연습 · 우완', 'km/h', '직전 직구']);
    expect(errors).toEqual([]);
  });

  test('HIT·HOMERUN이 뜨는 동안은 폰에서도 전광판이 화면 안에 있고(카메라가 공 뒤로 날아갔으면 돌아온 뒤에 뜬다), 끝나면 화면이 주자를 따라간다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    const [hr, dbl, single] = await page.evaluate(() => {
      const w = walkoff, g = w.game;
      w.paused = true;   // 장면을 1/60초씩 직접 넘긴다(느린 기계에서도 같은 결과)
      const play = (p, dt) => {
        w.startGame('challenge'); g.seq[0] = p;
        for (let k = 0; k < 3000 && g.state !== 'result'; k++) {
          if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000);
          g.clockAt += 1000 / 60; w.update(1 / 60);
        }
        let min = 1, home = null, pan = null;
        for (let k = 0; k < 900; k++) {
          w.update(1 / 60);
          const bm = w.boardMoment();
          if (!bm) continue;
          if (g.resultT >= bm.t0 && g.resultT < bm.t1) {
            const R = w.scoreboardRect();
            min = Math.min(min, Math.max(0, Math.min(w.view.w, R.x + R.w) - Math.max(0, R.x)) / R.w);
            home ??= ['x', 'y', 'z'].every((a) => w.cam[a] === w.CAM_HOME[a]);
            pan = w.view.panX;
          }
          if (g.resultT >= bm.t1 + 1) return { name: g.outcome.name, min, home, beat: bm.t0 - g.revealAt, late: w.chaseable(g.outcome) ? bm.t0 - w.chaseEnd(g.outcome) : null, follow: Math.abs(w.view.panX - pan) };
        }
        return null;
      };
      const seq = w.makeSequence(42, w.pitcherHand(42) === 'L');
      // 홈런, 큰 뜬공 2루타(seed 1 둘째 공을 25ms 늦게, 114m, 카메라가 공 뒤로 날아간다), 폰에서 가장 많이 밀리는 좌익수 쪽 안타(seed 332 셋째 공을 40ms 빨리).
      // 2루타는 처음에 seed 42 첫 공 +25ms였다가 2026-11-03 홈런 방향을 넓혀 우월 홈런이 됐고, 다음 seed 19 여섯째 공 +25ms는 2026-11-04 판정을 실제처럼 바꿔 우익수 뜬공이 됐다
      return [play(seq[0], 0), play(w.makeSequence(1, w.pitcherHand(1) === 'L')[1], 25), play(w.makeSequence(332, false)[2], -40)];
    });
    expect([hr.name, dbl.name, single.name]).toEqual(['중월 홈런', '우중간 2루타', '좌전 안타']);
    for (const r of [hr, dbl, single]) expect(r.min, r.name).toBeGreaterThan(0.9);   // 붙잡기 전에는 폰에서 홈런 끝에 0%, 큰 뜬공 2루타는 30%쯤
    expect([hr.home, dbl.home]).toEqual([true, true]);   // 따라가는 카메라가 타석 시점으로 돌아온 뒤에 글자가 뜬다
    expect(dbl.late).toBeGreaterThanOrEqual(0);           // 공이 떨어지고 카메라가 끊긴 뒤
    expect([hr.beat, dbl.beat, single.beat]).toEqual([0, 0, 0]);   // 결과 카드·위 점수와 같은 순간(2026-11-05. 전에는 큰 뜬공 2루타의 카드가 2.6초에 먼저 나왔다)
    expect(hr.follow).toBeGreaterThan(20);   // 글자가 끝나면 화면이 다시 주자를 따라간다
    expect(errors).toEqual([]);
  });

  test('폰: 1루 간발이면 공을 잡는 순간부터 1루 쪽을 봐서, 머리부터 슬라이딩과 세이프·아웃이 뜨는 동안 1루가 화면 안이다(내야 안타도 HIT 전광판 쪽으로 끌려가지 않는다)', async ({ page, isMobile }) => {
    test.skip(!isMobile, '시야가 좁은 폰에서 본다(PC는 1루와 전광판이 원래 함께 보인다)');
    const errors = await open(page, '?seed=1');
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game;
      w.paused = true;
      const play = (p, dt) => {
        w.startGame('challenge'); g.seq[0] = p;
        for (let k = 0; k < 3000 && g.state !== 'result'; k++) {
          if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000);
          g.clockAt += 1000 / 60; w.update(1 / 60);
        }
        const o = g.outcome, d = Math.max(o.race.runner, o.race.arrive.t);
        let lo = 9, hi = -9;
        for (let k = 0; k < 900 && g.state === 'result' && g.flightT < d + 0.5; k++) {   // 머리부터 날기 시작할 때(판정 0.5초 앞)부터 세이프·아웃이 뜬 뒤 0.5초까지
          w.update(1 / 60);
          if (g.flightT >= d - 0.5) { const b = w.project(w.BASE1[0], 0, w.BASE1[1]); lo = Math.min(lo, b.x / w.view.w); hi = Math.max(hi, b.x / w.view.w); }
        }
        return { kind: o.kind, pos: o.race.pos, lo, hi };
      };
      const seq = w.makeSequence(1, false);
      return { safe: play(seq[3], -90), out: play(seq[5], -78) };   // 3루수 내야 안타(간발 세이프), 유격수 땅볼(간발 아웃)
    });
    expect([r.safe.kind, r.out.kind]).toEqual(['single', 'out']);
    for (const [k, v] of Object.entries(r)) { expect(v.lo, k).toBeGreaterThan(0.1); expect(v.hi, k).toBeLessThan(0.95); }   // 전에는 내야 안타 판정 때 1루가 화면 폭의 1.85배 자리(화면 밖)였다
    expect(errors).toEqual([]);
  });
});

test.describe('결과 한 박자·건너뛰기', () => {
  // 장면을 1/60초씩 직접 넘기며(느린 기계에서도 같은 결과) 공 하나를 친다. 그림에 쓴 글자는 그 장면 하나를 그리는 동안 모은다(글자·크기 px·세로 자리)
  const SETUP = () => {
    const w = walkoff, g = w.game; w.paused = true;
    window.__hit = (p, dt) => { w.startGame('challenge'); g.seq[0] = p; for (let k = 0; k < 3000 && g.state !== 'result'; k++) { if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000); g.clockAt += 1000 / 60; w.update(1 / 60); } };
    window.__step = (n = 1) => { for (let k = 0; k < n; k++) { g.clockAt += 1000 / 60; w.update(1 / 60); } };
    window.__draw = () => {
      const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, out = [];
      proto.fillText = function (s, x, y, ...rest) { const m = this.getTransform(); out.push({ s: String(s), size: Math.round(Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) * 10) / 10, y: Math.round((m.d * y + m.f) / w.view.dpr) }); return fill.call(this, s, x, y, ...rest); };
      try { w.render(g.resultT); } finally { proto.fillText = fill; }
      return out;
    };
  };

  test('보통 안타는 함성·HIT·결과 제목이 한 순간에 나오고, 자세한 카드는 HIT이 끝난 뒤 제목 아래로 나오며 제목은 그 자리 그대로다. 홈런은 함성이 먼저다(두 박자)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game;
      __hit(w.makeSequence(332, false)[2], -40);   // 좌전 안타(따라가는 카메라가 없는 보통 안타)
      let cheerAt = null, titleAt = null, before = null, detailsBefore = false, after = null;
      for (let k = 0; k < 600 && !after; k++) {
        __step();
        const bm = w.boardMoment(), texts = __draw(), title = texts.find((q) => q.s === g.outcome.name);
        if (g.cheered && cheerAt == null) cheerAt = g.resultT;
        if (title && titleAt == null) titleAt = g.resultT;
        if (bm && g.resultT < bm.t1 - 0.05 && title) { before = title; detailsBefore ||= texts.some((q) => /^타구 \d+km\/h/.test(q.s)); }
        if (bm && g.resultT > bm.t1 + 0.4) after = { title: texts.find((q) => q.s === g.outcome.name), details: texts.some((q) => /^타구 \d+km\/h/.test(q.s)) };
      }
      const bm = w.boardMoment(), name = g.outcome.name;
      __hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);   // 중월 홈런(공 뒤로 날아가는 카메라)
      let hrCheer = null;
      for (let k = 0; k < 900 && hrCheer == null; k++) { __step(); if (g.cheered) hrCheer = g.resultT; }
      return { name, t0: bm.t0, t1: bm.t1, cheerAt, titleAt, before, detailsBefore, after, hrCheer, hrT0: w.boardMoment().t0, hrLand: w.chaseEnd(g.outcome) - w.CHASE.hold };
    });
    expect(r.name).toBe('좌전 안타');
    expect(Math.abs(r.cheerAt - r.t0)).toBeLessThan(0.05);   // 함성과 HIT이 같은 순간에
    expect(Math.abs(r.titleAt - r.t0)).toBeLessThan(0.05);   // 결과 제목도(전에는 HIT이 끝난 1.2초 뒤에 카드와 함께)
    expect(r.detailsBefore).toBe(false);                      // 자세한 카드는 HIT 동안 없고
    expect(r.after.details).toBe(true);                       // 끝난 뒤에 나오며
    expect(r.after.title).toEqual(r.before);                  // 제목은 자리·크기 그대로(다시 튀어나오지 않는다)
    expect(r.hrT0 - r.hrCheer).toBeGreaterThan(0.3);          // 홈런: 공이 관중석에 들어갈 때 함성, 카메라가 돌아오면 HOMERUN과 제목
    expect(Math.abs(r.hrCheer - r.hrLand)).toBeLessThan(0.05);  // (2026-11-05 전에는 2.6초 상한에 걸려 공이 가장 높이 떴을 때 함성이 났다)
    expect(errors).toEqual([]);
  });

  test('결과 제목은 위 점수판 패널과 가운데 전광판 사이 빈자리에 들어간다(360·390·1440·1920 폭, 아이폰 사파리 390×664)', async ({ page, isMobile }) => {
    test.skip(isMobile, '창 크기를 바꿔 가며 보므로 PC에서만 본다');
    const errors = await open(page, '?seed=42');
    for (const [w, h] of [[360, 640], [360, 780], [390, 664], [390, 844], [1440, 900], [1920, 1080]]) {   // 390×664는 아이폰 사파리(주소창 포함)
      await page.setViewportSize({ width: w, height: h });
      await page.waitForFunction((w) => walkoff.view.w === w, w);
      const b = await page.evaluate(() => { const T = walkoff.resultTitleBox({ kind: 'hr' }), R = walkoff.scoreboardRect(); return { top: T.top, y: T.y, size: T.size, boardTop: R.y }; });
      expect(b.y - b.size / 2, `${w}×${h}`).toBeGreaterThanOrEqual(b.top - 1);
      expect(b.y + b.size / 2, `${w}×${h}`).toBeLessThanOrEqual(b.boardTop + 1);
      expect(b.size, `${w}×${h}`).toBeGreaterThanOrEqual(22);   // 처음엔 빈자리의 0.72배라 아이폰 사파리에서 18px이었다
    }
    expect(errors).toEqual([]);
  });

  test('공이 날아가는 동안 누르면 결과가 나오는 순간으로 건너뛴다: 맞은 뒤 0.4초 전 탭은 무시하고, 건너뛰게 한 탭은 다음 공으로 가지 않고, 홈런이면 카메라를 타석 시점으로 끊고 점수는 그대로다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game;
      __hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);   // 중월 홈런
      __step(12); w.tap(g.clockAt);
      const early = { skipped: g.skipAt != null, resultT: g.resultT };
      while (g.resultT < 0.5) __step();
      const before = { reveal: g.revealAt, i: g.i, score: g.score, name: g.outcome.name, chasing: w.cam.z > w.CAM_HOME.z + 0.3 };
      w.tap(g.clockAt);
      const after = { resultT: g.resultT, state: g.state, i: g.i, score: g.score, name: g.outcome.name };
      __step();
      const next = { home: ['x', 'y', 'z'].every((a) => w.cam[a] === w.CAM_HOME[a]), cheered: g.cheered, word: w.boardMoment()?.word, t0: w.boardMoment()?.t0 };
      w.tap(g.clockAt);
      return { early, before, after, next, last: { state: g.state, i: g.i } };
    });
    expect(r.early.skipped).toBe(false);   // 치면서 두 번 누른 탭은 무시
    expect(r.before.chasing).toBe(true);   // 카메라가 공 뒤로 날아가는 중에
    expect(r.after.resultT).toBeGreaterThanOrEqual(r.before.reveal);   // 누르면 결과가 정해지는 순간으로
    expect(r.after).toMatchObject({ state: 'result', i: r.before.i, score: r.before.score, name: r.before.name });   // 결과·점수 그대로, 다음 공으로 안 간다
    expect(r.next).toMatchObject({ home: true, cheered: true, word: 'HOMERUN' });   // 타석 시점으로 끊고 그 순간 함성·HOMERUN
    expect(r.next.t0).toBeCloseTo(r.after.resultT, 3);
    expect(r.last).toEqual({ state: 'windup', i: r.before.i + 1 });   // 다음 탭에 다음 공
    expect(errors).toEqual([]);
  });

  test('카메라가 공 뒤로 날아가는 타구는 공이 떨어지고 돌아올 때 결과를 한 번에 알린다: 날아가는 동안 아래 카드·버튼·위 점수와 불·제목이 없고, 안타 함성은 공이 떨어질 때, 2.6초가 지나도 누르면 다음 공이 아니라 결과부터 나온다(보통 안타는 그대로)', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game, atHome = () => ['x', 'y', 'z'].every((a) => w.cam[a] === w.CAM_HOME[a]);
      // 날아가는 동안(맞고 0.5초 ~ 끊기 직전)과 끊긴 바로 뒤를 그려 본다
      const watch = (p, dt) => {
        __hit(p, dt);
        const r = g.outcome, end = w.chaseEnd(r), score0 = w.boardView().score, title = r.kind === 'hr' ? '홈런!' : r.name, during = { cards: false, title: false, board: false };
        let cheerAt = null;
        while (g.resultT < end - 0.02) {
          __step();
          if (g.cheered && cheerAt == null) cheerAt = g.flightT;
          if (g.resultT < 0.5) continue;
          const texts = __draw(), v = w.boardView();
          during.cards ||= w.ui.buttons.some((b) => /다음 공|다시 보기/.test(b.label));
          during.title ||= texts.some((q) => q.s === title);
          during.board ||= v.score !== score0 || v.lamps[g.i] != null;
        }
        while (g.resultT <= g.revealAt) __step();
        const texts = __draw(), v = w.boardView();
        const after = { home: atHome(), cards: w.ui.buttons.some((b) => /다음 공/.test(b.label)), title: texts.some((q) => q.s === title), board: v.score === g.score && v.lamps[g.i] != null };
        return { name: r.name, reveal: g.revealAt, end, land: end - w.CHASE.hold, cheerAt, during, after, word: w.boardMoment()?.word ?? null };
      };
      const hr = watch(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);   // 중월 홈런
      const fly = watch(w.makeSequence(1, false)[0], -44);                      // 95m 좌익수 뜬공(따라가는 아웃)
      __hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);               // 2.6초가 지나 누르면
      while (g.resultT < 3) __step();
      const i0 = g.i;
      w.tap(g.clockAt); __step();
      const tap1 = { state: g.state, i: g.i, home: atHome(), word: w.boardMoment()?.word ?? null };
      w.tap(g.clockAt);
      const tap2 = { state: g.state, i: g.i };
      __hit(w.makeSequence(332, false)[2], -40);                                // 따라가지 않는 보통 안타
      const single = { name: g.outcome.name, chase: w.chaseable(g.outcome), reveal: g.revealAt, play: w.fieldPlay(g.outcome).revealReal };
      return { hr, fly, i0, tap1, tap2, single };
    });
    expect([r.hr.name, r.fly.name]).toEqual(['중월 홈런', '좌익수 뜬공']);
    for (const s of [r.hr, r.fly]) {
      expect(s.during, s.name).toEqual({ cards: false, title: false, board: false });   // 날아가는 동안은 결과가 미리 안 보인다
      expect(s.reveal, s.name).toBeCloseTo(s.end, 3);                                   // 카메라가 돌아올 때
      expect(s.after, s.name).toEqual({ home: true, cards: true, title: true, board: true });   // 한 번에
    }
    expect(r.hr.reveal).toBeGreaterThan(2.6 + 1);   // 2.6초 상한을 넘어 기다린다
    expect(r.hr.word).toBe('HOMERUN');
    expect(Math.abs(r.hr.cheerAt - r.hr.land)).toBeLessThan(0.05);   // 홈런 함성은 공이 관중석에 들어갈 때(전에는 2.6초)
    expect(r.fly.cheerAt).toBeNull();                                // 아웃은 날아가는 동안 함성이 없다
    expect(r.tap1).toEqual({ state: 'result', i: r.i0, home: true, word: 'HOMERUN' });   // 2.6초가 지나도 따라가는 중이면 결과부터(전에는 다음 공으로 갔다)
    expect(r.tap2).toEqual({ state: 'windup', i: r.i0 + 1 });                          // 다음 탭에 다음 공
    expect(r.single).toMatchObject({ name: '좌전 안타', chase: false });
    expect(r.single.reveal).toBe(r.single.play);    // 보통 안타는 그대로 수비가 정하는 때
    expect(r.single.reveal).toBeLessThanOrEqual(2.6);
    expect(errors).toEqual([]);
  });

  test("이 기기에서 처음 세 판만 공이 날아가는 동안 '탭하면 바로 결과'를 작게 띄운다", async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game, hint = w.view.mobile ? '탭하면 바로 결과' : '스페이스바 · 클릭하면 바로 결과', shown = [];
      for (let n = 0; n < 4; n++) {
        __hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);
        while (g.resultT < 0.6) __step();
        shown.push(__draw().some((q) => q.s === hint));
      }
      while (g.resultT < g.revealAt + 0.1) __step();
      return { shown, gone: !__draw().some((q) => q.s.includes('바로 결과')), count: Number(localStorage.getItem('walkoff.skipHint')) };
    });
    expect(r.shown).toEqual([true, true, true, false]);
    expect(r.gone).toBe(true);   // 결과가 나오면 사라진다
    expect(r.count).toBe(3);
    expect(errors).toEqual([]);
  });

  test('홈런 뒤 주자를 따라 화면이 멀리 밀린 채 다음 공을 누르면 화면이 거의 제자리에 온 뒤 와인드업을 시작하고, 화면이 제자리면 지금처럼 0.5초 뒤다(2026-11-10 패들렛 의견 "카메라가 다 가기 전에 이미 던지고 있어요")', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game, v = w.view;
      const windup = () => { let k = 0; while (g.state === 'windup' && g.t <= 0 && k < 600) { __step(); k++; } return { sec: Math.round(k / 60 * 100) / 100, pan: Math.abs(v.panX) / v.w, held: g.held }; };   // 누른 뒤 와인드업 시작까지(초)
      __hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], 0);   // 중월 홈런
      while (g.resultT < 19) __step();   // 홈을 밟고 더그아웃 쪽으로 가는 주자를 따라 화면이 밀려 있다
      const far = Math.abs(v.panX) / v.w;
      w.tap(g.clockAt);
      const state = g.state, hr = windup();
      while (g.state !== 'result') { if (g.state === 'pitch' && g.swingAt == null && w.ballTime() > 0.2) w.swing(g.clockAt, 'key'); __step(); }   // 헛스윙이든 무엇이든 결과까지
      while (g.resultT < 6 || Math.abs(v.panX) > 0.001) __step();
      w.tap(g.clockAt);
      return { far, state, hr, home: windup() };
    });
    expect(r.far).toBeGreaterThan(0.15);
    expect(r.state).toBe('windup');
    expect(r.hr.pan).toBeLessThan(0.02);        // 와인드업을 시작할 때 화면이 제자리(화면 폭 2% 안)
    expect(r.hr.sec).toBeGreaterThan(0.5);      // 그만큼 기다렸다
    expect(r.hr.held).toBeLessThanOrEqual(3);   // 많아야 3초
    expect(r.home.held).toBe(0); expect(r.home.pan).toBeLessThan(1e-6); expect(r.home.sec).toBeLessThanOrEqual(0.52);   // 화면이 제자리면 지금과 같다(0.5초, 1/60초 쌓기 오차 한 장면)
    expect(errors).toEqual([]);
  });

  test('자세한 카드(칩·타이밍 막대·타구·이유) 뒤에는 반투명 어두운 판을 깔아 뒤의 전광판 글자와 겹쳐 보이지 않는다(2026-11-10 패들렛 의견 "정타 게이지랑 메시지가 겹쳐요")', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    await page.evaluate(SETUP);
    const reason = await page.evaluate(() => {
      const w = walkoff, g = w.game;
      __hit(w.makeSequence(332, false)[2], -40);   // 좌전 안타(카메라가 안 따라가서 자세한 줄이 전광판 위에 나온다)
      while (!w.boardMoment() || g.resultT < w.boardMoment().t1 + 0.4) __step();
      return g.outcome.reason;
    });
    const ops = await drawnOps(page), dark = await norm(page, 'rgba(6,12,24,0.62)'), vw = await page.evaluate(() => walkoff.view.w);
    const at = ops.findIndex((o) => o.t === 'fill' && o.style === dark), P = ops[at];
    expect(at).toBeGreaterThan(-1);
    const lines = ops.filter((o, i) => i > at && o.t === 'text' && (/^\d+ms (빠름|늦음)$/.test(o.s) || ['빠름', '늦음', reason].includes(o.s) || /^타구 \d+km\/h/.test(o.s)));
    expect(new Set(lines.map((o) => o.s)).size).toBe(5);   // 칩·막대 양끝·타구·이유를 판 다음에 그린다
    for (const o of lines) { expect(o.y, o.s).toBeGreaterThan(P.y); expect(o.y, o.s).toBeLessThan(P.y + P.h); }
    expect(P.x).toBeGreaterThanOrEqual(0); expect(P.x + P.w).toBeLessThanOrEqual(vw);
    expect(errors).toEqual([]);
  });
});

test.describe('타구 정보', () => {
  test('맞는 순간 가운데 전광판이 타구 속도·발사각을 띄우고 날아가는 동안 비거리가 올라가며, 결과 전에는 세이프·아웃이 드러나지 않는다. 안타는 HIT 뒤, 아웃도 마지막 타구 정보를 어둡게 남기고, 헛스윙은 투수판이다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    const r = await page.evaluate(() => {
      const w = walkoff, g = w.game; w.paused = true;
      const hit = (p, dt) => { w.startGame('challenge'); g.seq[0] = p; for (let k = 0; k < 3000 && g.state !== 'result'; k++) { if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T + dt / 1000) w.swing(g.clockAt + Math.max(0, p.T + dt / 1000 - w.ballTime()) * 1000); g.clockAt += 1000 / 60; w.update(1 / 60); } };
      const trace = () => { const out = []; for (let k = 0; k < 60 * 8 && g.state === 'result'; k++) { g.clockAt += 1000 / 60; w.update(1 / 60); const s = w.scoreboardShows(); out.push({ t: g.resultT, s, b: s === 'ball' ? w.ballInfo() : null }); } return out; };
      const summary = (rows) => {
        const before = rows.filter((q) => q.t < g.revealAt), after = rows.filter((q) => q.t > g.revealAt + 2);
        const d = before.filter((q) => q.b).map((q) => q.b.dist);
        return { beforeShows: [...new Set(before.map((q) => q.s))], rising: d.length > 10 && d[d.length - 1] > d[0] + 5 && d.every((x, i) => i === 0 || x >= d[i - 1]), beforeDim: before.some((q) => q.b?.dim),
          afterShows: [...new Set(after.map((q) => q.s))], afterDim: after.every((q) => !q.b || q.b.dim), final: after.at(-1)?.b?.dist ?? null, ev: before.at(-1)?.b?.ev };
      };
      const res = {};
      hit(w.makeSequence(332, false)[2], -40); res.single = { ...summary(trace()), name: g.outcome.name, outEv: g.outcome.ev };
      hit(w.makeSequence(1, w.pitcherHand(1) === 'L')[5], -78); res.ground = { ...summary(trace()), name: g.outcome.name };
      hit(w.makeSequence(42, w.pitcherHand(42) === 'L')[0], -200); res.whiff = { kind: g.outcome.kind, shows: [...new Set(trace().map((q) => q.s))] };
      return res;
    });
    expect(r.single).toMatchObject({ name: '좌전 안타', beforeShows: ['ball'], rising: true, beforeDim: false, afterShows: ['ball'], afterDim: true });   // 날아가는 동안 타구 정보, HIT 뒤 어둡게 남김
    expect(r.single.ev).toBe(r.single.outEv);
    expect(r.ground).toMatchObject({ name: '3루수 땅볼', beforeShows: ['ball'], rising: true, afterShows: ['ball'], afterDim: true });   // 1루 승부 전에는 속도·각도·거리만
    expect(r.whiff).toEqual({ kind: 'whiff', shows: ['pitcher'] });   // 헛스윙은 타구가 없어 투수판
    // 전광판 그림에 쓴 글자: '타구 정보'·발사각·비거리
    await page.evaluate(() => { const w = walkoff, g = w.game; w.startGame('challenge'); const p = w.makeSequence(332, false)[2]; g.seq[0] = p; for (let k = 0; k < 3000 && g.state !== 'result'; k++) { if (g.state === 'pitch' && g.swingAt == null && w.ballTime() + 1 / 60 >= p.T - 0.04) w.swing(g.clockAt + Math.max(0, p.T - 0.04 - w.ballTime()) * 1000); g.clockAt += 1000 / 60; w.update(1 / 60); } while (g.resultT < 1.2) { g.clockAt += 1000 / 60; w.update(1 / 60); } w.paused = false; });
    // 폰은 카메라가 당긴 타구를 따라가 전광판이 화면 밖이라 같은 정보를 위 빈자리에 한 줄로 띄운다(PC는 전광판이 보여 안 띄운다)
    const line = (await drawnTexts(page)).some((s) => /^타구 109km\/h · 24° · \d+m$/.test(s));
    expect(line).toBe(await page.evaluate(() => { const R = walkoff.scoreboardRect(); return (Math.min(walkoff.view.w, R.x + R.w) - Math.max(0, R.x)) / R.w < 0.5; }));
    const words = await boardWords(page);
    expect(words).toContain('타구 정보');
    expect(words).toContain('발사각 24°');
    expect(words.some((s) => /^비거리 \d+m$/.test(s))).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('상점 배트 미리 보기', () => {
  test('배트 탭 미리 보기는 2.5초마다 공을 치고, 효과 배트면 맞는 순간 효과가 터지고 효과 없는 배트는 스윙만 한다', async ({ page }) => {
    const errors = await open(page, '?seed=42');
    const r = await page.evaluate(() => {
      const w = walkoff; w.paused = true;
      // t초(배트를 고른 뒤)의 미리 보기를 그릴 때 번짐(createRadialGradient)을 몇 번 그리는지와 타자 손 높이
      const at = (bat, t) => {
        w.setWallet({ look: { ...w.wallet.look, bat } });
        if (w.game.state !== 'shop') w.openShop();
        w.game.shop.tab = 'bat'; w.game.shop.demo = performance.now() - t * 1000;
        const proto = CanvasRenderingContext2D.prototype, rg = proto.createRadialGradient; let n = 0;
        proto.createRadialGradient = function (...a) { n++; return rg.apply(this, a); };
        try { w.render(performance.now() / 1000); } finally { proto.createRadialGradient = rg; }
        return n;
      };
      return { fireHit: at('bat-fire', 1.1), woodHit: at('bat-wood', 1.1), fireWait: at('bat-fire', 0.5), fireNext: at('bat-fire', 2.5 + 1.1) };
    });
    expect(r.fireHit).toBeGreaterThan(r.woodHit);    // 불꽃 배트는 맞는 순간 불덩이가 터지고
    expect(r.fireWait).toBe(r.woodHit);              // 기다리는 동안은 안 터지고(원목 배트와 같은 수)
    expect(r.fireNext).toBe(r.fireHit);              // 2.5초마다 되풀이한다
    expect(errors).toEqual([]);
  });
});
