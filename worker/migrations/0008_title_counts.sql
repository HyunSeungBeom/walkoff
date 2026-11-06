-- 쌓아서 받는 칭호(2026-11-06 사용자 '한 번 쳤다고 주면 좀 그렇지 않나, 전체적으로 횟수 난이도 올려줘', js/core/titles.js): 계정 표에 칭호마다 쌓은 수 칸을 더한다
-- 새로 만드는 DB는 schema.sql에 이 칸이 들어 있다. ALTER TABLE ADD COLUMN은 두 번 실행하면 duplicate column으로 실패한다(한 번만 실행). 서버 배포보다 먼저 실행한다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0008_title_counts.sql)"
ALTER TABLE accounts ADD COLUMN counts TEXT NOT NULL DEFAULT '{}';
