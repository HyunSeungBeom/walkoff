// 뛰는 자세(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김): 뛰기 표의 걸음 위상으로 친 타자·누상 주자·뛰는 수비수의 뼈대를 만든다(runnerSkeleton).
// 2루타 슬라이딩·1루 머리부터 슬라이딩 자세도 여기 있다. 차올린 발 밑창이 보이는지는 카메라 자리(port.eye)로 잰다
import { clamp, DEG, lerp } from '../core/math.js';
import { port } from './port.js';
import { bendJoint, smooth, unit3, V } from './geom.js';
import { blendSkeleton, fielderSkeleton, fpose, makeTrack } from './pose.js';
import { alongRoute, distAtPhase, phaseIndex, SPRINT, standingRunner } from './route.js';
import { HF_REACH } from './batter.js';

// 뛰는 자세(화면 기준 좌표). 2026-11-03 사용자 '뛰는 폼이 너무 안 자연스럽다, 살짝 만화 같은 느낌을 이용해 다시'로 시안 A(자연스럽게 + 과장 조금)·B(더 만화처럼)
// 가운데 A를 골랐다. 한 걸음을 애니메이션 키 자세로 짠다: 딛기 → 눌림(가장 낮음) → 떼기 → 날기(가장 높음).
// 디딘 발은 길 위 디딘 자리에 붙어 있고 뒤꿈치부터 들려 발볼로 민다. 엉덩이 높이는 딛는·떼는 순간에도 무릎이 조금 굽게 정해 다리가 뻣뻣하게 펴지지 않는다.
// 뗀 다리는 허벅지 각(수직 아래 0, 앞 +)과 무릎 굽힘을 키로 준다: 떼기 → 뒤꿈치 차올림 → 지나가기 → 무릎 끌어올림 → 정강이 펴기 → 딛기.
// 떼기·딛기 키는 디딘 다리 계산과 같은 각이고 기울기도 이어서 발이 튀거나 미끄러지지 않는다. 신발은 발목 각대로 기운다(feetDir).
// 전에는 뗀 발 자리를 엉덩이 기준 키로 줘서 딛기 직전 앞발이 일찍 땅에 내려와 다리를 찢은 것처럼(런지) 보였고, 딛는 순간 무릎이 쭉 펴졌고,
// 무릎 방향을 IK로 정해 뒤에서 정강이가 옆으로 벌어졌다(사용자 '오징어 다리')
// RUN_POSE: bump 날 때 오르는 높이(물리 값의 배수), drop 디딘 발 위에서 더 내려앉는 높이(m), sway·roll 디딘 발 쪽으로 옮기기(m)·기울기(도),
// twist·hipTwist 어깨·엉덩이를 서로 반대로 돌리기(도), leanK 숙임(걸음새 lean의 배수). 걸음 묶음(sprint 최고 속도, drive 출발, jog 천천히 뛰기)은
// td·to 딛는·떼는 순간 무릎 굽힘, land 몸 가운데보다 뒤에 딛는 거리(m, 빠를수록), toeTD·toeTO 딛는·떼는 순간 발끝 내림, keys [뗀 몫, 허벅지, 무릎],
// ankle [뗀 몫, 발목 펴기], arm 어깨 앞뒤(fwd·back)·팔꿈치 굽힘(elFwd·elBack)·뒤로 칠 때 바깥으로 벌림(flare)·앞으로 올 때 안쪽으로(cross). 각은 모두 도
const RUN_POSE = {
  bump: 1, drop: 0.022, sway: 0.02, roll: 3, twist: 16, hipTwist: 9, leanK: 0.75,
  sprint: { td: 22, to: 27, land: 0.12, toeTD: 8, toeTO: 45, keys: [[0.1, -15, 72], [0.3, 6, 128], [0.5, 42, 114], [0.68, 70, 98], [0.86, 54, 40]], ankle: [[0.3, 30], [0.7, 6]],
    arm: { fwd: 50, back: -62, elFwd: 72, elBack: 108, flare: 13, cross: 10 } },
  drive: { td: 38, to: 16, land: 0, toeTD: 4, toeTO: 50, keys: [[0.12, -18, 50], [0.32, 0, 92], [0.52, 40, 108], [0.7, 68, 100], [0.88, 30, 50]], ankle: [[0.3, 25], [0.7, 8]],
    arm: { fwd: 66, back: -66, elFwd: 80, elBack: 100, flare: 12, cross: 8 } },
  jog: { td: 24, to: 28, land: 0.06, toeTD: 0, toeTO: 30, keys: [[0.12, -12, 48], [0.32, 2, 92], [0.52, 26, 84], [0.7, 42, 68], [0.88, 36, 24]], ankle: [[0.3, 25], [0.7, 4]],
    arm: { fwd: 34, back: -32, elFwd: 78, elBack: 100, flare: 7, cross: 7 } },
};
const LEG1 = 0.46, LEG2 = 0.45, ANKLE_Y = 0.06, FOOT_W = 0.09;   // 넓적다리·정강이 길이, 땅에 선 발목 높이, 발이 몸 가운데에서 옆으로 떨어진 거리
const legLen = (k) => Math.sqrt(LEG1 * LEG1 + LEG2 * LEG2 + 2 * LEG1 * LEG2 * Math.cos(k));   // 무릎을 k 굽혔을 때 엉덩이~발목
// 엉덩이에서 발목까지(앞 dx, 아래 dy)의 허벅지 각과 무릎 굽힘(라디안). 무릎은 앞으로 굽는다
function legAngles(dx, dy) {
  const L = Math.min(Math.hypot(dx, dy), LEG1 + LEG2 - 0.002), phi = Math.atan2(dx, dy);
  const alpha = Math.acos(clamp((LEG1 * LEG1 + L * L - LEG2 * LEG2) / (2 * LEG1 * L), -1, 1));
  const inner = Math.acos(clamp((LEG1 * LEG1 + LEG2 * LEG2 - L * L) / (2 * LEG1 * LEG2), -1, 1));
  return [phi + alpha, Math.PI - inner];
}
// 발끝을 phi만큼 내려(뒤꿈치를 들어) 발볼로 설 때 발목이 움직이는 양(앞, 위)
const heelLift = (phi) => [0.12 - 0.12 * Math.cos(phi) + 0.05 * Math.sin(phi), 0.12 * Math.sin(phi) + 0.05 * Math.cos(phi) - 0.05];
// 디딤 동안(us 0 → 1) 발끝 내림: 발볼로 딛어 뒤꿈치를 내리고, 디딤 뒤쪽 반부터 뒤꿈치를 들어 발끝으로 민다
const toeAt = (Q, us) => (Q.toeTD * (1 - smooth(us / 0.25)) + Q.toeTO * Math.pow(clamp((us - 0.45) / 0.55, 0, 1), 2)) * DEG;
// 끝 기울기: 이웃 키 쪽과 방향이 반대면 0, 크기는 그 구간 평균 기울기의 3배까지(넘침 막기)
const endSlope = (s, d) => (s * d <= 0 ? 0 : Math.sign(s) * Math.min(Math.abs(s), 3 * Math.abs(d)));
const mixPose = (a, b, k) => (typeof a === 'number' ? lerp(a, b, k) : Array.isArray(a) ? a.map((x, i) => mixPose(x, b[i], k)) : Object.fromEntries(Object.keys(a).map((key) => [key, mixPose(a[key], b[key], k)])));
// 걸음새 G를 빠르기 vv로 뛸 때의 걸음 묶음. 전력(effort 1)은 출발(drive) → 최고 속도(sprint)로 섞고, 천천히 뛰기(effort 0)는 느릴수록 작게 움직인다
function runPose(G, vv) {
  const P = RUN_POSE, sp = mixPose(P.drive, P.sprint, Math.pow(clamp(vv / G.top, 0, 1), 1.3)), ef = G.effort ?? 1;
  if (ef >= 1) return sp;
  const s = 0.6 + 0.4 * clamp((vv - 1.2) / 4.2, 0, 1), J = P.jog;
  const jog = { ...J, keys: J.keys.map(([w, a, b]) => [w, a * s, b * s]), arm: mixPose({ ...J.arm, fwd: 0, back: 0 }, J.arm, s) };
  return ef <= 0 ? jog : mixPose(jog, sp, ef);
}
const landOf = (G, kv) => lerp(RUN_POSE.jog.land, lerp(RUN_POSE.drive.land, RUN_POSE.sprint.land, Math.pow(kv, 1.3)), G.effort ?? 1) * kv;
// 한 발의 j번째 걸음: D 디딤 몫, b 몸 뒤로 디디는 거리, land 빨리 뛸 때 몸 가운데보다 뒤에 딛는 거리(딛는 발이 몸 앞 멀리 나가지 않게).
// 출발 직후일수록 오래 디디고 몸 뒤를 밀어서 뒷발부터 머리까지 한 줄로 기운다.
// 걸음마다 그 걸음을 디딜 때의 빠르기로 정해서 디딘 발이 미끄러지지 않는다. 멈출 때(빠르기가 줄 때)는 그대로 둔다
export function runStep(tr, G, j, off) {
  const i = phaseIndex(tr, j - off), braking = i > 6 && tr.V[i] < tr.V[i - 6] - 0.01, kv = clamp(tr.V[i] / G.top, 0, 1);
  const e = braking ? 0 : Math.pow(1 - kv, 1.6);
  return { D: G.D + (G.Dstart ?? 0) * e, b: (G.drive ?? 0) * e, land: landOf(G, kv) };
}
export const plantDist = (tr, j, off, st) => distAtPhase(tr, j - off + st.D / 2) - st.b - st.land;   // j번째 걸음에 디딘 자리(길 위 거리)
export function runnerSkeleton(run) {
  if (run.slide) return slideSkeleton(run);
  if (run.dive) return diveSkeleton(run);
  const th = Math.atan2(run.dir[1], run.dir[0]), facing = (deg) => [Math.cos(th + deg * DEG), 0, Math.sin(th + deg * DEG)], left = (deg) => [-Math.sin(th + deg * DEG), 0, Math.cos(th + deg * DEG)];
  const G = run.gait ?? SPRINT, tr = run.track, v = run.speed, D = G.D, f = facing(0), l = left(0), up = [0, 1, 0], base = [run.x, 0, run.z], RP = RUN_POSE;
  const g = clamp(v / 1.2, 0, 1), ka = clamp(v / 1.5, 0, 1), amp = clamp(v / 2.5, 0, 1), ef = G.effort ?? 1;   // g: 거의 서 있을 때는 두 발을 모으고 선다
  const cadAt = (vv) => G.cad[0] + G.cad[1] * vv, cad = cadAt(v), early = run.braking ? 0 : Math.pow(1 - clamp(v / G.top, 0, 1), 1.6);   // early: 출발 직후일수록 1
  const swingAt = (ph) => Math.cos(2 * Math.PI * (ph - (D + 0.68 * (1 - D))));   // +1이면 오른팔이 가장 앞(왼무릎이 가장 높다)
  const hipTurnAt = (ph) => -RP.hipTwist * swingAt(ph) * ka * g;
  const hipFwdAt = (side, ph) => -side * 0.11 * Math.sin(hipTurnAt(ph) * DEG);   // 엉덩이를 돌려 엉덩이 관절이 앞뒤로 나간 거리
  // 한 발의 n번째 디딤: 디딘 자리, 딛는·떼는 순간 발목(엉덩이 관절 기준), 그때와 디딤 가운데의 엉덩이 높이(그 무릎 굽힘이 되는 높이)
  const steps = new Map();
  const info = (off, n) => {
    const key = `${off}:${n}`;
    if (steps.has(key)) return steps.get(key);
    const st = runStep(tr, G, n, off), ph0 = n - off, vS = tr.V[phaseIndex(tr, ph0)], Q = runPose(G, vS), side = off === 0 ? 1 : -1, plant = plantDist(tr, n, off, st);
    const lTD = heelLift(Q.toeTD * DEG), lTO = heelLift(Q.toeTO * DEG);
    const aTD = [plant + lTD[0] - distAtPhase(tr, ph0) - hipFwdAt(side, ph0), ANKLE_Y + lTD[1]];
    const aTO = [plant + lTO[0] - distAtPhase(tr, ph0 + st.D) - hipFwdAt(side, ph0 + st.D), ANKLE_Y + lTO[1]];
    const xMid = plant - distAtPhase(tr, ph0 + st.D / 2) - hipFwdAt(side, ph0 + st.D / 2);
    const reach = (k, a) => a[1] + Math.sqrt(Math.max(0.01, legLen(k * DEG) * legLen(k * DEG) - a[0] * a[0]));
    const hTD = reach(Q.td, aTD), hTO = reach(Q.to, aTO);
    const hMid = clamp(Math.min(hTD, hTO) - RP.drop * clamp(vS / 3, 0, 1), reach(55, [xMid, ANKLE_Y]), reach(10, [xMid, ANKLE_Y]));
    const s = { D: st.D, plant, side, hTD, hTO, hMid, Q, v: vS, ph0 };
    steps.set(key, s);
    return s;
  };
  const nextStep = (off, n) => (off === 0 ? [0.5, n + 1] : [0, n]);
  // 한 걸음(이 발을 디딘 때부터 다른 발을 디딜 때까지, u 0 → 1)의 엉덩이 높이: 딛기 → 눌림(가장 낮음) → 떼기 → 날기(가장 높음) → 다음 딛기
  const curves = new Map();
  const stepCurve = (off, n) => {
    const key = `${off}:${n}`;
    if (curves.has(key)) return curves.get(key);
    const A = info(off, n), B = info(...nextStep(off, n)), tf = (0.5 - A.D) / cadAt(A.v);
    const bump = RP.bump * lerp(0.6, 1, ef) * 9.8 * tf * tf / 8 * clamp(A.v / 3, 0, 1), uTO = 2 * A.D, uPk = (uTO + 1) / 2, pk = Math.max(A.hTO, B.hTD) + bump;
    const s0 = endSlope((A.hMid - pk) / (A.D + 1 - uPk), (A.hMid - A.hTD) / A.D), s1 = endSlope((B.hMid - pk) / (B.D + 1 - uPk), (B.hTD - pk) / (1 - uPk));
    const c = makeTrack([[0, [A.hTD]], [A.D, [A.hMid]], [uTO, [A.hTO]], [uPk, [pk]], [1, [B.hTD]]], [s0], [s1]);
    curves.set(key, c);
    return c;
  };
  // 디딘 다리의 각(us: 디딤 동안 0 → 1)
  const stanceAt = (off, n, us) => {
    const A = info(off, n), H = stepCurve(off, n)(2 * A.D * us)[0], toe = toeAt(A.Q, us), lift = heelLift(toe), ph = A.ph0 + A.D * us;
    return { ang: legAngles(A.plant + lift[0] - distAtPhase(tr, ph) - hipFwdAt(A.side, ph), H - ANKLE_Y - lift[1]), toe };
  };
  // 지금 걸음은 가장 최근에 디딘 발의 걸음이다
  const qL = run.ph - Math.floor(run.ph), qR = run.ph + 0.5 - Math.floor(run.ph + 0.5), curOff = qL <= qR ? 0 : 0.5;
  const standH = Math.min(0.9, 0.06 + Math.sqrt(Math.max(0, 0.905 * 0.905 - Math.pow((G.drive ?? 0) * early, 2))));
  const H = g > 0 ? lerp(standH, stepCurve(curOff, Math.floor(run.ph + curOff))(2 * Math.min(qL, qR))[0], g) : standH;
  const P = g > 0 ? runPose(G, v) : null, swing = swingAt(run.ph) * ka;
  const swayK = RP.sway * amp * Math.cos(2 * Math.PI * (run.ph - D / 2)), bank = (run.bank ?? 0) * g, inward = V.mul(l, Math.sin(bank));   // 베이스를 돌 때 안쪽으로 기운다
  const pelvis = V.add(V.add(V.add(base, V.mul(inward, 0.12)), V.mul(l, swayK)), [0, H, 0]);
  const hipTurn = hipTurnAt(run.ph), shTurn = RP.twist * swing * g;   // 오른팔이 나가면 오른 어깨가 앞으로, 엉덩이는 반대로 돈다
  const hips = { l: V.add(pelvis, V.mul(left(hipTurn), 0.11)), r: V.add(pelvis, V.mul(left(hipTurn), -0.11)) };
  const sg0 = (e) => e.ang[0] - e.ang[1] + e.toe;   // 떼는·딛는 순간 발목 펴기(정강이 기울기 + 발끝 내림)
  const leg = (off, side) => {
    const hip = hips[side > 0 ? 'l' : 'r'], stand = V.add(base, V.add(V.mul(l, side * 0.13), [0, ANKLE_Y, 0]));
    if (g <= 0) return { foot: stand, knee: bendJoint(hip, stand, LEG1, LEG2, f), dir: f };
    const ph = run.ph + off, n = Math.floor(ph), q = ph - n, A = info(off, n);
    let foot, knee = null, dir;
    if (q < A.D) {   // 디딘 발: 디딘 자리에서 뒤꿈치부터 들려 발볼로 민다
      const toe = toeAt(A.Q, q / A.D), lift = heelLift(toe), gp = alongRoute(run.route, Math.max(0, A.plant + lift[0]));
      foot = [gp[0] + l[0] * side * FOOT_W, ANKLE_Y + lift[1], gp[1] + l[2] * side * FOOT_W];
      dir = V.add(V.mul(f, Math.cos(toe)), V.mul(up, -Math.sin(toe)));
    } else {   // 뗀 발: 키 사이를 잇되 양 끝은 떼는·딛는 순간의 디딘 다리 각과 그 기울기
      const w = (q - A.D) / (1 - A.D), B = info(off, n + 1), K = P.keys.map(([kw, a, b]) => [kw, [a * DEG, b * DEG]]), last = K[K.length - 1];
      const e0 = stanceAt(off, n, 1), e0b = stanceAt(off, n, 0.94), e1 = stanceAt(off, n + 1, 0), e1b = stanceAt(off, n + 1, 0.06);
      const k0 = (1 - A.D) / (A.D * 0.06), k1 = (1 - A.D) / (B.D * 0.06);   // 디딤 몫 → 뗀 몫 기울기
      const s0 = [0, 1].map((c) => endSlope((e0.ang[c] - e0b.ang[c]) * k0, (K[0][1][c] - e0.ang[c]) / K[0][0]));
      const s1 = [0, 1].map((c) => endSlope((e1b.ang[c] - e1.ang[c]) * k1, (e1.ang[c] - last[1][c]) / (1 - last[0])));
      const [tA, kA] = makeTrack([[0, e0.ang], ...K, [1, e1.ang]], s0, s1)(w), sg = tA - kA;
      // 발목: 뗄 때 발끝이 내려가 있고, 차올릴 때 힘을 빼 늘어뜨렸다가, 딛기 전에 다시 세운다
      const beta = makeTrack([[0, [sg0(e0)]], ...P.ankle.map(([kw, b]) => [kw, [b * DEG]]), [1, [sg0(e1)]]])(w)[0];
      const hipFwd = V.dot(V.sub(hip, base), f), hipLat = V.dot(V.sub(hip, base), l), kx = Math.sin(tA) * LEG1, ky = -Math.cos(tA) * LEG1;
      knee = V.add(V.add(V.add(base, V.mul(f, hipFwd + kx)), V.mul(l, (hipLat + side * FOOT_W) / 2)), [0, hip[1] + ky, 0]);
      foot = V.add(V.add(V.add(base, V.mul(f, hipFwd + kx + Math.sin(sg) * LEG2)), V.mul(l, side * FOOT_W)), [0, Math.max(ANKLE_Y, hip[1] + ky - Math.cos(sg) * LEG2), 0]);
      dir = V.add(V.mul(f, Math.cos(sg - beta)), V.mul(up, Math.sin(sg - beta)));
    }
    if (g < 1 || !knee) { foot = V.add(V.mul(stand, 1 - g), V.mul(foot, g)); knee = bendJoint(hip, foot, LEG1, LEG2, f); dir = unit3(V.add(V.mul(f, 1 - g), V.mul(dir, g))); }
    return { foot, knee, dir };
  };
  const L_ = leg(0, 1), R_ = leg(0.5, -1), feet = { l: L_.foot, r: R_.foot }, knees = { l: L_.knee, r: R_.knee }, feetDir = { l: L_.dir, r: R_.dir };
  // 몸통: 출발할 때 크게 숙였다가 빨라질수록 세우고, 디딘 발 쪽으로 조금 기운다
  const lean = run.braking ? -0.04 : (G.lean * RP.leanK + G.start * early) * clamp(v, 0, 1);
  const roll = V.mul(l, Math.sin(RP.roll * DEG * amp * Math.cos(2 * Math.PI * (run.ph - D / 2))));
  const tUp0 = V.add(V.add(V.add(V.mul(up, Math.cos(lean) * Math.cos(bank)), V.mul(f, Math.sin(lean))), inward), roll), tUp = V.mul(tUp0, 1 / (V.len(tUp0) || 1));
  const tFwd = V.add(V.mul(up, -Math.sin(lean)), V.mul(f, Math.cos(lean)));
  const chest = V.add(pelvis, V.mul(tUp, 0.5));
  const shoulders = { l: V.add(chest, V.mul(left(shTurn), 0.2)), r: V.add(chest, V.mul(left(shTurn), -0.2)) };
  // 팔은 반대쪽 다리와 함께 친다. 앞으로는 팔꿈치를 접어 손이 얼굴 앞, 뒤로는 팔꿈치를 펴며 바깥으로 조금 벌려 뒤에서도 팔 치기가 보인다
  const limb = (deg) => V.add(V.mul(tUp, -Math.cos(deg * DEG)), V.mul(tFwd, Math.sin(deg * DEG)));
  const AR = P ? P.arm : RP.jog.arm;
  const arm = (sh, s, sd) => {
    const u = (s + 1) / 2, a = lerp(AR.back, AR.fwd, u), b = lerp(AR.elBack, AR.elFwd, u);
    const out = V.mul(l, sd), flare = AR.flare * DEG * Math.max(0, -s), cross = AR.cross * DEG * Math.max(0, s);
    const elbow = V.add(sh, V.mul(V.add(V.mul(limb(a), Math.cos(flare)), V.mul(out, Math.sin(flare))), 0.3));
    const fa = V.add(V.mul(limb(a + b), Math.cos(cross)), V.mul(out, -Math.sin(cross)));
    return { elbow, hand: V.add(elbow, V.mul(fa, 0.29 / (V.len(fa) || 1))) };
  };
  const al = arm(shoulders.l, -swing, 1), ar = arm(shoulders.r, swing, -1);
  if (run.raise > 0) {   // 홈런: 홈을 밟으며 오른손을 머리 위로 든다(위팔 0.3m·아래팔 0.29m 그대로)
    const k = run.raise, e2 = V.add(shoulders.r, V.add(V.mul(up, 0.29), V.add(V.mul(l, -0.05), V.mul(f, 0.05)))), h2 = V.add(e2, V.add(V.mul(up, 0.29), V.mul(f, 0.02)));
    ar.elbow = V.add(V.mul(ar.elbow, 1 - k), V.mul(e2, k)); ar.hand = V.add(V.mul(ar.hand, 1 - k), V.mul(h2, k));
  }
  const neck = V.add(V.mul(tUp, 0.6), V.mul(up, 0.4)), head = V.add(chest, V.mul(neck, 0.24 / (V.len(neck) || 1)));   // 몸은 숙여도 고개는 들어 앞을 본다
  // 1루를 지나치면 오른쪽(파울 쪽)을 본다. 수비수는 공을 본다(고개는 몸 앞에서 110°까지)
  const look = run.look ? clampLook(run.look, f) : run.lookFoul ? V.add(V.mul(f, 0.6), V.mul(l, -0.8)) : V.add(f, [0, -0.25 * early, 0]);
  // 밑창이 카메라를 보는 정도(땅에서 뜬 발만). 차올린 발은 밑창이 뒤를 봐서 카메라가 뒤에 있을 때 보인다
  const sole = (sd) => {
    const eye = port.eye(), ft = feet[sd], d = feetDir[sd], toCam = unit3(V.sub([eye.x, eye.y, eye.z], ft)), p = Math.atan2(d[1], Math.hypot(d[0], d[2]) * (V.dot(d, f) < 0 ? -1 : 1));
    return clamp((ft[1] - 0.15) / 0.2, 0, 1) * Math.max(0, V.dot(V.add(V.mul(f, Math.sin(p)), V.mul(up, -Math.cos(p))), toCam));
  };
  // 신발 효과(로켓 불꽃, 번개 운동화 발밑 번개)용 걸음: 빠르기, 앞쪽, 발마다 디딘 뒤 시간(디딤은 위상의 정수 자리)과 걸음 번호
  const plantOf = (off) => { const p = run.ph + off, n = Math.floor(p); return { age: (p - n) / cad, n }; };
  const stride = { v, fwd: f, l: plantOf(0), r: plantOf(0.5) };
  return { world: true, noBat: true, front: Math.sign(f[0]) || 1, side: 1, e: 0, shTurn, hipTurn, pelvis, chest, hips, shoulders, feet, knees, feetDir, elbows: { l: al.elbow, r: ar.elbow }, hands: { l: al.hand, r: ar.hand }, soles: { l: sole('l'), r: sole('r') }, hand: ar.hand, tip: ar.hand, yaw: 0, left, facing, head, brim: V.add(head, V.add([0, -0.04, 0], V.mul(look, 0.12 / (V.len(look) || 1)))), stride };
}
// 슬라이딩(4자): 엉덩이를 0.28m로 낮추고 상체를 뒤로 0.9라디안 눕혀, 왼다리는 펴서 발로 베이스를 짚고 오른다리는 접어 왼무릎 밑에 넣고 두 손은 위로 든다
function slidePose(run) {
  const th = Math.atan2(run.dir[1], run.dir[0]), facing = (deg) => [Math.cos(th + deg * DEG), 0, Math.sin(th + deg * DEG)], left = (deg) => [-Math.sin(th + deg * DEG), 0, Math.cos(th + deg * DEG)];
  const f = facing(0), l = left(0), up = [0, 1, 0], lean = 0.9, tUp = V.add(V.mul(up, Math.cos(lean)), V.mul(f, -Math.sin(lean)));
  const pelvis = [run.x, 0.28, run.z], chest = V.add(pelvis, V.mul(tUp, 0.5));
  const hips = { l: V.add(pelvis, V.mul(l, 0.11)), r: V.add(pelvis, V.mul(l, -0.11)) };
  const feet = { l: V.add(hips.l, [f[0] * 0.86, -0.2, f[2] * 0.86]), r: V.add(hips.l, [f[0] * 0.42, -0.21, f[2] * 0.42]) };
  const knees = { l: bendJoint(hips.l, feet.l, 0.46, 0.45, up), r: bendJoint(hips.r, feet.r, 0.46, 0.45, V.add(V.mul(l, -1), [0, -0.3, 0])) };
  const shoulders = { l: V.add(chest, V.mul(l, 0.2)), r: V.add(chest, V.mul(l, -0.2)) };
  const arm = (sh, sd) => ({ elbow: V.add(sh, V.add(V.mul(up, 0.26), V.mul(l, sd * 0.08))), hand: V.add(sh, V.add(V.mul(up, 0.52), V.mul(f, 0.08))) });
  const al = arm(shoulders.l, 1), ar = arm(shoulders.r, -1);
  const neck = V.add(V.mul(tUp, 0.5), V.mul(up, 0.5)), head = V.add(chest, V.mul(neck, 0.24 / V.len(neck)));   // 고개는 들어 베이스를 본다
  return { world: true, noBat: true, front: Math.sign(f[0]) || 1, side: 1, e: 0, shTurn: 0, hipTurn: 0, pelvis, chest, hips, shoulders, feet, knees, elbows: { l: al.elbow, r: ar.elbow }, hands: { l: al.hand, r: ar.hand }, soles: { l: 0, r: 0 }, hand: ar.hand, tip: ar.hand, yaw: 0, left, facing, head, brim: V.add(head, V.add([0, -0.04, 0], V.mul(f, 0.12))) };
}
// 달리던 자세 → 슬라이딩(down) → 베이스 위에 선 자세(up)로 섞는다
function slideSkeleton(run) {
  const { down, up, bag } = run.slide, lie = slidePose(run);
  if (up > 0) return blendSkeleton(lie, runnerSkeleton({ ...run, slide: null, x: bag[0], z: bag[1], speed: 0, braking: false, bank: 0 }), up);
  return down < 1 ? blendSkeleton(runnerSkeleton({ ...run, slide: null }), lie, down) : lie;
}
// 1루 머리부터 슬라이딩 자세(수비수 다이빙 FTRACK.dive와 같은 키 모양, 엉덩이가 원점이고 몸 앞이 -z): 박차며 숙임 → 두 팔을 앞으로 뻗고 다리를 뒤로
// 띄워 난다 → 배로 떨어진다 → 엎드려 미끄러진다(손은 엉덩이 앞 HF_REACH m). 두 손을 모두 뻗고, 팔다리는 닿는 길이 안이다
const HF_POSE = makeTrack([
  [0, fpose({ pel: [0, 0.86, 0], lean: 0.55, lf: [0.12, 0.03, -0.2], rf: [-0.12, 0.3, 0.5], gl: [0.22, 0.98, -0.42], bh: [-0.22, 0.98, -0.42] })],
  [0.4, fpose({ pel: [0, 0.6, 0], lean: 1.25, lf: [0.13, 0.32, 0.7], rf: [-0.13, 0.42, 0.75], gl: [0.2, 0.68, -1.0], bh: [-0.2, 0.68, -1.0] })],
  [0.7, fpose({ pel: [0, 0.32, 0], lean: 1.45, lf: [0.14, 0.18, 0.86], rf: [-0.14, 0.22, 0.84], gl: [0.19, 0.24, -1.04], bh: [-0.19, 0.24, -1.04] })],
  [1, fpose({ pel: [0, 0.27, 0], lean: 1.48, lf: [0.15, 0.1, 0.88], rf: [-0.15, 0.12, 0.86], gl: [0.18, 0.15, -HF_REACH], bh: [-0.18, 0.15, -HF_REACH] })],
]);
// 일어나기: 엎드린 채 팔로 밀어 올리고 → 왼발을 앞에 디뎌 한쪽 무릎을 꿇었다가 → 선다
const HF_GETUP = makeTrack([
  [0, fpose({ pel: [0, 0.27, 0], lean: 1.48, lf: [0.15, 0.1, 0.88], rf: [-0.15, 0.12, 0.86], gl: [0.18, 0.15, -HF_REACH], bh: [-0.18, 0.15, -HF_REACH] })],
  [0.3, fpose({ pel: [0, 0.4, 0.1], lean: 1.05, lf: [0.15, 0.1, 0.75], rf: [-0.15, 0.1, 0.72], gl: [0.22, 0.12, -0.42], bh: [-0.22, 0.12, -0.42] })],
  [0.45, fpose({ pel: [0, 0.47, 0.13], lean: 0.82, lf: [0.17, 0.2, 0.25], rf: [-0.15, 0.1, 0.65], gl: [0.24, 0.25, -0.38], bh: [-0.24, 0.25, -0.38] })],
  [0.6, fpose({ pel: [0, 0.55, 0.15], lean: 0.6, lf: [0.18, 0.03, -0.3], rf: [-0.16, 0.12, 0.55], gl: [0.25, 0.45, -0.3], bh: [-0.25, 0.45, -0.3] })],
  [1, fpose({ pel: [0, 0.93, 0.02], lean: 0.06, lf: [0.15, 0.03, -0.02], rf: [-0.15, 0.03, 0.04], gl: [0.25, 0.95, -0.08], bh: [-0.25, 0.95, -0.08] })],
]);
// 키 자세 v로 at에서 face 쪽을 보는 친 타자 뼈대(수비수 조립을 빌리되 글러브·모자 없이 타자 헬멧·장갑·상점 물건을 그린다).
// 몸이 누울수록 고개를 들어 앞(베이스)을 보고, 밑창이 뒤(카메라 쪽)를 본다. 팔꿈치는 아래로 굽힌다(수비수처럼 옆으로 굽히면 뒤에서 날개처럼 보였다)
function runnerFigure(at, face, v) {
  const k = fielderSkeleton(at, face, v), f = k.facing(k.shTurn), l = k.left(k.shTurn), w = clamp((v[5] - 0.9) / 0.5, 0, 1);
  delete k.plain; delete k.cap; delete k.bare; delete k.mitt;
  for (const s of ['l', 'r']) k.elbows[s] = bendJoint(k.shoulders[s], k.hands[s], 0.3, 0.29, V.add(V.mul(l, s === 'l' ? 0.3 : -0.3), [0, -1, 0]));
  k.head = V.add(k.chest, V.mul(unit3(V.add(V.mul(unit3(V.sub(k.chest, k.pelvis)), 1 - w), V.mul(unit3(V.add(f, [0, 0.75, 0])), w))), 0.24));
  k.brim = V.add(k.head, V.add([0, -0.03, 0], V.mul(f, 0.12)));
  k.soles = { l: 0.8 * w, r: 0.8 * w };
  return k;
}
// 달리던 자세 → 머리부터 슬라이딩(blend·u) → 엎드려 있다가 일어나(up) 선 자세로 섞는다
function diveSkeleton(run) {
  const D = run.dive, face = Math.atan2(run.dir[1], run.dir[0]), at = [run.x, run.z];
  if (D.up > 0) {
    const k = runnerFigure(at, face, HF_GETUP(D.up));
    return D.up < 0.75 ? k : blendSkeleton(k, runnerSkeleton(standingRunner(at, run.dir)), smooth((D.up - 0.75) / 0.25));
  }
  const k = runnerFigure(at, face, HF_POSE(D.u));
  return D.blend < 1 ? blendSkeleton(runnerSkeleton(D.run), k, D.blend) : k;
}
function clampLook(look, f) {
  const h = Math.hypot(look[0], look[2]) || 1, c = (look[0] * f[0] + look[2] * f[2]) / h;
  if (c >= Math.cos(110 * DEG)) return look;
  const side = Math.sign(f[0] * look[2] - f[2] * look[0]) || 1, a = Math.atan2(f[2], f[0]) + side * 110 * DEG;
  return [Math.cos(a) * h, look[1], Math.sin(a) * h];
}
