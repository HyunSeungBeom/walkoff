// @ts-check
// 테스트용 정적 서버. 게임을 file://로 열면 크롬이 페이지를 옮길 때 저장소(localStorage)를 통째로 못 볼 때가 있어서(2026-10-29 CI),
// 실제 배포처럼 http로 연다. 이 컴퓨터(127.0.0.1)에서만 열린다: node scripts/serve.js [포트]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url || '/', 'http://x').pathname));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }   // 레포 밖은 주지 않는다
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`walkoff test server http://127.0.0.1:${PORT}/index.html`));
