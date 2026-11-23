import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attempt, checkApi, checkGame, gameFiles, opener } from '../src/checks.js';
import { API, FROM, NEW_SITE, OLD_SITE, REMIND_MS, RETRY_MS, round, targets } from '../src/watch.js';
import { encodeHeader, hideMail, rawMail } from '../src/mail.js';
import server from '../../src/index.js';
import { memoryD1 } from '../../test/d1.js';
import * as site from '../../../js/infra/site.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = 'a036a4c';
// 배포된 index.html: CI(ci.yml)가 커밋 번호를 넣고 모듈 폴더를 js-커밋7자리로 바꾼 것과 같게 만든다
const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const deployed = source.replace('<div id="build">local</div>', `<div id="build">${BUILD}</div>`).replaceAll('"js/', `"js-${BUILD}/`);
// 서버의 진짜 /rankings 답(빈 DB). 서버가 답 모양을 바꾸면 이 시험이 먼저 안다
const rankings = async () => server.fetch(new Request('https://api.test/rankings'), { DB: memoryD1() });

const page = (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
const status = (n) => new Response(n === 200 ? null : 'x', { status: n });
// 가짜 바깥: 주소마다 (method) => Response | Error. 없는 주소는 404. 연 주소를 'GET 주소'로 적어 둔다
function fakeWeb(routes) {
  const seen = [];
  const get = opener(async (url, init) => {
    seen.push(`${init.method} ${url}`);
    const r = routes[url] ? await routes[url](init.method) : status(404);
    if (r instanceof Error) throw r;
    return r;
  });
  return { get, seen };
}
const healthy = () => ({
  [NEW_SITE]: () => page(deployed),
  [`${NEW_SITE}js-${BUILD}/main.js`]: () => status(200),
  [OLD_SITE]: () => page(deployed),
  [`${OLD_SITE}js-${BUILD}/main.js`]: () => status(200),
  [`${API}/rankings`]: rankings,
});
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const offline = () => new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });

// 한 바퀴를 가짜 시계·기다리기·메일로 돌린다. 기다린 시간만큼 시계가 간다
function harness(routes) {
  const web = fakeWeb(routes), mails = [], waits = [];
  let t = Date.parse('2026-11-23T00:05:00Z'), fail = null;
  const run = async (prev, { test = false } = {}) => round({
    get: web.get, prev, test, now: () => t,
    sleep: async (ms) => { waits.push(ms); },
    send: async (m) => { if (fail) throw fail; mails.push(m); },
  });
  return { web, mails, waits, run, tick: (ms) => { t += ms; }, failSend: (e) => { fail = e; } };
}

test('판정: 배포된 index.html(커밋 번호, js-커밋 폴더)이 200이고 main.js를 받으면 정상이다. Worker는 main.js 하나만 HEAD로 본다', async () => {
  const all = gameFiles(deployed);
  assert.ok(all.length >= 30 && all.every((f) => f.startsWith(`js-${BUILD}/`)));
  const one = fakeWeb(healthy());
  assert.equal(await checkGame(one.get, NEW_SITE, { mainOnly: true }), `판 ${BUILD}, 모듈 1개`);
  assert.deepEqual(one.seen, [`GET ${NEW_SITE}`, `HEAD ${NEW_SITE}js-${BUILD}/main.js`]);
  const routes = { [OLD_SITE]: () => page(deployed), ...Object.fromEntries(all.map((f) => [`${OLD_SITE}${f}`, () => status(200)])) };
  const every = fakeWeb(routes);
  assert.equal(await checkGame(every.get, OLD_SITE), `판 ${BUILD}, 모듈 ${all.length}개`);   // health.js(GitHub)는 모듈을 모두 본다
  assert.equal(every.seen.filter((s) => s.startsWith('HEAD ')).length, all.length);
  assert.equal(await checkApi(fakeWeb(healthy()).get, API), `이번 주 ${(await (await rankings()).json()).week}`);
});

test('판정: 막혀야 할 것 — index.html 500, 커밋 번호 없음(local 그대로), main.js가 index.html에 없음, main.js 404, /rankings 500·429·모양 다름·JSON 아님', async () => {
  const bad = async (routes, run, re) => assert.rejects(run(fakeWeb({ ...healthy(), ...routes }).get), re);
  await bad({ [NEW_SITE]: () => status(500) }, (get) => checkGame(get, NEW_SITE, { mainOnly: true }), /^Error: index\.html 500$/);
  await bad({ [NEW_SITE]: () => page(source) }, (get) => checkGame(get, NEW_SITE, { mainOnly: true }), /커밋 번호가 없다/);
  await bad({ [NEW_SITE]: () => page(deployed.replace(/<script type="module" src="[^"]*main\.js"><\/script>/, '').replace(/<link rel="modulepreload" href="[^"]*\/main\.js">/g, '')) }, (get) => checkGame(get, NEW_SITE, { mainOnly: true }), /main\.js\)이 index\.html에 없다/);
  await bad({ [`${NEW_SITE}js-${BUILD}/main.js`]: () => status(404) }, (get) => checkGame(get, NEW_SITE, { mainOnly: true }), new RegExp(`모듈을 못 받는다: js-${BUILD}/main\\.js 404`));
  await bad({ [`${API}/rankings`]: () => status(500) }, (get) => checkApi(get, API), /^Error: \/rankings 500$/);
  const limited = await server.fetch(new Request('https://api.test/rankings'), { DB: memoryD1(), RANKINGS_LIMIT: { limit: async () => ({ success: false }) } });
  await bad({ [`${API}/rankings`]: () => limited }, (get) => checkApi(get, API), /^Error: \/rankings 429$/);   // 서버의 횟수 제한에 걸려도 실패로 본다
  await bad({ [`${API}/rankings`]: () => new Response('{"ok":false}', { status: 200 }) }, (get) => checkApi(get, API), /답의 모양이 다르다/);
  await bad({ [`${API}/rankings`]: () => page('<html>점검 중</html>') }, (get) => checkApi(get, API), SyntaxError);
});

test('여는 법: GET·HEAD를 20초 시간 제한·캐시 없음 머리글로 연다. 시간 초과·망 오류는 까닭 한 줄로', async () => {
  const calls = [];
  const get = opener(async (url, init) => { calls.push({ url, ...init }); return status(200); });
  await get(NEW_SITE);
  await get(`${NEW_SITE}x.js`, 'HEAD');
  assert.deepEqual(calls.map((c) => [c.method, c.headers['cache-control'], c.signal instanceof AbortSignal]), [['GET', 'no-cache', true], ['HEAD', 'no-cache', true]]);
  assert.deepEqual(await attempt(async () => { throw timeout(); }, { wait: 1, retry: false }), { ok: false, note: '20초 안에 답이 없다' });
  assert.deepEqual(await attempt(async () => { throw offline(); }, { wait: 1, retry: false }), { ok: false, note: 'ENOTFOUND' });
});

test('다시 보기: 한 번 실패하면 25초 뒤 한 번 더 보고, 그때 되면 정상(앞 까닭을 남긴다), 또 실패면 실패. retry가 거짓이면 기다리지 않는다', async () => {
  const waits = [], sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  assert.deepEqual(await attempt(async () => { if (n++ === 0) throw offline(); return '판 a036a4c, 모듈 1개'; }, { wait: RETRY_MS, sleep }), { ok: true, note: '판 a036a4c, 모듈 1개 (한 번 더 봐서 됨: ENOTFOUND)' });
  assert.deepEqual(await attempt(async () => { throw new Error('/rankings 500'); }, { wait: RETRY_MS, sleep }), { ok: false, note: '/rankings 500' });
  assert.deepEqual(await attempt(async () => { throw new Error('index.html 522'); }, { wait: RETRY_MS, retry: false, sleep }), { ok: false, note: 'index.html 522' });
  assert.deepEqual(waits, [RETRY_MS, RETRY_MS]);
  assert.equal(RETRY_MS, 25_000);
});

test('한 바퀴: 모두 정상이면 메일 없이 처음 한 번만 KV에 쓰고, 그다음 바퀴는 쓰지 않는다. 바깥 요청은 다섯 번이다', async () => {
  const h = harness(healthy());
  const first = await h.run({});
  assert.deepEqual([first.changed, h.mails.length, first.sent, h.waits], [true, 0, [], []]);
  assert.deepEqual(first.next, { new: { ok: true }, old: { ok: true }, api: { ok: true }, test: { ok: true } });
  assert.equal(h.web.seen.length, 5);
  const second = await h.run(JSON.parse(JSON.stringify(first.next)));   // KV를 거친 모양
  assert.equal(second.changed, false);
});

test('한 바퀴: 실패해도 바깥 요청이 무료 Worker 상한(한 번에 50번) 안이다(모든 곳이 다시 보기까지 해도)', async () => {
  const h = harness({ ...healthy(), [`${NEW_SITE}js-${BUILD}/main.js`]: () => status(404), [`${OLD_SITE}js-${BUILD}/main.js`]: () => status(404), [`${API}/rankings`]: () => status(500) });
  const r = await h.run({});
  assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => x.key), ['new', 'old', 'api']);
  assert.ok(h.web.seen.length <= 50, `${h.web.seen.length}번`);
  assert.equal(h.web.seen.length, 10);
});

test('한 바퀴: 서버가 다시 봐도 500이면 장애 메일 한 통. 1시간 안에는 더 안 보내고 KV도 안 쓰며, 1시간이 지나면 아직 장애, 되살아나면 복구 메일', async () => {
  let down = true, n = 0;
  const h = harness({ ...healthy(), [`${API}/rankings`]: () => (down ? status(n++ < 2 ? 500 : 500 + (n % 3)) : rankings()) });   // 장애 중에 까닭(500·501·502)이 바뀌어도
  const a = await h.run({});
  assert.deepEqual(a.sent, ['장애 서버']);
  assert.match(h.mails[0].subject, /^\[walkoff\] 장애: 서버 \(\/rankings 500\)$/);
  assert.match(h.mails[0].text, /^\[장애\] 서버 https:\/\/walkoff-api\.walkoff-api\.workers\.dev\/rankings\n내용: \/rankings 500 \(25초 뒤 한 번 더 봐도 실패\)\n처음 본 때: 2026-11-23 09:05 한국 시간\n/);
  assert.match(h.mails[0].text, /다른 곳: 새 주소 정상 · 옛 주소 정상\n/);
  assert.deepEqual(a.next.api, { ok: false, since: Date.parse('2026-11-23T00:05:00Z'), note: '/rankings 500', mailed: true, lastMail: Date.parse('2026-11-23T00:05:00Z') });
  let prev = a.next;
  for (let i = 0; i < 11; i++) {   // 5분마다 55분까지
    h.tick(5 * 60_000);
    const b = await h.run(prev);
    assert.deepEqual([b.sent, b.changed], [[], false]);   // KV를 쓰지 않는다(처음 까닭만 둔다)
    prev = b.next;
  }
  h.tick(5 * 60_000);   // 첫 메일에서 1시간
  const c = await h.run(prev);
  assert.deepEqual(c.sent, ['아직 장애 서버']);
  assert.equal(h.mails[1].subject, '[walkoff] 아직 장애: 서버 (1시간째)');
  assert.match(h.mails[1].text, /처음 본 때: 2026-11-23 09:05 한국 시간 \(1시간째\)/);
  h.tick(23 * 60_000);
  down = false;
  const d = await h.run(c.next);
  assert.deepEqual(d.sent, ['복구 서버']);
  assert.equal(h.mails[2].subject, '[walkoff] 복구: 서버 (장애 1시간 23분)');
  assert.match(h.mails[2].text, /^\[복구\] 서버 \S+\n지금: 이번 주 \S+\n장애: 2026-11-23 09:05 ~ 10:28 한국 시간 \(1시간 23분\), 처음 내용: \/rankings 500\n/);
  assert.deepEqual(d.next.api, { ok: true, lastMail: Date.parse('2026-11-23T01:05:00Z') });
  assert.equal(h.mails.length, 3);
});

test('한 바퀴: 처음 볼 때만 실패하고 25초 뒤 다시 볼 때 되면 메일 없이 정상이다(망이 잠깐 끊김)', async () => {
  let n = 0;
  const h = harness({ ...healthy(), [NEW_SITE]: () => (n++ === 0 ? timeout() : page(deployed)) });
  const r = await h.run({});
  assert.deepEqual([r.sent, r.next.new, h.waits], [[], { ok: true }, [RETRY_MS]]);
  assert.match(r.results[0].note, /한 번 더 봐서 됨: 20초 안에 답이 없다/);
});

test('한 바퀴: 오르락내리락하면 장애 메일은 같은 곳에 1시간에 한 번이고, 메일을 안 보낸 장애가 끝나면 복구 메일도 없다', async () => {
  let down = true;
  const h = harness({ ...healthy(), [OLD_SITE]: () => (down ? status(503) : page(deployed)) });
  const step = async (prev, isDown) => { down = isDown; const r = await h.run(prev); h.tick(5 * 60_000); return r; };
  let r = await step({}, true);            // 09:05 장애 메일
  r = await step(r.next, false);           // 09:10 복구 메일
  r = await step(r.next, true);            // 09:15 1시간 안이라 미룸
  assert.deepEqual([r.sent, r.next.old.mailed], [[], false]);
  r = await step(r.next, false);           // 09:20 메일 안 보낸 장애라 복구 메일 없음
  assert.deepEqual(r.sent, []);
  assert.deepEqual(h.mails.map((m) => m.subject.split(':')[0]), ['[walkoff] 장애', '[walkoff] 복구']);
  for (let i = 0; i < 7; i++) r = await step(r.next, false);   // 09:55까지 정상
  r = await step(r.next, true);            // 10:00 다시 장애, 첫 메일(09:05)에서 55분이라 미룸
  assert.deepEqual(r.sent, []);
  r = await step(r.next, true);            // 10:05 1시간이 차서 장애 메일
  assert.deepEqual(r.sent, ['장애 옛 주소']);
  assert.match(h.mails[2].text, /처음 본 때: 2026-11-23 10:00 한국 시간\n/);   // 미룬 바퀴부터 센다
});

test('한 바퀴: 메일을 못 보내면 보낸 것으로 치지 않아 다음 바퀴에 다시 보낸다(못 보낸 까닭은 따로 돌려준다)', async () => {
  const h = harness({ ...healthy(), [NEW_SITE]: () => status(522) });
  h.failSend(Object.assign(new Error('recipient not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' }));
  const a = await h.run({});
  assert.deepEqual([a.sent, a.failed, a.next.new.mailed, a.next.new.lastMail], [[], ['장애 새 주소: E_RECIPIENT_NOT_ALLOWED recipient not verified'], false, undefined]);
  h.failSend(null);
  h.tick(5 * 60_000);
  const b = await h.run(a.next);
  assert.deepEqual(b.sent, ['장애 새 주소']);
  assert.match(h.mails[0].text, /처음 본 때: 2026-11-23 09:05 한국 시간\n/);   // 처음 실패한 때 그대로
});

test('한 바퀴: 시험 모드(비밀값 ALERT_TEST)는 바깥 요청 없이 일부러 실패해 장애 메일을 내고, 끄면 복구 메일을 낸다', async () => {
  const h = harness(healthy());
  const on = await h.run({}, { test: true });
  assert.deepEqual(on.sent, ['장애 시험']);
  assert.deepEqual([h.web.seen.length, h.waits], [5, [RETRY_MS]]);   // 시험은 바깥 요청 없이 다시 보기까지 한다
  assert.match(h.mails[0].text, /다른 곳: 새 주소 정상 · 옛 주소 정상 · 서버 정상\n/);   // 운영 메일함에서 세 곳을 실제로 봤는지도 보인다
  h.tick(10 * 60_000);
  const off = await h.run(on.next);
  assert.deepEqual(off.sent, ['복구 시험']);
  assert.deepEqual(targets(false).map((t) => t.key), ['new', 'old', 'api', 'test']);
});

test('한 바퀴: KV에 든 상태가 이상한 모양이어도 정상이었다고 보고 새로 쓴다', async () => {
  const h = harness(healthy());
  const r = await h.run({ new: 'x', old: { ok: 'yes' }, gone: { ok: false } });
  assert.deepEqual([r.changed, r.sent, Object.keys(r.next)], [true, [], ['new', 'old', 'api', 'test']]);
});

// 원문 머리글을 풀어 되돌린다(접힌 줄을 잇고 encoded-word마다 UTF-8로, 깨진 글자가 있으면 TextDecoder가 멈춘다)
const unfold = (raw) => raw.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
const decodeWords = (v) => v.replace(/=\?UTF-8\?B\?([^?]+)\?=\s?/g, (_, b) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))));

test('메일 원문: From·To·Subject·Date·Message-ID·MIME 머리글, 줄 끝 CRLF, 한 줄 76자 안. 한글 제목은 글자를 쪼개지 않고 되돌리면 같다', () => {
  const subject = '[walkoff] 아직 장애: 새 주소 (모듈을 못 받는다: js-a036a4c/main.js 404, 한글이 길게 이어지는 제목)';
  const text = '[장애] 새 주소 https://walkoff.kr/\n내용: index.html 522\n'.repeat(5);
  const raw = rawMail({ from: FROM, fromName: 'walkoff 상태 알림', to: 'ops@example.com', subject, text, date: new Date('2026-11-23T00:05:00Z'), id: 'fixed' });
  assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(raw), 'CRLF만');
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 76, line);
  const head = unfold(raw);
  assert.match(head, /^From: =\?UTF-8\?B\?[^?]+\?= <alerts@walkoff\.kr>\r\nTo: <ops@example\.com>\r\nSubject: /);
  assert.match(head, /\r\nDate: Mon, 23 Nov 2026 00:05:00 \+0000\r\nMessage-ID: <fixed@walkoff\.kr>\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64$/);
  assert.equal(decodeWords(/\r\nSubject: (.+?)\r\n/.exec(head)[1]), subject);
  assert.equal(decodeWords(/^From: (.+?) </.exec(head)[1]), 'walkoff 상태 알림');
  const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))), text.replace(/\n/g, '\r\n'));
  assert.equal(encodeHeader('plain ascii'), 'plain ascii');
  assert.match(rawMail({ from: FROM, fromName: 'x', to: 'ops@example.com', subject: 's', text: 't' }), /\r\nMessage-ID: <[0-9a-f-]{36}@walkoff\.kr>\r\n/);
});

test('메일 원문: 막혀야 할 것 — 머리글 끼워 넣기(제목·받는 주소의 줄바꿈), 주소 모양이 아닌 받는 주소', () => {
  const raw = rawMail({ from: FROM, fromName: 'x', to: 'ops@example.com', subject: '장애\r\nBcc: evil@example.com', text: 't' });
  assert.ok(!/\r\nBcc:/i.test(raw));
  assert.ok(!/\r\nBcc:/i.test(rawMail({ from: FROM, fromName: 'x', to: 'ops@example.com', subject: 'down\r\nBcc: evil@example.com', text: 't' })));   // 아스키만 있어도
  assert.equal(decodeWords(/\r\nSubject: (.+?)\r\n/.exec(unfold(raw))[1]), '장애\r\nBcc: evil@example.com');   // 줄바꿈도 encoded-word 안에 든다
  assert.throws(() => rawMail({ from: FROM, fromName: 'x', to: 'ops@example.com\r\nBcc: evil@example.com', subject: 's', text: 't' }), /메일 주소 모양이 아니다/);
  assert.throws(() => rawMail({ from: FROM, fromName: 'x', to: '', subject: 's', text: 't' }), /메일 주소 모양이 아니다/);
  assert.throws(() => rawMail({ from: FROM, fromName: 'x', to: 'ops@localhost', subject: 's', text: 't' }), /메일 주소 모양이 아니다/);
});

test('로그: 메일 주소를 가린다(보내기 오류 글에 받는 주소가 들 수 있다)', () => {
  assert.equal(hideMail('E_RECIPIENT_NOT_ALLOWED: ops.team+x@example.com is not verified'), 'E_RECIPIENT_NOT_ALLOWED: <메일> is not verified');
  assert.equal(hideMail('to <a@example.com>, c@example.com'), 'to <<메일>>, <메일>');
  assert.equal(hideMail('/rankings 500'), '/rankings 500');
});

test('설정: 볼 곳은 게임(js/infra/site.js)·서버(js/infra/api.js) 주소와 같고, 5분마다·주소 없이 돌며, 보내는 주소만 적고 받는 주소는 레포에 없다', () => {
  assert.deepEqual([NEW_SITE, OLD_SITE], [site.NEW_SITE, site.OLD_SITE]);
  assert.equal(API, /\|\| '(https:\/\/[^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'js', 'infra', 'api.js'), 'utf8'))?.[1]);
  const toml = fs.readFileSync(path.join(ROOT, 'worker', 'health', 'wrangler.toml'), 'utf8');
  const lines = toml.split('\n').map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l && !l.startsWith('#'));
  for (const want of ['name = "walkoff-health"', 'main = "src/index.js"', 'compatibility_flags = ["global_fetch_strictly_public"]', 'workers_dev = false', 'preview_urls = false', 'crons = ["*/5 * * * *"]', 'binding = "STATE"', 'name = "MAIL"', `allowed_sender_addresses = ["${FROM}"]`]) assert.ok(lines.includes(want), want);
  assert.ok(!lines.some((l) => /destination_address|\[vars\]|route/.test(l)));   // 받는 주소·바깥 주소를 적지 않는다
  assert.equal(REMIND_MS, 60 * 60_000);
  // 이 폴더와 health.js에 적힌 메일 주소는 보내는 주소와 시험용(example.com)뿐이다(공개 레포)
  const files = ['scripts/health.js', ...fs.readdirSync(path.join(ROOT, 'worker', 'health'), { recursive: true }).filter((f) => !f.startsWith('.wrangler')).map((f) => path.join('worker', 'health', f))].filter((f) => /\.(js|toml|md|json)$/.test(f));
  const found = files.flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []);
  assert.ok(found.length > 0);
  assert.deepEqual([...new Set(found)].filter((a) => a !== FROM && !a.endsWith('@example.com')), []);
});
