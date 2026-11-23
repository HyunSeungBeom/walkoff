-- 첫 주 숫자 장치(2026-11-19, 2026-11-30부터 센다): 이미 있는 원격 DB의 기기 줄(play_devices)에 처음 온 기기의 들어온 길·첫날 단계 칸 둘을 더하고,
-- 10구 판이 어떻게 끝났는지 게임 판(빌드)별로 세는 표 하나를 더한다. 새로 만드는 DB는 schema.sql에 이 칸·표가 들어 있다.
-- 서버를 배포하기 전에 먼저 실행한다(배포한 서버가 이 칸·표에 쓴다. 없으면 통계 묶음이 모두 실패한다).
-- 두 번 실행하면 duplicate column name 오류가 나고 바뀌는 것은 없다(표는 IF NOT EXISTS)
-- 실행: worker 폴더에서 npx wrangler d1 execute walkoff --remote --command="$(grep -v '^--' migrations/0015_funnel.sql)"
-- (원격에 --file로 보내면 Authentication error [code: 10000]으로 막히고, 설명 줄을 같이 보내면 Unknown arguments라 빼고 보낸다)
CREATE TABLE IF NOT EXISTS build_stats (
  day TEXT NOT NULL,
  build TEXT NOT NULL,
  mode TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  ends INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  backs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, build, mode)
);
ALTER TABLE play_devices ADD COLUMN path TEXT;
ALTER TABLE play_devices ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;
