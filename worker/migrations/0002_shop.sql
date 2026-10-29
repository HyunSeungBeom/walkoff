-- 상점(2026-10-29): 이미 있는 원격 DB의 accounts 표에 칸을 더한다. 한 번만 실행한다(이미 있으면 duplicate column 오류)
-- 0001은 schema.sql의 처음 모양. 새로 만드는 DB는 schema.sql에 이 칸이 들어 있다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --file=migrations/0002_shop.sql
ALTER TABLE accounts ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN owned TEXT NOT NULL DEFAULT '[]';
ALTER TABLE accounts ADD COLUMN equipped TEXT NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN coin_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN daily_bonus_day TEXT NOT NULL DEFAULT '';
