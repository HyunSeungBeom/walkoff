// 이용 통계: 하루에 몇 판, 몇 명이 하는지만 센다(2026-10-29 사용자 결정, 서버는 worker/src/stats.js). 기기에 저장한 무작위 번호,
// 모드, 시작·끝, 터치 기기인지만 보내고 랭킹 ID·닉네임·카카오 계정과는 잇지 않는다. 실제 사이트에서 사람이 친 판만 센다:
// 자동 브라우저(테스트, navigator.webdriver)와 이 컴퓨터에서 연 게임은 빼고, ?api=로 서버를 바꿔 열면 그 서버로 보낸다.
// 결과는 worker 폴더에서 npm run stats
// (2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
import { RANKING_API } from './api.js';
import { store } from './store.js';

const STATS_ON = !navigator.webdriver && (location.hostname === 'hyunseungbeom.github.io' || new URLSearchParams(location.search).has('api'));
function ensureDeviceId() {
  const saved = String(store.get('device', ''));
  if (/^[a-z0-9-]{8,40}$/.test(saved)) return saved;
  const id = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  store.set('device', id);
  return id;
}
// type은 'start'(판 시작)·'end'(판 끝), mode는 그 판의 모드
export function track(type, mode) {
  if (!STATS_ON) return;
  try {
    const body = JSON.stringify({ device: ensureDeviceId(), mode, type, mobile: matchMedia('(pointer: coarse)').matches });
    navigator.sendBeacon(`${RANKING_API}/events`, body);
  } catch { /* 통계를 못 보내도 게임은 그대로 */ }
}
