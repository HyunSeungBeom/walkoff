// 하루 이용 통계(2026-10-29 사용자 결정). 사람이 아니라 게임이 기기에 저장한 무작위 번호로 센다.
// 랭킹 ID·닉네임·카카오 계정과는 잇지 않고, 날짜·모드별 판 수와 그날 기기 수만 남긴다
export const MODES = ['daily', 'challenge', 'scenario', 'practice'];
export const EVENT_CAP = 300;   // 한 기기가 하루에 보내는 신호는 이만큼까지만 센다(새로고침 반복이나 장난으로 숫자가 부풀지 않게)

export function validateEvent(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad_body' };
  const device = String(b.device ?? ''), mode = String(b.mode ?? ''), type = String(b.type ?? '');
  if (!/^[a-z0-9-]{8,40}$/.test(device)) return { ok: false, error: 'bad_device' };
  if (!MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
  if (type !== 'start' && type !== 'end') return { ok: false, error: 'bad_type' };
  return { ok: true, value: { device, mode, type, mobile: b.mobile === true } };
}

// 신호 하나를 센다. 그날 그 기기의 신호가 EVENT_CAP보다 적을 때만 판 수를 올린다
export async function recordEvent(db, e, day) {
  const seen = await db.prepare(`INSERT INTO play_devices (day, device, mobile, events) VALUES (?, ?, ?, 1)
    ON CONFLICT (day, device) DO UPDATE SET events = events + 1 WHERE play_devices.events < ?`)
    .bind(day, e.device, e.mobile ? 1 : 0, EVENT_CAP).run();
  if (seen.meta.changes === 0) return false;
  const start = e.type === 'start' ? 1 : 0;
  await db.prepare(`INSERT INTO play_stats (day, mode, starts, ends) VALUES (?, ?, ?, ?)
    ON CONFLICT (day, mode) DO UPDATE SET starts = starts + excluded.starts, ends = ends + excluded.ends`)
    .bind(day, e.mode, start, 1 - start).run();
  return true;
}

// 최근 7일(한국 시간) 표. 날짜마다 한 줄: 기기 수, 그중 터치 기기, 시작한 판·끝낸 판, 모드별 시작한 판(npm run stats)
export const STATS_SQL = `SELECT d.day AS "날짜", d.devices AS "기기", d.touch AS "터치 기기",
  COALESCE(SUM(s.starts), 0) AS "시작한 판", COALESCE(SUM(s.ends), 0) AS "끝낸 판",
  COALESCE(SUM(CASE s.mode WHEN 'daily' THEN s.starts END), 0) AS "오늘의 10구",
  COALESCE(SUM(CASE s.mode WHEN 'challenge' THEN s.starts END), 0) AS "10구 도전",
  COALESCE(SUM(CASE s.mode WHEN 'scenario' THEN s.starts END), 0) AS "끝내기 상황",
  COALESCE(SUM(CASE s.mode WHEN 'practice' THEN s.starts END), 0) AS "연습"
FROM (SELECT day, COUNT(*) AS devices, SUM(mobile) AS touch FROM play_devices
      WHERE day >= date('now', '+9 hours', '-6 days') GROUP BY day) d
LEFT JOIN play_stats s ON s.day = d.day
GROUP BY d.day ORDER BY d.day DESC`;
