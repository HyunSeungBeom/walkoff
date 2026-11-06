-- 10구 판 점수. 한 사람이 하루에 한 줄(그날 가장 높은 판)만 남긴다
CREATE TABLE IF NOT EXISTS daily_scores (
  player_id TEXT NOT NULL,                       -- 계정 ID(accounts.player_id)
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  week TEXT NOT NULL,                            -- 그 주 월요일 YYYY-MM-DD
  nick TEXT NOT NULL,
  team TEXT NOT NULL,
  score INTEGER NOT NULL,
  lights TEXT NOT NULL,                          -- 전광판 공마다 S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R 나머지(2026-11-05까지의 판은 안타가 모두 G)
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
  daily_bonus_day TEXT NOT NULL DEFAULT '',      -- 오늘의 10구 2배를 준 날(하루 한 번). 2026-10-30 2배를 없애서 더 쓰지 않는다
  -- 칭호·업적(2026-11-05, js/core/titles.js). 이미 있던 DB에는 migrations/0007_titles.sql로 더했다
  titles TEXT NOT NULL DEFAULT '[]',             -- 받은 칭호 id(JSON 배열)
  -- 쌓아서 받는 칭호(2026-11-06). 이미 있던 DB에는 migrations/0008_title_counts.sql로 더했다
  counts TEXT NOT NULL DEFAULT '{}'              -- 칭호마다 쌓은 수(JSON, js/core/titles.js countsOf)
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
-- 스윙 결과 수(2026-11-05 조준 타격 실험, src/stats.js). 이미 있던 DB에는 migrations/0006_swing_stats.sql로 더했다
CREATE TABLE IF NOT EXISTS swing_stats (
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  mode TEXT NOT NULL,                            -- challenge(10구, 기준선), aim(조준 실험)
  input TEXT NOT NULL,                           -- mouse, touch, key(스페이스바)
  swings INTEGER NOT NULL DEFAULT 0,             -- 휘두른 수
  contacts INTEGER NOT NULL DEFAULT 0,           -- 맞힌 수(파울 포함)
  hits INTEGER NOT NULL DEFAULT 0,               -- 안타
  perfect INTEGER NOT NULL DEFAULT 0,            -- 정타
  near INTEGER NOT NULL DEFAULT 0,               -- 조준: 과녁 가운데
  edge INTEGER NOT NULL DEFAULT 0,               -- 조준: 과녁 가장자리
  miss INTEGER NOT NULL DEFAULT 0,               -- 조준: 과녁 밖
  PRIMARY KEY (day, mode, input)
);

-- 10구 도전 시드 표(2026-10-30, src/seeds.js). 서버가 판마다 내주고 점수와 함께 한 번만 받는다. 이미 있던 DB에는 migrations/0004_seed_tokens.sql로 더했다
CREATE TABLE IF NOT EXISTS seed_tokens (
  id TEXT PRIMARY KEY,                           -- 게임에 준 표(무작위 UUID)
  player_id TEXT NOT NULL,                       -- 받은 계정(accounts.player_id)
  seed INTEGER NOT NULL,                         -- 공 순서 시드
  issued_at INTEGER NOT NULL,                    -- 내준 시각(ms)
  used_at INTEGER                                -- 점수를 받은 시각(ms). 아직 안 썼으면 NULL
);
CREATE INDEX IF NOT EXISTS seed_tokens_player ON seed_tokens (player_id, issued_at);

-- 주마다 사람별 요약(2026-11-04, src/board.js). daily_scores로 언제든 다시 만들 수 있다. 이미 있던 DB에는 migrations/0005_weekly_boards.sql로 더했다
CREATE TABLE IF NOT EXISTS weekly_boards (
  week TEXT PRIMARY KEY,                         -- 그 주 월요일(한국 시간)
  players TEXT NOT NULL,                         -- JSON { 사람 ID: [최고 기록, 그 기록을 낸 날의 팀, 친 날 수, 가장 최근 날, 그날 닉네임] }
  built_at INTEGER NOT NULL                      -- daily_scores로 다시 만든 시각(ms). BOARD_TTL_MS가 지나면 다시 만든다
);
