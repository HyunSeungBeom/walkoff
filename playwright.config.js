// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 게임은 이 컴퓨터의 작은 정적 서버(scripts/serve.js, http://127.0.0.1:4173)로 연다. 예전에는 index.html을 file://로 바로 열었는데,
// 크롬이 file:// 페이지를 옮길 때 저장소(localStorage)를 통째로 못 볼 때가 있어서 바꿨다(2026-10-29, 부하가 큰 CI에서 로그인 테스트가 실패)
module.exports = defineConfig({
  testDir: './tests',
  workers: 2,
  timeout: 120_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.js 4173', url: 'http://127.0.0.1:4173/index.html', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'pc', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mo', use: { ...devices['Pixel 7'] } },
  ],
});
