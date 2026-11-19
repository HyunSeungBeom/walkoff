// 친구 도전장(2026-11-16 사용자 '추천 순서대로'): 끝낸 10구 판을 같은 공 순서로 친구에게 보내 겨룬다. 주소 ?vs=에 판을 싣고,
// 받은 쪽은 그 값을 믿지 않고 검사한다. 서명은 하지 않는다(랭킹이 없고, 그 공 순서와 전광판 불로 낼 수 있는 점수인지만 본다.
// 2026-11-19 사용자 '닉네임 검사만': 남의 닉네임으로 만든 주소는 못 막고, 욕·투명 글자를 넣은 닉네임은 '친구'로 보인다).
// 꼴: 판 글자.시드.점수.불.팀.타석.닉네임.번째. 시드·점수·번째는 36진수, 팀이 없으면 '-', 닉네임은 UTF-8 base64url(마침표가 안 나온다).
// 끝이 번째(영문·숫자)라서 메신저가 주소 끝의 '-'·'_'를 링크에서 떼어 내지 않는다
// 판 글자 'a'는 정통파 공 순서(core makeSequence·pitcherHand, 투수 유형이 생기기 전과 같은 공)다. 'b'는 판 글자 뒤에 투수 유형 id(core PITCHER_STYLES)를
// 한 칸 더 싣는다(이번 주 투수, 2026-11-16). 정통파 판은 지금도 a로 써서 옛 주소와 같다. 공 만드는 법이 또 바뀌면 글자를 바꿔 옛 주소와 가른다
import { TEAM_IDS } from '../core/catalog.js';
import { isStyle, makeSequence, pitcherHand } from '../core/pitches.js';
import { scoreRange } from '../core/score.js';
import { checkNick } from '../core/nick.js';

export const DUEL_KEEP = 30;          // 이 브라우저가 기억하는 도전장 공 순서 수(최근 것부터)
const SEED_MAX = 2147483647;           // 서버 시드(1 ~ 2^31-1, worker/src/seeds.js)와 기기 시드(시각 % 2147483647)
const LIGHTS = /^[SDTHYR]{1,40}$/;     // core가 쓰는 불(공 40개). 안타 종류를 모르는 예전 G는 받지 않는다

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
// 서버와 같은 닉네임 규칙(core/nick.js: 한글·영문·숫자 10자까지, 욕·사칭 목록)에 맞으면 그 닉네임(앞뒤 빈칸을 뺀 값), 아니면 null.
// 화면에는 캔버스로만 그린다(HTML에 넣지 않는다)
export function cleanNick(nick) {
  const c = checkNick(typeof nick === 'string' ? nick : '');
  return c.ok ? c.nick : null;
}

// d: { seed, score, lights, team(id나 null), bats('L'·'R'), n(그 공으로 몇 번째 친 판인지), nick, style(투수 유형 id, 없으면 정통파) }
export function duelCode(d) {
  const style = isStyle(d.style) ? d.style : 'classic';
  return [...(style === 'classic' ? ['a'] : ['b', style]), d.seed.toString(36), d.score.toString(36), d.lights, d.team ?? '-', d.bats, toB64(d.nick), d.n.toString(36)].join('.');
}

// 주소의 ?vs= 값을 검사해 d로 돌려준다. 하나라도 틀리면 null(그때 게임은 도전장 없이 연다).
// 닉네임만은 규칙에 안 맞아도(욕·투명 글자·망가진 글자) 도전장을 열고 nick을 null로 준다. 게임은 보낸 사람을 '친구'로 보인다
export function parseDuel(code) {
  const f = String(code ?? '').split('.');
  const style = f[0] === 'a' && f.length === 8 ? 'classic' : f[0] === 'b' && f.length === 9 && isStyle(f[1]) ? f[1] : null;
  if (!style) return null;
  const [s36, score36, lights, team, bats, nick64, n36] = f.slice(-7);
  const seed = int36(s36), score = int36(score36), n = int36(n36), nick = cleanNick(fromB64(nick64));
  if (!(seed >= 1 && seed <= SEED_MAX) || !(score >= 0) || !(n >= 1 && n <= 999)) return null;
  if (!LIGHTS.test(lights) || !(team === '-' || TEAM_IDS.includes(team)) || !(bats === 'L' || bats === 'R')) return null;
  const range = scoreRange(lights, makeSequence(seed, pitcherHand(seed) === 'L', style));   // 그 투수 유형의 공 순서로 나올 수 있는 전광판이고, 그 전광판으로 낼 수 있는 점수인지
  if (!range || score < range.min || score > range.max) return null;
  return { seed, score, lights, team: team === '-' ? null : team, bats, n, nick, style };
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
