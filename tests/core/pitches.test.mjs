// 이번 주 투수(2026-11-16): 투수 유형별 공 순서(js/core/pitches.js PITCHER_STYLES·makeSequence)와 주 → 유형(styleOn). 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSequence, PITCHER_STYLES, PITCHES, STYLE_ORDER, STYLE_START, styleOn, zoneMiss } from '../../js/core/pitches.js';

const STYLES = Object.keys(PITCHER_STYLES);
const fnv = (str, h = 2166136261) => { for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

test('정통파는 유형이 생기기 전과 같은 공이다(시드 1~500 × 좌우 투수, 유형 없이 부른 것도 같다)', () => {
  let h = 2166136261;
  for (let seed = 1; seed <= 500; seed++) for (const lefty of [false, true]) {
    const seq = makeSequence(seed, lefty);
    assert.deepEqual(makeSequence(seed, lefty, 'classic'), seq);
    h = fnv(JSON.stringify(seq), h);
  }
  assert.equal(h.toString(16), '8fc0b6d7');   // 고치기 전 코드(65a77a7)로 낸 값
});

test('유형마다 4구부터 구종 비율이 정한 비율이고, 1~3구 감 잡기는 그대로다', () => {
  for (const style of STYLES) {
    const { mix } = PITCHER_STYLES[style], total = Object.values(mix).reduce((a, b) => a + b, 0), count = {};
    let n = 0;
    for (let seed = 1; seed <= 4000; seed++) {
      const seq = makeSequence(seed, false, style);
      assert.deepEqual(seq.slice(0, 2).map((p) => p.type), ['fastball', 'fastball']);
      assert.ok(['fastball', 'slider'].includes(seq[2].type));
      for (const p of seq.slice(3)) { count[p.type] = (count[p.type] ?? 0) + 1; n++; }
    }
    for (const [type, w] of Object.entries(mix)) {
      const got = (count[type] ?? 0) / n, want = w / total;
      assert.ok(Math.abs(got - want) < 0.01, `${style} ${type}: ${(got * 100).toFixed(1)}% (정한 값 ${(want * 100).toFixed(1)}%)`);
    }
  }
});

test('직구 빠르기만 유형마다 바뀌고(강속구형 151~158, 기교파 141~148) 변화구는 그대로, 4구부터 존 안 비율은 기교파만 55%', () => {
  for (const style of STYLES) {
    const st = PITCHER_STYLES[style], seen = {};
    let late = 0, lateIn = 0;
    for (let seed = 1; seed <= 4000; seed++) makeSequence(seed, seed % 2 === 0, style).forEach((p, i) => {
      const [lo, hi] = PITCHES[p.type].kmh, add = p.type === 'fastball' ? st.fastKmh : 0;
      assert.ok(p.kmh >= lo + add && p.kmh <= hi + add, `${style} ${p.type} ${p.kmh}km`);
      seen[p.type] = [Math.min(seen[p.type]?.[0] ?? 999, p.kmh), Math.max(seen[p.type]?.[1] ?? 0, p.kmh)];
      if (i >= 3) { late++; if (zoneMiss(p) === 0) lateIn++; }
    });
    assert.deepEqual(seen.fastball, [146 + st.fastKmh, 153 + st.fastKmh]);
    assert.ok(Math.abs(lateIn / late - st.zone) < 0.01, `${style} 존 안 ${(100 * lateIn / late).toFixed(1)}%`);
  }
  assert.deepEqual([PITCHER_STYLES.power.fastKmh, PITCHER_STYLES.finesse.fastKmh, PITCHER_STYLES.finesse.zone], [5, -5, 0.55]);
  for (const bad of ['no-such-style', 'toString', undefined, null, 3]) assert.deepEqual(makeSequence(7, false, bad), makeSequence(7));   // 모르는 유형은 정통파
});

test('주 → 유형: 2026-11-23(월) 주부터 강속구형 → 기교파 → 포크볼러 → 정통파로 돌고, 그 전 주는 모두 정통파다', () => {
  assert.equal(STYLE_START, '2026-11-23');
  assert.deepEqual(['2026-10-26', '2026-11-16', '2026-11-22'].map(styleOn), ['classic', 'classic', 'classic']);
  assert.deepEqual(['2026-11-23', '2026-11-29', '2026-11-30', '2026-12-06', '2026-12-07', '2026-12-14', '2026-12-21'].map(styleOn),
    ['power', 'power', 'finesse', 'finesse', 'forkball', 'classic', 'power']);
  // Date로 센 날 수와 같은지(core는 Date를 쓰지 않고 셈한다): 2026~2031년 하루도 빠짐없이, 윤년(2028) 포함
  const start = Date.parse(`${STYLE_START}T00:00:00Z`);
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t <= Date.parse('2031-12-31T00:00:00Z'); t += 864e5) {
    const day = new Date(t).toISOString().slice(0, 10), n = Math.floor((t - start) / (7 * 864e5));
    assert.equal(styleOn(day), n < 0 ? 'classic' : STYLE_ORDER[n % 4], day);
  }
});
