// 친구 도전장(2026-11-16 사용자 '추천 순서대로'): 끝낸 10구 판을 같은 공 순서로 친구에게 보내 겨룬다. 주소 ?vs=에 판을 싣고,
// 받은 쪽은 그 값을 믿지 않고 검사한다. 서명은 하지 않는다(랭킹이 없고, 그 공 순서와 전광판 불로 낼 수 있는 점수인지만 본다).
// 꼴: 판 글자.시드.점수.불.팀.타석.닉네임.번째. 시드·점수·번째는 36진수, 팀이 없으면 '-', 닉네임은 UTF-8 base64url(마침표가 안 나온다).
// 끝이 번째(영문·숫자)라서 메신저가 주소 끝의 '-'·'_'를 링크에서 떼어 내지 않는다
// 판 글자 'a'는 지금의 공 만들기(core makeSequence·pitcherHand)다. 공 만드는 법이 바뀌면(이번 주 투수 등) 글자를 바꿔 옛 주소와 가른다
import { TEAM_IDS } from '../core/catalog.js';
import { makeSequence, pitcherHand } from '../core/pitches.js';
import { scoreRange } from '../core/score.js';

export const DUEL_VERSION = 'a';
export const DUEL_KEEP = 30;          // 이 브라우저가 기억하는 도전장 공 순서 수(최근 것부터)
const SEED_MAX = 2147483647;           // 서버 시드(1 ~ 2^31-1, worker/src/seeds.js)와 기기 시드(시각 % 2147483647)
const LIGHTS = /^[SDTHYR]{1,40}$/;     // core가 쓰는 불(공 40개). 안타 종류를 모르는 예전 G는 받지 않는다
const NICK_MAX = 10;                   // 서버와 같은 닉네임 규칙(worker/src/rules.js validateProfile)

const int36 = (s) => (/^[0-9a-z]{1,7}$/.test(s) ? parseInt(s, 36) : NaN);
function toB64(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64(s) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))); } catch { return null; }
}
// 서버 규칙(앞뒤 빈칸을 뺀 1~10자, 제어 문자 없음)에 맞는 닉네임이면 그 닉네임, 아니면 null. 화면에는 캔버스로만 그린다(HTML에 넣지 않는다)
export function cleanNick(nick) {
  const s = typeof nick === 'string' ? nick.trim() : '';
  return s && [...s].length <= NICK_MAX && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

// d: { seed, score, lights, team(id나 null), bats('L'·'R'), n(그 공으로 몇 번째 친 판인지), nick }
export const duelCode = (d) => [DUEL_VERSION, d.seed.toString(36), d.score.toString(36), d.lights, d.team ?? '-', d.bats, toB64(d.nick), d.n.toString(36)].join('.');

// 주소의 ?vs= 값을 검사해 d로 돌려준다. 하나라도 틀리면 null(그때 게임은 도전장 없이 연다)
export function parseDuel(code) {
  const f = String(code ?? '').split('.');
  if (f.length !== 8 || f[0] !== DUEL_VERSION) return null;
  const [, s36, score36, lights, team, bats, nick64, n36] = f;
  const seed = int36(s36), score = int36(score36), n = int36(n36), nick = cleanNick(fromB64(nick64));
  if (!(seed >= 1 && seed <= SEED_MAX) || !(score >= 0) || !(n >= 1 && n <= 999) || !nick) return null;
  if (!LIGHTS.test(lights) || !(team === '-' || TEAM_IDS.includes(team)) || !(bats === 'L' || bats === 'R')) return null;
  const range = scoreRange(lights, makeSequence(seed, pitcherHand(seed) === 'L'));   // 그 공 순서로 나올 수 있는 전광판이고, 그 전광판으로 낼 수 있는 점수인지
  if (!range || score < range.min || score > range.max) return null;
  return { seed, score, lights, team: team === '-' ? null : team, bats, n, nick };
}

// 이 브라우저가 도전장 공 순서로 친 기록 [{ seed, tries, first }](최근 것부터 DUEL_KEEP개). tries는 그 공으로 판을 시작한 수(보낸 사람이 처음 친 판도 1),
// first는 처음 끝까지 친 판의 점수다. 받은 사람의 첫 판만 승부로 치고, 다시 친 판은 'N번째 도전'으로 보인다(같은 공을 다시 치면 외워서 친다).
// start면 시작한 수를 하나 올리고, score가 있으면 아직 없을 때만 first로 적는다
export const duelEntry = (list, seed) => (Array.isArray(list) ? list.find((r) => r?.seed === seed) : null) ?? null;
export function duelLog(list, seed, { start = false, score = null } = {}) {
  const old = (Array.isArray(list) ? list : []).filter((r) => r && Number.isInteger(r.seed) && Number.isInteger(r.tries) && r.seed !== seed);
  const cur = duelEntry(list, seed);
  const tries = (Number.isInteger(cur?.tries) ? cur.tries : 0) + (start ? 1 : 0), first = Number.isInteger(cur?.first) ? cur.first : score;
  return [{ seed, tries, first }, ...old].slice(0, DUEL_KEEP);
}
