// @ts-check
// 시작 화면을 찍어 링크 미리보기 그림(og.png, 1200x630)을 만든다. 시작 화면이 바뀌면 다시 돌린다: npm run og
const { chromium } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.waitForFunction(() => !!window.walkoff);
  await page.evaluate(() => walkoff.goTitle());   // 처음 온 사람은 팀 고르기부터 나오지만, 그림은 팀을 안 고른 기본 색의 시작 화면으로 찍는다
  await page.addStyleTag({ content: '#build { display: none; }' });   // 커밋 번호 표시는 그림에 넣지 않는다
  await page.waitForTimeout(1500);   // 시작 화면 글자가 다 나타날 때까지
  await page.screenshot({ path: path.join(ROOT, 'og.png') });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
