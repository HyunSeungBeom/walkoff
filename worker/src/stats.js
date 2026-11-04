// 하루 이용 통계(2026-10-29 사용자 결정). 사람이 아니라 게임이 기기에 저장한 무작위 번호로 센다.
// 랭킹 ID·닉네임·카카오 계정과는 잇지 않고, 날짜·모드별 판 수와 그날 기기 수만 남긴다
import { addDays } from './rules.js';

export const MODES = ['daily', 'challenge', 'scenario', 'practice'];
export const EVENT_CAP = 3000;   // 한 기기가 하루에 보내는 신호는 이만큼까지만 센다(새로고침 반복이나 장난으로 숫자가 부풀지 않게)
export const BATCH_MAX = 500;    // 묶음 하나에 받는 신호 수. 게임은 20개가 쌓이면 보낸다(js/infra/stats.js)
export const LATE_DAYS = 2;      // 화면을 갑자기 닫아 못 보낸 묶음은 다음에 열 때 보낸다. 그날부터 이틀 지난 것까지 받는다

// 신호를 검사해 { device, mobile, day, counts: [[모드, 시작, 끝], ...], n }으로 바꾼다. today는 서버의 한국 시간 날짜.
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
    return { ok: true, value: { device, mobile, day: today, counts: [[mode, type === 'start' ? 1 : 0, type === 'end' ? 1 : 0]], n: 1 } };
  }
  if (!b.counts || typeof b.counts !== 'object' || Array.isArray(b.counts)) return { ok: false, error: 'bad_counts' };
  const counts = [];
  for (const [mode, c] of Object.entries(b.counts)) {
    if (!MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    const { starts, ends } = c ?? {};
    if (![starts, ends].every((x) => Number.isInteger(x) && x >= 0)) return { ok: false, error: 'bad_counts' };
    if (starts + ends > 0) counts.push([mode, starts, ends]);
  }
  const n = counts.reduce((s, [, a, z]) => s + a + z, 0);
  if (n < 1 || n > BATCH_MAX) return { ok: false, error: 'bad_counts' };
  // 날짜는 게임이 모은 날(기기 시계). 서버 날짜보다 뒤면 오늘로, 이틀보다 앞이면 받지 않는다
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day ?? '')) ? String(b.day) : today;
  if (asked < addDays(today, -LATE_DAYS)) return { ok: false, error: 'stale_day' };
  return { ok: true, value: { device, mobile, day: asked > today ? today : asked, counts, n } };
}

// 신호(묶음)를 센다. 그날 그 기기의 신호가 EVENT_CAP보다 적을 때만 판 수를 올린다. 묶음 하나에 DB 쓰기는 기기 한 줄 + 모드 수만큼이다
export async function recordEvent(db, e) {
  const seen = await db.prepare(`INSERT INTO play_devices (day, device, mobile, events) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, device) DO UPDATE SET events = events + excluded.events WHERE play_devices.events < ?`)
    .bind(e.day, e.device, e.mobile ? 1 : 0, e.n, EVENT_CAP).run();
  if (seen.meta.changes === 0) return false;
  await db.batch(e.counts.map(([mode, starts, ends]) => db.prepare(`INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, mode) DO UPDATE SET starts = starts + excluded.starts, ends = ends + excluded.ends`).bind(e.day, mode, starts, ends)));
  return true;
}

// 최근 7일(한국 시간) 표. 날짜마다 한 줄: 기기 수, 그중 터치 기기, 시작한 판·끝낸 판, 모드별 시작한 판(npm run stats).
// 오늘의 10구는 2026-10-30에 없어져서 칸을 뺐다. 그 전 날짜의 오늘의 10구 판은 시작한 판·끝낸 판 합계에만 들어간다
export const STATS_SQL = `SELECT d.day AS "날짜", d.devices AS "기기", d.touch AS "터치 기기",
  COALESCE(SUM(s.starts), 0) AS "시작한 판", COALESCE(SUM(s.ends), 0) AS "끝낸 판",
  COALESCE(SUM(CASE s.mode WHEN 'challenge' THEN s.starts END), 0) AS "10구 도전",
  COALESCE(SUM(CASE s.mode WHEN 'scenario' THEN s.starts END), 0) AS "끝내기 상황",
  COALESCE(SUM(CASE s.mode WHEN 'practice' THEN s.starts END), 0) AS "연습"
FROM (SELECT day, COUNT(*) AS devices, SUM(mobile) AS touch FROM play_devices
      WHERE day >= date('now', '+9 hours', '-6 days') GROUP BY day) d
LEFT JOIN play_stats s ON s.day = d.day
GROUP BY d.day ORDER BY d.day DESC`;
