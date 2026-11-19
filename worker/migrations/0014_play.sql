-- 랭킹 점수 검사 강화(2026-11-19): 그날 최고 판을 다시 돌릴 재료(시드·투수 유형·타석·공마다 타이밍)를 남길 칸을 daily_scores에 더한다.
-- 새로 만드는 DB는 schema.sql에 이 칸이 들어 있다. 서버를 배포하기 전에 먼저 실행한다(배포한 서버가 이 칸에 쓴다).
-- 두 번 실행하면 duplicate column name 오류가 나고 바뀌는 것은 없다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0014_play.sql)"
ALTER TABLE daily_scores ADD COLUMN play TEXT;
