// 끝내기 상황 규칙: 9회말 지고 있을 때 타석에 선다. 볼넷·삼진·주자 진루를 세고, 역전하는 순간 끝내기 승리다.
// 상황 목록과 공 하나의 결과에 따른 볼카운트·아웃·진루·득점·끝을 정한다. 화면에 띄울 글은 view/text.js(scenarioLabel·scenarioMessage)

export const SCENARIOS = [
  { outs: 2, bases: [true, true, false], away: 3, home: 2 },
  { outs: 1, bases: [false, true, false], away: 4, home: 3 },
  { outs: 2, bases: [true, true, true], away: 5, home: 3 },
  { outs: 0, bases: [true, false, false], away: 2, home: 0 },
  { outs: 2, bases: [false, false, false], away: 1, home: 0 },
  { outs: 1, bases: [false, false, true], away: 6, home: 5 },
];

export function makeScenario(rnd) {
  const s = SCENARIOS[Math.floor(rnd() * SCENARIOS.length)];
  return { ...s, bases: [...s.bases], count: { b: 0, s: 0 }, pa: [], end: null };
}

// 공 하나의 결과를 상황에 반영한다. 돌려주는 것: 들어온 점수(runs), 끝난 타석(pa: G 출루·Y 볼넷·R 아웃, 안 끝났으면 null),
// 알릴 일(play: walk 볼넷·k-looking 루킹 삼진·k-swinging 헛스윙 삼진·sac-fly 희생플라이·out 아웃, 없으면 null)
// 주자: 안타면 2·3루 주자가 들어오고 1루 주자는 2루로, 2루타면 1루 주자가 3루로 간다
export function applyScenario(s, r) {
  const c = s.count, [b1, b2, b3] = s.bases;
  let runs = 0, pa = null, play = null;
  if (r.kind === 'ball') {
    if (++c.b === 4) {
      if (b1 && b2 && b3) runs = 1;
      s.bases = [true, b1 || b2, (b1 && b2) || b3];
      pa = 'Y'; play = 'walk';
    }
  } else if (r.kind === 'strike' || r.kind === 'whiff') {
    if (++c.s === 3) { s.outs++; pa = 'R'; play = r.kind === 'strike' ? 'k-looking' : 'k-swinging'; }
  } else if (r.kind === 'foul') {
    if (c.s < 2) c.s++;   // 2스트라이크 뒤 파울은 세지 않는다
  } else if (r.kind === 'out') {
    s.outs++; pa = 'R';
    if (r.type === 'fly' && b3 && s.outs < 3) { s.bases = [b1, b2, false]; runs = 1; play = 'sac-fly'; }   // 3루 주자가 태그업해서 들어온다
    else play = 'out';
  } else if (r.kind === 'single' && r.infield) {   // 내야 안타: 밀려서 한 베이스씩만 간다(만루면 3루 주자만 들어온다)
    if (b1 && b2 && b3) runs = 1;
    s.bases = [true, b1 || b2, (b1 && b2) || b3]; pa = 'G';
  } else if (r.kind === 'single') {
    runs = (b3 ? 1 : 0) + (b2 ? 1 : 0); s.bases = [true, b1, false]; pa = 'G';
  } else if (r.kind === 'double') {
    runs = (b3 ? 1 : 0) + (b2 ? 1 : 0); s.bases = [false, true, b1]; pa = 'G';
  } else if (r.kind === 'triple') {
    runs = (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0); s.bases = [false, false, true]; pa = 'G';
  } else if (r.kind === 'hr') {
    runs = 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0); s.bases = [false, false, false]; pa = 'G';
  }
  s.home += runs;
  if (pa) { s.pa.push(pa); s.count = { b: 0, s: 0 }; }
  if (s.home > s.away) s.end = 'win';
  else if (s.outs >= 3) s.end = s.home === s.away ? 'tie' : 'lose';
  return { runs, pa, play };
}
