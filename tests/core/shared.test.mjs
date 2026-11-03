// 서버와 같이 쓰는 규칙(js/core의 pitches·score·catalog)이 랭킹 서버의 복사본(worker/src)과 같은지 본다(2026-11-03 코드 나누기 2단계).
// 서버가 core를 직접 가져오게 바꾸면 이 파일은 지운다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../js/core/pitches.js';
import * as S from '../../js/core/score.js';
import * as C from '../../js/core/catalog.js';
import { mulberry32 } from '../../js/core/math.js';
import { ZONE } from '../../js/core/field.js';
import * as WP from '../../worker/src/pitches.js';
import * as WR from '../../worker/src/rules.js';
import * as WS from '../../worker/src/shop.js';

test('공 순서·투수 손·날짜 시드·존 밖 거리가 서버와 같다', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    for (const lefty of [false, true]) assert.deepEqual(P.makeSequence(seed, lefty), WP.makeSequence(seed, lefty), `시드 ${seed}`);
    assert.equal(P.pitcherHand(seed), WP.pitcherHand(seed));
  }
  for (let d = 0; d < 400; d++) { const day = new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString().slice(0, 10); assert.equal(P.dailySeed(day), WP.dailySeed(day), day); }
  for (const p of P.makeSequence(77)) assert.equal(P.zoneMiss(p), WP.zoneMiss(p));
  assert.deepEqual([P.SEQ_LEN, P.REACH_M, ZONE], [WP.SEQ_LEN, WP.REACH_M, WP.ZONE]);
});

test('점수 표·보너스·점수 상한이 서버와 같다', () => {
  assert.equal(S.CHANCES, WP.CHANCES);
  assert.equal(S.PERFECT_BONUS, WP.PERFECT_BONUS);
  for (const k of Object.keys(WP.POINTS)) assert.equal(S.POINTS[k], WP.POINTS[k], k);   // 서버는 3루타 점수를 쓰지 않는다(안타는 모두 홈런으로 상한을 잰다)
  for (let n = 0; n <= 12; n++) assert.equal(S.hrStreakBonus(n), WP.hrStreakBonus(n));
  // 그 판의 공 순서로 칠 수 있는 전광판(존 밖 공은 골라내거나 휘두르고, 배트가 닿는 공만 안타)과, 아무렇게나 만든 전광판(대개 나올 수 없다)으로 견준다
  const rnd = mulberry32(2026);
  const playable = (seq) => {
    let left = S.CHANCES, out = '';
    for (const p of seq) {
      if (left === 0) break;
      const miss = P.zoneMiss(p), x = rnd();
      if (miss > 0 && x < 0.5) { out += 'Y'; continue; }
      out += miss <= P.REACH_M && x < 0.8 ? 'G' : 'R';
      left--;
    }
    return out;
  };
  let valid = 0, rejected = 0;
  for (let k = 0; k < 4000; k++) {
    const seed = 1 + Math.floor(rnd() * 1e6), seq = P.makeSequence(seed, P.pitcherHand(seed) === 'L');
    const lights = k % 2 ? playable(seq) : Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => 'GYR'[Math.floor(rnd() * 3)]).join('');
    const mine = S.maxScoreFor(lights, seq);
    assert.equal(mine, WR.maxScoreFor(lights, seq), `${seed} ${lights}`);
    if (mine === null) rejected++; else valid++;
  }
  assert.ok(valid >= 1900 && rejected >= 1900, `받음 ${valid} · 거름 ${rejected}`);   // 받는 경우와 거르는 경우를 둘 다 본다
});

test('팀 id와 상점 물건(id·종류·가격)이 서버와 같다', () => {
  assert.deepEqual(C.TEAM_IDS, WR.TEAM_IDS);
  assert.deepEqual(C.SLOTS, WS.SLOTS);
  assert.deepEqual(C.ITEMS, WS.ITEMS);
});
