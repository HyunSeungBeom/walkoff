// 이용 통계: 하루에 몇 판, 몇 명이 하는지만 센다(2026-10-29 사용자 결정, 서버는 worker/src/stats.js). 기기에 저장한 무작위 번호,
// 모드, 시작·끝, 터치 기기인지만 보내고 랭킹 ID·닉네임·카카오 계정과는 잇지 않는다. 실제 사이트에서 사람이 친 판만 센다:
// 자동 브라우저(테스트, navigator.webdriver)와 이 컴퓨터에서 연 게임은 빼고, ?api=로 서버를 바꿔 열면 그 서버로 보낸다.
// 결과는 worker 폴더에서 npm run stats
// (2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
// 모아 보내기(2026-11-04): 판 시작·끝마다 보내던 신호가 서버 하루 요청의 65%, DB 쓰기의 60%라 무료 한도(요청·쓰기 하루 10만)에 먼저 걸려서,
// 날짜별로 모드마다 센 묶음 { device, mobile, day, counts: { 모드: { starts, ends } } }을 화면을 떠날 때·20개가 쌓일 때·날짜가 바뀔 때 보낸다.
// 묶음은 저장소에도 적어 두어, 창을 갑자기 닫아 못 보낸 것은 다음에 열 때 보낸다(서버는 이틀 전 것까지 받는다)
// 스윙 결과 수(2026-11-05 조준 타격 실험): 묶음에 swings: { '모드|입력': { swings, contacts, hits, perfect, near, edge, miss } }를 더한다.
// 모드는 'challenge'(지금 조작의 기준선)·'aim', 입력은 'mouse'·'touch'·'key'. 합계뿐이라 사람이나 기기를 알아볼 값은 없다
import { RANKING_API } from './api.js';
import { store } from './store.js';

const STATS_ON = !navigator.webdriver && (location.hostname === 'hyunseungbeom.github.io' || new URLSearchParams(location.search).has('api'));
const FLUSH_EVENTS = 20, QUEUE_KEY = 'statsQueue';
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 서버(worker/src/rules.js kstDay)와 같은 한국 시간 날짜
let queue = null;   // { day, counts, swings?, n }. 저장소를 못 쓰는 브라우저(사생활 보호 모드)도 이 판 동안은 모아 보낸다

function ensureDeviceId() {
  const saved = String(store.get('device', ''));
  if (/^[a-z0-9-]{8,40}$/.test(saved)) return saved;
  const id = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  store.set('device', id);
  return id;
}

// 모은 묶음을 보낸다. 보내기를 받아 주면(sendBeacon이 true) 비우고, 못 보내면 남겨 두었다가 다음에 다시 보낸다
function flush(q = queue) {
  if (!q?.n) return;
  try {
    const body = JSON.stringify({ device: ensureDeviceId(), mobile: matchMedia('(pointer: coarse)').matches, day: q.day, counts: q.counts, ...(q.swings ? { swings: q.swings } : {}) });
    if (!navigator.sendBeacon(`${RANKING_API}/events`, body)) return;
  } catch { return; /* 통계를 못 보내도 게임은 그대로 */ }
  if (q === queue) queue = null;
  store.remove(QUEUE_KEY);
}

// 오늘 묶음. 날짜가 바뀌면 지난날 묶음을 먼저 보낸다(못 보내면 버린다)
function today() {
  const day = kstDay();
  if (queue && queue.day !== day) { flush(); queue = null; }
  return (queue ??= { day, counts: {}, n: 0 });
}
function added() {
  queue.n += 1;
  store.set(QUEUE_KEY, queue);
  if (queue.n >= FLUSH_EVENTS) flush();
}

// type은 'start'(판 시작)·'end'(판 끝), mode는 그 판의 모드
export function track(type, mode) {
  if (!STATS_ON) return;
  const c = (today().counts[mode] ??= { starts: 0, ends: 0 });
  c[type === 'start' ? 'starts' : 'ends'] += 1;
  added();
}

// 스윙 하나: mode는 'challenge'·'aim', input은 'mouse'·'touch'·'key', r은 판정 결과(맞힘은 파울 포함, aimZone은 조준 판만)
export function trackSwing(mode, input, r) {
  if (!STATS_ON) return;
  const q = today(), s = ((q.swings ??= {})[`${mode}|${input}`] ??= { swings: 0, contacts: 0, hits: 0, perfect: 0, near: 0, edge: 0, miss: 0 });
  s.swings += 1;
  if (r.kind !== 'whiff') s.contacts += 1;
  if (r.hit) s.hits += 1;
  if (r.perfect) s.perfect += 1;
  if (r.aimZone) s[r.aimZone] += 1;
  added();
}

if (STATS_ON) {
  const left = store.get(QUEUE_KEY, null);   // 지난번에 못 보낸 묶음(창을 갑자기 닫았거나 보내기가 막혔을 때)
  if (left?.n > 0 && left.counts) {
    flush(left);
    if (store.get(QUEUE_KEY, null) && left.day === kstDay()) queue = left;   // 또 못 보낸 오늘 묶음은 이어서 모은다(전에는 새 묶음이 덮어써서 그 판 수가 사라졌다)
  }
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  addEventListener('pagehide', () => flush());
}
