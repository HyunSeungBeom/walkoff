// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PAGE = `http://127.0.0.1:${process.env.WALKOFF_PORT || 4173}/index.html`;   // playwright.config.js의 webServer(scripts/serve.js)
const SITE = 'https://hyunseungbeom.github.io/walkoff/';

test.describe('링크 미리보기', () => {
  test.skip(({ isMobile }) => isMobile, '태그와 그림 파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('미리보기 태그가 배포 주소와 그림을 가리키고, 그림은 1200x630 PNG다', async ({ page }) => {
    await page.goto(PAGE);
    const meta = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('meta[property], meta[name]')]
      .map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.getAttribute('content')])));
    // 사람들이 치는 주소(js/infra/site.js HOME, 옛 주소 넘기기를 켜면 새 주소). 옛 주소 페이지도 같은 태그라 카톡이 새 주소 쪽을 읽는다
    const { HOME } = await import(pathToFileURL(path.join(ROOT, 'js', 'infra', 'site.js')).href);
    expect(meta['og:url']).toBe(HOME);
    expect(meta['og:image']).toBe(HOME + 'og.png');
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

test.describe('배포 파일', () => {
  test.skip(({ isMobile }) => isMobile, '파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('게임이 받아 쓰는 파일(미리보기 그림, 관중 함성 녹음)을 배포 단계가 함께 올린다', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
    const crowd = fs.readFileSync(path.join(ROOT, 'js', 'infra', 'sound.js'), 'utf8').match(/CROWD_URL = '([^']+)'/)?.[1] ?? '';   // 소리는 infra/sound.js
    expect(crowd).toBe('crowd.mp3');
    const copied = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').match(/cp (.+) _site\//)?.[1].split(/\s+/);
    for (const f of ['index.html', 'og.png', crowd]) {
      expect(copied, f).toContain(f);   // 빠지면 배포된 게임에서는 녹음 대신 합성 함성이 난다
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    }
    expect(fs.statSync(path.join(ROOT, crowd)).size).toBeLessThan(150_000);   // 폰에서 처음 소리를 켤 때 받는다
    // 게임 모듈(js/)은 커밋 번호 폴더로 올리고 index.html이 그 폴더의 main.js를 읽게 바꾼다(빠지면 배포된 게임이 안 뜬다)
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(html).toContain('<script type="module" src="js/main.js"></script>');
    expect(ci).toContain('cp -r js "_site/js-${GITHUB_SHA::7}"');
    expect(ci).toContain('sed -i "s|\\"js/|\\"js-${GITHUB_SHA::7}/|g" _site/index.html');
    expect(ci).toContain('node scripts/keep-prev.js https://hyunseungbeom.github.io/walkoff/ _site');   // 앞 판 모듈 폴더도 남긴다(배포 직후 10분 동안 옛 index.html을 받은 사람)
    expect(ci).toContain('test -f "_site/$f"');   // index.html이 미리 받는 모듈이 모두 올라갔는지 배포 단계가 본다
    // main.js에서 import를 따라가며: 가져오는 파일이 js/에 있고, index.html이 모두 미리 받는다(main.js를 받은 뒤에야 찾으면 느린 망에서 한 단계마다 늦게 뜬다)
    const mods = [], queue = ['main.js'];
    while (queue.length) {
      const f = /** @type {string} */ (queue.shift());
      if (mods.includes(f)) continue;
      mods.push(f);
      expect(fs.existsSync(path.join(ROOT, 'js', f)), f).toBe(true);
      const src = f === 'main.js' ? main : fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
      for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom '(\.{1,2}\/[^']+)';/gm)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
    }
    expect(mods.length).toBeGreaterThan(5);
    for (const f of mods) expect(html, `${f}을 미리 받는다`).toContain(`<link rel="modulepreload" href="js/${f}">`);
    expect(html.match(/rel="modulepreload"/g)?.length, '안 쓰는 파일은 미리 받지 않는다').toBe(mods.length);
  });

  test('배포 단계가 게임 모듈을 줄여 올린다: 주석이 빠지고 import는 그대로라, 앞 판 남기기(keep-prev)가 줄인 파일에서도 모듈을 모두 따라간다', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/minify.js "_site/js-${GITHUB_SHA::7}"');
    expect(ci).toContain('node scripts/minify.js _min/js');   // 테스트 단계도 똑같이 줄여 @min 테스트를 한 번 더 돌린다
    const { minify } = require('../scripts/minify.js'), { importsOf } = require('../scripts/keep-prev.js');
    const files = fs.readdirSync(path.join(ROOT, 'js'), { recursive: true }).map(String).filter((f) => f.endsWith('.js'));
    let srcBytes = 0, minBytes = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), min = minify(src);
      expect(importsOf(min), f).toEqual(importsOf(src));   // 줄인 파일은 from"./x.js"처럼 큰따옴표에 빈칸이 없다
      expect(min, `${f} 주석이 빠진다`).not.toMatch(/(^|[^:])\/\/ |\/\*/);
      srcBytes += src.length; minBytes += min.length;
    }
    expect(importsOf(fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8')).length).toBeGreaterThan(5);
    expect(minBytes / srcBytes, '절반쯤으로 준다').toBeLessThan(0.6);
  });

  // 오류 자리(2026-11-18 운영 준비): 폰에서 난 오류는 줄인 파일의 줄·칸으로 오니(npm run stats 셋째 표), 같은 설정으로 다시 줄여 소스의 줄을 찾는다
  test('오류 자리 찾기(scripts/where.js): 줄인 파일의 줄·칸(1부터)을 소스의 그 코드 줄로 되돌린다', () => {
    const { minify } = require('../scripts/minify.js'), { whereIn } = require('../scripts/where.js');
    for (const [f, token] of [['infra/stats.js', 'errorsSeen'], ['infra/stats.js', 'matchAll('], ['main.js', 'openAccount'], ['main.js', '이용 통계는 무작위 번호로만']]) {
      const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), min = minify(src), at = min.indexOf(token);
      expect(at, `줄인 ${f}에 ${token}`).toBeGreaterThan(0);
      const before = min.slice(0, at), line = before.split('\n').length, col = at - before.lastIndexOf('\n');   // 브라우저처럼 1부터 센다
      const back = whereIn(src, line, col), text = src.split('\n')[back.line - 1];
      expect([text.includes(token), /^\s*\/\//.test(text)], `${f}:${back.line} ${text}`).toEqual([true, false]);
    }
  });
});

test.describe('버전 표시', { tag: '@min' }, () => {
  test('오른쪽 아래 커밋 번호 위를 눌러도 캔버스가 받아 경기가 시작된다', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {   // 팀을 고르고 오늘은 로그인을 미룬 사람 기준(아니면 팀 고르기나 로그인 권유가 먼저 나온다)
      localStorage.setItem('walkoff.team', 'lg');
      localStorage.setItem('walkoff.loginLater', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10));
    });
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

test.describe('주소 옮기기(2026-11-17)', () => {
  test.skip(({ isMobile }) => isMobile, '파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('게임과 서버가 같은 두 주소를 쓰고, 주소 옮기기 모듈(infra/move.js)이 게임보다 먼저 돈다', async () => {
    const { OLD_SITE, NEW_SITE } = await import(pathToFileURL(path.join(ROOT, 'js', 'infra', 'site.js')).href);
    const { SITES } = await import(pathToFileURL(path.join(ROOT, 'worker', 'src', 'auth.js')).href);
    expect(SITES).toEqual([OLD_SITE, NEW_SITE]);   // 서버가 로그인 뒤 돌려보낼 주소
    expect(OLD_SITE).toBe(SITE);   // 앞 판 모듈을 남길 때(keep-prev) 읽는 옛 주소. 미리보기 태그는 HOME이고, 옛 주소일 때는 새 주소에 올릴 때 CI가 바꾼다
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
    const move = html.indexOf('<script type="module" src="js/infra/move.js"></script>');
    expect(move).toBeGreaterThan(0);
    expect(move).toBeLessThan(html.indexOf('<link rel="modulepreload"'));   // 게임 모듈보다 먼저 받기 시작한다(옛 주소에서 빨리 떠난다)
    expect(main.match(/^import .+ from '(\.\/[^']+)';/m)?.[1]).toBe('./infra/move.js');   // main.js도 맨 처음 가져온다(다른 모듈이 저장소를 읽기 전에)
  });

  // 오류 세기(2026-11-18 운영 준비): 게임 모듈이 아예 못 떠도(문법 오류·파일 못 받음) 오류를 세려고 통계 모듈을 따로 먼저 띄운다
  test('이용 통계·오류 세기 모듈(infra/stats.js)은 move.js 다음, 게임(main.js)보다 먼저 따로 돈다', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), tag = (f) => html.indexOf(`<script type="module" src="js/${f}"></script>`);
    expect(tag('infra/move.js')).toBeGreaterThan(0);
    expect(tag('infra/stats.js')).toBeGreaterThan(tag('infra/move.js'));   // 옛 주소에서 옮겨 온 기록을 넣은 뒤에 저장소를 읽는다
    expect(tag('infra/stats.js')).toBeLessThan(tag('main.js'));
  });

  test('CI가 새 주소(Cloudflare Pages)에도 올린다: 미리보기 태그만 새 주소로 바꾸고, 비밀값이 없으면 건너뛰고, 옛 주소 배포를 기다리지 않는다. 토큰은 따로 잡의 올리는 단계에만 준다', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain(`import('./js/infra/site.js')`);   // 주소는 게임과 같은 곳에서 읽는다
    expect(ci).toContain('cp -r _site _cf');   // 테스트를 거친 같은 파일(앞 판 모듈 폴더 포함)
    expect(ci).toContain('sed -i "s|content=\\"${OLD}|content=\\"${NEW}|g" _cf/index.html');
    expect(ci).toContain('grep -q "<meta property=\\"og:url\\" content=\\"${NEW}\\">" _cf/index.html');
    // 새 주소 머리글: 모든 경로에 HSTS(walkoff.kr은 DNS only라 zone 설정이 안 걸린다, 2026-11-20 사용자), 모듈 폴더만 1년 캐시(2026-11-19 사용자, 커밋마다 새 폴더라 바뀌지 않는다).
    // index.html은 Pages 기본(매번 확인)이라 캐시 규칙에 없다. 옛 주소(GitHub Pages)는 이 파일을 안 읽어서 넣지 않는다
    expect(ci).toContain(`printf '%s\\n' '/*' '  Strict-Transport-Security: max-age=15552000; includeSubDomains' '/js-*' '  Cache-Control: public, max-age=31536000, immutable' > _cf/_headers`);
    expect(ci).not.toContain('_site/_headers');
    expect(ci).toContain('worker/node_modules/.bin/wrangler pages deploy _cf --project-name walkoff --branch main');
    expect(ci).toMatch(/if \[ -z "\$CLOUDFLARE_API_TOKEN" \] \|\| \[ -z "\$CLOUDFLARE_ACCOUNT_ID" \]; then [^\n]*exit 0; fi/);
    expect(ci).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');   // 토큰은 레포 비밀값으로만
    // 2026-11-18 보안 검토: 새 주소는 따로 잡에서 올리고, 그 잡에는 옛 주소 배포 권한(id-token)이 없다.
    // 2026-11-24부터 옛 주소 배포를 기다리지 않고 만드는 잡(build)만 기다린다(옛 주소 배포가 실패해도 walkoff.kr은 올라간다)
    const cf = ci.slice(ci.indexOf('\n  deploy-cf:'));
    expect(cf).toContain('\n    needs: build\n');
    expect(cf).not.toContain('id-token');
    // 비밀값은 올리는 단계 하나에만 주고, 그 단계는 설치하지 않는다(wrangler는 앞 단계에서 비밀값 없이 받는다)
    expect(ci.match(/secrets\.CLOUDFLARE_\w+/g)).toEqual(['secrets.CLOUDFLARE_API_TOKEN', 'secrets.CLOUDFLARE_ACCOUNT_ID']);
    const at = cf.indexOf('secrets.CLOUDFLARE_API_TOKEN'), end = cf.indexOf('\n      - ', at);
    const step = cf.slice(cf.lastIndexOf('\n      - ', at), end < 0 ? undefined : end);
    expect(step).toContain('wrangler pages deploy _cf');
    expect(step).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(cf.indexOf('npm ci --prefix worker')).toBeGreaterThan(0);
    expect(cf.indexOf('npm ci --prefix worker')).toBeLessThan(at);
  });

  // 2026-11-24 옛 주소 배포가 'No artifacts named github-pages'(올린 묶음이 목록에 늦게 보이는 GitHub 쪽 오류, actions/deploy-pages#451)로 자주 실패했고,
  // 올리기와 배포를 한 잡에서 해서 그 잡을 다시 돌리면 묶음이 하나 더 올라가 'Multiple artifacts'로 또 막혔다. 그래서 묶음은 만드는 잡(build)만 올린다
  test('옛 주소(GitHub Pages)는 만드는 잡이 올린 묶음을 따로 잡에서 배포만 한다: 배포 잡을 다시 돌려도 묶음이 늘지 않고, 배포 권한이 있는 잡은 코드를 받거나 설치하지 않는다', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').split('\n');
    // 잡 하나의 줄(주석은 뺀다). 잡은 두 칸 들여 쓴 '이름:' 줄로 시작한다
    const job = (name) => {
      const at = lines.indexOf(`  ${name}:`), end = lines.findIndex((l, i) => i > at && /^ {2}[\w-]+:$/.test(l));
      expect(at, name).toBeGreaterThan(0);
      return lines.slice(at, end < 0 ? undefined : end).filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');
    };
    const build = job('build'), pages = job('deploy'), cf = job('deploy-cf');
    expect(build).toContain('\n    needs: test\n');
    expect(build).not.toMatch(/id-token|pages: write/);   // npm ci로 남의 코드가 도는 잡이라 배포 권한이 없다
    for (const up of ['actions/upload-artifact@', 'actions/upload-pages-artifact@']) {
      expect(build, up).toContain(up);
      expect(pages, up).not.toContain(up);   // 배포 잡만 다시 돌려도 같은 이름 묶음이 하나 더 생기지 않는다
      expect(cf, up).not.toContain(up);
    }
    expect(pages).toContain('\n    needs: build\n');
    expect(pages).toContain('id-token: write');
    expect(pages).toContain('uses: actions/deploy-pages@');
    expect(pages).not.toMatch(/actions\/checkout|\bnpm\b|\bnpx\b/);
    expect(pages).toContain("if: steps.deployment.outcome == 'failure'");   // 첫 배포가 실패하면 한 번 더 한다
  });
});

// 상태 알림(2026-11-18 운영 준비, .github/workflows/health.yml·scripts/health.js): 15분마다 게임 주소와 서버를 열어 보고, 죽었으면 잡이 실패해 메일이 간다.
// 2026-11-20부터는 두 번째 감시이고 첫째는 Cloudflare Worker(worker/health, 시험은 worker/health/test). 판정은 둘이 worker/health/src/checks.js를 같이 쓴다
test.describe('상태 알림(2026-11-18)', () => {
  test.skip(({ isMobile }) => isMobile, '파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('15분마다 정각을 피해 돌고, 게임 index.html에 적힌 모듈을 모두 본다. 손으로 넣는 주소는 환경 변수로만 넘긴다', async () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'health.yml'), 'utf8');
    expect(yml).toContain("- cron: '7,22,37,52 * * * *'");   // 매시 정각은 붐벼서 늦거나 빠진다
    expect(yml).toMatch(/permissions:\n  contents: read\n/);
    expect(yml).toContain('EXTRA_URL: ${{ inputs.extra_url }}');
    expect(yml).not.toMatch(/run:[^\n]*\$\{\{/);   // 넣은 값을 명령 줄에 바로 쓰지 않는다(명령 끼워 넣기)
    const { gameFiles } = await import(pathToFileURL(path.join(ROOT, 'worker', 'health', 'src', 'checks.js')).href);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const listed = [...html.matchAll(/<script type="module" src="([^"]+)"|<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(gameFiles(html).sort()).toEqual([...new Set(listed)].sort());
    expect(gameFiles(html)).toEqual(expect.arrayContaining(['js/main.js', 'js/infra/move.js', 'js/infra/stats.js']));
  });
});

// 개인정보 처리방침(2026-11-18 사용자): 게임과 같은 곳의 privacy.html. 받는 값·두는 기간·서버 로그가 바뀌면 이 페이지와 게임 안내(js/main.js PRIVACY)를 같이 고친다
test.describe('개인정보 처리방침(2026-11-18)', () => {
  test.skip(({ isMobile }) => isMobile, '파일은 화면 크기와 상관없어서 PC에서만 본다');

  test('privacy.html을 게임과 같이 올리고(_min에도), 빈칸 없이 시행일이 있으며 바깥 파일을 읽지 않는다', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    for (const dir of ['_site', '_min']) expect(ci.match(new RegExp(`cp (.+?) ${dir}/`))?.[1].split(/\s+/), dir).toContain('privacy.html');
    const page = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
    expect(page).not.toMatch(/\[\[|곧 들어감/);   // 초안의 빈칸·표시
    const day = page.match(/<p class="date">시행일: (\d{4}-\d{2}-\d{2})<\/p>/)?.[1];
    expect(page).toContain(`이 방침은 ${day}부터 적용합니다.`);
    expect(page.match(/<(?:script|link|img|iframe|object|embed)\b[^>]*>/g)).toEqual([expect.stringMatching(/^<link rel="icon" href="data:image\/svg\+xml,/)]);   // 15절 '외부 글꼴이나 외부 스크립트를 쓰지 않습니다'
    expect(fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8')).toContain("const PRIVACY_URL = 'privacy.html';");
  });

  test("서버 로그는 오류만(2026-11-19 사용자): 서버가 찍는 줄은 오류(console.error(e))와 점수 검사에서 걸린 판(score_mismatch) 둘뿐이고 요청마다 남는 기록은 끈다. 바꾸면 처리방침 3·11절도 고친다", () => {
    const src = path.join(ROOT, 'worker', 'src');
    const calls = fs.readdirSync(src).filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(path.join(src, f), 'utf8').matchAll(/console\.(\w+)\((.{0,60})/g)]
      .map((m) => `${f} ${m[1]} ${m[2].startsWith('e)') ? 'e' : m[2].includes("event: 'score_mismatch'") ? 'score_mismatch' : m[2]}`));
    expect([...new Set(calls)].sort()).toEqual(['index.js error e', 'index.js log score_mismatch']);
    expect(fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8')).toContain('[observability]\nenabled = true\nredact_query_string = true\n\n[observability.logs]\ninvocation_logs = false\n');
    const page = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
    expect(page).toContain('<td data-label="정보">서버 로그(서버 오류, 점수가 다르게 온 판)</td><td data-label="두는 기간">3일</td>');
    expect(page).toContain('서버 로그(Cloudflare Workers Logs)에는 두 가지만 남깁니다.');
  });
});
