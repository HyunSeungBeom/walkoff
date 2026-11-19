-- 오류 종류(2026-11-18 운영 준비): 이미 있는 원격 DB에 표 하나를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다. 서버 배포보다 먼저 더한다(없으면 오류가 실린 묶음이 통째로 실패한다)
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0012_error_stats.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄을 같이 보내면 Unknown arguments라 빼고 보낸다)
CREATE TABLE IF NOT EXISTS error_stats (
  day TEXT NOT NULL,
  build TEXT NOT NULL,
  src TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  os TEXT NOT NULL,
  browser TEXT NOT NULL,
  devices INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, build, src, line, col, name, message, os, browser)
);
