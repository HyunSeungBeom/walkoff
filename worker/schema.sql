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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
