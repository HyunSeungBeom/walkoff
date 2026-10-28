// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const API = 'https://walkoff-api.walkoff-api.workers.dev';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' };
const SESSION = 'test-session';         // 가짜 서버가 받아 주는 로그인 표
const ACCOUNT_ID = 'p-account-0001';    // 가짜 서버의 계정 ID
const EMPTY_RANKING = { week: '2026-10-26', nextWeek: '2026-11-02', players: [], teams: [], count: 0, me: null, myTeam: null, lastWeek: { player: null, team: null } };
const SAMPLE_RANKING = {
  ...EMPTY_RANKING,
  players: [
    { rank: 1, nick: '명은', team: 'lotte', total: 12300, days: 3, me: false },
    { rank: 2, nick: '민성', team: 'lg', total: 9100, days: 2, me: true },
  ],
  teams: [{ rank: 1, team: 'lotte', total: 12300, players: 1 }, { rank: 2, team: 'lg', total: 9100, players: 1 }],
  count: 2, me: { rank: 2, total: 9100, days: 2, team: 'lg' }, myTeam: { rank: 2, total: 9100, team: 'lg' },
  lastWeek: { player: { rank: 1, nick: '명은', team: 'lotte', total: 20000, days: 7, me: false }, team: { rank: 1, team: 'lotte', total: 20000, players: 1 } },
};

// 테스트가 실제 랭킹 서버에 닿지 않도록 서버 주소를 가로채 가짜로 답한다. 받은 요청은 돌려주는 배열에 쌓인다.
// account: 로그인한 계정에 이미 있는 팀·닉네임(다른 기기에서 쓰던 계정을 흉내 낸다)
async function mockApi(page, { rankings = EMPTY_RANKING, fail = false, account = {} } = {}) {
  const calls = [];
  await page.route(`${API}/**`, (route) => {
    const req = route.request(), url = new URL(req.url()), auth = req.headers().authorization ?? null;
    const reply = (body, status = 200) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ method: req.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), auth, body: req.postData() ? JSON.parse(req.postData()) : null });
    if (url.pathname.startsWith('/auth/')) return route.abort();   // 카카오로 가는 길. 돌아오는 것은 loginReturn으로 흉내 낸다
    if (fail) return reply({ ok: false, error: 'server_error' }, 500);
    if ((url.pathname === '/me' || url.pathname === '/scores') && auth !== `Bearer ${SESSION}`) return reply({ ok: false, error: 'login_required' }, 401);
    if (url.pathname === '/me') return reply(req.method() === 'GET' ? { ok: true, playerId: ACCOUNT_ID, nick: account.nick ?? null, team: account.team ?? null } : { ok: true });
    if (url.pathname === '/scores') {
      return reply({ ok: true, accepted: true, week: '2026-10-26', me: { rank: 3, total: 4200, days: 1, team: 'lg' }, myTeam: { rank: 2, total: 9000, team: 'lg' }, count: 5 });
    }
    return reply(rankings);
  });
  return calls;
}

// team: 처음부터 고른 팀(null이면 처음 온 사람). login: 카카오로 로그인한 상태로 연다. api: mockApi 설정
async function open(page, query = '?seed=42', { team = 'lg', login = false, api } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = await mockApi(page, api);
  await page.addInitScript(({ team, login, session }) => {
    if (location.protocol !== 'file:') return;   // 로그인 흉내 중에 지나가는 빈 페이지에서는 저장소를 못 쓴다
    if (localStorage.getItem('walkoff.seeded')) return;   // 새로고침해도 처음 값으로 되돌리지 않는다
    localStorage.setItem('walkoff.seeded', '1');
    if (team) { localStorage.setItem('walkoff.team', team); localStorage.setItem('walkoff.nick', '테스트'); }
    if (login) localStorage.setItem('walkoff.session', session);
  }, { team, login, session: SESSION });
  await page.goto(PAGE + query);
  await page.waitForFunction(() => !!window.walkoff);
  Object.defineProperty(errors, 'calls', { value: calls });   // expect(errors).toEqual([])에 걸리지 않게 숨긴 속성으로 둔다
  return errors;
}
const sentScores = (errors) => errors.calls.filter((c) => c.method === 'POST' && c.path === '/scores');

// 게임이 카카오 로그인으로 떠난 요청(서버 /auth/kakao/start)을 기다려 그 값을 돌려준다
async function kakaoStart(errors) {
  await expect.poll(() => errors.calls.some((c) => c.path === '/auth/kakao/start')).toBe(true);
  return errors.calls.find((c) => c.path === '/auth/kakao/start').query;
}

// 카카오 로그인을 마치고 게임으로 돌아온 것처럼 연다. n은 게임이 보낸 확인값
async function loginReturn(page, query, n, { error } = {}) {
  await page.goto('about:blank');
  await page.goto(`${PAGE}${query}#${error ? `login_error=${error}` : `login=${SESSION}`}&n=${n}`);
  await page.waitForFunction(() => !!window.walkoff);
}

const tap = async (page, label) => {
  const r = await page.evaluate((l) => walkoff.ui.buttons.find((b) => b.label === l)?.r, label);
  if (!r) throw new Error(`버튼이 없다: ${label}`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
};

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
    expect(r).toEqual({ sameSeed: true, length: 15, sameDay: true, nextDay: true, dayOne: 1 });
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

  test('10구 도전: 볼을 골라내면 기회가 늘고, 추가 기회는 5번까지다', async ({ page }) => {
    test.slow();
    const errors = await open(page, '?seed=2');   // 처음 15개 중 존 밖 공이 7개 넘는 시드
    await page.evaluate(() => walkoff.startGame('challenge'));
    await playUntilOver(page, null);
    const end = await page.evaluate(() => ({ pitches: walkoff.game.results.length, extra: walkoff.game.extra, left: walkoff.game.left }));
    expect(end).toEqual({ pitches: 15, extra: 5, left: 0 });
    expect(errors).toEqual([]);
  });

  test('오늘의 10구: 첫 판만 기록되고, 다시 누르면 기록을 보여 준다', async ({ page }) => {
    test.slow();
    const errors = await open(page, '', { login: true });
    await page.keyboard.press('Space');   // 오늘 아직 안 쳤으면 오늘의 10구로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('daily');
    await playUntilOver(page, 0);
    const saved = await page.evaluate(() => walkoff.store.get('daily.' + walkoff.today(), null));
    expect(saved && saved.score).toBe(await page.evaluate(() => walkoff.game.score));
    // 첫 판 점수가 로그인 표와 함께 랭킹 서버로 한 번 가고, 끝 화면에 이번 주 순위가 붙는다
    await expect.poll(() => sentScores(errors).length).toBe(1);
    const sent = sentScores(errors)[0], today = await page.evaluate(() => walkoff.today());
    expect(sent.auth).toBe(`Bearer ${SESSION}`);
    expect(sent.body).toEqual({ nick: '테스트', team: 'lg', day: today, score: saved.score, lights: saved.lights });   // 사람 ID는 서버가 로그인 표에서 꺼낸다
    await page.waitForFunction(() => walkoff.game.rankInfo?.status === 'ok');
    expect(await page.evaluate(() => walkoff.ui.buttons.map((b) => b.label))).toContain('이번 주 3위 · LG 2위 · 랭킹 보기 ›');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');   // 오늘 친 뒤에는 10구 도전으로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('challenge');
    expect(sentScores(errors).length).toBe(1);   // 10구 도전은 랭킹에 보내지 않는다
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
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'daily' });
    expect(errors).toEqual([]);
  });

  test('좌타/우타는 눌러도 경기가 시작되지 않고, 새로고침해도 남는다', async ({ page }) => {
    const errors = await open(page);
    const left = await page.evaluate(() => walkoff.ui.buttons.find((b) => b.label === '좌타').r);
    await page.mouse.click(left.x + left.w / 2, left.y + left.h / 2);
    expect(await page.evaluate(() => walkoff.game.state)).toBe('title');   // 버튼을 눌러도 경기는 시작하지 않는다
    await page.reload();
    await page.waitForFunction(() => !!window.walkoff);
    expect(await page.evaluate(() => walkoff.settings.bats)).toBe('L');
    expect(errors).toEqual([]);
  });

  test('처음 온 사람은 열자마자 팀과 닉네임을 고르고, 로그인 없이도 시작할 수 있다', async ({ page }) => {
    const errors = await open(page, '?seed=42', { team: null });
    const nick = page.locator('input[aria-label="닉네임"]');
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');   // 누르지 않아도 팀 고르기부터
    await page.waitForFunction(() => walkoff.ui.buttons.some((b) => b.label === '카카오로 시작'));
    await tap(page, '로그인 없이 하기 · 랭킹 제외');   // 팀을 안 고르면 넘어가지 않는다
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');
    await tap(page, '한화 이글스');
    expect(await page.evaluate(() => walkoff.batterColors().accent)).toBe('#1b1b1b');   // 고르는 중에도 유니폼을 미리 입혀 본다
    await nick.fill('명은');
    await nick.press('Enter');   // 처음 화면에서 엔터는 키보드만 닫는다(카카오 로그인으로 넘어가지 않는다)
    expect(await page.evaluate(() => walkoff.game.state)).toBe('onboard');
    await tap(page, '로그인 없이 하기 · 랭킹 제외');
    expect(await page.evaluate(() => ({ state: walkoff.game.state, team: walkoff.settings.team, nick: walkoff.settings.nick })))
      .toEqual({ state: 'title', team: 'hanwha', nick: '명은' });   // 시작 화면에서 규칙과 좌타·우타를 보고 시작한다
    await expect(nick).toBeHidden();
    const vp = page.viewportSize();
    await page.mouse.click(20, vp.height - 20);
    expect(await page.evaluate(() => ({ state: walkoff.game.state, mode: walkoff.game.mode }))).toEqual({ state: 'windup', mode: 'daily' });
    expect(await page.evaluate(() => walkoff.game.opponent !== 'hanwha' && walkoff.pitcherColors().navy !== '#1d2f5c')).toBe(true);   // 투수는 상대 팀 색
    await page.reload();
    await page.waitForFunction(() => !!window.walkoff);
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
    const start = await kakaoStart(errors);
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
    await loginReturn(page, '?seed=42', 'nother1234567');   // 다른 사람이 만든 로그인 주소
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
    await loginReturn(page, '?seed=42', (await kakaoStart(errors)).n);
    await expect.poll(() => sentScores(errors).length).toBe(1);
    expect(sentScores(errors)[0]).toMatchObject({ auth: `Bearer ${SESSION}`, body: pending });
    await page.waitForFunction(() => walkoff.store.get('pending', null) === null);
    expect(await page.evaluate(() => ({ token: walkoff.auth.token, playerId: walkoff.settings.playerId, toast: walkoff.game.toast?.text })))
      .toEqual({ token: SESSION, playerId: ACCOUNT_ID, toast: '오늘의 10구 기록을 랭킹에 올렸어요' });
    expect(errors.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ nick: '테스트', team: 'lg' }]);   // 새 계정에 팀·닉네임을 올린다
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
});

test.describe('랭킹 규칙', () => {
  test.skip(({ isMobile }) => isMobile, '계산은 화면 크기와 상관없어서 PC에서만 본다');

  test('게임과 랭킹 서버가 같은 팀 목록과 주 계산(한국 시간 월요일 시작)을 쓴다', async ({ page }) => {
    const rules = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'rules.js')).href);
    await open(page);
    const days = Array.from({ length: 400 }, (_, i) => rules.addDays('2026-10-01', i));
    const game = await page.evaluate((days) => ({ ids: walkoff.TEAMS.map((t) => t.id), weeks: days.map((d) => walkoff.weekStartOf(d)) }), days);
    expect(game.ids).toEqual(rules.TEAM_IDS);
    expect(game.weeks).toEqual(days.map((d) => rules.weekStart(d)));
  });
});
