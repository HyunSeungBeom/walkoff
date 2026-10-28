// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const SITE = 'https://hyunseungbeom.github.io/walkoff/';

test.describe('링크 미리보기', () => {
  test.skip(({ isMobile }) => isMobile, '태그와 그림 파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('미리보기 태그가 배포 주소와 그림을 가리키고, 그림은 1200x630 PNG다', async ({ page }) => {
    await page.goto(PAGE);
    const meta = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('meta[property], meta[name]')]
      .map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.getAttribute('content')])));
    expect(meta['og:url']).toBe(SITE);
    expect(meta['og:image']).toBe(SITE + 'og.png');
    expect([meta['og:image:width'], meta['og:image:height']]).toEqual(['1200', '630']);
    expect(meta['twitter:card']).toBe('summary_large_image');
    for (const key of ['og:title', 'og:description', 'description']) expect(meta[key], key).toBeTruthy();

    const png = fs.readFileSync(path.join(ROOT, 'og.png'));   // 배포 단계가 이 파일을 함께 올린다
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);   // PNG 머리에 적힌 가로·세로
  });

  test('파비콘은 페이지 안에 들어 있어 따로 받지 않는다', async ({ page }) => {
    await page.goto(PAGE);
    expect(await page.getAttribute('link[rel="icon"]', 'href')).toMatch(/^data:image\/svg\+xml,/);
  });
});

test.describe('버전 표시', () => {
  test('오른쪽 아래 커밋 번호 위를 눌러도 캔버스가 받아 경기가 시작된다', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('walkoff.team', 'lg'));   // 팀을 고른 사람 기준(처음 온 사람은 팀 고르기부터 나온다)
    await page.goto(PAGE + '?seed=42');
    await page.waitForFunction(() => !!window.walkoff);
    const label = page.locator('#build');
    await expect(label).toHaveText('local');   // 배포할 때 커밋 번호로 바뀐다(.github/workflows/ci.yml)
    const box = await label.boundingBox();
    if (!box) throw new Error('커밋 번호 표시가 화면에 없다');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await page.evaluate(() => walkoff.game.state)).toBe('windup');
    expect(errors).toEqual([]);
  });
});
