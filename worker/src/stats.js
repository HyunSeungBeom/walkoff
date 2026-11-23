// 하루 이용 통계(2026-10-29 사용자 결정). 사람이 아니라 게임이 기기에 저장한 무작위 번호로 센다.
// 랭킹 ID·닉네임·카카오 계정과는 잇지 않고, 날짜·모드별 판 수와 그날 기기 수만 남긴다
import { addDays } from './rules.js';

// aim: 조준 타격(실험, 2026-11-05). duel: 친구 도전장으로 연 10구 판, invite: 도전장을 보낸 수(10구 끝 화면 공유를 누른 수, 2026-11-16).
// invite는 판이 아니라서 starts에만 세고(ends는 늘 0) 아래 표의 시작한 판·끝낸 판 합계에서 뺀다(표를 새로 만들지 않으려고 같은 표에 둔다).
// move: 옛 주소(github.io)의 기록을 새 주소(walkoff.kr)로 가져온 기기 수(2026-11-17 주소 옮기기, js/infra/move.js). invite처럼 starts에만 세고 판 합계에서 뺀다
export const MODES = ['daily', 'challenge', 'scenario', 'practice', 'aim', 'duel', 'invite', 'move'];
const NOT_PLAYS = "('invite', 'move')";   // 판이 아닌 모드
// 스윙 결과 수(2026-11-05 조준 타격 실험): 모드·입력마다 스윙·맞힘(파울 포함)·안타·정타 수와 조준 자리(near·edge·miss) 수의 합계
export const SWING_MODES = ['challenge', 'aim'], SWING_INPUTS = ['mouse', 'touch', 'key'];
const SWING_KEYS = ['swings', 'contacts', 'hits', 'perfect', 'near', 'edge', 'miss'];
export const EVENT_CAP = 3000;   // 한 기기가 하루에 보내는 신호는 이만큼까지만 센다(새로고침 반복이나 장난으로 숫자가 부풀지 않게)
export const BATCH_MAX = 500;    // 묶음 하나에 받는 신호 수. 게임은 20개가 쌓이면 보낸다(js/infra/stats.js)
// 묶음 하나에 받는 모드·스윙 칸 수의 합(2026-11-18 사용자, 홍보 전 서버 지키기). 칸마다 DB에 한 줄을 써서, 모드·스윙 칸을 다 채운 묶음은
// 새 기기 줄(2줄)과 함께 한 번에 15줄이었다(로그인 없이 IP 하나로 1시간이면 하루 쓰기 한도). 이제 많아야 9줄이고, 정상 묶음은 2~4칸이다.
// 판 번호를 실은 묶음(FUNNEL_FROM부터)은 10구 판별 칸(build_stats)도 들어서 정상 묶음은 3~5칸이다(게임 js/infra/stats.js도 같은 상한으로 나눠 보낸다)
export const BATCH_KEYS = 7;
export const LATE_DAYS = 2;      // 화면을 갑자기 닫아 못 보낸 묶음은 다음에 열 때 보낸다. 그날부터 이틀 지난 것까지 받는다
// 기기별 줄(play_devices, 무작위 번호가 든 유일한 표)은 90일이 지나면 지운다(2026-11-18 사용자, 처리방침 3절). 따로 도는 일 없이 묶음을 받을 때 같이 지운다.
// 날짜가 기본 키 맨 앞이라 지울 줄만 읽고, 지울 줄은 하루에 한 번(그날 처음 받은 묶음) 생긴다. 날짜별 합계(play_stats 등)는 누구인지 알 수 없어 그대로 둔다
export const DEVICE_DAYS = 90;
// 오류 종류(2026-11-18 사용자 '운영 준비', 작업 글 walkoff-ops.md): 묶음에 errors: [{ build, src, line, col, name, message, os, browser }]를 더한다.
// 게임(js/infra/stats.js)이 우리 파일에서 난 오류만 골라 같은 오류는 기기마다 하루 한 번 보내고, 서버는 그날 그 오류를 낸 기기 수만 센다(error_stats, 기기 번호는 안 남긴다).
// 오류 칸도 BATCH_KEYS에 들어서 묶음 하나가 쓰는 줄은 그대로다. 메시지는 서버도 한 번 더 지운다(cleanErrorMessage)
export const ERROR_OS = ['ios', 'android', 'windows', 'mac', 'other'];
export const ERROR_BROWSERS = ['kakao', 'naver', 'instagram', 'facebook', 'whale', 'samsung', 'edge', 'firefox', 'chrome', 'safari', 'other'];
export const ERROR_MESSAGE_MAX = 80;
const ERROR_COLS = ['build', 'src', 'line', 'col', 'name', 'message', 'os', 'browser'];

// 오류 메시지에서 사람이나 주소를 알아볼 수 있는 것을 지운다: 주소(물음표 뒤 포함)·메일, 큰따옴표 안(JSON 조각처럼 받은 글), 이름이 아닌 작은따옴표 안,
// 영문 밖의 글자(한글 닉네임·팀), 네 자리 넘는 숫자(시드·번호). 게임(js/infra/stats.js cleanMessage)과 같은 규칙이고, 두 번 지워도 그대로다
export function cleanErrorMessage(s) {
  return String(s ?? '').replace(/\s+/g, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '…')
    .replace(/\S+@\S+/g, '…')
    .replace(/"[\s\S]*"/g, '"…"')
    .replace(/'([^']*)'/g, (q, s) => (/^[\w$.]{1,40}$/.test(s) ? q : "'…'"))
    .replace(/[^\x20-\x7e…]+/g, '…')
    .replace(/\d{4,}/g, '#')
    .replace(/…(?: ?…)+/g, '…')
    .trim().slice(0, ERROR_MESSAGE_MAX).trim();
}

// 오류 한 칸을 검사해 [build, src, line, col, name, message, os, browser]로 바꾼다. 모양이 틀리면 null.
// build는 배포한 커밋 7자리(이 컴퓨터는 local), src는 js/ 아래 파일(어디서 났는지 모르는 거절은 ?), 줄·칸은 0 이상
function checkError(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const { build, src, line, col, name, message, os, browser } = x;
  if (typeof build !== 'string' || !/^(?:[0-9a-f]{7}|local)$/.test(build)) return null;
  if (typeof src !== 'string' || !(src === '?' || /^(?:[a-z]+\/)?[a-z0-9-]{1,40}\.js$/.test(src))) return null;
  if (![line, col].every((v) => Number.isInteger(v) && v >= 0 && v <= 10_000_000)) return null;
  if (typeof name !== 'string' || !/^[A-Za-z]{1,40}$/.test(name)) return null;
  if (typeof message !== 'string' || message.length > 200) return null;
  if (!ERROR_OS.includes(os) || !ERROR_BROWSERS.includes(browser)) return null;
  return [build, src, line, col, name, cleanErrorMessage(message), os, browser];
}

// 첫 주 숫자(2026-11-19 사용자 '첫 주 숫자 장치', 작업 글 walkoff-first-week-stats.md): 묶음에 셋을 더 받는다. 없으면(예전 게임) 그대로 받는다.
// 처리방침에 새로 받는 정보를 7일 전에 알려야 해서 FUNNEL_FROM(한국 시간) 날짜의 묶음부터 받는다(2026-11-23 사용자). 그 전 날짜의 묶음은 셋을 없는 것으로 보고
// 나머지만 센다(예전 서버와 같다). 날짜는 묶음 날짜(서버 날짜보다 뒤면 서버 날짜)로 봐서 기기 시계가 빨라도 먼저 받지 않는다
//  build: 게임 판(배포한 커밋 7자리, 이 컴퓨터는 local). 10구 판(TEN_MODES)은 판별 표(build_stats)에 한 줄 더 쓰고, 그 줄도 BATCH_KEYS에 든다
//  first: 처음 온 기기의 첫날 { path, steps }. 그날 기기 줄(play_devices)에 들어온 길(처음 받은 값)과 간 단계(받은 것을 합친다)를 남긴다
//  10구 counts의 restarts·leaves·backs: 끝내지 않고 새 판을 연 수, 끝내지 않고 화면을 숨긴 수, 숨겼다 돌아와 그 판을 끝내거나 새 판을 연 수(나감 = leaves - backs)
export const FUNNEL_FROM = '2026-11-30';   // 게임(js/infra/stats.js FUNNEL_FROM)과 같다
export const TEN_MODES = ['challenge', 'duel'];
export const PATHS = ['duel', 'link', 'move'];   // 들어온 길: 도전장 주소(?vs=), 그냥 링크, 옛 주소에서 기록을 가져옴
export const STEPS = { open: 1, swing: 2, end: 4, again: 8 };   // 첫날 단계: 처음 연 것, 첫 스윙, 첫 10구 끝, 10구를 끝낸 뒤 새 판(js/infra/stats.js STEP과 같다)
const STEPS_ALL = Object.values(STEPS).reduce((a, x) => a | x, 0);   // 단계를 다 간 수(15)
const TEN_KEYS = ['restarts', 'leaves', 'backs'], BUILD_KEYS = ['starts', 'ends', ...TEN_KEYS];

// 신호를 검사해 { device, mobile, day, build, first, counts: [[모드, 시작, 끝, 다시 시작, 숨김, 돌아옴], ...], swings: [[모드, 입력, ...SWING_KEYS], ...], errors, n }으로 바꾼다.
// today는 서버의 한국 시간 날짜.
// 묶음(2026-11-04): { device, mobile, day, counts: { 모드: { starts, ends } } }. 판 시작·끝마다 보내던 신호가 하루 요청의 65%, DB 쓰기의 60%라
// 무료 한도(요청 하루 10만 번·쓰기 10만 줄)에 먼저 걸려서 게임이 모아 보낸다. 예전 게임의 한 건 { device, mode, type, mobile }도 그대로 받는다
export function validateEvent(b, today) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const device = String(b.device ?? ''), mobile = b.mobile === true;
  if (!/^[a-z0-9-]{8,40}$/.test(device)) return { ok: false, error: 'bad_device' };
  if (b.counts === undefined) {   // 예전 게임의 한 건
    const mode = String(b.mode ?? ''), type = String(b.type ?? '');
    if (!MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    if (type !== 'start' && type !== 'end') return { ok: false, error: 'bad_type' };
    return { ok: true, value: { device, mobile, day: today, build: null, first: null, counts: [[mode, type === 'start' ? 1 : 0, type === 'end' ? 1 : 0, 0, 0, 0]], swings: [], n: 1 } };
  }
  // 날짜는 게임이 모은 날(기기 시계). 서버 날짜보다 뒤면 오늘로, 이틀보다 앞이면 받지 않는다(맨 끝에서). 첫 주 숫자는 이 날짜가 FUNNEL_FROM부터일 때만 읽는다
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day ?? '')) ? String(b.day) : today, day = asked > today ? today : asked, funnel = day >= FUNNEL_FROM;
  if (!b.counts || typeof b.counts !== 'object' || Array.isArray(b.counts)) return { ok: false, error: 'bad_counts' };
  const counts = [];
  for (const [mode, c] of Object.entries(b.counts)) {
    if (!MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    const { starts, ends } = c ?? {}, ten = TEN_KEYS.map((k) => (funnel ? c?.[k] ?? 0 : 0));   // 다시 시작·숨김·돌아옴은 없으면 0(예전 게임, 10구 밖 모드, FUNNEL_FROM 전)
    if (![starts, ends, ...ten].every((x) => Number.isInteger(x) && x >= 0)) return { ok: false, error: 'bad_counts' };
    if (!TEN_MODES.includes(mode) && ten.some((x) => x > 0)) return { ok: false, error: 'bad_counts' };   // 다시 시작·나감은 10구 판만
    if (starts + ends + ten.reduce((a, x) => a + x, 0) > 0) counts.push([mode, starts, ends, ...ten]);
  }
  // 스윙 묶음 { '모드|입력': { swings, contacts, hits, perfect, near, edge, miss } }. 없으면(예전 게임) 그대로 받는다
  const swings = [];
  if (b.swings !== undefined) {
    if (!b.swings || typeof b.swings !== 'object' || Array.isArray(b.swings)) return { ok: false, error: 'bad_swings' };
    for (const [key, c] of Object.entries(b.swings)) {
      const [mode, input, extra] = key.split('|'), v = SWING_KEYS.map((k) => c?.[k]);
      if (extra !== undefined || !SWING_MODES.includes(mode) || !SWING_INPUTS.includes(input)) return { ok: false, error: 'bad_swings' };
      if (!v.every((x) => Number.isInteger(x) && x >= 0)) return { ok: false, error: 'bad_swings' };
      const [sw, contacts, hits, perfect, near, edge, miss] = v;
      if (contacts > sw || hits > contacts || perfect > contacts || near + edge + miss > sw) return { ok: false, error: 'bad_swings' };
      if (sw > 0) swings.push([mode, input, ...v]);
    }
  }
  // 오류 칸(2026-11-18). 없으면(예전 게임) 그대로 받는다. 하나라도 모양이 틀리면 묶음째 거절한다
  const errors = [];
  if (b.errors !== undefined) {
    if (!Array.isArray(b.errors) || b.errors.length > BATCH_KEYS) return { ok: false, error: 'bad_errors' };
    for (const x of b.errors) {
      const v = checkError(x);
      if (!v) return { ok: false, error: 'bad_errors' };
      errors.push(v);
    }
  }
  // 게임 판(2026-11-19). 커밋 7자리나 local만 받는다
  if (funnel && b.build !== undefined && !(typeof b.build === 'string' && /^(?:[0-9a-f]{7}|local)$/.test(b.build))) return { ok: false, error: 'bad_build' };
  const build = funnel ? b.build ?? null : null;
  // 처음 온 기기의 첫날(2026-11-19). 들어온 길은 갈래 이름만, 단계는 STEPS를 더한 수만 받는다
  const f = funnel ? b.first : undefined;
  if (f !== undefined && !(f && typeof f === 'object' && PATHS.includes(f.path) && Number.isInteger(f.steps) && f.steps >= 0 && f.steps <= STEPS_ALL)) return { ok: false, error: 'bad_first' };
  const first = f ? { path: f.path, steps: f.steps } : null;
  // DB에 쓸 칸: 판 수(시작·끝이 있는 모드), 10구 판별 칸(판을 실었을 때), 스윙, 오류
  const plays = counts.filter(([, a, z]) => a + z > 0).length, tens = build ? counts.filter(([mode]) => TEN_MODES.includes(mode)).length : 0;
  if (plays + tens + swings.length + errors.length > BATCH_KEYS) return { ok: false, error: 'bad_counts' };
  const n = counts.reduce((s, [, ...v]) => s + v.reduce((a, x) => a + x, 0), 0) + swings.reduce((s, x) => s + x[2], 0) + errors.length;
  if ((n < 1 && !first) || n > BATCH_MAX) return { ok: false, error: 'bad_counts' };   // 처음 연 것만 실은 묶음(아무것도 안 치고 나간 기기)은 신호 수 0으로 받는다
  if (asked < addDays(today, -LATE_DAYS)) return { ok: false, error: 'stale_day' };
  return { ok: true, value: { device, mobile, day, build, first, counts, swings, errors, n } };
}

// 신호(묶음)를 센다. 그날 그 기기의 신호가 EVENT_CAP보다 적을 때만 판 수·스윙 수·오류 수를 올린다.
// 묶음 하나에 DB 쓰기는 기기 한 줄 + 모드 수 + 10구 판별 수 + 모드·입력 수 + 오류 수만큼이다(90일 지난 기기 줄 지우기는 그날 처음 한 번만 줄을 지운다: DEVICE_DAYS).
// 처음 온 기기의 첫날 값은 기기 줄에 같이 쓴다(들어온 길은 처음 받은 값을 두고, 단계는 비트로 합친다)
export async function recordEvent(db, e) {
  const seen = await db.prepare(`INSERT INTO play_devices (day, device, mobile, events, path, steps) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, device) DO UPDATE SET events = events + excluded.events, path = COALESCE(path, excluded.path), steps = steps | excluded.steps
    WHERE play_devices.events < ?`)
    .bind(e.day, e.device, e.mobile ? 1 : 0, e.n, e.first?.path ?? null, e.first?.steps ?? 0, EVENT_CAP).run();
  if (seen.meta.changes === 0) return false;
  const writes = [
    db.prepare('DELETE FROM play_devices WHERE day < ?').bind(addDays(e.day, -DEVICE_DAYS)),
    ...e.counts.filter(([, starts, ends]) => starts + ends > 0).map(([mode, starts, ends]) => db.prepare(`INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, mode) DO UPDATE SET starts = starts + excluded.starts, ends = ends + excluded.ends`).bind(e.day, mode, starts, ends)),
    ...(e.build ? e.counts.filter(([mode]) => TEN_MODES.includes(mode)) : []).map(([mode, ...v]) => db.prepare(`INSERT INTO build_stats (day, build, mode, ${BUILD_KEYS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, build, mode) DO UPDATE SET ${BUILD_KEYS.map((k) => `${k} = ${k} + excluded.${k}`).join(', ')}`).bind(e.day, e.build, mode, ...v)),
    ...(e.swings ?? []).map(([mode, input, ...v]) => db.prepare(`INSERT INTO swing_stats (day, mode, input, ${SWING_KEYS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, mode, input) DO UPDATE SET ${SWING_KEYS.map((k) => `${k} = ${k} + excluded.${k}`).join(', ')}`).bind(e.day, mode, input, ...v)),
    ...(e.errors ?? []).map((v) => db.prepare(`INSERT INTO error_stats (day, ${ERROR_COLS.join(', ')}, devices) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (day, ${ERROR_COLS.join(', ')}) DO UPDATE SET devices = devices + 1`).bind(e.day, ...v)),
  ];
  await db.batch(writes);
  return true;
}

// 최근 7일(한국 시간) 표. 날짜마다 한 줄: 기기 수, 그중 터치 기기, 시작한 판·끝낸 판, 모드별 시작한 판, 도전장 판 끝·보낸 수, 옛 주소에서 옮긴 기기(npm run stats).
// 오늘의 10구는 2026-10-30에 없어져서 칸을 뺐다. 그 전 날짜의 오늘의 10구 판은 시작한 판·끝낸 판 합계에만 들어간다
export const STATS_SQL = `SELECT d.day AS "날짜", d.devices AS "기기", d.touch AS "터치 기기",
  COALESCE(SUM(CASE WHEN s.mode NOT IN ${NOT_PLAYS} THEN s.starts END), 0) AS "시작한 판", COALESCE(SUM(CASE WHEN s.mode NOT IN ${NOT_PLAYS} THEN s.ends END), 0) AS "끝낸 판",
  COALESCE(SUM(CASE s.mode WHEN 'challenge' THEN s.starts END), 0) AS "10구 도전",
  COALESCE(SUM(CASE s.mode WHEN 'scenario' THEN s.starts END), 0) AS "끝내기 상황",
  COALESCE(SUM(CASE s.mode WHEN 'practice' THEN s.starts END), 0) AS "연습",
  COALESCE(SUM(CASE s.mode WHEN 'aim' THEN s.starts END), 0) AS "조준 실험",
  COALESCE(SUM(CASE s.mode WHEN 'duel' THEN s.starts END), 0) AS "도전장 판",
  COALESCE(SUM(CASE s.mode WHEN 'duel' THEN s.ends END), 0) AS "도전장 끝",
  COALESCE(SUM(CASE s.mode WHEN 'invite' THEN s.starts END), 0) AS "도전장 보냄",
  COALESCE(SUM(CASE s.mode WHEN 'move' THEN s.starts END), 0) AS "옛 주소에서 옮김"
FROM (SELECT day, COUNT(*) AS devices, SUM(mobile) AS touch FROM play_devices
      WHERE day >= date('now', '+9 hours', '-6 days') GROUP BY day) d
LEFT JOIN play_stats s ON s.day = d.day
GROUP BY d.day ORDER BY d.day DESC`;

// 최근 7일 스윙 결과(2026-11-05 조준 타격 실험, npm run stats의 둘째 표): 날짜·모드·입력마다 스윙 수와 맞힌·안타·헛스윙 비율(%), 조준 자리 비율
export const SWING_SQL = `SELECT day AS "날짜", CASE mode WHEN 'aim' THEN '조준 실험' ELSE '10구' END AS "모드", input AS "입력", swings AS "스윙",
  ROUND(100.0 * contacts / swings, 1) AS "맞힘%", ROUND(100.0 * hits / swings, 1) AS "안타%", ROUND(100.0 * (swings - contacts) / swings, 1) AS "헛스윙%",
  ROUND(100.0 * perfect / swings, 1) AS "정타%", CASE mode WHEN 'aim' THEN ROUND(100.0 * near / swings, 1) END AS "과녁 가운데%",
  CASE mode WHEN 'aim' THEN ROUND(100.0 * edge / swings, 1) END AS "가장자리%", CASE mode WHEN 'aim' THEN ROUND(100.0 * miss / swings, 1) END AS "과녁 밖%"
FROM swing_stats WHERE day >= date('now', '+9 hours', '-6 days') AND swings > 0 ORDER BY day DESC, mode, input`;

// 최근 7일 오류(2026-11-18 운영 준비, npm run stats의 셋째 표): 판·자리·오류·메시지마다 그 오류를 낸 기기 수(많은 것부터 30줄)와 기기·브라우저 갈래.
// 배포한 js는 줄여서 한 줄이라, 자리(파일:줄:칸)는 레포에서 node scripts/where.js 판 파일 줄 칸으로 소스의 줄을 찾는다
export const ERRORS_SQL = `SELECT MAX(day) AS "마지막 날", build AS "판", src || ':' || line || ':' || col AS "자리", name AS "오류", message AS "메시지",
  GROUP_CONCAT(DISTINCT os) AS "기기", GROUP_CONCAT(DISTINCT browser) AS "브라우저", SUM(devices) AS "기기 수"
FROM error_stats WHERE day >= date('now', '+9 hours', '-6 days')
GROUP BY build, src, line, col, name, message ORDER BY SUM(devices) DESC, MAX(day) DESC LIMIT 30`;
