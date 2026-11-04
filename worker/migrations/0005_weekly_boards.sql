-- 주마다 사람별 요약(2026-11-04, src/board.js): 이미 있는 원격 DB에 표 하나를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다. 요약은 서버가 처음 읽을 때 daily_scores로 만들어서 따로 채울 것은 없다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0005_weekly_boards.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막혀서 --command로 보낸다. 이 설명 줄을 같이 보내면 wrangler가 '--'를 옵션으로 읽어
-- Unknown arguments로 멈춰서 grep으로 뺀다). 서버 배포보다 먼저 실행한다. 2026-11-04 원격 DB에 만들었다
CREATE TABLE IF NOT EXISTS weekly_boards (
  week TEXT PRIMARY KEY,
  players TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
