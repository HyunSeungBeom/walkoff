import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOTS, ITEMS, DEFAULTS, coinsFor, lookOf } from '../src/shop.js';

test('물건 목록: id가 겹치지 않고, 종류마다 무료 기본 물건이 하나씩 있다', () => {
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  for (const slot of SLOTS) assert.equal(ITEMS.filter((i) => i.slot === slot && i.price === 0).length, 1, slot);
  assert.deepEqual(Object.keys(DEFAULTS), SLOTS);
  assert.ok(ITEMS.every((i) => SLOTS.includes(i.slot) && Number.isInteger(i.price) && i.price >= 0));
});

test('코인: 점수의 1/100(버림)', () => {
  assert.equal(coinsFor(3050), 30);
  assert.equal(coinsFor(99), 0);
  assert.equal(coinsFor(-5), 0);
});

test('착용: 모르거나 안 산 물건은 기본으로, 등번호는 달았을 때 0~99만', () => {
  assert.deepEqual(lookOf('{}', []), DEFAULTS);
  assert.deepEqual(lookOf('망가진 JSON', []), DEFAULTS);
  assert.equal(lookOf('{"bat":"bat-gold"}', []).bat, 'bat-wood');                 // 안 산 물건
  assert.equal(lookOf('{"bat":"bat-gold"}', ['bat-gold']).bat, 'bat-gold');
  assert.equal(lookOf('{"bat":"helmet-gold"}', ['helmet-gold']).bat, 'bat-wood');  // 다른 종류 칸에 넣은 값
  assert.deepEqual([lookOf('{"number":"number-on","no":7}', ['number-on']).no, lookOf('{"number":"number-on","no":100}', ['number-on']).number], [7, 'number-none']);
});
