// 1루 경주에 쓰는 계산: 수비수 달리기, 땅볼이 굴러가는 길, 공에 닿는 때, 잡아 던지기, 주자가 1루에 닿는 때.
// 판정(judge.js settleAtFirst)과 수비 그림(main.js fieldPlay)이 같은 값을 쓴다
// 수비수 달리기(초속 m, 빨라지는 시간 상수 초)와 반응 시간(초). 판정(1루 경주)과 그림이 같은 값을 쓴다. 내야수는 투구에 맞춰 반 걸음 나가 있어서 첫발이 조금 빠르다
import { clamp, DEG } from './math.js';
import { BASE1, FAIR_SPRAY, fieldHome, MOUND } from './field.js';

export const FIELD_SPEED = { in: [7, 0.46], out: [8.5, 0.6], p: [6.5, 0.45] }, FIELD_REACT = { in: 0.22, out: 0.3, p: 0.4 };
// 다이빙(그림 FTRACK.dive와 같은 식): 잡기 DIVE_LEAD초 전까지 공 쪽으로 달려가 그 자리에서 박차고 날아, 엉덩이 앞 DIVE_GLOVE m의 글러브가 공에 닿는다.
// 엉덩이가 나는 거리는 그때 빠르기로 DIVE_LEAD초 + 박차는 DIVE_PUSH m(서서 날면 1m, 전력으로 달려오면 3.3m). 전에는 '다이빙하면 2.4m 더'로 쳐서
// 거의 서 있던 수비수가 몸을 날린 자리에서 공까지 5m를 날아야 했다
export const DIVE_LEAD = 0.33, DIVE_GLOVE = 1.06, DIVE_PUSH = 1.0;
// 땅볼에 글러브가 닿는 거리(m): 서서 잡을 때는 몸 앞 0.6m, 달려가며 한 손으로 뻗으면 0.95m. 서서 잡으려면 공보다 0.3초 먼저 가 있어야 한다
export const SET_REACH = 0.6, RUN_REACH = 0.95, SET_SLACK = 0.3;
// 0에서 출발해 top(1 - e^(-t/tau))로 빨라지는 달리기(주자·수비수 걸음 runTrack과 같은 식)로 t초에 가는 거리와, d m를 가는 시간(멈추지 않고 지나가는 때)
export const sprintDist = (t, top, tau) => (t <= 0 ? 0 : top * (t - tau * (1 - Math.exp(-t / tau))));
export function sprintTime(d, top, tau) {
  if (d <= 0) return 0;
  let lo = 0, hi = 40;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (top * (m - tau * (1 - Math.exp(-m / tau))) < d) lo = m; else hi = m; }
  return hi;
}
// 땅볼이 굴러가는 길(2026-11-02): 처음 빠르기는 타구 속도에서 내고(덮어 친 공은 느리다) 내야에서는 초속 3m씩, 외야 잔디(40m 너머)에서는 6m씩 준다.
// 공은 홈플레이트 앞 0.3m에서 spray 방향(±43°로 자름)으로 간다
export const GROUND_DECEL = 3.0, GRASS_DECEL = 6.0, GRASS_AT = 40;
export function groundPath(r) {
  const a = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY) * DEG, dir = [Math.sin(a), Math.cos(a)];
  const u0 = Math.max(4, (r.ev - 45) * 0.38) * (r.la < 0 ? Math.max(0.6, 1 + r.la / 40) : 1);
  // 내야 구간: 감속 3m/s². GRASS_AT m에 닿으면 그때 빠르기로 외야 구간(감속 6m/s²)을 이어 간다
  const tIn = u0 * u0 / (2 * GROUND_DECEL) <= GRASS_AT ? Infinity : (u0 - Math.sqrt(u0 * u0 - 2 * GROUND_DECEL * GRASS_AT)) / GROUND_DECEL;
  const uIn = Number.isFinite(tIn) ? u0 - GROUND_DECEL * tIn : 0;
  const tStop = Number.isFinite(tIn) ? tIn + uIn / GRASS_DECEL : u0 / GROUND_DECEL;
  const dist = (t) => {
    const k = Math.min(t, tStop);
    if (k <= tIn) return u0 * k - 0.5 * GROUND_DECEL * k * k;
    const q = k - tIn;
    return GRASS_AT + uIn * q - 0.5 * GRASS_DECEL * q * q;
  };
  const speed = (t) => (t >= tStop ? 0 : t <= tIn ? u0 - GROUND_DECEL * t : uIn - GRASS_DECEL * (t - tIn));
  return { dir, u0, tStop, dist, speed, pos: (t) => { const s = dist(t); return [dir[0] * s, 0.3 + dir[1] * s]; } };
}
// 수비수가 굴러오는 땅볼에 닿는 첫 때와 자리. reach는 몸에서 글러브가 닿는 거리, slack은 공보다 먼저 가 있어야 하는 때(서서 잡기),
// 공이 홈에서 maxDepth m보다 멀어지면 더 쫓지 않는다(내야수가 외야 잔디까지 쫓아가 잡지 않게). 못 닿으면 null. 1/120초 간격으로 찾는다
export function reachGround(path, home, react, top, tau, reach, slack = 0, maxDepth = Infinity, until = path.tStop + 2) {
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) {
    const b = path.pos(t);
    if (Math.hypot(b[0], b[1]) > maxDepth) return null;
    if (Math.hypot(b[0] - home[0], b[1] - home[1]) - reach <= sprintDist(t - react - slack, top, tau)) return { t, at: b };
  }
  return null;
}
// 다이빙으로 땅볼에 닿고도 남는 거리(음수면 닿는다): t초에 잡으려면 DIVE_LEAD초 전까지 달린 자리에서 날아야 한다
export function diveShort(b, home, t, react, top, tau) {
  const tl = t - DIVE_LEAD - react, vL = tl > 0 ? top * (1 - Math.exp(-tl / tau)) : 0;
  return Math.hypot(b[0] - home[0], b[1] - home[1]) - DIVE_GLOVE - vL * DIVE_LEAD - DIVE_PUSH - sprintDist(tl, top, tau);
}
export function reachDive(path, home, react, top, tau, maxDepth = Infinity, until = path.tStop + 2) {
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) {
    const b = path.pos(t);
    if (Math.hypot(b[0], b[1]) > maxDepth) return null;
    if (diveShort(b, home, t, react, top, tau) <= 0) return { t, at: b };
  }
  return null;
}
// 달려가 닿는 첫 때(std), 못 닿으면 다이빙(dive), 그래도 못 닿으면 가장 가까이 가는 때에 다이빙(forced)
export function interceptGround(path, home, react, top, tau, until = path.tStop + 2) {
  const run = reachGround(path, home, react, top, tau, RUN_REACH, 0, Infinity, until);
  if (run) return { ...run, how: 'std' };
  const dive = reachDive(path, home, react, top, tau, Infinity, until);
  if (dive) return { ...dive, how: 'dive' };
  let best = null;
  for (let i = 0, t = 0; t <= until; i++, t = i / 120) { const short = diveShort(path.pos(t), home, t, react, top, tau); if (!best || short < best.short) best = { t, short }; }
  return { t: best.t, at: path.pos(best.t), how: 'forced' };
}

// ===== 1루 경주(2026-11-02 사용자 '간발의 승부', 판정이 바뀐다) =====
// 땅볼 아웃으로 판정된 공을 수비수가 잡아 던진 공이 1루에 닿는 때와, 친 타자가 1루를 밟는 때를 견줘 늦으면 내야 안타로 바꾼다.
// 무작위 없이 ev·la·spray·수비수·타석만 쓰고 화면(폰 그림 이동 등)은 쓰지 않아 PC·폰이 같다. 그림(fieldPlay)도 이 시각을 그대로 쓴다.
// 정타는 이미 수비 사이로 빠져(throughGap) 여기 오지 않는다. 서버는 바꾸지 않는다(내야 안타도 배트가 닿은 공이라 초록불을 받는다)
// 친 뒤 주자가 1루를 밟는 때(초). 우타는 스윙한 힘이 3루 쪽으로 쏠려 타석에서 늦게 나오고 좌타는 1루 쪽이라 빠르다. 그림은 출발 시각으로 맞춘다(runStartOf).
// 우타의 땅볼은 3루·유격 쪽(먼 송구)으로, 좌타는 1·2루 쪽(짧은 송구, 1루수가 직접 밟기)으로 많이 가서 둘의 차이를 실제(0.1초쯤)보다 크게 두어 내야 안타가 한쪽으로 쏠리지 않게 했다
export const RUN_TO_1B = { R: 4.7, L: 4.2 };
// 땅볼을 잡는 방법(2026-11-02 사용자 '러닝 스로가 더 빠르다, 몸을 날리는 건 1·2루간·3유간으로 가는 어려운 공만'):
//  set   공 길에 먼저 가서 서서 잡고 한 발 내디뎌 던진다(정면 땅볼)
//  run   달려가며 한 손으로 잡아 멈추지 않고 던진다(러닝 스로). 앞으로 달려 나오거나(charge) 1루 쪽으로 몸이 가는 공
//  plant 1루 반대쪽으로 달려가며 잡아(백핸드·2루 쪽) 발을 디뎌 멈추고 던진다
//  dive  달려도 글러브가 안 닿아 몸을 날려 잡고 일어나 던진다
// 서서 잡아도 주자보다 0.3초 넘게 먼저 닿으면 서서 잡고, 아니면 1루에 가장 빨리 닿는 방법을 고른다. 다이빙은 달려서는 안 닿는 공뿐이다.
// 전에는 늘 가장 일찍 닿는 자리에서 잡게 하고 잡은 뒤 1.45초를 들고 있다 던져서, 그림이 땅볼의 86%를 다이빙으로 그렸다
// 잡아서 공을 놓기까지(초, 서서 잡기)와 1루까지 평균 송구 빠르기(m/s). run·plant·dive는 PLAY_EX(초)와 PLAY_SPEED(빠르기 배수)를 쓴다.
// 1루수는 잡고 공을 챙겨 1루로 뛰거나 토스하기까지. 분석 스크립트(scripts/outcomes.js)로 맞춘 값이다
export const EXCHANGE = { '3루수': 0.95, '유격수': 0.95, '2루수': 0.9, '1루수': 0.4, '투수': 1.0 };
export const THROW_SPEED = { '3루수': 30, '유격수': 29, '2루수': 25, '투수': 25 };
export const PLAY_EX = { run: 0.75, plant: 1.25, dive: 2.0 }, PLAY_SPEED = { run: 0.85, plant: 0.92, dive: 0.78 };
// 투수가 1루 커버를 가는 길: 마운드 앞에서 1루 4m 앞 선 안쪽(0.6m)으로 달려가 선을 따라 베이스 안쪽을 밟는다(꺾이는 곳은 둥글게).
// 1루수가 멀리 잡으면 이 길을 뛰는 투수에게 토스하고, 투수는 베이스 1m 앞(TOSS_STEP초 앞)에서 받아 밟는다
export const PCOVER = (() => {
  const at = (d, o) => [BASE1[0] - Math.SQRT1_2 * (d + o), BASE1[1] - Math.SQRT1_2 * (d - o)];   // 1루에서 홈 쪽 선을 따라 d, 선 안쪽(내야 쪽)으로 o
  const a = [0, MOUND - 1.5], c = at(4, 0.6), k = 2 / Math.hypot(c[0] - a[0], c[1] - a[1]), c0 = [c[0] + (a[0] - c[0]) * k, c[1] + (a[1] - c[1]) * k], c1 = at(2, 0.4), pts = [a];
  for (let i = 0; i <= 8; i++) { const s = i / 8; pts.push([0, 1].map((j) => (1 - s) * (1 - s) * c0[j] + 2 * (1 - s) * s * c[j] + s * s * c1[j])); }
  pts.push(at(0, 0.3));
  return pts;
})();
export const PCOVER_LEN = PCOVER.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - PCOVER[i][0], q[1] - PCOVER[i][1]), 0), TOSS_STEP = 0.12;
// 친 타자가 출발점(타석)에서 at까지 가는 때. 1루를 밟는 때(RUN_TO_1B)에 맞춘 SPRINT 걸음 비율로 센다(1루수 태그용)
export function runnerTimeAt(at, bats) {
  const start = [(bats === 'L' ? 1 : -1) * 1.0, 0.3], full = sprintTime(Math.hypot(BASE1[0] - start[0], BASE1[1] - start[1]), 8.3, 0.8);
  return 0.28 + sprintTime(Math.hypot(at[0] - start[0], at[1] - start[1]), 8.3, 0.8) * (RUN_TO_1B[bats === 'L' ? 'L' : 'R'] - 0.28) / full;
}

// 1루 경주를 잰다(r는 바꾸지 않는다). 그림(fieldPlay)이 판정 없이 만든 시험용 결과에도 쓴다
export function computeRace(r, bats) {
  const path = groundPath(r);
  const f = r.fielder, pos = f.pos, isP = pos === '투수', [top, tau] = isP ? FIELD_SPEED.p : FIELD_SPEED.in, react = isP ? FIELD_REACT.p : FIELD_REACT.in;
  const home = fieldHome(f), hd = Math.hypot(home[0], home[1]), runner = RUN_TO_1B[bats === 'L' ? 'L' : 'R'];
  const toB1 = (at) => Math.hypot(at[0] - BASE1[0], at[1] - BASE1[1]), lane = (at) => Math.abs(at[0] - at[1]) / Math.SQRT2;   // lane: 1루선(주자 길목)에서 떨어진 거리
  // 잡는 방법마다 잡는 때·자리. 다이빙은 달려서 안 닿을 때만 본다. 수비 자리보다 5m 넘게 뒤(외야 쪽)로는 쫓지 않는다
  const cands = [], maxD = hd + 5;
  const set = reachGround(path, home, react, top, tau, SET_REACH, SET_SLACK, maxD);
  if (set) cands.push({ how: 'set', ...set });
  const run = reachGround(path, home, react, top, tau, RUN_REACH, 0, maxD);
  if (run) {
    const m = Math.hypot(run.at[0] - home[0], run.at[1] - home[1]), u = m > 0.01 ? [(run.at[0] - home[0]) / m, (run.at[1] - home[1]) / m] : [-home[0] / hd, -home[1] / hd];
    const d1 = toB1(run.at), w = [(BASE1[0] - run.at[0]) / d1, (BASE1[1] - run.at[1]) / d1], charge = -(u[0] * home[0] + u[1] * home[1]) / hd;   // charge: 홈 쪽으로 달려 나온 정도
    // 1루 반대쪽으로 몸이 가면(유격수·3루수의 백핸드, 2루수의 2루 쪽) 발을 디뎌 멈추고 던진다. 달려 나오거나 1루 쪽으로 가면 그대로 던진다
    cands.push({ how: charge < 0.5 && u[0] * w[0] + u[1] * w[1] < -0.25 ? 'plant' : 'run', charge: charge >= 0.5, ...run });
  } else {
    const dive = reachDive(path, home, react, top, tau, maxD);
    if (dive) cands.push({ how: 'dive', ...dive });
  }
  if (!cands.length) { const ic = interceptGround(path, home, react, top, tau); cands.push({ how: 'dive', forced: true, t: ic.t, at: ic.at }); }
  // 잡은 뒤 공이 1루에 닿는 때(1루수는 직접 밟거나 투수에게 토스하거나 오는 주자를 태그한다)
  const finish = (c) => {
    if (pos === '1루수') {
      if (c.how !== 'dive' && lane(c.at) < 2.5 && c.t + 0.3 <= runnerTimeAt(c.at, bats)) return { release: c.t, arrive: c.t + 0.3, to: 'tag' };   // 주자 길목에서 먼저 잡으면 오는 주자를 태그한다
      const gather = c.how === 'dive' ? 1.0 : EXCHANGE[pos], d = toB1(c.at), self = c.t + gather + sprintTime(Math.max(0, d - 0.5), top, tau);
      const flight = clamp(d / 12, 0.3, 0.6), toss = Math.max(FIELD_REACT.p + sprintTime(PCOVER_LEN, ...FIELD_SPEED.p), c.t + gather + flight + TOSS_STEP);
      if (self <= toss || d < 8) return { release: c.t + gather, arrive: self, to: 'self' };   // 베이스가 가까우면 직접 밟는다
      return { release: toss - TOSS_STEP - flight, arrive: toss, to: 'P' };
    }
    const ex = c.how === 'set' ? EXCHANGE[pos] : PLAY_EX[c.how], speed = THROW_SPEED[pos] * (c.how === 'set' ? 1 : PLAY_SPEED[c.how]);
    return { release: c.t + ex, arrive: c.t + ex + Math.max(0.15, (toB1(c.at) - 0.9) / speed), to: '1B' };
  };
  for (const c of cands) Object.assign(c, finish(c));
  const pick = cands.find((c) => c.how === 'set' && c.arrive <= runner - 0.3) ?? cands.reduce((a, b) => (b.arrive < a.arrive ? b : a));
  const margin = Math.round((runner - pick.arrive) * 1000) / 1000;   // 양수면 송구가 먼저(아웃). ms로 반올림해 기기마다 같게
  return { pos, how: pick.how, charge: !!pick.charge, field: { t: pick.t, at: pick.at }, release: { t: pick.release }, arrive: margin < -0.6 ? null : { t: pick.arrive, to: pick.to }, runner, margin, safe: margin <= 0 };
}
