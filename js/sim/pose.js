// 키 자세와 뼈대 조립(2026-11-06 코드 나누기 4단계에서 main.js에서 옮김). 키 자세(엉덩이 자리·몸 방향·숙임·발·손)를 곡선으로 잇고(makeTrack)
// 관절 자리(마당 기준 3D, 미터)로 조립한다(assembleFigure). 투수 투구 동작, 수비수가 선 뼈대, 두 뼈대 섞기도 여기 있다. 화면은 모른다(그리기는 main.js)
import { DEG, lerp } from '../core/math.js';
import { MOUND } from '../core/field.js';
import { bendJoint, V } from './geom.js';

// 포즈는 투수 발밑(마운드 위) 기준 [x, y] 미터. 화면 왼쪽이 투수의 오른팔이다
export const WINDUP = 1.0;   // 와인드업 시작부터 공을 놓기까지(초)

// ===== 투구 동작(2026-11-02 사용자 요청 '투구폼을 바꿔야 한다') =====
// 전에는 정면을 본 납작한 인형의 손발 자리만 옮겨서 몸을 옆으로 돌렸다가 트는 동작이 없었다. 이제 타자와 같은 3D 인형으로 실제 투구 단계를 따른다
// (우완을 포수 쪽에서 볼 때): 옆으로 서서 왼쪽 어깨가 홈을 향하고(가슴은 3루 쪽) 손을 가슴에 모은 세트 → 왼무릎을 가슴 쪽으로 드는 균형 →
// 손을 나누며 홈 쪽으로 크게 내딛기(글러브 팔은 홈을 가리키고 공 쥔 팔은 아래·뒤로 돌아 올라간다, 엉덩이가 어깨보다 먼저 열린다) →
// 앞발이 닿을 때 공 쥔 손은 머리 뒤 높이 → 몸통이 홈 쪽으로 돌며 팔을 뒤로 젖혔다가 머리 위로 넘겨 놓기 → 팔이 몸을 가로질러
// 왼무릎 바깥까지 내려가고 뒷다리가 앞으로 돌아 나와 수비 자세. 그 뒤 마운드로 걸어 돌아간다. 공을 놓는 손은 RELEASE 그대로다.
// 자리는 투수판 기준(x 오른쪽, y 마운드 위, z는 2루 쪽이 +), 방향(yaw)은 가슴이 보는 쪽(180 3루 쪽, 270 홈 쪽), lean은 몸통을 앞으로 숙인 정도,
// tilt는 글러브 쪽으로 기울인 정도(라디안). 공을 놓을 때 몸통을 글러브 쪽으로 기울여 던지는 어깨가 올라가서 팔이 머리 위로 넘어오는 것처럼 보인다
const PITCH_KEYS = [
  [0, { pel: [0.03, 0.95, 0.02], hip: 180, sh: 180, lean: 0.05, tilt: 0, lf: [0, 0.03, -0.42], rf: [0.02, 0.03, 0.15], gl: [-0.2, 1.28, -0.05], bh: [-0.18, 1.26, 0.02] }],
  [0.18, { pel: [0.04, 0.96, 0.05], hip: 176, sh: 173, lean: 0.03, tilt: 0, lf: [-0.04, 0.14, -0.3], rf: [0.02, 0.03, 0.15], gl: [-0.21, 1.34, -0.03], bh: [-0.19, 1.32, 0.04] }],
  [0.4, { pel: [0.05, 0.98, 0.08], hip: 164, sh: 157, lean: -0.04, tilt: 0, lf: [-0.18, 0.66, -0.08], rf: [0.02, 0.03, 0.15], gl: [-0.22, 1.41, 0], bh: [-0.2, 1.39, 0.06] }],   // 2026-11-11: 다리를 들며 몸을 2루 쪽으로 더 감고 손을 턱 쪽으로 올린다
  [0.58, { pel: [0.03, 0.88, -0.5], hip: 200, sh: 178, lean: 0, tilt: 0, lf: [0.02, 0.28, -1.15], rf: [0.02, 0.03, 0.15], gl: [0, 1.38, -0.95], bh: [-0.3, 0.85, 0.35] }],
  [0.75, { pel: [0.03, 0.82, -0.95], hip: 240, sh: 195, lean: 0.1, tilt: 0.08, lf: [0.05, 0.03, -1.6], rf: [0, 0.05, 0.12], gl: [0.1, 1.38, -1.5], bh: [-0.32, 1.76, -0.5] }],
  [0.9, { pel: [0.03, 0.8, -1.15], hip: 262, sh: 240, lean: 0.28, tilt: 0.2, lf: [0.05, 0.03, -1.6], rf: [-0.02, 0.1, 0], gl: [0.18, 1.2, -1.38], bh: [-0.42, 1.62, -0.85] }],
  [WINDUP, { pel: [0.03, 0.78, -1.3], hip: 272, sh: 282, lean: 0.45, tilt: 0.35, lf: [0.05, 0.03, -1.6], rf: [-0.05, 0.15, -0.15], gl: [0.2, 1.1, -1.42], bh: [-0.55, 1.5, -1.44] }],
  [1.22, { pel: [0.06, 0.7, -1.45], hip: 285, sh: 315, lean: 0.75, tilt: 0.3, lf: [0.05, 0.03, -1.6], rf: [-0.15, 0.4, -1], gl: [0.3, 0.95, -1.35], bh: [0.4, 0.55, -1.85] }],
  [1.45, { pel: [-0.02, 0.76, -1.55], hip: 270, sh: 270, lean: 0.3, tilt: 0.05, lf: [0.22, 0.03, -1.62], rf: [-0.32, 0.03, -1.55], gl: [0.12, 1, -1.95], bh: [-0.12, 1, -1.92] }],
  [1.9, { pel: [0, 0.9, -1.45], hip: 270, sh: 270, lean: 0.1, tilt: 0, lf: [0.18, 0.03, -1.6], rf: [-0.2, 0.03, -1.45], gl: [0.15, 1.05, -1.7], bh: [-0.15, 1.05, -1.7] }],
  [2.35, { pel: [0.02, 0.92, -0.75], hip: 270, sh: 270, lean: 0.05, tilt: 0, lf: [0.15, 0.1, -1.1], rf: [-0.15, 0.03, -0.55], gl: [0.15, 1.05, -1], bh: [-0.15, 1.05, -1] }],   // 마운드로 걸어 돌아간다
  [2.9, { pel: [0.03, 0.95, 0.02], hip: 180, sh: 180, lean: 0.05, tilt: 0, lf: [0, 0.03, -0.42], rf: [0.02, 0.03, 0.15], gl: [-0.2, 1.28, -0.05], bh: [-0.18, 1.26, 0.02] }],
];
// 키 장면 사이를 속도가 이어지는 곡선(에르미트)으로 잇는다. 방향이 바뀌는 곳과 값이 그대로인 곳(디딘 발)은 그 방향 속도만 0이라 넘치지 않는다.
// 전에는 장면 사이마다 따로 부드럽게 이어서 키 장면마다 멈칫했다(2026-11-02 사용자 요청 '던지는 것을 더 부드럽고 자연스럽게')
export function makeTrack(keys, s0, s1) {
  const tans = keys.map(([t, v], j) => v.map((x, c) => {
    if (j === 0) return s0 ? s0[c] : 0;
    if (j === keys.length - 1) return s1 ? s1[c] : 0;
    const [ta, va] = keys[j - 1], [tb, vb] = keys[j + 1], d0 = (x - va[c]) / (t - ta), d1 = (vb[c] - x) / (tb - t);
    if (d0 * d1 <= 0) return 0;
    const m = (vb[c] - va[c]) / (tb - ta), lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    return Math.sign(m) * Math.min(Math.abs(m), lim);
  }));
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
    let i = 1;
    while (keys[i][0] < t) i++;
    const [t0, a] = keys[i - 1], [t1, b] = keys[i], h = t1 - t0, u = (t - t0) / h, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2, ma = tans[i - 1], mb = tans[i];
    return a.map((x, c) => h00 * x + h10 * h * ma[c] + h01 * b[c] + h11 * h * mb[c]);
  };
}
const pitchVec = (q) => [...q.pel, q.hip, q.sh, q.lean, ...q.lf, ...q.rf, ...q.gl, ...q.bh, q.tilt];
const pitchTrack = makeTrack(PITCH_KEYS.map(([t, q]) => [t, pitchVec(q)]));
// t초의 투수 뼈대(화면 기준 좌표). 좌완은 좌우를 거울로 뒤집는다
// 키 값(pitchVec 모양: 엉덩이 자리·엉덩이·어깨 방향·숙임·발·손·기울기)을 뼈대로 조립한다. 투수와 수비수가 함께 쓴다.
// W(x, y, z)는 키 좌표 → 화면 기준 좌표, R(v)는 키 방향 → 화면 기준 방향, yawOf(도)는 키의 몸 방향 → 화면 기준 라디안이다.
// 키는 오른손잡이 기준(lf 왼발, rf 오른발, gl 글러브 손, bh 공 쥔 손)이고, lefty면 거울로 뒤집은 뒤 좌우 짝을 바꾼다
function assembleFigure(v, W, R, yawOf, lefty = false) {
  const facing = (deg) => [Math.cos(yawOf(deg)), 0, Math.sin(yawOf(deg))], left = (deg) => [-Math.sin(yawOf(deg)), 0, Math.cos(yawOf(deg))];
  const [px, py, pz, hipYaw, shYaw, lean] = v, tilt = v[18], pelvis = W(px, py, pz), f = facing(shYaw), l = left(shYaw), fh = facing(hipYaw), lh = left(hipYaw);
  const gside = V.mul(l, lefty ? -1 : 1);   // 글러브 쪽
  const chest = V.add(pelvis, V.add(V.add([0, 0.5 * Math.cos(lean) * Math.cos(tilt), 0], V.mul(f, 0.5 * Math.sin(lean))), V.mul(gside, 0.5 * Math.sin(tilt))));
  const hips = { l: V.add(pelvis, V.mul(lh, 0.12)), r: V.add(pelvis, V.mul(lh, -0.12)) };
  const sl = V.add(V.mul(l, Math.cos(tilt)), [0, -Math.sin(tilt) * (lefty ? -1 : 1), 0]);   // 기운 어깨선: 글러브 쪽 어깨가 내려간다
  const shoulders = { l: V.add(chest, V.mul(sl, 0.2)), r: V.add(chest, V.mul(sl, -0.2)) };
  const ballHand = lefty ? 'l' : 'r', mittHand = lefty ? 'r' : 'l';
  const lfoot = W(v[6], v[7], v[8]), rfoot = W(v[9], v[10], v[11]), glove = W(v[12], v[13], v[14]), ball = W(v[15], v[16], v[17]);
  const feet = { [mittHand]: lfoot, [ballHand]: rfoot }, hands = { [mittHand]: glove, [ballHand]: ball };
  const knees = { l: bendJoint(hips.l, feet.l, 0.46, 0.45, fh), r: bendJoint(hips.r, feet.r, 0.46, 0.45, fh) };
  const out = (side) => V.mul(l, side === 'l' ? 1 : -1);   // 그쪽 바깥
  const elbows = {   // 공 쥔 팔꿈치는 바깥·조금 아래·뒤쪽, 글러브 팔꿈치는 바깥·아래로 굽는다
    [ballHand]: bendJoint(shoulders[ballHand], ball, 0.3, 0.29, V.add(out(ballHand), R([0, -0.5, 0.3]))),
    [mittHand]: bendJoint(shoulders[mittHand], glove, 0.3, 0.29, V.add(out(mittHand), [0, -0.6, 0])),
  };
  const head = V.add(chest, V.add([0, 0.24 * Math.cos(lean), 0], V.mul(f, 0.24 * Math.sin(lean))));
  return { world: true, noBat: true, plain: true, cap: true, bare: true, side: 1, front: 0, mitt: mittHand, ballHand, e: 0, shTurn: shYaw, hipTurn: hipYaw,
    pelvis, chest, hips, shoulders, feet, knees, elbows, hands, hand: ball, tip: ball, yaw: 0, left, facing, head };
}
// t초의 투수 뼈대(화면 기준 좌표). 키는 마운드 위 좌표이고 좌완은 좌우를 거울로 뒤집는다.
// idle(화면 시계 초)을 주면 세트 자세로 서 있는 동안(와인드업 앞, 마운드로 돌아온 뒤) 숨을 쉬고, 와인드업 앞 0.5초에 포수 사인을 보고 한 번 끄덕인다
// (2026-11-11 사용자 '딱딱하다'. 전에는 다음 공을 누를 때까지 굳어 있었다). 수비가 이어 그릴 때(fielding.js)는 idle 없이 부른다
const SET_AGAIN = PITCH_KEYS[PITCH_KEYS.length - 1][0];
export function pitcherSkeleton(t, lefty = false, idle = null) {
  const m = lefty ? -1 : 1, v = pitchTrack(t).slice();   // 처음·끝 키는 키 배열 그대로라 사본에 더한다
  if (idle != null && (t <= 0 || t >= SET_AGAIN)) {   // 숨: 골반·손이 조금 오르내리고 몸이 살짝 숙여진다
    const b = Math.sin(1.9 * idle);
    v[1] += 0.004 * b; v[5] += 0.015 * b; v[13] += 0.008 * b; v[16] += 0.008 * b;
  }
  const k = assembleFigure(v, (x, y, z) => [m * x, 0.25 + y, MOUND + z], (q) => [m * q[0], q[1], q[2]], (deg) => (lefty ? 180 - deg : deg) * DEG, lefty);
  const u = (t + 0.47) / 0.27, nod = idle != null && u > 0 && u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;   // 사인에 끄덕임(머리가 숙여졌다 돌아온다)
  if (nod) k.head = V.add(k.head, [0, -0.05 * nod, -0.015 * nod]);
  k.brim = V.add(k.head, [0, -0.03 - 0.09 * nod, -0.12 + 0.03 * nod]);   // 투수는 늘 홈(포수) 쪽을 본다
  return k;
}
// 테스트용: t초에 공을 쥔 손의 자리. 공을 놓는 순간에는 RELEASE와 같아야 공이 손에서 나간다
export const pitcherHandAt = (t) => { const k = pitcherSkeleton(t), q = k.hands[k.ballHand]; return { x: q[0], y: q[1], z: q[2] }; };

// 수비 자세 키 값(pitchVec 모양)을 선 자세에서 바꿀 것만 받아 만든다. 홈 쪽(-z)을 보고 선 오른손잡이 기준이고, 자리(발 사이)가 원점이다. 왼쪽이 +x다
export const fpose = (o) => pitchVec({ pel: [0, 0.92, 0], hip: 270, sh: 270, lean: 0.02, tilt: 0, lf: [0.15, 0.03, 0], rf: [-0.15, 0.03, 0.02], gl: [0.26, 0.92, -0.05], bh: [-0.26, 0.92, -0.03], ...o });

// 자리 at([x, z])에서 face 방향(라디안, facing = [cos, 0, sin])을 보고 키 v 자세로 선 수비수 뼈대. look은 모자 챙이 향할 쪽(없으면 몸 앞)
export function fielderSkeleton(at, face, v, look, lefty = false) {
  const rho = face - 1.5 * Math.PI, c = Math.cos(rho), s = Math.sin(rho);
  const W = (x, y, z) => [at[0] + x * c - z * s, y, at[1] + x * s + z * c], R = (q) => [q[0] * c - q[2] * s, q[1], q[0] * s + q[2] * c];
  const k = assembleFigure(v, W, R, (deg) => deg * DEG + rho);
  if (lefty) k.mitt = 'r';   // 좌완 투수가 수비할 때는 글러브만 오른손으로 바꾼다
  const dir = look && V.len(look) > 1e-6 ? look : k.facing(k.shTurn);
  k.brim = V.add(k.head, V.add([0, -0.03, 0], V.mul(dir, 0.12 / V.len(dir))));
  k.front = Math.sign(k.facing(k.shTurn)[0]) || 1;
  return k;
}
// 뼈대 둘을 k(0~1)로 섞는다. 몸통 방향은 벡터(axes)로 섞는다.
// turn(a에서 b까지 몸이 도는 각, 라디안)을 주면 두 뼈대를 골반을 축으로 같은 방향까지 돌려 놓고 자세만 섞는다(2026-11-09 사용자 '수비 선수들이 너무 딱딱함').
// 관절 자리를 그대로 섞으면 크게 돌 때 어깨·골반이 한 점으로 모였다 펴져서 몸이 접히며 휙 돈다(수비수가 뛰기 시작·멈출 때 장면의 99%에서 나왔다)
export function blendSkeleton(a, b, k, turn = 0) {
  const L3 = (p, q) => [lerp(p[0], q[0], k), lerp(p[1], q[1], k), lerp(p[2], q[2], k)];
  const ca = Math.cos(turn * k), sa = Math.sin(turn * k), cb = Math.cos(turn * (k - 1)), sb = Math.sin(turn * (k - 1));
  const spinA = (q) => [q[0] * ca - q[2] * sa, q[1], q[0] * sa + q[2] * ca], spinB = (q) => [q[0] * cb - q[2] * sb, q[1], q[0] * sb + q[2] * cb];
  const pelvis = L3(a.pelvis, b.pelvis), L = turn ? (p, q) => V.add(pelvis, L3(spinA(V.sub(p, a.pelvis)), spinB(V.sub(q, b.pelvis)))) : L3, LR = (p, q) => ({ l: L(p.l, q.l), r: L(p.r, q.r) });
  const ax = (s) => s.axes ?? { lc: s.left(s.shTurn), fc: s.facing(s.shTurn), lp: s.left(s.hipTurn), fp: s.facing(s.hipTurn) };
  const A = ax(a), B = ax(b), N = (p, q) => { const v = turn ? L3(spinA(p), spinB(q)) : L3(p, q), n = V.len(v) || 1; return V.mul(v, 1 / n); };
  return { ...b, pelvis, chest: L(a.chest, b.chest), head: L(a.head, b.head), brim: L(a.brim, b.brim),
    hips: LR(a.hips, b.hips), shoulders: LR(a.shoulders, b.shoulders), knees: LR(a.knees, b.knees), feet: LR(a.feet, b.feet), elbows: LR(a.elbows, b.elbows), hands: LR(a.hands, b.hands),
    axes: { lc: N(A.lc, B.lc), fc: N(A.fc, B.fc), lp: N(A.lp, B.lp), fp: N(A.fp, B.fp) } };
}
// 뼈대 a에서 b까지 몸(어깨)이 도는 각(라디안, -π~π)
export function yawGap(a, b) {
  const yaw = (s) => { const q = s.axes ? s.axes.fc : s.facing(s.shTurn); return Math.atan2(q[2], q[0]); }, d = yaw(b) - yaw(a);
  return d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
}
