-- 공개 화면 지키기(2026-11-19 사용자 '숨김 칸 2개, 칭호 그대로'): 이상한 판과 계정을 지우지 않고 랭킹에서 숨긴다(풀면 되돌아온다, scripts/mod.mjs).
-- 새로 만드는 DB는 schema.sql에 이 칸들이 들어 있다. ALTER TABLE ADD COLUMN은 두 번 실행하면 duplicate column으로 실패한다(한 번만 실행).
-- 새 서버가 새 칸을 읽으므로 서버 배포보다 먼저 실행한다. 칸을 더하기만 하므로 옛 서버도 그대로 돈다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0013_moderation.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄을 같이 보내면 Unknown arguments라 빼고 보낸다)
-- 판 숨김: 0 보임, 1 판을 숨김, 2 계정을 숨기면서 같이 숨김(계정을 풀면 2만 다시 보인다). 주간 요약(weekly_boards)은 0인 줄로만 만든다
ALTER TABLE daily_scores ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
-- 계정 숨김: 숨긴 시각(ms). 숨긴 계정은 점수·선물을 못 보내고 받는 사람 찾기에 안 나온다. 칭호·코인·물건은 그대로 둔다
ALTER TABLE accounts ADD COLUMN hidden_at INTEGER;
