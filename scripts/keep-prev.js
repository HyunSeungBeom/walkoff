// @ts-check
// 배포 직전에 돌린다: 지금 배포된 판의 게임 모듈 폴더(js-커밋7자리)를 새 배포에도 남긴다. Pages는 index.html을 10분 캐시해서,
// 배포 직후 10분 동안 옛 index.html을 받은 사람이 옛 폴더를 찾다가 게임이 안 뜨는 일을 막는다(2026-11-03 코드 나누기).
// 이미 열려 있는 탭은 모듈을 다 받아 둬서 상관없다. 옛 판이 한 파일(모듈 없음)이면 할 일이 없다.
// 사용: node scripts/keep-prev.js <배포된 주소(끝에 /)> <배포할 폴더>
const fs = require('fs');
const path = require('path');

const [site = 'https://hyunseungbeom.github.io/walkoff/', out = '_site'] = process.argv.slice(2);
// 모듈 하나가 가져오는 다른 모듈(상대 경로). 줄여 올린 판(scripts/minify.js)은 from"./x.js"처럼 큰따옴표에 빈칸이 없다
const importsOf = (src) => [...src.matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
module.exports = { importsOf };

if (require.main === module) (async () => {
  const html = await (await fetch(`${site}index.html?nocache=${Date.now()}`)).text();
  const dir = html.match(/src="(js-[0-9a-f]{7})\/main\.js"/)?.[1];
  if (!dir) { console.log('앞 판은 모듈 폴더가 없다(한 파일). 남길 것 없음'); return; }
  if (fs.existsSync(path.join(out, dir))) { console.log(`${dir}는 이번 배포와 같은 판이다`); return; }
  // main.js에서 시작해 import를 따라가며 받는다(모듈은 모두 정적 import)
  const seen = new Set(), queue = ['main.js'];
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    const res = await fetch(`${site}${dir}/${file}`);
    if (!res.ok) throw new Error(`${dir}/${file} ${res.status}`);
    const src = await res.text();
    fs.mkdirSync(path.join(out, dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(out, dir, file), src);
    for (const m of importsOf(src)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m)));
  }
  console.log(`앞 판 ${dir}의 모듈 ${seen.size}개를 남김`);
})().catch((e) => {
  // 못 받아도 배포는 한다. 배포 직후 10분 동안 옛 화면을 받은 사람은 새로고침해야 할 수 있다
  console.warn(`::warning::앞 판 모듈을 못 남겼다: ${e.message}`);
});
