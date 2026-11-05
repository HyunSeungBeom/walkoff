-- 스윙 결과 수(2026-11-05 조준 타격 실험): 이미 있는 원격 DB에 표 하나를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0006_swing_stats.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄을 같이 보내면 Unknown arguments라 빼고 보낸다)
CREATE TABLE IF NOT EXISTS swing_stats (
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  input TEXT NOT NULL,
  swings INTEGER NOT NULL DEFAULT 0,
  contacts INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  perfect INTEGER NOT NULL DEFAULT 0,
  near INTEGER NOT NULL DEFAULT 0,
  edge INTEGER NOT NULL DEFAULT 0,
  miss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode, input)
);
