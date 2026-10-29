// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 게임은 이 컴퓨터의 작은 정적 서버(scripts/serve.js, http://127.0.0.1:4173)로 연다. 예전에는 index.html을 file://로 바로 열었는데,
// 크롬이 file:// 페이지를 옮길 때 저장소(localStorage)를 통째로 못 볼 때가 있어서 바꿨다(2026-10-29, 부하가 큰 CI에서 로그인 테스트가 실패)
// 다른 작업 폴더에서 동시에 테스트를 돌릴 때는 WALKOFF_PORT로 포트를 바꾼다. 로컬에서는 이미 떠 있는 서버를 그대로 쓰므로,
// 같은 포트를 쓰면 다른 폴더의 게임을 테스트하게 된다(2026-10-29, 두 세션이 함께 작업하다 겪음)
const PORT = Number(process.env.WALKOFF_PORT) || 4173;
module.exports = defineConfig({
  testDir: './tests',
  workers: 2,
  timeout: 120_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: { command: `node scripts/serve.js ${PORT}`, url: `http://127.0.0.1:${PORT}/index.html`, reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'pc', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mo', use: { ...devices['Pixel 7'] } },
  ],
});
