-- 하루 이용 통계(2026-10-29): 이미 있는 원격 DB에 표 두 개를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command "$(cat migrations/0003_stats.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막혀서 0002 때처럼 --command로 보낸다)
CREATE TABLE IF NOT EXISTS play_stats (
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  ends INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode)
);
CREATE TABLE IF NOT EXISTS play_devices (
  day TEXT NOT NULL,
  device TEXT NOT NULL,
  mobile INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, device)
);
