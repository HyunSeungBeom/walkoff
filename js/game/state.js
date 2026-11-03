// 판 상태(game)와 설정(settings). 다른 파일과 테스트(Object.assign(walkoff.game, …))가 같은 객체를 붙들고 있어서,
// 새 객체로 바꾸지 않고 안의 값만 바꾼다. 이 브라우저에 남긴 설정 값은 main.js가 열 때 넣는다(2026-11-03 코드 나누기 2단계)

// title → windup(투수 와인드업) → pitch(공이 날아옴) → result → 다음 공 … → over
export const game = {
  state: 'title', mode: 'challenge', throws: 'R', seq: [], i: 0, score: 0, results: [], seed: 0, summary: null,
  t: 0,              // 와인드업 시작부터 흐른 시간(초). 맞는 순간 멈춤 동안은 흐르지 않는다
  clockAt: 0,        // t를 마지막으로 올린 시각(performance.now 기준)
  swingAt: null,     // 공을 놓은 뒤 몇 초에 휘둘렀는지
  outcome: null, gained: 0, resultT: 0, revealAt: 0, flightT: 0,
  hitstop: 0, flash: 0, contactPos: null, burst: null, mittDone: false, replay: null, replayed: false,   // burst: 효과 배트로 맞힌 효과 { fx, t(지난 초), seed }
  toast: null, newBest: false, best: 0,
  left: 0, extra: 0, lastChance: false,   // 10구 모드: 남은 기회, 볼로 얻은 추가 기회, 지금 공이 마지막 기회인지
  opponent: null, onboard: null, ranking: null, rankInfo: null, rankTab: 'players', rankBack: 'title', account: null,   // 상대 팀, 팀 고르기, 랭킹, 내 계정 화면
  ticket: null, fixedSeed: false, waitingSeed: false, recorded: false,   // 이번 판에 쓴 서버 시드, 주소의 ?seed=로 친 판인지, 서버 시드를 기다리는 중인지, 이번 판을 기록했는지
};

// 좌타/우타, 타이밍 보정(ms), 팀·닉네임, 랭킹에서 이 브라우저를 구별하는 ID, 진동. 아래는 저장소를 못 읽을 때의 기본값이다
export const settings = { bats: 'R', offset: 0, team: null, nick: '', playerId: '', vibrate: true };
