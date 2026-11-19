// @ts-check
// 오류 자리(npm run stats 셋째 표의 판·자리)를 소스의 줄로 바꾼다(2026-11-18 운영 준비): node scripts/where.js 86f966f main.js 1 48213
// 배포한 js는 scripts/minify.js로 줄여 거의 한 줄이라, 그 판의 소스(git show 커밋:js/파일)를 같은 설정에 소스맵만 더해 다시 줄여서 찾는다.
// 판이 local(이 컴퓨터에서 연 게임)이면 줄이지 않은 지금 파일의 그 줄을 보인다. 그 판 뒤에 minify.js 설정이 바뀌었으면 자리가 어긋날 수 있다
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SourceMap } = require('module');
const { transformSync } = require('esbuild');
const { minify, OPTIONS } = require('./minify.js');

// 줄인 파일의 자리(1부터 센 줄·칸, 브라우저가 알려 주는 값)를 소스의 자리로. 못 찾으면 null
function whereIn(src, line, col) {
  const out = transformSync(src, { ...OPTIONS, sourcemap: 'external', sourcefile: 'src.js' });
  if (out.code !== minify(src)) throw new Error('소스맵을 만들며 줄인 결과가 배포한 것과 다르다');
  const hit = new SourceMap(JSON.parse(out.map)).findEntry(line - 1, col - 1);
  return hit && 'originalLine' in hit ? { line: hit.originalLine + 1, col: hit.originalColumn + 1 } : null;
}
module.exports = { whereIn };

if (require.main === module) {
  const [build = '', src = '', line, col] = process.argv.slice(2);
  if (!/^(?:[0-9a-f]{7}|local)$/.test(build) || !/^(?:[a-z]+\/)?[a-z0-9-]+\.js$/.test(src) || !(Number(line) >= 1) || !(Number(col) >= 1)) {
    console.error('사용: node scripts/where.js <판(커밋 7자리|local)> <파일(main.js, infra/stats.js …)> <줄> <칸>');
    process.exit(1);
  }
  const file = `js/${src}`;
  const source = build === 'local' ? fs.readFileSync(path.join(__dirname, '..', file), 'utf8') : execFileSync('git', ['show', `${build}:${file}`], { encoding: 'utf8' });
  const at = build === 'local' ? { line: Number(line), col: Number(col) } : whereIn(source, Number(line), Number(col));
  if (!at) { console.error('그 자리를 소스에서 찾지 못했다'); process.exit(1); }
  console.log(`${file}:${at.line}:${at.col} (판 ${build})`);
  console.log((source.split('\n')[at.line - 1] ?? '').trim().slice(0, 200));
}
