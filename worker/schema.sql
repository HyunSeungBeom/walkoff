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
  -- 랭킹 점수 검사 강화(2026-11-19, src/rules.js 다시 돌리기). 이미 있던 DB에는 migrations/0014_play.sql로 더했다
  play TEXT,                                     -- 그 판을 다시 돌릴 재료 JSON {seed, style, bats, moves: 공마다 타이밍 ms, 그냥 보낸 공 null}. 타이밍 없이 온 판은 NULL
  -- 공개 화면 지키기(2026-11-19, scripts/mod.mjs). 이미 있던 DB에는 migrations/0013_moderation.sql로 더했다
  hidden INTEGER NOT NULL DEFAULT 0,             -- 0 보임, 1 판을 숨김, 2 계정을 숨기면서 같이 숨김. 주간 요약은 0인 줄로만 만든다
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
  counts TEXT NOT NULL DEFAULT '{}',             -- 칭호마다 쌓은 수(JSON, js/core/titles.js countsOf)
  -- 선물하기(2026-11-10, src/gifts.js). 이미 있던 DB에는 migrations/0010_gift.sql로 더했다
  tag INTEGER,                                   -- 바뀌지 않는 번호(게임은 '골든#4821', 0~9999, 4자리가 차면 10000~99999). 처음 로그인할 때 준다
  games INTEGER NOT NULL DEFAULT 0,              -- 10구 랭킹 판 수(선물은 GIFT_MIN_GAMES판 넘게 친 계정만)
  -- 공개 화면 지키기(2026-11-19, scripts/mod.mjs). 이미 있던 DB에는 migrations/0013_moderation.sql로 더했다
  hidden_at INTEGER                              -- 계정을 숨긴 시각(ms). 숨긴 계정은 점수·선물을 못 보내고 받는 사람 찾기에 안 나온다
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_tag ON accounts (tag);
CREATE INDEX IF NOT EXISTS accounts_nick ON accounts (nick);   -- 받는 사람 찾기

-- 선물 기록(2026-11-10, src/gifts.js). 이미 있던 DB에는 migrations/0010_gift.sql로 더했다
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,                           -- 무작위 UUID
  sender TEXT NOT NULL,                          -- 보낸 계정(accounts.player_id)
  receiver TEXT NOT NULL,                        -- 받은 계정
  item TEXT NOT NULL,                            -- 물건 id(js/core/catalog.js)
  price INTEGER NOT NULL,                        -- 보낸 사람 코인에서 뺀 값(그때 상점 값)
  day TEXT NOT NULL,                             -- 보낸 날(한국 시간). 하루 보낸 수를 센다
  sent_at INTEGER NOT NULL,                      -- 보낸 시각(ms)
  seen INTEGER NOT NULL DEFAULT 0                -- 받는 사람이 메뉴 띠를 눌러 봤으면 1
);
CREATE INDEX IF NOT EXISTS gifts_sender ON gifts (sender, day);
CREATE INDEX IF NOT EXISTS gifts_receiver ON gifts (receiver, seen);

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
  path TEXT,                                     -- 처음 온 기기의 첫날만: 들어온 길(duel 도전장 주소, link 그냥 링크, move 옛 주소에서 옮김). 2026-11-30부터, migrations/0015_funnel.sql
  steps INTEGER NOT NULL DEFAULT 0,              -- 처음 온 기기의 첫날만: 간 단계를 더한 수(1 처음 연 것, 2 첫 스윙, 4 첫 10구 끝, 8 10구를 끝낸 뒤 새 판)
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
-- 오류 종류(2026-11-18 운영 준비, src/stats.js). 게임이 우리 파일에서 난 오류를 기기마다 하루 한 번 보내고, 기기 번호 없이 그 오류를 낸 기기 수만 센다.
-- 이미 있던 DB에는 migrations/0012_error_stats.sql로 더했다
CREATE TABLE IF NOT EXISTS error_stats (
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  build TEXT NOT NULL,                           -- 배포한 커밋 7자리(이 컴퓨터에서 연 게임은 local)
  src TEXT NOT NULL,                             -- js/ 아래 파일(main.js, infra/stats.js 등). 어디서 났는지 모르는 거절은 ?
  line INTEGER NOT NULL,                         -- 줄(배포한 js는 줄여서 거의 1)
  col INTEGER NOT NULL,                          -- 칸. 소스 줄은 scripts/where.js로 찾는다
  name TEXT NOT NULL,                            -- 오류 이름(TypeError 등)
  message TEXT NOT NULL,                         -- 주소·한글·메일·긴 숫자를 지운 80자까지의 메시지
  os TEXT NOT NULL,                              -- ios, android, windows, mac, other
  browser TEXT NOT NULL,                         -- kakao, naver, instagram, facebook, whale, samsung, edge, firefox, chrome, safari, other
  devices INTEGER NOT NULL DEFAULT 0,            -- 그날 이 오류를 낸 기기 수
  PRIMARY KEY (day, build, src, line, col, name, message, os, browser)
);
-- 10구 판(도전장 판 포함)이 어떻게 끝났는지 게임 판(빌드)별로(2026-11-19 첫 주 숫자 장치, 2026-11-30부터 센다, src/stats.js). 이미 있던 DB에는 migrations/0015_funnel.sql로 더했다
CREATE TABLE IF NOT EXISTS build_stats (
  day TEXT NOT NULL,                             -- 한국 시간 날짜 YYYY-MM-DD
  build TEXT NOT NULL,                           -- 게임 판: 배포한 커밋 7자리(오른쪽 아래 #build. 이 컴퓨터에서 연 게임은 local)
  mode TEXT NOT NULL,                            -- challenge(10구), duel(도전장 판)
  starts INTEGER NOT NULL DEFAULT 0,             -- 시작한 판
  ends INTEGER NOT NULL DEFAULT 0,               -- 끝까지 친 판
  restarts INTEGER NOT NULL DEFAULT 0,           -- 끝내지 않고 새 판을 연 수(처음부터, 처음으로 뒤 새 판)
  leaves INTEGER NOT NULL DEFAULT 0,             -- 끝내지 않고 화면을 숨긴 수(다른 앱, 창 닫기, 새로고침)
  backs INTEGER NOT NULL DEFAULT 0,              -- 숨겼다 돌아와 그 판을 끝내거나 새 판을 연 수(나감 = leaves - backs)
  PRIMARY KEY (day, build, mode)
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
-- 2026-11-18부터 표는 서버 서명으로 내주고 DB에 적지 않는다(src/seeds.js). seed_tokens는 그 전에 받은 표를 사흘 동안 받으려고 둔다

-- 쓴 시드 표(2026-11-18, src/seeds.js 서명한 표). 점수·끝내기 코인과 함께 온 표만 한 줄 적어 같은 표를 두 번 못 쓰게 한다.
-- 사람 ID는 적지 않는다. 기한(사흘)이 지난 줄은 새로 적을 때 지운다. 이미 있던 DB에는 migrations/0011_used_seeds.sql로 더했다
CREATE TABLE IF NOT EXISTS used_seeds (
  id TEXT PRIMARY KEY,                           -- 표를 내준 시각(ms, 13자리) + '.' + 표마다 다른 글자. 시각이 앞이라 기한 지난 줄을 기본 키 범위로 지운다
  used_at INTEGER NOT NULL                       -- 쓴 시각(ms)
) WITHOUT ROWID;                                 -- 줄 하나에 쓰기 1줄(따로 두는 색인이 없다)

-- 주마다 사람별 요약(2026-11-04, src/board.js). daily_scores로 언제든 다시 만들 수 있다. 이미 있던 DB에는 migrations/0005_weekly_boards.sql로 더했다
CREATE TABLE IF NOT EXISTS weekly_boards (
  week TEXT PRIMARY KEY,                         -- 그 주 월요일(한국 시간)
  players TEXT NOT NULL,                         -- JSON { 사람 ID: [최고 기록, 그 기록을 낸 날의 팀, 친 날 수, 가장 최근 날, 그날 닉네임] }
  built_at INTEGER NOT NULL                      -- daily_scores로 다시 만든 시각(ms). BOARD_TTL_MS가 지나면 다시 만든다
);
