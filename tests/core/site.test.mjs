// 게임 주소(js/infra/site.js)와 옛 주소 → 새 주소로 넘길 기록 싣기를 브라우저 없이 본다(2026-11-17 주소 옮기기).
// # 조각으로 받은 값은 믿지 않으므로 모양이 틀리면 null, 이상한 키·글자가 아닌 값은 버려야 한다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME, MOVE_ON, moveUrl, NEW_SITE, OLD_SITE, packMove, shareSite, siteOf, unpackMove } from '../../js/infra/site.js';

test('주소가 옛·새 주소 가운데 어느 쪽인지: 같은 출처이고 경로가 그 아래여야 한다', () => {
  assert.equal(OLD_SITE, 'https://hyunseungbeom.github.io/walkoff/');
  assert.equal(NEW_SITE, 'https://walkoff.kr/');
  for (const href of [OLD_SITE, `${OLD_SITE}index.html?seed=42`, `${OLD_SITE}?vs=abc#login=x`]) assert.equal(siteOf(href), OLD_SITE, href);
  for (const href of [NEW_SITE, `${NEW_SITE}index.html`, `${NEW_SITE}?vs=abc&fps=1`]) assert.equal(siteOf(href), NEW_SITE, href);
  for (const href of ['https://hyunseungbeom.github.io/other/', 'http://walkoff.kr/', 'https://www.walkoff.kr/', 'https://walkoff.kr.evil.example/', 'https://walkoff.pages.dev/',
    'http://127.0.0.1:4173/index.html', 'file:///Users/x/walkoff/index.html', 'not a url', '']) assert.equal(siteOf(href), null, href);
});

test('공유 주소는 지금 열린 주소이고, 그 밖의 주소(이 컴퓨터·pages.dev)에서는 사람들이 치는 주소다', () => {
  assert.equal(shareSite(`${OLD_SITE}?seed=1`), OLD_SITE);   // 넘기기 전 옛 주소에서 친 사람은 옛 주소를 보낸다
  assert.equal(shareSite(`${NEW_SITE}?vs=abc`), NEW_SITE);
  assert.equal(HOME, MOVE_ON ? NEW_SITE : OLD_SITE);
  for (const href of ['http://127.0.0.1:4173/index.html?seed=42', 'https://walkoff.pages.dev/']) assert.equal(shareSite(href), HOME, href);
});

test('옛 주소에서 갈 주소: 물음표 뒤는 그대로, 옛 # 조각과 index.html은 떼고, 넘길 기록은 # 조각에 싣는다', () => {
  assert.equal(moveUrl(OLD_SITE), NEW_SITE);
  assert.equal(moveUrl(`${OLD_SITE}index.html?vs=a-b_c&seed=7&fps=1#login=tok&n=x`), `${NEW_SITE}?vs=a-b_c&seed=7&fps=1`);
  assert.equal(moveUrl(`${OLD_SITE}?vs=abc`, 'eyJ2Ijox'), `${NEW_SITE}?vs=abc#move=eyJ2Ijox`);
});

test('넘길 기록 싣기: 한글·특수 문자·긴 값도 그대로 돌아오고, 주소에 쓸 수 있는 글자만 쓴다', () => {
  const values = {
    team: 'lg', nick: '명은🔥', session: 'eyJ0Ijoicy.abc-_', 'played.2026-11-16': '1', offset: '-24',
    duels: JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ seed: 1e6 + i, tries: i, first: i * 100 }))),
    timingLog: '[-12,8,30]', newsSeen: '2026-11-17a', quote: '"따옴표" & = # ? / + %',
  };
  for (let d = 0; d < 400; d++) values[`played.day${d}`] = '1';   // 1년 넘게 친 연속 기록도 싣는다
  const packed = packMove(values);
  assert.match(packed, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(unpackMove(`#move=${packed}`), values);
  assert.deepEqual(unpackMove(`#move=${packMove({})}`), {});
});

test('받은 # 조각은 믿지 않는다: 모양이 틀리면 null, 이상한 키나 글자가 아닌 값은 버린다', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  for (const hash of ['', '#', '#move=', '#login=abc&n=x', `#move=${b64({ v: 1, d: { a: '1' } })}&x=1`, '#move=!!!', '#move=bm90IGpzb24',
    `#move=${b64({ v: 2, d: { a: '1' } })}`, `#move=${b64({ v: 1, d: ['a'] })}`, `#move=${b64({ v: 1, d: null })}`, `#move=${b64({ v: 1 })}`, `#move=${b64([1])}`]) {
    assert.equal(unpackMove(hash), null, hash);
  }
  const mixed = unpackMove(`#move=${b64({ v: 1, d: { team: 'lg', n: 3, obj: { a: 1 }, nil: null, 'bad key': 'x', '../x': 'y', [`k${'x'.repeat(70)}`]: 'z', 'ok.key-1_2': 'v' } })}`);
  assert.deepEqual(mixed, { team: 'lg', 'ok.key-1_2': 'v' });
});
