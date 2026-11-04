// 끝내기 상황 규칙: 9회말 지고 있을 때 타석에 선다. 볼넷·삼진·주자 진루를 세고, 역전하는 순간 끝내기 승리다.
// 상황 목록과 공 하나의 결과에 따른 볼카운트·아웃·진루·득점·끝을 정한다. 화면에 띄울 글은 view/text.js(scenarioLabel·scenarioMessage)
// 서버도 이 파일로 판을 다시 돌린다(2026-11-04 인프라 세션과 정한 순서): mulberry32(시드) → makeScenario → 공마다 scenarioPitch →
// judgeSwing(공, dt, 타석) 또는 judgeTake(공) → applyScenario. 이 사이에 다른 무작위나 화면 값이 끼면 안 된다
import { clamp, pickWeighted } from './math.js';
import { BASE1, BASE2, BASE3, FAIR_SPRAY, fieldHome, INFIELDERS, OUTFIELDERS } from './field.js';
import { makePitch, PITCH_MIX } from './pitches.js';
import { PERFECT_BONUS, POINTS } from './score.js';
import { catchTime, flightPos, interceptRoll, reactOf, rollPath, speedOf } from './flight.js';
import { EXCHANGE, FIELD_SPEED, groundPath, interceptGround, PLAY_EX, PLAY_SPEED, reachGround, runArrive, SET_REACH, smoothRoute, sprintTime, THROW_SPEED } from './race.js';

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

// 다음 공: 투수는 3볼이면 존 안에 넣고, 2스트라이크면 유인구를 더 던진다. n은 몇째 공(1부터), lefty는 좌완
export function scenarioPitch(rnd, count, n, lefty) {
  const inZone = clamp(0.6 + (count.b === 3 ? 0.25 : 0) - (count.s === 2 && count.b < 2 ? 0.2 : 0), 0.3, 0.9);
  return makePitch(rnd, pickWeighted(rnd, PITCH_MIX), inZone, { n, lefty });
}

// 끝내기 상황 점수(2026-11-03 사용자 결정 '10구와 같은 점수, 정타 보너스 포함'): 안타·홈런마다 결과 점수 + 정타 보너스. 볼·연속 보너스·끝내기 2배는 없다
export const scenarioPoints = (r) => (r.hit ? (POINTS[r.kind] ?? 0) + (r.perfect ? PERFECT_BONUS : 0) : 0);

// ===== 주루 플레이(2026-11-03 사용자 요청 '태그 플레이, 힘들게 잡았다면 그런 주루 플레이, 병살도') =====
// 무작위 없이 판정 결과(r)와 누상 상황만으로 정한다. 그림(main.js)은 여기서 정한 때에 공과 주자를 닿게 그린다.
// 주자는 리드한 자리(LEAD)에서 맞은 RUN_JUMP초 뒤 출발해 베이스에 미끄러져 들어간다(그림의 뛰기 표와 같은 runArrive 계산)
export const LEAD = [2.5, 3.0, 2.0];   // 리드: 1루는 2루 쪽, 2루는 3루 쪽, 3루는 홈 쪽(m)
export const HOME_PLATE = [0, 0.3];
// 누상 주자는 리드한 자세에서 바로 내달려 친 타자(시간 상수 0.8초)보다 빨리 빨라지고(0.55초), 짧게(초속 16m씩 줄며) 미끄러져 들어간다
export const RUN_JUMP = 0.12, RUN_TOP = 8.3, RUN_TAU = 0.55, SLIDE_BRAKE = 16, SLIDE_SHORT = 0.95;   // 미끄러져 멈추는 자리는 베이스 0.95m 앞(발이 베이스에 닿는다)
const BASES = [BASE1, BASE2, BASE3, HOME_PLATE];
const toward = (a, b, d) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [a[0] + dx / l * d, a[1] + dz / l * d]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const leadAt = (b) => toward(BASES[b], BASES[b + 1], LEAD[b]);
const routeLen = (route) => route.slice(1).reduce((sum, q, i) => sum + dist(route[i], q), 0);
// 주자 길: from(리드한 자리·베이스)에서 베이스들을 지나 마지막 베이스에 미끄러져 들어간다. 그림도 이 길을 그대로 뛴다
export function slideRoute(from, bases) {
  const last = bases[bases.length - 1], prev = bases.length > 1 ? bases[bases.length - 2] : from;
  const pts = [from, ...bases.slice(0, -1), toward(last, prev, SLIDE_SHORT)];
  return pts.length > 2 ? smoothRoute(pts) : pts;
}
export const slideTime = (route) => runArrive(routeLen(route), RUN_TOP, RUN_TAU, SLIDE_BRAKE);
// 1·2루 주자가 맞은 뒤 다음 베이스에 미끄러져 닿는 때. 2루 주자는 3루를 돌아 홈까지(단타 홈 승부)
export const RUNNER_ROUTES = { homeFrom2: slideRoute(leadAt(1), [BASE3, HOME_PLATE]), secondFrom1: slideRoute(leadAt(0), [BASE2]), thirdFrom2: slideRoute(BASE2, [BASE3]) };
export const RUNNER_TIMES = Object.fromEntries(Object.entries(RUNNER_ROUTES).map(([k, route]) => [k, slideTime(route)]));

// 공을 주워 던지기까지(초)와 받고 태그하기까지(초). 외야수는 줍고 크로 홉으로 던진다(그림 pickUp·throwTo와 같은 때)
export const OF_EXCHANGE = 1.0, HOME_THROW = 30, TAG_TIME = 0.2, PIVOT = 0.75, FEED_SPEED = 24, RELAY_SPEED = 30;   // 홈 송구는 한 번 튀기는 공이라 30m/s
// 태그업: 잡는 방법마다 잡고 던지기까지(서서 기다려 잡기 std, 달려가며 run, 몸을 날려 dive), 주자가 이만큼(초) 넉넉해야 간다
export const TAG_EXCHANGE = { std: 1.0, run: 1.35, dive: 2.1 }, TAG_SAFE = 0.1;
const nearestOF = (spray) => OUTFIELDERS.reduce((b, f) => (Math.abs(f.a - spray) < Math.abs(b.a - spray) ? f : b));
const keystone = (spray) => INFIELDERS.slice(0, 4).reduce((b, f) => (Math.abs(f.a - spray) < Math.abs(b.a - spray) ? f : b));
const byPos = (pos) => [...INFIELDERS, ...OUTFIELDERS].find((f) => f.pos === pos);

// 안타 공을 줍는 수비수·때·자리(그림과 같은 계산): 뜬 안타는 떨어져 구르는 공을 가까운 외야수가, 얕게(48m 안) 떨어지면 가까운 내야수가 먼저 닿으면 줍는다.
// 땅볼 안타는 외야수가 달려 나와 막는다
export function hitPickup(r) {
  const side = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY), O = nearestOF(side);
  if (r.type === 'ground') {
    const path = groundPath(r), [top, tau] = speedOf(O), h = fieldHome(O), react = reactOf(O);
    const ic = reachGround(path, h, react, top, tau, SET_REACH, 0.35, Infinity, path.tStop + 4) ?? interceptGround(path, h, react, top, tau, path.tStop + 4);
    return { pos: O.pos, t: ic.t, at: ic.at };
  }
  const roll = rollPath(r), dur = roll.dur;
  let best = { f: O, ...interceptRoll(roll, fieldHome(O), reactOf(O), ...speedOf(O), dur + 0.35, 0.35, SET_REACH) };
  if (dist(roll.land, [0, 0]) < 48) {
    const fi = keystone(side), ic = interceptRoll(roll, fieldHome(fi), reactOf(fi), ...speedOf(fi), dur + 0.35, 0.35, SET_REACH);
    if (ic.t < best.t) best = { f: fi, ...ic };
  }
  return { pos: best.f.pos, t: best.t, at: best.at };
}
// 단타 때 2루 주자의 홈 승부: 주운 공이 홈에 닿아 태그하는 때와 주자가 홈에 미끄러져 닿는 때. 공이 먼저면 아웃
export function homePlay(r) {
  const pk = hitPickup(r), release = pk.t + OF_EXCHANGE, speed = OUTFIELDERS.some((f) => f.pos === pk.pos) ? HOME_THROW : RELAY_SPEED;
  const arrive = release + Math.max(0.25, dist(pk.at, HOME_PLATE) / speed), runner = RUN_JUMP + RUNNER_TIMES.homeFrom2;
  const margin = Math.round((runner - arrive - TAG_TIME) * 1000) / 1000;   // 양수면 공이 먼저(아웃). ms로 반올림해 기기마다 같게
  return { pickup: pk, release, arrive, runner, margin, safe: margin <= 0 };
}
// 뜬공을 잡는 방법(그림 catchAir와 같은 갈래): 먼저 가서 기다리면 std, 달려가며 잡으면 run, 그래도 못 닿으면 dive
export function airCatch(r) {
  const f = byPos(r.fielder.pos), tc = catchTime(r), q = flightPos(r, tc), at = [q.x, q.z], h = fieldHome(f), [top, tau] = speedOf(f), react = reactOf(f), d = dist(h, at);
  const how = react + sprintTime(d, top, tau) + 0.45 <= tc ? 'std' : react + sprintTime(Math.max(0, d - 0.4), top, tau) <= tc + 0.03 ? 'run' : 'dive';
  return { pos: f.pos, t: tc, at, how };
}
// 뜬공 아웃 때 2루 주자 태그업: 잡는 순간 2루를 떠나 3루에 미끄러져 닿는 때와 3루로 던진 공이 닿아 태그하는 때. 넉넉히(TAG_SAFE) 살 때만 간다
export function tagUp(r) {
  const c = airCatch(r), release = c.t + TAG_EXCHANGE[c.how], arrive = release + Math.max(0.25, dist(c.at, BASE3) / HOME_THROW), runner = c.t + RUNNER_TIMES.thirdFrom2;
  const margin = Math.round((runner - arrive - TAG_TIME) * 1000) / 1000;
  return { catch: c, release, arrive, runner, margin, go: margin < -TAG_SAFE };
}
// 병살(1루 주자, 아웃 2개 미만, 내야 땅볼): 잡은 수비수가 2루로 던져(유격수·2루수가 베이스 가까이서 잡으면 직접 밟는다) 1루 주자를 잡고,
// 2루에 들어간 사람이 몸을 돌려 1루로 던진다. 1루 경주(computeRace)의 잡는 때·자리·방법을 이어 쓴다.
// 2루가 늦으면(주자가 먼저 닿는다) 그냥 1루로 던져 타자만 잡는다. 1루가 늦으면 2루 한 명만(야수 선택)
export function doublePlay(r) {
  const race = r.race, pos = race.pos, at = race.field.at, how = race.how;
  const cover = pos === '2루수' || pos === '1루수' || pos === '투수' ? '유격수' : '2루수';   // 2루에 들어가 받는 사람
  const runner2 = RUN_JUMP + RUNNER_TIMES.secondFrom1, d2 = dist(at, BASE2);
  let atSecond, self = false;
  if ((pos === '유격수' || pos === '2루수') && d2 < 4) { atSecond = race.field.t + 0.3 + sprintTime(Math.max(0, d2 - 0.4), ...FIELD_SPEED.in); self = true; }   // 공을 들고 직접 2루를 밟는다
  else {
    const ex = how === 'set' ? (EXCHANGE[pos] ?? 0.9) : PLAY_EX[how] ?? 0.9, speed = (THROW_SPEED[pos] ?? FEED_SPEED) * (how === 'set' ? 1 : PLAY_SPEED[how] ?? 1);
    atSecond = race.field.t + ex * 0.8 + Math.max(0.2, d2 / Math.min(speed, FEED_SPEED));   // 2루로는 가까워 짧게 챙겨 부드럽게 던진다
  }
  const force = Math.round((runner2 - atSecond) * 1000) / 1000;   // 양수면 2루에서 아웃
  const atFirst = atSecond + PIVOT + dist(BASE2, BASE1) / RELAY_SPEED, margin = Math.round((race.runner - atFirst) * 1000) / 1000;   // 양수면 1루에서도 아웃(병살)
  return { pos, cover: self ? pos : cover, self, atSecond, runner2, force, out2: force > 0, atFirst, runner1: race.runner, margin, out1: force > 0 && margin > 0 };
}

// 공 하나의 결과를 상황에 반영한다. 돌려주는 것: 들어온 점수(runs), 끝난 타석(pa: G 출루·Y 볼넷·R 아웃, 안 끝났으면 null),
// 알릴 일(play: walk 볼넷·k-looking 루킹 삼진·k-swinging 헛스윙 삼진·sac-fly 희생플라이·tag-up 태그업 진루·out-home 홈 아웃·
// dp 병살·fc 야수 선택·out 아웃, 없으면 null). 주루 플레이를 했으면 r.scnPlay에 그 계산(home·tag·dp)을 남긴다(그림이 쓴다)
// 주자: 안타면 3루 주자는 들어오고 2루 주자는 홈 승부, 1루 주자는 2루로, 2루타면 1루 주자가 3루로 간다
export function applyScenario(s, r) {
  const c = s.count, [b1, b2, b3] = s.bases, outsBefore = s.outs;
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
    pa = 'R'; play = 'out';
    if (r.type === 'ground' && b1 && outsBefore < 2 && r.race) {   // 병살 상황: 1루 주자를 2루에서 잡고 1루로
      const dp = doublePlay(r);
      r.scnPlay = { dp };
      // 병살이면 타자·1루 주자, 야수 선택이면 1루 주자, 2루가 늦으면 타자가 아웃. 밀린 주자는 한 베이스씩 가고(2루 주자는 늘 밀린다),
      // 밀리지 않은 3루 주자는 그대로 선다. 만루면 밀린 3루 주자가 들어온다(세 번째 아웃이 나면 점수는 없다)
      s.outs += dp.out1 ? 2 : 1;
      play = dp.out1 ? 'dp' : dp.out2 ? 'fc' : 'out';
      if (b2 && b3 && s.outs < 3) runs = 1;
      s.bases = [dp.out2 && !dp.out1, !dp.out2, b2 || b3];
    } else {
      s.outs++;
      if (r.type === 'fly' && s.outs < 3 && (b3 || b2)) {
        const tag = b2 && r.fielder && Number.isFinite(r.ev) && OUTFIELDERS.some((f) => f.pos === r.fielder.pos) ? tagUp(r) : null;
        if (tag) r.scnPlay = { tag };
        const go = !!tag?.go;
        if (b3) { runs = 1; play = 'sac-fly'; }   // 3루 주자가 태그업해서 들어온다
        else if (go) play = 'tag-up';
        s.bases = [b1, b2 && !go, go];
      }
    }
  } else if (r.kind === 'single' && r.infield) {   // 내야 안타: 밀려서 한 베이스씩만 간다(만루면 3루 주자만 들어온다)
    if (b1 && b2 && b3) runs = 1;
    s.bases = [true, b1 || b2, (b1 && b2) || b3]; pa = 'G';
  } else if (r.kind === 'single') {
    pa = 'G';
    runs = b3 ? 1 : 0;
    if (b2 && !Number.isFinite(r.ev)) runs++;   // 타구 숫자가 없는 결과(규칙 시험용)는 예전처럼 들어온다
    else if (b2) {   // 2루 주자는 홈으로 뛰고 외야수는 홈으로 던진다. 3루 주자 점수로 이미 이겼으면 승부 없이 끝난다
      // 얕게 떨어져 내야수가 주우면 3루에서 멈춘다(2026-11-04 사용자 결정. 송구가 짧아 홈으로 뛰면 95% 넘게 죽었다)
      const home = homePlay(r), shallow = !OUTFIELDERS.some((f) => f.pos === home.pickup.pos);
      r.scnPlay = { home };
      if (s.home + runs > s.away || home.safe && !shallow) runs++;
      else if (shallow) { home.hold = true; play = 'hold'; }
      else { s.outs++; play = 'out-home'; }
    }
    s.bases = [true, b1, !!r.scnPlay?.home?.hold];
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
