// 하루 이용 통계(2026-10-29 사용자 결정). 사람이 아니라 게임이 기기에 저장한 무작위 번호로 센다.
// 랭킹 ID·닉네임·카카오 계정과는 잇지 않고, 날짜·모드별 판 수와 그날 기기 수만 남긴다
import { addDays } from './rules.js';

export const MODES = ['daily', 'challenge', 'scenario', 'practice', 'aim'];   // aim: 조준 타격(실험, 2026-11-05)
// 스윙 결과 수(2026-11-05 조준 타격 실험): 모드·입력마다 스윙·맞힘(파울 포함)·안타·정타 수와 조준 자리(near·edge·miss) 수의 합계
export const SWING_MODES = ['challenge', 'aim'], SWING_INPUTS = ['mouse', 'touch', 'key'];
const SWING_KEYS = ['swings', 'contacts', 'hits', 'perfect', 'near', 'edge', 'miss'];
export const EVENT_CAP = 3000;   // 한 기기가 하루에 보내는 신호는 이만큼까지만 센다(새로고침 반복이나 장난으로 숫자가 부풀지 않게)
export const BATCH_MAX = 500;    // 묶음 하나에 받는 신호 수. 게임은 20개가 쌓이면 보낸다(js/infra/stats.js)
export const LATE_DAYS = 2;      // 화면을 갑자기 닫아 못 보낸 묶음은 다음에 열 때 보낸다. 그날부터 이틀 지난 것까지 받는다

// 신호를 검사해 { device, mobile, day, counts: [[모드, 시작, 끝], ...], swings: [[모드, 입력, ...SWING_KEYS], ...], n }으로 바꾼다. today는 서버의 한국 시간 날짜.
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
    return { ok: true, value: { device, mobile, day: today, counts: [[mode, type === 'start' ? 1 : 0, type === 'end' ? 1 : 0]], swings: [], n: 1 } };
  }
  if (!b.counts || typeof b.counts !== 'object' || Array.isArray(b.counts)) return { ok: false, error: 'bad_counts' };
  const counts = [];
  for (const [mode, c] of Object.entries(b.counts)) {
    if (!MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    const { starts, ends } = c ?? {};
    if (![starts, ends].every((x) => Number.isInteger(x) && x >= 0)) return { ok: false, error: 'bad_counts' };
    if (starts + ends > 0) counts.push([mode, starts, ends]);
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
  const n = counts.reduce((s, [, a, z]) => s + a + z, 0) + swings.reduce((s, x) => s + x[2], 0);
  if (n < 1 || n > BATCH_MAX) return { ok: false, error: 'bad_counts' };
  // 날짜는 게임이 모은 날(기기 시계). 서버 날짜보다 뒤면 오늘로, 이틀보다 앞이면 받지 않는다
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day ?? '')) ? String(b.day) : today;
  if (asked < addDays(today, -LATE_DAYS)) return { ok: false, error: 'stale_day' };
  return { ok: true, value: { device, mobile, day: asked > today ? today : asked, counts, swings, n } };
}

// 신호(묶음)를 센다. 그날 그 기기의 신호가 EVENT_CAP보다 적을 때만 판 수·스윙 수를 올린다. 묶음 하나에 DB 쓰기는 기기 한 줄 + 모드 수 + 모드·입력 수만큼이다
export async function recordEvent(db, e) {
  const seen = await db.prepare(`INSERT INTO play_devices (day, device, mobile, events) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, device) DO UPDATE SET events = events + excluded.events WHERE play_devices.events < ?`)
    .bind(e.day, e.device, e.mobile ? 1 : 0, e.n, EVENT_CAP).run();
  if (seen.meta.changes === 0) return false;
  const writes = [
    ...e.counts.map(([mode, starts, ends]) => db.prepare(`INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, mode) DO UPDATE SET starts = starts + excluded.starts, ends = ends + excluded.ends`).bind(e.day, mode, starts, ends)),
    ...(e.swings ?? []).map(([mode, input, ...v]) => db.prepare(`INSERT INTO swing_stats (day, mode, input, ${SWING_KEYS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, mode, input) DO UPDATE SET ${SWING_KEYS.map((k) => `${k} = ${k} + excluded.${k}`).join(', ')}`).bind(e.day, mode, input, ...v)),
  ];
  if (writes.length) await db.batch(writes);
  return true;
}

// 최근 7일(한국 시간) 표. 날짜마다 한 줄: 기기 수, 그중 터치 기기, 시작한 판·끝낸 판, 모드별 시작한 판(npm run stats).
// 오늘의 10구는 2026-10-30에 없어져서 칸을 뺐다. 그 전 날짜의 오늘의 10구 판은 시작한 판·끝낸 판 합계에만 들어간다
export const STATS_SQL = `SELECT d.day AS "날짜", d.devices AS "기기", d.touch AS "터치 기기",
  COALESCE(SUM(s.starts), 0) AS "시작한 판", COALESCE(SUM(s.ends), 0) AS "끝낸 판",
  COALESCE(SUM(CASE s.mode WHEN 'challenge' THEN s.starts END), 0) AS "10구 도전",
  COALESCE(SUM(CASE s.mode WHEN 'scenario' THEN s.starts END), 0) AS "끝내기 상황",
  COALESCE(SUM(CASE s.mode WHEN 'practice' THEN s.starts END), 0) AS "연습",
  COALESCE(SUM(CASE s.mode WHEN 'aim' THEN s.starts END), 0) AS "조준 실험"
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
