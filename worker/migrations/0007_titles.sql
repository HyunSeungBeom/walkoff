-- 칭호·업적(2026-11-05 유저 피드백, js/core/titles.js): 이미 있는 원격 DB의 계정 표에 받은 칭호 칸을 더한다
-- 새로 만드는 DB는 schema.sql에 이 칸이 들어 있다. ALTER TABLE ADD COLUMN은 두 번 실행하면 duplicate column으로 실패한다(한 번만 실행)
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0007_titles.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄을 같이 보내면 Unknown arguments라 빼고 보낸다)
ALTER TABLE accounts ADD COLUMN titles TEXT NOT NULL DEFAULT '[]';
