-- 쌓아서 받는 칭호로 바꾸며(2026-11-06 사용자 결정) 한 판으로 받던 칭호를 지운다. 규칙이 그대로인 첫 홈런(firsthr)만 남긴다
-- 새 서버를 배포한 뒤에 실행한다(먼저 지우면 배포 전 몇 분 동안 옛 서버가 옛 규칙으로 다시 준다). 지우기 전에 accounts의 player_id·titles를 내려받아 둔다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0009_title_reset.sql)"
UPDATE accounts SET titles = CASE WHEN titles LIKE '%"firsthr"%' THEN '["firsthr"]' ELSE '[]' END WHERE titles != '[]';
