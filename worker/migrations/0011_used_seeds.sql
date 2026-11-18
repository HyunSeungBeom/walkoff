-- 쓴 시드 표(2026-11-18, 서명한 표): 이미 있는 원격 DB에 표 하나를 더한다. IF NOT EXISTS라 두 번 실행해도 괜찮다
-- 새로 만드는 DB는 schema.sql에 이 표가 들어 있다. 서버를 배포하기 전에 먼저 실행한다(배포한 서버가 이 표에 쓴다)
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0011_used_seeds.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄 --를 같이 보내면 Unknown arguments라서 설명 줄을 빼고 보낸다)
CREATE TABLE IF NOT EXISTS used_seeds (
  id TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
) WITHOUT ROWID;
