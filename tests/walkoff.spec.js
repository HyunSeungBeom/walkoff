// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

async function open(page, query = '?seed=42') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + query);
  await page.waitForFunction(() => !!window.walkoff);
  return errors;
}

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
    const errors = await open(page, '');
    await page.keyboard.press('Space');   // 오늘 아직 안 쳤으면 오늘의 10구로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('daily');
    await playUntilOver(page, 0);
    const saved = await page.evaluate(() => walkoff.store.get('daily.' + walkoff.today(), null));
    expect(saved && saved.score).toBe(await page.evaluate(() => walkoff.game.score));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');   // 오늘 친 뒤에는 10구 도전으로 시작
    expect(await page.evaluate(() => walkoff.game.mode)).toBe('challenge');
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
    for (const want of [/^끝내기 상황$/, /^연습$/, /^타이밍 보정/, /^기록$/, /^닫기$/]) {
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
