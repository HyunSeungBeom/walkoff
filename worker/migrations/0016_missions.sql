-- 오늘의 미션(2026-11-23, src/missions.js): 계정마다 그날 미션 진행(JSON { day, n, paid })을 둘 칸을 accounts에 더한다. 다음 날 첫 랭킹 판에서 그날 것으로 덮어쓴다.
-- 새로 만드는 DB는 schema.sql에 이 칸이 들어 있다. 서버를 배포하기 전에 먼저 실행한다(배포한 서버는 계정을 읽을 때마다 이 칸을 읽는다).
-- 두 번 실행하면 duplicate column name 오류가 나고 바뀌는 것은 없다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0016_missions.sql)"
ALTER TABLE accounts ADD COLUMN missions TEXT;
