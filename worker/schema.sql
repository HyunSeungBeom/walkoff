-- 오늘의 10구 점수. 한 사람이 하루에 한 줄(첫 판)만 남긴다
CREATE TABLE IF NOT EXISTS daily_scores (
  player_id TEXT NOT NULL,                       -- 브라우저마다 만든 무작위 ID
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
