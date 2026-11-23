// 기간 한정 물건(js/core/catalog.js SALES·saleOn, 2026-11-23 사용자 '겨울 한정')을 브라우저 없이 본다. 서버(사기·선물)와 게임(상점에 보일지·살 수 있는지)이 같은 함수를 쓴다.
// 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, SALES, SLOTS, saleOn } from '../../js/core/catalog.js';

test('겨울 한정은 한국 시간 2026-12-01부터 12-31까지만 판다: 그 전은 soon, 그 뒤는 over', () => {
  assert.deepEqual(SALES.winter, { from: '2026-12-01', to: '2026-12-31' });
  const it = { id: 'x', slot: 'helmet', price: 800, sale: 'winter' };
  assert.equal(saleOn(it, '2026-11-23'), 'soon');
  assert.equal(saleOn(it, '2026-11-30'), 'soon');
  assert.equal(saleOn(it, '2026-12-01'), 'on');
  assert.equal(saleOn(it, '2026-12-31'), 'on');
  assert.equal(saleOn(it, '2027-01-01'), 'over');
});

test('기간이 없는 물건과 모르는 기간 이름은 늘 판다(on)', () => {
  assert.equal(saleOn({ id: 'bat-red', slot: 'bat', price: 150 }, '2026-12-15'), 'on');
  assert.equal(saleOn({ id: 'y', slot: 'bat', price: 1, sale: 'nope' }, '2026-12-15'), 'on');
  assert.equal(saleOn(null, '2026-12-15'), 'on');
});

test('한정 물건은 모두 있는 기간 이름을 달고, 기본 물건(값 0)은 한정이 아니며, id는 겹치지 않는다', () => {
  for (const it of ITEMS.filter((i) => i.sale)) { assert.ok(SALES[it.sale], it.id); assert.ok(it.price > 0, it.id); assert.ok(SLOTS.includes(it.slot), it.id); }
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
});
