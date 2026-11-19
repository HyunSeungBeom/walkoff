// 친구 도전장 주소(js/game/duel.js duelCode·parseDuel)와 이 브라우저 기록(duelLog)을 브라우저 없이 본다(2026-11-16).
// 주소 값은 믿지 않으므로 틀린 값이 하나라도 있으면 null이어야 한다. 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSequence, pitcherHand, REACH_M, zoneMiss } from '../../js/core/pitches.js';
import { scoreRange } from '../../js/core/score.js';
import { DUEL_KEEP, duelCode, duelEntry, duelLog, parseDuel } from '../../js/game/duel.js';

// 시드 42 공 순서로 나올 수 있는 전광판: 존 밖으로 멀리 빠진 공은 골라낸 볼(Y), 나머지는 앞에서부터 홈런·단타·아웃 순서로 기회 10번
const seq = makeSequence(42, pitcherHand(42) === 'L');
function lightsFor(pattern, s = seq) {
  let out = '', k = 0;
  for (const p of s) {
    if (k === 10) break;
    if (zoneMiss(p) > REACH_M) { out += 'Y'; continue; }
    out += pattern[k % pattern.length]; k++;
  }
  return out;
}
const LIGHTS = lightsFor('HSR');
const RANGE = scoreRange(LIGHTS, seq);
const BASE = { seed: 42, score: RANGE.min, lights: LIGHTS, team: 'hanwha', bats: 'L', n: 1, nick: '명은' };
// LIGHTS에서 존 한가운데 공(zoneMiss 0) 하나를 볼(Y)로 바꾸고, 줄어든 기회 하나를 다음 공 아웃(R)으로 채운다. 기회 수는 맞고 그 볼만 틀리다
function inZoneBall() {
  const i = [...LIGHTS].findIndex((c, k) => c !== 'Y' && zoneMiss(seq[k]) === 0);
  return `${LIGHTS.slice(0, i)}Y${LIGHTS.slice(i + 1)}R`;
}
const swap = (code, i, v) => code.split('.').map((f, j) => (j === i ? v : f)).join('.');

test('도전장 주소: 만든 값을 그대로 읽고, 닉네임은 base64url이라 마침표·한글이 주소에 그대로 나오지 않는다', () => {
  assert.ok(RANGE && RANGE.max > RANGE.min, '시험 전광판은 정타 보너스만큼 점수가 열린다');
  const code = duelCode(BASE);
  assert.match(code, /^a\.[0-9a-z]+\.[0-9a-z]+\.[SDTHYR]+\.hanwha\.L\.[A-Za-z0-9_-]+\.1$/);   // 끝은 번째(영문·숫자)
  assert.deepEqual(parseDuel(code), { ...BASE, style: 'classic' });   // 판 글자 a는 정통파
  for (const d of [{ ...BASE, score: RANGE.max }, { ...BASE, team: null, bats: 'R', n: 12, nick: 'Ohtani17' }, { ...BASE, seed: 2147483647, lights: 'RRRRRRRRRR', score: 0 }]) {
    const c = duelCode(d);
    assert.equal(c.split('.').length, 8);
    assert.deepEqual(parseDuel(c), { ...d, style: 'classic' });
  }
  assert.equal(duelCode({ ...BASE, team: null }).split('.')[4], '-');
  assert.equal(duelCode({ ...BASE, nick: 'a.b c' }).split('.').length, 8);   // 마침표가 든 글자도 칸을 깨지 않는다(지금 규칙으로는 닉네임이 될 수 없어 '친구'로 열린다)
});

test('이번 주 투수 판은 판 글자 b 뒤에 투수 유형을 싣고 그 유형의 공 순서로 검사한다. 정통파 판은 예전처럼 a다', () => {
  assert.equal(duelCode({ ...BASE, style: 'classic' }), duelCode(BASE));
  const seed = 60, styled = (style) => makeSequence(seed, pitcherHand(seed) === 'L', style);   // 시드 60은 유형마다 전광판이 달라 정통파 공으로 보면 틀린다
  for (const style of ['power', 'finesse', 'forkball']) {
    const lights = lightsFor('HSR', styled(style)), d = { ...BASE, seed, lights, score: scoreRange(lights, styled(style)).max, style }, code = duelCode(d);
    assert.match(code, new RegExp(`^b\\.${style}\\.[0-9a-z]+\\.`));
    assert.equal(code.split('.').length, 9);
    assert.deepEqual(parseDuel(code), d);
    assert.equal(parseDuel(['a', ...code.split('.').slice(2)].join('.')), null, `${style} 전광판을 정통파 공으로 보면 틀린다`);
    for (const bad of ['toString', 'Power', '', 'classic2']) assert.equal(parseDuel(swap(code, 1, bad)), null, bad);
  }
});

test('도전장 주소: 판 글자·칸 수·시드·불·점수·팀·타석·번째 가운데 하나라도 틀리면 받지 않는다', () => {
  const code = duelCode(BASE), nick = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const bad = [
    '', 'a', `b${code.slice(1)}`, `${code}.x`, code.split('.').slice(0, 7).join('.'),
    swap(code, 1, '0'), swap(code, 1, (2147483648).toString(36)), swap(code, 1, '-1'), swap(code, 1, 'A1'), swap(code, 1, ''),
    swap(code, 3, LIGHTS.replace('H', 'G')),                     // 예전 G
    swap(code, 3, LIGHTS.replace('R', 'x')),
    swap(code, 3, `${LIGHTS}R`),                                 // 기회 10번을 다 쓴 뒤의 공
    swap(code, 3, LIGHTS.slice(0, -1)),                          // 기회가 남은 채 끝남
    swap(code, 3, inZoneBall()),                                 // 존 안 공을 골라낸 볼로 적은 전광판
    swap(code, 2, (RANGE.max + 1).toString(36)), swap(code, 2, (RANGE.min - 1).toString(36)), swap(code, 2, '1.5'),
    swap(code, 4, 'bears'), swap(code, 4, ''), swap(code, 5, 'X'), swap(code, 5, 'l'),
    swap(code, 7, '0'), swap(code, 7, 'zzz'),
  ];
  for (const c of bad) assert.equal(parseDuel(c), null, c);
  assert.equal(parseDuel(null), null);
  assert.equal(parseDuel(swap(code, 6, nick(' 명은 '))).nick, '명은');   // 서버처럼 앞뒤 빈칸은 뺀다
  assert.equal(parseDuel(swap(code, 6, nick('열글자닉네임입니다'))).nick, '열글자닉네임입니다');
});

test('도전장 닉네임(2026-11-19 공개 화면 지키기): 서버와 같은 닉네임 규칙에 안 맞으면 도전장은 그대로 열고 닉네임만 null(게임은 \'친구\')', () => {
  const code = duelCode(BASE), nick = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const odd = [nick('씨발'), nick('tlqkf'), nick('운영자'), nick('\u3164'), nick('명\u200b은'), nick('명 은'), nick('열한글자닉네임입니다요'), nick('a\u0007b'), nick('   '), '',
    '%%%', Buffer.from([0xff, 0xfe]).toString('base64url')];   // 욕·사칭·투명 글자·빈칸·11자·제어 문자·빈 값·base64가 아님·UTF-8이 아님
  for (const n64 of odd) {
    const d = parseDuel(swap(code, 6, n64));
    assert.ok(d, n64);
    assert.deepEqual(d, { ...BASE, style: 'classic', nick: null }, n64);   // 시드·점수·불은 그대로 검사한 값
  }
});

test('도전장 기록: 시작할 때마다 몇 번째인지 올리고, 처음 끝까지 친 점수만 남기며, 최근 것부터 DUEL_KEEP개', () => {
  let log = duelLog(null, 42, { start: true });
  assert.deepEqual(log, [{ seed: 42, tries: 1, first: null }]);
  log = duelLog(log, 42, { score: 3200 });
  log = duelLog(log, 42, { start: true });
  log = duelLog(log, 42, { score: 9900 });                     // 두 번째 판 점수는 첫 판 점수를 덮지 않는다
  assert.deepEqual(duelEntry(log, 42), { seed: 42, tries: 2, first: 3200 });
  log = duelLog(log, 7, { start: true, score: 1500 });         // 보낸 사람이 처음 친 판(시작 1번, 점수)
  assert.deepEqual(log.map((r) => r.seed), [7, 42]);
  assert.equal(duelEntry(log, 99), null);
  for (let s = 100; s < 100 + DUEL_KEEP; s++) log = duelLog(log, s, { start: true });
  assert.equal(log.length, DUEL_KEEP);
  assert.equal(duelEntry(log, 42), null);                      // 오래된 것부터 빠진다
  assert.deepEqual(duelLog(['x', { seed: 'a' }, { seed: 5, tries: 1, first: 10 }], 6, { start: true }), [{ seed: 6, tries: 1, first: null }, { seed: 5, tries: 1, first: 10 }]);   // 망가진 줄은 버린다
});
