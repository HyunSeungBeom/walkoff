// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// index.html을 파일로 바로 열어서 확인한다. 서버는 필요 없다
module.exports = defineConfig({
  testDir: './tests',
  workers: 2,
  timeout: 120_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'pc', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mo', use: { ...devices['Pixel 7'] } },
  ],
});
