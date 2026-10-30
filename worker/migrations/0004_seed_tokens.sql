-- 10구 도전 시드 표(2026-10-30): 이미 있는 원격 DB에 표 하나를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command "$(cat migrations/0004_seed_tokens.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막혀서 0002·0003 때처럼 --command로 보낸다)
CREATE TABLE IF NOT EXISTS seed_tokens (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS seed_tokens_player ON seed_tokens (player_id, issued_at);
