// 이용 통계: 하루에 몇 판, 몇 명이 하는지만 센다(2026-10-29 사용자 결정, 서버는 worker/src/stats.js). 기기에 저장한 무작위 번호,
// 모드, 시작·끝, 터치 기기인지만 보내고 랭킹 ID·닉네임·카카오 계정과는 잇지 않는다. 실제 사이트에서 사람이 친 판만 센다:
// 자동 브라우저(테스트, navigator.webdriver)와 이 컴퓨터에서 연 게임은 빼고, ?api=로 서버를 바꿔 열면 그 서버로 보낸다.
// 결과는 worker 폴더에서 npm run stats
// (2026-11-04 코드 나누기 3단계에서 main.js에서 옮김. 2026-11-17부터 옛 주소·새 주소(infra/site.js) 모두에서 센다)
// 모아 보내기(2026-11-04): 판 시작·끝마다 보내던 신호가 서버 하루 요청의 65%, DB 쓰기의 60%라 무료 한도(요청·쓰기 하루 10만)에 먼저 걸려서,
// 날짜별로 모드마다 센 묶음 { device, mobile, day, counts: { 모드: { starts, ends } } }을 화면을 떠날 때·20개가 쌓일 때·날짜가 바뀔 때 보낸다.
// 묶음은 저장소에도 적어 두어, 창을 갑자기 닫아 못 보낸 것은 다음에 열 때 보낸다(서버는 이틀 전 것까지 받는다)
// 스윙 결과 수(2026-11-05 조준 타격 실험): 묶음에 swings: { '모드|입력': { swings, contacts, hits, perfect, near, edge, miss } }를 더한다.
// 모드는 'challenge'(지금 조작의 기준선)·'aim', 입력은 'mouse'·'touch'·'key'. 합계뿐이라 사람이나 기기를 알아볼 값은 없다
// 오류 종류(2026-11-18 사용자 '운영 준비', 작업 글 walkoff-ops.md, 서버 error_stats): 화면에서 난 오류(error)와 받지 않은 거절(unhandledrejection)을
// 묶음의 errors: [{ build, src, line, col, name, message, os, browser }]에 싣는다. 우리 파일(js/ 아래)에서 난 것만 세고(브라우저 확장·앱 안 브라우저가 넣은
// 스크립트는 뺀다), 보내는 것은 판(커밋 7자리)·파일·줄·칸, 오류 이름, 지운 메시지(cleanMessage), 기기 갈래, 브라우저 갈래뿐이다. 서버는 기기 번호 없이 기기 수만 센다.
// 같은 오류는 기기마다 하루 한 번, 하루 3가지까지(쓰기 한도). 오류 칸도 서버의 묶음 칸 상한(BATCH_KEYS)에 들어서, 칸이 차면 먼저 보내고 새 묶음을 연다.
// index.html이 move.js 다음, 게임(main.js)보다 먼저 이 모듈을 따로 띄워서 게임 모듈이 아예 못 떠도(문법 오류·파일 못 받음) 센다.
// 옛 주소에서 move.js가 새 주소로 보내며 일부러 멈출 때(MOVE_ON)는 세지 않는다
import { RANKING_API } from './api.js';
import { MOVE_ON, OLD_SITE, siteOf } from './site.js';
import { store } from './store.js';

const SITE = siteOf(location.href);
const STATS_ON = !navigator.webdriver && (SITE != null || new URLSearchParams(location.search).has('api')) && !(MOVE_ON && SITE === OLD_SITE);
const FLUSH_EVENTS = 20, QUEUE_KEY = 'statsQueue';
export const BATCH_KEYS = 7;   // 묶음 하나의 모드·스윙·오류 칸 수 상한(서버 worker/src/stats.js와 같다)
const ERRORS_PER_DAY = 3, SEEN_KEY = 'errorsSeen', MESSAGE_MAX = 80;
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 서버(worker/src/rules.js kstDay)와 같은 한국 시간 날짜
let queue = null;   // { day, counts, swings?, errors?, n }. 저장소를 못 쓰는 브라우저(사생활 보호 모드)도 이 판 동안은 모아 보낸다

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
    const body = JSON.stringify({
      device: ensureDeviceId(), mobile: matchMedia('(pointer: coarse)').matches, day: q.day, counts: q.counts,
      ...(q.swings ? { swings: q.swings } : {}), ...(q.errors?.length ? { errors: q.errors } : {}),
    });
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
// 새 칸(모드·스윙·오류)을 하나 더할 오늘 묶음. 칸이 서버 상한만큼 차 있으면 먼저 보내고 새 묶음을 연다. 못 보내 그대로 차 있으면 null(이번 것은 세지 않는다)
const keysOf = (q) => Object.keys(q.counts).length + Object.keys(q.swings ?? {}).length + (q.errors?.length ?? 0);
function roomFor(isNew) {
  if (isNew && keysOf(today()) >= BATCH_KEYS) flush();
  const q = today();
  return isNew && keysOf(q) >= BATCH_KEYS ? null : q;
}
function added() {
  queue.n += 1;
  store.set(QUEUE_KEY, queue);
  if (queue.n >= FLUSH_EVENTS) flush();
}

// type은 'start'(판 시작)·'end'(판 끝), mode는 그 판의 모드
export function track(type, mode) {
  if (!STATS_ON) return;
  const q = roomFor(!today().counts[mode]);
  if (!q) return;
  const c = (q.counts[mode] ??= { starts: 0, ends: 0 });
  c[type === 'start' ? 'starts' : 'ends'] += 1;
  added();
}

// 스윙 하나: mode는 'challenge'·'aim', input은 'mouse'·'touch'·'key', r은 판정 결과(맞힘은 파울 포함, aimZone은 조준 판만)
export function trackSwing(mode, input, r) {
  if (!STATS_ON) return;
  const key = `${mode}|${input}`, q = roomFor(!today().swings?.[key]);
  if (!q) return;
  const s = ((q.swings ??= {})[key] ??= { swings: 0, contacts: 0, hits: 0, perfect: 0, near: 0, edge: 0, miss: 0 });
  s.swings += 1;
  if (r.kind !== 'whiff') s.contacts += 1;
  if (r.hit) s.hits += 1;
  if (r.perfect) s.perfect += 1;
  if (r.aimZone) s[r.aimZone] += 1;
  added();
}

// 오류 메시지에서 사람이나 주소를 알아볼 수 있는 것을 지운다: 주소(물음표 뒤 포함)·메일, 큰따옴표 안(JSON 조각처럼 받은 글), 이름이 아닌 작은따옴표 안,
// 영문 밖의 글자(한글 닉네임·팀), 네 자리 넘는 숫자(시드·번호). 서버(worker/src/stats.js cleanErrorMessage)와 같은 규칙이고 서버가 한 번 더 지운다
export function cleanMessage(s) {
  return String(s ?? '').replace(/\s+/g, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '…')
    .replace(/\S+@\S+/g, '…')
    .replace(/"[\s\S]*"/g, '"…"')
    .replace(/'([^']*)'/g, (q, s) => (/^[\w$.]{1,40}$/.test(s) ? q : "'…'"))
    .replace(/[^\x20-\x7e…]+/g, '…')
    .replace(/\d{4,}/g, '#')
    .replace(/…(?: ?…)+/g, '…')
    .trim().slice(0, MESSAGE_MAX).trim();
}

const BUILD = /\/js-([0-9a-f]{7})\//.exec(import.meta.url)?.[1] ?? 'local';   // 이 판의 커밋(배포한 js 폴더 이름). 이 컴퓨터에서 연 게임은 local
const NOWHERE = { build: BUILD, src: '?', line: 0, col: 0 };   // 어디서 났는지 모르는 거절(스택이 없는 값)
const UA = navigator.userAgent;
const OS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1) ? 'ios'
  : /Android/.test(UA) ? 'android' : /Windows/.test(UA) ? 'windows' : /Macintosh/.test(UA) ? 'mac' : 'other';
// 브라우저 큰 갈래. 앱 안 브라우저(카카오톡·네이버·인스타그램·페이스북)를 먼저 본다(그 안에 크롬·사파리 글자도 있어서)
const BROWSER = [['kakao', /KAKAOTALK/i], ['naver', /NAVER\(inapp/], ['instagram', /Instagram/], ['facebook', /FBAN|FBAV/], ['whale', /Whale\//],
  ['samsung', /SamsungBrowser/], ['edge', /Edg(?:e|A|iOS)?\//], ['firefox', /Firefox|FxiOS/], ['chrome', /Chrome|CriOS/], ['safari', /Safari/]]
  .find(([, re]) => re.test(UA))?.[0] ?? 'other';

// 우리 파일의 자리 { build, src, line, col }. 다른 출처(확장·앱 안 브라우저 스크립트)이거나 js/ 밖(페이지 안에 넣은 스크립트)이면 null
function ourPlace(url, line, col) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.origin === location.origin ? /\/js(?:-([0-9a-f]{7}))?\/((?:[a-z]+\/)?[a-z0-9-]+\.js)$/.exec(u.pathname) : null;
  return m && { build: m[1] ?? 'local', src: m[2], line: Math.max(0, line | 0), col: Math.max(0, col | 0) };
}
// 스택에서 처음 나오는 우리 파일 자리(크롬 'at f (주소:줄:칸)', 사파리·파이어폭스 'f@주소:줄:칸')
function stackPlace(stack) {
  for (const m of String(stack ?? '').matchAll(/(https?:\/\/[^\s()@]+?):(\d+):(\d+)/g)) {
    const p = ourPlace(m[1], +m[2], +m[3]);
    if (p) return p;
  }
  return null;
}
const nameOf = (x) => { const n = String(x?.name ?? 'Error'); return /^[A-Za-z]{1,40}$/.test(n) ? n : 'Error'; };

// 오류 신호 하나를 보낼 값으로. 우리 파일에서 난 것이 아니면 null
function errorOf(e) {
  const of = (at, name, message) => ({ ...at, name, message: cleanMessage(message), os: OS, browser: BROWSER });
  if (e.type === 'unhandledrejection') {
    const r = e.reason;
    if (!(r instanceof Object)) return of(NOWHERE, r === null ? 'null' : typeof r, '');   // 오류가 아닌 값으로 거절했다(받은 글일 수 있어서 메시지는 안 보낸다)
    const stack = typeof r.stack === 'string' ? r.stack : '', at = stackPlace(stack);
    if (!at && /:\d+:\d+/.test(stack)) return null;   // 스택이 남의 스크립트만 가리킨다
    return of(at ?? NOWHERE, nameOf(r), typeof r.message === 'string' ? r.message : '');
  }
  if (e instanceof ErrorEvent) {
    const at = ourPlace(e.filename, e.lineno, e.colno) ?? stackPlace(e.error?.stack);
    return at && of(at, nameOf(e.error), e.error?.message ?? e.message);
  }
  const at = e.target instanceof HTMLScriptElement ? ourPlace(e.target.src, 0, 0) : null;   // 스크립트 파일을 못 받았다(모듈 404·망 끊김). 그림·소리 파일은 안 센다
  return at && of(at, 'LoadError', '');
}

let seen = null;   // { day, keys }: 오늘 이 기기에서 센 오류. 저장소에도 적어 새로고침해도 다시 세지 않는다
function noteError(e) {
  try {
    const r = errorOf(e);
    if (!r) return;
    const day = kstDay(), key = [r.build, r.src, r.line, r.col, r.name, r.message].join('|');
    if (seen?.day !== day) {
      const s = store.get(SEEN_KEY, null);
      seen = s?.day === day && Array.isArray(s.keys) ? s : { day, keys: [] };
    }
    if (seen.keys.includes(key) || seen.keys.length >= ERRORS_PER_DAY) return;
    const q = roomFor(true);
    if (!q) return;
    seen.keys.push(key);
    store.set(SEEN_KEY, seen);
    (q.errors ??= []).push(r);
    added();
  } catch { /* 오류를 세다가 난 오류는 버린다(게임은 그대로, 오류 신호가 또 나지 않게) */ }
}

if (STATS_ON) {
  const left = store.get(QUEUE_KEY, null);   // 지난번에 못 보낸 묶음(창을 갑자기 닫았거나 보내기가 막혔을 때)
  if (left?.n > 0 && left.counts) {
    flush(left);
    if (store.get(QUEUE_KEY, null) && left.day === kstDay()) queue = left;   // 또 못 보낸 오늘 묶음은 이어서 모은다(전에는 새 묶음이 덮어써서 그 판 수가 사라졌다)
  }
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  addEventListener('pagehide', () => flush());
  addEventListener('error', noteError, true);   // 붙잡는 단계에서 들어서 스크립트 파일을 못 받은 것(창까지 올라오지 않는 신호)도 받는다
  addEventListener('unhandledrejection', noteError);
}
