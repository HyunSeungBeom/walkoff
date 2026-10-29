-- 10구 판 점수. 한 사람이 하루에 한 줄(그날 가장 높은 판)만 남긴다
CREATE TABLE IF NOT EXISTS daily_scores (
  player_id TEXT NOT NULL,                       -- 계정 ID(accounts.player_id)
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  week TEXT NOT NULL,                            -- 그 주 월요일 YYYY-MM-DD
  nick TEXT NOT NULL,
  team TEXT NOT NULL,
  score INTEGER NOT NULL,
  lights TEXT NOT NULL,                          -- 전광판 G(안타) Y(볼) R(나머지)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, day)
);
CREATE INDEX IF NOT EXISTS daily_scores_week ON daily_scores (week);

-- 카카오 로그인 계정. 카카오 회원번호는 그대로 두지 않고 비밀값(ID_SALT)으로 바꾼 값만 저장한다
CREATE TABLE IF NOT EXISTS accounts (
  kakao_key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL UNIQUE,                -- daily_scores.player_id
  nick TEXT,                                     -- 마지막으로 쓴 닉네임·팀. 다른 기기에서 로그인하면 이어 준다
  team TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 상점(2026-10-29). 이미 있던 DB에는 migrations/0002_shop.sql로 더했다
  coins INTEGER NOT NULL DEFAULT 0,              -- 코인 잔액
  owned TEXT NOT NULL DEFAULT '[]',              -- 산 물건 id(JSON 배열)
  equipped TEXT NOT NULL DEFAULT '{}',           -- 종류별 착용 물건 id와 등번호 no(JSON)
  coin_at INTEGER NOT NULL DEFAULT 0,            -- 마지막으로 코인을 준 시각(ms)
  daily_bonus_day TEXT NOT NULL DEFAULT ''       -- 오늘의 10구 2배를 준 날(하루 한 번)
);

-- 하루 이용 통계(2026-10-29, src/stats.js). 이미 있던 DB에는 migrations/0003_stats.sql로 더했다
CREATE TABLE IF NOT EXISTS play_stats (
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  mode TEXT NOT NULL,                            -- daily, challenge, scenario, practice
  starts INTEGER NOT NULL DEFAULT 0,             -- 시작한 판
  ends INTEGER NOT NULL DEFAULT 0,               -- 끝낸 판(연습은 끝이 없다)
  PRIMARY KEY (day, mode)
);
CREATE TABLE IF NOT EXISTS play_devices (
  day TEXT NOT NULL,
  device TEXT NOT NULL,                          -- 게임이 기기에 저장한 무작위 번호. 랭킹 ID·계정과 잇지 않는다
  mobile INTEGER NOT NULL DEFAULT 0,             -- 터치 기기면 1
  events INTEGER NOT NULL DEFAULT 0,             -- 그날 받은 신호 수(EVENT_CAP까지만 센다)
  PRIMARY KEY (day, device)
);
