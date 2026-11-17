// 투수·수비수 얼굴(js/sim/faces.js facesFor·faceMood·PITCHER_FACES)을 브라우저 없이 본다(2026-11-16, 투수 유형별 얼굴 2026-11-17). 표정은 게임과 같은
// 판정(core judgeSwing)과 수비 일정(sim fieldPlay)으로 만든 결과로 본다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing } from '../../js/core/judge.js';
import { makeSequence, PITCHER_STYLES } from '../../js/core/pitches.js';
import { fieldPlay } from '../../js/sim/fielding.js';
import { FACE_PARTS, FACE_POS, faceMood, facesFor, PITCHER_FACES } from '../../js/sim/faces.js';

const OUTFIELD = ['좌익수', '중견수', '우익수'];
const FIELD_POS = FACE_POS.filter((pos) => pos !== '투수');
const STYLES = Object.keys(PITCHER_STYLES);
const HIT = ['single', 'double', 'triple'];
const missOf = (play, pos) => play.acts[pos]?.find((e) => e.name === 'dive' || e.name === 'leap');
// 시드 1~60 공 순서를 -60~60ms로 휘둘러 pre에 맞는 결과 가운데 수비 일정이 check에 맞는 첫 것(판정 숫자를 다듬어도 찾아진다)
function find(pre, check = () => true) {
  for (let seed = 1; seed <= 60; seed++) for (const p of makeSequence(seed, false)) for (let dt = -60; dt <= 60; dt += 5) {
    const r = judgeSwing(p, dt, 'R');
    if (!pre(r)) continue;
    const play = fieldPlay(r);
    if (check(r, play)) return { r, play };
  }
  return assert.fail('찾지 못함');
}

test('투수 얼굴: 유형마다 하나(core PITCHER_STYLES와 같은 유형), 부품은 FACE_PARTS 안이고 폰에서 갈리는 덤은 넷이 모두 다르다', () => {
  assert.deepEqual(Object.keys(PITCHER_FACES).sort(), [...STYLES].sort());
  for (const [style, f] of Object.entries(PITCHER_FACES)) for (const key of Object.keys(FACE_PARTS)) assert.ok(FACE_PARTS[key].includes(f[key]), `${style} ${key} ${f[key]}`);
  assert.equal(new Set(Object.values(PITCHER_FACES).map((f) => f.extra)).size, STYLES.length);
});

test('얼굴: 같은 시드·유형이면 같은 얼굴, 투수는 유형의 얼굴(모르는 유형은 정통파), 한 판 9명은 눈·덤 짝이 모두 다르고 눈·덤마다 2~3명(투수의 눈·덤은 수비수 한 명씩), 선글라스는 외야수 하나까지', () => {
  assert.deepEqual(facesFor(42, 'power'), facesFor(42, 'power'));
  assert.notDeepEqual(facesFor(42), facesFor(43));
  for (const bad of [undefined, 'toString', 'lefty']) assert.deepEqual(facesFor(42, bad), facesFor(42, 'classic'));
  for (const style of STYLES) for (let seed = 0; seed < 1000; seed++) {
    const f = facesFor(seed, style), list = FACE_POS.map((pos) => f[pos]), P = PITCHER_FACES[style];
    assert.deepEqual(Object.keys(f).sort(), [...FACE_POS].sort());
    assert.deepEqual(f['투수'], { ...P, shades: false });
    assert.equal(new Set(list.map((x) => `${x.eye}/${x.extra}`)).size, 9, `${style} 시드 ${seed}`);
    for (const key of ['eye', 'extra']) for (const v of FACE_PARTS[key]) {
      const n = list.filter((x) => x[key] === v).length;
      assert.ok(v === P[key] ? n === 2 : n >= 2 && n <= 3, `${style} 시드 ${seed} ${key} ${v} ${n}명`);
    }
    for (const key of ['brow', 'nose', 'mouth']) for (const x of list) assert.ok(FACE_PARTS[key].includes(x[key]));
    const shades = FACE_POS.filter((pos) => f[pos].shades);
    assert.ok(shades.length <= 1 && shades.every((pos) => OUTFIELD.includes(pos)), `${style} 시드 ${seed} ${shades}`);
  }
});

test('얼굴: 수비수는 시드마다 고르게 섞인다(자리마다 부품 비율이 고른 몫의 ±20% 안, 투수의 눈·덤은 8명 중 1명 몫), 선글라스는 판의 절반쯤', () => {
  const N = 3000;
  for (const style of STYLES) {
    const count = {}, P = PITCHER_FACES[style];
    let shades = 0;
    for (let i = 0; i < N; i++) {
      const f = facesFor(i * 7919 + 1, style);
      for (const pos of FIELD_POS) for (const key of Object.keys(FACE_PARTS)) { const k = `${pos}/${key}/${f[pos][key]}`; count[k] = (count[k] ?? 0) + 1; }
      if (FIELD_POS.some((pos) => f[pos].shades)) shades++;
    }
    for (const pos of FIELD_POS) for (const [key, list] of Object.entries(FACE_PARTS)) for (const v of list) {
      // 눈·덤: 투수 것은 수비수 8명 중 1명, 나머지 셋이 7명을 나눠 가진다(3·2·2명). 눈썹·코·입은 고르게
      const fair = key === 'eye' || key === 'extra' ? (v === P[key] ? 1 / 8 : 7 / 24) : 1 / list.length;
      const share = (count[`${pos}/${key}/${v}`] ?? 0) / N;
      assert.ok(Math.abs(share - fair) < fair * 0.2, `${style} ${pos} ${key} ${v} ${share.toFixed(3)}`);
    }
    assert.ok(Math.abs(shades / N - 0.5) < 0.04, `${style} 선글라스 ${shades / N}`);
  }
});

test('표정: 홈런은 모두 놀람, 뜬공·직선타는 잡은 수비수만 잡은 때부터 웃음, 땅볼 아웃과 공을 안 친 때는 그대로', () => {
  const hr = find((r) => r.kind === 'hr');
  for (const pos of FACE_POS) for (const t of [0, 1, 4]) assert.equal(faceMood(hr.r, hr.play, pos, t), 'wow');
  const fly = find((r) => r.kind === 'out' && r.type !== 'ground'), { catch: tc, fielder } = fly.play.ev;
  assert.ok(FACE_POS.includes(fielder) && tc > 0);
  assert.equal(faceMood(fly.r, fly.play, fielder, tc - 0.05), null);
  assert.equal(faceMood(fly.r, fly.play, fielder, tc), 'grin');
  assert.equal(faceMood(fly.r, fly.play, fielder, tc + 3), 'grin');
  for (const pos of FACE_POS) if (pos !== fielder) assert.equal(faceMood(fly.r, fly.play, pos, tc + 1), null, pos);
  const ground = find((r) => r.kind === 'out' && r.type === 'ground');
  for (const pos of FACE_POS) for (const t of [0.5, 1.5, 3]) assert.equal(faceMood(ground.r, ground.play, pos, t), null, pos);
  assert.equal(faceMood(null, null, '투수', 1), null);
});

test('표정: 안타에 몸을 날리거나 뛰어올랐다 놓친 수비수는 그때부터 아쉬움, 그 전과 다른 수비수는 그대로', () => {
  for (const name of ['dive', 'leap']) {
    const miss = find((r) => HIT.includes(r.kind), (r, play) => FACE_POS.some((pos) => missOf(play, pos)?.name === name));
    const pos = FACE_POS.find((q) => missOf(miss.play, q)?.name === name), t0 = missOf(miss.play, pos).t0;
    assert.equal(faceMood(miss.r, miss.play, pos, t0 - 0.05), null, name);
    assert.equal(faceMood(miss.r, miss.play, pos, t0), 'sad', name);
    assert.equal(faceMood(miss.r, miss.play, pos, t0 + 3), 'sad', name);
    for (const q of FACE_POS) if (!missOf(miss.play, q)) assert.equal(faceMood(miss.r, miss.play, q, t0 + 1), null, `${name} ${q}`);
  }
});
