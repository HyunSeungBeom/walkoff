// 지금 주자 자리(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김): 친 타자가 맞은 뒤 t초에 있는 자리(runnerAt)와 멈춘 뒤의 다리(runAfter),
// 끝내기 상황 누상 주자의 뛰기 계획(scenarioRuns)과 t초의 자리(baseRunnersAt), 끝내기가 정해지는 때(walkoffTime). 공이 맞기 전 상황판은 인자로 받는다
import { clamp, DEG, polar } from '../core/math.js';
import { BASE1, BASE2, BASE3, MOUND } from '../core/field.js';
import { HOME_PLATE, leadAt, RUN_JUMP, RUN_TAU, RUNNER_ROUTES, SLIDE_BRAKE as BASE_SLIDE } from '../core/scenario.js';
import { catchTime } from '../core/flight.js';
import { port } from './port.js';
import { flatDist, smooth, stepToward, unitTo } from './geom.js';
import { JOG, makeLeg, routeState, runTrack, SPRINT, standingRunner, TROT } from './route.js';
import { batsOf, headFirstAt, HF_DIVE, HF_UP, runnerReach, runPlan, runStartOf, SLIDE_DOWN, SLIDE_IN, SLIDE_UP } from './batter.js';
import { fieldPlay } from './fielding.js';

// 친 타자가 멈춘 뒤의 다리(2026-11-03 사용자 '주루 다듬기' 1·4·5번). 없으면 null(2루타·3루타는 미끄러져 베이스에 선다):
// - 단타는 1루로 돌아온다(외야수가 공을 던진 0.2초 뒤, 내야 안타는 멈추고 0.5초 뒤)
// - 아웃은 멈추고 0.6초 뒤 고개를 숙이고 파울 지역 오른쪽(1루 쪽 바깥)으로 천천히 뛰어 나간다(TROT). 전에는 멈춘 자리에 다음 공까지 서 있었다.
//   걷기는 뛰는 다리 계산에 느린 빠르기를 넣으면 무릎이 안쪽으로 꺾이고 발이 옆으로 벌어져서(사용자 '오징어 다리') 쓰지 않는다
// - 홈런은 홈을 밟으며 한 손을 들었다가(RAISE_T초) 더그아웃으로 천천히 뛰어 나간다. 전에는 홈플레이트 위에 정면으로 서 있었다
// 다리를 시작할 때는 TURN_T초 동안 제자리에서 몸을 돌린다(전에는 한 장면 만에 180도 돌았다). 거의 반대로 돌 때 단타는 1루 안쪽(투수 쪽)으로,
// 1루를 지나친 내야 안타는 파울 쪽으로 돈다(prefer). 1루로 돌아오면 SETTLE_T초 동안 투수 쪽으로 돌아선다(face)
const TURN_T = 0.35, SETTLE_T = 0.45, RAISE_T = 0.9;
export const DUGOUT = polar(69, 22);   // 1루 쪽 파울 지역(홈에서 22m). 화면에는 더그아웃을 그리지 않아서 그쪽으로 뛰어 나간다
function runAfter(r) {
  if (r.runAfter !== undefined) return r.runAfter;
  const plan = runPlan(r);
  if (!plan || !['single', 'out', 'hr'].includes(r.kind)) return (r.runAfter = null);
  const hf = plan.dive, stopT = hf ? hf.t0 + hf.up1 : plan.track.T[plan.track.T.length - 1], end = runStartOf(batsOf(r)) + plan.delay + stopT;
  // 멈춘 자리와 보는 쪽(뜬공 아웃은 1루 가는 길 중간, 머리부터 슬라이딩은 일어선 자리)
  const st = hf ? { x: hf.rest[0], z: hf.rest[1], dir: hf.dir } : routeState(plan.route, plan.track, plan.gait, stopT), at = [st.x, st.z];
  let leg;
  const fc = r.scnPlay?.dp?.out2 && !r.scnPlay.dp.out1;   // 끝내기 야수 선택: 타자는 1루에 산다
  if (r.kind === 'single' || fc) {
    const t0 = r.infield || fc ? end + 0.5 : Math.max(end + 0.3, (fieldPlay(r).ev.release ?? end) + 0.2);
    leg = { ...makeLeg(t0, [at, stepToward(BASE1, BASE2, 0.2)], TROT), prefer: r.infield || fc ? -1 : 1, face: [0, MOUND] };
  } else {
    // 아웃은 멈춘 자리에서 파울 지역 오른쪽(1루 쪽 바깥)으로 나간다. 1루 너머에서 홈 쪽 더그아웃으로 오면 카메라를 향해 비스듬히 뛰어서
    // 보폭이 옆으로 벌어져 보였다. 홈런은 홈에서 더그아웃 쪽이 카메라에서 옆 방향이라 그대로
    const exit = r.kind === 'hr' ? DUGOUT : [at[0] + 12, at[1] - 3];
    leg = { ...makeLeg(end + (r.kind === 'hr' ? RAISE_T : 0.6), [at, exit], TROT), down: r.kind === 'out' };
  }
  leg.from = st.dir; leg.dir0 = routeState(leg.route, leg.track, leg.gait, 0).dir;
  return (r.runAfter = leg);
}
// 보는 쪽 a에서 b로 u(0 → 1)만큼 돈 쪽. 거의 반대(166도 넘게)일 때는 prefer(+1 반시계, -1 시계) 쪽으로 돈다
function turnDir(a, b, u, prefer = 0) {
  let d = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
  if (prefer && Math.abs(d) > 2.9 && Math.sign(d) !== prefer) d += prefer * 2 * Math.PI;
  const th = Math.atan2(a[1], a[0]) + d * smooth(u);
  return [Math.cos(th), Math.sin(th)];
}
// 멈춘 뒤의 다리를 tt초 간 자리: 처음 TURN_T초는 제자리에서 돌고, 다리 끝에서는 서서 face 쪽으로 돈다. 아웃은 고개를 숙인다
function afterState(a, tt) {
  const end = a.route[a.route.length - 1], keep = { goals: [{ at: a.total, p: end }], drawShift: 0, lookFoul: false, top: a.gait.top };
  let run;
  if (tt < TURN_T) run = { ...standingRunner(a.route[0], turnDir(a.from, a.dir0, tt / TURN_T, a.prefer)), ...keep };
  else {
    const st = routeState(a.route, a.track, a.gait, tt - TURN_T), stopT = a.track.T[a.track.T.length - 1];
    if (st.speed < 0.05 && tt - TURN_T > 0.3) run = { ...standingRunner([st.x, st.z], a.face ? turnDir(st.dir, unitTo([st.x, st.z], a.face), (tt - TURN_T - stopT) / SETTLE_T) : st.dir), ...keep };
    else run = { ...st, ...keep };
  }
  if (a.down) run.look = [run.dir[0], -0.55, run.dir[1]];
  return run;
}
// 아웃된 타자는 고개를 젓는다(2026-11-11 사용자 '넘겨 ㄱㄱ', 작업 글 walkoff-motion.md '친 뒤 동작 묶음'): 땅볼 아웃은 1루를 밟고, 뜬공 아웃은 잡히고 SHAKE_DELAY초 뒤,
// 머리부터 미끄러진 아웃은 일어나 나가기 시작할 때부터 SHAKE_LEN초 동안 조금 숙인 채 좌우로 SHAKE_DEG도씩 초당 SHAKE_HZ번 젓는다(그동안 속도를 줄여 선다).
// 화면에 작게 보여서 실제보다 크게 젓는다. 몸이 가는 자리와 1루를 밟는 때는 그대로다
const SHAKE_DELAY = 0.15, SHAKE_LEN = 1.3, SHAKE_DEG = 42, SHAKE_HZ = 2.2;
function shakeFrom(r) {
  if (r.shakeAt !== undefined) return r.shakeAt;
  const plan = runPlan(r), dp = r.scnPlay?.dp;
  let t = null;
  if (plan && r.kind === 'out' && !(dp?.out2 && !dp.out1)) t = plan.dive ? runAfter(r).t0 : r.type === 'ground' ? runnerReach(r, BASE1) + SHAKE_DELAY : catchTime(r) + SHAKE_DELAY;
  return (r.shakeAt = t);
}
// 맞은 뒤 t초에 친 타자가 있는 자리와 보는 쪽. 아직 안 뛰거나 뛰지 않는 결과면 null
export function runnerAt(r, t) {
  const run = runState(r, t), s = run ? shakeFrom(r) : null;
  if (s == null || t < s || t >= s + SHAKE_LEN) return run;
  const u = t - s, a = SHAKE_DEG * DEG * Math.sin(2 * Math.PI * SHAKE_HZ * u) * smooth(u / 0.12) * (1 - smooth((u - SHAKE_LEN + 0.3) / 0.3)), c = Math.cos(a), sn = Math.sin(a), d = run.dir;
  return { ...run, look: [d[0] * c - d[1] * sn, -0.4, d[0] * sn + d[1] * c] };
}
function runState(r, t) {
  const plan = r && runPlan(r);
  const t0 = runStartOf(batsOf(r));
  if (!plan || t < t0) return null;
  const after = runAfter(r);
  if (after && t >= after.t0) return afterState(after, t - after.t0);   // 1루로 돌아오거나 더그아웃으로 걸어간다
  const tt = Math.max(0, t - t0 - plan.delay), st = routeState(plan.route, plan.track, plan.gait, tt);
  const drawShift = port.batSide() * port.batterShift() * clamp(1 - st.dist / 8, 0, 1);   // 폰은 타자를 화면 안으로 당겨 그려서, 주자도 처음 8m 동안 그만큼 옮겨 그린다
  const run = { ...st, goals: plan.goals, drawShift, lookFoul: ((r.kind === 'out' && r.type === 'ground') || r.infield) && st.dist > 27, top: plan.gait.top };
  const hf = plan.dive;
  if (hf && tt >= hf.t0) {   // 1루 머리부터 슬라이딩: 엎드리는 정도(u), 달리던 자세에서 섞는 정도(blend), 일어나는 정도(up), 멈춘 뒤 시간(rest)
    const tau = tt - hf.t0, m = headFirstAt(hf, tau), x = hf.from[0] + hf.dir[0] * m.d, z = hf.from[1] + hf.dir[1] * m.d;
    const dive = { u: clamp(tau / HF_DIVE, 0, 1), blend: smooth(tau / 0.1), up: clamp((tau - hf.up0) / HF_UP, 0, 1), rest: Math.max(0, tau - hf.stop), run };
    return { ...run, x, z, dir: hf.dir, speed: m.v, dist: hf.s0 + m.d, braking: true, bank: 0, lookFoul: false, dive };
  }
  if (r.kind === 'hr') {   // 홈을 밟기 0.45초 전부터 한 손을 들었다가 더그아웃으로 걷기 전에 내린다
    const stop = plan.track.T[plan.track.T.length - 1];
    run.raise = smooth((tt - stop + 0.45) / 0.25) * (1 - smooth((tt - stop - RAISE_T + 0.3) / 0.3));
  }
  if (plan.slide && tt >= plan.slideAt) {   // 2루타 슬라이딩: 눕는 정도(down)와 일어나는 정도(up), 멈춘 뒤 시간(rest)
    const stop = plan.track.T[plan.track.T.length - 1], rest = Math.max(0, tt - stop), up = smooth((rest - SLIDE_DOWN) / SLIDE_UP), bag = plan.slideBag ?? stepToward(BASE2, BASE1, 0.3);
    if (up >= 1) return { ...run, x: bag[0], z: bag[1], speed: 0, braking: false, bank: 0 };   // 일어나 베이스 위에 선다
    run.slide = { down: smooth((tt - plan.slideAt) / SLIDE_IN), up, rest, bag };
    run.braking = true;
  }
  return run;
}
// ===== 끝내기 상황의 누상 주자(2026-11-02 사용자 '끝내기에는 왜 주자가 없나, 1·2루라고 표시는 돼 있는데') =====
// 공을 던질 때는 누상에서 다음 베이스 쪽으로 리드해 서 있고(leadAt, core/scenario.js), 공 하나의 결과에 따라 판정(applyScenario)과 같은 베이스로 뛴다:
// 안타는 3루 주자가 들어오고 1루 주자가 2루, 2루타는 1루 주자가 3루, 홈런은 모두 들어온다(조깅), 내야 안타·볼넷은 밀리는 주자만 한 베이스,
// 희생플라이는 3루 주자가 3루로 돌아가 잡히는 순간 태그업해 들어온다. 그 밖(아웃·삼진·파울·볼)은 베이스로 돌아간다.
// 주루 플레이(2026-11-04, core/scenario.js가 정함): 단타 때 2루 주자는 홈에 미끄러져 들어가 승부하고(얕은 안타는 3루에서 멈춤), 외야 뜬공이 잡히면
// 2루 주자가 넉넉할 때 태그업해 3루에 미끄러져 들어가고, 병살 상황의 내야 땅볼이면 1루 주자가 2루에 미끄러져 들어간다. 아웃된 주자는 일어나 고개를 숙이고 나간다
const BASES = [BASE1, BASE2, BASE3, HOME_PLATE];
const BASE_RUN = { ...SPRINT, tau: RUN_TAU };   // 누상 주자는 리드한 자세에서 바로 내달린다(판정과 같은 값)
// 미끄러져 들어가는 다리: route(core RUNNER_ROUTES)를 판정과 같은 뛰기 표로 뛰어 끝에서 줄이며 미끄러진다. 끝나는 때가 판정의 주자 도착이다
function slideLeg(t0, route, bag) {
  const total = route.slice(1).reduce((a, q, i) => a + flatDist(route[i], q), 0), track = runTrack({ gait: BASE_RUN, route, total, until: Infinity, delay: 0, brake: BASE_SLIDE });
  const V = track.V, at = track.T[V.findIndex((v, i) => i > 0 && v < V[i - 1])];
  return { t0, route, gait: BASE_RUN, total, track, slide: { at, bag }, end: t0 + track.T[track.T.length - 1] };
}
// 아웃된 주자: 미끄러진 자리에서 일어나 고개를 숙이고 to 쪽으로 천천히 뛰어 나간다
const outLeg = (from, t0, to) => ({ ...makeLeg(t0 + SLIDE_DOWN + SLIDE_UP + 0.2, [from, to], TROT), down: true });
// 공 하나 동안 누상 주자들의 뛰기 계획(결과 r마다 한 번): [{ legs: [{ t0, route, track, gait }], start, scores, home }] home은 홈을 밟는 때.
// before는 공이 맞기 전 상황판(main.js가 game.scnBefore ?? game.scn을 넘긴다)
export function scenarioRuns(r, before) {
  if (r.baseRuns) return r.baseRuns;
  const bases = before.bases, walk = r.kind === 'ball' && before.count.b === 3;
  const forced = (r.kind === 'single' && r.infield) || walk, sac = r.kind === 'out' && r.type === 'fly' && bases[2] && before.outs + 1 < 3;
  const sp = r.scnPlay ?? {}, dp = sp.dp, leg = makeLeg;
  const path = (b, to) => { const pts = [leadAt(b)]; for (let k = b + 1; k < to; k++) pts.push(BASES[k]); pts.push(BASES[to]); return pts; };
  const runs = [];
  for (let b = 0; b < 3; b++) {
    if (!bases[b]) continue;
    let to = b, how = 'back';
    const legs = [];
    if (r.kind === 'hr') { to = 3; how = 'jog'; }
    else if (r.kind === 'single' && !r.infield) {
      if (b === 1 && sp.home && !sp.home.hold) {   // 홈 승부: 홈에 미끄러져 들어간다. 아웃이면 일어나 3루 쪽 파울 지역으로
        const L = slideLeg(RUN_JUMP, RUNNER_ROUTES.homeFrom2, HOME_PLATE);
        legs.push(L);
        if (!sp.home.safe) legs.push(outLeg(L.route[L.route.length - 1], L.end, [-9, 4]));
        runs.push({ legs, start: leadAt(b), scores: sp.home.safe, home: sp.home.safe ? L.end : null });
        continue;
      }
      to = b === 0 ? 1 : b === 1 && sp.home?.hold ? 2 : 3; how = 'run';
    }
    else if (r.kind === 'double') { to = b === 0 ? 2 : 3; how = 'run'; }
    else if (r.kind === 'triple') { to = 3; how = 'run'; }
    else if (forced && bases.slice(0, b).every(Boolean)) { to = b + 1; how = walk ? 'jog' : 'run'; }
    else if (dp && b === 0) {   // 병살 상황의 1루 주자: 2루에 미끄러져 들어간다. 2루에서 아웃이면 일어나 1루 쪽 파울 지역으로
      const L = slideLeg(RUN_JUMP, RUNNER_ROUTES.secondFrom1, BASE2);
      legs.push(L);
      if (dp.out2) legs.push(outLeg(L.route[L.route.length - 1], L.end, [26, 14]));
      runs.push({ legs, start: leadAt(b), scores: false, home: null });
      continue;
    }
    else if (dp && bases.slice(0, b).every(Boolean)) { to = b + 1; how = 'run'; }   // 1루 주자에게 밀린 주자
    else if (sac && b === 2) { to = 3; how = 'tag'; }
    if (how === 'run') legs.push(leg(0.12, path(b, to), SPRINT));
    else if (how === 'jog') legs.push(leg(walk ? 0.4 : 0.6, path(b, to), JOG));
    else {   // 베이스로 돌아간다(태그업은 돌아가서 잡히는 순간 다음 베이스로)
      legs.push(leg(0.15, [leadAt(b), BASES[b]], JOG));
      if (how === 'tag') legs.push(leg(fieldPlay(r).ev.catch ?? 1, [BASES[2], BASES[3]], SPRINT));
      else if (b === 1 && sp.tag?.go) { const L = slideLeg(sp.tag.catch.t, RUNNER_ROUTES.thirdFrom2, BASE3); legs.push(L); to = 2; }   // 2루 주자 태그업: 3루에 미끄러져 들어간다
    }
    const last = legs[legs.length - 1], scores = to === 3;
    runs.push({ legs, start: leadAt(b), scores, home: scores ? last.end ?? last.t0 + last.track.T[last.track.T.length - 1] : null });
  }
  return (r.baseRuns = runs);
}
// 맞은 뒤 t초에 누상 주자들(scenarioRuns의 계획)이 있는 자리와 자세 값
export function baseRunnersAt(runs, t) {
  return runs.map((run) => {
    let L = null;
    for (const l of run.legs) if (t >= l.t0) L = l;
    if (!L) return standingRunner(run.start);
    const tt = t - L.t0, st = routeState(L.route, L.track, L.gait, tt);
    if (L.slide && tt >= L.slide.at) {   // 미끄러져 들어가 SLIDE_DOWN초 누웠다가 일어난다(친 타자의 2루타와 같은 자세)
      const rest = Math.max(0, tt - L.track.T[L.track.T.length - 1]), up = smooth((rest - SLIDE_DOWN) / SLIDE_UP);
      if (up >= 1) return standingRunner(L.slide.bag, st.dir);
      return { ...st, drawShift: 0, lookFoul: false, top: L.gait.top, braking: true, slide: { down: smooth((tt - L.slide.at) / SLIDE_IN), up, rest, bag: L.slide.bag } };
    }
    const out = st.speed < 0.05 && tt > 0.3 ? { ...standingRunner([st.x, st.z]) } : { ...st, drawShift: 0, lookFoul: false, top: L.gait.top };
    if (L.down) out.look = [out.dir[0], -0.55, out.dir[1]];   // 아웃된 주자는 고개를 숙이고 나간다
    return out;
  });
}
// 끝내기 승리가 정해지는 때(맞은 뒤 초): 이긴 점수가 홈을 밟는 때. 홈런은 담장을 넘은 뒤 2초. before는 공이 맞기 전 상황판(game.scnBefore)
export function walkoffTime(r, before) {
  const need = before.away - before.home + 1;   // 몇 번째 점수에 이기는지
  if (r.kind === 'hr') return fieldPlay(r).revealReal + 2;
  const homes = scenarioRuns(r, before).filter((x) => x.scores).map((x) => x.home).sort((a, b) => a - b);
  return (homes[need - 1] ?? homes[homes.length - 1] ?? 0) + 0.6;
}
