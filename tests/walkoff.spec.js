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

// 테스트가 실제 랭킹 서버에 닿지 않도록 서버 주소를 가로채 가짜로 답한다. 받은 요청은 돌려주는 배열에 쌓인다.
// account: 로그인한 계정에 이미 있는 팀·닉네임(다른 기기에서 쓰던 계정을 흉내 낸다).
// scoreReply: 'best'(보낸 점수가 이번 주 최고 기록) | 'lower'(이번 주에 더 높은 기록이 있다). 테스트 중에 바꿀 수 있게 요청 때 읽는다.
// seed: /seeds가 내주는 10구 도전 시드(기본 42). 표는 요청마다 새로 만들어 돌려주는 배열의 tickets에 쌓는다(받은 시각 at).
// seedFail: /seeds가 서버 오류로 답한다. seedExpired: /seeds만 로그인이 풀린 것처럼 401로 답한다(계정 확인 /me는 된다).
// seedDelay: /seeds가 이만큼(ms) 늦게 답한다. scoreFail: /scores가 서버 오류로 답한다.
// /scores는 실제 서버처럼 10구 도전에 표가 없거나 모르는 표, 이미 쓴 표면 거절한다.
// 상점은 실제 서버(worker/src/shop.js)의 가격으로 코인·산 물건·착용을 기억한다. account.coins·owned·look으로 처음 지갑을 준다
async function mockApi(page, opts = {}) {
  const { rankings = EMPTY_RANKING, fail = false, account = {} } = opts;
  const { ITEMS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'shop.js')).href);
  const { replayScenario, WIN_BONUS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'scenario.js')).href);
  const shop = { coins: account.coins ?? 0, owned: [...(account.owned ?? [])], look: { ...(account.look ?? {}) } };
  const wallet = () => ({ coins: shop.coins, owned: [...shop.owned], look: { ...shop.look } });
  const calls = [], tickets = [];
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
      return new Promise((done) => setTimeout(done, opts.seedDelay ?? 0)).then(() => reply({ ok: true, ...t }));
    }
    if (url.pathname === '/me' && req.method() === 'PUT' && opts.failProfile) return reply({ ok: false, error: 'server_error' }, 500);   // 팀·닉네임 저장 실패(테스트 중에 바꿀 수 있게 요청 때 읽는다)
    if (url.pathname === '/me') return reply(req.method() === 'GET' ? { ok: true, playerId: ACCOUNT_ID, nick: account.nick ?? null, team: account.team ?? null, ...wallet() } : { ok: true });
    if (url.pathname === '/scores') {
      if (opts.scoreFail) return reply({ ok: false, error: 'server_error' }, 500);
      const { score, mode, token } = JSON.parse(req.postData() || '{}'), lower = opts.scoreReply === 'lower';
      const ticket = tickets.find((t) => t.token === token);
      if (mode === 'challenge' && !token) return reply({ ok: false, error: 'seed_required' }, 400);
      if (mode === 'challenge' && (!ticket || ticket.used)) return reply({ ok: false, error: ticket ? 'seed_used' : 'bad_seed' }, 400);
      if (ticket) ticket.used = true;
      const earned = opts.earned ?? Math.floor(score / 100);
      shop.coins += earned;
      return reply({ ok: true, accepted: !lower, week: '2026-10-26', me: { rank: 3, best: lower ? score + 1000 : score, days: 1, team: 'lg' }, myTeam: { rank: 2, total: 9000, team: 'lg' }, count: 5, coins: shop.coins, earned });
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
    return reply(rankings);
  });
  Object.defineProperty(calls, 'tickets', { value: tickets });   // 받은 요청 목록과 비교할 때 걸리지 않게 숨긴 속성으로 둔다
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

  test('끝내기 상황: 밀어내기, 희생플라이, 2스트라이크 파울, 끝내기 홈런', async ({ page }) => {
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

  test('실제로 친 10구 도전은 서버 검사(서버가 내준 시드의 공 순서·점수 상한·한 판 칠 시간)를 통과한다', async ({ page }) => {
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

  test('가장 빨리 친 판(공을 놓자마자 휘두르고 바로 다음 공)도 서버의 한 판 칠 시간 검사에 걸리지 않는다', async ({ page }) => {
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
    const game = await page.evaluate(() => ({ score: walkoff.game.score, lights: walkoff.game.summary.lights }));
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
    for (const want of [/^끝내기 상황$/, /^연습$/, /^타이밍 보정/, /^기록$/, /^이번 주 랭킹$/, /^팀·닉네임 바꾸기$/, /^카카오 로그인$/, /^닫기$/]) {
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
    expect(sentScores(errors).map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg', day: await page.evaluate(() => walkoff.today()), score: first.score, lights: expect.stringMatching(/^[GYR]$/), mode: 'challenge', seed: 42, token: errors.calls.tickets[0].token }]);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주')));
    expect((await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label)))).toContain('이번 주 최고 기록! 3위 · 랭킹 보기 ›');
    api.scoreReply = 'lower';   // 이번에는 이번 주에 더 높은 기록이 있다
    const second = await endChallenge();
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주 최고 ')));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain(`이번 주 최고 ${(second.score + 1000).toLocaleString()}점 · 3위 · 랭킹 보기 ›`);
    expect(sentScores(errors).map((c) => c.body.token)).toEqual(errors.calls.tickets.slice(0, 2).map((t) => t.token));   // 판마다 새 시드
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

  test('새 소식: 처음 온 사람은 점이 없고, 쳐 본 사람은 ≡에 빨간 점이 떴다가 읽으면 사라지며, 더 새 소식이 오면 다시 뜬다', async ({ page }) => {
    const errors = await open(page);   // 처음 온 사람(이 기기에 친 기록이 없음)
    expect(await page.evaluate(() => ({ unread: walkoff.newsUnread(), seen: localStorage.getItem('walkoff.newsSeen') === walkoff.NEWS[0].id }))).toEqual({ unread: false, seen: true });
    // 쳐 본 사람이 처음 이 기능을 만나면(읽은 기록 없음) 첫 소식부터 점이 뜬다
    await page.evaluate(() => { localStorage.removeItem('walkoff.newsSeen'); localStorage.setItem('walkoff.best', '1500'); });
    await reloadUntil(page, () => walkoff.newsUnread());
    await page.evaluate(() => { walkoff.game.state = 'menu'; });
    await expect.poll(() => page.evaluate(() => walkoff.ui.buttons.map((b) => b.label)[0])).toBe('새 소식');
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
    const box = await page.locator('canvas').boundingBox();   // 끌어 내리면 다시 위로
    await page.mouse.move(box.x + 180, box.y + 150); await page.mouse.down(); await page.mouse.move(box.x + 180, box.y + 600, { steps: 6 }); await page.mouse.up();
    expect(await page.evaluate(() => ({ scroll: walkoff.news.scroll, state: walkoff.game.state }))).toEqual({ scroll: 0, state: 'news' });
    await page.reload(); await page.waitForFunction(() => !!window.walkoff);
    expect(await page.evaluate(() => walkoff.newsUnread())).toBe(false);   // 읽은 기록은 남는다
    await page.evaluate(() => walkoff.NEWS.unshift({ id: '2099-01-01', label: '1/1', items: ['더 새 소식'] }));   // 다음 업데이트
    expect(await page.evaluate(() => walkoff.newsUnread())).toBe(true);
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
    const errors = await open(page, '', { login: true, api: { seed: 7, seedDelay: 1500 } });
    await page.keyboard.press('Space');   // 시드를 받는 중에 시작한다
    expect(await page.evaluate(() => [walkoff.game.state, walkoff.game.waitingSeed])).toEqual(['title', true]);
    await expect.poll(() => page.evaluate(() => walkoff.game.toast?.text)).toBe('공을 받는 중…');
    await page.keyboard.press('Space');   // 기다리는 동안 또 눌러도 한 판만 시작한다
    await tap(page, '메뉴');   // 다른 버튼도 받지 않는다(메뉴가 열리면 시작하지 않게 돼 있다)
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');
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

  test('상점: 물건을 하나씩 골라 미리 입혀 봐도 오류가 없고, 물건이 가장 많은 탭도 닫기까지 화면에 들어간다(폰은 키가 작은 360×640)', async ({ page, isMobile }) => {
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
        infield: (() => {   // 내야 안타는 1루를 지나쳐 멈췄다가 돌아온다
          let r = null; for (let sd = 1; sd < 30 && !r; sd++) { const q = walkoff.makeSequence(sd, false); for (let n = 0; n < 16 && !r; n++) for (let dt = -90; dt <= 90; dt += 3) { const x = walkoff.judgeSwing(q[n], dt, 'R'); if (x.infield) { r = x; break; } } }
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
    expect(after.lamps[0]).toBe('#3ddc6e');    // 홈런은 초록 불
    expect(errors).toEqual([]);
  });

  test('관중은 안타·홈런에 일어나 함성을 지르고(홈런이 더 크다), 파울에는 그대로다. 새 물건을 입고 쳐도 오류가 없다', async ({ page }) => {
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
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '팀·닉네임 바꾸기'));
    await tap(page, '팀·닉네임 바꾸기');
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
      return { tc, reveal: pl.reveal, dur: walkoff.flightDuration(r), home: at(0), atCatch: { ball: pl.ball(tc), glove: glove(tc), cf: at(tc) }, later: { ball: pl.ball(tc + 1), glove: glove(tc + 1) } };
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
        const runAt = (t) => { const q = walkoff.runnerAt(r, t); return Math.hypot(q.x - B1[0], q.z - B1[1]); };
        const ball = pl.ball(c.arrive.t), ballGap = Math.hypot(ball.x - B1[0], ball.z - B1[1]);
        let pass = 99; for (let t = c.runner - 0.3; t < c.runner + 0.3; t += 0.005) pass = Math.min(pass, runAt(t));
        return { margin: c.margin, end: pl.end, arrive: c.arrive.t, runner: c.runner, ballGap, runnerAtTouch: runAt(c.runner), pass, slow: pl.slow.length, rate: pl.rate(Math.max(c.arrive.t, c.runner) - 0.1), call: pl.calls[0]?.text, revealReal: pl.revealReal, reveal: pl.reveal };
      };
      return { out: one(walkoff.judgeSwing(seq[5], -78, 'R')), safe: one(walkoff.judgeSwing(seq[3], -90, 'R')) };
    });
    for (const [k, v] of Object.entries(d)) {
      expect(v.ballGap, k).toBeLessThan(1.6);           // 송구는 판정한 때에 1루(뻗은 글러브)에 닿는다
      expect(v.runnerAtTouch, k).toBeLessThan(0.7);     // 주자는 판정한 때에 1루를 밟는다
      expect(v.slow, k).toBe(1);
      expect(v.rate, k).toBeCloseTo(0.4, 5);            // 판정 앞은 0.4배로 느리다
      expect(v.revealReal, k).toBeGreaterThan(v.reveal);  // 느린 만큼 결과 글자는 실제 시간으로 늦게 뜬다
    }
    expect(d.out.call).toBe('아웃');
    expect(d.safe.call).toBe('세이프');
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
          // 2루타에서 공 앞 외야수가 떨어지는 공에 몸을 날렸다가 놓치는 것(ev.miss)은 따로 센다
          const missDive = (pos, e) => pos === pl.ev.miss && e.t0 < pl.ev.land + 0.3;
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

  test('사람이 친 판은 시작과 끝을 보내고, 기기 번호·모드·시작끝·터치 여부 말고는 보내지 않는다', async ({ page }) => {
    const { MODES } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'stats.js')).href);
    await catchBeacons(page, { human: true });
    const errors = await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝나게
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    for (const mode of ['scenario', 'practice']) await page.evaluate((m) => walkoff.startGame(m), mode);   // 다른 모드는 시작만(오늘의 10구는 없앴다)
    const beacons = await page.evaluate(() => window.__beacons);
    expect(beacons.map((b) => [b.url, b.body.mode, b.body.type])).toEqual([
      [`${API}/events`, 'challenge', 'start'], [`${API}/events`, 'challenge', 'end'],
      [`${API}/events`, 'scenario', 'start'], [`${API}/events`, 'practice', 'start'],
    ]);
    for (const b of beacons) {
      expect(Object.keys(b.body).sort()).toEqual(['device', 'mobile', 'mode', 'type']);
      expect(MODES).toContain(b.body.mode);   // 서버(worker/src/stats.js)가 받는 모드만 보낸다
    }
    const ids = await page.evaluate(() => ({ device: localStorage.getItem('walkoff.device'), player: walkoff.settings.playerId }));
    expect(ids.device).toMatch(/^[a-z0-9-]{8,40}$/);
    expect(beacons.every((b) => b.body.device === ids.device)).toBe(true);
    expect(ids.device).not.toBe(ids.player);   // 랭킹 ID와 다른 번호라 통계와 랭킹이 이어지지 않는다
    expect(errors).toEqual([]);
  });

  test('자동 브라우저(테스트, 봇)는 세지 않는다', async ({ page }) => {
    await catchBeacons(page, { human: false });
    await open(page, `?seed=42&api=${encodeURIComponent(API)}`);
    await page.evaluate(() => walkoff.startGame('challenge'));
    expect(await page.evaluate(() => window.__beacons)).toEqual([]);
  });

  test('이 컴퓨터에서 연 게임(?api 없이)은 세지 않는다', async ({ page }) => {
    await catchBeacons(page, { human: true });
    await open(page);
    await page.evaluate(() => walkoff.startGame('challenge'));
    expect(await page.evaluate(() => window.__beacons)).toEqual([]);
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
          if (g.resultT >= bm.t1 + 1) return { name: g.outcome.name, min, home, late: bm.t0 - g.revealAt, follow: Math.abs(w.view.panX - pan) };
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
    expect(dbl.late).toBeGreaterThan(0.3);
    expect(hr.follow).toBeGreaterThan(20);   // 글자가 끝나면 화면이 다시 주자를 따라간다
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
      return { name, t0: bm.t0, t1: bm.t1, cheerAt, titleAt, before, detailsBefore, after, hrCheer, hrT0: w.boardMoment().t0 };
    });
    expect(r.name).toBe('좌전 안타');
    expect(Math.abs(r.cheerAt - r.t0)).toBeLessThan(0.05);   // 함성과 HIT이 같은 순간에
    expect(Math.abs(r.titleAt - r.t0)).toBeLessThan(0.05);   // 결과 제목도(전에는 HIT이 끝난 1.2초 뒤에 카드와 함께)
    expect(r.detailsBefore).toBe(false);                      // 자세한 카드는 HIT 동안 없고
    expect(r.after.details).toBe(true);                       // 끝난 뒤에 나오며
    expect(r.after.title).toEqual(r.before);                  // 제목은 자리·크기 그대로(다시 튀어나오지 않는다)
    expect(r.hrT0 - r.hrCheer).toBeGreaterThan(0.3);          // 홈런: 공이 담장을 넘을 때 함성, 카메라가 돌아오면 HOMERUN과 제목
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
