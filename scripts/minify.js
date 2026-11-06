// @ts-check
// 배포할 게임 모듈(js/)을 줄인다(2026-11-06 사용자 결정): 주석·빈칸을 빼고 안쪽 이름을 짧게 바꿔 받는 크기가 절반쯤이 된다(폰에서 빨리 뜬다).
// 파일은 하나하나 그대로 두고 import 경로도 그대로라 index.html의 modulepreload와 scripts/keep-prev.js가 그대로 맞는다.
// 문법은 소스가 이미 쓰는 ES2021(??=·60_000)까지로 두어 더 새 문법이 끼지 않는다. 소스맵은 올리지 않는다(레포 원본에는 주석이 그대로 있다).
// 사용: node scripts/minify.js <폴더>   그 아래 .js를 모두 제자리에서 줄인다
const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const minify = (src) => transformSync(src, { loader: 'js', format: 'esm', target: 'es2021', minify: true, legalComments: 'none', charset: 'utf8' }).code;
module.exports = { minify };

if (require.main === module) {
  const [dir] = process.argv.slice(2);
  if (!dir || !fs.existsSync(path.join(dir, 'main.js'))) { console.error('사용: node scripts/minify.js <main.js가 있는 폴더>'); process.exit(1); }
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.js'));
  let from = 0, to = 0;
  for (const f of files) {
    const file = path.join(dir, f), src = fs.readFileSync(file, 'utf8'), code = minify(src);
    fs.writeFileSync(file, code);
    from += Buffer.byteLength(src); to += Buffer.byteLength(code);
  }
  console.log(`js ${files.length}개를 줄임: ${Math.round(from / 1024)} → ${Math.round(to / 1024)} KiB`);
}
