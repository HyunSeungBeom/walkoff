// 모르는 사람과 대결(2026-11-23 사용자 '모르는 사람과 대결'): 랭킹 서버(worker/src/rival.js)가 골라 준 다른 사람의 하루 최고 판을 도전장(duel.js)처럼
// 같은 공으로 겨룬다. 서버 답도 믿지 않고 도전장 주소와 같은 검사(checkDuel)를 한다. 상대와 처음 친 판만 이 기기 전적(main.js walkoff.rivals)에 센다
import { checkDuel } from './duel.js';

export const RIVAL_FROM = '2026-12-01';   // 대결을 여는 첫날(한국 시간). 서버 worker/src/rival.js RIVAL_FROM과 같다(처리방침 5절을 알린 날 + 7일)
export const rivalOpen = (day) => day >= RIVAL_FROM;

// 서버 답의 rival({ seed, style, bats, score, lights, nick, team })을 겨룰 판 d로(game.duel에 넣고 rival 표시를 단다). 틀리면 null.
// 대결 상대는 랭킹 판이라 늘 팀이 있다
export function parseRival(r) {
  if (!r || typeof r !== 'object') return null;
  const d = checkDuel({ seed: r.seed, score: r.score, lights: r.lights, team: r.team, bats: r.bats, n: 1, nick: r.nick, style: r.style });
  return d && d.team ? { ...d, rival: true } : null;
}

// 이 기기의 대결 전적 { w, l, d }(이김·짐·비김)에 한 판(diff = 내 점수 - 상대 점수)을 더한다. 망가진 값은 0으로 본다
export function rivalRecord(rec, diff) {
  const r = Object.fromEntries(['w', 'l', 'd'].map((k) => [k, Number.isInteger(rec?.[k]) && rec[k] > 0 ? rec[k] : 0]));
  r[diff > 0 ? 'w' : diff < 0 ? 'l' : 'd'] += 1;
  return r;
}
// 전적 글: '3승 1패', 비김이 있으면 '3승 1패 1무'(KBO 순위표처럼 승·패·무). 친 판이 없으면 ''
export function rivalText(rec) {
  const [w, l, d] = ['w', 'l', 'd'].map((k) => (Number.isInteger(rec?.[k]) && rec[k] > 0 ? rec[k] : 0));
  return w + l + d ? `${w}승 ${l}패${d ? ` ${d}무` : ''}` : '';
}
