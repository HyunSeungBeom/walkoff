// @ts-check
// 층 검사(2026-11-03 코드 나누기). 게임 모듈(js/)이 정한 방향으로만 서로 가져오는지 본다. 어기면 1로 끝나서 CI가 배포를 멈춘다.
//  층: core(규칙) ← sim(장면 일정) ← game(판 진행) ← view(그리기), infra(바깥 연결) ← core, main.js → 모두.
//      아래 층으로 건너뛰어 가져오는 것은 되고, 위 층에서 가져오기와 파일끼리 빙 도는 것은 안 된다. game은 infra를 가져오지 않는다.
//  core·sim·game에는 화면·저장소·시간·무작위(window, document, localStorage, navigator, performance, Date, Math.random 등)가 없다(sim·game은 포트로 받는다).
//  core는 랭킹 서버(wrangler)와 node도 읽어서 같은 폴더의 './x.js'처럼 확장자까지 쓴 경로만 가져온다.
//  view는 판 상태(game·settings)에 값을 넣지 않는다(바꾸는 것은 game 함수로).
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'js');
const ALLOW = { core: ['core'], sim: ['core', 'sim'], game: ['core', 'sim', 'game'], view: ['core', 'sim', 'game', 'view'], infra: ['core', 'infra'] };
const PURE = ['core', 'sim', 'game'];
const BANNED = /\b(window|document|localStorage|sessionStorage|navigator|performance|globalThis|requestAnimationFrame|setTimeout|setInterval|fetch|Date)\b|\bMath\.random\b/;

// 주석과 글자를 빈칸으로 바꾼 코드(줄 수는 그대로, 템플릿 글자 안 ${…}는 코드로 남긴다)
function codeOnly(src) {
  let out = '', i = 0, mode = 'code';
  const depth = [];
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); out += src.slice(i, e + 2).replace(/[^\n]/g, ' '); i = e + 2; continue; }
      if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; out += ' '; continue; }
      if (c === '`') { mode = 'tpl'; i++; out += ' '; continue; }
      if (c === '{' && depth.length) depth[depth.length - 1]++;
      if (c === '}' && depth.length) { if (depth[depth.length - 1] === 0) { depth.pop(); mode = 'tpl'; i++; out += ' '; continue; } depth[depth.length - 1]--; }
      out += c; i++; continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { mode = 'code'; i++; out += ' '; continue; }
    if (c === '$' && n === '{') { depth.push(0); mode = 'code'; i += 2; out += ' '; continue; }
    if (c === '\n') out += '\n';
    i++;
  }
  return out;
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(path.relative(JS, p).split(path.sep).join('/'));
  }
})(JS);

const errors = [], graph = {};
const layerOf = (f) => (f === 'main.js' ? 'main' : f.split('/')[0]);
for (const f of files) {
  const layer = layerOf(f), src = fs.readFileSync(path.join(JS, f), 'utf8'), code = codeOnly(src), lines = src.split('\n');
  const at = (index) => src.slice(0, index).split('\n').length;
  if (layer !== 'main' && !ALLOW[layer]) { errors.push(`${f}: 정해진 층 폴더(${Object.keys(ALLOW).join('·')}) 밖에 있다`); continue; }
  graph[f] = [];
  for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|^import\s+'([^']+)'/gm)) {
    const spec = m[1] ?? m[2], line = at(m.index);
    if (!/^\.{1,2}\/.+\.js$/.test(spec)) { errors.push(`${f}:${line} '${spec}': 확장자까지 쓴 상대 경로로 가져온다`); continue; }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
    if (!files.includes(target)) { errors.push(`${f}:${line} '${spec}': 없는 파일`); continue; }
    graph[f].push(target);
    const to = layerOf(target);
    if (to === 'main') errors.push(`${f}:${line}: main.js는 아무도 가져오지 않는다`);
    else if (layer !== 'main' && !ALLOW[layer].includes(to)) errors.push(`${f}:${line}: ${layer}는 ${to}를 가져오지 않는다(위 층이거나 game → infra)`);
    if (layer === 'core' && !/^\.\/[\w-]+\.js$/.test(spec)) errors.push(`${f}:${line} '${spec}': core는 같은 폴더의 './x.js'만 가져온다(서버와 같이 쓴다)`);
  }
  if (/\bimport\s*\(/.test(code) && layer !== 'main') errors.push(`${f}: 동적 import는 쓰지 않는다`);
  if (PURE.includes(layer)) {
    codeOnly(src).split('\n').forEach((l, i) => { const m = l.match(BANNED); if (m) errors.push(`${f}:${i + 1}: ${layer}에는 화면·저장소·시간·무작위가 없다(${m[0]}): ${lines[i].trim().slice(0, 100)}`); });
  }
  if (layer === 'view') {
    code.split('\n').forEach((l, i) => {
      if (/\b(game|settings)(\.[\w$]+|\[[^\]]+\])+\s*(=(?![=>])|\+=|-=|\*=|\/=|\+\+|--)|\bObject\.assign\(\s*(game|settings)\b|\bdelete\s+(game|settings)\./.test(l)) errors.push(`${f}:${i + 1}: view는 판 상태(game·settings)에 값을 넣지 않는다: ${lines[i].trim().slice(0, 100)}`);
    });
  }
}
// 빙 도는 import
const done = new Set(), stack = [];
function visit(f) {
  if (stack.includes(f)) { errors.push(`빙 도는 import: ${[...stack.slice(stack.indexOf(f)), f].join(' → ')}`); return; }
  if (done.has(f)) return;
  stack.push(f);
  for (const d of graph[f] ?? []) visit(d);
  stack.pop();
  done.add(f);
}
Object.keys(graph).forEach(visit);

if (errors.length) {
  console.error(`층 검사 실패 ${errors.length}건\n` + errors.map((e) => `  ${e}`).join('\n'));
  process.exit(1);
}
const count = (l) => files.filter((f) => layerOf(f) === l).length;
console.log(`층 검사 통과: 모듈 ${files.length}개(${['core', 'sim', 'game', 'view', 'infra'].filter(count).map((l) => `${l} ${count(l)}`).join(', ')}, main 1)`);
