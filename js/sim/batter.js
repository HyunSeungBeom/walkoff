// 친 타자 주루 계획(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김): 결과마다 뛰는 길과 뛰기 표, 베이스를 밟는 때, 1루 머리부터 슬라이딩. 지금 자리는 runner.js
// ===== 타자 주루(2026-11-02 사용자 요청 '타자의 주루 플레이', 사용자 결정: 친 타자만) =====
// 공을 앞으로 보내면 스윙을 마친 뒤 방망이를 놓고(땅으로 굴러 떨어진다) 지금 입은 모습 그대로 뛴다. 판정은 그대로이고 정해진 결과를 몸으로 보여 준다.
// 실제 1루 주루를 따른다(사용자가 첫 두 시안을 보고 '너무 어정쩡하다, 실제 선수가 어떻게 뛰는지 보고 묘사해 달라'):
// - 전력 질주(셋째 시안을 보고 사용자 '뜀걸음처럼 뛴다, 진짜 전력으로 뛰는 느낌이 들게'): 출발할 때 40도 넘게 숙였다가 빨라질수록 세워 최고 속도에서 15도쯤 숙인다.
//   팔은 팔꿈치를 굽혀 앞으로는 손이 턱 높이, 뒤로는 엉덩이 뒤까지 크게 치고, 뗀 발은 뒤꿈치를 엉덩이 쪽으로 차올린 뒤 허벅지가 수평이 되게 무릎을 끌어올렸다가
//   정강이를 펴 몸 앞에 쓸어 딛는다. 빠르기는 단거리 출발처럼 처음에 빨리 늘고(시간 상수 0.85초) 최고 초속 8m라 1루까지 4.3초쯤 걸린다
// - 땅볼 아웃: 1루 선 바깥(파울 쪽) 주로로 달려 1루 앞쪽을 밟고 그대로 지나쳐 달린 뒤 짧은 걸음으로 멈추며 오른쪽(파울 쪽)을 본다. 송구가 먼저 닿는다
// - 뜬공·직선타 아웃: 잡히면 속도를 줄여 멈춘다
// - 안타·2루타·홈런: 1루 5m쯤 앞에서 바깥으로 살짝 휘었다가(바나나 모양) 1루 안쪽을 밟고 돈다. 안타는 2루 쪽으로 3m, 2루타는 2루에 선다
// - 홈런: 0.5초쯤 공을 바라보다가 초속 5.4m 조깅으로 몸을 세우고 팔을 가볍게 흔들며 홈까지 돈다
// 파울·헛스윙은 뛰지 않는다. 다음 공을 누르면 타석으로 돌아온다
import { BASE1, BASE2, BASE3 } from '../core/field.js';
import { RUN_TO_1B, smoothRoute } from '../core/race.js';
import { catchTime } from '../core/flight.js';
import { port } from './port.js';
import { flatDist, unitTo } from './geom.js';
import { alongRoute, arcRoute, JOG, RUN_START, runTrack, SPRINT, trackAt } from './route.js';

// 타석 자리(우타, 좌타는 x를 뒤집는다): 홈플레이트 가운데에서 3루 쪽으로 1m. 친 타자는 여기서 뛰기 시작한다
export const BATTER_X = -1.0, BATTER_Z = 0.3;
// 2루타 슬라이딩(2026-11-02 사용자 '주루 마무리'): 2루 3m쯤 앞에서 초속 10m씩 줄며 미끄러져 왼발로 베이스를 짚고(SLIDE_IN초에 몸을 눕힌다),
// SLIDE_DOWN초 누워 있다가 SLIDE_UP초에 일어나 베이스 위에 선다. 단타는 1루를 4.5m 돌아 섰다가 외야수가 공을 던지면 1루로 돌아오고,
// 내야 안타는 1루를 지나쳐 멈췄다가 0.5초 뒤 돌아온다(TROT: 천천히 뛰어 돌아오기)
export const SLIDE_BRAKE = 10, SLIDE_IN = 0.12, SLIDE_DOWN = 0.5, SLIDE_UP = 0.45;
// 1루 머리부터 슬라이딩(2026-11-05 유저 피드백 '1루 슬라이딩', 사용자 결정은 '확률적' 대신 '아슬아슬할 때만'): 1루 경주가 간발이면(느린 화면과
// 세이프·아웃이 뜨는 공과 같은 조건, headFirstAt1) 친 타자가 몸을 날려 배로 미끄러지며 두 손으로 베이스를 짚는다. 판정은 그대로이고, 손이 베이스
// 앞쪽 끝에 닿는 때가 판정에서 주자가 1루를 밟는 때(race.runner)다. 손이 엉덩이 앞 HF_REACH m라 엉덩이는 달려 지나갈 때보다 그만큼 뒤에 있어야 해서,
// 닿기 HF_LEAD초 앞(엉덩이가 베이스 4m쯤 앞)에서 날아 닿을 때까지 고르게 줄이고(초속 10m씩쯤, 공마다 맞춰 정한다), 닿은 뒤에는 손이 베이스를 잡아
// HF_STOP m 안에 멈춘다. 몸은 HF_DIVE초에 엎드리고, 멈춘 뒤 HF_LIE초 엎드려 있다가 HF_UP초에 일어나 세이프면 1루에 서고 아웃이면 고개를 숙이고
// 파울 지역으로 나간다(runAfter)
export const HF_LEAD = 0.5, HF_DIVE = 0.3, HF_REACH = 1.05, HF_STOP = 0.2, HF_LIE = 0.45, HF_UP = 0.75;
const headFirstAt1 = (r) => !!r.race?.arrive && r.race.arrive.to !== 'tag' && Math.abs(r.race.margin) < 0.15 && !r.scnPlay?.dp?.out2;
// 친 타자의 타석(판정이 남긴 r.bats, 없으면 지금 설정)과 뛰기 시작하는 때. RUN_START(0.28초)에 출발하면 1루를 우타 4.458초·좌타 4.275초에 밟는다(재 둔 값).
// 판정(RUN_TO_1B)과 같은 때에 밟도록 출발을 옮긴다: 우타는 0.24초 늦게(친 뒤 0.52초), 좌타는 0.08초 일찍(0.2초)
export const batsOf = (r) => (r && r.bats === 'L') || (!(r && r.bats) && port.batSide() < 0) ? 'L' : 'R';
const RUN_FREE_1B = { R: 4.458, L: 4.275 };
export const runStartOf = (bats) => RUN_START + RUN_TO_1B[bats] - RUN_FREE_1B[bats];
// 홈런 주루 길(2026-11-02 사용자 '홈런 때 주자가 도는 게 어색하다, 부드럽게'): 베이스 사이는 곧게, 베이스마다 반지름 5m 원호로 돌며 원호 가운데가
// 베이스를 지난다(그래서 베이스 6~7m 앞부터 바깥으로 2m쯤 벌어진다). 전에는 베이스 앞뒤 2m에만 점을 둔 곡선(캣멀-롬)이라 베이스마다 S자로 출렁여
// 몸이 좌우로 20도씩 번갈아 기울었다
const TROT_R = 5;
const trotRoute = (S) => arcRoute(S, [BASE1, BASE2, BASE3], [0, 0.3], TROT_R);
export function runPlan(r) {
  if (r.runPlan !== undefined) return r.runPlan;
  // 길은 폰 그림 이동(batterShift) 없이 타석에서 잰다. 판정(1루 경주)과 1루를 밟는 때가 같아야 해서다. 폰에서는 그림만 처음 8m 동안 옮긴다(runnerAt)
  const S = [batsOf(r) === 'L' ? -BATTER_X : BATTER_X, BATTER_Z], u1 = unitTo([0, 0], BASE1), foul = [u1[1], -u1[0]];   // 1루 선 바깥(파울 쪽)
  const on1 = (d, out) => [u1[0] * d + foul[0] * out, u1[1] * d + foul[1] * out];   // 홈에서 1루 선을 따라 d, 바깥으로 out
  const toward = (a, b, d) => { const u = unitTo(a, b); return [a[0] + u[0] * d, a[1] + u[1] * d]; };
  const banana = [S, on1(8, 0.6), on1(22.5, 1.8), on1(27.1, 0.15)];   // 1루 5m 앞에서 바깥으로 휘었다가 1루 안쪽을 밟는다
  let plan = null;
  if ((r.kind === 'out' && r.type === 'ground') || r.infield) plan = { pts: [S, on1(10, 0.5), on1(26.9, 0.45), on1(33.5, 0.5)], race1: true };   // 주로를 따라 1루를 밟고 지나쳐 달린다(내야 안타도 1루 경주라 같은 길)
  else if (r.kind === 'out') plan = { pts: [S, on1(10, 0.5), on1(26.9, 0.45), on1(33.5, 0.5)], until: catchTime(r) };
  else if (r.kind === 'single') plan = { pts: [...banana, toward(BASE1, BASE2, 4.5)] };
  else if (r.kind === 'double') plan = { pts: [...banana, toward(BASE1, BASE2, 7), toward(BASE2, BASE1, 0.95)], brake: SLIDE_BRAKE, slide: true };
  else if (r.kind === 'triple') plan = { route: arcRoute(S, [BASE1, BASE2], toward(BASE3, BASE2, 0.95), 4), brake: SLIDE_BRAKE, slide: true, slideBag: toward(BASE3, BASE2, 0.3) };   // 1·2루를 돌아 3루에 미끄러져 들어간다
  else if (r.kind === 'hr') plan = { route: trotRoute(S), gait: JOG, delay: 0.5, brake: 3 };   // 홈에서는 천천히 줄여 밟는다
  if (plan) {
    plan.gait ??= SPRINT; plan.until ??= Infinity; plan.delay ??= 0;
    plan.route ??= smoothRoute(plan.pts);
    plan.total = plan.route.slice(1).reduce((sum, q, i) => sum + flatDist(plan.route[i], q), 0);
    plan.track = runTrack(plan);
    if (plan.slide) { const V = plan.track.V; plan.slideAt = plan.track.T[V.findIndex((v, i) => i > 0 && v < V[i - 1])]; }   // 줄이기 시작하는 때 = 미끄러지기 시작
    if (plan.race1 && headFirstAt1(r)) plan.dive = headFirst(r, plan);   // 1루 간발: 달려 지나가는 길에서 머리부터 미끄러져 들어간다
    // 지나가는 베이스와 그 길 위 거리(화면이 주자가 가는 베이스 쪽을 잡는다). 마지막은 멈추는 자리
    plan.goals = [];
    for (const b of [BASE1, BASE2, BASE3, [0, 0]]) {
      let best = Infinity, at = 0, sum = 0;
      for (let i = 1; i < plan.route.length; i++) { sum += flatDist(plan.route[i - 1], plan.route[i]); const d = flatDist(plan.route[i], b); if (d < best) { best = d; at = sum; } }
      if (best < 1.5 && at > (plan.goals.length ? plan.goals[plan.goals.length - 1].at : 0)) plan.goals.push({ at, p: b });
    }
    plan.goals.push({ at: plan.total, p: plan.route[plan.route.length - 1] });
  }
  return (r.runPlan = plan);
}
// 머리부터 슬라이딩의 자리와 때. t0는 날기 시작하는 뛰기 표의 시각이고, 나머지 때(stop 멈춤, up0·up1 일어나기 시작·끝)는 날기 시작한 뒤 초다.
// 손을 대는 곳은 1루 앞쪽 끝(베이스 가운데에서 홈 쪽으로 0.2m, 선 바깥으로 0.15m)이다. 엉덩이가 간 거리는 닿기까지 v0·τ - a·τ²/2이고
// (닿을 때 손이 그곳에 오게 a를 정한다), 닿은 뒤에는 HF_STOP m 안에 멈춘다
function headFirst(r, plan) {
  const t0 = r.race.runner - runStartOf(batsOf(r)) - plan.delay - HF_LEAD, st = trackAt(plan.track, t0), from = alongRoute(plan.route, st.s);
  const u1 = unitTo([0, 0], BASE1), hand = [BASE1[0] - u1[0] * 0.2 + u1[1] * 0.15, BASE1[1] - u1[1] * 0.2 - u1[0] * 0.15];
  const dir = unitTo(from, hand), dTouch = flatDist(from, hand) - HF_REACH, v0 = st.v;
  const a = Math.max(0, 2 * (v0 * HF_LEAD - dTouch) / (HF_LEAD * HF_LEAD)), vTouch = Math.max(0.5, v0 - a * HF_LEAD), a2 = vTouch * vTouch / (2 * HF_STOP);
  const stop = HF_LEAD + vTouch / a2, d = dTouch + HF_STOP;
  return { t0, stop, from, dir, s0: st.s, v0, a, dTouch, vTouch, a2, rest: [from[0] + dir[0] * d, from[1] + dir[1] * d], up0: stop + HF_LIE, up1: stop + HF_LIE + HF_UP };
}
// 날기 시작하고 tau초 뒤 엉덩이가 간 거리와 빠르기
export function headFirstAt(D, tau) {
  if (tau <= HF_LEAD) return { d: D.v0 * tau - 0.5 * D.a * tau * tau, v: D.v0 - D.a * tau };
  const q = Math.min(tau - HF_LEAD, D.vTouch / D.a2);
  return { d: D.dTouch + D.vTouch * q - 0.5 * D.a2 * q * q, v: Math.max(0, D.vTouch - D.a2 * q) };
}
// 친 타자가 베이스 b를 밟는(가장 가까이 가는) 때(맞은 뒤 초). 그 베이스까지 가지 않으면 null
export function runnerReach(r, b) {
  const plan = runPlan(r);
  if (!plan) return null;
  let best = Infinity, at = 0, sum = 0;
  for (let i = 1; i < plan.route.length; i++) { sum += flatDist(plan.route[i - 1], plan.route[i]); const d = flatDist(plan.route[i], b); if (d < best) { best = d; at = sum; } }
  if (best > 1.5) return null;
  const i = plan.track.S.findIndex((x) => x >= at - 0.05);
  return runStartOf(batsOf(r)) + plan.delay + plan.track.T[i < 0 ? plan.track.T.length - 1 : i];
}
