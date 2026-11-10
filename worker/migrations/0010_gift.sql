-- 물건 선물하기와 #번호(2026-11-10 사용자 결정, src/gifts.js). 새로 만드는 DB는 schema.sql에 이 칸·표가 들어 있다
-- ALTER TABLE ADD COLUMN은 두 번 실행하면 duplicate column으로 실패한다(한 번만 실행). 새 서버가 새 칸을 읽으므로 서버 배포보다 먼저 실행한다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0010_gift.sql)"
-- 계정마다 바뀌지 않는 번호(게임은 '골든#4821'). 있던 계정은 여기서 한 번에 준다(rowid에 10000과 서로소인 수를 곱해 흩어서 겹치지 않는다).
-- 이 파일을 실행한 뒤 서버 배포 전에 옛 서버가 만든 계정은 번호가 없고, 새 서버가 처음 불러올 때 무작위로 준다(giveTag)
ALTER TABLE accounts ADD COLUMN tag INTEGER;
UPDATE accounts SET tag = (rowid * 7919 + 4821) % 10000 WHERE tag IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_tag ON accounts (tag);
-- 받는 사람 찾기(정확히 같은 닉네임)
CREATE INDEX IF NOT EXISTS accounts_nick ON accounts (nick);
-- 10구 랭킹 판 수(선물은 10판 넘게 친 계정만). 있던 계정은 남은 기록으로 적게 잡아 채운다: 친 날 수(하루 한 줄), 안타 수 / 10(한 판 기회 10번),
-- 칭호 수 가운데 판 수(g_로 시작) 가장 큰 것. 셋 다 친 판 수보다 크지 않다
ALTER TABLE accounts ADD COLUMN games INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET games = MAX((SELECT COUNT(*) FROM daily_scores d WHERE d.player_id = accounts.player_id), CASE WHEN json_valid(counts) THEN COALESCE(json_extract(counts, '$.hit'), 0) / 10 ELSE 0 END, CASE WHEN json_valid(counts) THEN COALESCE((SELECT MAX(j.value) FROM json_each(accounts.counts) j WHERE substr(j.key, 1, 2) = 'g_'), 0) ELSE 0 END);
-- 선물 기록. 하루 보낸 수를 세고, 받는 사람이 아직 안 본 선물을 메뉴 띠에 보인다
CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, item TEXT NOT NULL, price INTEGER NOT NULL, day TEXT NOT NULL, sent_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS gifts_sender ON gifts (sender, day);
CREATE INDEX IF NOT EXISTS gifts_receiver ON gifts (receiver, seen);
