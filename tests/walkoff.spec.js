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
// 상점은 실제 서버(worker/src/shop.js)의 가격으로 코인·산 물건·착용을 기억한다. account.coins·owned·look으로 처음 지갑을 준다
async function mockApi(page, opts = {}) {
  const { rankings = EMPTY_RANKING, fail = false, account = {} } = opts;
  const { ITEMS } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'shop.js')).href);
  const shop = { coins: account.coins ?? 0, owned: [...(account.owned ?? [])], look: { ...(account.look ?? {}) } };
  const wallet = () => ({ coins: shop.coins, owned: [...shop.owned], look: { ...shop.look } });
  const calls = [];
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
    if (['/me', '/scores', '/shop/buy', '/shop/equip'].includes(url.pathname) && auth !== `Bearer ${SESSION}`) return reply({ ok: false, error: 'login_required' }, 401);
    if (url.pathname === '/me') return reply(req.method() === 'GET' ? { ok: true, playerId: ACCOUNT_ID, nick: account.nick ?? null, team: account.team ?? null, ...wallet() } : { ok: true });
    if (url.pathname === '/scores') {
      const { score, mode } = JSON.parse(req.postData() || '{}'), lower = opts.scoreReply === 'lower';
      const earned = opts.earned ?? Math.floor(score / 100) * (mode === 'daily' ? 2 : 1);
      shop.coins += earned;
      return reply({ ok: true, accepted: !lower, week: '2026-10-26', me: { rank: 3, best: lower ? score + 1000 : score, days: 1, team: 'lg' }, myTeam: { rank: 2, total: 9000, team: 'lg' }, count: 5, coins: shop.coins, earned, bonus: mode === 'daily' });
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

// 오늘의 10구를 친 날을 이 브라우저 기록(daily.날짜)으로 둔다. ago는 며칠 전에 쳤는지(0은 오늘)
const setPlayedDays = (page, ago) => page.evaluate((ago) => {
  for (const k of walkoff.store.keys('daily.')) walkoff.store.remove(k);
  const t = Date.parse(walkoff.today() + 'T00:00:00Z');
  for (const n of ago) {
    const date = new Date(t - n * 864e5).toISOString().slice(0, 10);
    walkoff.store.set('daily.' + date, { score: 1500, hr: 0, hits: 3, balls: 1, far: 82, lights: 'GGRYGRRRRRR', bats: 'R', day: walkoff.dayNumber(date), date });
  }
}, ago);

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

  test('같은 시드와 같은 날짜는 같은 공 순서다', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => ({
      sameSeed: JSON.stringify(walkoff.makeSequence(7)) === JSON.stringify(walkoff.makeSequence(7)),
      length: walkoff.makeSequence(7).length,
      sameDay: walkoff.dailySeed('2026-10-28') === walkoff.dailySeed('2026-10-28'),
      nextDay: walkoff.dailySeed('2026-10-28') !== walkoff.dailySeed('2026-10-29'),
      dayOne: walkoff.dayNumber('2026-10-28'),
    }));
    expect(r).toEqual({ sameSeed: true, length: 40, sameDay: true, nextDay: true, dayOne: 1 });   // 볼은 기회를 안 써서 공을 40개 미리 만든다
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
    const text = await page.evaluate(() => walkoff.shareText({ day: 3, bats: 'L', lights: 'GYRRG', score: 2100, hr: 1, far: 128 }));
    expect(text.split('\n')).toEqual([
      'walkoff 오늘의 10구 #3 (좌타)',
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

  test('오늘의 10구: 첫 판만 기록되고(어제도 쳤으면 2일 연속), 다시 누르면 기록을 보여 준다', async ({ page }) => {
    test.slow();
    const errors = await open(page, '', { login: true });
    await setPlayedDays(page, [1]);   // 어제도 쳤다
    await page.keyboard.press('Space');   // 오늘 아직 안 쳤으면 오늘의 10구로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('daily');
    await playUntilOver(page, 0);
    const saved = await page.evaluate(() => walkoff.store.get('daily.' + walkoff.today(), null));
    expect(saved && saved.score).toBe(await page.evaluate(() => walkoff.game.score));
    // 첫 판 점수가 로그인 표와 함께 랭킹 서버로 한 번 가고, 끝 화면에 이번 주 순위가 붙는다
    await expect.poll(() => sentScores(errors).length).toBe(1);
    const sent = sentScores(errors)[0], today = await page.evaluate(() => walkoff.today());
    expect(sent.auth).toBe(`Bearer ${SESSION}`);
    expect(sent.body).toEqual({ nick: '테스트', team: 'lg', day: today, score: saved.score, lights: saved.lights, mode: 'daily' });   // 사람 ID는 서버가 로그인 표에서 꺼낸다. mode는 코인 2배 판단용
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain('이번 주 최고 기록! 3위 · 랭킹 보기 ›');
    expect((await drawnTexts(page)).some((t) => / · 2일 연속( · |$)/.test(t))).toBe(true);   // 방금 친 판까지 세서 점수 아래 줄(코인 앞)에 붙는다
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');   // 오늘 친 뒤에는 10구 도전으로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('challenge');
    expect(sentScores(errors).length).toBe(1);   // 10구 도전은 판이 끝나야 보낸다
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
    expect(await page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');   // 로그인 안 했으면 오늘의 10구 전에 로그인을 권한다
    await tap(page, '나중에 하기');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'daily' });
    expect(errors).toEqual([]);
  });

  test('로그인 안 한 사람은 오늘의 10구 전에 하루 한 번 카카오 로그인을 권한다', async ({ page }) => {
    const errors = await open(page);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '나중에 하기'));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label).sort())).toEqual(['나중에 하기', '카카오로 로그인']);
    await page.keyboard.press('Escape');   // 닫으면 시작 화면. 다시 시작하면 또 묻는다
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => walkoff.game.state)).toBe('loginPrompt');
    await tap(page, '나중에 하기');
    await expect.poll(() => page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'daily' });
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

  test('오늘의 10구 연속 기록: 시작 화면 아래 줄과 끝 화면에 이어 친 날 수가 나오고, 하루 빠지면 끊긴다', async ({ page }) => {
    const errors = await open(page, '');
    const day = await page.evaluate(() => walkoff.dayNumber(walkoff.today()));
    const titleLine = async () => (await drawnTexts(page)).find((t) => t.startsWith(`오늘의 10구 #${day}`));
    await setPlayedDays(page, [2, 3]);   // 어제를 걸러서 끊겼다
    expect(await titleLine()).toBe(`오늘의 10구 #${day} · 주간 랭킹은 이번 주 최고 기록이에요`);
    await setPlayedDays(page, [1, 3]);
    expect(await titleLine()).toBe(`오늘의 10구 #${day} · 오늘 치면 2일 연속`);
    await setPlayedDays(page, [1, 2]);
    expect(await titleLine()).toBe(`오늘의 10구 #${day} · 2일 연속 중 · 오늘 치면 3일`);
    await setPlayedDays(page, [0, 1, 2]);
    expect(await titleLine()).toBe(`오늘의 10구 #${day} 1,500점 기록 · 3일 연속 · 지금은 10구 도전`);
    // 끝 화면(메뉴의 오늘의 10구 결과 보기)은 점수 아래 줄에 붙는다
    const streakLine = async () => (await drawnTexts(page)).find((t) => t.includes('일 연속'));
    await tap(page, '메뉴');
    await tap(page, '오늘의 10구 결과 보기');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    expect(await streakLine()).toBe('주전 타자 · 3일 연속');
    // 오늘만 이어졌으면(어제를 걸렀으면) 끝 화면에도 시작 화면에도 없다
    await setPlayedDays(page, [0, 2]);
    expect(await streakLine()).toBeUndefined();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => walkoff.game.state === 'title');
    expect(await titleLine()).toBe(`오늘의 10구 #${day} 1,500점 기록 · 지금은 10구 도전`);
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
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'daily' });
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
    await loginReturn(page, '?seed=42', 'nother1234567', { stored: 'nabc12345678' });   // 다른 사람이 만든 로그인 주소
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, session: localStorage.getItem('walkoff.session'), hash: location.hash })))
      .toEqual({ token: null, session: null, hash: '' });
    expect(errors.calls.filter((c) => c.path === '/me')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('로그인하지 않으면 점수를 남겨 두고, 끝 화면에서 카카오로 로그인하면 그때 올린다', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => { walkoff.startGame('daily'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝낸다
    await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => walkoff.game.state === 'over');
    const today = await page.evaluate(() => walkoff.today()), pending = await page.evaluate(() => walkoff.store.get('pending', null));
    expect(pending).toMatchObject({ nick: '테스트', team: 'lg', day: today });
    expect(sentScores(errors)).toEqual([]);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 로그인하면 랭킹에 올라가요 ›'));
    await tap(page, '카카오로 로그인하면 랭킹에 올라가요 ›');
    await loginReturn(page, '?seed=42', (await kakaoStart(errors, page)).n);
    await expect.poll(() => sentScores(errors).length).toBe(1);
    expect(sentScores(errors)[0]).toMatchObject({ auth: `Bearer ${SESSION}`, body: pending });
    await page.waitForFunction(() => walkoff.store.get('pending', null) === null);
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, playerId: walkoff.settings.playerId, toast: walkoff.game.toast?.text })))
      .toEqual({ token: SESSION, playerId: ACCOUNT_ID, toast: '기록을 랭킹에 올렸어요' });
    expect(errors.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg' }]);   // 새 계정에 팀·닉네임을 올린다
    expect(errors).toEqual([]);
  });

  test('10구 도전도 판이 끝나면 보내고, 이번 주 최고 기록이면 끝 화면에 바로 보인다', async ({ page }) => {
    const api = { scoreReply: 'best' };
    const errors = await open(page, '?seed=42', { login: true, api });
    const endChallenge = async () => {
      await page.evaluate(() => { walkoff.startGame('challenge'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });   // 공 하나로 끝낸다
      await page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
      await page.keyboard.press('Space');
      await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.game.rankInfo?.status === 'ok');
      return page.evaluate(() => ({ score: walkoff.game.score, labels: walkoff.ui.buttons.map((b) => b.label) }));
    };
    const first = await endChallenge();
    expect(sentScores(errors).map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg', day: await page.evaluate(() => walkoff.today()), score: first.score, lights: expect.stringMatching(/^[GYR]$/), mode: 'challenge' }]);
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주')));
    expect((await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label)))).toContain('이번 주 최고 기록! 3위 · 랭킹 보기 ›');
    api.scoreReply = 'lower';   // 이번에는 이번 주에 더 높은 기록이 있다
    const second = await endChallenge();
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('이번 주 최고 ')));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain(`이번 주 최고 ${(second.score + 1000).toLocaleString()}점 · 3위 · 랭킹 보기 ›`);
    expect(sentScores(errors).length).toBe(2);
    expect(errors).toEqual([]);
  });

  test('로그인 전에 친 판은 가장 높은 판 하나만 남겨 둔다(이틀 지난 판은 버린다)', async ({ page }) => {
    const errors = await open(page);
    const keep = (body) => page.evaluate((b) => { walkoff.keepPending(b); return walkoff.store.get('pending', null)?.score; }, body);
    const day = await page.evaluate(() => walkoff.today());
    const old = await page.evaluate(() => new Date(Date.now() + 9 * 3600e3 - 3 * 864e5).toISOString().slice(0, 10));
    expect(await keep({ nick: '테스트', team: 'lg', day, score: 5000, lights: 'G' })).toBe(5000);
    expect(await keep({ nick: '테스트', team: 'lg', day, score: 3000, lights: 'G' })).toBe(5000);   // 낮은 판은 남기지 않는다
    expect(await keep({ nick: '테스트', team: 'lg', day, score: 6000, lights: 'G' })).toBe(6000);
    await page.evaluate((d) => walkoff.store.set('pending', { nick: '테스트', team: 'lg', day: d, score: 9000, lights: 'G' }), old);
    expect(await keep({ nick: '테스트', team: 'lg', day, score: 1000, lights: 'G' })).toBe(1000);   // 서버가 안 받는 사흘 전 판은 버린다
    expect(sentScores(errors)).toEqual([]);   // 로그인하지 않았으면 보내지 않는다
    expect(errors).toEqual([]);
  });

  test('10구 도전은 공을 보고 처음부터 다시 할 수 있고, 끝내지 않은 판은 보내지 않는다. 오늘의 10구에는 없다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { login: true });
    const resultShown = () => page.waitForFunction(() => walkoff.game.state === 'result' && walkoff.game.resultT > walkoff.game.revealAt + 0.4, null, { timeout: 15_000 });
    await page.evaluate(() => walkoff.startGame('challenge'));
    await resultShown();   // 초구를 그냥 보낸다
    await tap(page, '처음부터');
    await expect.poll(() => page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode, i: walkoff.game.i, results: walkoff.game.results.length, score: walkoff.game.score })))
      .toEqual({ state: 'windup', mode: 'challenge', i: 0, results: 0, score: 0 });
    expect(sentScores(errors)).toEqual([]);
    await page.evaluate(() => walkoff.startGame('daily'));
    await resultShown();
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label.startsWith('다음 공')));
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).not.toContain('처음부터');   // 모두 같은 공이라 다시 보고 칠 수 없게
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

  test('끝 화면에 받은 코인이 붙고, 꾸민 공 꼬리·타격음·등번호로 쳐도 문제없다', async ({ page }) => {
    const look = { trail: 'trail-fire', sound: 'sound-metal', number: 'number-on', no: 9, helmet: 'helmet-gold', uniform: 'uniform-home' };
    const errors = await open(page, '?seed=42', { login: true, api: { account: { coins: 0, owned: ['trail-fire', 'sound-metal', 'number-on', 'helmet-gold', 'uniform-home'], look }, earned: 64 } });
    await page.waitForFunction(() => walkoff.wallet.look.trail === 'trail-fire');
    expect(await page.evaluate(() => ({ helmet: walkoff.batterColors().helmet, jersey: walkoff.batterColors().jersey, accent: walkoff.batterColors().accent })))
      .toEqual({ helmet: '#e3b322', jersey: '#eceef2', accent: '#a50034' });   // 홈 유니폼은 흰 바탕에 소매·스타킹은 팀 색(LG)
    await page.evaluate(() => { walkoff.startGame('daily'); Object.assign(walkoff.game, { left: 1, extra: 99 }); });
    const o = await playPitch(page, 0);
    expect(o.kind).not.toBe('whiff');
    await page.waitForFunction(() => walkoff.game.state === 'over' && walkoff.game.rankInfo?.status === 'ok');
    expect(await page.evaluate(() => ({ note: walkoff.coinNote(), coins: walkoff.wallet.coins }))).toEqual({ note: ' · +64코인(2배)', coins: 64 });
    expect(sentScores(errors)[0].body.mode).toBe('daily');
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
    ['오늘의 10구', 'daily', /^walkoff 오늘의 10구 #\d+ \(우타\)$/, '처음으로'],
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
    await endAfterOnePitch(page, 'daily');
    await page.waitForFunction(() => walkoff.game.shareCard?.file != null);
    await tap(page, '결과 공유하기');
    await tap(page, '결과 공유하기');   // 공유 창이 떠 있는 동안 또 누른다
    expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    const sent = await page.evaluate(async () => {
      const d = window.__calls[0], f = d.files?.[0], img = f && await createImageBitmap(f);
      return { files: d.files?.length ?? 0, type: f?.type, w: img?.width, h: img?.height, text: d.text };
    });
    expect(sent).toMatchObject({ files: 1, type: 'image/png', w: 1080, h: 1080 });
    expect(sent.text.split('\n')[0]).toMatch(/^walkoff 오늘의 10구 #\d+ \(우타\)$/);
    expect(sent.text.split('\n').at(-1)).toBe('https://hyunseungbeom.github.io/walkoff/');
    // 그림 공유가 안 되는 브라우저는 예전처럼 글만 보낸다
    await page.evaluate(() => { window.__close(); window.__filesOk = false; });
    await expect.poll(() => page.evaluate(() => walkoff.game.sharing)).toBe(false);
    await tap(page, '결과 공유하기');
    expect(await page.evaluate(() => ({ n: window.__calls.length, files: window.__calls[1].files ?? null, same: window.__calls[1].text === window.__calls[0].text })))
      .toEqual({ n: 2, files: null, same: true });
    expect(errors).toEqual([]);
  });

  test('결과 카드에는 끝 화면의 큰 줄과 주소가 들어간다(오늘의 10구는 연속 일수, 10구 도전은 새 최고 기록, 끝내기 상황은 결과)', async ({ page }) => {
    const errors = await open(page);
    // 카드를 그릴 때 쓴 글자를 차례대로 모은다
    const cardTexts = (s, mode) => page.evaluate(({ s, mode }) => {
      const proto = CanvasRenderingContext2D.prototype, fill = proto.fillText, seen = [];
      proto.fillText = function (str, ...rest) { seen.push(String(str)); return fill.call(this, str, ...rest); };
      try { walkoff.drawShareCard(s, mode); } finally { proto.fillText = fill; }
      return seen;
    }, { s, mode });
    await setPlayedDays(page, [0, 1, 2]);
    const day = await page.evaluate(() => walkoff.dayNumber(walkoff.today()));
    const base = { score: 2350, hr: 1, hits: 3, balls: 2, far: 118, lights: 'GRYGRRYGRRRR', bats: 'R', day };
    expect(await cardTexts(base, 'daily')).toEqual(['끝내기', 'walkoff', `오늘의 10구 #${day} · 우타`, '2,350', '주전 타자 · 3일 연속', '홈런 1 · 안타 3 · 볼 2 · 가장 멀리 118m', 'walkoff · hyunseungbeom.github.io/walkoff']);
    expect((await cardTexts({ ...base, bats: 'L', newBest: true }, 'challenge')).slice(2, 5)).toEqual(['10구 도전 · 좌타', '2,350', '새 최고 기록!']);
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
    for (const mode of ['daily', 'scenario', 'practice']) await page.evaluate((m) => walkoff.startGame(m), mode);   // 다른 모드는 시작만
    const beacons = await page.evaluate(() => window.__beacons);
    expect(beacons.map((b) => [b.url, b.body.mode, b.body.type])).toEqual([
      [`${API}/events`, 'challenge', 'start'], [`${API}/events`, 'challenge', 'end'],
      [`${API}/events`, 'daily', 'start'], [`${API}/events`, 'scenario', 'start'], [`${API}/events`, 'practice', 'start'],
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
