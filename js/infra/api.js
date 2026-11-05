// 랭킹 서버(worker/, Cloudflare Workers + D1)와 주고받기: 서버 주소, 로그인 표, 요청.
// 받은 답으로 판 상태·지갑·화면을 바꾸는 일은 main이 한다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
import { store } from './store.js';

// 주소 뒤에 ?api=주소를 붙이면 이 컴퓨터에서 띄운 서버(worker의 wrangler dev)를 쓴다.
// ?api=는 이 컴퓨터 주소(http의 localhost·127.0.0.1, 서버 allowedReturn과 같다)만 받는다. 아무 주소나 받으면 로그인한 사람이 남이 만든 링크를 열었을 때
// 로그인 표가 그 주소로 간다(2026-11-02 보안 점검). 테스트는 실제 서버 주소를 가로채 가짜로 답한다
function localApi(raw) {
  let u;
  try { u = new URL(raw); } catch { return ''; }
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') ? u.origin : '';
}
export const RANKING_API = localApi(new URLSearchParams(location.search).get('api')) || 'https://walkoff-api.walkoff-api.workers.dev';

// 카카오 로그인(auth.js)으로 받은 로그인 표. 카카오와 주고받는 일은 랭킹 서버가 하고,
// 게임은 서버가 준 로그인 표만 이 브라우저에 둔다. 카카오 회원번호나 카카오 토큰은 게임에 오지 않는다
export const auth = { token: String(store.get('session', '')) || null, fresh: false };
export const loggedIn = () => !!auth.token;

export function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  return fetch(`${RANKING_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// 10구 도전 점수와 끝내기 상황 판을 보낸다. 답의 상태 번호와 내용을 돌려준다
export async function postScore(body) {
  const res = await api('/scores', { method: 'POST', body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
export async function postScenario(body) {
  const res = await api('/scenario', { method: 'POST', body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// 이번 주 랭킹. playerId는 이 브라우저의 랭킹 ID(서버가 내 줄을 표시한다)
export async function fetchRanking(playerId) {
  const res = await fetch(`${RANKING_API}/rankings?player=${encodeURIComponent(playerId)}`);
  if (!res.ok) throw Object.assign(new Error(`ranking ${res.status}`), { status: res.status });   // 429면 서버 횟수 제한(잠시 뒤 다시)
  return res.json();
}
