// 수비 일정(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김): 친 공마다 수비수 8명이 언제 어디서 무엇을 하는지(fieldPlay)와 t초의 자세(actorSkeleton). 그리기는 main.js
// ===== 수비 =====
// 친 공 뒤의 수비(2026-11-02 사용자 '진짜 실전 야구처럼'). 판정(classify)이 정한 결과를, 공이 맞는 순간 수비 8명(투수 포함, 포수는 화면 뒤라 뺌)이
// 실제 야구에서 맡는 일대로 움직여 보여 준다(주자 없는 상황 기준): 공을 맡은 사람은 쫓아가 잡아 던지고, 나머지는 베이스 커버·송구 뒤 백업으로 간다.
// 수비수는 투수와 같은 3D 인형(assembleFigure → drawBatterFigure, 상대 팀 유니폼)이고, 뛸 때는 주자 걸음(runnerSkeleton)을 쓴다.
// 전에는 맡은 1~2명만 움직이고 나머지는 서 있었으며, 카메라를 정면으로 보는 납작한 인형이라 외야 쪽으로 뛰면 뒷걸음질처럼 보였다
import { clamp, DEG, lerp, polar } from '../core/math.js';
import { BASE1, BASE2, BASE3, FAIR_SPRAY, fenceDist, INFIELDERS, MOUND, OUTFIELDERS } from '../core/field.js';
import {
  computeRace, DIVE_GLOVE, diveShort, FIELD_REACT, FIELD_SPEED, groundPath, interceptGround, PCOVER, PCOVER_LEN, PLAY_EX, reachGround, RUN_REACH,
  SET_REACH, sprintDist, sprintTime, TOSS_STEP,
} from '../core/race.js';
import { HOME_PLATE, HOME_THROW, TAG_TIME } from '../core/scenario.js';
import { catchTime, flightDuration, flightPos, interceptRoll, rollPath, THROW_OUT } from '../core/flight.js';
import { port } from './port.js';
import { bendJoint, faceTo, flatDist, smooth, stepToward, unitTo, V } from './geom.js';
import { blendSkeleton, fielderSkeleton, fpose, makeTrack, pitcherSkeleton } from './pose.js';
import { alongRoute, runTrack, trackAt } from './route.js';
import { runnerReach, runPlan } from './batter.js';
import { runnerSkeleton } from './runpose.js';

const THROW_IN = 45, TRANSFER = 0.15, REVEAL_MAX = 2.6;   // 외야 송구 빠르기(THROW_OUT)와 뜬공 잡는 높이는 core/flight.js
export const FIELDERS = [...INFIELDERS.filter((f) => f.pos !== '투수'), ...OUTFIELDERS];
export const PITCHER_F = INFIELDERS.find((f) => f.pos === '투수');
export const DEFENSE = [...FIELDERS, PITCHER_F];   // 그리기·역할은 투수까지 8명. FIELDERS(7명)는 예전 그대로 둔다
export const homeOf = (f) => (f === PITCHER_F ? [0, MOUND - 1.5] : polar(f.a, f.d));   // 투수는 공을 던진 뒤 마운드 앞 수비 자세 자리
const byPos = (pos) => DEFENSE.find((f) => f.pos === pos);
// 포수는 평소 카메라 바로 앞이라 그리지 않고, 끝내기 상황 홈 승부 때만 홈플레이트 3루 쪽 앞에서 공을 받아 태그한다(2026-11-04)
export const CATCHER_F = { pos: '포수', a: 0, d: -0.9 }, CATCH_SPOT = [-0.9, 1.0];
const nearestOutfielder = (spray) => OUTFIELDERS.reduce((b, f) => (Math.abs(f.a - spray) < Math.abs(b.a - spray) ? f : b));
const isOutfielder = (f) => OUTFIELDERS.includes(f);
// 수비수 걸음: 내야 최고 초속 7m, 외야 8.5m(주자보다 빨리 서고, 덜 숙인다). 조깅은 커버·백업에 일찍 닿을 때
const FIELD_RUN_IN = { top: FIELD_SPEED.in[0], tau: FIELD_SPEED.in[1], cad: [1.8, 0.05], D: 0.21, effort: 1, lean: 0.2, start: 0.35, Dstart: 0.06, drive: 0.2, dust: 0 };
const FIELD_RUN_OUT = { ...FIELD_RUN_IN, top: FIELD_SPEED.out[0], tau: FIELD_SPEED.out[1] };
const FIELD_JOG = { top: 4, tau: 0.5, cad: [1.4, 0.07], D: 0.26, effort: 0, lean: 0.06, start: 0.1, Dstart: 0.04, drive: 0.05, dust: 0 };
const BLEND = 0.15;   // 동작이 바뀔 때 앞 자세에서 섞는 시간(초)

// 수비 자세(키 값, 투수와 같은 pitchVec 모양). 홈 쪽(-z)을 보고 선 오른손잡이 기준이고, 자리(발 사이)가 원점이다. 왼쪽이 +x다
const FPOSE = {
  stand: fpose({}),
  readyIn: fpose({ pel: [0, 0.7, 0.08], lean: 0.45, lf: [0.32, 0.03, 0.02], rf: [-0.32, 0.03, 0.02], gl: [0.12, 0.58, -0.35], bh: [-0.12, 0.6, -0.32] }),   // 내야: 낮게 숙여 글러브를 앞에
  readyOut: fpose({ pel: [0, 0.8, 0.05], lean: 0.35, lf: [0.25, 0.03, 0], rf: [-0.25, 0.03, 0], gl: [0.2, 0.62, -0.2], bh: [-0.2, 0.62, -0.2] }),   // 외야: 무릎에 손
  fieldLow: fpose({ pel: [0, 0.5, 0.18], lean: 1.1, lf: [0.38, 0.03, -0.12], rf: [-0.34, 0.03, 0.14], gl: [0.1, 0.22, -0.55], bh: [-0.06, 0.3, -0.5] }),   // 땅볼을 앞에서 잡는다
  catchHigh: fpose({ pel: [0, 0.95, 0], lean: -0.05, lf: [0.16, 0.03, 0], rf: [-0.14, 0.03, 0.06], gl: [0.1, 2.0, -0.2], bh: [-0.1, 1.85, -0.15] }),
  catchChest: fpose({ pel: [0, 0.88, 0], lean: 0.15, lf: [0.2, 0.03, -0.05], rf: [-0.18, 0.03, 0.08], gl: [0.08, 1.2, -0.42], bh: [-0.06, 1.15, -0.38] }),
  cover: fpose({ pel: [0, 0.88, 0.02], lean: 0.2, lf: [0.2, 0.03, -0.12], rf: [-0.2, 0.03, 0.1], gl: [0.18, 1.3, -0.38], bh: [-0.08, 1.2, -0.3] }),   // 베이스에서 던지는 쪽에 글러브
  stretch: fpose({ pel: [0.05, 0.62, -0.4], lean: 0.55, lf: [0.08, 0.03, -0.95], rf: [-0.05, 0.03, 0.05], gl: [0.12, 1.0, -1.05], bh: [-0.12, 0.95, -0.55] }),   // 오른발로 베이스를 밟고 몸을 뻗는다
  backup: fpose({ pel: [0, 0.72, 0.05], lean: 0.5, lf: [0.3, 0.03, 0], rf: [-0.3, 0.03, 0], gl: [0.22, 0.6, -0.25], bh: [-0.22, 0.6, -0.25] }),
  hold: fpose({ pel: [0, 0.9, 0], lean: 0.08, gl: [0.12, 1.15, -0.3], bh: [-0.06, 1.15, -0.32] }),   // 잡은 공을 글러브에 들고 선다
  point: fpose({ bh: [-0.12, 2.1, -0.3] }),   // 내야 뜬공: 투수가 손으로 가리킨다
  squat: fpose({ pel: [0, 0.48, 0.1], lean: 0.3, lf: [0.36, 0.03, -0.05], rf: [-0.36, 0.03, -0.05], gl: [0.15, 0.8, -0.42], bh: [-0.15, 0.68, -0.22] }),   // 포수가 쪼그려 앉아 받을 준비
  slump: fpose({ pel: [0, 0.74, 0.1], lean: 0.95, lf: [0.24, 0.03, -0.02], rf: [-0.24, 0.03, 0.02], gl: [0.2, 0.5, -0.22], bh: [-0.2, 0.5, -0.22] }),   // 무릎에 손을 짚고 숙인다(홈런 맞은 투수)
  gather: fpose({ pel: [0, 0.84, 0.06], hip: 215, sh: 195, lean: 0.25, tilt: 0.05, lf: [0.06, 0.03, -0.32], rf: [-0.02, 0.03, 0.3], gl: [0.12, 1.2, -0.28], bh: [-0.02, 1.18, -0.18] }),   // 잡은 공을 글러브에서 빼며 던질 쪽으로 몸을 닫는다
};
const FTRACK = {
  // 던지기: 글러브 쪽 어깨를 받는 쪽으로 → u 0.55에 손이 머리 앞 높이에서 공을 놓는다 → 몸을 넘겨 마무리
  throw: makeTrack([
    [0, fpose({ pel: [0, 0.88, 0.12], hip: 200, sh: 185, lean: 0, tilt: 0.08, lf: [0.04, 0.03, -0.42], rf: [0, 0.03, 0.3], gl: [0.12, 1.32, -0.42], bh: [-0.15, 1.6, 0.75] })],
    [0.55, fpose({ pel: [0, 0.84, -0.12], hip: 255, sh: 270, lean: 0.35, tilt: 0.12, lf: [0.05, 0.03, -0.48], rf: [-0.08, 0.08, 0.22], gl: [0.28, 1.05, -0.2], bh: [-0.22, 1.72, -0.55] })],
    [1, fpose({ pel: [0, 0.8, -0.22], hip: 285, sh: 310, lean: 0.6, tilt: 0.1, lf: [0.05, 0.03, -0.5], rf: [-0.12, 0.25, -0.05], gl: [0.3, 0.95, -0.05], bh: [0.18, 0.78, -0.55] })],
  ]),
  // 다이빙: 박차고 몸을 날려 배로 떨어진다(글러브가 2.5m 앞까지). 끝 자세는 일어나기의 첫 자세와 1.5m 앞에서 이어진다
  dive: makeTrack([
    [0, fpose({ pel: [0, 0.82, 0], lean: 0.6, lf: [0.12, 0.03, -0.1], rf: [-0.12, 0.2, 0.3], gl: [0.2, 1.0, -0.5], bh: [-0.2, 0.95, -0.3] })],
    [0.35, fpose({ pel: [0, 0.55, -0.9], lean: 1.35, lf: [0.12, 0.45, -0.1], rf: [-0.12, 0.6, -0.12], gl: [0.18, 0.55, -2.0], bh: [-0.18, 0.55, -1.7] })],
    [0.6, fpose({ pel: [0, 0.3, -1.4], lean: 1.42, lf: [0.15, 0.15, -0.95], rf: [-0.15, 0.25, -0.75], gl: [0.18, 0.22, -2.45], bh: [-0.18, 0.25, -2.15] })],
    [1, fpose({ pel: [0, 0.28, -1.5], lean: 1.45, lf: [0.15, 0.1, -1.05], rf: [-0.15, 0.12, -0.85], gl: [0.2, 0.18, -2.55], bh: [-0.2, 0.2, -2.25] })],
  ]),
  getUp: makeTrack([
    [0, fpose({ pel: [0, 0.28, 0], lean: 1.45, lf: [0.15, 0.1, 0.45], rf: [-0.15, 0.12, 0.65], gl: [0.2, 0.18, -1.05], bh: [-0.2, 0.2, -0.75] })],
    [0.5, fpose({ pel: [0, 0.5, 0.1], lean: 0.5, lf: [0.2, 0.03, -0.3], rf: [-0.2, 0.15, 0.45], gl: [0.25, 0.6, -0.3], bh: [-0.25, 0.6, -0.3] })],
    [1, fpose({ pel: [0, 0.8, 0.05], lean: 0.3, lf: [0.25, 0.03, 0], rf: [-0.25, 0.03, 0], gl: [0.22, 0.8, -0.2], bh: [-0.22, 0.8, -0.2] })],
  ]),
  // 홈런 공을 잡으러 담장 앞에서 뛰어오른다(담장 쪽을 본다)
  leap: makeTrack([
    [0, fpose({ pel: [0, 0.7, 0], lean: 0.3, lf: [0.15, 0.03, -0.05], rf: [-0.15, 0.03, 0.05], gl: [0.2, 1.0, -0.3], bh: [-0.2, 0.95, -0.3] })],
    [0.35, fpose({ pel: [0, 1.4, -0.1], lean: -0.1, lf: [0.12, 0.6, 0.05], rf: [-0.12, 0.56, 0.15], gl: [0.12, 2.8, -0.2], bh: [-0.2, 2.0, 0] })],
    [0.7, fpose({ pel: [0, 1.2, -0.1], lean: -0.05, lf: [0.12, 0.4, 0], rf: [-0.12, 0.3, 0.1], gl: [0.15, 2.4, -0.25], bh: [-0.22, 1.7, 0] })],
    [1, fpose({ pel: [0, 0.85, 0], lean: 0.2, gl: [0.25, 1.1, -0.2], bh: [-0.25, 1.0, -0.1] })],
  ]),
  // 크로 홉: 공을 챙긴 자세에서 오른발을 왼발 뒤로 엇갈려 딛으며 받는 쪽으로 0.4m 뛰어 나가 던지기 첫 자세(FTRACK.throw의 0, 0.4m 앞)로 들어간다
  hop: makeTrack([
    [0, fpose({ pel: [0, 0.84, 0.06], hip: 215, sh: 195, lean: 0.25, tilt: 0.05, lf: [0.06, 0.03, -0.32], rf: [-0.02, 0.03, 0.3], gl: [0.12, 1.2, -0.28], bh: [-0.02, 1.18, -0.18] })],
    [0.45, fpose({ pel: [0, 0.95, -0.15], hip: 205, sh: 190, lean: 0.15, tilt: 0.05, lf: [0.05, 0.12, -0.5], rf: [-0.02, 0.18, -0.12], gl: [0.12, 1.3, -0.45], bh: [-0.12, 1.35, 0.1] })],
    [0.75, fpose({ pel: [0, 0.9, -0.2], hip: 200, sh: 186, lean: 0.05, tilt: 0.06, lf: [0.05, 0.15, -0.65], rf: [0, 0.03, -0.1], gl: [0.12, 1.32, -0.6], bh: [-0.15, 1.5, 0.45] })],
    [1, fpose({ pel: [0, 0.88, -0.28], hip: 200, sh: 185, lean: 0, tilt: 0.08, lf: [0.04, 0.03, -0.82], rf: [0, 0.03, -0.1], gl: [0.12, 1.32, -0.82], bh: [-0.15, 1.6, 0.35] })],
  ]),
  // 아래로 던져 주기(토스, 1루수 → 1루로 뛰어 오는 투수): 공 쥔 손을 몸 뒤 아래에서 앞으로 흔들어 허리 높이에서 놓고, 손끝이 받는 사람을 가리킨다
  toss: makeTrack([
    [0, fpose({ pel: [0, 0.78, 0.05], hip: 250, sh: 245, lean: 0.45, lf: [0.14, 0.03, -0.32], rf: [-0.14, 0.03, 0.22], gl: [0.25, 0.95, -0.2], bh: [-0.2, 0.5, 0.12] })],
    [0.55, fpose({ pel: [0, 0.8, -0.08], hip: 262, sh: 266, lean: 0.35, lf: [0.14, 0.03, -0.32], rf: [-0.14, 0.06, 0.18], gl: [0.28, 0.98, -0.1], bh: [-0.08, 0.92, -0.5] })],
    [1, fpose({ pel: [0, 0.86, -0.12], hip: 270, sh: 272, lean: 0.2, lf: [0.14, 0.03, -0.32], rf: [-0.12, 0.12, 0.08], gl: [0.27, 1.0, -0.05], bh: [-0.04, 1.32, -0.52] })],
  ]),
  // 홈런 맞은 투수: 어깨가 먼저 처지고 숙여 무릎에 손을 짚는다 / 천천히 일어난다
  slump: makeTrack([
    [0, fpose({})],
    [0.4, fpose({ pel: [0, 0.88, 0.04], lean: 0.25, gl: [0.22, 0.8, -0.08], bh: [-0.22, 0.8, -0.06] })],
    [1, FPOSE.slump],
  ]),
  rise: makeTrack([
    [0, FPOSE.slump],
    [0.6, fpose({ pel: [0, 0.88, 0.03], lean: 0.25, gl: [0.24, 0.82, -0.08], bh: [-0.24, 0.82, -0.06] })],
    [1, fpose({ lean: 0.08 })],
  ]),
};
const THROW_LEN = 0.45, THROW_AT = 0.55, DIVE_LEN = 0.6, DIVE_HIT = 0.55, GETUP_LEN = 0.7;   // 던지기는 0.45초 동작의 55%에 공을 놓는다
// 수비 다듬기(2026-11-04, 사용자 우선순위 ④): 투수 옆 FLINCH_NEAR m 안을 초속 8m 넘게 지나가는 땅볼에 투수가 움찔한다(FLINCH_LEN초, 공이 지나기
// FLINCH_LEAD초 앞에 시작해 지날 때 가장 높이 뜨고, 공 반대쪽으로 FLINCH_STEP m 비킨다). 뜬공을 잡은 외야수는 LOB_WAIT초 뒤 중계하러 나온 키스톤에게
// 초속 LOB_SPEED m로 높게(거리의 LOB_ARC배) 던져 준다. 홈런이면 투수가 공이 담장을 넘고 SLUMP_DELAY초 뒤 무릎을 짚고, SLUMP_HOLD초 뒤 일어난다
const FLINCH_NEAR = 2, FLINCH_LEN = 0.6, FLINCH_LEAD = 0.18, FLINCH_STEP = 0.15;
const LOB_WAIT = 0.9, LOB_SPEED = 28, LOB_LEN = 0.6, LOB_ARC = 0.06;
const SLUMP_DELAY = 0.2, SLUMP_LEN = 0.7, SLUMP_HOLD = 2.4, RISE_LEN = 0.9;
// 움찔: 몸을 낮췄다가 공이 지날 때 공 반대쪽으로 뛰어올라 다리를 접고 글러브를 공 쪽 아래로 내린 뒤 내려앉아 선다.
// s는 공이 지나는 쪽(+1 왼쪽, -1 오른쪽, 0 가랑이 사이), g는 글러브 손(+1 왼손, 좌완은 -1). 홈 쪽을 본 자세 기준이다
const FLINCH = new Map();
function flinchTrack(s, g) {
  const key = `${s},${g}`;
  if (!FLINCH.has(key)) {
    const sh = -s * FLINCH_STEP, hands = (glove, other) => (g > 0 ? { gl: glove, bh: other } : { gl: other, bh: glove }), side = s || g;
    FLINCH.set(key, makeTrack([
      [0, fpose({ pel: [0, 0.8, 0.05], lean: 0.35, lf: [0.28, 0.03, 0], rf: [-0.28, 0.03, 0], ...hands([g * 0.15, 0.72, -0.3], [-g * 0.15, 0.72, -0.28]) })],
      [0.3, fpose({ pel: [sh * 0.6, 1.08, 0.06], lean: 0.12, tilt: -s * 0.18, lf: [0.24 + sh * 0.6, s > 0 ? 0.42 : 0.3, 0.06], rf: [-0.24 + sh * 0.6, s < 0 ? 0.42 : 0.3, 0.06], ...hands([side * 0.38, 0.42, -0.32], [-side * 0.42, 1.28, 0.05]) })],
      [0.6, fpose({ pel: [sh, 0.72, 0.06], lean: 0.42, tilt: -s * 0.06, lf: [0.28 + sh, 0.03, 0.02], rf: [-0.28 + sh, 0.03, 0.02], ...hands([g * 0.2, 0.6, -0.3], [-g * 0.2, 0.75, -0.2]) })],
      [1, fpose({ pel: [sh, 0.9, 0.02], lean: 0.1, lf: [0.17 + sh, 0.03, 0], rf: [-0.17 + sh, 0.03, 0.02], ...hands([g * 0.24, 0.9, -0.1], [-g * 0.24, 0.9, -0.06]) })],
    ]));
  }
  return FLINCH.get(key);
}
// 몸 앞(키의 -z)으로 나는 다이빙. 엉덩이는 달려온 빠르기 v0로 날기 시작해 글러브가 공에 닿을 때(DIVE_HIT) F m를 날고, 땅에 떨어져 미끄러지며 선다.
// 발·손은 엉덩이를 따라간다(팔다리 길이는 그대로). 전에는 다이빙 첫 장면이 멈춰 있어 달려오던 몸이 잠깐 섰다가 튀어 나갔다
const diveTrack = (F, v0 = 0) => {
  const tc = DIVE_HIT * DIVE_LEN, T2 = DIVE_LEN - tc, a = 2 * (F - v0 * tc) / (tc * tc), vc = Math.max(0, v0 + a * tc), slide = Math.min(vc * T2 / 2, 0.3 * F);
  const z = (t) => (t <= tc ? v0 * t + 0.5 * a * t * t : F + slide * (1 - (1 - (t - tc) / T2) ** 2));
  return Object.assign((u) => { const v = FTRACK.dive(u).slice(), dz = -z(clamp(u, 0, 1) * DIVE_LEN) - v[2]; for (const i of [2, 8, 11, 14, 17]) v[i] += dz; return v; }, { end: F + slide });
};
// 토스는 0.45초 동작의 55%에 놓는다. 달려가며 잡는 동작은 잡기 0.15초 전에 달리던 걸음에서 이어진다. 수비수는 초속 9m씩 줄여 선다
const TOSS_LEN = 0.45, TOSS_AT = 0.55, PICK_LEAD = 0.15, FIELD_BRAKE = 9, HOP_LEN = 0.35, HOP_D = 0.4;   // 크로 홉은 던지기 앞 0.35초에 0.4m
// 몸(엉덩이·몸통·손)과 두 발을 따로 키 장면으로 잇는 동작. 발은 디딘 동안 같은 값을 두 번 넣어 땅에 붙인다(미끄러지지 않게)
function composeTrack(body, lf, rf) {
  const B = makeTrack(body), L = makeTrack(lf), R = makeTrack(rf);
  return (u) => { const v = B(u).slice(); v.splice(6, 3, ...L(u)); v.splice(9, 3, ...R(u)); return v; };
}
// 달려가며 잡는 땅볼의 동작(1루 경주의 run·plant, 2026-11-02 사용자 '러닝 스로'). 잡을 때 몸 자리 at과 face(던질 쪽)를 기준으로 키 값을 그 공에 맞춰 만든다.
// u: 달려온 방향(마당), v: 잡을 때 빠르기, ball: 잡는 공(flightPos), ex: 잡고 공을 놓기까지(초), bare: 거의 멈춘 공을 맨손으로 줍는다.
//  run   한 손으로 떠 올려 오른발을 앞으로 엇갈려 딛고, 왼발을 던질 쪽으로 디디며 옆으로 던진다(러닝 스로). 몸은 달려온 쪽으로 계속 미끄러지듯 간다
//  plant 백핸드로 잡아 오른발로 버텨 멈추고 몸을 던질 쪽으로 닫는다(던지기는 FTRACK.throw로 잇는다)
// 잡기 PICK_LEAD초 전부터 시작한다. 돌려주는 것: 동작 track, 길이 len(초), 공을 놓는 진행 rel(run만), 끝난 몸 자리 endAt(마당)
function pickTrack(kind, at, face, u, v, ball, ex, bare = false, room = Infinity) {   // room: 달려온 쪽으로 미끄러질 수 있는 거리(담장 앞)
  const fw = [Math.cos(face), Math.sin(face)], lw = [-Math.sin(face), Math.cos(face)];
  const loc = (w) => [w[0] * lw[0] + w[1] * lw[1], -(w[0] * fw[0] + w[1] * fw[1])];   // 마당 방향 → 키 좌표(x 왼쪽, z 뒤)
  const m = loc(u), mL = [-m[1], m[0]], b = loc([ball.x - at[0], ball.z - at[1]]);
  const P = (a, s, y) => [m[0] * a + mL[0] * s, y, m[1] * a + mL[1] * s];   // 달려온 쪽으로 a, 그 왼쪽으로 s, 높이 y
  const off = (p, x, y, z) => [p[0] + x, y, p[2] + z];                      // p에서 키 좌표로 왼쪽 x, 뒤 z, 높이 y
  const near = (a, ref) => ref + ((((a - ref) % 360) + 540) % 360) - 180;
  const psi = near(270 + Math.atan2(m[0], -m[1]) / DEG, 200);   // 달려온 쪽을 보는 몸 방향(키의 hip·sh 값, 던질 쪽으로 닫힌 자세 쪽에서 가까운 값)
  const back = -v * PICK_LEAD, G = [b[0], Math.max(0.06, ball.y), b[1]], nearG = (a, s, y) => { const q = P(a, s, 0); return [G[0] + q[0], y, G[2] + q[2]]; };
  const K = (o) => fpose(o);
  let ts, body, lf, rf, rel = null, endPel;
  if (kind === 'run') {
    // 잡은 뒤에는 몸을 세우며(엉덩이 0.84m) 공 쥔 팔을 몸 뒤 옆으로 낮게 뺐다가 어깨 높이 옆에서 놓는다(옆으로 던지기)
    const D = Math.min(clamp(0.42 * v, 1.2, 2.6), Math.max(0.3, room)), p0 = P(back, 0, 0.8), p1 = P(0, 0, 0.6), p2 = off(P(0.45 * D, 0, 0), 0, 0.82, -0.05), p3 = off(P(0.75 * D, 0, 0), 0, 0.82, -0.2), p4 = off(P(D, 0, 0), 0, 0.86, -0.35);
    ts = [-PICK_LEAD, 0, 0.3, ex, ex + 0.4];
    body = [
      K({ pel: p0, hip: psi, sh: psi, lean: 0.55, gl: P(back + 0.45, 0.2, 0.5), bh: P(back - 0.3, -0.25, 0.9) }),
      K({ pel: p1, hip: psi, sh: psi, lean: 1.0, gl: bare ? P(-0.1, 0.4, 0.62) : G, bh: bare ? G : nearG(-0.3, -0.18, 0.34) }),
      K({ pel: p2, hip: lerp(psi, 205, 0.6), sh: 192, lean: 0.3, tilt: 0, gl: off(p2, 0.25, 1.1, -0.3), bh: off(p2, -0.38, 1.02, 0.4) }),
      K({ pel: p3, hip: 250, sh: 266, lean: 0.35, tilt: -0.1, gl: off(p3, 0.3, 1.0, -0.05), bh: off(p3, -0.52, 1.2, -0.3) }),
      K({ pel: p4, hip: 285, sh: 305, lean: 0.45, tilt: 0, gl: off(p4, 0.22, 0.95, 0.15), bh: off(p4, 0.25, 0.85, -0.35) }),
    ];
    const lp = P(0.35, 0.14, 0.03), rp = P(0.45 * D + 0.12, -0.1, 0.03), lq = off(P(0.75 * D + 0.12, 0.1, 0), 0, 0.03, -0.2);
    // 던진 뒤 오른발이 앞으로 넘어와 디디고 왼발이 따라 나온다(몸은 계속 미끄러져 간다)
    const rq = off(P(0.75 * D + 0.6, -0.12, 0), 0, 0.03, -0.3);
    lf = [[-PICK_LEAD, P(back + 0.15, 0.13, 0.2)], [-0.04, lp], [0, lp], [0.12, lp], [0.3, P(0.45 * D + 0.05, 0.13, 0.22)], [ex - 0.06, lq], [ex, lq], [ex + 0.1, lq], [ex + 0.4, off(P(D + 0.25, 0.12, 0), 0, 0.12, -0.35)]];
    rf = [[-PICK_LEAD, P(back - 0.5, -0.12, 0.12)], [0, P(-0.4, -0.12, 0.3)], [0.2, rp], [0.3, rp], [0.45, rp], [ex, off(P(0.45 * D + 0.4, -0.1, 0), 0, 0.22, -0.05)], [ex + 0.2, rq], [ex + 0.4, rq]];
    endPel = p4;
  } else {
    const D = Math.min(clamp(0.28 * v, 0.6, 2.4), Math.max(0.3, room)), p0 = P(back, 0, 0.78), p1 = P(0, 0, 0.6), p2 = P(0.7 * D, 0, 0.7), p3 = P(D, 0, 0.84);
    ts = [-PICK_LEAD, 0, 0.3, 0.6];
    body = [
      K({ pel: p0, hip: psi, sh: psi, lean: 0.6, gl: P(back + 0.45, -0.2, 0.5), bh: P(back - 0.3, 0.25, 0.9) }),
      K({ pel: p1, hip: psi, sh: psi - 12, lean: 1.0, gl: G, bh: P(-0.35, 0.4, 0.85) }),
      K({ pel: p2, hip: (psi + 205) / 2, sh: 198, lean: 0.55, tilt: 0.03, gl: off(p2, 0.15, 1.0, -0.3), bh: off(p2, -0.1, 1.05, -0.25) }),
      K({ pel: p3, hip: 210, sh: 188, lean: 0.2, tilt: 0.05, gl: off(p3, 0.12, 1.22, -0.3), bh: off(p3, -0.02, 1.2, -0.25) }),
    ];
    const rp = P(0.25, -0.15, 0.03), rq = P(D - 0.1, -0.15, 0.03), lm = P(0.55 * D, 0.2, 0.03), lq = off(p3, 0.05, 0.03, -0.32);
    rf = [[-PICK_LEAD, P(back - 0.4, -0.13, 0.15)], [-0.05, rp], [0, rp], [0.08, rp], [0.32, rq], [0.6, rq]];
    lf = [[-PICK_LEAD, P(back + 0.2, 0.13, 0.03)], [-0.1, P(back + 0.2, 0.13, 0.03)], [0, P(-0.2, 0.14, 0.22)], [0.12, P(0.4 * D, 0.18, 0.15)], [0.2, lm], [0.36, lm], [0.5, off(lq, 0, 0.08, 0)], [0.6, lq]];
    endPel = p3;
  }
  const len = ts[ts.length - 1] + PICK_LEAD, U = (t) => (t + PICK_LEAD) / len;
  const lead = fpose({ ...Object.fromEntries(['hip', 'sh', 'lean'].map((k, i) => [k, body[0][3 + i]])), pel: P(-v * 2 * PICK_LEAD, 0, 0.8), gl: body[0].slice(12, 15), bh: body[0].slice(15, 18) });   // 달려오던 빠르기로 들어오게
  const track = composeTrack([[U(-2 * PICK_LEAD), lead], ...body.map((v, i) => [U(ts[i]), v])], lf.map(([t, q]) => [U(t), q]), rf.map(([t, q]) => [U(t), q]));
  if (kind === 'run') rel = U(ex);
  const world = (q) => [at[0] + lw[0] * q[0] - fw[0] * q[2], at[1] + lw[1] * q[0] - fw[1] * q[2]];
  return { track, len, rel, endAt: world(endPel), posAt: (t) => world(track(clamp(U(t), 0, 1)).slice(0, 3)) };   // posAt: 잡은 뒤 t초의 몸 자리(마당)
}

const HOME_FACE = (at) => faceTo(at, [0, 0]);

const speedOf = (f) => (f === PITCHER_F ? FIELD_SPEED.p : isOutfielder(f) ? FIELD_SPEED.out : FIELD_SPEED.in);
const reactOf = (f) => (f === PITCHER_F ? FIELD_REACT.p : isOutfielder(f) ? FIELD_REACT.out : FIELD_REACT.in);
const gaitOf = (f) => (f === PITCHER_F ? { ...FIELD_RUN_IN, top: FIELD_SPEED.p[0], tau: FIELD_SPEED.p[1] } : isOutfielder(f) ? FIELD_RUN_OUT : FIELD_RUN_IN);
const readyOf = (f) => (isOutfielder(f) ? FPOSE.readyOut : FPOSE.readyIn);
const inPark = (p, margin) => { const d = Math.hypot(p[0], p[1]), lim = fenceDist(Math.atan2(p[0], p[1]) / DEG) - margin; return d > lim ? [p[0] * lim / d, p[1] * lim / d] : p; };   // 담장 margin m 안으로
// 2루타인데 외야수가 공을 너무 일찍 주워서 2루로 가는 공이 주자를 이만큼(초)보다 오래 기다려야 하면(중계수가 공을 들고 서 있다),
// 외야수가 떨어지는 공에 몸을 날렸다가 놓치고 공이 담장까지 굴러가는 쪽으로 다시 만든다
const MISS_WAIT = 0.6;

// 한 타구의 수비 진행. 시간은 맞은 뒤 초(game.flightT).
// acts[pos]: 그 수비수가 언제 무엇을 하는지. move는 길을 따라 뛰기(주자 걸음), shuffle은 짧게 옆걸음, pose는 자리에서 자세·동작(track이면 len초 동안 움직인다)
// ball(t): 공의 자리(날아가는·구르는 공 → 글러브 → 던진 공), focus(t): 카메라가 볼 곳(송구 때는 받는 사람 쪽으로 미리 간다),
// reveal: 결과 글자를 띄울 때, end: 수비가 끝나는 때, moves: 뛰기 목록(예전 모양: f, from, to, t0, t1)
export function fieldPlay(r) {
  if (r.play) return r.play;
  let play = buildPlay(r);
  if ((r.kind === 'double' || r.kind === 'triple') && play.ev.wait > MISS_WAIT) play = buildPlay(r, { miss: true });
  return (r.play = play);
}
function buildPlay(r, o = {}) {
  const play = { acts: Object.fromEntries(DEFENSE.map((f) => [f.pos, []])), segs: [], moves: [], end: 0, reveal: 0, focusSegs: [], ev: {} };   // ev: 잡기·송구·도착 같은 사건 시각
  const C = CATCHER_F;
  if (r.scnPlay?.home && !r.scnPlay.home.hold) play.acts[C.pos] = [];   // 포수는 끝내기 홈 승부 때만 움직인다
  const { acts, segs, moves } = play;
  const last = (f) => acts[f.pos][acts[f.pos].length - 1];
  const where = (f) => { const e = last(f); return !e ? homeOf(f) : e.k === 'move' ? e.to : e.k === 'shuffle' ? e.to : e.endAt ?? e.at; };
  const freeAt = (f) => { const e = last(f); return e ? (e.t1 ?? e.t0) : 0; };
  const pose = (f, t0, at, face, v, o = {}) => acts[f.pos].push({ k: 'pose', t0, at, face, v, name: o.name ?? 'pose', look: o.look, t1: o.t1 });
  const anim = (f, t0, at, face, track, len, o = {}) => acts[f.pos].push({ k: 'pose', t0, t1: t0 + len, at, face, track, len, name: o.name ?? 'pose', look: o.look, endAt: o.endAt });
  // 지금 자리에서 to로 뛰어 닿는 때를 돌려준다. stop이 false면 멈추지 않고 to를 지나는 때에 끝난다(달려가며 잡기, 다이빙 앞). 짧으면 옆걸음
  const run = (f, to, t0, o = {}) => {
    const from = where(f), d = flatDist(from, to), G = o.gait ?? gaitOf(f);
    if (d < 0.05) return t0;
    if (d < 2.5 && !o.force) {
      const t1 = t0 + Math.max(0.3, 1.15 * sprintTime(d, G.top, G.tau));   // 전력으로 뛸 때와 비슷한 때에 닿는다
      acts[f.pos].push({ k: 'shuffle', t0, t1, from, to, face: o.face, look: o.look, v: o.v ?? readyOf(f) });
      return t1;
    }
    const over = o.stop === false ? 12 : 0, u = unitTo(from, to), route = [from, [to[0] + u[0] * over, to[1] + u[1] * over]];
    const track = runTrack({ gait: G, route, total: d + over, until: Infinity, delay: 0, brake: FIELD_BRAKE });
    const i = o.stop === false ? track.S.findIndex((s) => s >= d) : track.T.length - 1;
    const t1 = t0 + track.T[i < 0 ? track.T.length - 1 : i];
    acts[f.pos].push({ k: 'move', t0, t1, from, to, route, track, gait: G, look: o.look, reach: o.reach });
    moves.push({ f, from, to, t0, t1 });
    return t1;
  };
  // 마감까지 to에 가서 endPose로 선다. 전력으로 1초 넘게 일찍 닿으면 조깅으로, 그래도 2초 넘게 일찍이면 늦게 출발한다. 늦으면 전력으로(백업은 닿는 데까지)
  const arriveBy = (f, to, deadline, endPose, o = {}) => {
    const from = where(f), t0 = Math.max(freeAt(f), reactOf(f) + (o.delay ?? 0)), [top, tau] = speedOf(f);
    if (o.name === 'backup' && t0 + sprintTime(flatDist(from, to), top, tau) > deadline + 0.6) to = stepToward(from, to, Math.max(0, sprintDist(deadline + 0.6 - t0, top, tau)));   // 백업은 마감까지 갈 수 있는 데까지
    const d = flatDist(from, to);
    let gait = gaitOf(f), start = t0;
    const jog = sprintTime(d, FIELD_JOG.top, FIELD_JOG.tau) + 0.6;
    if (d >= 2.5 && t0 + jog <= deadline - 0.3) { gait = FIELD_JOG; start = Math.max(t0, deadline - 1 - jog); }
    else if (t0 + sprintTime(d, top, tau) + 0.8 < deadline - 2) start = deadline - 2 - sprintTime(d, top, tau);
    const t1 = run(f, to, start, { gait, look: o.look });
    if (endPose) pose(f, t1, to, o.face ?? faceTo(to, o.faceTo ?? [0, 0.3]), endPose, { name: o.name ?? 'ready', look: o.look });
    return t1;
  };
  const seg = (t0, at, by = null) => segs.push({ t0, at, by });   // by: 공을 쥔 수비수(자기가 쥔 공은 보지 않는다)
  // 글러브(맨손) 속 공. 카메라에서 볼 때 몸통 뒤에 있으면 가려서 그리지 않는다(등을 보이며 뛰는 투수가 가슴 앞에 든 공이 등 위에 그려졌다)
  const inBody = (k, g) => { const c = k.chest, eye = port.eye(), d = V.sub(c, [eye.x, eye.y, eye.z]), n = V.len(d) || 1, q = V.sub(g, c), along = V.dot(q, d) / n; return along > 0.06 && V.len(V.sub(q, V.mul(d, along / n))) < 0.2; };
  const held = (f) => (t) => { const k = actorSkeleton(play, f, t), g = k.hands.l; return { x: g[0], y: g[1], z: g[2], trail: false, hidden: inBody(k, g) }; };
  const inHand = (f) => (t) => { const k = actorSkeleton(play, f, t), g = k.hands.r; return { x: g[0], y: g[1], z: g[2], trail: false, hidden: inBody(k, g) }; };
  // f가 at에서 받는 사람 rv(자리 rvAt, 받는 자세 rvPose)에게 t0에 던지기 동작을 시작한다. 공은 동작의 rel(위로 던지기는 55%)에 손에서 나가 받는 글러브에 닿는다.
  // mo: 던지는 동작(track·len·rel·face, 기본은 위로 던지기), done이면 동작은 이미 넣었다(러닝 스로), handAt은 공이 던지는 손으로 옮겨 가는 때,
  // glove는 받는 글러브 자리(마당, 달려오며 받는 투수), arc는 공이 뜨는 높이, after는 공이 닿아도 되는 가장 이른 때(그보다 이르면 늦게 던진다)
  const throwTo = (f, at, rv, rvAt, rvPose, t0, speed, tArrFixed, mo = {}) => {   // tArrFixed: 1루 경주가 정한 닿는 때
    const track = mo.track ?? FTRACK.throw, len = mo.len ?? THROW_LEN, rel = mo.rel ?? THROW_AT, glove = mo.glove ?? fielderSkeleton(rvAt, faceTo(rvAt, at), rvPose).hands.l;
    const gAt = [glove[0], glove[2]], face = mo.face ?? faceTo(at, gAt);
    const t00 = t0;
    if (mo.after != null && tArrFixed == null) {   // 크로 홉까지 넣어 던지는 손 자리를 정하고, 공이 after보다 일찍 닿으면 그만큼 늦게 던진다
      for (let k = 0; k < 2; k++) {
        const hop = !mo.done && !mo.track && mo.hop !== false && freeAt(f) <= t0 - HOP_LEN + 0.02, from = hop ? [at[0] + Math.cos(face) * HOP_D, at[1] + Math.sin(face) * HOP_D] : at;
        const hd = fielderSkeleton(from, face, track(rel)).hands.r, arr = t0 + rel * len + Math.max(0.25, Math.hypot(glove[0] - hd[0], glove[2] - hd[2]) / speed);
        if (arr >= mo.after) break;
        t0 += mo.after - arr;
      }
    }
    const tRel = t0 + rel * len;
    if (!mo.done && !mo.track && mo.hop !== false && freeAt(f) <= t0 - HOP_LEN + 0.02) {   // 서서 던질 때는 크로 홉으로 한 걸음 뛰어 나가며 던진다
      anim(f, t0 - HOP_LEN, at, face, FTRACK.hop, HOP_LEN, { name: 'hop' });
      at = [at[0] + Math.cos(face) * HOP_D, at[1] + Math.sin(face) * HOP_D];
    }
    if (!mo.done) {
      anim(f, t0, at, face, track, len, { name: mo.name ?? 'throw' });
      pose(f, t0 + len, at, face, readyOf(f), { name: 'ready' });
    }
    const hand = fielderSkeleton(at, face, track(rel)).hands.r;
    const d = Math.hypot(glove[0] - hand[0], glove[2] - hand[2]), tArr = tArrFixed ?? tRel + Math.max(0.25, d / speed), h = mo.arc ?? d * 0.04;
    seg(mo.handAt ?? t0, inHand(f), f);
    seg(tRel, (t) => { const u = clamp((t - tRel) / (tArr - tRel), 0, 1); return { x: lerp(hand[0], glove[0], u), y: lerp(hand[1], glove[1], u) + 4 * h * u * (1 - u), z: lerp(hand[2], glove[2], u), trail: false }; });
    seg(tArr, held(rv), rv);
    const look = flatDist(gAt, BASE1) < 3 ? stepToward(BASE1, [0, 0.3], -4) : gAt;   // 1루로 던지면 1루 4m 바깥을 봐서 1루가 화면 끝에 걸리지 않게(간발을 잘 보이게)
    play.focusSegs.push({ t0: tRel, at: () => ({ x: look[0], y: 1.2, z: look[1] }) });
    return { tRel, tArr, face, waited: t0 - t00 };
  };
  // 받는 사람: 마감 전에 그 자리에 가서 던지는 쪽을 보고 서 있다가, 공이 닿기 0.25초 전에 받는 자세(1루는 몸 뻗기)
  const receive = (f, at, from, tArr, recvPose = FPOSE.cover, name = 'cover') => {
    arriveBy(f, at, tArr - 0.3, FPOSE.cover, { faceTo: from, name: 'cover' });
    pose(f, Math.max(freeAt(f), tArr - 0.25), at, faceTo(at, from), recvPose, { name });
  };
  // 공 처리가 끝나면 베이스 둘레의 수비수가 to로 비켜 서서(2.5m 안이면 옆걸음) look 쪽을 본다. 공을 쥐었으면 든 채로(2026-11-03 사용자 '주루 다듬기' 2·3번).
  // 홈 뒤 카메라에서는 홈과 베이스를 잇는 줄 위에 선 사람끼리 겹쳐 보여서, 베이스에 서는 주자의 옆으로 2m쯤 비킨다
  const ballBy = (t) => { let s = null; for (const q of segs) if (q.t0 <= t && (!s || q.t0 >= s.t0)) s = q; return s ? s.by : null; };
  const stepAside = (f, to, t, look) => {
    const t0 = Math.max(freeAt(f), t), v = ballBy(t0) === f ? FPOSE.hold : FPOSE.readyIn, face = faceTo(to, look), from = where(f), d = flatDist(from, to);
    let t1;
    if (d < 2.5) { t1 = t0 + clamp(d / 4, 0.35, 0.6); acts[f.pos].push({ k: 'shuffle', t0, t1, from, to, face, v }); }   // 옆걸음 두세 번(초속 4m쯤)
    else t1 = run(f, to, t0, { face, v });
    pose(f, t1, to, face, v, { name: v === FPOSE.hold ? 'hold' : 'ready' });
  };
  // 공 길 위 자리 to를 향해 달려가 at의 공을 잡는다: 넉넉하면 멈춰 기다렸다 잡고, 빠듯하면 달려가며, 못 닿으면 다이빙. 잡는 자세의 몸 자리를 돌려준다
  const field = (f, ballAt, tCatch, catchPose, o = {}) => {
    const from = where(f), d = flatDist(from, ballAt), [top, tau] = speedOf(f), react = Math.max(freeAt(f), reactOf(f));
    const face = o.face ?? faceTo(ballAt, [0, 0.3]);   // 공이 오는 쪽(홈 쪽)을 본다
    const gl = fielderSkeleton([0, 0], face, catchPose).hands.l, body = [ballAt[0] - gl[0], ballAt[1] - gl[2]];   // 잡는 자세의 글러브가 공 자리에 오게 몸을 세운다
    const mustDive = o.how === 'dive' || o.how === 'forced';   // 1루 경주가 다이빙으로 잰 공은 그림도 다이빙
    if (!mustDive && react + sprintTime(flatDist(from, body), top, tau) + 0.7 <= tCatch) {   // 멈춰서 기다릴 수 있다
      const t1 = run(f, body, react, { look: 'ball' });
      if (t1 < tCatch - 0.4) pose(f, t1, body, face, readyOf(f), { name: 'ready', look: 'ball' });
      pose(f, Math.max(t1, tCatch - 0.22), body, face, catchPose, { name: o.name });
      return { at: body, face, how: 'std' };
    }
    if (!mustDive && react + sprintTime(flatDist(from, body), top, tau) <= tCatch + 0.05) {   // 달려가며 잡는다
      const t1 = run(f, body, Math.max(react, tCatch - sprintTime(flatDist(from, body), top, tau)), { stop: false, look: 'ball' });
      pose(f, Math.min(t1, tCatch - 0.1), body, face, catchPose, { name: o.name });
      return { at: body, face, how: 'run' };
    }
    // 다이빙: 몸을 날리는 때까지 공 쪽으로 달려가 그 자리에서 날아 동작의 55%에 글러브가 공에 닿는다. 몸은 달려온 빠르기로 날아서
    // 공이 멀면 그만큼 길게 난다(k배, 1.75배까지). 그래도 못 닿으면 조금 더 빨리 뛰게 한다(판정이 아웃이라 잡아야 한다)
    const df0 = faceTo(from, ballAt), tLaunch = tCatch - DIVE_HIT * DIVE_LEN, [top0, tau0] = speedOf(f);
    const F = clamp(flatDist(from, ballAt) - sprintDist(tLaunch - react, top0, tau0) - DIVE_GLOVE, 1.3, 3.4), v0 = tLaunch > react ? top0 * (1 - Math.exp(-(tLaunch - react) / tau0)) : 0;
    const track = diveTrack(F, v0), gd = fielderSkeleton([0, 0], df0, track(DIVE_HIT)).hands.l, launch = [ballAt[0] - gd[0], ballAt[1] - gd[2]], dl = flatDist(from, launch);
    if (tLaunch < react + 0.1) {   // 반응할 틈도 없는 공(투수 정면 타구): 몸을 날리지 않고 그 자리에서 공 쪽으로 낮게 글러브를 뻗는다
      const fc = faceTo(ballAt, [0, 0.3]), gs = fielderSkeleton([0, 0], fc, FPOSE.fieldLow).hands.l, body = stepToward([ballAt[0] - gs[0], ballAt[1] - gs[2]], from, 0);
      acts[f.pos].push({ k: 'shuffle', t0: react, t1: Math.max(react + 0.1, tCatch - 0.12), from, to: body, face: fc, v: FPOSE.fieldLow });
      pose(f, Math.max(react + 0.1, tCatch - 0.12), body, fc, FPOSE.fieldLow, { name: 'catchLow' });
      return { at: body, face: fc, how: 'stab', up: tCatch + 0.35 };
    }
    const need = tLaunch - react, G = { ...gaitOf(f) };
    if (sprintTime(dl, G.top, G.tau) > need) G.top = Math.min(G.top * 1.12, dl / Math.max(0.3, need - G.tau) + 0.5);   // 조금 모자라면 살짝 빨리(사람 빠르기 안에서)
    run(f, launch, Math.max(react, tLaunch - sprintTime(dl, G.top, G.tau)), { stop: false, gait: G, look: 'ball', force: true });
    const df = df0;
    anim(f, tLaunch, launch, df, track, DIVE_LEN, { name: 'dive' });
    const lie = stepToward(launch, [launch[0] + Math.cos(df), launch[1] + Math.sin(df)], track.end);
    anim(f, tLaunch + DIVE_LEN + 0.25, lie, df, FTRACK.getUp, GETUP_LEN, { name: 'getUp' });
    return { at: lie, face: df, how: 'dive', up: tLaunch + DIVE_LEN + 0.25 + GETUP_LEN };
  };
  // 다이빙해도 못 잡는 공: 공이 지나가는 자리 0.4m 앞까지 몸을 날린다(안타)
  const diveMiss = (f, ballAt, tPass) => {
    const from = where(f), launch = stepToward(ballAt, from, DIVE_GLOVE + 1.3 + 0.4), tLaunch = tPass - DIVE_HIT * DIVE_LEN, react = Math.max(freeAt(f), reactOf(f));
    if (react + sprintTime(flatDist(from, launch), ...speedOf(f)) > tLaunch) { arriveBy(f, stepToward(ballAt, from, 6), tPass, readyOf(f), { faceTo: ballAt }); return; }   // 거기까지 못 가면 쫓다 선다
    const [top, tau] = speedOf(f), t0 = tLaunch - sprintTime(flatDist(from, launch), top, tau);
    run(f, launch, t0, { stop: false, look: 'ball', force: true });
    const df = faceTo(launch, ballAt), track = diveTrack(1.3, top * (1 - Math.exp(-(tLaunch - t0) / tau)));
    anim(f, tLaunch, launch, df, track, DIVE_LEN, { name: 'dive' });
    anim(f, tLaunch + DIVE_LEN + 0.3, stepToward(launch, ballAt, track.end), df, FTRACK.getUp, GETUP_LEN, { name: 'getUp' });
  };
  // 서서 잡기(1루 경주의 set): 공 길에 먼저 가서 공이 오는 쪽(홈)을 보고 낮게 잡는다. 잡는 자세의 글러브가 공 자리에 오게 선다
  const fieldSet = (f, C, T, target = BASE1) => {
    const c = [C.x, C.z], face = faceTo(c, [0, 0.3]), gl = fielderSkeleton([0, 0], face, FPOSE.fieldLow).hands.l, body = [c[0] - gl[0], c[1] - gl[2]];
    const from = where(f), d = flatDist(from, body), G = gaitOf(f), react = Math.max(freeAt(f), reactOf(f));
    const arrive = react + (d < 2.5 ? Math.max(0.3, 1.15 * sprintTime(d, G.top, G.tau)) : runTrack({ gait: G, route: [from, body], total: d, until: Infinity, delay: 0, brake: FIELD_BRAKE }).T.at(-1));
    if (arrive > T - 0.15) return fieldMoving(f, C, T, 'plant', target, 0, false);   // 멈춰 서기에는 늦다: 달려가며 잡고 디뎌 멈춘다
    const t1 = run(f, body, react, { look: 'ball' });
    if (t1 < T - 0.45) pose(f, t1, body, face, readyOf(f), { name: 'ready', look: 'ball' });
    pose(f, Math.min(Math.max(t1, T - 0.3), T - 0.2), body, face, FPOSE.fieldLow, { name: 'catchLow' });
    return { at: body, face };
  };
  // 달려가며 잡기(1루 경주의 run·plant): 잡는 때에 공 옆을 지나도록 달려와 pickTrack 동작으로 잇는다. 공은 달려온 쪽으로 볼 때
  // 글러브(앞 0.9m·왼쪽 0.25m), 백핸드(앞 0.85m·오른쪽 0.3m), 맨손(앞 0.88m·오른쪽 0.2m) 자리에 온다. target: 던질 쪽
  const fieldMoving = (f, C, T, kind, target, ex, bare) => {
    const from = where(f), c = [C.x, C.z], react = Math.max(freeAt(f), reactOf(f));
    const u = flatDist(from, c) > 0.5 ? unitTo(from, c) : unitTo(c, [0, 0.3]), uL = [-u[1], u[0]], rc = kind === 'plant' ? [-0.3, 0.85] : bare ? [-0.2, 0.88] : [0.25, 0.9];
    const B = [c[0] - u[0] * rc[1] - uL[0] * rc[0], c[1] - u[1] * rc[1] - uL[1] * rc[0]], d = flatDist(from, B), G = { ...gaitOf(f) };
    if (sprintTime(d, G.top, G.tau) > T - react) G.top = Math.min(G.top * 1.12, d / Math.max(0.2, T - react - G.tau) + 0.3);   // 글러브 자리만큼 모자라면 조금 빨리
    const start = Math.max(react, T - sprintTime(d, G.top, G.tau)), v = G.top * (1 - Math.exp(-(T - start) / G.tau)), face = faceTo(B, target);
    const bd = Math.hypot(B[0], B[1]) || 1, out = (u[0] * B[0] + u[1] * B[1]) / bd, room = out > 0.2 ? (fenceDist(Math.atan2(B[0], B[1]) / DEG) - 1.5 - bd) / out : Infinity;   // 담장 쪽으로 가면 담장 1.5m 앞까지만 미끄러진다
    run(f, B, start, { stop: false, gait: G, look: 'ball', force: true });
    const pk = pickTrack(kind, B, face, u, v, C, ex, bare, room);
    anim(f, T - PICK_LEAD, B, face, pk.track, pk.len, { name: kind === 'plant' ? 'backhand' : 'runThrow', endAt: pk.endAt });
    return { at: B, face, pk };
  };
  // 뜬공·직선타 잡기: 넉넉하면 떨어지는 자리에 먼저 가서 기다렸다 잡고, 빠듯하면 달려가며 글러브를 뻗어 잡고 몇 걸음 더 가서 서고,
  // 달려서 안 닿는 공(그린 거리로도 다이빙해야 닿는 공, carryOf)만 몸을 날려 잡는다
  const catchAir = (f, q, tc, catchPose) => {
    const from = where(f), at = [q.x, q.z], [top, tau] = speedOf(f), react = Math.max(freeAt(f), reactOf(f)), face = faceTo(at, [0, 0.3]);
    const gl = fielderSkeleton([0, 0], face, catchPose).hands.l, body = [at[0] - gl[0], at[1] - gl[2]];
    if (flatDist(from, body) < 1.2 && react + sprintTime(flatDist(from, body), top, tau) <= tc) {   // 거의 제자리: 한 걸음 옮겨 잡는다(정면 직선타)
      run(f, body, react, { look: 'ball' });
      pose(f, Math.max(react + 0.1, tc - 0.22), body, face, catchPose, { name: 'catchHigh' });
      return { at: body, face, how: 'std', free: tc + 0.35 };
    }
    if (react + sprintTime(flatDist(from, body), top, tau) + 0.45 <= tc) {   // 먼저 가서 기다린다
      const t1 = run(f, body, react, { look: 'ball' });
      if (t1 < tc - 0.45) pose(f, t1, body, face, readyOf(f), { name: 'ready', look: 'ball' });
      pose(f, Math.min(Math.max(t1, tc - 0.3), tc - 0.22), body, face, catchPose, { name: 'catchHigh' });
      return { at: body, face, how: 'std', free: tc + 0.35 };
    }
    const hi = q.y > 1.6, rf = hi ? 0.3 : 0.55, rl = hi ? 0.2 : 0.3;   // 머리 위 공은 몸 바로 앞, 가슴 높이 공은 팔을 뻗은 자리(airReach)
    const u = unitTo(from, at), uL = [-u[1], u[0]], B = [at[0] - u[0] * rf - uL[0] * rl, at[1] - u[1] * rf - uL[1] * rl], d = flatDist(from, B), G = gaitOf(f);
    if (react + sprintTime(d, G.top, G.tau) <= tc + 0.03) {   // 달려가며 잡는다: 잡는 때에 공 밑을 지나며 글러브를 뻗고, 빠르기만큼 몇 걸음 더 가서 선다
      const v = G.top * (1 - Math.exp(-(tc - react) / G.tau)), more = clamp(0.55 * v, 1, 4), end = [B[0] + u[0] * more, B[1] + u[1] * more], route = [from, B, end];
      const track = runTrack({ gait: G, route, total: d + more, until: Infinity, delay: 0, brake: FIELD_BRAKE });
      const iB = Math.max(0, track.S.findIndex((x) => x >= d)), t0 = Math.max(react, tc - track.T[iB]), t1 = t0 + track.T[track.T.length - 1];
      acts[f.pos].push({ k: 'move', t0, t1, from, to: end, route, track, gait: G, look: 'ball', reach: { t: tc, p: [q.x, q.y, q.z] } });
      moves.push({ f, from, to: end, t0, t1 });
      return { at: end, face: faceTo(end, [0, 0.3]), how: 'run', free: t1 };
    }
    return field(f, at, tc, catchPose, { name: 'catchHigh', face, how: 'dive' });
  };
  // 굴러가는 안타 공 줍기: 달려 나와 공 앞에서 서서 막고(다이빙 없이), 공을 챙겨 크로 홉으로 던진다. roll은 공 자리 함수(t → {x, y, z})
  const pickUp = (f, ballAt, t) => {
    const got = fieldSet(f, ballAt(t), t, BASE2), at = got.pk ? got.pk.endAt : got.at, ready = Math.max(freeAt(f), t + 0.12);
    pose(f, ready, at, faceTo(at, BASE2), FPOSE.gather, { name: 'gather' });
    return { ...got, at, throwAt: Math.max(t + 0.6, ready + HOP_LEN + 0.1) };   // 던지기 시작(크로 홉 뒤)
  };
  // 안타 공을 주운 뒤 2루로 보낸다. 2루타는 주자가 2루를 밟고 0.45초 넘게 지나서 공이 2루에 닿게 한다(2026-11-02 유저 제보 '주자가 아직 2루에
  // 안 왔는데 공이 2루에 먼저 왔는데 2루타'. 전에는 주우면 바로 2루로 던져서 2루타의 72%에서 공이 먼저였다). 2루에서 40m 넘게 떨어져 주우면
  // 공 쪽 키스톤이 중계 자리(2루에서 공 쪽으로 거리의 0.45배, 18~35m)에서 받아 돌아 던지고, 일찍 받으면 주자를 보며 공을 들고 있다가 던진다.
  // 단타는 주자가 1루를 돌아 서므로 그대로 던진다
  // 3루타는 같은 방법으로 3루로 보낸다(3루수가 받고, 공 쪽 키스톤이 중계)
  const toBag = (picker, got, base, recv, bagAt, tRun) => {
    const speed = isOutfielder(picker) ? THROW_OUT : THROW_IN * 0.6, after = tRun == null ? null : tRun + 0.45;   // 공은 주자가 베이스를 밟고 0.45초 뒤부터 닿는다
    const relayMan = picker !== near2 && picker !== recv && flatDist(got.at, base) > 40 ? near2 : null;
    let th;
    if (relayMan) {
      const R = stepToward(base, got.at, clamp(0.45 * flatDist(got.at, base), 18, 35)), th1 = throwTo(picker, got.at, relayMan, R, FPOSE.cover, got.throwAt, speed);
      receive(relayMan, R, got.at, th1.tArr);
      pose(relayMan, th1.tArr + 0.2, R, faceTo(R, base), FPOSE.hold, { name: 'hold' });   // 받아서 베이스 쪽으로 돈다(주자가 아직이면 들고 기다린다)
      th = throwTo(relayMan, R, recv, bagAt(R), FPOSE.cover, th1.tArr + 0.45, THROW_IN * 0.7, undefined, { after });
      receive(recv, bagAt(R), R, th.tArr);
      Object.assign(play.ev, { relay: relayMan.pos, relayAt: th1.tArr });
      th = { ...th, tRel: th1.tRel };
    } else {
      th = throwTo(picker, got.at, recv, bagAt(got.at), FPOSE.cover, got.throwAt, speed, undefined, { after });
      receive(recv, bagAt(got.at), got.at, th.tArr);
    }
    // 2루타·3루타: 받자마자(0.15초 뒤) 공을 든 채 주자 반대쪽 옆으로 1.8m 비켜 서서, 미끄러졌다 일어서는 주자와 몸이 겹치지 않게 한다.
    // 자기 자리 쪽으로 비키면 주자 몸을 가로질러 지나갈 때가 있었다(주자가 서는 자리는 runnerAt과 같다)
    if (tRun != null) {
      const at = where(recv), bagRun = runPlan(r).slideBag ?? stepToward(BASE2, BASE1, 0.3), sgn = Math.sign(at[0] - bagRun[0]) || (base === BASE3 ? 1 : -1);
      stepAside(recv, [at[0] + sgn * 1.8, at[1]], th.tArr + 0.15, base);
    }
    Object.assign(play.ev, { release: th.tRel, arrive: th.tArr, receiver: recv.pos, runner2: tRun, wait: th.waited });
    return { ...th, end: Math.max(th.tArr, tRun ?? 0) };
  };
  const toSecond = (picker, got) => toBag(picker, got, BASE2, picker === cover2 ? near2 : cover2, bag2, r.kind === 'double' ? runnerReach(r, BASE2) : null);
  // 끝내기 단타 홈 승부: 주운 외야수가 홈으로 던지고(판정이 정한 때에 닿는다) 포수가 받아 3루 쪽에서 미끄러져 오는 주자를 태그한다
  const toHome = (picker, got, hp) => {
    const th = throwTo(picker, got.at, C, CATCH_SPOT, FPOSE.catchChest, got.throwAt, HOME_THROW, hp.arrive);
    arriveBy(C, CATCH_SPOT, hp.arrive - 0.6, FPOSE.squat, { faceTo: got.at });   // 홈 앞 3루 쪽에 쪼그려 앉아 기다리다 받는다(서 있으면 화면 가운데를 가렸다)
    pose(C, hp.arrive - 0.25, CATCH_SPOT, faceTo(CATCH_SPOT, got.at), FPOSE.catchChest, { name: 'catch' });
    pose(C, hp.arrive + 0.05, CATCH_SPOT, faceTo(CATCH_SPOT, BASE3), FPOSE.fieldLow, { name: 'tag' });
    pose(C, Math.max(hp.arrive + TAG_TIME, hp.runner) + 0.45, CATCH_SPOT, faceTo(CATCH_SPOT, BASE3), FPOSE.hold, { name: 'hold' });
    Object.assign(play.ev, { release: th.tRel, arrive: th.tArr, receiver: C.pos });
    return { ...th, end: Math.max(hp.arrive + TAG_TIME, hp.runner) + 0.3 };
  };
  // 주루 판정이 간발이면 정해지는 때 앞뒤를 0.4배로 느리게 하고 베이스 위에 세이프/아웃을 띄운다(1루 간발과 같다)
  const closeCall = (d, at, safe, width = 0.2) => { play.slow = [{ t0: d - 0.35, t1: d + 0.15, rate: 0.4 }]; play.calls = [{ t: d, at, text: safe ? '세이프' : '아웃' }]; };
  const toThird = (picker, got) => toBag(picker, got, BASE3, B3, (from) => stepToward(BASE3, from, 0.4), runnerReach(r, BASE3));
  // 투수가 1루 커버 길(PCOVER)을 뛰어 tBag에 베이스를 밟고 3m쯤 지나쳐 선다. tCatch에 글러브를 뻗어 토스를 받는 자리(마당)를 돌려준다
  const coverRun = (tBag, tCatch) => {
    const P = PITCHER_F, n = PCOVER.length, bag = PCOVER[n - 1], past = [bag[0] + 1.41, bag[1] + 2.83], route = [...PCOVER, past], G = gaitOf(P);
    const track = runTrack({ gait: G, route, total: PCOVER_LEN + flatDist(bag, past), until: Infinity, delay: 0, brake: FIELD_BRAKE });
    const iB = track.S.findIndex((q) => q >= PCOVER_LEN - 1e-6), t0 = Math.max(FIELD_REACT.p, tBag - track.T[iB]), tEnd = t0 + track.T[track.T.length - 1];
    const sc = trackAt(track, tCatch - t0).s, pc = alongRoute(route, sc), dir = unitTo(pc, alongRoute(route, sc + 0.6)), lft = [-dir[1], dir[0]];
    const Q = [pc[0] + dir[0] * 0.42 + lft[0] * 0.18, 1.15, pc[1] + dir[1] * 0.42 + lft[1] * 0.18];
    acts[P.pos].push({ k: 'move', t0, t1: tEnd, from: route[0], to: past, route, track, gait: G, look: 'ball', reach: { t: tCatch, p: Q } });
    moves.push({ f: P, from: route[0], to: past, t0, t1: tEnd });
    return Q;
  };
  const watchAll = (t0, except = []) => { for (const f of DEFENSE) if (!except.includes(f) && !acts[f.pos].length && f !== PITCHER_F) pose(f, t0 + reactOf(f), homeOf(f), faceTo(homeOf(f), [0, 0.3]), FPOSE.stand, { name: 'watch', look: 'ball' }); };

  const side = clamp(r.spray, -FAIR_SPRAY, FAIR_SPRAY), leftSide = side < 0;
  const SS = byPos('유격수'), B2 = byPos('2루수'), B3 = byPos('3루수'), B1 = byPos('1루수'), LF = byPos('좌익수'), CF = byPos('중견수'), RF = byPos('우익수'), P = PITCHER_F;
  const cover2 = side < 0 ? B2 : SS, near2 = side < 0 ? SS : B2;   // 공 반대쪽 키스톤이 2루에 들어가고, 공 쪽 키스톤은 공 쪽으로
  const bag1 = (from) => stepToward(BASE1, from, 0.25), bag2 = (from) => stepToward(BASE2, from, 0.4), bag3 = stepToward(BASE3, [0, 0.3], 1.2);
  // 단타·내야 안타 뒤 1루수가 서는 자리: 1루 안쪽(투수 쪽) 2.2m. 1루 앞(홈 쪽)에 서면 돌아온 주자가 그 뒤에 겹쳐 가려졌고,
  // 2루 쪽 선 위는 주자가 1루를 돌아 나가는 길이다
  const aside1 = stepToward(BASE1, [0, MOUND], 2.2);
  const backOf = (at, k, ref = [0, 0.3]) => stepToward(at, ref, -k);   // 홈에서 볼 때 at의 k m 뒤
  const backupSpot = (f, at, k) => { const p = inPark(backOf(at, k), 2.5); return flatDist(p, at) < k * 0.6 ? stepToward(at, homeOf(f), k * 0.8) : p; };   // 뒤를 받친다. 담장 앞이면 자기 쪽 옆으로
  const otherOF = (o) => OUTFIELDERS.filter((x) => x !== o).reduce((b, x) => (Math.abs(x.a - side) < Math.abs(b.a - side) ? x : b));
  // 땅볼이 투수 옆(FLINCH_NEAR m 안)을 빠르게 지나가면 투수가 움찔한다(force면 거리와 상관없이). 움찔이 끝나는 때·비켜 선 자리·공이 지난 쪽을 돌려준다
  const flinch = (path, force = false) => {
    const p0 = homeOf(P), far = Math.hypot(p0[0], p0[1]) + 3;
    let best = null;
    for (let i = 1; i < 360; i++) {
      const t = i / 120, q = path.pos(t), d = flatDist(q, p0);
      if (!best || d < best.d) best = { d, t, x: q[0] - p0[0], v: path.speed(t) };
      if (Math.hypot(q[0], q[1]) > far) break;
    }
    if (!force && (best.d > FLINCH_NEAR || best.v < 8)) return null;
    const s = Math.abs(best.x) < 0.15 ? 0 : Math.sign(best.x), g = port.lefty() ? -1 : 1, t0 = Math.max(0.12, best.t - FLINCH_LEAD), at = [p0[0] - s * FLINCH_STEP, p0[1]];
    anim(P, t0, p0, faceTo(p0, [0, 0.3]), flinchTrack(s, g), FLINCH_LEN, { name: 'flinch', look: 'ball', endAt: at });
    return { t1: t0 + FLINCH_LEN, at, s };
  };
  let reveal = 0, end = 0;

  if (r.type === 'ground' && (r.kind === 'out' || r.kind === 'single' || r.kind === 'double')) {
    const path = (r.gpath ??= groundPath(r));
    seg(0, (t) => ({ ...flightPos(r, t), trail: true }));
    if (r.kind === 'out' || r.infield) {   // 1루 경주(r.race)대로: 잡는 때·공을 빼 던지는 때·송구가 1루에 닿는 때가 판정과 같다
      const race = r.race ?? computeRace(r, r.bats ?? 'R'), safe = !!r.infield, dp = r.scnPlay?.dp;   // 판정 없이 만든 시험용 결과는 그 자리에서 잰다. dp: 끝내기 병살 상황
      const X = byPos(race.pos), to = race.arrive?.to, T = race.field.t, C = flightPos(r, T);
      let touch = race.arrive?.t;   // 아웃이 되는 때(송구가 1루에 닿거나 1루수가 베이스를 밟는 때)
      const bare = race.how === 'run' && race.charge && path.speed(T) < 2.5;   // 거의 멈춘 공은 달려 나와 맨손으로 줍는다
      // 잡기: 서서(set), 달려가며(run·plant, 1루수는 잡고 멈춘다), 몸을 날려(dive)
      const got = race.how === 'set' ? fieldSet(X, C, T, dp?.out2 ? BASE2 : BASE1)
        : race.how === 'dive' ? field(X, race.field.at, T, FPOSE.fieldLow, { name: 'catchLow', how: 'dive' })
        : fieldMoving(X, C, T, X === B1 || !race.arrive || dp?.out2 ? 'plant' : race.how, dp?.out2 ? BASE2 : BASE1, PLAY_EX.run, bare);
      const at = got.pk ? got.pk.endAt : got.at, ready = got.pk ? T - PICK_LEAD + got.pk.len : got.up ?? T + 0.12;   // 잡는 동작이 끝난 자리와 때
      const atTime = (t) => (got.pk && t < ready ? got.pk.posAt(t - T) : at);   // t초에 몸이 있는 자리(잡는 동작 중이면 그 자리)
      seg(T, bare ? inHand(X) : held(X), X);
      Object.assign(play.ev, { field: T, fielder: X.pos, how: race.how, release: race.release.t, arrive: race.arrive?.t ?? null, runner: race.runner, margin: race.margin });
      if (dp?.out2) {   // 끝내기 병살 상황: 2루로 던져(베이스 가까이서 잡은 키스톤은 직접 밟는다) 1루 주자를 잡고, 2루에 들어간 사람이 1루로 던진다(판정이 정한 때)
        const cv = byPos(dp.cover), cvAt = bag2(at), rv1 = X === B1 ? P : B1, rvAt1 = bag1(BASE2);
        if (dp.self) arriveBy(X, cvAt, dp.atSecond, FPOSE.cover, { faceTo: BASE1, name: 'cover' });
        else {
          const face = faceTo(at, BASE2), t0 = Math.max(freeAt(X), ready, dp.atSecond - 0.25 - THROW_AT * THROW_LEN);
          if (Math.max(freeAt(X), ready) < t0 - 0.05) pose(X, Math.max(freeAt(X), ready), at, face, FPOSE.gather, { name: 'gather' });
          throwTo(X, at, cv, cvAt, FPOSE.cover, t0, 0, dp.atSecond, { hop: false });
          receive(cv, cvAt, at, dp.atSecond, FPOSE.cover, 'cover');
        }
        const pv = dp.self ? X : cv;
        throwTo(pv, cvAt, rv1, rvAt1, FPOSE.stretch, dp.atSecond + 0.1, 0, dp.atFirst, { hop: false });
        receive(rv1, rvAt1, cvAt, dp.atFirst, FPOSE.stretch, 'stretch');
        touch = dp.atFirst;
        Object.assign(play.ev, { release: null, arrive: dp.atFirst, second: dp.atSecond, cover: dp.cover, decide: Math.max(dp.atFirst, dp.runner1) });
      } else if (!race.arrive) {   // 던질 틈이 없다: 공을 쥐고 1루 쪽을 본다
        pose(X, Math.max(freeAt(X), ready), at, faceTo(at, BASE1), FPOSE.hold, { name: 'hold' });
        if (X !== B1) arriveBy(B1, bag1(at), race.runner, FPOSE.cover, { faceTo: at, name: 'cover' });
      } else if (to === 'self') {   // 1루수가 잡아 직접 베이스를 밟는다
        // 주자보다 0.9초 넘게 먼저면 천천히 뛰어 가서 주자보다 0.6초쯤 먼저 밟고 선다(2026-11-02 사용자 '1루수 땅볼이 뚝딱거린다, 갑자기 막 달린다'.
        // 전에는 늘 전력으로 출발해 주자보다 1초 넘게 먼저 닿는 공도 몸을 숙이고 내달렸다). 빠듯하면 전력으로 밟고 2.5m 지나간다
        const from = where(X), bag = stepToward(BASE1, from, 0.3), d = flatDist(from, bag), t0 = Math.max(freeAt(X) - 0.15, race.release.t), easy = !safe && race.runner - race.arrive.t > 0.9;
        // 걸음새는 필요한 빠르기에 맞춰 조깅과 전력 사이로 섞고, 빠르기는 천천히(시간 상수 0.7초) 올린다
        const need = clamp(d / Math.max(0.3, race.runner - 0.6 - t0 - 0.7), FIELD_JOG.top, FIELD_RUN_IN.top), k = (need - FIELD_JOG.top) / (FIELD_RUN_IN.top - FIELD_JOG.top);
        const G = easy ? { ...Object.fromEntries(Object.keys(FIELD_JOG).map((key) => [key, Array.isArray(FIELD_JOG[key]) ? FIELD_JOG[key].map((v, i) => lerp(v, FIELD_RUN_IN[key][i], k)) : lerp(FIELD_JOG[key], FIELD_RUN_IN[key], k)])), top: need, tau: 0.7, start: FIELD_JOG.start, drive: FIELD_JOG.drive } : gaitOf(X);
        const over = easy ? 0.6 : 2.5, past = stepToward(bag, from, -over), route = [from, bag, past];
        const track = runTrack({ gait: G, route, total: d + over, until: Infinity, delay: 0, brake: FIELD_BRAKE });
        acts[X.pos].push({ k: 'move', t0, t1: t0 + track.T[track.T.length - 1], from, to: past, route, track, gait: G });
        pose(X, t0 + track.T[track.T.length - 1], past, faceTo(past, [0, 0.3]), FPOSE.hold, { name: 'hold' });
        if (easy) touch = t0 + track.T[Math.max(0, track.S.findIndex((x) => x >= d))];   // 베이스를 밟는 때(아웃이 되는 때)
      } else if (to === 'tag') {   // 주자 길목에서 잡아 오는 주자를 태그한다
        const tagAt = atTime(race.arrive.t - 0.15);
        pose(X, race.arrive.t - 0.15, tagAt, faceTo(tagAt, [0, 0.3]), FPOSE.fieldLow, { name: 'tag' });
      } else if (to === 'P') {   // 멀리 잡은 1루수가 1루로 뛰어 오는 투수에게 아래로 던져 준다(토스). 투수는 달리며 베이스 1m 앞에서 받아 밟고 지나간다
        const tCatch = race.arrive.t - TOSS_STEP, waits = race.arrive.t - (FIELD_REACT.p + sprintTime(PCOVER_LEN, ...FIELD_SPEED.p)) > 0.25;
        let Q;
        if (waits) { const pAt = bag1(at); receive(P, pAt, at, tCatch, FPOSE.cover, 'cover'); Q = fielderSkeleton(pAt, faceTo(pAt, at), FPOSE.cover).hands.l; }   // 투수가 먼저 와서 베이스에서 기다린다
        else Q = coverRun(race.arrive.t, tCatch);
        const t0 = race.release.t - TOSS_AT * TOSS_LEN, tossAt = atTime(t0), face = faceTo(tossAt, [Q[0], Q[2]]);
        if (Math.max(freeAt(X), ready) < t0 - 0.05) pose(X, Math.max(freeAt(X), ready), tossAt, face, FPOSE.hold, { name: 'hold' });   // 공을 챙겨 투수에게 보여 준다
        throwTo(X, tossAt, P, null, null, t0, 0, tCatch, { track: FTRACK.toss, len: TOSS_LEN, rel: TOSS_AT, glove: Q, arc: 0.35 + 0.03 * flatDist(tossAt, [Q[0], Q[2]]), face, name: 'toss' });
      } else if (race.how === 'run') {   // 러닝 스로: 잡는 동작(pickTrack)에 던지기까지 들어 있다
        const rvAt = bag1(got.at);
        throwTo(X, got.at, B1, rvAt, FPOSE.stretch, T - PICK_LEAD, 0, race.arrive.t, { track: got.pk.track, len: got.pk.len, rel: got.pk.rel, face: got.face, done: true, handAt: T + 0.25 });
        pose(X, ready, at, got.face, readyOf(X), { name: 'ready' });
        receive(B1, rvAt, got.at, race.arrive.t, FPOSE.stretch, 'stretch');
      } else {   // 서서 잡기·백핸드·다이빙: 몸을 1루 쪽으로 닫았다가 위로 던진다
        const rvAt = bag1(at), face = faceTo(at, BASE1), t0 = race.release.t - THROW_AT * THROW_LEN;
        if (Math.max(freeAt(X), ready) < t0 - 0.05) pose(X, Math.max(freeAt(X), ready), at, face, FPOSE.gather, { name: 'gather' });
        throwTo(X, at, B1, rvAt, FPOSE.stretch, t0, 0, race.arrive.t);
        receive(B1, rvAt, at, race.arrive.t, FPOSE.stretch, 'stretch');
      }
      if (touch !== race.arrive?.t) play.ev.arrive = touch;
      const decide = dp?.out2 ? Math.max(dp.atFirst, dp.runner1) : race.arrive ? Math.max(touch, safe ? race.runner : 0) : race.runner;
      reveal = dp?.out2 ? (dp.out1 ? dp.atFirst : decide + 0.05) : safe ? Math.max(race.runner, race.arrive?.t ?? race.runner) + (race.arrive ? 0.05 : 0.1) : touch;
      end = Math.max(decide, reveal);
      if (dp?.out2) { if (Math.abs(dp.margin) < 0.15) closeCall(decide, BASE1, !dp.out1); }
      else if (race.arrive && Math.abs(race.margin) < 0.15) {   // 간발: 판정 앞뒤를 0.4배로 느리게, 1루 위에 세이프/아웃
        const d = Math.max(race.runner, race.arrive.t);
        play.slow = [{ t0: d - 0.35, t1: d + 0.15, rate: 0.4 }];
        play.calls = [{ t: d, at: BASE1, text: safe ? '세이프' : '아웃' }];
        // 폰은 시야가 좁아 공을 던질 때 1루로 돌기 시작하면 머리부터 슬라이딩과 세이프·아웃에 늦어서, 공을 잡는 순간부터 1루 4m 바깥(송구 때와 같은 곳)을 본다
        const look = stepToward(BASE1, [0, 0.3], -4);
        play.focusSegs.push({ t0: T, at: () => ({ x: look[0], y: 1.2, z: look[1] }) });
      }
      // 커버·백업: 공을 안 잡은 키스톤이 2루, 3루수는 3루(3루수가 잡았으면 유격수가 3루 쪽), 투수는 1·2루 쪽 공이면 1루로, 우익수는 1루 송구 뒤, 중견수·좌익수는 몇 걸음
      const cv2 = X === B2 ? SS : X === SS ? B2 : cover2;
      if (!dp?.out2) arriveBy(cv2, bag2(at), end, FPOSE.cover, { faceTo: at, name: 'cover' });
      if (X !== B3) arriveBy(B3, bag3, end, FPOSE.readyIn, { faceTo: at });
      else if (cv2 !== SS) arriveBy(SS, stepToward(bag3, BASE2, 4), end, FPOSE.readyIn, { faceTo: at });
      if (X !== P && to !== 'P' && !(dp?.out2 && X === B1)) {
        const fl = flinch(path);   // 투수 옆을 지나간 공이면 움찔한 뒤에
        if (X === B2 || X === B1) arriveBy(P, stepToward(BASE1, [0, MOUND], 4), end, FPOSE.cover, { faceTo: at, name: 'cover' });   // 1루 커버를 가다 멈춘다
        else pose(P, fl ? fl.t1 : FIELD_REACT.p, fl ? fl.at : homeOf(P), faceTo(fl ? fl.at : homeOf(P), at), FPOSE.stand, { name: 'watch', look: 'ball' });
      }
      arriveBy(RF, stepToward(BASE1, at, -11), end + 0.2, FPOSE.backup, { faceTo: BASE1, name: 'backup' });
      arriveBy(CF, stepToward(homeOf(CF), BASE2, 9), end, FPOSE.backup, { faceTo: at, name: 'backup' });
      arriveBy(LF, stepToward(homeOf(LF), at, X === B3 || X === SS ? 14 : 6), end, FPOSE.backup, { faceTo: at, name: 'backup' });
      // 내야 안타: 판정 0.6초 뒤 1루 둘레(3m 안)의 수비수가 1루 안쪽으로 비켜 서서, 지나쳤다 돌아오는 주자와 겹치지 않게 한다
      if (safe) for (const f of new Set([B1, P, X])) if (flatDist(where(f), BASE1) < 3) stepAside(f, aside1, end + 0.6, BASE1);
    } else {   // 땅볼 안타: 빈틈 쪽 내야수가 쫓아가고, 거의 닿을 만한 공이면 가까운 한 명만 몸을 날려도 못 잡는다. 외야로 굴러간 공은 외야수가 달려 나와 막아 2루로 던진다
      const pair = r.gap === '3유간' ? [B3, SS] : r.gap === '1·2루간' ? [B2, B1] : [SS, B2];
      const closest = (f) => {   // 공 길에 가장 가까이 가는 때·자리와 달려서 못 미치는 거리
        const h = homeOf(f), [top, tau] = speedOf(f), hd = Math.hypot(h[0], h[1]);
        let best = { short: Infinity, t: 0, at: h };
        for (let i = 1; i < 480; i++) { const t = i / 120, q = path.pos(t); if (Math.hypot(q[0], q[1]) > hd + 4) break; const sh = flatDist(h, q) - RUN_REACH - sprintDist(t - reactOf(f), top, tau); if (sh < best.short) best = { short: sh, t, at: q }; }
        return { f, ...best };
      };
      pair.map(closest).sort((x, y) => x.short - y.short).forEach((c, i) => {
        if (i === 0 && diveShort(c.at, homeOf(c.f), c.t, reactOf(c.f), ...speedOf(c.f)) < 1.2) diveMiss(c.f, c.at, c.t);   // 거의 닿는 공: 몸을 날려도 글러브 끝을 지나간다
        else arriveBy(c.f, stepToward(homeOf(c.f), c.at, clamp(flatDist(homeOf(c.f), c.at) - 2, 0, 5)), c.t + 0.3, readyOf(c.f), { faceTo: c.at, look: 'ball' });   // 몇 걸음 쫓다 선다
      });
      const fl = flinch(path, r.gap === '투수 옆');   // 투수 옆으로 빠지는 공은 늘 움찔하고, 옆으로 돌아서서 빠져나간 공을 본다(전에는 한 번에 숙인 자세로 굳었다)
      if (r.gap === '투수 옆') pose(P, fl.t1, fl.at, faceTo(fl.at, [fl.at[0] + (fl.s || 1), fl.at[1]]), FPOSE.stand, { name: 'watch', look: 'ball' });
      const O = nearestOutfielder(side), [top, tau] = speedOf(O);
      const ic = reachGround(path, homeOf(O), reactOf(O), top, tau, SET_REACH, 0.35, Infinity, path.tStop + 4) ?? { ...interceptGround(path, homeOf(O), reactOf(O), top, tau, path.tStop + 4) };
      const hp = r.scnPlay?.home, goHome = !!hp && !hp.hold;
      if (goHome) Object.assign(ic, { t: hp.pickup.t, at: hp.pickup.at });   // 판정(core hitPickup)과 같은 때
      const got = pickUp(O, (t) => flightPos(r, t), ic.t);
      seg(ic.t, held(O), O);
      Object.assign(play.ev, { pickup: ic.t, fielder: O.pos });
      const th = goHome ? toHome(O, got, hp) : toSecond(O, got);
      if (goHome) { const d = Math.max(hp.arrive + TAG_TIME, hp.runner); play.ev.decide = d; if (Math.abs(hp.margin) < 0.2) closeCall(d, HOME_PLATE, hp.safe); }
      const ob = otherOF(O); arriveBy(ob, backOf(got.at, 10), ic.t, FPOSE.backup, { faceTo: got.at, name: 'backup' });
      if (!pair.includes(B1)) arriveBy(B1, r.kind === 'single' ? aside1 : stepToward(BASE1, [0, 0], 1.5), th.tArr, FPOSE.readyIn, { faceTo: got.at });   // 단타는 1루 안쪽(주자가 돌아온다)
      if (!pair.includes(B3)) arriveBy(B3, bag3, th.tArr, FPOSE.readyIn, { faceTo: got.at });
      if (r.gap !== '투수 옆') arriveBy(P, stepToward(BASE2, got.at, -8), th.tArr, FPOSE.backup, { faceTo: BASE2, name: 'backup' });
      reveal = Math.min(ic.t, REVEAL_MAX); end = th.end;
    }
  } else if (r.kind === 'out') {   // 뜬공·직선타·내야 뜬공: 떨어지는 자리로 가서 잡는다(멀면 다이빙)
    const X = r.fielder ? byPos(r.fielder.pos) : CF, tc = catchTime(r), q = flightPos(r, tc), at = [q.x, q.z];
    seg(0, (t) => ({ ...flightPos(r, t), trail: true }));
    const got = catchAir(X, q, tc, r.type === 'line' && q.y < 1.5 ? FPOSE.catchChest : FPOSE.catchHigh);
    Object.assign(play.ev, { catch: tc, fielder: X.pos, how: got.how });
    seg(tc, held(X), X);
    pose(X, Math.max(tc + 0.35, got.free ?? 0, got.up ?? 0), got.at, got.face, FPOSE.hold, { name: 'hold' });
    reveal = end = tc;
    const tg = r.scnPlay?.tag;
    if (tg?.go) {   // 끝내기 2루 주자 태그업: 잡고 3루로 던지고(판정이 정한 때에 닿는다) 3루수가 받아 태그한다. 주자가 먼저 미끄러져 닿는다
      const t0 = Math.max(freeAt(X), tg.release - THROW_AT * THROW_LEN), from = where(X);
      throwTo(X, from, B3, bag3, FPOSE.cover, t0, HOME_THROW, tg.arrive);
      receive(B3, bag3, from, tg.arrive, FPOSE.cover, 'cover');
      pose(B3, tg.arrive + 0.05, bag3, faceTo(bag3, BASE2), FPOSE.fieldLow, { name: 'tag' });
      const d = Math.max(tg.arrive + TAG_TIME, tg.runner);
      play.ev.decide = d; end = d + 0.3;
      if (tg.margin > -0.4) closeCall(d, BASE3, true);
    }
    if (isOutfielder(X)) {
      const ob = otherOF(X); arriveBy(ob, backupSpot(ob, got.at, 8), tc, FPOSE.backup, { faceTo: got.at, name: 'backup' });
      for (const f of [SS, B2]) arriveBy(f, stepToward(homeOf(f), got.at, 6), tc, FPOSE.readyIn, { faceTo: got.at });
      arriveBy(B1, stepToward(BASE1, [0, 0], 1.2), tc, FPOSE.readyIn, { faceTo: got.at });
      arriveBy(B3, bag3, tc, FPOSE.readyIn, { faceTo: got.at });
      arriveBy(P, stepToward([0, MOUND], BASE2, 4), tc, FPOSE.stand, { faceTo: got.at, name: 'watch' });
      if (!tg?.go) {   // 잡은 공은 공 쪽 키스톤(중계하러 나온 유격수·2루수)에게 가볍게 던져 준다. 전에는 잡은 채 서 있었다
        const rv = got.at[0] < 0 ? SS : B2, rvAt = stepToward(homeOf(rv), got.at, 6), from = where(X), face = faceTo(rvAt, from);
        const th = throwTo(X, from, rv, rvAt, FPOSE.catchChest, Math.max(freeAt(X), tc + LOB_WAIT), LOB_SPEED, undefined, { hop: false, len: LOB_LEN, arc: LOB_ARC * flatDist(from, rvAt), name: 'lob' });
        pose(rv, Math.max(freeAt(rv), th.tRel - 0.25), rvAt, face, FPOSE.cover, { name: 'cover' });
        pose(rv, th.tArr - 0.2, rvAt, face, FPOSE.catchChest, { name: 'catch' });
        pose(rv, th.tArr + 0.35, rvAt, faceTo(rvAt, [0, MOUND]), FPOSE.hold, { name: 'hold' });
        play.ev.lob = { to: rv.pos, release: th.tRel, arrive: th.tArr };
      }
    } else {
      for (const f of [B1, B2, SS, B3]) if (f !== X && flatDist(homeOf(f), at) < 22) arriveBy(f, stepToward(at, homeOf(f), 5), tc, FPOSE.stand, { faceTo: at, name: 'watch', look: 'ball' });
      if (r.type === 'pop') pose(P, FIELD_REACT.p, homeOf(P), faceTo(homeOf(P), at), FPOSE.point, { name: 'point' });
      watchAll(0, [X]);
    }
  } else if (r.kind === 'single' || r.kind === 'double' || r.kind === 'triple') {   // 뜬 안타: 떨어져 튀고 구르는 공을 가장 먼저 닿는 사람이 주워 2루(3루타는 3루)로 던진다
    const roll = rollPath(r), dur = roll.dur, L = roll.land, O = nearestOutfielder(side), hp = r.scnPlay?.home, goHome = !!hp && !hp.hold;
    seg(0, (t) => (t < dur ? { ...flightPos(r, t), trail: true } : roll.at(t)));
    // 외야수는 한 번 튄 뒤에 잡는다(떨어지기 전에 닿으면 안타가 아니라 아웃으로 보인다)
    let picker = O, ic = interceptRoll(roll, homeOf(O), reactOf(O), ...speedOf(O), dur + 0.35, 0.35, SET_REACH);
    if (o.miss) {   // 공 앞의 외야수가 떨어지는 공에 몸을 날렸다가 놓치고, 공은 담장까지 구른다. 일어나 쫓고, 옆 외야수가 먼저 닿으면 그가 줍는다
      const ob = otherOF(O);
      diveMiss(O, L, dur);
      const a = interceptRoll(roll, where(O), freeAt(O), ...speedOf(O), Math.max(dur + 0.35, freeAt(O)), 0.35, SET_REACH);
      const b = interceptRoll(roll, homeOf(ob), reactOf(ob), ...speedOf(ob), dur + 0.35, 0.35, SET_REACH);
      if (b.t < a.t) { picker = ob; ic = b; } else ic = a;
      play.ev.miss = O.pos;
    }
    if (flatDist(L, [0, 0]) < 48) {   // 얕게 떨어진 공: 가까운 내야수가 뒤로 쫓아간다. 거의 닿을 만하면 몸을 날려도 못 닿고, 일어나 주울 수도 있다
      const fi = [SS, B2, B3, B1].reduce((b, x) => (Math.abs(x.a - side) < Math.abs(b.a - side) ? x : b));
      const short = flatDist(homeOf(fi), L) - RUN_REACH - sprintDist(dur - reactOf(fi), ...speedOf(fi));
      if (Math.abs(short - 1.0) < 0.8) diveMiss(fi, L, dur);
      else arriveBy(fi, stepToward(homeOf(fi), L, clamp(flatDist(homeOf(fi), L) - 3, 0, 9)), dur, readyOf(fi), { faceTo: L, look: 'ball' });
      const icI = interceptRoll(roll, where(fi), freeAt(fi), ...speedOf(fi), dur + 0.35, 0.35, SET_REACH);
      if (icI.t < ic.t) { picker = fi; ic = icI; }
    }
    if (goHome) { picker = byPos(hp.pickup.pos); ic = { t: hp.pickup.t, at: hp.pickup.at }; }   // 판정(core hitPickup)과 같은 외야수·같은 때
    const got = pickUp(picker, roll.at, ic.t);
    seg(ic.t, held(picker), picker);
    Object.assign(play.ev, { land: dur, pickup: ic.t, fielder: picker.pos });
    const th = r.kind === 'triple' ? toThird(picker, got) : goHome ? toHome(picker, got, hp) : toSecond(picker, got);
    if (goHome) { const d = Math.max(hp.arrive + TAG_TIME, hp.runner); play.ev.decide = d; if (Math.abs(hp.margin) < 0.2) closeCall(d, HOME_PLATE, hp.safe); }
    if (r.kind === 'triple') arriveBy(cover2, bag2(got.at), th.tArr, FPOSE.cover, { faceTo: got.at, name: 'cover' });   // 3루타도 2루는 비우지 않는다
    if (picker !== O) arriveBy(O, backupSpot(O, got.at, 8), ic.t, FPOSE.backup, { faceTo: got.at, name: 'backup' });
    else { const ob = otherOF(O); arriveBy(ob, backupSpot(ob, got.at, 10), ic.t, FPOSE.backup, { faceTo: got.at, name: 'backup' }); }
    if (picker !== B1 && !acts[B1.pos].length) arriveBy(B1, r.kind === 'single' ? aside1 : stepToward(BASE1, [0, 0], 1.5), th.tArr, FPOSE.readyIn, { faceTo: got.at });   // 단타는 1루 안쪽(주자가 돌아온다)
    if (picker !== B3 && !acts[B3.pos].length) arriveBy(B3, bag3, th.tArr, FPOSE.readyIn, { faceTo: got.at });
    const backBase = r.kind === 'triple' ? BASE3 : BASE2;   // 투수는 공이 가는 베이스 뒤를 받친다
    arriveBy(P, stepToward(backBase, got.at, -8), th.tArr, FPOSE.backup, { faceTo: backBase, name: 'backup' });
    reveal = Math.min(dur, REVEAL_MAX); end = th.end;
  } else if (r.kind === 'hr') {   // 홈런: 가까운 외야수가 담장까지 쫓아가 6m 안으로 넘어가면 뛰어오른다. 나머지는 공을 바라본다
    // 공은 관중석에 떨어지면 감춘다. 관중석은 담장 2m 뒤 3m 높이에서 시작해 1m 뒤로 갈 때마다 0.49m씩 높아진다(buildCrowd).
    // 전에는 담장 너머 땅 높이까지 떨어진 공이 관중석 그림 위에 그대로 보였다(2026-11-02 사용자 제보)
    const dur = flightDuration(r), fence = fenceDist(side), fly = (t) => flightPos(r, t), inStands = (q) => q.s > fence && q.y < 3 + 0.49 * Math.max(0, q.s - fence - 2);
    let gone = Infinity, over = dur;
    for (let t = 0; t <= dur; t += 0.02) { const q = fly(t); if (over === dur && q.s >= fence) over = t; if (inStands(q)) { gone = t; break; } }
    seg(0, (t) => (t >= gone ? { ...fly(gone), hidden: true } : { ...fly(t), trail: true }));
    const O = nearestOutfielder(side), wall = polar(side, fence - 1.2), [top, tau] = speedOf(O), need = flatDist(homeOf(O), wall);
    const reach = reactOf(O) + sprintTime(need, top, tau);
    if (reach + 0.4 <= over && fly(over).y < 6) {
      const t1 = run(O, wall, reactOf(O), { look: 'ball' });
      if (t1 < over - 0.5) pose(O, t1, wall, faceTo(wall, polar(side, fence + 5)), FPOSE.stand, { name: 'watch', look: 'ball' });
      anim(O, over - 0.35 * 0.8, wall, faceTo(wall, polar(side, fence + 5)), FTRACK.leap, 0.8, { name: 'leap' });
    } else {
      const k = Math.min(1, (over - reactOf(O)) * top / Math.max(1, need)), stopAt = [lerp(homeOf(O)[0], wall[0], k), lerp(homeOf(O)[1], wall[1], k)];
      const t1 = run(O, stopAt, reactOf(O), { look: 'ball' });
      pose(O, t1, stopAt, faceTo(stopAt, polar(side, fence + 5)), FPOSE.stand, { name: 'watch', look: 'ball' });
    }
    const ob = otherOF(O); arriveBy(ob, stepToward(homeOf(ob), wall, 12), over, FPOSE.stand, { faceTo: wall, name: 'watch', look: 'ball' });
    watchAll(0, [O, ob]);
    // 투수: 공이 간 쪽으로 옆으로 돌아서서 보다가, 담장을 넘으면 무릎에 손을 짚고 고개를 숙인다(옆모습이라 홈 뒤 카메라에서 잘 보인다).
    // SLUMP_HOLD초 뒤 천천히 일어나 고개를 숙인 채 선다
    const pAt = homeOf(P), pFace = side < 0 ? Math.PI : 0, s0 = over + SLUMP_DELAY;
    pose(P, FIELD_REACT.p, pAt, pFace, FPOSE.stand, { name: 'watch', look: 'ball' });
    anim(P, s0, pAt, pFace, FTRACK.slump, SLUMP_LEN, { name: 'slump', look: 'down' });
    pose(P, s0 + SLUMP_LEN, pAt, pFace, FPOSE.slump, { name: 'slump', look: 'down' });
    anim(P, s0 + SLUMP_HOLD, pAt, pFace, FTRACK.rise, RISE_LEN, { name: 'rise', look: 'down' });
    pose(P, s0 + SLUMP_HOLD + RISE_LEN, pAt, pFace, FPOSE.stand, { name: 'dejected', look: 'down' });
    reveal = Math.min(over, REVEAL_MAX); end = dur;
  } else {   // 파울: 공만 날아가고 수비는 바라본다
    seg(0, (t) => ({ ...flightPos(r, t), trail: true }));
    reveal = end = Math.min(flightDuration(r), REVEAL_MAX);
  }
  // 투수는 첫 수비 동작이 늦으면 그때까지 마운드 앞에서 공을 본다(투구 동작은 끝나면 마운드로 걸어 돌아가서, 늦게 수비에 끼면 1.5m를 미끄러져 왔다)
  const pf = acts[PITCHER_F.pos];
  if (pf.length && Math.min(...pf.map((e) => e.t0)) > FIELD_REACT.p + 0.15) pf.push({ k: 'pose', t0: FIELD_REACT.p, at: homeOf(PITCHER_F), face: faceTo(homeOf(PITCHER_F), [0, 0.3]), v: FPOSE.stand, name: 'watch', look: 'ball' });
  for (const f of DEFENSE) acts[f.pos].sort((a, b) => a.t0 - b.t0);
  segs.sort((a, b) => a.t0 - b.t0);
  play.ball = (t) => { for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].t0) return segs[i].at(t); return segs[0].at(t); };
  play.focus = (t) => { for (let i = play.focusSegs.length - 1; i >= 0; i--) if (t >= play.focusSegs[i].t0) return play.focusSegs[i].at(t); return play.ball(t); };
  play.reveal = r.type === 'ground' && (r.kind === 'out' || r.infield) ? reveal : Math.min(reveal, REVEAL_MAX);   // 1루에서 정해지는 땅볼은 2.6초 상한 없이
  play.end = end;
  // 느린 화면: 그 구간에서는 공·수비 시간(flightT)이 rate배로 흐른다. 결과 글자는 실제 시간(resultT)으로 띄워서 realTime으로 바꾼다
  play.slow ??= []; play.calls ??= [];
  play.rate = (t) => { for (const w of play.slow) if (t >= w.t0 && t < w.t1) return w.rate; return 1; };
  play.realTime = (t) => t + play.slow.reduce((sum, w) => sum + Math.max(0, Math.min(t, w.t1) - w.t0) * (1 / w.rate - 1), 0);
  play.revealReal = play.realTime(play.reveal);
  return play;
}

// ===== 수비수의 지금 자세 =====
// 그 수비수가 t초에 하고 있는 동작(마지막으로 시작한 것). 동작이 바뀔 때는 0.15초 동안 앞 자세에서 섞는다
function actorEntry(play, f, t) {
  const list = play ? play.acts[f.pos] : [];
  let i = -1;
  for (let j = 0; j < list.length; j++) if (list[j].t0 <= t) i = j;
  return { e: i >= 0 ? list[i] : null, prev: i > 0 ? list[i - 1] : null, i };
}
const readyEntry = (f) => ({ k: 'pose', t0: -1, at: homeOf(f), face: HOME_FACE(homeOf(f)), v: readyOf(f), name: 'ready' });
function entrySpot(e, t) {
  if (e.k === 'move') { const st = trackAt(e.track, Math.max(0, t - e.t0)); return alongRoute(e.route, st.s); }
  if (e.k === 'shuffle') { const u = smooth((t - e.t0) / Math.max(0.01, e.t1 - e.t0)); return [lerp(e.from[0], e.to[0], u), lerp(e.from[1], e.to[1], u)]; }
  return e.at;
}
function entryLook(play, e, at, t, f) {
  if (e.look === 'down') return [Math.cos(e.face), -1.1, Math.sin(e.face)];   // 고개를 숙인다(홈런 맞은 투수)
  if (e.look !== 'ball' || !play) return null;
  let sg = play.segs[0];
  for (const q of play.segs) if (t >= q.t0) sg = q;
  if (sg.by === f) return null;
  const b = sg.at(t);
  return [b.x - at[0], b.y - 1.6, b.z - at[1]];
}
// 뛰는 수비수 뼈대. 몸은 길을 따라 그 자리에서 가는 쪽을 본다(투수의 1루 커버처럼 꺾이는 길도)
function moveSkeleton(play, f, e, t, look, lefty) {
  const at = entrySpot(e, t), tt = Math.max(0, t - e.t0), st = trackAt(e.track, tt), q = alongRoute(e.route, st.s + 0.6), n = e.route.length;
  const u = Math.hypot(q[0] - at[0], q[1] - at[1]) > 0.05 ? unitTo(at, q) : unitTo(e.route[n - 2], e.route[n - 1]);
  const k = runnerSkeleton({ x: at[0], z: at[1], dir: u, speed: st.v, dist: st.s, ph: st.ph, gait: e.gait, route: e.route, track: e.track, t: tt, bank: 0,
    braking: st.v < trackAt(e.track, Math.max(0, tt - 0.05)).v - 0.01, lookFoul: false, look });
  return Object.assign(k, { plain: true, cap: true, bare: true, mitt: lefty ? 'r' : 'l', noBat: true });
}
// 달리며 공을 받는다(1루로 뛰어 오는 투수): 받기 0.3초 전부터 글러브 손을 공이 올 자리(rc.p)로 뻗고, 받은 뒤 0.25초 동안 공을 가슴 앞으로 가져와 든다
function reachHand(k, rc, t, chestAtCatch) {
  const lead = 0.3;
  if (t < rc.t - lead) return k;
  const f = k.facing(0), l = k.left(0), hold = V.add(V.mul(f, 0.32), V.add(V.mul(l, 0.1), [0, -0.18, 0]));
  rc.rel ??= V.sub(rc.p, chestAtCatch());   // 받는 순간 가슴에서 글러브까지
  let p;
  if (t <= rc.t) { const w = smooth((t - (rc.t - lead)) / lead); p = V.add(V.mul(k.hands.l, 1 - w), V.mul(rc.p, w)); }
  else { const w = smooth((t - rc.t) / 0.25); p = V.add(k.chest, V.add(V.mul(rc.rel, 1 - w), V.mul(hold, w))); }
  k.hands = { ...k.hands, l: p };
  k.elbows = { ...k.elbows, l: bendJoint(k.shoulders.l, p, 0.3, 0.29, V.add(l, [0, -0.6, 0])) };
  return k;
}
function entrySkeleton(play, f, e, t) {
  const at = entrySpot(e, t), look = entryLook(play, e, at, t, f), lefty = f === PITCHER_F && port.lefty();
  if (e.k === 'move') {
    const k = moveSkeleton(play, f, e, t, look, lefty);
    return e.reach ? reachHand(k, e.reach, t, () => moveSkeleton(play, f, e, e.reach.t, null, lefty).chest) : k;
  }
  if (e.k === 'shuffle') return fielderSkeleton(at, e.face ?? (look ? Math.atan2(look[2], look[0]) : HOME_FACE(at)), e.v, look, lefty);
  const v = e.track ? e.track(clamp((t - e.t0) / e.len, 0, 1)) : e.v;
  return fielderSkeleton(at, e.face, v, look, lefty);
}
export function actorSkeleton(play, f, t) {
  const { e, prev } = actorEntry(play, f, t);
  if (!e) return entrySkeleton(play, f, readyEntry(f), t);
  const k = entrySkeleton(play, f, e, t), u = (t - e.t0) / BLEND;
  if (u >= 1) return k;
  const from = prev ? entrySkeleton(play, f, prev, Math.min(t, prev.t1 ?? t)) : f === PITCHER_F ? pitcherSkeleton(port.pitchT(), !!port.lefty()) : entrySkeleton(play, f, readyEntry(f), t);
  return blendSkeleton(from, k, smooth(u));
}
const NAME_OF = { move: 'run', shuffle: 'run' };
export function actorState(play, f, t) {
  const { e } = actorEntry(play, f, t);
  if (!e) return { spot: homeOf(f), pose: 'ready' };
  return { spot: entrySpot(e, t), pose: e.k === 'pose' ? e.name : NAME_OF[e.k], phase: t - e.t0 };
}
// 투수는 공을 친 뒤 수비 동작이 시작되면 수비수로 그린다. 그 전에는 투구 그림(drawPitcher) 그대로
export const pitcherFielding = (play, t) => !!play && play.acts[PITCHER_F.pos].some((e) => e.t0 <= t);

// 지금 수비수들의 자리와 자세(예전 모양). r이 없거나(공을 안 쳤을 때, 다시 보기 중) 수비에 안 끼면 제자리 준비 자세
export function fieldersAt(r, t) {
  const play = r ? fieldPlay(r) : null;
  return FIELDERS.map((f) => { const s = actorState(play, f, t); return { f, spot: s.spot, pose: s.pose, phase: s.phase }; });
}
