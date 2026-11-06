// walkoff 게임: 화면, 수비·주루 그림, 진행, 입력, 랭킹·상점. 판정 규칙은 js/core/, 장면 계산(수비 일정·주루·뼈대)은 js/sim/, 화면 글은 js/view/text.js, 판 상태는 js/game/state.js,
// 바깥 연결(저장소·랭킹 서버·로그인·시드·소리·공유·통계·진동)은 js/infra/에서 가져온다(2026-11-03 코드 나누기 2단계, 2026-11-04 3단계, 2026-11-06 4단계. 나머지도 차례로 나눈다)
import { clamp, DEG, easeOut, lerp, mulberry32, pickWeighted, polar } from './core/math.js';
import { BALL_R, BASE1, BASE2, BASE3, FAIR_SPRAY, fenceDist, INFIELDERS, MOUND, OUTFIELDERS, RELEASE, ZONE } from './core/field.js';
import { ballPos, hardMatchup as hardMatchupIn, makePitch, makeSequence, PITCH_MIX, pitcherHand, PITCHES, zoneMiss } from './core/pitches.js';
import { CHANCES, hitStreakBefore as hitStreakIn, hitStreakBonus, hrStreakBefore as hrStreakIn, hrStreakBonus, PERFECT_BONUS } from './core/score.js';
import { groundPath, interceptGround, sprintTime } from './core/race.js';
import { AIM, FAIR_MS, FOUL_MS, judgeSwing as judgeSwingIn, judgeTake as judgeTakeIn, PERFECT_MS } from './core/judge.js';
import { applyScenario as applyScenarioIn, leadAt, makeScenario as makeScenarioIn, SCENARIOS, scenarioPitch, scenarioPoints } from './core/scenario.js';
import { carryOf, catchTime, flightDuration, flightPos } from './core/flight.js';
import { ITEMS, SLOTS, TEAM_IDS } from './core/catalog.js';
import { TITLES, titleById, titlesOf, topTitle } from './core/titles.js';
import { connect } from './sim/port.js';
import { bendJoint, smooth, unit3, V } from './sim/geom.js';
import { pitcherHandAt, pitcherSkeleton, WINDUP } from './sim/pose.js';
import { alongRoute, makeLeg, phaseIndex, routeState, SPRINT, standingRunner } from './sim/route.js';
import { batsOf, BATTER_X, BATTER_Z, runnerReach, runStartOf } from './sim/batter.js';
import { plantDist, runnerSkeleton, runStep } from './sim/runpose.js';
import { actorSkeleton, actorState, CATCHER_F, DEFENSE, FIELDERS, fieldersAt, fieldPlay, homeOf, PITCHER_F, pitcherFielding } from './sim/fielding.js';
import { baseRunnersAt, DUGOUT, runnerAt, scenarioRuns as scenarioRunsIn, walkoffTime as walkoffTimeIn } from './sim/runner.js';
import { labelSwing, labelTake, PITCH_COLORS, PITCH_NAMES, scenarioLabel, scenarioMessage, zoneOffText } from './view/text.js';
import { game, settings } from './game/state.js';
import { api, auth, fetchRanking, loggedIn, postScenario, postScore, RANKING_API } from './infra/api.js';
import { goKakaoLogin, readLoginReturn } from './infra/auth.js';
import { onSeedExpired, prefetchSeed, SEED_WAIT_MS, seedTicket, takeSeedTicket, urlSeed } from './infra/seeds.js';
import { canShareFiles, canShareSheet, copyText, pngFile, shareSheet } from './infra/share.js';
import { Sound } from './infra/sound.js';
import { track, trackSwing } from './infra/stats.js';
import { ensurePlayerId, store } from './infra/store.js';
import { canVibrate, vibrate } from './infra/vibrate.js';
// 규칙은 게임 상태를 모르니 여기서 이어 준다. 판정 결과의 이름·이유 글은 view/text.js가 붙인다. 조준 판은 조준(aim)을 결과에 같이 남겨 이유 글·다시 보기에 쓴다
const judgeSwing = (p, dt, bats, aim = null) => labelSwing(Object.assign(judgeSwingIn(p, dt, bats, aim), aim ? { aim } : {}), p);
const judgeTake = (p, bats = settings.bats) => labelTake(judgeTakeIn(p), p, bats);
const hrStreakBefore = (i) => hrStreakIn(game.results, i);
const hitStreakBefore = (i) => hitStreakIn(game.results, i);
const hardMatchup = (p) => hardMatchupIn(p, settings.bats);
const zoneOff = (p, bats = settings.bats) => zoneOffText(p, bats);
// 장면 계산(sim)도 판 상태·카메라를 모르니 부를 때 읽을 값을 여기서 이어 준다(카메라 자리, 지금 공의 투수 손·투구 시계, 타석, 폰 그림 이동).
// 끝내기 누상 주자는 공이 맞기 전 상황판을 인자로 넘긴다
connect({ eye: () => cam, lefty: () => game.seq[game.i]?.lefty, pitchT: () => game.t, batSide: () => batSide(), batterShift: () => batterShift() });
const scenarioRuns = (r) => scenarioRunsIn(r, game.scnBefore ?? game.scn);
const walkoffTime = (r) => walkoffTimeIn(r, game.scnBefore);

// ===== 화면과 원근 =====
// 카메라는 홈플레이트 뒤 3.2m, 눈높이 1.4m에서 투수 쪽을 본다. 멀수록 f / 거리만큼 작게 그린다
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const view = { w: 0, h: 0, dpr: 1, f: 0, cx: 0, cy: 0, panX: 0, panY: 0, mobile: false, shake: 0 };
const cam = { x: 0, y: 1.4, z: -3.2 };
// 홈런·큰 뜬공 때 공 뒤로 날아가는 카메라(2026-11-02 사용자 결정, 시안은 인프라 세션 walkoff-chasecam-proto). 방향은 늘 가운데 담장 쪽(회전 없음)이고
// 자리(cam)만 움직인다. project가 회전 없는 핀홀이라 3D로 그리는 것은 모두 따라온다. CAM_HOME은 타석 시점(처음 자리)
const CAM_HOME = { ...cam };
const camOffset = () => Math.max(cam.z - CAM_HOME.z, Math.abs(cam.x - CAM_HOME.x), Math.abs(cam.y - CAM_HOME.y));   // 타석 시점에서 움직인 거리(m, 가장 큰 축)
const camMoved = () => camOffset() > 0.3;
const FONT = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
const font = (size, weight = 700) => `${weight} ${Math.round(size)}px ${FONT}`;
function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth; view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr); canvas.height = Math.round(view.h * view.dpr);
  view.mobile = view.w < 640;
  view.f = Math.min(1.45 * view.h, (view.mobile ? MOBILE_FOV_W : 2.3) * view.w);
  view.cx = view.w / 2;
  view.cy = view.h * (view.mobile ? 0.31 : 0.34);
}

function project(x, y, z) {
  const d = z - cam.z;
  if (d < 0.1) return null;
  const s = view.f / d;
  return { x: view.cx + sceneShift() + view.panX + (x - cam.x) * s, y: view.cy + view.panY - (y - cam.y) * s, s };
}

// points: [x, z, y = 0] 목록. close면 닫힌 도형. 투영하기 전에 카메라 앞 0.1m 면(project가 null을 내는 곳)에서 자른다
// (닫힌 도형은 서덜랜드-호지먼, 선은 구간마다). 전에는 뒤로 넘어간 점을 건너뛰어, 따라가는 카메라가 지나친 땅 도형이 엉뚱한 모양이 됐다
function path3d(points, close = true) {
  ctx.beginPath();
  const near = cam.z + 0.1, P = points.map(([x, z, y = 0]) => [x, y, z]), n = P.length, inside = (p) => p[2] >= near;
  const cut = (a, b) => { const t = (near - a[2]) / (b[2] - a[2]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near + 1e-6]; };
  const runs = [];
  if (close) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      if (inside(a)) { out.push(a); if (!inside(b)) out.push(cut(a, b)); } else if (inside(b)) out.push(cut(a, b));
    }
    runs.push(out);
  } else {
    let cur = [];
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[i + 1];
      if (inside(a)) cur.push(a);
      if (!b) break;
      if (inside(a) && !inside(b)) { cur.push(cut(a, b)); runs.push(cur); cur = []; } else if (!inside(a) && inside(b)) cur.push(cut(a, b));
    }
    if (cur.length) runs.push(cur);
  }
  for (const run of runs) {
    let first = true;
    for (const [x, y, z] of run) {
      const p = project(x, y, z);
      if (!p) continue;
      if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
    }
  }
  if (close) ctx.closePath();
}

function fill3d(points, color) { path3d(points); ctx.fillStyle = color; ctx.fill(); }

function arcPoints(from, to, step, fn) {
  const out = [];
  const dir = from <= to ? 1 : -1;
  for (let a = from; dir > 0 ? a <= to : a >= to; a += step * dir) out.push(fn(a));
  return out;
}

function drawField() {
  const { w, h } = view;
  const horizon = view.cy + view.panY;
  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  sky.addColorStop(0, '#040912'); sky.addColorStop(1, '#16305a');
  ctx.fillStyle = sky; ctx.fillRect(-50, -50, w + 100, h + 100);
  ctx.fillStyle = '#145029'; ctx.fillRect(-50, horizon, w + 100, h - horizon + 100);

  // 관중석
  const stands = [
    ...arcPoints(-58, 58, 4, (a) => [...polar(a, fenceDist(a) + 2), 3]),
    ...arcPoints(58, -58, 4, (a) => [...polar(a, fenceDist(a) + 45), 24]),
  ];
  path3d(stands);
  const st = ctx.createLinearGradient(0, horizon - view.f * 0.2, 0, horizon);
  st.addColorStop(0, '#0a1222'); st.addColorStop(1, '#1f2c44');
  ctx.fillStyle = st; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let k = 1; k < 6; k++) {
    path3d(arcPoints(-58, 58, 4, (a) => [...polar(a, fenceDist(a) + 2 + 43 * k / 6), 3 + 21 * k / 6]), false);
    ctx.stroke();
  }
  // 투수 뒤 가운데는 관중 없이 어둡게(배터스 아이)
  fill3d([...arcPoints(-CROWD_EYE, CROWD_EYE, 1, (a) => [...polar(a, fenceDist(a) + 2), 3]), ...arcPoints(CROWD_EYE, -CROWD_EYE, 1, (a) => [...polar(a, fenceDist(a) + 45), 24])], '#07120d');
  drawCrowd();
  // 조명탑
  for (const a of [-42, -15, 15, 42]) {
    const [x, z] = polar(a, fenceDist(a) + 55);
    const p = project(x, 36, z);
    if (!p) continue;
    const R = view.f * 0.09;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
    g.addColorStop(0, 'rgba(255,250,220,0.85)'); g.addColorStop(0.18, 'rgba(255,245,200,0.28)'); g.addColorStop(1, 'rgba(255,245,200,0)');
    ctx.fillStyle = g; ctx.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    ctx.fillStyle = '#fffbe8'; ctx.fillRect(p.x - p.s * 3, p.y - p.s, p.s * 6, p.s * 2);
  }
  drawScoreboard();   // 관중 다음에 그려 관중에 가리지 않는다

  // 담장과 경고 트랙
  const fenceBase = arcPoints(-45, 45, 3, (a) => [...polar(a, fenceDist(a)), 0]);
  const fenceTop = arcPoints(-45, 45, 3, (a) => [...polar(a, fenceDist(a)), 3]);
  fill3d([...fenceBase, ...fenceTop.slice().reverse()], '#0d3b2b');
  path3d(fenceTop, false); ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2; ctx.stroke();
  fill3d([...arcPoints(-45, 45, 3, (a) => polar(a, fenceDist(a))), ...arcPoints(45, -45, 3, (a) => polar(a, fenceDist(a) - 5))], '#6b4c34');

  // 외야 잔디 무늬
  for (let r = 34; r < 118; r += 10) {
    fill3d([
      ...arcPoints(-45, 45, 3, (a) => polar(a, Math.min(r, fenceDist(a) - 5))),
      ...arcPoints(45, -45, 3, (a) => polar(a, Math.min(r + 5, fenceDist(a) - 5))),
    ], 'rgba(255,255,255,0.045)');
  }
  // 파울 지역은 조금 어둡게
  for (const s of [-1, 1]) fill3d([[0, -3], polar(45 * s, 110), polar(80 * s, 110), [s * 30, -3]], 'rgba(0,0,0,0.2)');

  // 내야 흙과 잔디
  fill3d([[0, -1], polar(45, 38.9), ...arcPoints(71.8, -71.8, 6, (t) => [29 * Math.sin(t * DEG), MOUND + 29 * Math.cos(t * DEG)]), polar(-45, 38.9)], '#9a6b45');
  fill3d([[0, 2.2], [17.4, 19.4], [0, 36.6], [-17.4, 19.4]], '#1a6233');
  fill3d(arcPoints(0, 345, 15, (t) => [2.74 * Math.sin(t * DEG), MOUND + 2.74 * Math.cos(t * DEG)]), '#a7754c');
  fill3d([[-0.3, MOUND - 0.08], [0.3, MOUND - 0.08], [0.3, MOUND + 0.08], [-0.3, MOUND + 0.08]], '#eeeae0');
  fill3d(arcPoints(0, 345, 15, (t) => [4 * Math.sin(t * DEG), -0.2 + 4 * Math.cos(t * DEG)]), '#9a6b45');
  for (const [x, z] of [polar(45, 27.43), [0, 38.8], polar(-45, 27.43)]) {
    fill3d([[x - 0.25, z - 0.25], [x + 0.25, z - 0.25], [x + 0.25, z + 0.25], [x - 0.25, z + 0.25]], '#f4f1ea');
  }
  // 파울 라인과 폴
  for (const s of [-1, 1]) {
    const a = 45 * s, nx = Math.cos(a * DEG) * 0.05, nz = -Math.sin(a * DEG) * 0.05;
    const [x0, z0] = polar(a, 0.6), [x1, z1] = polar(a, 100);
    fill3d([[x0 - nx, z0 - nz], [x1 - nx, z1 - nz], [x1 + nx, z1 + nz], [x0 + nx, z0 + nz]], 'rgba(255,255,255,0.85)');
    const b = project(x1, 0, z1), t = project(x1, 25, z1);
    if (b && t) { ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y); ctx.stroke(); }
  }
  // 타석과 홈플레이트
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = Math.max(1.5, view.f * 0.0016);
  for (const s of [-1, 1]) { path3d([[s * 0.36, -0.95], [s * 1.5, -0.95], [s * 1.5, 0.85], [s * 0.36, 0.85]]); ctx.stroke(); }
  fill3d([[-0.216, 0], [0.216, 0], [0.216, -0.216], [0, -0.43], [-0.216, -0.216]], '#f7f5ef');
}

// ===== 관중 =====
// 외야 관중석(담장 뒤 띠)을 사람으로 채운다(2026-10-29 사용자 요청). 1루 쪽(화면 오른쪽)은 내 팀, 3루 쪽은 상대 팀 색 옷이 많다.
// 투수 바로 뒤(가운데 ±CROWD_EYE도)는 실제 구장의 배터스 아이처럼 비운다. 공을 놓는 높이가 관중석과 겹쳐서 관중이 있으면 공이 묻힌다.
// 수천 명을 매 화면 그리면 폰이 버거워서, 앉은 모습과 일어나 손을 든 모습을 한 번씩 따로 그려 두고(화면 크기·팀이 바뀔 때만 다시) 붙인다.
// 안타·홈런·끝내기 때는 세로 띠마다 조금씩 다르게 일어났다 앉고, 홈런·끝내기에는 카메라 플래시가 터진다
const CROWD_ROWS = 22, CROWD_EYE = 4;   // 관중석 줄 수, 가운데 비우는 각도(±도). 공을 놓는 곳이 ±1.6도라 ±4도면 공이 관중에 묻히지 않는다(±6도는 폰에서 화면 폭의 40%가 검었다)
const crowd = { key: '', sit: null, stand: null, res: 1, x0: 0, y0: 0, people: [], builds: 0, at: 0, dur: 0, power: 0 };

function crowdPalette(teamId) {
  const t = teamById(teamId), plain = ['#eceef2', '#c9ced8', '#1c2130', '#2c3650', '#6f7b90'];   // 흰 옷, 회색, 검정·남색
  return t ? [t.main, t.main, t.main, t.main, t.accent, ...plain] : ['#c8504a', '#3a6db0', '#d9b44a', '#3d8b58', ...plain];
}

function buildCrowd(key) {
  const pan = [view.panX, view.panY];
  view.panX = view.panY = 0;   // 공을 따라가는 화면 이동은 붙일 때 더한다
  const rnd = mulberry32(20261029), home = crowdPalette(settings.team), away = crowdPalette(game.opponent), people = [];
  for (let k = CROWD_ROWS - 1; k >= 0; k--) {   // 뒷줄(화면 위)부터 그려서 앞줄 머리가 뒷줄 몸을 가린다
    const t = (k + 0.5) / CROWD_ROWS, y = 3 + 21 * t;
    for (let a = -57; a <= 57;) {
      const d = fenceDist(a) + 2 + 43 * t, step = 0.9 / d / DEG;   // 자리 간격 0.9m
      if (Math.abs(a) >= CROWD_EYE && rnd() > 0.12) {   // 12%는 빈자리
        const [x, z] = polar(a + (rnd() - 0.5) * step * 0.4, d), p = project(x, y, z), pal = a > 0 ? home : away;
        if (p) people.push({ a, x: p.x, y: p.y, s: p.s, shirt: pal[Math.floor(rnd() * pal.length)], head: rnd() < 0.25 ? pal[0] : rnd() < 0.5 ? '#d6a57f' : '#b98a66' });
      }
      a += step;
    }
  }
  [view.panX, view.panY] = pan;
  Object.assign(crowd, { key, people, sit: null, stand: null, builds: crowd.builds + 1 });
  if (!people.length) return;
  const minX = Math.min(...people.map((q) => q.x - q.s)), maxX = Math.max(...people.map((q) => q.x + q.s));
  const minY = Math.min(...people.map((q) => q.y - 1.8 * q.s)), maxY = Math.max(...people.map((q) => q.y + 1));
  const res = Math.min(view.dpr, 1.5, 4096 / (maxX - minX));   // 사람이 1~2px이라 1.5배면 충분하다(폰 메모리를 아낀다)
  const paint = (standing) => {
    const c = document.createElement('canvas');
    c.width = Math.ceil((maxX - minX) * res); c.height = Math.ceil((maxY - minY) * res);
    const g = c.getContext('2d');
    g.setTransform(res, 0, 0, res, -minX * res, -minY * res);
    for (const q of people) {
      const bw = 0.46 * q.s, bh = 0.6 * q.s, hr = Math.max(0.5, 0.13 * q.s), top = q.y - bh - (standing ? 0.3 * q.s : 0);
      g.fillStyle = q.shirt; g.fillRect(q.x - bw / 2, top, bw, q.y - top);
      if (standing) {   // 손을 든 팔
        const aw = Math.max(0.5, 0.1 * q.s), al = 0.45 * q.s;
        g.fillRect(q.x - bw / 2 - aw * 0.3, top - al, aw, al); g.fillRect(q.x + bw / 2 - aw * 0.7, top - al, aw, al);
      }
      g.fillStyle = q.head; g.beginPath(); g.arc(q.x, top - hr * 0.9, hr, 0, Math.PI * 2); g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);   // 밤 관중석이라 멀수록(위로 갈수록) 어둡게
    g.globalCompositeOperation = 'source-atop';
    const dark = g.createLinearGradient(0, 0, 0, c.height);
    dark.addColorStop(0, 'rgba(4,8,18,0.6)'); dark.addColorStop(1, 'rgba(4,8,18,0.22)');
    g.fillStyle = dark; g.fillRect(0, 0, c.width, c.height);
    return c;
  };
  Object.assign(crowd, { res, x0: minX, y0: minY, sit: paint(false), stand: paint(true) });
}

// power 1 안타, 2 홈런, 3 끝내기. delay초 뒤 일어나 dur초 동안 환호한다
function cheerCrowd(power, dur, delay = 0) { Object.assign(crowd, { at: performance.now() / 1000 + delay, dur, power }); }

function drawCrowd() {
  if (!view.w) return;
  const key = [view.w, view.h, view.dpr, sceneShift(), settings.team, game.opponent].join('|');
  if (crowd.key !== key) { const at = { ...cam }; Object.assign(cam, CAM_HOME); buildCrowd(key); Object.assign(cam, at); }   // 굽기는 늘 타석 시점으로
  if (!crowd.sit) return;
  if (camMoved()) { drawCrowdChase(); return; }
  const now = performance.now() / 1000, u = (now - crowd.at) / crowd.dur, res = crowd.res;
  const ox = crowd.x0 + view.panX, oy = crowd.y0 + view.panY, H = crowd.sit.height / res;
  if (!(u >= 0 && u < 1)) { ctx.drawImage(crowd.sit, ox, oy, crowd.sit.width / res, H); return; }
  const env = Math.min(1, u * 6, (1 - u) * 3), N = 40, sw = crowd.sit.width / N;   // 빨리 일어나고 천천히 앉는다
  for (let i = 0; i < N; i++) {
    const lift = env * (0.5 + 0.5 * Math.sin(now * (7 + crowd.power) + i * 1.7 + (i % 3)));
    const img = lift > 0.2 ? crowd.stand : crowd.sit;
    ctx.drawImage(img, i * sw, 0, sw, img.height, ox + i * sw / res, oy - lift * (1 + crowd.power) * 1.6, sw / res + 0.5, H);
  }
  if (crowd.power >= 2) {   // 홈런·끝내기에는 카메라 플래시
    ctx.fillStyle = '#fffbe6';
    for (let n = 0; n < 6 * crowd.power; n++) {
      const q = crowd.people[Math.floor(Math.random() * crowd.people.length)];
      ctx.globalAlpha = env * (0.4 + 0.6 * Math.random());
      ctx.fillRect(q.x + view.panX - 1, q.y - 0.8 * q.s + view.panY - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  }
}

// 따라가는 카메라의 관중: 타석 시점으로 구운 그림을 세로 40 × 가로 4칸으로 나눠, 칸마다 사람들의 깊이(구울 때 크기 s에서 거꾸로 구함)로
// 타석 화면 → 지금 화면의 비(k)와 이동을 구해 붙인다. 회전이 없어서 한 깊이 안에서는 정확하다. 날아가는 동안 다시 굽지 않는다(폰이 버벅인다).
// 뒷줄(위 칸)부터 그리고, 칸마다 깊이가 달라 생기는 틈은 칸을 조금씩 겹쳐 덮는다
const CROWD_TN = 40, CROWD_TM = 4;
function drawCrowdChase() {
  const W = crowd.sit.width, H = crowd.sit.height, res = crowd.res, sw = W / CROWD_TN, sh = H / CROWD_TM;
  if (crowd.tileKey !== crowd.key) {
    const sums = [];
    for (const q of crowd.people) {
      const i = Math.floor((q.x - crowd.x0) * res / sw), j = Math.floor((q.y - 0.8 * q.s - crowd.y0) * res / sh);
      if (i >= 0 && i < CROWD_TN && j >= 0 && j < CROWD_TM) (sums[i * CROWD_TM + j] ??= []).push(view.f / q.s);   // 타석 시점에서 이 사람까지 깊이
    }
    crowd.tiles = sums.map((a) => (a ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0));
    crowd.tileKey = crowd.key;
  }
  const now = performance.now() / 1000, u = (now - crowd.at) / crowd.dur, cheering = u >= 0 && u < 1, env = cheering ? Math.min(1, u * 6, (1 - u) * 3) : 0;
  const cx0 = view.cx + sceneShift(), dz = cam.z - CAM_HOME.z, shift = (dc) => [view.panX - (cam.x - CAM_HOME.x) * view.f / dc, view.panY + (cam.y - CAM_HOME.y) * view.f / dc];
  const lifts = Array.from({ length: CROWD_TN }, (_, i) => env * (0.5 + 0.5 * Math.sin(now * (7 + crowd.power) + i * 1.7 + (i % 3))));
  for (let j = 0; j < CROWD_TM; j++) {
    for (let i = 0; i < CROWD_TN; i++) {
      const dh = crowd.tiles[i * CROWD_TM + j], dc = dh - dz;
      if (!dh || dc < 3) continue;
      const lift = lifts[i], img = lift > 0.2 ? crowd.stand : crowd.sit, k = dh / dc, [tx, ty] = shift(dc);
      const x = crowd.x0 + i * sw / res, y = crowd.y0 + j * sh / res - lift * (1 + crowd.power) * 1.6, w = k * sw / res, h = k * sh / res, ox = 0.5 + 0.03 * w, oy = 0.5 + 0.12 * h;
      ctx.drawImage(img, i * sw, j * sh, sw, sh, cx0 + k * (x - cx0) + tx - ox, view.cy + k * (y - view.cy) + ty - oy, w + 2 * ox, h + 2 * oy);
    }
  }
  if (cheering && crowd.power >= 2) {   // 카메라 플래시: 사람마다 자기 깊이로 옮긴다
    ctx.fillStyle = '#fffbe6';
    for (let n = 0; n < 6 * crowd.power; n++) {
      const q = crowd.people[Math.floor(Math.random() * crowd.people.length)], dh = view.f / q.s, dc = dh - dz;
      if (dc < 3) continue;
      const k = dh / dc, [tx, ty] = shift(dc);
      ctx.globalAlpha = env * (0.4 + 0.6 * Math.random()); ctx.fillRect(cx0 + k * (q.x - cx0) + tx - 1, view.cy + k * (q.y - 0.8 * q.s - view.cy) + ty - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  }
}

// ===== 가운데 큰 전광판(2026-11-03 사용자 '투수 뒤 검은 공간을 전광판으로') =====
// 투수 뒤 배터스 아이(관중을 비운 어두운 곳)를 전광판으로 쓴다. 담장 18m 뒤에 선 폭 19m·높이 7~22m 화면이라 배터스 아이 안에 들어가고,
// 그 아래 띠(공을 놓는 자리 뒤)는 공이 보이게 어둡게 남긴다(공은 놓은 뒤 화면 아래로만 가서 전광판을 지나지 않는다).
// 투구 중에는 움직이지 않는 투수판이다(2026-11-03 사용자 '실제 전광판의 요약본, 투수가 어떤 투수인지'. 전에는 '상대 / VS / 우리 팀'이라 위쪽 점수판과 겹쳤다).
// 상대 팀 색 머리줄에 팀·선발(끝내기 상황은 마무리)·좌완/우완, 첫 공은 등번호와 이번 판의 직구 최고 구속·주무기, 그 뒤는 큰 등번호·주무기·직전 공.
// 연습은 직전 공 구속만, 시작 화면·타이밍 보정은 WALKOFF. 이미 던진 공으로만 정해서 바뀌는 때는 다음 공의 와인드업이 시작될 때뿐이다.
// 안타·홈런이 나오면 우리 팀 색 바탕에 HIT·HOMERUN이 한 글자씩 튀어나오고(boardMoment), 그동안 결과 카드는 숨겼다가 끝나면 나온다
// (결과 카드가 같은 자리에 겹친다). 홈런·큰 뜬공 안타는 따라가는 카메라가 타석 시점으로 돌아온 뒤에. 그 밖의 결과 화면에서는 꺼 둔다
const SCOREBOARD = { w: 19, y0: 7, y1: 22, back: 18, moment: 1.2, hrMoment: 1.6 }, scoreboardCache = { key: '', canvas: null };
function scoreboardRect() {
  const z = fenceDist(0) + SCOREBOARD.back, a = project(-SCOREBOARD.w / 2, SCOREBOARD.y1, z), b = project(SCOREBOARD.w / 2, SCOREBOARD.y0, z);
  return a && b ? { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, s: a.s, z } : null;
}
// 전광판이 HIT·HOMERUN을 띄우는 때(결과 화면 시간 resultT 기준): { word, t0, t1 }. 안타가 아니면 null
// 결과를 알리는 때(revealAt)에 띄운다. 카메라가 공 뒤로 날아가는 타구는 revealAt이 타석 시점으로 돌아올 때라서(revealOf) 폰에서도 전광판이
// 화면 안에 있고(2026-11-03 사용자 '전광판을 화면에 붙잡기'. 전에는 큰 뜬공 2루타가 카메라가 40m 앞에 있는 동안 HIT을 띄워 30%쯤만 보였다),
// 공이 날아가는 동안 눌러 건너뛰면(skipToBeat) 그 순간이 revealAt이다
function boardMoment() {
  const r = game.outcome;
  if (game.state !== 'result' || !r?.hit || game.replay != null) return null;
  const t0 = game.revealAt;
  return { word: r.kind === 'hr' ? 'HOMERUN' : 'HIT', t0, t1: t0 + (r.kind === 'hr' ? SCOREBOARD.hrMoment : SCOREBOARD.moment) };
}
// 결과 카드를 그려도 되는지(전광판이 HIT·HOMERUN을 띄우는 동안과 그 전에는 숨긴다)
const cardDetails = () => { const bm = boardMoment(); return !bm || game.resultT >= bm.t1; };
// 투수판에 쓰는 값. 등번호는 시드로 정하고 공 순서·투수 손·상대 팀과 다른 난수를 쓴다(pitcherHand·pickOpponent와 같은 방식). 선수 이름은 쓰지 않는다
const pitcherNo = (seed) => 1 + Math.floor(mulberry32((seed ^ 0x2c1b3c6d) >>> 0)() * 99);
// 그 판 공 순서 앞 16구(10구 도전의 평균 공 수)에서 직구 최고 구속과 가장 많이 나오는 변화구(같으면 먼저 나온 것). 10구 도전은 시작할 때
// 공 40개를 다 만들어 두므로 지어낸 말이 아니라 이번 판에 실제로 맞는 말이다. 끝내기 상황·연습은 공을 그때그때 만들어서 없다
const PROFILE_PITCHES = 16;
function pitcherProfile(seq) {
  const head = seq.slice(0, PROFILE_PITCHES), fast = head.filter((p) => p.type === 'fastball'), count = {};
  for (const p of head) if (p.type !== 'fastball') count[p.type] = (count[p.type] ?? 0) + 1;
  let main = null;
  for (const p of head) if (p.type !== 'fastball' && (main == null || count[p.type] > count[main])) main = p.type;
  return { top: fast.length ? Math.max(...fast.map((p) => p.kmh)) : null, main: main && PITCH_NAMES[main] };
}
// 투수판에 보이는 값. 투구수는 이미 던진 공 수(와인드업 중인 공은 빼고, 끝 화면은 마지막 공까지)다.
// 팀을 안 고른 사람도 투수는 상대 팀 옷을 입어서(pitcherColors) 상대 팀 이름을 그대로 쓴다
function pitcherCard() {
  const thrown = game.state === 'over' ? game.i + 1 : game.i, last = thrown > 0 ? game.seq[thrown - 1] : null, t = teamById(game.opponent);
  return {
    mode: game.mode, hand: (game.seq[game.i]?.lefty ?? game.throws === 'L') ? '좌완' : '우완', no: pitcherNo(game.seed), thrown,
    team: t && { short: t.short, main: t.main, accent: t.accent },
    last: last && { name: PITCH_NAMES[last.type], kmh: last.kmh },
    profile: game.mode === 'challenge' ? pitcherProfile(game.seq) : null,
  };
}
const pitcherRole = (c) => `${c.team ? c.team.short : '상대'} ${c.mode === 'scenario' ? '마무리' : '선발'}`;
// 전광판 그림(g)에 글자를 쓴다. 폭(maxW)을 넘으면 글자를 줄인다
function boardText(g, str, x, y, maxW, size, color = '#fff', weight = 800, align = 'center') {
  g.font = font(size, weight);
  const fit = Math.min(1, maxW / g.measureText(str).width);
  g.font = font(size * fit, weight); g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(str, x, y);
}
// 머리줄: 상대 팀 색 띠와 아래 보조색 줄(상대 팀이 없거나 연습이면 남색). 높이를 돌려준다
function boardHeader(g, W, H, c, str) {
  const hh = H * 0.24, t = c.mode !== 'practice' && c.team;
  g.fillStyle = t ? t.main : '#24314a'; g.fillRect(0, 0, W, hh);
  g.fillStyle = t ? t.accent : '#f2c94c'; g.fillRect(0, hh * 0.86, W, hh * 0.14);
  boardText(g, str, W / 2, hh * 0.45, W * 0.9, hh * 0.56, '#fff', 900);
  return hh;
}
// 투수판(폭 W·높이 H의 전광판 그림 g). 폰(390폭)에서 판은 111×88px라 줄은 3~4개, 글자는 10px 이상이다
function drawPitcherBoard(g, W, H, c) {
  if (c.mode === 'practice') { drawPracticeBoard(g, W, H, c); return; }
  if (c.thrown === 0) {   // 첫 공: 어떤 투수인지. 폰은 첫 공에 마운드 위 '우완 투수' 알림(drawPitcherTag)이 판 아래 4분의 1을 가려서 위쪽에 담는다
    boardHeader(g, W, H, c, `${pitcherRole(c)} ${c.no} · ${c.hand}`);
    const size = Math.max(10, H * 0.15);
    if (c.profile) {
      boardText(g, `직구 최고 ${c.profile.top}`, W / 2, H * 0.41, W * 0.92, size, LED_AMBER);
      boardText(g, `주무기 ${c.profile.main}`, W / 2, H * 0.6, W * 0.92, size, LED_AMBER);
    } else boardText(g, '9회말 등판', W / 2, H * 0.5, W * 0.92, size * 1.1, LED_AMBER);
    return;
  }
  // 그 뒤: 큰 등번호(앞에 작은 No.), 주무기(끝내기 상황은 투구수), 직전 공
  const hh = boardHeader(g, W, H, c, `${pitcherRole(c)} · ${c.hand}`), line = Math.max(10, H * 0.135);
  const big = H * 0.28, ny = hh + (H * 0.58 - hh) / 2 + H * 0.03, ps = Math.max(10, big * 0.38), no = String(c.no);
  g.font = font(big, 900); const nw = g.measureText(no).width;
  g.font = font(ps, 800); const pw = g.measureText('No.').width, x0 = W / 2 - (nw + pw + 3) / 2;
  boardText(g, 'No.', x0, ny + big * 0.12, pw + 1, ps, 'rgba(255,255,255,0.6)', 800, 'left');
  g.save(); g.shadowColor = 'rgba(255,255,255,0.5)'; g.shadowBlur = big * 0.25; boardText(g, no, x0 + pw + 3, ny, W, big, '#fff', 900, 'left'); g.restore();
  if (c.profile) boardText(g, `주무기 ${c.profile.main}`, W / 2, H * 0.7, W * 0.94, line, LED_AMBER);
  else boardText(g, `투구수 ${c.thrown}`, W / 2, H * 0.7, W * 0.94, line);
  boardText(g, `직전 ${c.last.name} ${c.last.kmh}`, W / 2, H * 0.86, W * 0.94, line);
}
// 연습: 직전 공 구속(7세그먼트)과 구종
function drawPracticeBoard(g, W, H, c) {
  const hh = boardHeader(g, W, H, c, `연습 · ${c.hand}`), line = Math.max(10, H * 0.135);
  if (!c.last) { boardText(g, '구속이 여기 떠요', W / 2, H * 0.48, W * 0.9, line, 'rgba(255,255,255,0.75)'); return; }
  const y = hh + (H * 0.76 - hh) / 2;
  seg7(g, String(c.last.kmh), W * 0.7, y, H * 0.32, LED_AMBER, 'right');
  boardText(g, 'km/h', W * 0.73, y + H * 0.07, W * 0.26, Math.max(10, line * 0.8), 'rgba(255,255,255,0.6)', 700, 'left');
  boardText(g, `직전 ${c.last.name}`, W / 2, H * 0.87, W * 0.9, line);
}
// 타구 정보(2026-11-03 유저 피드백 '타구 날아갈 때 전광판이 비어 있다', 사용자 결정 '타구 정보'): 맞는 순간 실제 구장 전광판처럼
// 타구 속도·발사각을 띄우고, 공이 날아가는(구르는) 동안 비거리가 올라간다. 결과가 정해지기 전에는 이것만 보여 줘서 세이프·아웃이 미리 드러나지 않는다
// (1루 간발). 안타·홈런은 결과가 정해지면 HIT·HOMERUN으로 넘어갔다가 돌아오고, 아웃·파울도 마지막 타구 정보를 남긴다. 결과 카드가 나오면
// (전광판 자리에 겹쳐 그린다) 글자가 읽히게 어둡게 남긴다(dim). 헛스윙·지켜본 공은 타구가 없어 투수판 그대로다
function ballInfo(r = game.outcome) {
  const T = flightDuration(r), final = Math.round(carryOf(r));
  const dist = game.flightT >= T ? final : Math.min(final, Math.round(flightPos(r, game.flightT).s));
  return { ev: r.ev, la: r.la, dist, dim: game.resultT >= game.revealAt && cardDetails() };
}
// 가운데 전광판이 지금 보여 주는 것: 'moment'(HIT·HOMERUN), 'ball'(타구 정보), 'pitcher'(투수판, 시작 화면·보정은 WALK OFF), null(꺼짐)
function scoreboardShows() {
  const bm = boardMoment();
  if (bm && game.resultT >= bm.t0 && game.resultT < bm.t1) return 'moment';
  if (game.state === 'result' && hasBattedBall() && game.replay == null) return 'ball';
  return ['windup', 'pitch', 'result', 'title', 'over', 'calib'].includes(game.state) ? 'pitcher' : null;
}
// 공이 날아가는 동안 전광판이 화면 밖(반 넘게)이면 같은 타구 정보를 위 점수판 아래 빈자리(결과 제목 자리)에 LED 한 줄로 띄운다.
// 폰은 시야가 좁아 카메라가 당긴·민 타구를 따라가면 가운데 전광판이 화면 밖으로 나간다. 결과 제목이 뜨면 그 자리를 내준다
function drawBallInfoLine() {
  if (scoreboardShows() !== 'ball' || game.resultT >= beatAt()) return;
  const R = scoreboardRect();
  if (R && (Math.min(view.w, R.x + R.w) - Math.max(0, R.x)) / R.w >= 0.5) return;
  const b = ballInfo(), T = resultTitleBox(), size = Math.min(16, T.size * 0.6), str = `타구 ${b.ev}km/h · ${b.la}° · ${b.dist}m`;
  ctx.font = font(size, 800);
  const w = ctx.measureText(str).width + size * 1.4, h = size * 1.7;
  roundRect(view.w / 2 - w / 2, T.y - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(5,7,13,0.78)'; ctx.fill();
  text(str, view.w / 2, T.y + 0.5, { size, weight: 800, color: LED_AMBER });
}
function drawBallBoard(g, W, H, b) {
  const hh = H * 0.24, line = Math.max(10, H * 0.135), y = hh + (H * 0.6 - hh) / 2;
  g.fillStyle = '#24314a'; g.fillRect(0, 0, W, hh);
  g.fillStyle = '#f2c94c'; g.fillRect(0, hh * 0.86, W, hh * 0.14);
  boardText(g, '타구 정보', W / 2, hh * 0.45, W * 0.9, hh * 0.56, '#fff', 900);
  seg7(g, String(b.ev), W * 0.66, y, H * 0.26, LED_AMBER, 'right');
  boardText(g, 'km/h', W * 0.69, y + H * 0.06, W * 0.29, Math.max(10, line * 0.8), 'rgba(255,255,255,0.6)', 700, 'left');
  boardText(g, `발사각 ${b.la}°`, W / 2, H * 0.73, W * 0.92, line);
  boardText(g, `비거리 ${b.dist}m`, W / 2, H * 0.88, W * 0.92, line, LED_AMBER);
}
function drawScoreboard() {
  const R = scoreboardRect();
  if (!R || R.w < 20) return;
  const pad = Math.max(1.5, R.w * 0.025);
  ctx.fillStyle = '#05070d'; ctx.fillRect(R.x - pad, R.y - pad, R.w + pad * 2, R.h + pad * 2);   // 틀
  ctx.fillStyle = '#0a101c'; ctx.fillRect(R.x, R.y, R.w, R.h);                                    // 화면
  ctx.strokeStyle = 'rgba(242,201,76,0.4)'; ctx.lineWidth = Math.max(1, pad * 0.4); ctx.strokeRect(R.x - pad * 0.5, R.y - pad * 0.5, R.w + pad, R.h + pad);
  const us = teamById(settings.team), bm = boardMoment(), shows = scoreboardShows();
  if (shows === 'moment') {   // HIT·HOMERUN: 우리 팀 색 바탕에 한 글자씩
    const u = game.resultT - bm.t0, main = us?.main ?? '#c2410c', alt = us?.accent && us.accent !== '#ffffff' ? us.accent : '#f2c94c', hr = bm.word === 'HOMERUN';
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    ctx.fillStyle = tint(main, hr ? 0.75 + 0.25 * Math.max(0, Math.sin(u * 10)) : 0.8); ctx.fillRect(R.x, R.y, R.w, R.h);
    const lines = hr ? ['HOME', 'RUN'] : ['HIT'], size = Math.min(R.h / (lines.length + 0.4), R.w / (Math.max(...lines.map((l) => l.length)) * 0.72));
    ctx.font = font(size, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let n = 0;
    lines.forEach((line, li) => {
      const step = size * 0.72, x0 = R.x + R.w / 2 - step * (line.length - 1) / 2, cy = R.y + R.h * (li + 0.5 + (lines.length === 1 ? 0 : 0.0)) / lines.length;
      [...line].forEach((ch, i) => {
        const k = clamp((u - n * 0.05) / 0.16, 0, 1), blink = Math.floor((u - n * 0.05) * 4) % 2 === 0; n++;   // 한 글자씩 튀어나와 깜빡인다
        if (k <= 0) return;
        const pop = 1 + 0.35 * Math.sin(k * Math.PI) * (1 - k);
        ctx.save(); ctx.translate(x0 + i * step, cy + Math.sin(u * 6 + n) * R.h * 0.02); ctx.scale(pop, pop);
        ctx.shadowColor = alt; ctx.shadowBlur = size * 0.4; ctx.fillStyle = hr && !blink ? alt : '#ffffff'; ctx.fillText(ch, 0, 0); ctx.restore();
      });
    });
    ctx.restore();
  } else if (shows) {   // 투수판(투구 중에는 움직이지 않는다)·타구 정보. 바뀔 때만 작은 캔버스에 그려 두고 붙인다(빛 번짐 그림자가 무거워서)
    const brand = shows === 'pitcher' && (game.state === 'title' || game.state === 'calib' || !game.seq.length), ball = shows === 'ball' ? ballInfo() : null, card = brand || ball ? null : pitcherCard();
    const key = [Math.round(R.w), Math.round(R.h), brand ? 'brand' : ball ? `ball|${ball.ev}|${ball.la}|${ball.dist}` : JSON.stringify(card)].join('|');
    if (scoreboardCache.key !== key) {
      const c = scoreboardCache.canvas ??= document.createElement('canvas'), dpr = Math.min(view.dpr || 1, 2), g = c.getContext('2d');
      c.width = Math.ceil(R.w * dpr); c.height = Math.ceil(R.h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.textBaseline = 'middle'; g.textAlign = 'center';
      if (brand) {
        const size = Math.min(R.h * 0.22, R.w / 5.2);
        g.font = font(size, 900); g.shadowColor = '#f2c94c'; g.shadowBlur = size * 0.5; g.fillStyle = '#f2c94c';
        g.fillText('WALK', R.w / 2, R.h * 0.36); g.fillText('OFF', R.w / 2, R.h * 0.64);
      } else if (ball) drawBallBoard(g, R.w, R.h, ball);
      else drawPitcherBoard(g, R.w, R.h, card);
      scoreboardCache.key = key;
    }
    ctx.drawImage(scoreboardCache.canvas, R.x, R.y, R.w, R.h);
    if (ball?.dim) { ctx.fillStyle = 'rgba(5,7,13,0.68)'; ctx.fillRect(R.x, R.y, R.w, R.h); }   // 결과 카드 글자가 읽히게
  }
  ctx.fillStyle = 'rgba(0,0,0,0.2)';   // LED 가로줄 무늬
  for (let yy = R.y + 1; yy < R.y + R.h; yy += Math.max(2, R.h / 22)) ctx.fillRect(R.x, yy, R.w, Math.max(0.6, R.h / 70));
}

// ===== 사람 그리기 공통 =====
// 굵기가 wa에서 wb로 변하는 마디(화면 좌표). 같은 색끼리는 관절이 이음매 없이 붙는다
function segment(a, b, wa, wb, color) {
  if (!a || !b) return;
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x + nx * wa / 2, a.y + ny * wa / 2); ctx.lineTo(b.x + nx * wb / 2, b.y + ny * wb / 2);
  ctx.lineTo(b.x - nx * wb / 2, b.y - ny * wb / 2); ctx.lineTo(a.x - nx * wa / 2, a.y - ny * wa / 2);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(a.x, a.y, wa / 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(b.x, b.y, wb / 2, 0, Math.PI * 2); ctx.fill();
}

// 점들을 부드럽게 이은 닫힌 경로. 점이 모자라면 false
function smoothPath(pts) {
  pts = pts.filter(Boolean);
  if (pts.length < 3) return false;
  const n = pts.length, mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const m0 = mid(pts[n - 1], pts[0]);
  ctx.beginPath(); ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) { const m = mid(pts[i], pts[(i + 1) % n]); ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y); }
  ctx.closePath();
  return true;
}

// 점들을 부드럽게 이은 닫힌 도형

function ellipseAt(p, rx, ry, color) {
  if (!p) return;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); ctx.fill();
}

// 화면 점들을 감싸는 볼록 다각형. 돌아가는 몸통의 윤곽을 만든다
function hull(pts) {
  const p = pts.filter(Boolean).sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ===== 투수 그리기(투구 동작과 뼈대는 sim/pose.js) =====
const PITCHER_COLOR = { jersey: '#f4f5f9', shade: '#c9cfdb', pants: '#e7e9ef', navy: '#1d2f5c', brim: '#15244a', skin: '#dcae88', glove: '#8a5a2b', pocket: '#6b4320', shoe: '#14161b' };

// 투수: 타자와 같은 3D 인형(drawBatterFigure)으로 그린다. 깊이대로 팔다리를 그려서 공 쥔 팔이 몸 뒤로 돌 때 몸에 가려진다.
// 흰 유니폼에 상대 팀 색 모자·언더셔츠·스타킹, 글러브 손에는 큰 글러브, 공 쥔 손은 맨손이고 공을 쥐고 있으면 공도 그린다
function drawPitcher(t, holdingBall, lefty) {
  const k = pitcherSkeleton(t, lefty), C = pitcherColors();
  const base = project(k.pelvis[0], 0.25, k.pelvis[2] + 0.1);
  if (base) ellipseAt(base, 0.6 * base.s, 0.13 * base.s, 'rgba(0,0,0,0.3)');
  const pal = { jersey: C.jersey, shade: C.shade, pants: C.pants, pantsShade: C.shade, accent: C.navy, helmet: C.navy, brim: C.brim, belt: C.navy,
    skin: C.skin, shoe: C.shoe, glove: C.glove, pocket: C.pocket, sleeve: C.navy };
  if (holdingBall) k.ball = k.ballHand;
  drawBatterFigure(k, (name) => pal[name], 0);
}

// 판의 첫 공이나 투수 손이 바뀐 공의 와인드업 동안 투수 머리 위에 던지는 손을 적는다
function drawPitcherTag(p) {
  const q = project(0, 2.55, MOUND);
  if (!q) return;
  const hard = hardMatchup(p);
  pill(`${p.lefty ? '좌완' : '우완'} 투수${hard ? ' · 좌타자에게는 공이 늦게 보여요' : ''}`, q.x, q.y,
    { size: view.mobile ? 11 : 13, bg: hard ? 'rgba(200,40,40,0.75)' : 'rgba(0,0,0,0.5)' });
}

// ===== 수비 그리기 =====
// 누가 언제 어디서 무엇을 하는지(수비 일정)와 그때 자세는 sim/fielding.js가 정한다
// 지금 공을 따라가는 수비. 공을 안 쳤거나(볼·헛스윙) 다시 보기 중이면 없음
const liveOutcome = () => (game.state === 'result' && hasBattedBall() && game.replay == null ? game.outcome : null);
const fieldersNow = () => fieldersAt(liveOutcome(), game.flightT);

// 수비수 그리기(투수가 수비에 끼면 투수도, 1.5m 넘게 간 주자도 같은 목록에서 먼 것부터). 수비수는 테두리 없이 한 번만 그린다(폰 성능)
function defenseColors() {
  const C = pitcherColors();
  return { jersey: C.jersey, shade: C.shade, pants: C.pants, pantsShade: C.shade, accent: C.navy, helmet: C.navy, brim: C.brim, belt: C.navy,
    skin: C.skin, shoe: C.shoe, glove: C.glove, pocket: C.pocket, sleeve: C.navy };
}
function drawDefense(time, runners, idlePitcher) {
  const r = liveOutcome(), play = r ? fieldPlay(r) : null, t = game.flightT, pal = defenseColors(), list = [];
  for (const f of DEFENSE) {
    if (f === PITCHER_F && !pitcherFielding(play, t)) { list.push({ z: MOUND, draw: idlePitcher }); continue; }
    const spot = play ? actorState(play, f, t).spot : homeOf(f);
    list.push({ z: spot[1], draw: () => {
      const k = actorSkeleton(play, f, t), base = project(spot[0], 0, spot[1]);
      if (base) ellipseAt(base, 0.32 * base.s, 0.07 * base.s, 'rgba(0,0,0,0.25)');
      drawBatterFigure(k, (name) => pal[name], 0);
    } });
  }
  if (play?.acts[CATCHER_F.pos] && t > Math.max(0.8, (play.ev.arrive ?? 0) - 1.0)) {   // 끝내기 홈 승부의 포수: 공이 닿기 1초 전부터(카메라 바로 앞이라 일찍 나오면 화면을 가린다)
    const spot = actorState(play, CATCHER_F, t).spot;
    list.push({ z: spot[1], draw: () => {
      const k = actorSkeleton(play, CATCHER_F, t), base = project(spot[0], 0, spot[1]);
      if (base) ellipseAt(base, 0.32 * base.s, 0.07 * base.s, 'rgba(0,0,0,0.25)');
      drawBatterFigure(k, (name) => pal[name], 0);
    } });
  }
  for (const run of runners) list.push({ z: run.z, draw: () => drawRunner(run) });
  list.sort((a, b) => b.z - a.z).forEach((q) => q.draw());
}

// ===== 스트라이크 존과 공 =====
// 판정한 자리(2026-10-30 사용자 제보 '커브·포크가 존에 걸치는데 볼'). 판정은 공이 홈플레이트 앞면을 지나는 순간인데, 떨어지는 공은
// 마지막 한 장면(약 0.02초)에 4~5cm씩 떨어져서 바로 앞 장면에서는 존 안에 보이다가 빠진다(존 밖 포크의 78%, 커브·체인지업의 65%쯤이
// 판정 직전 두 장면에서 존과 겹쳐 보였다). 공이 그 면을 지난 뒤로 그 자리에 공 크기 동그라미를 남기고, 존 밖이면 노랗게 칠하고 몇 cm 빠졌는지 적는다
function drawPitchMark(p) {
  if (camMoved()) return;   // 홈플레이트 위라 따라가는 카메라 뒤로 넘어간다
  const c = project(p.tx, p.ty, 0);
  if (!c) return;
  const r = BALL_R * c.s, out = zoneMiss(p) > 0;
  ctx.save();
  ctx.lineWidth = Math.max(2, r * 0.2);
  ctx.strokeStyle = out ? '#facc15' : 'rgba(255,255,255,0.9)';
  ctx.fillStyle = out ? 'rgba(250,204,21,0.2)' : 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
  if (out) { const o = zoneOff(p); text(`${o.dir} ${o.cm}cm`, c.x + r + 6, c.y, { size: view.mobile ? 12 : 14, weight: 800, color: '#facc15', align: 'left', shadow: true }); }
}

function drawZone(alpha) {
  // 따라가는 카메라가 움직이기 시작하면 CHASE.zoneFade m에 걸쳐 흐려진다(홈플레이트 위라 카메라 뒤로 넘어간다). 전에는 0.3m에서 한 장면에 꺼졌다
  const fade = 1 - clamp(camOffset() / CHASE.zoneFade, 0, 1);
  if (fade <= 0) return;
  alpha *= fade;
  const tl = project(ZONE.left, ZONE.top, 0), br = project(ZONE.right, ZONE.bottom, 0);
  if (!tl || !br) return;
  const w = br.x - tl.x, h = br.y - tl.y;
  ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`; ctx.lineWidth = 2;
  ctx.strokeRect(tl.x, tl.y, w, h);
  ctx.strokeStyle = `rgba(255,255,255,${0.16 * alpha})`; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(tl.x + w * i / 3, tl.y); ctx.lineTo(tl.x + w * i / 3, br.y);
    ctx.moveTo(tl.x, tl.y + h * i / 3); ctx.lineTo(br.x, tl.y + h * i / 3);
  }
  ctx.stroke();
}

// 공 회전(2026-10-30 유저 목소리 '커브가 무회전으로 온다'). 전에는 빨간 호 두 개를 화면 안에서 돌려서(바람개비) 커브의 앞회전으로
// 보이지 않았고, 폰에서는 공이 작아(반지름 3.5px 아래) 날아오는 처음 40%쯤 실밥이 안 보였다. 이제 실밥을 공 위의 3D 곡선으로 두고
// 구종마다 실제 회전축대로 돌린다. 축은 화면 기준(x 오른쪽, y 위, z 카메라 쪽, 우투수 기준)이고 w는 오른손 법칙 방향의 라디안/초다.
// 실제 회전(초당 200라디안 이상)은 60fps 화면에서 오히려 멈춰 보여서 한 장면에 0.25~0.4라디안쯤 돌게 줄였다
const SPIN = {
  fastball: { axis: [-0.94, -0.34, 0], w: 22 },   // 백스핀: 앞면이 위로, 조금 팔 쪽(화면 왼쪽)으로
  slider:   { axis: [0.3, -0.2, 0.93], w: 20 },   // 자이로: 축이 타자 쪽이라 가운데를 두고 돈다
  curve:    { axis: [0.97, 0.24, 0], w: 24 },     // 앞회전: 앞면이 아래로 굴러 떨어진다
  change:   { axis: [-0.8, -0.6, 0], w: 14 },     // 느린 백스핀, 팔 쪽으로 더 기울었다
  fork:     { axis: [1, 0.2, 0], w: 2.5 },        // 거의 안 돈다
};
// 야구공 실밥: 단위 구 위의 닫힌 곡선 (a cos t + b cos 3t, a sin t − b sin 3t, 2√(ab) sin 2t), a + b = 1이면 구 위에 놓인다
const SEAM = Array.from({ length: 64 }, (_, i) => {
  const t = i / 64 * Math.PI * 2, a = 0.7, b = 0.3;
  return [a * Math.cos(t) + b * Math.cos(3 * t), a * Math.sin(t) - b * Math.sin(3 * t), 2 * Math.sqrt(a * b) * Math.sin(2 * t)];
});
// v를 단위 축 k 둘레로 th만큼 돌린다(로드리게스 공식)
function rotateAbout(v, k, th) {
  const c = Math.cos(th), sn = Math.sin(th), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + cr[i] * sn + k[i] * d * (1 - c));
}
// 회전 상태 spin = { type, n, t, lefty }의 실밥 점들(화면 기준 단위 구). 공마다 처음 방향을 공 번호로 다르게 두고,
// 좌완은 거울로 뒤집는다(축의 x 성분과 회전 방향이 반대라 커브는 좌완도 앞회전이다). spin이 없으면(맞은 공·송구) 고정 방향
// 친 공의 회전(2026-11-02 사용자 '따라가는 공이 너무 정지해 있다'). 전에는 맞은 공을 실밥 고정으로 그렸다. 뜬공·홈런·직선타는 백스핀(윗면이 홈 쪽으로),
// 땅볼은 앞회전이고, 축은 날아가는 방향에 수평으로 직각이다(화면 기준 축, 투구처럼 60fps에서 읽히게 줄인 빠르기)
function battedSpin(r, t) {
  const a = clamp(r.spray ?? 0, -FAIR_SPRAY, FAIR_SPRAY) * DEG;
  return { axis: [Math.cos(a), 0, Math.sin(a)], w: r.type === 'ground' ? -18 : r.type === 'line' ? 16 : 22, t, n: game.i };
}
function seamPoints(spin, ahead = 0) {
  const def = spin ? (spin.axis ? spin : SPIN[spin.type] ?? SPIN.fastball) : null;
  const phase = spin ? ((spin.n ?? 0) * 2.399) % (Math.PI * 2) : 0.6;
  const pre = SEAM.map((v) => rotateAbout(v, [0.6, 0.8, 0], phase));   // 처음 방향
  if (!def) return pre;
  const len = Math.hypot(...def.axis), k = def.axis.map((x) => x / len), m = spin.lefty ? -1 : 1;
  const axis = [k[0] * m, k[1], k[2]], th = (def.w * spin.t + ahead) * m;
  return pre.map((v) => rotateAbout(v, axis, th));
}
// 실밥 그리기: 카메라 쪽(z > 0) 조각만, 가장자리로 갈수록 옅게
function drawSeam(c, r, pts, lw, alpha) {
  ctx.lineWidth = lw; ctx.lineCap = 'round';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a[2] <= 0 || b[2] <= 0) continue;
    ctx.strokeStyle = `rgba(210,59,59,${(alpha * (0.35 + 0.65 * (a[2] + b[2]) / 2)).toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(c.x + a[0] * r, c.y - a[1] * r); ctx.lineTo(c.x + b[0] * r, c.y - b[1] * r); ctx.stroke();
  }
}

function drawBall(pos, { alpha = 1, spin = null, scale = 1.5, shadow = true, glow = false } = {}) {
  const p = project(pos.x, pos.y, pos.z);
  if (!p) return;
  const chase = glow && camMoved();
  // 따라가는 카메라: 친 공을 실제 크기의 1.2배로, 멀어도 화면 높이의 0.6%보다는 크게 그리고 빛번짐도 줄인다(타석 시점처럼 2배로 그리면 공 뒤 8m에서
  // 지름이 20px을 넘어 너무 컸고, 실제 크기면 20m만 떨어져도 점이라 멀어 보였다)
  const r = chase ? Math.max(BALL_R * 1.2 * p.s, view.h * CHASE.ballMin) : Math.max(glow ? 2.5 : 1.6, BALL_R * scale * p.s), halo = chase ? 2.5 : 4;
  if (shadow && pos.y > 0.05) {
    const sp = project(pos.x, 0, pos.z);
    if (sp) {
      ctx.fillStyle = `rgba(0,0,0,${0.28 * alpha})`;
      ctx.beginPath(); ctx.ellipse(sp.x, sp.y, r * 1.1, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  if (glow) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * halo);
    g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * halo, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#fbfaf5';
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  if (r > 2.2) {   // 둥글게 보이도록 위쪽은 밝고 가장자리는 조금 어둡게
    const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#dedad0'); ctx.fillStyle = g;
  }
  ctx.fill();
  if (r > 2.2) {   // 폰에서는 공이 작아서 전에는 3.5px부터라 처음 40%쯤 실밥이 안 보였다
    ctx.clip();
    const lw = Math.max(1, r * 0.13);
    if (spin) {   // 바로 앞 두 장면의 실밥을 옅게 겹쳐 빠르게 도는 느낌을 준다
      const step = (spin.w ?? SPIN[spin.type]?.w ?? 0) / 60;
      drawSeam(p, r, seamPoints(spin, -2 * step), lw, 0.18);
      drawSeam(p, r, seamPoints(spin, -step), lw, 0.32);
    }
    drawSeam(p, r, seamPoints(spin), lw, 1);
  }
  ctx.restore();
}

// 다시 보기: 점은 실제 궤적, 점선은 휘지 않았다면 갔을 길
function drawTrail(p, uEnd) {
  const def = PITCHES[p.type];
  const hs = p.lefty ? -1 : 1, a = project(RELEASE.x * hs, RELEASE.y, RELEASE.z), b = project(p.tx - def.brk.x * hs, p.ty - def.brk.y, 0);
  if (a && b && p.type !== 'fastball') {
    ctx.save(); ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
  }
  ctx.fillStyle = PITCH_COLORS[p.type];
  for (let u = 0.03; u <= uEnd + 1e-6; u += 0.035) {
    const q = ballPos(p, u), s = project(q.x, q.y, q.z);
    if (!s) continue;
    ctx.globalAlpha = 0.3 + 0.6 * u;
    ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(1.4, BALL_R * 0.7 * s.s), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ===== 타자와 배트 =====
const BAT_LEN = 0.86, SWING_TIME = 0.28;
// 모바일(세로 화면)은 가로가 좁아 타자(홈플레이트에서 1m 옆)가 화면 밖으로 나갔다(2026-10-29, 390폭에서 거의 안 보임).
// 타자 그림만 홈플레이트 쪽으로 0.4m 당기고, 장면 전체를 타자 반대쪽으로 화면 폭의 5% 밀고, 조금 넓게 본다.
// 판정은 타이밍만 봐서 그림에만 영향이 있다. PC와 가로 화면은 그대로
const MOBILE_BATTER_SHIFT = 0.4, MOBILE_SCENE_SHIFT = 0.05, MOBILE_FOV_W = 2.15;
const batterShift = () => (view.mobile ? MOBILE_BATTER_SHIFT : 0);
const sceneShift = () => (view.mobile ? batSide() * view.w * MOBILE_SCENE_SHIFT : 0);
const batterPoint = (p) => project(batSide() * (p[0] + batterShift()), p[1], p[2]);   // 타자 뼈대의 한 점을 화면으로
function batterSpan() {   // 테스트용: 칠 준비 자세의 몸(머리·손·무릎·발)이 화면에서 차지하는 가로 범위
  const k = batterSkeleton(null), xs = [k.head, k.hand, k.knees.l, k.knees.r, k.feet.l, k.feet.r, k.chest].map((p) => batterPoint(p).x);
  return { min: Math.min(...xs), max: Math.max(...xs), w: view.w };
}

// tau: 스윙 뒤 지난 시간(초), null이면 준비 자세. 누른 순간을 맞는 순간으로 보여 준다
// yaw는 배트 끝 방향(도): -90 포수 쪽, 0 1루 쪽(플레이트 위), 90 투수 쪽
// pre는 준비 자세의 움직임(2026-11-02 사용자 요청 '타격을 더 부드럽고 자연스럽게', 전에는 공을 기다리는 동안 굳어 있었다):
// idle(초)로 기다리는 동안 방망이를 1초에 0.7번 살짝 까딱이고, load(0~1)만큼 손을 포수 쪽으로 조금 높게 당긴다
function batPose(tau, pre = null) {
  let yaw, pitch, hand;
  if (tau == null) {
    const L = pre?.load ?? 0, w = pre ? (1 - L) * Math.sin(pre.idle * 4.4) : 0, w2 = pre ? (1 - L) * Math.sin(pre.idle * 4.4 + 1.2) : 0;
    yaw = -100 - 12 * L + 6 * w; pitch = 55 + 7 * L + 4 * w2;
    hand = [-0.84, 1.48 + 0.04 * L + 0.01 * w2, 0.04 - 0.1 * L];
  } else {
    const e = easeOut(tau / SWING_TIME), f = smooth((tau - SWING_TIME) / 0.4);   // 휘두른 뒤 0.4초 동안 힘을 빼며 마무리한다
    yaw = lerp(5, 195, e) + 10 * f; pitch = lerp(-8, 45, e) - 6 * f;
    hand = [lerp(-0.5, -1.0, e), lerp(1.02, 1.62, e) - 0.07 * f, lerp(0.3, 0.44, e)];   // 끝에는 손이 앞어깨(왼쪽) 위로 가고 방망이는 어깨 너머로 넘어간다
  }
  const c = Math.cos(pitch * DEG);
  const tip = [hand[0] + BAT_LEN * c * Math.cos(yaw * DEG), hand[1] + BAT_LEN * Math.sin(pitch * DEG), hand[2] + BAT_LEN * c * Math.sin(yaw * DEG)];
  return { hand, tip, yaw };
}

const BATTER_COLOR = {
  jersey: '#8b93a6', shade: '#6c7487', pants: '#a0a7b7', pantsShade: '#7f8696', accent: '#74182a', helmet: '#74182a', belt: '#1b1d24',
  skin: '#c18f69', shoe: '#121418', glove: '#e9e9ec', bat: '#c8955a', batEnd: '#8a5e32', sleeve: '#596173',
};

// ===== 팀 =====
// KBO 10개 구단(2026-10-28 사용자 결정). 구단 이름은 상표라서 로고·엠블럼은 쓰지 않고, 팀 고르기·랭킹 화면에
// "KBO·각 구단과 관계없는 비공식 팬 게임"이라고 적는다. 색은 공식 색상 코드가 아니라 대표 색에 가깝게 고른 값이다.
// id와 순서는 core/catalog.js의 TEAM_IDS(랭킹 서버와 같이 쓴다). main은 상의·헬멧(소매는 main을 어둡게), accent는 양말 색이다
const TEAM_LOOKS = {
  kia: { name: 'KIA 타이거즈', short: 'KIA', main: '#ea0029', accent: '#0b1c2c' },
  kt: { name: 'KT 위즈', short: 'KT', main: '#1b1b1b', accent: '#eb1c24' },
  lg: { name: 'LG 트윈스', short: 'LG', main: '#a50034', accent: '#1b1b1b' },
  nc: { name: 'NC 다이노스', short: 'NC', main: '#315288', accent: '#c7a079' },
  ssg: { name: 'SSG 랜더스', short: 'SSG', main: '#ce0e2d', accent: '#ffb81c' },
  doosan: { name: '두산 베어스', short: '두산', main: '#131230', accent: '#f4f5f9' },
  lotte: { name: '롯데 자이언츠', short: '롯데', main: '#041e42', accent: '#d00f31' },
  samsung: { name: '삼성 라이온즈', short: '삼성', main: '#074ca1', accent: '#f4f5f9' },
  kiwoom: { name: '키움 히어로즈', short: '키움', main: '#820024', accent: '#f4f5f9' },
  hanwha: { name: '한화 이글스', short: '한화', main: '#ff6600', accent: '#1b1b1b' },
};
const TEAMS = TEAM_IDS.map((id) => ({ id, ...TEAM_LOOKS[id] }));
const teamById = (id) => TEAMS.find((t) => t.id === id) ?? null;

// 상대 팀은 내 팀이 아닌 팀 가운데서 판마다 고른다. 공 순서와 다른 난수를 써서 순서는 그대로 둔다
function pickOpponent(seed) {
  const others = TEAMS.filter((t) => t.id !== settings.team);
  return others[Math.floor(mulberry32((seed ^ 0x51ed270b) >>> 0)() * others.length)].id;
}
// 끝내기 상황 점수판의 [원정, 홈] 이름. 팀을 안 골랐으면 원정·홈이라고 쓴다
const sideNames = () => [teamById(game.opponent)?.short ?? '원정', teamById(settings.team)?.short ?? '홈'];

// '#rrggbb'의 밝기를 k배로(1보다 작으면 어둡게)
function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `#${[16, 8, 0].map((s) => clamp(Math.round(((n >> s) & 255) * k), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}
const hexAlpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };   // '#a50034' → 투명도 a

// 타자는 팀 색 유니폼을 입는다. 조명을 등지고 있어서 상의는 조금 어둡게 칠한다.
// 팀을 고르는 화면에서는 고르는 중인 팀을 미리 입혀 보여 준다
const paletteCache = {};
// 그 위에 상점에서 산 유니폼 스타일과 배트·헬멧·장갑·신발 색을 덮는다(상점에서 고르는 중이면 그 물건을 미리 입힌다)
function batterColors() {
  const t = teamById(lookOverride ? lookOverride.team : game.state === 'onboard' && game.onboard?.team ? game.onboard.team : settings.team), look = currentLook();
  const key = `b-${t?.id ?? '-'}-${look.bat}-${look.helmet}-${look.glove}-${look.shoe}-${look.uniform}`;
  if (paletteCache[key]) return paletteCache[key];
  const base = t ? { ...BATTER_COLOR, jersey: tint(t.main, 0.9), shade: tint(t.main, 0.7), helmet: tint(t.main, 0.75), accent: t.accent, sleeve: tint(t.main, 0.6), pants: '#b4b9c4', pantsShade: '#8f949f' } : BATTER_COLOR;
  return (paletteCache[key] = lookPalette(base, t, look));
}

// 투수는 흰 유니폼에 상대 팀 색(모자, 소매, 스타킹, 번호)을 입는다
function pitcherColors() {
  const t = teamById(game.opponent);
  if (!t) return PITCHER_COLOR;
  return (paletteCache[`p-${t.id}`] ??= { ...PITCHER_COLOR, navy: tint(t.main, 0.85), brim: tint(t.main, 0.65) });
}

// 타자 뼈대(3D). 준비 자세에서는 어깨가 투수 쪽으로 닫혀 있고, 스윙하면 엉덩이가 먼저, 어깨가 뒤따라 돈다
// pre.load만큼 어깨·엉덩이를 포수 쪽으로 감고 앞발을 들었다 투수 쪽으로 12cm 내디딘다. 휘두를 때는 이미 내디딘 발이다
function batterSkeleton(tau, pre = null) {
  const swinging = tau != null, e = swinging ? easeOut(tau / SWING_TIME) : 0, st = swinging ? 1 : smooth(pre?.load ?? 0);
  const shTurn = swinging ? lerp(55, 105, e) : -10 * st, hipTurn = swinging ? lerp(65, 88, e) : -6 * st;
  const at = (x, y, z) => [BATTER_X + x, y, BATTER_Z + z];
  const left = (deg) => [-Math.sin(deg * DEG), 0, Math.cos(deg * DEG)];    // 타자의 왼쪽(처음엔 투수 쪽)
  const facing = (deg) => [Math.cos(deg * DEG), 0, Math.sin(deg * DEG)];   // 가슴이 보는 쪽(처음엔 홈플레이트)
  const sink = swinging ? 0 : 0.03 * st, pelvis = at(-0.02 + 0.05 * e, 0.86 - sink, 0), chest = at(0.06 + 0.05 * e, 1.38 - sink, 0);
  const hips = { l: V.add(pelvis, V.mul(left(hipTurn), 0.12)), r: V.add(pelvis, V.mul(left(hipTurn), -0.12)) };
  const shoulders = { l: V.add(chest, V.mul(left(shTurn), 0.2)), r: V.add(chest, V.mul(left(shTurn), -0.2)) };
  const feet = { l: at(0.03, 0.06 + (swinging ? 0 : 0.09 * Math.sin(Math.PI * st)), 0.4 + 0.12 * st), r: at(-0.06 + 0.08 * e, 0.06 + 0.1 * e, -0.36) };   // 스윙하면 뒷발 뒤꿈치가 들린다
  const knees = { l: bendJoint(hips.l, feet.l, 0.46, 0.45, [1, 0, 0]), r: bendJoint(hips.r, feet.r, 0.46, 0.45, [1, 0, 0]) };
  const { hand, tip, yaw } = batPose(tau, pre);
  // 팔꿈치가 굽는 쪽. 준비·맞는 순간에는 뒷팔 팔꿈치가 아래·뒤(포수 쪽)이고, 팔로스루에서는 두 팔이 몸 앞으로 감겨 등 뒤에서는 가려진다.
  // 전에는 끝까지 뒤로 꺾여서 아래팔이 등을 가로질러 보였다(2026-10-29 사용자 제보)
  const pole = (a, b) => V.add(V.mul(a, 1 - e), V.mul(b, e));
  const elbows = { r: bendJoint(shoulders.r, hand, 0.3, 0.29, pole([-0.3, -0.7, -0.6], [0.3, -0.5, 1])), l: bendJoint(shoulders.l, hand, 0.3, 0.29, pole([0.3, -1, 0.3], [-0.9, 0.4, 0.5])) };
  return { e, shTurn, hipTurn, pelvis, chest, hips, shoulders, feet, knees, elbows, hand, tip, yaw, left, facing, head: V.add(chest, [0.04, 0.24, 0.02]) };
}

// ===== 상점 물건의 모양과 효과 =====
// 색만 바꾸는 물건은 팔레트(lookPalette)로 칠하고, fx가 있는 물건(2026-10-30 더함: 불꽃 배트, 동물 헬멧·신발 등)은 여기서 모양과 효과를 그린다.
// 타자는 빛 테두리 색으로 한 번, 제 색으로 한 번 그리므로 테두리 차례(detail false)에는 윤곽만 그리고 무늬·효과는 건너뛴다.
// 상점 칸의 견본 그림도 같은 함수로 그린다
const fxOf = (id) => shopItem(id)?.fx ?? null;
const fxTime = () => performance.now() / 1000;
function gradientAlong(a, b, stops) {
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);   // 두 점이 같으면 아무것도 칠하지 않아서 부르는 쪽이 길이를 본다
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}
function drawSparkle(p, r, color) {   // 네 갈래 반짝임
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, rr = i % 2 ? r * 0.28 : r; ctx[i ? 'lineTo' : 'moveTo'](p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill();
}
function drawStar(x, y, r, rot, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = rot + i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill();
}
function drawHeart(x, y, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.3, y - r * 0.1, x - r * 0.7, y - r * 1.1, x, y - r * 0.4);
  ctx.bezierCurveTo(x + r * 0.7, y - r * 1.1, x + r * 1.3, y - r * 0.1, x, y + r * 0.9);
  ctx.fill();
}

// 불꽃: 배트 둘레로 혀 모양 불길이 양옆으로 번갈아 흔들리며 솟고(불은 늘 위로 탄다), 불티가 날린다.
// 처음에는 곧장 위로만 솟게 했더니 배트를 세운 준비 자세에서 불길이 배트를 따라 겹쳐 톱니처럼 보였다
function drawFlames(a, b, wa, wb, t) {
  const n = 9, at = (u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(wa, wb, u) });
  segment(at(0.25), b, wa * 2.6, wb * 2.8, 'rgba(255,110,30,0.16)');   // 달아오른 빛
  for (const [color, hk, wk] of [['rgba(255,70,20,0.85)', 1, 1], ['rgba(255,160,40,0.92)', 0.68, 0.66], ['rgba(255,240,170,0.95)', 0.38, 0.38]]) {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const p = at(0.25 + 0.75 * (i + 0.5) / n), fl = 0.75 + 0.2 * Math.sin(t * 17 + i * 2.1) + 0.1 * Math.sin(t * 31 + i * 5.3);
      const lean = (i % 2 ? 0.6 : -0.6) + 0.15 * Math.sin(t * 7 + i), vl = Math.hypot(lean, 1), v = { x: lean / vl, y: -1 / vl }, q = { x: -v.y, y: v.x };   // 솟는 쪽과 그 옆
      const h = p.w * (2 + 0.5 * (i % 3)) * fl * hk, bw = p.w * 0.6 * wk, sway = Math.sin(t * 9 + i * 1.7) * p.w * 0.35;
      const tip = { x: p.x + v.x * h + q.x * sway, y: p.y + v.y * h + q.y * sway };
      ctx.beginPath(); ctx.moveTo(p.x - q.x * bw, p.y - q.y * bw);
      ctx.quadraticCurveTo(p.x - q.x * bw * 0.9 + v.x * h * 0.55, p.y - q.y * bw * 0.9 + v.y * h * 0.55, tip.x, tip.y);
      ctx.quadraticCurveTo(p.x + q.x * bw * 0.9 + v.x * h * 0.55, p.y + q.y * bw * 0.9 + v.y * h * 0.55, p.x + q.x * bw, p.y + q.y * bw);
      ctx.closePath(); ctx.fill();
    }
  }
  for (let i = 0; i < 4; i++) {   // 불티: 위로 날아가며 사라진다
    const u = (t * 0.9 + i * 0.27) % 1, p = at(0.4 + 0.15 * i);
    ellipseAt({ x: p.x + Math.sin(t * 5 + i) * p.w * 0.6, y: p.y - p.w * (1.2 + 3 * u) }, p.w * 0.1 * (1 - u) + 0.6, p.w * 0.1 * (1 - u) + 0.6, `rgba(255,200,90,${(0.9 * (1 - u)).toFixed(2)})`);
  }
}
// 번개: 몸통 둘레로 지지직 튀는 전기. 0.07초마다 모양이 바뀐다
function drawSparks(a, b, w, t) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }, rnd = mulberry32(Math.floor(t * 14) + 101);
  const at = (u, off) => ({ x: lerp(a.x, b.x, u) + n.x * off, y: lerp(a.y, b.y, u) + n.y * off });
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let k = 0; k < 3; k++) {
    const u0 = 0.3 + rnd() * 0.55, span = 0.12 + rnd() * 0.15, pts = [];
    for (let i = 0; i <= 4; i++) pts.push(at(Math.min(1, u0 + span * i / 4), (rnd() - 0.5) * w * 2.2));
    for (const [lw, c] of [[Math.max(2, w * 0.22), 'rgba(120,200,255,0.85)'], [Math.max(1, w * 0.08), '#ffffff']]) {
      ctx.strokeStyle = c; ctx.lineWidth = lw;
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    }
  }
  ctx.restore();
}

// a에서 b로 반지름이 ra에서 rb로 변하는 캡슐 경로. 한 경로라 반투명·더하기 합성으로 칠해도 이음매가 겹쳐 진해지지 않는다(segment는 원 두 개를 따로 칠한다)
function capsulePath(a, b, ra, rb) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), q = Math.PI / 2;
  ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(0.3, rb), ang - q, ang + q); ctx.arc(a.x, a.y, Math.max(0.3, ra), ang + q, ang + 3 * q); ctx.closePath();
}
// 고가 배트 둘(2026-11-03 사용자 '고가로 퀄리티 있게')은 굵기를 미터로 정하고 손(sa)·끝(sb) 자리의 원근대로 바꾼다(1m가 몇 px인지는 wa·wb에서 거꾸로 구한다).
// up은 배트에 수직인 두 방향 중 화면 위쪽(빛이 오는 쪽)
function batFrame(a, b, wa, wb) {
  const len = Math.hypot(b.x - a.x, b.y - a.y), d = len > 0.5 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 0, y: -1 };
  const up = d.x >= 0 ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x }, sa = wa / 0.034, sb = wb / 0.068;
  return { d, up, sa, sb, at: (u, off = 0) => { const s = lerp(sa, sb, u); return { x: lerp(a.x, b.x, u) + up.x * off * s, y: lerp(a.y, b.y, u) + up.y * off * s, s }; } };
}
// e에서 b까지 빛 막대의 부드러운 번짐. stops는 [가장자리(0)에서 가운데(1)로, 밝기] 목록. 몸통은 가로 그러데이션 사각형, 두 끝은 같은 번짐의 반원이라
// 이음매가 없다. 반투명 캡슐을 여러 겹 쌓으면 겹의 경계가 계단처럼 보여서 이렇게 칠한다
function glowRod(e, b, R, rgb, peak, stops) {
  const len = Math.hypot(b.x - e.x, b.y - e.y) || 1, d = { x: (b.x - e.x) / len, y: (b.y - e.y) / len }, n = { x: -d.y * R, y: d.x * R };
  const c = (k) => `rgba(${rgb},${Math.min(1, peak * k).toFixed(3)})`;
  const g = ctx.createLinearGradient(e.x + n.x, e.y + n.y, e.x - n.x, e.y - n.y);
  for (const [o, k] of stops) { g.addColorStop(o / 2, c(k)); g.addColorStop(1 - o / 2, c(k)); }
  ctx.fillStyle = g; ctx.beginPath();
  ctx.moveTo(e.x + n.x, e.y + n.y); ctx.lineTo(b.x + n.x, b.y + n.y); ctx.lineTo(b.x - n.x, b.y - n.y); ctx.lineTo(e.x - n.x, e.y - n.y); ctx.closePath(); ctx.fill();
  for (const [p, k] of [[b, 1], [e, -1]]) {
    const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R), ang = Math.atan2(d.y * k, d.x * k);
    for (const [o, v] of stops) rg.addColorStop(1 - o, c(v));
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(p.x, p.y, R, ang - Math.PI / 2, ang + Math.PI / 2); ctx.closePath(); ctx.fill();
  }
}
// 광선 배트(5,000코인): 손 쪽 25%는 고리 홈이 파인 어두운 금속 손잡이, 그 위는 하얗게 달아오른 심과 청록 빛 번짐.
// 빛 번짐은 더하기 합성(lighter)이라 어두운 관중석·잔디 위에서 빛처럼 보이고, 심 굵기가 길이를 따라 물결쳐 미세하게 일렁이며 빛 알갱이가 끝으로 흐른다.
// 번짐 모양은 넓고 옅은 번짐(반지름 12cm)과 좁고 진한 번짐(4.5cm)을 더한 것이고 한 번에 칠한다
const BEAM_RGB = '56,200,255', BEAM_GLOW = [[0, 0], [0.35, 0.04], [0.65, 0.16], [0.75, 0.31], [0.86, 0.59], [0.93, 0.95], [1, 1]];
function drawBeamBat(a, b, wa, wb, col, detail, t) {
  const { d, up, sa, sb, at } = batFrame(a, b, wa, wb), H = 0.25, e = at(H), tip = at(1.015), glow = col('batEnd');
  if (!detail) { segment(e, b, 0.03 * e.s, 0.03 * tip.s, glow); segment(a, e, 0.044 * sa, 0.046 * e.s, '#3a414c'); return; }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const fl = 0.9 + 0.06 * Math.sin(t * 47) + 0.04 * Math.sin(t * 83);   // 빛이 아주 조금 떨린다
  glowRod(e, tip, 0.12 * (e.s + tip.s) / 2, BEAM_RGB, fl, BEAM_GLOW);
  ctx.globalCompositeOperation = 'source-over';
  // 심: 굵기가 물결치는 흰 막대(끝은 둥글게)
  const w = (u) => 0.0125 * (1 + 0.16 * Math.sin(u * 22 - t * 26) + 0.08 * Math.sin(u * 51 + t * 41)), N = 12, ang = Math.atan2(d.y, d.x);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const u = lerp(H, 1, i / N), p = at(u, w(u)); ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y); }
  const r1 = w(1) * sb, upSide = Math.atan2(up.y, up.x);
  ctx.arc(b.x, b.y, r1, upSide, upSide + (Math.sin(ang - upSide) > 0 ? 1 : -1) * Math.PI, Math.sin(ang - upSide) < 0);
  for (let i = N; i >= 0; i--) { const u = lerp(H, 1, i / N), p = at(u, -w(u)); ctx.lineTo(p.x, p.y); }
  ctx.closePath(); ctx.fillStyle = col('bat'); ctx.fill();
  // 손잡이: 금속 원통(가로 그러데이션), 고리 홈 넷, 빛이 나오는 은색 목, 작은 불빛 단추
  const m = at(H / 2), hr = 0.023 * m.s, g = ctx.createLinearGradient(m.x + up.x * hr, m.y + up.y * hr, m.x - up.x * hr, m.y - up.y * hr);
  [[0, '#2a3038'], [0.22, '#8d98a8'], [0.4, '#c9d2de'], [0.62, '#4a525e'], [1, '#111419']].forEach(([o, c]) => g.addColorStop(o, c));
  capsulePath(a, at(H - 0.02), 0.022 * sa, 0.023 * e.s); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(8,10,14,0.85)'; ctx.lineWidth = Math.max(0.8, 0.005 * sa); ctx.beginPath();
  for (const u of [0.05, 0.09, 0.13, 0.17]) { const p = at(u, 0.023), q = at(u, -0.023); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
  ctx.stroke();
  const c0 = at(H - 0.035), c1 = at(H), gc = ctx.createLinearGradient(c1.x + up.x * hr * 1.2, c1.y + up.y * hr * 1.2, c1.x - up.x * hr * 1.2, c1.y - up.y * hr * 1.2);
  [[0, '#5d6673'], [0.3, '#f4f8ff'], [0.65, '#8792a3'], [1, '#2b3139']].forEach(([o, c]) => gc.addColorStop(o, c));
  capsulePath(c0, c1, 0.027 * c0.s, 0.029 * c1.s); ctx.fillStyle = gc; ctx.fill();
  ellipseAt(at(0.205, 0.012), Math.max(0.7, 0.0065 * sa), Math.max(0.7, 0.0065 * sa), '#7dfff0');
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {   // 빛 알갱이: 손잡이에서 끝으로 흐른다
    const u = H + (1 - H) * ((t * 0.8 + i / 3) % 1), p = at(u, (i % 2 ? 1 : -1) * (0.022 + 0.006 * Math.sin(t * 9 + i * 2))), r = Math.max(0.6, 0.008 * p.s);
    ellipseAt(p, r, r, 'rgba(190,255,255,0.8)');
  }
  ctx.restore();
}
// 다이아몬드 배트(4,000코인): 깎은 결정. 손잡이는 가늘고 통은 굵은 배트 모양을 칸마다 지그재그 능선으로 나눠 삼각형 면을 만들고,
// 빛을 받는 위쪽 면은 밝게·아래쪽 면은 어둡게 번갈아 칠한다(같은 밝기 면은 한 경로로 모아 한 번에). 면 둘은 돌아가며 무지개빛(분산)으로 물들고,
// 반짝임 셋과 빛줄기 하나가 배트를 따라 흐른다. 가장자리는 옅은 얼음빛 테두리, 끝은 결정처럼 뾰족하게 깎았다
const DIAMOND_U = [0, 0.12, 0.24, 0.35, 0.45, 0.54, 0.62, 0.7, 0.78, 0.86, 0.93, 1];
function drawDiamondBat(a, b, wa, wb, col, detail, t) {
  const { d, sa, at } = batFrame(a, b, wa, wb), half = (u) => 0.017 * (u < 0.3 ? 1 : lerp(1, 2, smooth((u - 0.3) / 0.45)));
  const U = DIAMOND_U, n = U.length - 1, T = U.map((u) => at(u, half(u))), B = U.map((u) => at(u, -half(u))), M = U.map((u, i) => at(u, half(u) * (i % 2 ? 0.3 : -0.12)));
  const tipP = { x: b.x + d.x * half(1) * 0.75 * T[n].s, y: b.y + d.y * half(1) * 0.75 * T[n].s };
  const outline = () => { ctx.beginPath(); T.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.lineTo(tipP.x, tipP.y); for (let i = n; i >= 0; i--) ctx.lineTo(B[i].x, B[i].y); ctx.closePath(); };
  if (!detail) { outline(); ctx.fillStyle = col('bat'); ctx.fill(); return; }
  ctx.save(); ctx.lineJoin = 'round';
  outline(); ctx.strokeStyle = 'rgba(170,230,255,0.3)'; ctx.lineWidth = Math.max(1.5, 0.022 * sa); ctx.stroke();   // 얼음빛 번짐
  ctx.fillStyle = '#9fd6f2'; ctx.fill();   // 면 사이 이음매로 뒤가 비치지 않게 바탕을 먼저
  const tri = (p, q, r) => { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.lineTo(r.x, r.y); ctx.closePath(); };
  const facet = (i, f) => (f === 0 ? tri(T[i], T[i + 1], M[i]) : f === 1 ? tri(T[i + 1], M[i + 1], M[i]) : f === 2 ? tri(M[i], M[i + 1], B[i]) : tri(M[i + 1], B[i + 1], B[i]));
  ['#f4fcff', '#c6ecfc', '#86c8ea', '#558fc4'].forEach((tone, k) => {   // 위 두 줄은 밝게, 아래 두 줄은 어둡게. 칸마다 밝기가 엇갈린다
    ctx.beginPath();
    for (let i = 0; i < n; i++) for (let f = 0; f < 4; f++) if ((f < 2 ? (f + i) % 2 : 2 + (f + i) % 2) === k) facet(i, f);
    if (k === 0) tri(T[n], tipP, M[n]);
    if (k === 3) tri(M[n], tipP, B[n]);
    ctx.fillStyle = tone; ctx.fill();
  });
  for (let j = 0; j < 2; j++) {   // 무지개빛(분산): 면 하나가 물들었다 사라지고 다음 면으로 옮겨 간다
    const ph = t * 1.8 + j * 0.5, i = 2 + (Math.floor(ph) * 5 + j * 3) % (n - 2), al = Math.sin(Math.PI * (ph % 1));
    ctx.beginPath(); facet(i, j ? 2 : 1); ctx.fillStyle = `hsla(${Math.round(t * 80 + j * 160) % 360},100%,72%,${(0.55 * al).toFixed(2)})`; ctx.fill();
  }
  ctx.beginPath();   // 면 모서리(능선과 가로 금)
  M.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.lineTo(tipP.x, tipP.y);
  for (let i = 1; i < n; i++) { ctx.moveTo(T[i].x, T[i].y); ctx.lineTo(M[i].x, M[i].y); ctx.lineTo(B[i].x, B[i].y); }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(0.5, 0.0035 * sa); ctx.stroke();
  outline(); ctx.strokeStyle = 'rgba(240,252,255,0.95)'; ctx.lineWidth = Math.max(0.7, 0.005 * sa); ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  const g = (t * 0.55) % 1.5 - 0.2;   // 빛줄기: 2.7초마다 손잡이에서 끝으로 비스듬히 지나간다
  if (g > 0 && g < 0.97) {
    const p1 = at(g + 0.04, half(g + 0.04)), p2 = at(g + 0.09, half(g + 0.09)), p3 = at(g + 0.03, -half(g + 0.03)), p4 = at(Math.max(0, g - 0.02), -half(Math.max(0, g - 0.02)));
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${(0.6 * Math.sin(Math.PI * g)).toFixed(2)})`; ctx.fill();
  }
  for (let i = 0; i < 3; i++) {   // 반짝임 셋이 배트를 따라 흐르며 깜빡인다
    const u = 0.3 + 0.68 * ((t * 0.27 + i * 0.37) % 1), tw = Math.sin(t * 4.3 + i * 2.4);
    if (tw > 0.1) drawSparkle(at(u, half(u) * 0.35), half(u) * at(u).s * (0.9 + 1.6 * tw), `rgba(255,255,255,${(0.95 * tw).toFixed(2)})`);
  }
  ctx.restore();
}

// 배트: a는 손, b는 끝(화면), wa·wb는 손잡이·끝 굵기(px), s는 끝 자리에서 1m가 몇 px인지
function drawBat(a, b, wa, wb, s, col, fx, detail) {
  if (fx === 'beam') { drawBeamBat(a, b, wa, wb, col, detail, fxTime()); return; }
  if (fx === 'diamond') { drawDiamondBat(a, b, wa, wb, col, detail, fxTime()); return; }
  const len = Math.hypot(b.x - a.x, b.y - a.y), d = len > 0.5 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 0, y: -1 }, n = { x: -d.y, y: d.x };
  const along = (stops) => (detail && len > 0.5 ? gradientAlong(a, b, stops) : col('bat'));
  if (fx === 'hammer') {   // 뿅망치: 노란 손잡이 끝에 배트와 직각인 빨간 머리통, 양 끝은 노란 마개, 몸통은 주름
    const c = { x: b.x - d.x * 0.03 * s, y: b.y - d.y * 0.03 * s }, hl = 0.15 * s, hr = 0.075 * s;
    segment(a, c, wa, wa * 1.15, col('bat'));
    const end = (e) => ({ x: c.x + n.x * hl * e, y: c.y + n.y * hl * e });
    segment(end(-1), end(1), hr * 2, hr * 2, col('batEnd'));
    if (!detail) return;
    ctx.strokeStyle = 'rgba(120,10,20,0.55)'; ctx.lineWidth = Math.max(1, hr * 0.16);
    for (const e of [-0.45, -0.15, 0.15, 0.45]) { const p = end(e); ctx.beginPath(); ctx.moveTo(p.x - d.x * hr * 0.9, p.y - d.y * hr * 0.9); ctx.lineTo(p.x + d.x * hr * 0.9, p.y + d.y * hr * 0.9); ctx.stroke(); }
    ctx.fillStyle = '#f7d84a';
    for (const e of [-1, 1]) { const p = end(e * 0.97); ctx.beginPath(); ctx.ellipse(p.x, p.y, hr, hr * 0.42, Math.atan2(d.y, d.x), 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  if (fx === 'leek') {   // 대파: 손잡이 쪽은 흰 줄기, 끝으로 갈수록 초록, 끝에서 잎이 갈라지고 손잡이 밑으로 뿌리가 나온다
    for (const [ang, l] of [[-0.3, 0.2], [0.06, 0.25], [0.34, 0.18]]) {
      const cs = Math.cos(ang), sn = Math.sin(ang), e = { x: b.x + (d.x * cs - d.y * sn) * l * s, y: b.y + (d.x * sn + d.y * cs) * l * s };
      segment(b, e, wb * 0.85, wb * 0.2, detail ? (ang > 0 ? '#2f8a2c' : '#46a83c') : col('bat'));
    }
    segment(a, b, wa * 1.1, wb, along([[0, '#f4f1e2'], [0.42, '#eceecb'], [0.62, '#a9d46c'], [1, col('batEnd')]]));
    if (!detail) return;
    ctx.strokeStyle = '#e3d7b0'; ctx.lineWidth = Math.max(1, wa * 0.09);
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI + (i - 2.5) * 0.22, cs = Math.cos(ang), sn = Math.sin(ang), r0 = wa * 0.5, r1 = wa * 0.5 + 0.05 * s * (0.7 + 0.3 * (i % 2));
      ctx.beginPath(); ctx.moveTo(a.x + (d.x * cs - d.y * sn) * r0, a.y + (d.x * sn + d.y * cs) * r0); ctx.lineTo(a.x + (d.x * cs - d.y * sn) * r1, a.y + (d.x * sn + d.y * cs) * r1); ctx.stroke();
    }
    return;
  }
  if (detail && fx === 'lightning') segment(a, b, wa * 2.4, wb * 2.4, 'rgba(110,190,255,0.22)');   // 푸른 빛
  if (detail && fx === 'ice') segment(a, b, wa * 1.8, wb * 1.8, 'rgba(190,235,255,0.25)');   // 찬 기운
  const body = fx === 'fire' ? along([[0, '#2a1610'], [0.5, col('bat')], [1, col('batEnd')]]) : fx ? along([[0, col('bat')], [1, col('batEnd')]]) : col('bat');
  segment(a, b, wa, wb, body);
  ellipseAt(b, wb / 2, wb / 2, fx && detail ? col('batEnd') : fx ? col('bat') : col('batEnd'));
  if (!detail) return;
  const t = fxTime();
  if (fx === 'fire') drawFlames(a, b, wa, wb, t);
  else if (fx === 'lightning') drawSparks(a, b, wb, t);
  else if (fx === 'ice') {   // 한쪽에 흰 결, 반짝임 셋
    const off = (u, k) => ({ x: lerp(a.x, b.x, u) + n.x * lerp(wa, wb, u) * k, y: lerp(a.y, b.y, u) + n.y * lerp(wa, wb, u) * k });
    segment(off(0.25, 0.22), off(0.95, 0.22), wa * 0.16, wb * 0.16, 'rgba(255,255,255,0.8)');
    [0.45, 0.7, 0.92].forEach((u, i) => drawSparkle(off(u, -0.15), lerp(wa, wb, u) * (0.35 + 0.45 * Math.abs(Math.sin(t * 3 + i * 2.1))), '#ffffff'));
  }
}

// 왕관(4,000코인): 헬멧은 팀 색 그대로이고 정수리에 금 왕관을 얹는다. 둥근 띠라 앞쪽 꼭짓점 다섯 중 양 끝은 비스듬해 좁게 보이고,
// 그 사이로 뒤쪽 꼭짓점이 어둡게 보인다. 꼭짓점마다 진주, 띠에는 빨강(가운데)·파랑·초록 보석. 반짝임이 띠를 따라 지나가고 보석이 번갈아 빛난다.
// (cx, cy)·rx·ry는 헬멧 돔. 작게 보이면(돔 반폭 7px 아래: 먼 주자, 상점 칸) 금 윤곽과 빨간 보석만 그린다
function drawCrown(cx, cy, rx, ry, detail, side = 1, t = fxTime()) {
  const W = rx * 0.86, yb = cy - ry * 0.64, hb = ry * 0.28, sag = ry * 0.06;   // 띠 반폭, 띠 가운데 높이, 띠 두께, 띠가 양옆으로 내려오는 정도
  const top = (x) => yb - hb / 2 - sag * (1 - (x / W) ** 2), bot = (x) => top(x) + hb, mid = (x) => top(x) + hb / 2;
  const X = [-0.93, -0.56, 0, 0.56, 0.93].map((k) => k * W), Hk = [0.52, 0.66, 0.86, 0.66, 0.52].map((k) => k * ry), small = !detail || rx < 7;
  const tipY = (j) => top(X[j]) - Hk[j];
  const gold = (y0, y1) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    [[0, '#fff6c8'], [0.32, '#f8d452'], [0.68, '#dc9f1f'], [1, '#93600a']].forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  };
  const pearl = (x, y, r, dim) => {
    ellipseAt({ x, y }, r, r, dim ? '#cfc6b6' : '#fbf7ee');
    if (!small) { ellipseAt({ x: x + r * 0.18, y: y + r * 0.22 }, r * 0.72, r * 0.6, dim ? 'rgba(90,70,40,0.25)' : 'rgba(150,130,100,0.35)'); ellipseAt({ x: x - r * 0.32 * side, y: y - r * 0.34 }, r * 0.34, r * 0.3, '#ffffff'); }
  };
  ctx.save(); ctx.lineJoin = 'round';
  if (!small) for (const k of [-0.79, -0.3, 0.3, 0.79]) {   // 뒤쪽 꼭짓점(앞 띠에 밑동이 가린다)
    const x = k * W * 0.92, X0 = cx + x, w = W * 0.15 * Math.sqrt(1 - k * k * 0.6), y = top(x) - ry * (Math.abs(k) > 0.5 ? 0.4 : 0.52), cy1 = top(x) - (top(x) - y) * 0.45;
    ctx.beginPath(); ctx.moveTo(X0 - w, mid(x)); ctx.quadraticCurveTo(X0 - w * 0.2, cy1, X0, y); ctx.quadraticCurveTo(X0 + w * 0.2, cy1, X0 + w, mid(x)); ctx.closePath();
    ctx.fillStyle = '#b58419'; ctx.fill();
    pearl(X0, y - ry * 0.035, ry * 0.055, true);
  }
  // 앞 윤곽: 왼쪽 띠 끝 → 꼭짓점·골짜기 → 오른쪽 띠 끝 → 아래 가장자리
  ctx.beginPath(); ctx.moveTo(-W + cx, bot(-W)); ctx.lineTo(-W + cx, top(-W));
  for (let j = 0; j < 5; j++) {
    const v0 = j ? (X[j - 1] + X[j]) / 2 : -W, v1 = j < 4 ? (X[j] + X[j + 1]) / 2 : W, tx = X[j], ty = tipY(j);
    ctx.quadraticCurveTo(cx + lerp(v0, tx, 0.72), lerp(top(v0), ty, 0.3), cx + tx, ty);
    ctx.quadraticCurveTo(cx + lerp(v1, tx, 0.72), lerp(top(v1), ty, 0.3), cx + v1, top(v1));
  }
  ctx.lineTo(cx + W, bot(W)); ctx.quadraticCurveTo(cx, bot(0) - sag, cx - W, bot(-W)); ctx.closePath();
  ctx.fillStyle = small ? '#f2c230' : gold(tipY(2), bot(0)); ctx.fill();
  if (!small) { ctx.strokeStyle = 'rgba(88,52,4,0.85)'; ctx.lineWidth = Math.max(0.6, rx * 0.03); ctx.stroke(); }
  if (small) { ellipseAt({ x: cx, y: mid(0) }, hb * 0.4, hb * 0.34, '#e0283a'); ctx.restore(); return; }
  // 띠: 위 가장자리 빛, 아래 반은 그늘
  ctx.beginPath(); ctx.moveTo(cx - W, mid(-W)); ctx.quadraticCurveTo(cx, mid(0) - sag, cx + W, mid(W)); ctx.lineTo(cx + W, bot(W)); ctx.quadraticCurveTo(cx, bot(0) - sag, cx - W, bot(-W)); ctx.closePath();
  ctx.fillStyle = 'rgba(110,62,0,0.28)'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - W * 0.97, top(-W) + hb * 0.14); ctx.quadraticCurveTo(cx, top(0) - sag + hb * 0.14, cx + W * 0.97, top(W) + hb * 0.14);
  ctx.strokeStyle = 'rgba(255,248,205,0.85)'; ctx.lineWidth = Math.max(0.6, hb * 0.1); ctx.stroke();
  for (let j = 0; j < 5; j++) pearl(cx + X[j], tipY(j) - ry * 0.045, ry * (j === 2 ? 0.085 : 0.068));
  // 보석: 가운데 빨강(마름모), 양옆 파랑·초록. 둥근 띠라 옆 보석은 가로로 좁다. 하이라이트가 번갈아 반짝인다
  [[0, '#e0283a', '#8e0d1c', 0.46], [-0.52 * side, '#2f6cf0', '#132f86', 0.34], [0.52 * side, '#27b85a', '#0d5a2a', 0.34]].forEach(([k, c, dk, r], i) => {
    const x = cx + k * W, y = mid(k * W), rw = hb * r * Math.sqrt(1 - k * k), rh = hb * r, glint = Math.max(0, Math.sin(t * 2.6 + i * 2.1));
    ctx.beginPath();
    if (i === 0) { ctx.moveTo(x, y - rh * 1.15); ctx.lineTo(x + rw, y); ctx.lineTo(x, y + rh * 1.15); ctx.lineTo(x - rw, y); ctx.closePath(); } else ctx.ellipse(x, y, rw, rh, 0, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = dk; ctx.lineWidth = Math.max(0.5, rh * 0.18); ctx.stroke();
    ellipseAt({ x: x - rw * 0.3 * side, y: y - rh * 0.35 }, rw * 0.32, rh * 0.26, `rgba(255,255,255,${(0.55 + 0.45 * glint).toFixed(2)})`);
    if (glint > 0.92) drawSparkle({ x: x - rw * 0.3 * side, y: y - rh * 0.35 }, rh * 1.6 * (glint - 0.9) * 10, 'rgba(255,255,255,0.9)');
  });
  const u = (t * 0.42) % 1.5;   // 반짝임이 띠 위를 왼쪽에서 오른쪽으로 지나간다(3.6초마다)
  if (u < 1) { const x = lerp(-W * 0.85, W * 0.85, u); drawSparkle({ x: cx + x, y: top(x) + hb * 0.2 }, hb * 1.3 * Math.sin(Math.PI * u), 'rgba(255,255,255,0.95)'); }
  ctx.restore();
}

// 우주인 헬멧(3,000코인): 보통 헬멧보다 큰 둥근 흰 돔(위에서 빛, 아래 그늘), 얼굴 쪽 금빛 반사 바이저, 양옆 조명 상자, 목의 금속 고리, 정수리 안테나 끝 불빛이 깜빡인다.
// 바이저는 돔 위의 큰 타원 영역(가로 ±88도·세로 ±40도)을 얼굴 방향으로 돌려 그리고, 돔 뒤로 넘어간 부분은 돔 가장자리에 붙인다.
// 그래서 뒤에서 보는 타자는 얼굴이 돌아간 쪽 가장자리에 금빛 초승달로 보이고, 앞에서 보면(상점 칸, 홈으로 들어오는 주자) 바이저가 다 보인다.
// face는 얼굴이 카메라를 보는 정도(1 정면, -1 뒤), fd는 얼굴이 화면 어느 쪽(±1)으로 돌았는지. 작게 보이면 돔·바이저·불빛만
function drawAstroHelmet(h, s, face, fd, detail, side, t) {
  const R = 0.17 * s, cx = h.x, cy = h.y - 0.015 * s, lw = Math.max(0.6, 0.012 * s), small = !detail || R < 8;
  const phi = Math.acos(clamp(face, -1, 1)), lx = -side * 0.3;   // 빛은 위·타석 반대쪽에서
  const onDome = (th, el) => ({ x: cx + fd * R * Math.cos(el) * Math.sin(clamp(th, -Math.PI / 2, Math.PI / 2)), y: cy - R * Math.sin(el) });
  const region = (ah, av, ec, n = small ? 12 : 22) => {   // 얼굴 방향 둘레의 타원 영역(뒤로 넘어간 점은 돔 가장자리로)
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const ps = i / n * Math.PI * 2, p = onDome(phi + ah * Math.cos(ps), ec + av * Math.sin(ps)); ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y); }
    ctx.closePath();
  };
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (!small) {
    const g = ctx.createLinearGradient(cx - R * 0.62, 0, cx + R * 0.62, 0);   // 목 고리(위 반은 돔에 가린다)
    [[0, '#39414d'], [0.32, '#c7cfda'], [0.55, '#7a8494'], [1, '#2c323b']].forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.86, R * 0.62, R * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
  }
  const ab = { x: cx + fd * 0.34 * R, y: cy - 0.93 * R }, at = { x: ab.x + fd * 0.14 * R, y: ab.y - 0.5 * R };   // 안테나: 정수리에서 얼굴 쪽(준비 자세의 배트가 반대쪽 위를 가린다)
  ctx.strokeStyle = '#8d96a6'; ctx.lineWidth = Math.max(0.8, 0.035 * R); ctx.beginPath(); ctx.moveTo(ab.x, ab.y + 0.1 * R); ctx.lineTo(at.x, at.y); ctx.stroke();
  if (!small) for (const e of [-1, 1]) {   // 관자놀이의 조명 상자: 돔 양옆으로 튀어나와(안쪽 반은 돔에 가린다) 뒤에서도 우주복 헬멧 윤곽이 된다
    const x = cx + e * R * 0.97, y = cy - 0.06 * R;
    roundRect(x - 0.11 * R, y - 0.15 * R, 0.22 * R, 0.3 * R, 0.06 * R); ctx.fillStyle = '#aab3c0'; ctx.fill(); ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
    if (e === fd) ellipseAt({ x: x + e * 0.03 * R, y: y - 0.04 * R }, 0.05 * R, 0.05 * R, '#ffe9a8');   // 얼굴 쪽 상자 앞의 등
  }
  const dg = ctx.createRadialGradient(cx + lx * R, cy - 0.45 * R, 0.05 * R, cx, cy, R * 1.05);   // 돔
  [[0, '#ffffff'], [0.45, '#eef1f6'], [0.8, '#c3cbd7'], [1, '#97a1b1']].forEach(([o, c]) => dg.addColorStop(o, c));
  ctx.fillStyle = small ? '#eef1f6' : dg; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
  const AH = 88 * DEG, AV = 40 * DEG, E0 = -0.12;
  if (!small && Math.cos(phi + Math.PI) > 0.05) {   // 뒤에서 보이면 돔 뒤 가운데 세로 이음선과 작은 장치(둥근 공으로 읽히고 앞뒤가 보인다)
    const thb = phi - Math.PI, sq = Math.cos(thb);
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) { const p = onDome(thb, lerp(-0.85, 1.35, i / 10)); ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y); }
    ctx.strokeStyle = 'rgba(110,122,142,0.5)'; ctx.lineWidth = lw; ctx.stroke();
    const p = onDome(thb, 0.2), bw = 0.16 * R * sq, bh = 0.1 * R;
    roundRect(p.x - bw, p.y - bh, bw * 2, bh * 2, bh * 0.5); ctx.fillStyle = '#4c5666'; ctx.fill();
    ellipseAt({ x: p.x + bw * 0.45, y: p.y }, 0.03 * R, 0.03 * R, Math.sin(t * 3) > 0 ? '#5dff9a' : '#1f6b3f');
  }
  if (!small) { region(AH + 0.13, AV + 0.13, E0); ctx.fillStyle = '#d7dce4'; ctx.fill(); ctx.strokeStyle = 'rgba(70,80,96,0.55)'; ctx.lineWidth = lw; ctx.stroke(); }   // 바이저 테
  const vg = ctx.createLinearGradient(0, cy - R * 0.62, 0, cy + R * 0.55);   // 금빛 바이저
  [[0, '#fff1b5'], [0.28, '#f2c24c'], [0.55, '#c9871c'], [0.8, '#8a5310'], [1, '#583306']].forEach(([o, c]) => vg.addColorStop(o, c));
  region(AH, AV, E0); ctx.fillStyle = small ? '#e0a62c' : vg; ctx.fill();
  if (!small) {
    region(AH * 0.86, AV * 0.3, E0 + AV * 0.5); ctx.fillStyle = 'rgba(255,252,230,0.4)'; ctx.fill();   // 위쪽에 비친 하늘·조명
    ctx.beginPath();   // 둥근 반사 줄
    for (let i = 0; i <= 6; i++) { const p = onDome(phi - AH * lerp(0.75, 0.15, i / 6), E0 + AV * lerp(0.35, 0.62, Math.sin(Math.PI * i / 6))); ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y); }
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(0.8, 0.045 * R); ctx.stroke();
    ellipseAt({ x: cx + lx * R * 1.1, y: cy - 0.62 * R }, 0.24 * R, 0.11 * R, 'rgba(255,255,255,0.85)');   // 돔 위 하이라이트
  }
  const blink = Math.max(0, 1 - (t % 1.2) / 0.3);   // 안테나 불빛: 1.2초마다 번쩍
  if (!small) {
    ctx.globalCompositeOperation = 'lighter';
    const hg = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 0.2 * R);
    hg.addColorStop(0, `rgba(255,90,80,${(0.8 * blink).toFixed(2)})`); hg.addColorStop(1, 'rgba(255,40,40,0)');
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(at.x, at.y, 0.2 * R, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ellipseAt(at, Math.max(0.8, 0.055 * R), Math.max(0.8, 0.055 * R), blink > 0.05 ? `rgb(255,${Math.round(90 + 140 * blink)},${Math.round(80 + 140 * blink)})` : '#9b1c1c');
  ctx.restore();
}

// 헬멧: h는 머리 가운데(화면), s는 머리 자리에서 1m가 몇 px인지, brim은 챙(없으면 안 그림). 타자는 투수 쪽을 봐서 뒤통수가 보인다.
// 동물 헬멧은 귀·갈기·가시를 헬멧보다 먼저(뒤에) 그리고, 무늬는 헬멧 위에 그린다. side는 좌타면 -1(빛 받는 쪽만 뒤집힌다).
// face는 얼굴이 카메라를 보는 정도(1 정면, -1 뒤. 우주인 헬멧의 바이저만 쓴다). 상점 칸은 정면(1)
function drawHelmet(h, s, brim, col, fx, detail, side = 1, face = 1) {
  if (fx === 'astro') { drawAstroHelmet(h, s, face, brim ? Math.sign(brim.x - h.x) || side : side, detail, side, fxTime()); return; }
  const c = col('helmet'), rx = 0.13 * s, ry = 0.125 * s, deco = (color) => (detail ? color : c);
  if (fx === 'rabbit') for (const e of [-1, 1]) {   // 긴 귀
    ctx.save(); ctx.translate(h.x + e * 0.06 * s, h.y - 0.19 * s); ctx.rotate(e * 0.2);
    ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, 0, 0.036 * s, 0.11 * s, 0, 0, Math.PI * 2); ctx.fill();
    if (detail) { ctx.fillStyle = '#f2a6b8'; ctx.beginPath(); ctx.ellipse(0, 0.01 * s, 0.017 * s, 0.075 * s, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (fx === 'lion') for (let i = 0; i < 16; i++) {   // 갈기
    const a = i / 16 * Math.PI * 2;
    ellipseAt({ x: h.x + Math.cos(a) * rx * 1.05, y: h.y + Math.sin(a) * ry * 1.05 }, 0.05 * s, 0.05 * s, deco(i % 2 ? '#b8692a' : '#cf8a3a'));
  }
  if (fx === 'bear' || fx === 'tiger' || fx === 'lion') for (const e of [-1, 1]) {   // 둥근 귀
    const p = { x: h.x + e * 0.095 * s, y: h.y - 0.088 * s }, r = (fx === 'lion' ? 0.036 : fx === 'tiger' ? 0.044 : 0.05) * s;
    ellipseAt(p, r, r, c);
    if (detail && fx === 'bear') ellipseAt({ x: p.x - e * 0.008 * s, y: p.y + 0.006 * s }, r * 0.5, r * 0.5, '#a8744a');
    if (detail && fx === 'tiger') {   // 호랑이 귀 뒤에는 흰 점이 있다
      ctx.lineWidth = Math.max(1, 0.008 * s); ctx.strokeStyle = '#1d1410'; ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.9, 0, Math.PI * 2); ctx.stroke();
      ellipseAt({ x: p.x, y: p.y + 0.004 * s }, r * 0.42, r * 0.42, '#ffffff');
    }
  }
  if (fx === 'dino') for (let i = 0; i < 5; i++) {   // 머리 위 가시
    const a = (-150 + i * 30) * DEG, ca = Math.cos(a), sa = Math.sin(a), bw = 0.032 * s;
    const base = { x: h.x + ca * rx * 0.88, y: h.y + sa * ry * 0.88 }, tip = { x: h.x + ca * (rx + 0.075 * s), y: h.y + sa * (ry + 0.075 * s) };
    ctx.fillStyle = deco('#f0a830'); ctx.beginPath();
    ctx.moveTo(base.x + sa * bw, base.y - ca * bw); ctx.lineTo(tip.x, tip.y); ctx.lineTo(base.x - sa * bw, base.y + ca * bw);
    ctx.closePath(); ctx.fill();
  }
  if (brim) ellipseAt(brim, 0.1 * brim.s, 0.035 * brim.s, c);
  ellipseAt(h, rx, ry, c);
  if (!detail) return;
  if (fx === 'tiger' || fx === 'turtle' || fx === 'dino') {
    ctx.save(); ctx.beginPath(); ctx.ellipse(h.x, h.y, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
    if (fx === 'tiger') {   // 양옆에서 들어오는 줄무늬와 정수리 줄무늬
      for (const e of [-1, 1]) for (const yo of [-0.06, 0, 0.06]) segment({ x: h.x + e * rx, y: h.y + yo * s }, { x: h.x + e * rx * 0.42, y: h.y + (yo + 0.012) * s }, 0.026 * s, 0.004 * s, '#1d1410');
      for (const e of [-1, 1]) segment({ x: h.x + e * 0.03 * s, y: h.y - ry }, { x: h.x + e * 0.018 * s, y: h.y - ry * 0.5 }, 0.022 * s, 0.004 * s, '#1d1410');
    } else if (fx === 'turtle') {   // 등딱지: 가운데 육각형과 바깥으로 뻗는 금
      const cx = h.x, cy = h.y - 0.01 * s, R = 0.055 * s, vs = Array.from({ length: 6 }, (_, i) => ({ x: cx + Math.cos((i * 60 + 30) * DEG) * R, y: cy + Math.sin((i * 60 + 30) * DEG) * R }));
      ctx.lineWidth = Math.max(1, 0.012 * s); ctx.strokeStyle = '#24502a';
      ctx.beginPath(); vs.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y))); ctx.closePath();
      ctx.fillStyle = '#76b65f'; ctx.fill(); ctx.stroke();
      for (const v of vs) { ctx.beginPath(); ctx.moveTo(v.x, v.y); ctx.lineTo(cx + (v.x - cx) * 4, cy + (v.y - cy) * 4); ctx.stroke(); }
    } else {   // 공룡: 밝은 점무늬
      for (const [x, y, r] of [[-0.05, 0.02, 0.022], [0.045, -0.03, 0.018], [0.02, 0.06, 0.015]]) ellipseAt({ x: h.x + x * s, y: h.y + y * s }, r * s, r * s, '#8fd27a');
    }
    ctx.restore();
  }
  ellipseAt({ x: h.x - side * 0.04 * s, y: h.y - 0.06 * s }, 0.045 * s, 0.025 * s, 'rgba(255,255,255,0.28)');
  if (fx === 'crown') drawCrown(h.x, h.y, rx, ry, detail, side);
}

// 신발: f는 발(화면), s는 발 자리에서 1m가 몇 px인지, front는 발끝 쪽(+1이면 화면 오른쪽).
// act는 뛸 때 효과가 나는 신발(로켓 부츠·번개 운동화)만 받는다: { v 빠르기(m/s), age 이 발을 디딘 뒤 초, n 걸음 번호, back 화면에서 발 뒤쪽(단위),
// fore 그 뒤쪽이 화면에 누운 정도(0이면 카메라 쪽), up 정강이 쪽(단위), seed 왼발 0·오른발 1 }
function drawShoe(f, s, front, col, fx, detail, act = null) {
  const c = col('shoe'), x = f.x + front * 0.05 * s, y = f.y;
  if (!fx) { ellipseAt({ x, y }, 0.12 * s, 0.045 * s, c); return; }
  if (fx === 'rocket') { drawRocketBoot(f, s, front, c, detail, act); return; }
  if (fx === 'bolt') { drawBoltShoe(f, s, front, c, detail, act); return; }
  if (fx === 'duck') {   // 오리발: 발끝으로 넓어지는 긴 물갈퀴, 끝은 물결 모양
    const hx = x - front * 0.07 * s, tx = x + front * 0.16 * s;
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(hx, y - 0.035 * s);
    ctx.quadraticCurveTo(x, y - 0.045 * s, tx, y - 0.05 * s);
    for (let i = 0; i < 3; i++) { const y0 = y - 0.05 * s + i * 0.033 * s; ctx.quadraticCurveTo(tx + front * 0.028 * s, y0 + 0.0165 * s, tx, y0 + 0.033 * s); }
    ctx.quadraticCurveTo(x, y + 0.05 * s, hx, y + 0.035 * s);
    ctx.quadraticCurveTo(hx - front * 0.03 * s, y, hx, y - 0.035 * s);
    ctx.closePath(); ctx.fill();
    if (detail) {
      ctx.strokeStyle = '#c9700f'; ctx.lineWidth = Math.max(1, 0.008 * s);
      for (const yo of [-0.017, 0.016]) { ctx.beginPath(); ctx.moveTo(x - front * 0.02 * s, y); ctx.lineTo(tx - front * 0.005 * s, y + yo * s); ctx.stroke(); }
    }
    return;
  }
  const rx = 0.13 * s, ry = (fx === 'rabbit' ? 0.06 : 0.055) * s;
  if (fx === 'rabbit') for (const [xo, tilt] of [[0.025, -0.15], [0.065, 0.25]]) {   // 발등에 선 작은 귀
    ctx.save(); ctx.translate(x + front * xo * s, y - ry * 1.2); ctx.rotate(front * tilt);
    ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, 0, 0.016 * s, 0.042 * s, 0, 0, Math.PI * 2); ctx.fill();
    if (detail) { ctx.fillStyle = '#f2a6b8'; ctx.beginPath(); ctx.ellipse(0, 0.004 * s, 0.007 * s, 0.028 * s, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (fx === 'dino' && detail) for (const yo of [-0.03, 0, 0.03]) {   // 하얀 발톱 셋
    const bx = x + front * rx * 0.85, by = y + yo * s;
    ctx.fillStyle = '#f4f1e6'; ctx.beginPath(); ctx.moveTo(bx, by - 0.012 * s); ctx.lineTo(bx + front * 0.045 * s, by); ctx.lineTo(bx, by + 0.012 * s); ctx.closePath(); ctx.fill();
  }
  ellipseAt({ x, y }, rx, ry, c);
  if (!detail) return;
  if (fx === 'bear' || fx === 'tiger') {   // 발끝 위쪽의 발가락 셋
    for (const a of [-62, -32, -2]) ellipseAt({ x: x + front * Math.cos(a * DEG) * rx * 0.8, y: y + Math.sin(a * DEG) * ry * 0.75 }, 0.021 * s, 0.021 * s, fx === 'bear' ? '#a3714a' : '#f6efe4');
    if (fx === 'tiger') for (const xo of [-0.06, -0.015]) segment({ x: x + front * xo * s, y: y - ry * 0.95 }, { x: x + front * (xo - 0.006) * s, y: y + ry * 0.1 }, 0.018 * s, 0.004 * s, '#1d1410');
  } else if (fx === 'rabbit') ellipseAt({ x: x + front * rx * 0.9, y: y - 0.006 * s }, 0.013 * s, 0.011 * s, '#f28aa3');   // 분홍 코
}

// ===== 뛸 때 효과가 나는 고가 신발(2026-11-03 로켓 부츠 3,000·번개 운동화 2,500) =====
// 신발 모양은 다른 상점 신발처럼 옆모습 그림이고(발 기준 m: dx는 발끝 쪽, dy는 아래), 효과는 친 타자가 뛸 때(runnerSkeleton의 stride) 난다.
// 서 있을 때(타석, 상점·랭킹 미리 보기)는 작게만 움직인다. 작게 보이면(먼 주자, 상점 칸 견본) 몸통 하나와 효과만 그린다
const shoeAt = (f, s, F) => (dx, dy) => ({ x: f.x + F * dx * s, y: f.y + dy * s });
// 빛 번짐: 가운데에서 바깥으로 옅어지는 타원을 더하기(lighter)로 칠해 둘레가 밝아진다(shadowBlur는 폰에서 느리다). ang은 긴 축 방향
function softGlow(c, rx, ry, ang, rgb, a) {
  if (rx < 0.5 || ry < 0.5) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(c.x, c.y); ctx.rotate(ang); ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`); g.addColorStop(0.45, `rgba(${rgb},${(a * 0.45).toFixed(3)})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
const glowDot = (p, r, rgb, a) => softGlow(p, r * 2.6, r * 2.6, 0, rgb, a * 0.5);
// 로켓 부츠: 크롬 금속 부츠(위가 밝고 가운데에 하늘이 비친 선), 뒤꿈치 위 빨간 날개, 뒤꿈치 노즐. 뛰면 노즐에서 빠르기에 비례해
// 불꽃이 뿜어지고(노즐 쪽부터 파란 심 → 노랑 → 주황, 불티가 뒤로 날린다), 서 있으면 노즐에 작은 불씨만 깜빡인다.
// 불꽃이 카메라 쪽으로 나가면(뒤에서 보는 주자) 짧게 눕고 노즐이 둥글게 빛난다(분사구를 들여다보는 모습)
function drawRocketBoot(f, s, F, c, detail, act) {
  const t = fxTime(), at = shoeAt(f, s, F), seed = act?.seed ?? 0, v = clamp((act?.v ?? 0) / SPRINT.top, 0, 1);
  const noz = at(-0.142, 0.006);   // 노즐 끝
  if (!detail || s < 45) {   // 작게: 은색 몸통, 노즐 불빛
    ellipseAt(at(0.04, 0.005), 0.135 * s, 0.05 * s, c);
    ellipseAt(at(0.04, 0.03), 0.12 * s, 0.022 * s, '#3a4150');
    if (v > 0.03) rocketFlame(noz, s, act, v, t, seed, false);
    else glowDot(noz, Math.max(0.8, 0.016 * s), '255,150,60', 0.8 + 0.2 * Math.sin(t * 9 + seed * 2));
    return;
  }
  const up = act?.up ?? { x: 0, y: -1 }, sh = (dx, h) => { const p = at(dx, -0.065); return { x: p.x + up.x * h * s, y: p.y + up.y * h * s }; };   // 목은 정강이를 따라 선다
  const body = [at(0.195, 0.03), at(0.19, -0.012), at(0.13, -0.048), at(0.05, -0.066), sh(0.035, 0.075), sh(-0.075, 0.08), at(-0.105, -0.04), at(-0.112, 0.03), at(-0.09, 0.056), at(0.16, 0.056)];
  const top = Math.min(...body.map((p) => p.y)), bot = f.y + 0.056 * s, lw = Math.max(0.6, 0.006 * s);
  // 날개: 뒤꿈치 위에서 뒤로 뻗은 빨간 지느러미(부츠보다 먼저 그려 뿌리가 부츠에 묻힌다)
  const fin = [sh(-0.07, 0.045), at(-0.152, -0.078), at(-0.14, -0.052), at(-0.1, -0.036)];
  ctx.fillStyle = '#c62f27'; ctx.beginPath(); fin.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y));
  ctx.closePath(); ctx.fill(); ctx.strokeStyle = 'rgba(60,8,4,0.75)'; ctx.lineWidth = lw; ctx.stroke();
  segment(fin[0], fin[1], lw * 1.4, lw * 0.8, '#ff7a62');   // 앞 가장자리 빛
  // 노즐: 뒤꿈치에서 뒤로 벌어지는 짙은 금속 통
  const nz = [at(-0.1, -0.022), at(-0.142, -0.034), at(-0.142, 0.046), at(-0.1, 0.034)];
  ctx.fillStyle = gradientAlong(nz[1], nz[2], [[0, '#9aa3b4'], [0.45, '#4b5262'], [1, '#2a2f3a']]); ctx.beginPath();
  nz.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.closePath(); ctx.fill(); ctx.strokeStyle = 'rgba(14,16,22,0.8)'; ctx.stroke();
  // 몸통: 크롬(위 밝게, 가운데에 비친 하늘 띠, 아래 어둡게)
  if (smoothPath(body)) {
    const g = ctx.createLinearGradient(0, top, 0, bot);
    [[0, '#ffffff'], [0.3, '#d3d9e3'], [0.52, '#8c96a8'], [0.55, '#f1f4f8'], [0.78, '#b6bfcc'], [1, '#6a7385']].forEach(([o, col]) => g.addColorStop(o, col));
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(18,22,32,0.75)'; ctx.lineWidth = lw; ctx.stroke();
  }
  // 밑창(짙은 고무)과 그 위 파란 동력 선(1초에 한 번 숨 쉰다), 발목 띠
  const sole = [at(-0.09, 0.056), at(0.16, 0.056), at(0.195, 0.03), at(0.192, 0.022), at(-0.11, 0.022)];
  ctx.fillStyle = '#2b313d'; ctx.beginPath(); sole.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.closePath(); ctx.fill();
  const pw = 0.6 + 0.4 * Math.sin(t * 6.3 + seed);
  segment(at(-0.098, 0.022), at(0.182, 0.022), 0.012 * s, 0.012 * s, `rgba(90,200,255,${(0.25 * pw).toFixed(3)})`);
  segment(at(-0.098, 0.022), at(0.182, 0.022), 0.004 * s, 0.004 * s, `rgba(200,240,255,${(0.6 + 0.4 * pw).toFixed(3)})`);
  segment(sh(0.03, 0.058), sh(-0.07, 0.062), 0.02 * s, 0.02 * s, '#3b4352');
  segment(sh(0.03, 0.058), sh(-0.07, 0.062), 0.005 * s, 0.005 * s, `rgba(150,225,255,${(0.6 + 0.4 * pw).toFixed(3)})`);
  // 금속 판 이음선과 발끝 반사광
  ctx.strokeStyle = 'rgba(40,46,60,0.45)'; ctx.lineWidth = lw * 0.8;
  const a = at(0.1, -0.056), b = at(0.07, 0.018), m = at(0.055, -0.02);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(m.x, m.y, b.x, b.y); ctx.stroke();
  const hl = at(0.135, -0.03);
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.ellipse(hl.x, hl.y, 0.035 * s, 0.007 * s, F * -0.45, 0, Math.PI * 2); ctx.fill();
  // 노즐 끝(안쪽은 늘 달아올라 있다)
  ctx.fillStyle = '#161a22'; ctx.beginPath(); ctx.ellipse(noz.x, noz.y, 0.009 * s, 0.038 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(255,${Math.round(150 + 60 * v)},70,${(0.55 + 0.45 * Math.max(v, 0.5 + 0.5 * Math.sin(t * 7 + seed))).toFixed(3)})`;
  ctx.beginPath(); ctx.ellipse(noz.x, noz.y, 0.0055 * s, 0.026 * s, 0, 0, Math.PI * 2); ctx.fill();
  // 뒤로 차올린 발은 밑창 대신 노즐이 카메라를 향해 둥글게 빛난다(rocketFlame의 fore). 옅은 밑창 타원은 부츠 위에 유령처럼 보였다
  if (v > 0.03) rocketFlame(noz, s, act, v, t, seed, true);
  else {   // 서 있으면 노즐에 불씨만: 깜빡이고 가끔 불티 하나가 올라간다
    const r = 0.013 * s * (1 + 0.25 * Math.sin(t * 9 + seed * 2) + 0.15 * Math.sin(t * 23 + seed));
    glowDot(noz, r, '255,140,50', 1);
    ellipseAt(noz, r, r, 'rgba(255,190,90,0.95)');
    ellipseAt(noz, r * 0.45, r * 0.45, 'rgba(200,235,255,0.95)');
    const u = (t * 0.7 + seed * 0.5) % 1;
    ellipseAt({ x: noz.x - F * u * 0.03 * s, y: noz.y - u * 0.09 * s }, 0.004 * s * (1 - u) + 0.4, 0.004 * s * (1 - u) + 0.4, `rgba(255,200,110,${(0.9 * (1 - u)).toFixed(2)})`);
  }
}
// 로켓 불꽃: 노즐 p에서 act.back 쪽으로. 길이는 빠르기에 비례하고 화면에 누운 만큼(fore) 길다. 혀 모양 네 겹이 흔들리고 불티 넷이 뒤로 날린다
function rocketFlame(p, s, act, v, t, seed, detail) {
  const B = act?.back ?? { x: -1, y: 0 }, fore = act?.fore ?? 1, q = { x: -B.y, y: B.x };
  const flick = 0.86 + 0.1 * Math.sin(t * 37 + seed * 2.3) + 0.06 * Math.sin(t * 61 + seed * 5.1);
  const L = s * (0.09 + 0.36 * v) * flick * (0.25 + 0.75 * fore), hw = s * (0.022 + 0.014 * v);
  const ang = Math.atan2(B.y, B.x), mid = { x: p.x + B.x * L * 0.4, y: p.y + B.y * L * 0.4 };
  softGlow(mid, L * 0.85 + hw * 2, hw * 3.2, ang, '255,120,40', 0.32 + 0.2 * v);   // 불빛 번짐
  const layers = detail ? [['rgba(255,92,22,0.9)', 1, 1], ['rgba(255,196,64,0.95)', 0.7, 0.7], ['rgba(130,205,255,0.95)', 0.36, 0.5], ['rgba(238,250,255,0.95)', 0.17, 0.3]] : [['rgba(255,110,30,0.9)', 1, 1], ['rgba(255,220,120,0.95)', 0.5, 0.55]];
  layers.forEach(([color, lk, wk], i) => {
    const l = L * lk, w = hw * wk, sway = Math.sin(t * 29 + i * 1.7 + seed) * hw * 0.35;
    const tip = { x: p.x + B.x * l + q.x * sway, y: p.y + B.y * l + q.y * sway };
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(p.x + q.x * w, p.y + q.y * w);
    ctx.quadraticCurveTo(p.x + B.x * l * 0.5 + q.x * w * 1.05, p.y + B.y * l * 0.5 + q.y * w * 1.05, tip.x, tip.y);
    ctx.quadraticCurveTo(p.x + B.x * l * 0.5 - q.x * w * 1.05, p.y + B.y * l * 0.5 - q.y * w * 1.05, p.x - q.x * w, p.y - q.y * w);
    ctx.closePath(); ctx.fill();
  });
  if (fore < 0.6) {   // 카메라 쪽으로 뿜으면 분사구가 둥글게 빛난다
    const r = hw * (0.8 + 0.8 * (1 - fore));
    glowDot(p, r, '255,140,50', 0.9);
    ellipseAt(p, r, r, 'rgba(255,205,110,0.9)');
    ellipseAt(p, r * 0.5, r * 0.5, 'rgba(205,238,255,0.95)');
  }
  if (!detail) return;
  for (let i = 0; i < 4; i++) {   // 불티
    const u = (t * 2.6 + i * 0.25 + seed * 0.13) % 1, side = Math.sin(i * 7.3 + seed * 3 + Math.floor(t * 2.6 + i * 0.25) * 2.1);
    const d = L * (0.55 + 0.9 * u), r = Math.max(0.6, 0.007 * s * (1 - u));
    ellipseAt({ x: p.x + B.x * d + q.x * side * hw * 1.3, y: p.y + B.y * d + q.y * side * hw * 1.3 }, r, r, `rgba(255,${Math.round(220 - 90 * u)},90,${(0.95 * (1 - u)).toFixed(2)})`);
  }
}
// 번개 운동화: 어두운 운동화에 흰 밑창, 옆에 형광 노랑 번개 줄(1초에 한 번 숨 쉬듯 빛난다). 뛰면 발을 디딜 때마다 발밑에서 작은 번개가 0.15초 터지고
// (걸음 번호로 모양이 정해지고 1초에 30번 지지직 바뀐다), 서 있으면 2초쯤에 한 번 번개 줄 끝에서 작은 불꽃이 튄다
const BOLT_SHAPE = [[0, 0.05], [0.55, -0.35], [0.55, -0.05], [1, -0.25], [0.4, 0.35], [0.4, 0.05], [0, 0.3]];   // 발끝 쪽을 가리키는 번개(가로 0~1, 세로 -0.35~0.35)
function drawBoltShoe(f, s, F, c, detail, act) {
  const t = fxTime(), at = shoeAt(f, s, F), seed = act?.seed ?? 0, small = !detail || s < 45;
  const plant = act && act.v > 1 && act.age != null && act.age < 0.15 ? 1 - act.age / 0.15 : 0;
  const idle = !act || act.v < 0.5 ? (t + seed * 0.83 + 0.4) % 1.9 : 9, spark = idle < 0.14 ? 1 - idle / 0.14 : 0;
  const pulse = 0.65 + 0.35 * Math.sin(t * 6.3 + seed * 1.7), boltPts = BOLT_SHAPE.map(([X, Y]) => at(-0.082 + 0.225 * X, -0.014 + 0.052 * Y));
  if (small) {
    ellipseAt(at(0.035, 0.004), 0.13 * s, 0.05 * s, c);
    segment(at(-0.06, 0.005), at(0.11, -0.012), 0.022 * s, 0.012 * s, '#e6ff3a');
  } else {
    const lw = Math.max(0.6, 0.006 * s);
    const upper = [at(0.172, 0.03), at(0.178, -0.004), at(0.125, -0.036), at(0.045, -0.05), at(-0.005, -0.07), at(-0.072, -0.076), at(-0.104, -0.048), at(-0.112, 0.004), at(-0.106, 0.03)];
    if (smoothPath(upper)) {
      ctx.fillStyle = gradientAlong(at(0, -0.075), at(0, 0.03), [[0, tint(c, 1.45)], [0.45, c], [1, tint(c, 0.75)]]);
      ctx.fill(); ctx.strokeStyle = 'rgba(8,10,18,0.8)'; ctx.lineWidth = lw; ctx.stroke();
    }
    ellipseAt(at(-0.04, -0.07), 0.034 * s, 0.008 * s, '#10131c');   // 발목 구멍
    segment(at(-0.098, -0.066), at(-0.106, -0.04), 0.014 * s, 0.012 * s, '#e6ff3a');   // 뒤꿈치 고리
    ctx.strokeStyle = 'rgba(220,226,240,0.75)'; ctx.lineWidth = Math.max(0.6, 0.005 * s);   // 끈
    for (let i = 0; i < 3; i++) { const p = at(0.012 + i * 0.03, -0.054 + i * 0.006), q = at(0.032 + i * 0.03, -0.044 + i * 0.006); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    const sole = [at(-0.108, 0.026), at(0.176, 0.026), at(0.196, 0.04), at(0.176, 0.058), at(-0.094, 0.058), at(-0.116, 0.044)];
    ctx.fillStyle = '#eef0f5'; ctx.beginPath(); sole.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(8,10,18,0.8)'; ctx.lineWidth = lw; ctx.stroke();
    segment(at(-0.1, 0.051), at(0.17, 0.051), 0.008 * s, 0.008 * s, '#1b2030');   // 바닥 고무
    segment(at(-0.1, 0.029), at(0.172, 0.029), 0.0035 * s, 0.0035 * s, `rgba(230,255,60,${(0.55 + 0.45 * pulse).toFixed(3)})`);
    // 번개 줄: 옅게 번진 테두리 위에 형광 노랑, 가장자리는 흰빛
    ctx.lineJoin = 'round'; ctx.beginPath(); boltPts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.closePath();
    ctx.strokeStyle = `rgba(225,255,60,${(0.22 * pulse + 0.25 * plant).toFixed(3)})`; ctx.lineWidth = 0.016 * s; ctx.stroke();
    ctx.fillStyle = '#e8ff3c'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,230,0.9)'; ctx.lineWidth = Math.max(0.5, 0.0025 * s); ctx.stroke();
  }
  if (plant > 0) boltBurst(at(0.035, 0.058), s, plant, ((act.n ?? 0) * 977 + seed * 131 + Math.floor(t * 30) * 7) >>> 0, small ? 4 : 6, 1);
  if (spark > 0) boltBurst(boltPts[3], s, spark, (Math.floor((t + seed * 0.83 + 0.4) / 1.9) * 53 + seed * 17 + Math.floor(t * 30)) >>> 0, 2, 0.45);
}
// 작은 번개 무더기: o에서 n줄이 지그재그로 뻗는다(k가 줄어들수록 길어지며 옅어진다). size가 1(발 디딤)이면 땅을 따라 양옆으로 낮게 뻗고
// 발밑 땅이 번쩍이며 고리(충격파)가 퍼진다(위로 솟으면 신발에 겹쳐 묻혔다). 작으면(서 있을 때 불꽃) 위쪽 반원으로 튄다.
// 빛은 더하기(lighter)로 칠해 잔디·흙 위에서도 튄다. 멀리 뛰는 주자(1루 근처 폰에서 1m가 80px 아래)도 보이게 작을수록 덜 줄인다(제곱근).
// 그냥 아래 한계를 두면 홈런 주루처럼 먼 주자는 번개가 몸보다 크게 퍼졌다
function boltBurst(o, s, k, seed, n, size) {
  const rnd = mulberry32(seed), grow = 0.8 + 0.4 * (1 - k), S = (s < 80 ? 80 * Math.sqrt(s / 80) : s) * size, low = size >= 1;
  if (low) {
    softGlow(o, 0.28 * S * grow, 0.085 * S * grow, 0, '215,255,80', 0.85 * k);
    ctx.strokeStyle = `rgba(225,255,110,${(0.75 * k).toFixed(3)})`; ctx.lineWidth = Math.max(1, 0.008 * S);
    ctx.beginPath(); ctx.ellipse(o.x, o.y, 0.22 * S * (1.25 - k), 0.06 * S * (1.25 - k), 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const paths = [];
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1, lift = 0.05 + 0.28 * (i / n) + 0.1 * rnd();   // 땅에서 들린 각(반원의 몫): 양옆 번갈아, 뒤로 갈수록 조금 높게
    const a = low ? (side > 0 ? -Math.PI * lift : -Math.PI * (1 - lift)) : -Math.PI * (0.06 + 0.88 * (i + 0.2 + 0.6 * rnd()) / n);
    const len = S * (low ? 0.14 + 0.14 * rnd() : 0.08 + 0.09 * rnd()) * grow, ca = Math.cos(a), sa = Math.sin(a), pts = [o];
    for (let j = 1; j <= 4; j++) { const d = len * j / 4, off = (rnd() - 0.5) * len * 0.42 * (j < 4 ? 1 : 0.3); pts.push({ x: o.x + ca * d - sa * off, y: o.y + sa * d + ca * off }); }
    paths.push(pts);
  }
  for (const [w, color] of [[Math.max(2.5, 0.022 * S), `rgba(200,255,40,${(0.42 * k).toFixed(3)})`], [Math.max(0.8, 0.005 * S), `rgba(255,255,220,${k.toFixed(3)})`]]) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    for (const pts of paths) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
  }
  for (const pts of paths) { const e = pts[pts.length - 1]; ellipseAt(e, 0.006 * S * k + 0.5, 0.006 * S * k + 0.5, `rgba(255,255,200,${k.toFixed(3)})`); }   // 끝에 튀는 불티
  ctx.restore();
}

// ===== 고가 유니폼(2026-11-03 금장 'legend' 5,000·네온 'neon' 4,000) =====
// 내 모습을 입는 사람(타자, 친 뒤 뛰는 주자, 상점·랭킹 미리 보기)만 입는다(drawBatterFigure의 look이 투수·수비수는 비어 있다).
// 소매(언더셔츠)·스타킹 바탕은 팀 색 그대로다(팀 대항 랭킹이라). 무늬는 몸 윤곽 안에만 둔다: 금 줄무늬는 몸통 단면에서 카메라를 보는 면에만 긋고
// (옆으로 돌아가면 옅어져 사라진다), 네온 이음선과 파이핑은 윤곽에서 안쪽으로 들인다. 자르기(ctx.clip)·shadowBlur는 폰에서 느려서 쓰지 않고, 빛 번짐은 굵고 옅은 선을 겹친다
const GOLD = { edge: 'rgba(30,18,2,0.82)', mid: '#d8ad36', light: '#ffe896', glint: 'rgba(255,252,232,0.95)', deep: '#8c6416' };
const NEON = { cyan: [40, 238, 255], pink: [255, 62, 212] };
const neonBreath = (lag = 0) => 0.5 + 0.5 * Math.sin((fxTime() - lag) * Math.PI * 0.8);   // 2.5초마다 숨 쉬듯 밝아졌다 어두워진다
function strokePoly(pts, w, color) {
  if (pts.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
}
// 꺾은선에서 길이 비율 u0~u1 부분(겹치는 데가 없으면 빈 배열)
function polyPart(pts, u0, u1) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const a = clamp(u0, 0, 1) * total, b = clamp(u1, 0, 1) * total, out = [];
  if (b <= a || total <= 0) return out;
  for (let i = 1, acc = 0; i < pts.length && acc <= b; i++) {
    const p = pts[i - 1], q = pts[i], d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > 0 && acc + d >= a) {
      const t0 = clamp((a - acc) / d, 0, 1), t1 = clamp((b - acc) / d, 0, 1);
      if (!out.length) out.push({ x: lerp(p.x, q.x, t0), y: lerp(p.y, q.y, t0) });
      out.push({ x: lerp(p.x, q.x, t1), y: lerp(p.y, q.y, t1) });
    }
    acc += d;
  }
  return out;
}
// 네온관: 옅고 굵은 번짐 두 겹 위에 하얗게 빛나는 심. pts는 꺾은선 하나나 여럿(같은 색은 한 번에 긋는다), k는 밝기(0~1).
// flow가 있으면 밝은 빛 한 점이 1.6초에 한 번 선을 따라 흐른다(flow는 시작 시각 어긋남). fine이 아니면(작게 보이는 주자) 번짐을 한 겹으로 합친다
function neonLine(pts, [r, g, b], w, k, flow = null, fine = true) {
  const lines = (Array.isArray(pts[0]) ? pts : [pts]).filter((l) => l.length > 1);
  if (!lines.length) return;
  const cap = ctx.lineCap, join = ctx.lineJoin, op = ctx.globalCompositeOperation;
  const pass = (lw, color) => { ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); for (const l of lines) l.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';   // 번짐은 더해서 둘레 천이 빛을 받은 것처럼
  if (fine) { pass(w * 3.4, `rgba(${r},${g},${b},${(0.04 + 0.16 * k).toFixed(3)})`); pass(w * 1.8, `rgba(${r},${g},${b},${(0.16 + 0.42 * k).toFixed(3)})`); }
  else pass(w * 2.4, `rgba(${r},${g},${b},${(0.12 + 0.34 * k).toFixed(3)})`);
  ctx.globalCompositeOperation = op;
  pass(w * 0.75, `rgba(${Math.round(lerp(r, 255, 0.72))},${Math.round(lerp(g, 255, 0.72))},${Math.round(lerp(b, 255, 0.72))},${(0.62 + 0.38 * k).toFixed(3)})`);
  if (flow != null) lines.forEach((l, i) => {
    const u = ((fxTime() + flow + i * 0.8) / 1.6 % 1) * 1.3 - 0.15;
    strokePoly(polyPart(l, u - 0.06, u + 0.06), w * 1.15, 'rgba(255,255,255,0.9)');
  });
  ctx.lineCap = cap; ctx.lineJoin = join;
}
// 금 파이핑: 어두운 테두리(검은 천에서 떠 보이게) 위에 금. fancy(크게 보일 때)면 금빛 번짐과 가운데 밝은 줄을 더하고, 빛이 줄을 따라 지나가고(2.6초마다)
// 가끔 별처럼 반짝인다(2.3초마다 한 번, 자리는 그때마다 다르다). 작게 보이는 주자는 줄이 1~2px라 테두리와 금만 긋는다. phase로 줄마다 때를 어긋낸다
function goldCord(pts, w, phase = 0, fancy = false) {
  if (pts.length < 2) return;
  const cap = ctx.lineCap, join = ctx.lineJoin, op = ctx.globalCompositeOperation, t = fxTime() + phase;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (fancy) { ctx.globalCompositeOperation = 'lighter'; strokePoly(pts, w * 2.8, 'rgba(255,190,70,0.12)'); ctx.globalCompositeOperation = op; }   // 은은한 금빛 번짐
  strokePoly(pts, w * 1.55, GOLD.edge);
  strokePoly(pts, w, GOLD.mid);
  if (fancy) {
    strokePoly(pts, w * 0.38, GOLD.light);
    const u = (t / 2.6 % 1) * 1.5 - 0.25;
    strokePoly(polyPart(pts, u - 0.07, u + 0.07), w * 0.85, GOLD.glint);
    const c = t / 2.3, sp = c % 1;
    if (sp < 0.3) {
      const h = Math.sin(Math.floor(c) * 12.9898 + phase * 78.233) * 43758.5453, at = polyPart(pts, 0, 0.1 + 0.8 * (h - Math.floor(h)));
      if (at.length) drawSparkle(at[at.length - 1], w * 2.6 * Math.sin(Math.PI * sp / 0.3), GOLD.glint);
    }
  }
  ctx.lineCap = cap; ctx.lineJoin = join;
}

// 한 번은 빛 테두리 색으로 조금 위에, 한 번은 제 색으로 그려서 조명을 등진 윤곽을 만든다
// 사람 몸 그리기(2026-11-02 사용자 결정 '캐릭터가 목탁 같다' → 시안 A '깔끔한 두 톤 명암 + 얇은 윤곽선', 시안은 인프라 세션이 만듦).
// 뼈대·동작(batterSkeleton, pitcherSkeleton, fielderSkeleton, runnerSkeleton, assembleFigure, bendJoint)은 그대로 두고 그 위에 입히는 몸만 그린다.
// - 팔다리: 관절 동그라미 없이 이어진 윤곽 하나(허벅지 앞·종아리 뒤 볼록, 끝으로 갈수록 가늘게)
// - 몸통: 높이마다 단면(타원)을 돌려 척추 양옆으로 가장 바깥 점을 잇는다(볼록 껍질이 아니라 허리가 들어가고 어깨가 생긴다)
// - 명암: 화면 위쪽(경기장 가운데 쪽)에서 빛이 온다고 보고 반대쪽 가장자리에 경계가 분명한 그늘 띠, 얇은 윤곽선. 자르기(ctx.clip)는 폰에서 느려서 쓰지 않는다
// 전에는 마디 양 끝에 원을 그려 관절이 모두 공 모양이었고, 몸통을 볼록 껍질로 감싸 허리·어깨선이 없고, 머리가 커서 목각 인형처럼 보였다
const FIG_SHADE = 'rgba(8,12,30,0.27)', FIG_LINE = 'rgba(10,12,22,0.62)', FIG_HAIR = '#211a16';
const n2 = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
const dot2 = (a, b) => a.x * b.x + a.y * b.y;
function drawBatterFigure(k, col, dy = 0) {
  if (camMoved() && k.world && k.chest[2] - cam.z < 1.5) return;   // 따라가는 카메라 곁을 지나는 사람은 그리지 않는다(뒤로 넘어간 점이 버려져 모양이 깨진다)
  const P = (p) => { const q = k.world ? project(p[0], p[1], p[2]) : batterPoint(p); return q ? { x: q.x, y: q.y + dy, s: q.s } : null; };
  const c0 = P(k.chest), p0 = P(k.pelvis);
  if (!c0 || !p0) return;
  const lod = c0.s > 150 ? 2 : c0.s > 30 ? 1 : 0;   // 크기별 자세함: 2 타자(전부), 1 투수·주자·가까운 수비, 0 먼 수비(단순, 팔다리 12% 굵게)
  const look = k.plain ? {} : currentLook();   // 투수·수비수(plain)에게는 상점 물건을 입히지 않는다
  const ufx = fxOf(look.uniform);   // 고가 유니폼(금장·네온) 무늬
  const ax = k.axes ?? { lc: k.left(k.shTurn), fc: k.facing(k.shTurn), lp: k.left(k.hipTurn), fp: k.facing(k.hipTurn) };
  const Ls = n2(c0.x < view.w / 2 ? 0.35 : -0.35, -1);   // 화면에서 빛이 오는 쪽(위, 경기장 가운데 쪽)
  const lw = Math.max(0.5, Math.min(2.4, 0.011 * c0.s));
  const nB = [2, 3, 5][lod];   // 뼈 하나를 몇 칸으로 나눠 윤곽을 만들지

  const stroke = (pts) => {
    if (!smoothPath(pts)) return;
    ctx.lineJoin = 'round'; ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
  };
  const fill = (pts, color, line = true) => {
    if (!smoothPath(pts)) return false;
    ctx.fillStyle = color; ctx.fill();
    if (line) stroke(pts);
    return true;
  };
  // 3D 두 점 사이를 n칸으로 나눈 화면 점과 반지름(px). prof(t)는 { r, fr(앞쪽 볼록), bk(뒤쪽 볼록) } 미터.
  // 아주 작게 보이는 사람(먼 수비수)은 실제 굵기면 젓가락처럼 보여서 12% 굵게 그린다
  const thick = lod === 0 ? 1.12 : 1;
  const samples = (a, b, n, prof, from = 0, to = 1, skipFirst = false) => {
    const out = [];
    for (let i = skipFirst ? 1 : 0; i <= n; i++) {
      const t = lerp(from, to, i / n), q = P(V.add(a, V.mul(V.sub(b, a), t)));
      if (!q) continue;
      const pr = prof(i / n), m = q.s * thick;
      out.push({ x: q.x, y: q.y, r: pr.r * m, fr: (pr.fr ?? 0) * m, bk: (pr.bk ?? 0) * m });
    }
    return out;
  };
  // 3D 방향 d가 화면에서 어느 쪽인지(길이는 화면에 누운 정도, 카메라 쪽을 보면 0에 가깝다)
  const screenDir = (p, d) => {
    const a = P(p), b = P(V.add(p, V.mul(d, 0.1)));
    if (!a || !b) return null;
    const m = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / (0.1 * a.s)), u = n2(b.x - a.x, b.y - a.y);
    return { x: u.x * m, y: u.y * m };
  };

  // 이어진 팔다리 윤곽. 왼쪽(L)·오른쪽(R) 가장자리, 가운데 줄(C), 닫힌 윤곽을 돌려준다. caps는 시작·끝을 둥글게 내미는 정도
  function limb(pts, front, caps = [0.8, 0.8]) {
    const L = [], R = [], C = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], d = n2(b.x - a.x, b.y - a.y), n = { x: -d.y, y: d.x };
      const q = pts[i], f = front ? dot2(n, front) : 0;
      const rl = q.r + (f > 0 ? q.fr * f : q.bk * -f), rr = q.r + (f > 0 ? q.bk * f : q.fr * -f);
      L.push({ x: q.x + n.x * rl, y: q.y + n.y * rl }); R.push({ x: q.x - n.x * rr, y: q.y - n.y * rr }); C.push({ x: q.x, y: q.y, n, rl, rr });
    }
    const e = pts[pts.length - 1], e2 = pts[pts.length - 2] ?? e, de = n2(e.x - e2.x, e.y - e2.y);
    const s0 = pts[0], s1 = pts[1] ?? s0, ds = n2(s0.x - s1.x, s0.y - s1.y);
    const outline = [...L, { x: e.x + de.x * e.r * caps[1], y: e.y + de.y * e.r * caps[1] }, ...R.slice().reverse(), { x: s0.x + ds.x * s0.r * caps[0], y: s0.y + ds.y * s0.r * caps[0] }];
    return { L, R, C, outline };
  }
  // 빛 반대쪽 가장자리에 그늘 띠(가운데를 조금 넘는 데까지)
  function shadeLimb(m) {
    if (m.C.length < 2) return;
    const mid = m.C[Math.floor(m.C.length / 2)], leftLit = dot2(mid.n, Ls) > 0, sgn = leftLit ? -1 : 1;
    const outer = leftLit ? m.R : m.L;
    const inner = m.C.map((c) => { const r = (leftLit ? c.rr : c.rl) * 0.12; return { x: c.x + sgn * c.n.x * r, y: c.y + sgn * c.n.y * r }; });
    if (smoothPath([...outer, ...inner.reverse()])) { ctx.fillStyle = FIG_SHADE; ctx.fill(); }
  }

  function drawLeg(side, far) {
    const hipIn = V.add(k.pelvis, V.add(V.mul(V.sub(k.hips[side], k.pelvis), 0.78), [0, -0.03, 0]));   // 다리 윤곽은 엉덩이 관절보다 조금 안쪽·아래에서 시작(엉덩이가 넓어 보이지 않게)
    const knee = k.knees[side], foot = k.feet[side], front = screenDir(knee, ax.fp);
    const pts = [
      ...samples(hipIn, knee, nB, (t) => ({ r: lerp(0.088, 0.06, t), fr: 0.013 * Math.sin(Math.PI * t), bk: 0.005 * Math.sin(Math.PI * t) })),
      ...samples(knee, foot, nB, (t) => ({ r: lerp(0.06, 0.054, t) + (t > 0.85 ? 0.004 : 0), bk: 0.012 * Math.sin(Math.PI * Math.min(1, t * 1.25)) }), 0, 0.64, true),   // 바지는 정강이 64%까지
    ];
    const sock = samples(knee, foot, Math.max(2, nB - 1), (t) => ({ r: lerp(0.045, 0.036, t), bk: 0.006 * (1 - t) }), 0.6, 0.93);
    if (sock.length > 1) { const m = limb(sock, front); fill(m.outline, col('accent')); shadeLimb(m); }
    const m = limb(pts, front);
    fill(m.outline, col(far ? 'pantsShade' : 'pants'), false);
    shadeLimb(m);
    if ((lod >= 1 || ufx) && m.C.length > 2) {   // 바지 바깥 옆줄(보조색): 골반에서 더 먼 쪽 가장자리를 따라간다. 고가 유니폼은 작게 보여도 그린다
      const mid = Math.floor(m.C.length / 2), off = (q) => Math.abs(dot2({ x: q.x - p0.x, y: q.y - p0.y }, perp));
      const outerL = off(m.L[mid]) > off(m.R[mid]), sgn = outerL ? 1 : -1;
      const edge = (u) => m.C.map((c) => { const r = (outerL ? c.rl : c.rr) * u; return { x: c.x + sgn * c.n.x * r, y: c.y + sgn * c.n.y * r }; });
      if (ufx === 'legend') {   // 은은한 금 줄무늬 셋(한 번에 긋는다)과 바깥 옆 금 파이핑
        if (c0.s > 70) {
          ctx.strokeStyle = 'rgba(226,186,80,0.24)'; ctx.lineWidth = Math.max(0.5, 0.0045 * c0.s); ctx.beginPath();
          for (const u of [-0.58, -0.16, 0.26]) m.C.forEach((c, i) => { const r = (c.rl + c.rr) / 2 * u, x = c.x + sgn * c.n.x * r, y = c.y + sgn * c.n.y * r; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.stroke();
        }
        goldCord(edge(0.7), Math.max(0.8, 0.011 * c0.s), side === 'l' ? 0.4 : 1.3, lod === 2);
      } else if (ufx === 'neon') neonLine(edge(0.48), NEON.cyan, Math.max(0.8, 0.009 * c0.s), neonBreath(), lod === 2 ? (side === 'l' ? 0 : 0.8) : null, lod === 2);   // 안쪽으로 들여 번짐도 바지 안
      else {
        const line = edge(0.8);
        ctx.strokeStyle = col('accent'); ctx.lineWidth = Math.max(0.6, 0.009 * c0.s); ctx.lineJoin = 'round';
        ctx.beginPath(); line.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      }
    }
    stroke(m.outline);
    drawShoe2(side);
  }
  // 신발: 엉덩이가 보는 쪽(조금 바깥)으로 놓인 0.27m 스파이크를 3D로 그린다. 상점 신발(fx)은 지금 그림 그대로
  function drawShoe2(side) {
    const f = P(k.feet[side]);
    if (!f) return;
    const fx = fxOf(look.shoe), kicked = (fx || !k.feetDir) && k.soles?.[side] > 0.05;   // 뒤로 차올린 발은 발끝이 아래로 서서 땅에 누운 신발 모양이 맞지 않는다
    const act = fx === 'rocket' || fx === 'bolt' ? shoeAct(side, f) : null;   // 뛸 때 효과가 나는 신발은 빠르기·디딘 때·뒤쪽을 넘긴다(차올린 발도 밑창 대신 효과로 보인다)
    if (fx) drawShoe(f, f.s, k.front ?? batSide(), col, fx, true, act);
    else if (kicked) ellipseAt(f, 0.06 * f.s, 0.12 * f.s, col('shoe'));
    else if (k.feetDir) drawShoeTilt(side);
    else {
      const F = k.feet[side], out = side === 'l' ? ax.lp : V.mul(ax.lp, -1);
      const d = unit3([ax.fp[0] + out[0] * 0.25, 0, ax.fp[2] + out[2] * 0.25]), w = unit3([out[0], 0, out[2]]), y0 = F[1] - 0.05;
      const at = (fwd, lat, up) => P([F[0] + d[0] * fwd + w[0] * lat, y0 + up, F[2] + d[2] * fwd + w[2] * lat]);
      const sole = [at(-0.07, 0.032, 0), at(0.03, 0.046, 0), at(0.14, 0.042, 0), at(0.185, 0.012, 0.012), at(0.185, -0.012, 0.012), at(0.14, -0.042, 0), at(0.03, -0.046, 0), at(-0.07, -0.032, 0), at(-0.085, 0, 0.006)];
      const top = [at(-0.07, 0.03, 0.13), at(0.0, 0.036, 0.12), at(0.09, 0.03, 0.06), at(0.09, -0.03, 0.06), at(0.0, -0.036, 0.12), at(-0.07, -0.03, 0.13)];
      fill(hull([...sole, ...top]), col('shoe'));
      if (lod >= 1) {   // 밑창: 아래 가장자리에 옅은 띠
        const lowS = sole.filter(Boolean), lowT = lowS.map((p) => ({ x: p.x, y: p.y - 0.012 * f.s }));
        if (smoothPath([...lowS, ...lowT.reverse()])) { ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill(); }
      }
    }
    if (kicked && !act) ellipseAt({ x: f.x, y: f.y - 0.03 * f.s }, 0.05 * f.s, 0.1 * f.s, `rgba(232,228,218,${(0.95 * k.soles[side]).toFixed(2)})`);   // 차올린 발의 밑창
  }
  // 뛰는 사람의 신발: 발목 각(k.feetDir)대로 기운다. 뗄 때 발끝이 내려가고, 차올린 발은 밑창이 뒤를 본다(카메라 쪽이면 밑창을 칠한다)
  function drawShoeTilt(side) {
    const F = k.feet[side], fd = k.feetDir[side], out = side === 'l' ? ax.lp : V.mul(ax.lp, -1), fs = P(F)?.s ?? 0;
    const h = unit3([ax.fp[0] + out[0] * 0.25, 0, ax.fp[2] + out[2] * 0.25]), w = unit3([out[0], 0, out[2]]);
    const p = Math.atan2(fd[1], Math.hypot(fd[0], fd[2]) * (V.dot(fd, ax.fp) < 0 ? -1 : 1)), d = V.add(V.mul(h, Math.cos(p)), [0, Math.sin(p), 0]), u = V.add(V.mul(h, -Math.sin(p)), [0, Math.cos(p), 0]);
    const at = (fwd, lat, up) => P(V.add(F, V.add(V.add(V.mul(d, fwd), V.mul(w, lat)), V.mul(u, up - 0.05))));
    const sole = [at(-0.07, 0.032, 0), at(0.03, 0.046, 0), at(0.14, 0.042, 0), at(0.185, 0.012, 0.012), at(0.185, -0.012, 0.012), at(0.14, -0.042, 0), at(0.03, -0.046, 0), at(-0.07, -0.032, 0), at(-0.085, 0, 0.006)];
    const top = [at(-0.07, 0.03, 0.13), at(0.0, 0.036, 0.12), at(0.09, 0.03, 0.06), at(0.09, -0.03, 0.06), at(0.0, -0.036, 0.12), at(-0.07, -0.03, 0.13)];
    fill(hull([...sole, ...top]), col('shoe'));
    if (lod < 1) return;
    const face = -V.dot(u, unit3(V.sub([cam.x, cam.y, cam.z], F)));
    if (face > 0.2) { if (smoothPath(sole)) { ctx.fillStyle = `rgba(232,228,218,${(0.9 * clamp((face - 0.2) / 0.4, 0, 1)).toFixed(2)})`; ctx.fill(); } }
    else if (Math.abs(p) < 0.35) {
      const lowS = sole.filter(Boolean), lowT = lowS.map((q) => ({ x: q.x, y: q.y - 0.012 * fs }));
      if (smoothPath([...lowS, ...lowT.reverse()])) { ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill(); }
    }
  }
  // 뛰는 주자(stride)면 빠르기, 이 발을 디딘 뒤 시간, 발 뒤쪽이 화면에서 어느 쪽인지(0.3m 뒤 점을 비춰 본다). 서 있으면 빠르기 0
  function shoeAct(side, f) {
    const st = k.stride, kn = P(k.knees[side]), up = kn ? n2(kn.x - f.x, kn.y - f.y) : { x: 0, y: -1 }, seed = side === 'l' ? 0 : 1;
    if (!st) return { v: 0, up, seed };
    const b = P(V.sub(k.feet[side], V.mul(st.fwd, 0.3))), d = b ? Math.hypot(b.x - f.x, b.y - f.y) : 0;
    return { v: st.v, age: st[side].age, n: st[side].n, back: d > 0.01 ? { x: (b.x - f.x) / d, y: (b.y - f.y) / d } : { x: -(k.front ?? 1), y: 0 }, fore: Math.min(1, d / (0.3 * f.s)), up, seed };
  }

  function drawArm(side, far) {
    const sh = V.add(k.chest, V.mul(V.sub(k.shoulders[side], k.chest), 0.92)), el = k.elbows[side];
    let hand = k.hands?.[side] ?? k.hand;
    if (!k.hands && !k.noBat && side === 'r') hand = V.add(k.hand, V.mul(V.sub(k.tip, k.hand), 0.1));   // 타자 오른손(위 손)은 왼손보다 배트 끝 쪽
    const wrist = V.add(el, V.mul(V.sub(hand, el), 0.88));
    const upper = (t) => ({ r: lerp(0.058, 0.041, t) });   // 어깨(삼각근)에서 팔꿈치로 가늘어진다
    const pts = [
      ...samples(sh, el, nB, upper),
      ...samples(el, wrist, nB, (t) => ({ r: t < 0.3 ? lerp(0.041, 0.046, t / 0.3) : lerp(0.046, 0.029, (t - 0.3) / 0.7) }), 0, 1, true),   // 아래팔은 팔꿈치 아래가 볼록
    ];
    const arm = limb(pts, null);
    fill(arm.outline, col('sleeve'), false);
    shadeLimb(arm);
    stroke(arm.outline);
    // 상의 반소매: 팔과 같은 굵기(조금 헐렁하게)로 어깨에서 위팔 55%까지, 끝은 평평하게. 팔 윤곽으로 잘라(clip) 칠하면 폰에서 장면 수가 10%쯤 줄었다
    const slv = samples(sh, el, Math.max(2, nB - 1), (t) => ({ r: upper(t * 0.55).r + 0.004 }), 0, 0.55);
    if (slv.length > 1) {
      const m = limb(slv, null, [0.8, 0]);
      fill(m.outline, col(far ? 'shade' : 'jersey'), false);
      shadeLimb(m);
      // 윤곽선은 소매 옆선에만. 어깨 쪽 둥근 끝까지 그으면 위팔이 카메라 쪽을 볼 때(타자 준비 자세) 어깨에 공 두 개가 붙은 것처럼 보였다
      for (const edge of [m.L, m.R]) {
        ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.lineJoin = 'round';
        ctx.beginPath(); edge.slice(1).forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      }
      // 소매 끝 단(보조색 줄)은 소매가 옆으로 누워 보일 때만. 끝에서 본 소매를 가로지르면 끈처럼 보였다
      const e = m.L.length - 1, s0 = slv[0], s1 = slv[slv.length - 1];
      if (lod >= 1 && e > 0 && Math.hypot(s1.x - s0.x, s1.y - s0.y) > 1.6 * s1.r) {
        if (ufx) {   // 고가 유니폼 소매 끝: 금 파이핑·분홍 네온. 끝을 들이고 굵기만큼 소매 쪽으로 옮겨 소매 밖으로 안 나가게
          const d = n2(s0.x - s1.x, s0.y - s1.y), w = Math.max(0.8, 0.009 * c0.s), cut = ufx === 'neon' ? 0.22 : 0.14;
          const cuff = [cut, 1 - cut].map((u) => ({ x: lerp(m.L[e].x, m.R[e].x, u) + d.x * w * 0.8, y: lerp(m.L[e].y, m.R[e].y, u) + d.y * w * 0.8 }));
          if (ufx === 'legend') goldCord(cuff, w, side === 'l' ? 2.1 : 0.9, lod === 2); else neonLine(cuff, NEON.pink, w * 0.85, neonBreath(0.6), null, lod === 2);
        } else {
          ctx.strokeStyle = col('accent'); ctx.lineWidth = Math.max(0.6, 0.008 * c0.s);
          ctx.beginPath(); ctx.moveTo(m.L[e].x, m.L[e].y); ctx.lineTo(m.R[e].x, m.R[e].y); ctx.stroke();
        }
      }
    }
    const hp = k.hands ? P(hand) : null;   // 타자 손은 배트와 함께 그린다
    if (!hp) return;
    if (k.mitt === side) {   // 투수·수비수 글러브: 손목에서 손 쪽으로 누운 타원과 주머니
      const wp = P(wrist), ang = wp ? Math.atan2(hp.y - wp.y, hp.x - wp.x) : 0;
      ctx.save(); ctx.translate(hp.x, hp.y); ctx.rotate(ang);
      ctx.fillStyle = col('glove'); ctx.beginPath(); ctx.ellipse(0.02 * hp.s, 0, 0.11 * hp.s, 0.095 * hp.s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
      ctx.fillStyle = col('pocket'); ctx.beginPath(); ctx.ellipse(0.03 * hp.s, 0.01 * hp.s, 0.055 * hp.s, 0.05 * hp.s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      ellipseAt(hp, 0.036 * hp.s, 0.04 * hp.s, col(k.bare ? 'skin' : 'glove'));
      if (k.ball === side) ellipseAt({ x: hp.x, y: hp.y - 0.03 * hp.s }, 0.037 * hp.s, 0.037 * hp.s, '#ffffff');
    }
  }

  // 몸통 단면: 골반(v=0)에서 가슴(v=1, 어깨 높이)까지 축을 섞어 돌리고, 화면에서 척추에 수직인 방향으로 가장 바깥 두 점을 고른다.
  // extra는 그 높이에서 윤곽에 넣을 3D 점과 반지름(어깨 관절의 삼각근)
  const spine = unit3(V.sub(k.chest, k.pelvis)), spineLen = V.len(V.sub(k.chest, k.pelvis));
  const sp = n2(c0.x - p0.x, c0.y - p0.y), perp = { x: -sp.y, y: sp.x }, N = [8, 10, 14][lod];
  const level = (v, w, d, extra = []) => {
    const t = clamp(v, 0, 1), a = unit3(V.add(V.mul(ax.lp, 1 - t), V.mul(ax.lc, t))), f = unit3(V.add(V.mul(ax.fp, 1 - t), V.mul(ax.fc, t)));
    const c = V.add(k.pelvis, V.mul(spine, spineLen * v));
    let lo = null, hi = null, lv = Infinity, hv = -Infinity;
    const take = (q) => { const pr = dot2(q, perp); if (pr < lv) { lv = pr; lo = q; } if (pr > hv) { hv = pr; hi = q; } };
    for (let i = 0; i < N; i++) {
      const ang = i / N * Math.PI * 2, q = P(V.add(c, V.add(V.mul(a, w * Math.cos(ang)), V.mul(f, d * Math.sin(ang)))));
      if (q) take(q);
    }
    for (const [p3, r] of extra) {
      const q = P(p3);
      if (q) for (const e of [-1, 1]) take({ x: q.x + perp.x * r * q.s * e, y: q.y + perp.y * r * q.s * e, s: q.s });
    }
    return { lo, hi, f };
  };
  const outlineOf = (lvls) => [...lvls.map((l) => l.hi), ...lvls.slice().reverse().map((l) => l.lo)];
  const frontLine = (lvls, sgn) => lvls.map(([v, d]) => P(V.add(V.add(k.pelvis, V.mul(spine, spineLen * v)), V.mul(level(v, 0.01, d).f, sgn * d)))).filter(Boolean);   // 앞(+1)·뒤(-1) 가운데 줄
  function shadeTorso(lvls) {   // 빛 반대쪽 30%에 그늘
    const hiLit = dot2(perp, Ls) > 0, outer = lvls.map((l) => (hiLit ? l.lo : l.hi)), other = lvls.map((l) => (hiLit ? l.hi : l.lo));
    const inner = outer.map((p, i) => (p && other[i] ? { x: lerp(p.x, other[i].x, 0.3), y: lerp(p.y, other[i].y, 0.3) } : null));
    if (smoothPath([...outer, ...inner.reverse()])) { ctx.fillStyle = FIG_SHADE; ctx.fill(); }
  }
  function backDetail() {   // 등이 보이면(타자처럼 크게 보일 때만) 척추 골과 바지 위로 접힌 셔츠 주름
    const camL = k.world ? [cam.x, cam.y, cam.z] : [-batterShift(), cam.y, cam.z];   // 타자 뼈대 좌표에서 본 카메라
    const vis = V.dot(V.mul(ax.fc, -1), unit3(V.sub(camL, k.chest)));
    if (vis < 0.15) return;
    const a = Math.min(1, (vis - 0.15) / 0.3), line = frontLine([[1.04, 0.1], [0.86, 0.128], [0.66, 0.12], [0.42, 0.108], [0.26, 0.112]], -1);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = `rgba(0,0,0,${(0.2 * a).toFixed(3)})`;
    if (line.length > 2) { ctx.lineWidth = 0.012 * c0.s; ctx.beginPath(); line.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); }
    ctx.lineWidth = 0.007 * c0.s;
    for (const [v, u0, u1, sag] of [[0.3, 0.22, 0.62, 0.012], [0.34, 0.45, 0.85, 0.01], [0.27, 0.55, 0.78, 0.008]]) {
      const l = level(v, 0.155, 0.11);
      if (!l.lo || !l.hi) continue;
      const A = { x: lerp(l.lo.x, l.hi.x, u0), y: lerp(l.lo.y, l.hi.y, u0) }, B = { x: lerp(l.lo.x, l.hi.x, u1), y: lerp(l.lo.y, l.hi.y, u1) };
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo((A.x + B.x) / 2 + sp.x * sag * c0.s, (A.y + B.y) / 2 + sp.y * sag * c0.s, B.x, B.y); ctx.stroke();
    }
  }
  function drawTorso() {
    const delt = (up, r) => ['l', 'r'].map((side) => [V.add(V.add(k.chest, V.mul(V.sub(k.shoulders[side], k.chest), 0.92)), V.mul(spine, up)), r]);   // 어깨 관절(삼각근)
    // [v, 단면 반폭, 반두께, 더할 점]. 허리(0.42)가 가슴(0.86)보다 좁고, 1.07~1.16은 어깨에서 목으로 내려오는 승모근 비탈
    const J = (lod === 0 ? [[0.2, 0.158, 0.11], [0.6, 0.168, 0.118], [1.0, 0.19, 0.125, delt(0, 0.05)], [1.16, 0.075, 0.06]]
      : [[0.2, 0.16, 0.112], [0.42, 0.152, 0.108], [0.66, 0.172, 0.12], [0.86, 0.186, 0.128], [1.0, 0.19, 0.125, delt(0, 0.055)], [1.07, 0.16, 0.1, delt(0.03, 0.04)], [1.16, 0.075, 0.06]])
      .map(([v, w, d, ex]) => level(v, w, d, ex));
    const Pn = [[-0.16, 0.15, 0.11], [-0.04, 0.172, 0.125], [0.1, 0.168, 0.118], [0.24, 0.162, 0.114]].map(([v, w, d]) => level(v, w, d));
    const jersey = outlineOf(J);
    fill(jersey, col('jersey'), false);
    shadeTorso(J);
    if (lod === 2) backDetail();
    if (ufx === 'legend' && c0.s > 70) pinstripes([[0.2, 0.155, 0.108], [0.42, 0.147, 0.104], [0.66, 0.167, 0.116], [0.86, 0.18, 0.124], [1.0, 0.184, 0.121], [1.07, 0.155, 0.097]]);
    stroke(jersey);
    if (ufx === 'neon') neonSeams(J, lod === 0 ? 2 : 4);
    fill(outlineOf(Pn), col('pants'));
    shadeTorso(Pn);
    if (ufx === 'legend' && lod === 2) pinstripes([[-0.16, 0.145, 0.106], [-0.04, 0.166, 0.121], [0.1, 0.163, 0.114], [0.24, 0.157, 0.11]]);
    const b1 = level(0.17, 0.168, 0.12), b2 = level(0.235, 0.166, 0.118);   // 벨트
    if (b1.lo && b1.hi && b2.lo && b2.hi) {
      ctx.fillStyle = col('belt'); ctx.beginPath(); ctx.moveTo(b1.lo.x, b1.lo.y); ctx.lineTo(b1.hi.x, b1.hi.y); ctx.lineTo(b2.hi.x, b2.hi.y); ctx.lineTo(b2.lo.x, b2.lo.y); ctx.closePath(); ctx.fill();
      if (ufx === 'neon') neonLine([0.16, 0.84].map((u) => ({ x: lerp(lerp(b1.lo.x, b2.lo.x, 0.5), lerp(b1.hi.x, b2.hi.x, 0.5), u), y: lerp(lerp(b1.lo.y, b2.lo.y, 0.5), lerp(b1.hi.y, b2.hi.y, 0.5), u) })), NEON.pink, Math.max(0.7, 0.007 * c0.s), neonBreath(0.6), null, lod === 2);   // 빛나는 허리띠
    }
    if (!k.plain && lod >= 1) drawBackNumber(k, P, col, jersey);   // 등번호는 새 상의 윤곽 안으로 자른다
    if (k.world && lod >= 1 && V.dot(ax.fc, unit3(V.sub([cam.x, cam.y, cam.z], k.chest))) > 0.25) {   // 앞이 보이면 단추선(보조색). 높이마다 그 높이의 앞면을 따라가서 몸이 꼬이면 같이 휜다
      const line = frontLine([[1.1, 0.09], [0.86, 0.128], [0.66, 0.12], [0.42, 0.108], [0.24, 0.114]], 1);
      if (line.length > 2 && ufx === 'legend') {   // 금장: 금 파이핑 단추선에 금 단추 넷
        goldCord(line, Math.max(0.8, 0.01 * c0.s), 1.7, lod === 2);
        for (const u of [0.18, 0.4, 0.62, 0.84]) { const b = polyPart(line, 0, u).pop(); if (b) ellipseAt(b, 0.011 * c0.s, 0.011 * c0.s, GOLD.light); }
      } else if (line.length > 2 && ufx === 'neon') neonLine(line, NEON.cyan, Math.max(0.8, 0.008 * c0.s), neonBreath(), lod === 2 ? 0.5 : null, lod === 2);
      else if (line.length > 2) {
        ctx.strokeStyle = col('accent'); ctx.lineWidth = Math.max(0.6, 0.012 * c0.s); ctx.lineJoin = 'round';
        ctx.beginPath(); line.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      }
    }
  }
  // ----- 고가 유니폼 무늬(위 '고가 유니폼' 참고) -----
  const camSk = k.world ? [cam.x, cam.y, cam.z] : [-batterShift(), cam.y, cam.z];   // 뼈대 좌표에서 본 카메라(backDetail과 같다)
  const frameAt = (v) => { const t = clamp(v, 0, 1); return { a: unit3(V.add(V.mul(ax.lp, 1 - t), V.mul(ax.lc, t))), f: unit3(V.add(V.mul(ax.fp, 1 - t), V.mul(ax.fc, t))), c: V.add(k.pelvis, V.mul(spine, spineLen * v)) }; };   // level과 같은 단면 축
  // 금장 세로 줄무늬: 단면(반폭 w·반두께 d, 몸통보다 조금 작게) 둘레 18곳을 높이마다 이어 긋고, 그 면이 카메라를 보는 만큼만 진하게 긋는다.
  // 옆으로 돌아간 줄은 옅어지다 사라져서 윤곽 밖으로 안 나가고, 몸이 돌면 줄도 같이 돈다. 진하기 3단계로 묶어 단계마다 한 번에 긋는다(그리기 호출을 줄인다).
  // 뒤쪽 반은 가운데 높이에서 먼저 걸러 점을 만들지 않고, 작게 보이는 주자는 12줄만 긋는다
  function pinstripes(lv) {
    const F = lv.map(([v, w, d]) => ({ ...frameAt(v), w, d })), n = lod === 2 ? 18 : 12, tiers = [[], [], []], M = F[F.length >> 1];
    const see = ({ a, f, c, w, d }, cs, sn, p) => {
      const nx = a[0] * cs / w + f[0] * sn / d, ny = a[1] * cs / w + f[1] * sn / d, nz = a[2] * cs / w + f[2] * sn / d, tx = camSk[0] - p[0], ty = camSk[1] - p[1], tz = camSk[2] - p[2];
      return (nx * tx + ny * ty + nz * tz) / (Math.hypot(nx, ny, nz) * Math.hypot(tx, ty, tz) || 1);
    };
    const at = ({ a, f, c, w, d }, cs, sn) => [c[0] + a[0] * w * cs + f[0] * d * sn, c[1] + a[1] * w * cs + f[1] * d * sn, c[2] + a[2] * w * cs + f[2] * d * sn];
    for (let j = 0; j < n; j++) {
      const th = (j + 0.5) / n * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th), pts = [];
      if (see(M, cs, sn, at(M, cs, sn)) <= 0.3) continue;
      let vis = 1;
      for (const L of F) {
        const p = at(L, cs, sn), q = P(p);
        vis = Math.min(vis, see(L, cs, sn, p));
        if (q) pts.push(q);
      }
      if (vis > 0.3 && pts.length > 1) tiers[vis > 0.6 ? 2 : vis > 0.45 ? 1 : 0].push(pts);
    }
    ctx.lineWidth = Math.max(0.5, 0.0045 * c0.s);
    tiers.forEach((list, i) => {
      if (!list.length) return;
      ctx.strokeStyle = `rgba(226,186,80,${[0.1, 0.2, 0.3][i]})`; ctx.beginPath();
      for (const pts of list) pts.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
    });
  }
  // 네온 이음선: 몸통 윤곽을 가운데로 14% 들인 선(번짐까지 몸 안). 허리에서 옆구리를 따라 어깨 끝(J[sh])까지 청록, 어깨 위에서 목까지 분홍
  function neonSeams(J, sh) {
    const all = J.flatMap((l) => [l.lo, l.hi]).filter(Boolean);
    if (all.length < 4) return;
    const cx = all.reduce((a, p) => a + p.x, 0) / all.length, cy = all.reduce((a, p) => a + p.y, 0) / all.length, w = Math.max(0.8, 0.0095 * c0.s);
    const ins = (p) => p && { x: lerp(p.x, cx, 0.14), y: lerp(p.y, cy, 0.14) }, chains = ['lo', 'hi'].map((e) => J.map((l) => ins(l[e])));
    neonLine(chains.map((ch) => ch.slice(0, sh + 1).filter(Boolean)), NEON.cyan, w, neonBreath(), lod === 2 ? 0.3 : null, lod === 2);
    neonLine(chains.map((ch) => ch.slice(sh).filter(Boolean)), NEON.pink, w, neonBreath(0.6), null, lod === 2);
  }
  // 깃: 목 밑동(v 1.12)을 두르는 고리에서 카메라를 넉넉히 보는 쪽만 잇는다(목을 그린 뒤라 그 반만 목 위에 보인다).
  // 옆으로 비스듬한 양 끝(0.2 아래)은 빼서 번짐이 몸통 윤곽 밖으로 안 나간다
  function collar() {
    const { a, f, c } = frameAt(1.12), n = 20, vis = [], pts = [];
    for (let i = 0; i < n; i++) {
      const th = i / n * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th), p = V.add(c, V.add(V.mul(a, 0.07 * cs), V.mul(f, 0.058 * sn)));
      vis.push(V.dot(unit3(V.add(V.mul(a, cs / 0.07), V.mul(f, sn / 0.058))), unit3(V.sub(camSk, p))) - 0.2); pts.push(p);
    }
    let s = vis.findIndex((x, i) => x > 0 && vis[(i + n - 1) % n] <= 0);
    if (s < 0) { if (vis[0] <= 0) return; s = 0; }
    const ring = [];
    for (let j = 0; j <= n; j++) { const i = (s + j) % n; if (vis[i] <= 0) break; const q = P(pts[i]); if (q) ring.push(q); }
    if (ufx === 'legend') goldCord(ring, Math.max(0.8, 0.012 * c0.s), 0.2, lod === 2);
    else neonLine(ring, NEON.pink, Math.max(0.8, 0.009 * c0.s), neonBreath(0.6), null, lod === 2);
  }

  function drawNeckHead() {
    const up = unit3(V.sub(k.head, k.chest));
    const neck = limb(samples(V.add(k.chest, V.mul(up, 0.1)), V.add(k.head, V.mul(up, -0.07)), 2, (t) => ({ r: lerp(0.06, 0.053, t) })), null);
    fill(neck.outline, col('skin'));
    shadeLimb(neck);
    if (ufx) collar();
    if (k.cap) capHead(); else helmet();
  }
  // 투수·수비수: 얼굴(폭 0.15m), 야구 모자, 이마 높이의 챙. 얼굴이 카메라 반대쪽이면 챙을 먼저, 뒷머리를 그린다
  function capHead() {
    const h = P(k.head);
    if (!h) return;
    const s = h.s, b = k.brim ? P(k.brim) : null;
    const front = k.brim ? V.dot(unit3(V.sub(k.brim, k.head)), unit3(V.sub([cam.x, cam.y, cam.z], k.head))) : 1;
    const brim = () => {   // 챙은 이마 높이(챙 점은 머리 가운데보다 낮아서 그 높이를 쓰면 눈을 가렸다)
      if (b) ellipseAt({ x: lerp(h.x, b.x, 0.8), y: h.y - 0.045 * s }, lerp(0.05, 0.088, Math.abs(front)) * s, 0.022 * s, col('brim'));
    };
    if (front < 0) brim();
    ellipseAt({ x: h.x, y: h.y + 0.005 * s }, 0.074 * s, 0.098 * s, col('skin'));
    if (lod >= 1) {
      if (front < -0.15) ellipseAt({ x: h.x, y: h.y + 0.02 * s }, 0.07 * s, 0.07 * s, FIG_HAIR);
      else {
        if (front > 0.3) for (const e of [-1, 1]) ellipseAt({ x: h.x + e * 0.074 * s, y: h.y + 0.012 * s }, 0.013 * s, 0.022 * s, col('skin'));   // 귀
        ctx.fillStyle = 'rgba(40,20,10,0.14)';   // 챙 바로 밑 그늘(진하면 선글라스처럼 보였다)
        ctx.beginPath(); ctx.ellipse(h.x + (b ? (b.x - h.x) * 0.3 : 0), h.y - 0.04 * s, 0.07 * s, 0.024 * s, 0, 0, Math.PI); ctx.fill();
      }
    }
    ctx.fillStyle = col('helmet'); ctx.beginPath(); ctx.ellipse(h.x, h.y - 0.035 * s, 0.082 * s, 0.072 * s, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
    if (front >= 0) brim();
  }
  // 타자·주자 헬멧(폭 0.21m): 투수 쪽(챙 쪽) 귀 덮개, 반대쪽 귀와 헬멧 아래 뒷머리, 아래쪽 반달 그늘과 위쪽 광택. 동물 헬멧(fx)은 지금 그림을 0.86배로
  function helmet() {
    const h = P(k.head);
    if (!h) return;
    const s = h.s, side = k.side ?? batSide(), brim3 = k.brim ?? V.add(k.head, [0.03, -0.04, 0.12]), b = P(brim3), fx = fxOf(look.helmet);
    if (fx === 'astro') {   // 바이저 쪽을 정하려고 얼굴이 카메라를 보는 정도를 3D로 잰다(타자는 타자 뼈대 좌표의 카메라)
      const camL = k.world ? [cam.x, cam.y, cam.z] : [-batterShift(), cam.y, cam.z];
      drawHelmet(h, s * 0.86, b, col, fx, lod >= 1, side, V.dot(unit3(V.sub(brim3, k.head)), unit3(V.sub(camL, k.head))));
      return;
    }
    if (fx && fx !== 'crown') { drawHelmet(h, s * 0.86, b, col, fx, true, side); return; }   // 왕관은 타격 헬멧 그대로 그리고 위에 얹는다
    const c = col('helmet'), bd = b ? Math.sign(b.x - h.x) || side : side, rx = 0.106 * s, ry = 0.112 * s, cy = h.y - 0.012 * s;
    if (lod >= 1) {
      ellipseAt({ x: h.x - bd * 0.012 * s, y: h.y + 0.08 * s }, 0.062 * s, 0.032 * s, FIG_HAIR);
      ellipseAt({ x: h.x - bd * 0.083 * s, y: h.y + 0.04 * s }, 0.017 * s, 0.03 * s, col('skin'));
    }
    ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(h.x + bd * 0.056 * s, h.y + 0.045 * s, 0.05 * s, 0.07 * s, bd * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
    if (b) ellipseAt(b, 0.085 * b.s, 0.03 * b.s, c);
    ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(h.x, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = FIG_SHADE; ctx.beginPath();   // 반달 그늘: 아래 반 바깥 테두리를 돌고 안쪽 호로 돌아온다(자르기 없이 헬멧 안에만)
    ctx.ellipse(h.x, cy, rx, ry, 0, 0, Math.PI);
    ctx.ellipse(h.x, cy + ry * 0.12, rx * 0.98, ry * 0.5, 0, Math.PI, 0, true);
    ctx.fill();
    ellipseAt({ x: h.x + Ls.x * rx * 0.4, y: cy - ry * 0.5 }, rx * 0.38, ry * 0.2, 'rgba(255,255,255,0.35)');
    if (fx === 'crown') drawCrown(h.x, cy, rx, ry, lod >= 1, side);
  }

  const parts = [];
  for (const side of ['l', 'r']) {   // 깊이(카메라에서 먼 것부터): 다리는 무릎, 팔은 팔꿈치, 몸통은 가슴
    const other = side === 'l' ? 'r' : 'l', far = k.world ? k.shoulders[side][2] > k.shoulders[other][2] : side === 'l';
    parts.push({ depth: k.knees[side][2], draw: () => drawLeg(side, far) });
    parts.push({ depth: k.elbows[side][2], draw: () => drawArm(side, far) });
  }
  parts.push({ depth: k.chest[2], draw: () => { drawTorso(); drawNeckHead(); } });
  if (!k.noBat) parts.push({ depth: Math.min(k.hand[2], k.tip[2]) - 0.01, draw: () => {
    const hp = P(k.hand), tp = P(k.tip), h2 = P(V.add(k.hand, V.mul(V.sub(k.tip, k.hand), 0.1)));
    if (!hp || !tp) return;
    drawBat(hp, tp, 0.034 * hp.s, 0.068 * tp.s, tp.s, col, fxOf(look.bat), true);
    const ang = Math.atan2(tp.y - hp.y, tp.x - hp.x);
    for (const q of [hp, h2]) {   // 장갑 낀 두 손이 배트를 감싸 쥔다(손가락 마디 두 줄)
      if (!q) continue;
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(ang);
      ctx.fillStyle = col('glove'); ctx.beginPath(); ctx.ellipse(0, 0, 0.047 * q.s, 0.042 * q.s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = FIG_LINE; ctx.lineWidth = lw; ctx.stroke();
      if (lod === 2) { ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = Math.max(1, 0.005 * q.s); for (const o of [-0.015, 0.015]) { ctx.beginPath(); ctx.moveTo(o * q.s, -0.035 * q.s); ctx.lineTo(o * q.s, 0.035 * q.s); ctx.stroke(); } }
      ctx.restore();
    }
  } });
  parts.sort((a, b) => b.depth - a.depth).forEach((p) => p.draw());
}
// 타자·주자 발밑 그림자: 골반 아래와 두 발 아래(뜬 발은 옅게). 전에는 몸을 빛 테두리 색으로 한 번 더 그렸다
function drawFigureShadow(k) {
  const G = (p) => (k.world ? project(p[0], 0, p[2]) : batterPoint([p[0], 0, p[2]]));
  for (const [p, rx, ry] of [[k.pelvis, 0.34, 0.06], [k.feet.l, 0.15, 0.05], [k.feet.r, 0.15, 0.05]]) {
    const g = G(p), lift = Math.max(0, p[1] - (p === k.pelvis ? 0.9 : 0.1)), a = 0.16 * Math.max(0, 1 - lift * 2);
    if (g && a > 0.01) ellipseAt(g, rx * g.s, ry * g.s, `rgba(0,0,0,${a.toFixed(3)})`);
  }
}

const SWING_GLOW = { fire: '255,140,50', lightning: '120,200,255', ice: '200,240,255', beam: '0,196,212' };
function drawBatter(tau, pre = null) {
  const k = batterSkeleton(tau, pre);
  // 스윙 잔상: 누른 순간을 맞는 순간으로 보여 줘서 방망이가 한 장면 만에 맞는 자리로 간다. 당긴 자리(-110도)부터 지금까지 지나간 자국을
  // 진하게 남겨 휘두른 것처럼 보이게 한다(2026-11-02 전에는 -80도부터 옅게 그렸다)
  if (tau != null && tau < 0.18) {
    const m = batSide(), hx = k.hand[0] + batterShift(), fx = fxOf(currentLook().bat), fade = 1 - tau / 0.18;
    const band = (r0, r1) => {   // 손에서 r0(바깥)~r1(안쪽) 사이 띠. 바깥은 높이 0.98m, 안쪽 0.3m는 1m
      const y = (r) => lerp(0.98, 1.0, (BAT_LEN - r) / (BAT_LEN - 0.3)), out = [];
      for (let a = -110; a <= k.yaw; a += 8) out.push([m * (hx + r0 * Math.cos(a * DEG)), k.hand[2] + r0 * Math.sin(a * DEG), y(r0)]);
      for (let a = k.yaw; a >= -110; a -= 8) out.push([m * (hx + r1 * Math.cos(a * DEG)), k.hand[2] + r1 * Math.sin(a * DEG), y(r1)]);
      return out;
    };
    if (fx === 'diamond') {   // 다이아몬드는 프리즘처럼 바깥 빨강에서 안쪽 보라까지 여섯 줄 무지개
      for (let j = 0; j < 6; j++) fill3d(band(lerp(BAT_LEN, 0.3, j / 6), lerp(BAT_LEN, 0.3, (j + 1) / 6)), `hsla(${j * 52},95%,62%,${(0.44 * fade).toFixed(3)})`);
    } else {
      const rgb = SWING_GLOW[fx];   // 불꽃·번개·얼음·광선 배트는 잔상도 그 색으로 남는다
      fill3d(band(BAT_LEN, 0.3), `rgba(${rgb ?? '255,255,255'},${(rgb ? 0.48 : 0.34) * fade})`);
      if (fx === 'beam') { ctx.save(); ctx.globalCompositeOperation = 'lighter'; fill3d(band(BAT_LEN, 0.6), `rgba(120,255,250,${(0.42 * fade).toFixed(3)})`); ctx.restore(); }   // 빛 막대가 지나간 바깥쪽은 빛처럼 밝게
    }
  }
  drawFigureShadow(k);
  const C = batterColors();
  drawBatterFigure(k, (name) => C[name], 0);
}

// ===== 효과 배트로 맞힌 순간 =====
// 효과가 있는 배트로 공을 맞히면(파울 포함) 맞은 자리에서 0.5초 동안 그 배트의 효과가 터진다(2026-11-03 사용자 '불 방망이면 불 나오고 얼음 방망이면
// 얼음 나오고'). 판정·점수·소리는 그대로이고 그림만 더한다. 조각은 저장하지 않고 맞을 때 정한 씨앗(seed)으로 장면마다 같은 난수를 다시 뽑아 시간으로
// 자리를 계산한다(장면마다 배열을 만들지 않게). 조각마다 난수를 다 뽑은 뒤 건너뛰어야 다음 조각의 난수가 밀리지 않는다.
// 크기는 맞은 자리의 원근(c.s, 1m가 몇 px)으로 정해 PC·폰이 같은 비율이다. 조각은 공기 저항(tau초)으로 느려지고 g(m/s²)로 떨어진다(음수면 떠오른다)
const BURST_T = 0.5;
const HIT_SPOT = { x: 0, y: 1, z: 0.3 };   // 그림에서 배트가 공을 맞히는 자리(친 공이 여기서 출발한다, flightPos). game.contactPos는 그때 던진 공 자리라 조금 아래·앞이다
const flyAt = (c, ang, v, a, tau, g) => { const d = v * tau * (1 - Math.exp(-a / tau)); return { x: c.x + Math.cos(ang) * d * c.s, y: c.y + Math.sin(ang) * d * c.s + 0.5 * g * a * a * c.s }; };
function radialGlow(c, R, stops) {   // 가운데에서 바깥으로 [위치, 색] 번짐 원
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.fill();
}
const BAT_BURSTS = {
  // 불: 하얗게 달아오른 불덩이가 부풀고, 불길 열 갈래가 사방으로 뻗었다가 위로 휘며 사그라들고, 불티가 떠오르며 흩어진다
  fire(c, a, k, seed) {
    const U = c.s, al = (1 - k) ** 1.2;
    ctx.globalCompositeOperation = 'lighter';
    radialGlow(c, U * (0.09 + 0.27 * easeOut(Math.min(1, k * 1.6))), [[0, `rgba(255,246,200,${al})`], [0.35, `rgba(255,170,50,${0.85 * al})`], [0.7, `rgba(255,70,20,${0.4 * al})`], [1, 'rgba(255,40,0,0)']]);
    ctx.globalCompositeOperation = 'source-over';
    const grow = Math.sin(Math.PI * Math.min(1, k * 1.25)) ** 0.7;
    for (const [rgb, sc] of [['255,84,24', 1], ['255,200,70', 0.56], ['255,248,210', 0.25]]) {
      const r = mulberry32(seed + 11);
      ctx.fillStyle = `rgba(${rgb},${(0.95 * (1 - k) ** 0.7).toFixed(3)})`;
      for (let i = 0; i < 10; i++) {
        const ang = i / 10 * Math.PI * 2 + r() * 0.5, dx = Math.cos(ang), dy = Math.sin(ang), fl = 0.85 + 0.15 * Math.sin(a * 42 + i * 2.3);   // 불은 위로 타서 위쪽 불길이 길다
        const L = U * (0.17 + 0.13 * r()) * grow * (0.45 + 0.55 * sc) * (0.75 - 0.35 * dy) * fl, bw = U * 0.055 * (1 - 0.5 * k) * sc;   // 안쪽 불길일수록 짧고 가늘다
        const tip = { x: c.x + dx * L, y: c.y + dy * L - U * 0.28 * k * k }, mx = c.x + dx * L * 0.5, my = c.y + dy * L * 0.5 - U * 0.08 * k * k;
        ctx.beginPath(); ctx.moveTo(c.x - dy * bw, c.y + dx * bw);
        ctx.quadraticCurveTo(mx - dy * bw * 0.9, my + dx * bw * 0.9, tip.x, tip.y);
        ctx.quadraticCurveTo(mx + dy * bw * 0.9, my - dx * bw * 0.9, c.x + dy * bw, c.y - dx * bw);
        ctx.closePath(); ctx.fill();
      }
    }
    const r = mulberry32(seed + 3);
    ctx.lineWidth = Math.max(1.2, U * 0.009);
    for (let i = 0; i < 18; i++) {
      const ang = r() * Math.PI * 2, v = 2.5 + 3.2 * r(), life = 0.55 + 0.45 * r(), gg = 90 + Math.round(120 * r()), kk = k / life;
      if (kk >= 1) continue;
      const p = flyAt(c, ang, v, a, 0.22, -2.4), q = flyAt(c, ang, v, Math.max(0, a - 0.04), 0.22, -2.4);
      ctx.strokeStyle = `rgba(255,${gg + 100},${gg - 40},${(1 - kk).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
  },
  // 얼음: 서리 안개가 퍼지고 찬 고리가 번지며, 얼음 조각이 돌며 튀어 떨어지고 눈송이가 천천히 흩날린다
  ice(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 5);
    radialGlow(c, U * (0.12 + 0.34 * easeOut(k)), [[0, `rgba(236,250,255,${0.6 * (1 - k)})`], [0.55, `rgba(200,236,255,${0.32 * (1 - k)})`], [1, 'rgba(190,230,255,0)']]);
    const kr = Math.min(1, k * 2.2);
    if (kr < 1) { ctx.strokeStyle = `rgba(235,250,255,${(0.9 * (1 - kr)).toFixed(3)})`; ctx.lineWidth = Math.max(1, U * 0.016 * (1 - kr)); ctx.beginPath(); ctx.arc(c.x, c.y, U * 0.44 * easeOut(kr), 0, Math.PI * 2); ctx.stroke(); }
    if (k < 0.45) {   // 얼음 가시: 가운데에서 결정이 순식간에 솟았다가 깨져 사라진다
      const L = U * 0.2 * easeOut(Math.min(1, k / 0.12)) * (1 - Math.max(0, (k - 0.25) / 0.2)), w = U * 0.028;
      for (let i = 0; i < 8; i++) {
        const an = i / 8 * Math.PI * 2 + 0.2, dx = Math.cos(an), dy = Math.sin(an), l = L * (i % 2 ? 0.65 : 1);
        const tip = { x: c.x + dx * l, y: c.y + dy * l };
        ctx.fillStyle = 'rgba(200,238,255,0.92)'; ctx.beginPath(); ctx.moveTo(c.x - dy * w, c.y + dx * w); ctx.lineTo(tip.x, tip.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(110,185,235,0.92)'; ctx.beginPath(); ctx.moveTo(c.x + dy * w, c.y - dx * w); ctx.lineTo(tip.x, tip.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill();
      }
    }
    const fade = 1 - Math.max(0, (k - 0.6) / 0.4);
    for (let i = 0; i < 13; i++) {   // 길쭉한 마름모 조각: 한쪽 면은 밝게, 한쪽은 푸르게
      const ang = r() * Math.PI * 2, v = 2.2 + 2.8 * r(), rot = r() * Math.PI + (r() - 0.5) * 14 * a, l = U * (0.03 + 0.045 * r());
      const p = flyAt(c, ang, v, a, 0.3, 4.5), ca = Math.cos(rot), sa = Math.sin(rot), w = l * 0.34;
      const t1 = { x: p.x + ca * l, y: p.y + sa * l }, t2 = { x: p.x - ca * l * 0.6, y: p.y - sa * l * 0.6 };
      ctx.fillStyle = `rgba(244,253,255,${fade.toFixed(3)})`; ctx.beginPath(); ctx.moveTo(t1.x, t1.y); ctx.lineTo(p.x - sa * w, p.y + ca * w); ctx.lineTo(t2.x, t2.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(120,196,240,${fade.toFixed(3)})`; ctx.beginPath(); ctx.moveTo(t1.x, t1.y); ctx.lineTo(p.x + sa * w, p.y - ca * w); ctx.lineTo(t2.x, t2.y); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = `rgba(255,255,255,${(1 - k).toFixed(3)})`;
    for (let i = 0; i < 7; i++) {   // 눈송이: 여섯 갈래
      const ang = r() * Math.PI * 2, v = 0.8 + 1.4 * r(), rot = r() * Math.PI + a * 2.5, sz = U * (0.016 + 0.012 * r()), p = flyAt(c, ang, v, a, 0.5, 0.7);
      ctx.lineWidth = Math.max(0.8, sz * 0.2); ctx.beginPath();
      for (let j = 0; j < 3; j++) { const an = rot + j * Math.PI / 3, dx = Math.cos(an) * sz, dy = Math.sin(an) * sz; ctx.moveTo(p.x - dx, p.y - dy); ctx.lineTo(p.x + dx, p.y + dy); }
      ctx.stroke();
    }
  },
  // 번개: 푸른 번쩍임과 함께 가운데에서 사방으로 지그재그 전기가 뻗고(0.05초마다 모양이 바뀐다), 작은 불꽃이 튄다
  lightning(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 7), rj = mulberry32(seed + 1000 + Math.floor(a * 20) * 37), grow = Math.min(1, a / 0.06), al = (1 - k) * (0.75 + 0.25 * rj());
    ctx.globalCompositeOperation = 'lighter';
    radialGlow(c, U * (0.2 + 0.12 * k), [[0, `rgba(235,245,255,${(1 - k) ** 2})`], [0.35, `rgba(120,190,255,${0.5 * (1 - k) ** 2})`], [1, 'rgba(80,150,255,0)']]);
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const ang = i / 7 * Math.PI * 2 + r() * 0.6, L = U * (0.3 + 0.26 * r()) * grow, dx = Math.cos(ang), dy = Math.sin(ang);
      let br = null;
      ctx.moveTo(c.x, c.y);
      for (let j = 1; j <= 6; j++) {
        const d = L * j / 6, off = (rj() - 0.5) * U * 0.075 * (j < 6 ? 1 : 0.4), x = c.x + dx * d - dy * off, y = c.y + dy * d + dx * off;
        ctx.lineTo(x, y);
        if (j === 3) br = { x, y };
      }
      const ba = ang + (rj() > 0.5 ? 0.7 : -0.7), bl = L * 0.35;   // 가지 하나
      ctx.moveTo(br.x, br.y); ctx.lineTo(br.x + Math.cos(ba) * bl * 0.5 + (rj() - 0.5) * U * 0.04, br.y + Math.sin(ba) * bl * 0.5 + (rj() - 0.5) * U * 0.04); ctx.lineTo(br.x + Math.cos(ba) * bl, br.y + Math.sin(ba) * bl);
    }
    ctx.strokeStyle = `rgba(110,190,255,${(0.6 * al).toFixed(3)})`; ctx.lineWidth = Math.max(2.5, U * 0.022); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${al.toFixed(3)})`; ctx.lineWidth = Math.max(1, U * 0.007); ctx.stroke();
    for (let i = 0; i < 9; i++) {
      const ang = r() * Math.PI * 2, v = 3.5 + 3 * r(), p = flyAt(c, ang, v, a, 0.15, 2), rr = Math.max(0.8, U * 0.008);
      ellipseAt(p, rr, rr, `rgba(200,235,255,${(1 - k).toFixed(3)})`);
    }
  },
  // 뿅망치: 만화처럼 노란 톱니 별이 튀어나왔다가(살짝 넘쳤다 돌아온다) 끝에 줄며 사라지고, 가운데에 '뿅!', 색색의 작은 별이 돌며 튄다
  hammer(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 9), al = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    const pop = k < 0.14 ? easeOut(k / 0.14) * 1.2 : k < 0.28 ? lerp(1.2, 1, (k - 0.14) / 0.14) : k > 0.7 ? 1 - 0.45 * (k - 0.7) / 0.3 : 1, R = U * 0.17 * pop, rot = 0.15 + 0.3 * k;
    ctx.globalAlpha = al;
    if (k < 0.4) {   // 튀어 나가는 선
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.2, U * 0.01); ctx.beginPath();
      for (let i = 0; i < 10; i++) { const an = i / 10 * Math.PI * 2 + 0.3, r0 = R * 1.15 + U * 0.25 * k, r1 = r0 + U * 0.08 * (1 - k / 0.4); ctx.moveTo(c.x + Math.cos(an) * r0, c.y + Math.sin(an) * r0); ctx.lineTo(c.x + Math.cos(an) * r1, c.y + Math.sin(an) * r1); }
      ctx.stroke();
    }
    const star = (sc) => { ctx.beginPath(); for (let i = 0; i < 14; i++) { const an = rot + i / 14 * Math.PI * 2, rr = R * sc * (i % 2 ? 0.58 : 1 - 0.12 * ((i * 7) % 3) / 2); ctx[i ? 'lineTo' : 'moveTo'](c.x + Math.cos(an) * rr, c.y + Math.sin(an) * rr); } ctx.closePath(); };
    star(1); ctx.fillStyle = '#ffe14d'; ctx.fill(); ctx.strokeStyle = '#e0393e'; ctx.lineWidth = Math.max(1.5, U * 0.012); ctx.stroke();
    star(0.6); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill();
    ctx.font = font(R * 0.62, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, R * 0.08); ctx.strokeStyle = '#ffffff'; ctx.strokeText('뿅!', c.x, c.y + R * 0.04); ctx.fillStyle = '#e0393e'; ctx.fillText('뿅!', c.x, c.y + R * 0.04);
    const cols = ['#ffd23f', '#ff6fa8', '#5fd3ff', '#ffffff', '#8cf06a'];
    for (let i = 0; i < 9; i++) {
      const ang = r() * Math.PI * 2, v = 2.4 + 2.4 * r(), spin = (r() - 0.5) * 12, sz = U * (0.024 + 0.02 * r()), p = flyAt(c, ang, v, a, 0.25, 1.5);
      drawStar(p.x, p.y, sz * (1 - 0.3 * k), spin * a, cols[i % cols.length]);
    }
    ctx.globalAlpha = 1;
  },
  // 대파: 초록 즙이 튀고, 길쭉한 파잎 조각이 팔랑이며 날아가 떨어지고, 흰 줄기 토막이 굴러 떨어진다
  leek(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 13);
    radialGlow(c, U * (0.1 + 0.2 * easeOut(k)), [[0, `rgba(205,240,150,${0.55 * (1 - k) ** 2})`], [1, 'rgba(120,200,80,0)']]);   // 초록 즙 번짐
    if (k < 0.35) {
      const kk = k / 0.35;
      ctx.strokeStyle = `rgba(170,230,110,${(1 - kk).toFixed(3)})`; ctx.lineWidth = Math.max(1.2, U * 0.012); ctx.beginPath();
      for (let i = 0; i < 10; i++) { const an = i / 10 * Math.PI * 2 + 0.2, r0 = U * (0.05 + 0.2 * easeOut(kk)), r1 = r0 + U * 0.07 * (1 - kk); ctx.moveTo(c.x + Math.cos(an) * r0, c.y + Math.sin(an) * r0); ctx.lineTo(c.x + Math.cos(an) * r1, c.y + Math.sin(an) * r1); }
      ctx.stroke();
    }
    const fade = 1 - Math.max(0, (k - 0.65) / 0.35), greens = ['#46a83c', '#2f8a2c', '#7cc95a'];
    for (let i = 0; i < 14; i++) {
      const ang = -Math.PI / 2 + (r() - 0.5) * Math.PI * 1.7, v = 2 + 2.8 * r(), rot = r() * Math.PI + (r() - 0.5) * 16 * a + 0.5 * Math.sin(a * 18 + i), len = U * (0.07 + 0.07 * r());
      const p = flyAt(c, ang, v, a, 0.35, 5), ca = Math.cos(rot) * len / 2, sa = Math.sin(rot) * len / 2, w = 0.3;
      ctx.globalAlpha = fade; ctx.fillStyle = greens[i % 3];
      ctx.beginPath(); ctx.moveTo(p.x - ca, p.y - sa); ctx.quadraticCurveTo(p.x - sa * w * 2, p.y + ca * w * 2, p.x + ca, p.y + sa); ctx.quadraticCurveTo(p.x + sa * w * 2, p.y - ca * w * 2, p.x - ca, p.y - sa); ctx.fill();
      ctx.strokeStyle = 'rgba(220,245,190,0.8)'; ctx.lineWidth = Math.max(0.6, len * 0.05); ctx.beginPath(); ctx.moveTo(p.x - ca * 0.8, p.y - sa * 0.8); ctx.lineTo(p.x + ca * 0.8, p.y + sa * 0.8); ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI / 2 + (r() - 0.5) * Math.PI * 1.4, v = 1.6 + 1.6 * r(), rot = r() * Math.PI + (r() - 0.5) * 10 * a, p = flyAt(c, ang, v, a, 0.4, 7), l = U * 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(rot); roundRect(-l, -l * 0.45, l * 2, l * 0.9, l * 0.4); ctx.fillStyle = '#f3f1e0'; ctx.fill(); ctx.strokeStyle = '#b9cf8c'; ctx.lineWidth = Math.max(0.6, l * 0.12); ctx.stroke(); ctx.restore();
    }
    ctx.globalAlpha = 1;
  },
  // 광선: 하얀 번쩍임과 청록 빛 고리 두 개가 퍼지고, 가로로 긴 빛줄기(렌즈 플레어)가 지나가며 빛 알갱이가 빠르게 튄다
  beam(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 15);
    ctx.globalCompositeOperation = 'lighter';
    radialGlow(c, U * 0.24 * (1 + 0.5 * k), [[0, `rgba(255,255,255,${(1 - k) ** 2})`], [0.3, `rgba(${BEAM_RGB},${0.65 * (1 - k) ** 2})`], [1, `rgba(${BEAM_RGB},0)`]]);
    for (const j of [0, 1]) {
      const kk = (a - j * 0.08) / 0.36;
      if (kk <= 0 || kk >= 1) continue;
      const rr = U * (0.05 + 0.52 * easeOut(kk));
      ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${BEAM_RGB},${(0.5 * (1 - kk)).toFixed(3)})`; ctx.lineWidth = U * 0.045 * (1 - kk) + 1; ctx.stroke();
      ctx.strokeStyle = `rgba(230,255,255,${(1 - kk).toFixed(3)})`; ctx.lineWidth = Math.max(0.8, U * 0.01 * (1 - kk)); ctx.stroke();
    }
    const fl = (1 - k) ** 1.5, hl = U * 0.8 * easeOut(Math.min(1, k * 3)), th = Math.max(0.8, U * 0.014 * (1 - k));
    for (const [w, h] of [[hl, th], [th, hl * 0.32]]) {   // 가로 빛줄기와 짧은 세로 빛줄기
      const g = w > h ? ctx.createLinearGradient(c.x - w, 0, c.x + w, 0) : ctx.createLinearGradient(0, c.y - h, 0, c.y + h);
      g.addColorStop(0, `rgba(${BEAM_RGB},0)`); g.addColorStop(0.5, `rgba(235,255,255,${fl.toFixed(3)})`); g.addColorStop(1, `rgba(${BEAM_RGB},0)`);
      ctx.fillStyle = g; ctx.fillRect(c.x - w, c.y - h, w * 2, h * 2);
    }
    ctx.lineWidth = Math.max(1, U * 0.008);
    for (let i = 0; i < 10; i++) {
      const ang = r() * Math.PI * 2, v = 4 + 4.5 * r(), p = flyAt(c, ang, v, a, 0.14, 0), q = flyAt(c, ang, v, Math.max(0, a - 0.03), 0.14, 0);
      ctx.strokeStyle = `rgba(150,250,255,${(1 - k).toFixed(3)})`; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
  },
  // 다이아몬드: 가운데 큰 네 갈래 반짝임, 반지름이 조금씩 다른 다섯 색 고리(분산)가 퍼지고, 무지개빛 반짝이와 작은 결정 조각이 흩어지며 깜빡인다
  diamond(c, a, k, seed) {
    const U = c.s, r = mulberry32(seed + 17);
    ctx.globalCompositeOperation = 'lighter';
    const s1 = U * 0.22 * (k < 0.08 ? k / 0.08 : (1 - k) ** 1.1);
    radialGlow(c, s1 * 0.8, [[0, `rgba(255,255,255,${0.8 * (1 - k)})`], [1, 'rgba(200,235,255,0)']]);
    drawSparkle(c, s1, 'rgba(255,255,255,0.95)');
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(Math.PI / 4); drawSparkle({ x: 0, y: 0 }, s1 * 0.55, 'rgba(210,240,255,0.85)'); ctx.restore();
    const kr = Math.min(1, k * 1.6), rr = U * (0.06 + 0.44 * easeOut(kr));
    ctx.lineWidth = Math.max(0.8, U * 0.008);
    if (kr < 1) for (let j = 0; j < 5; j++) { ctx.strokeStyle = `hsla(${j * 65},100%,65%,${(0.85 * (1 - kr)).toFixed(3)})`; ctx.beginPath(); ctx.arc(c.x, c.y, rr * (1 + j * 0.05), 0, Math.PI * 2); ctx.stroke(); }
    for (let i = 0; i < 14; i++) {
      const ang = r() * Math.PI * 2, v = 1.4 + 2.4 * r(), hue = Math.floor(r() * 360), ph = r() * 6, p = flyAt(c, ang, v, a, 0.35, 0.6);
      const tw = 0.55 + 0.45 * Math.sin(a * 28 + ph);
      drawSparkle(p, U * 0.034 * tw * (1 - 0.4 * k), `hsla(${hue},100%,78%,${(1 - k).toFixed(3)})`);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 6; i++) {
      const ang = r() * Math.PI * 2, v = 2 + 2 * r(), rot = r() * Math.PI + a * 8, p = flyAt(c, ang, v, a, 0.3, 3), l = U * 0.022, ca = Math.cos(rot) * l, sa = Math.sin(rot) * l;
      ctx.fillStyle = `rgba(215,244,255,${(1 - k).toFixed(3)})`; ctx.beginPath(); ctx.moveTo(p.x + ca, p.y + sa); ctx.lineTo(p.x - sa * 0.55, p.y + ca * 0.55); ctx.lineTo(p.x - ca, p.y - sa); ctx.lineTo(p.x + sa * 0.55, p.y - ca * 0.55); ctx.closePath(); ctx.fill();
    }
  },
};
// 효과 하나: b는 { fx, t, seed }, c는 맞은 자리(화면), a는 맞은 뒤 지난 초
function drawBatBurst(b, c, a) {
  const f = BAT_BURSTS[b.fx];
  if (!f || a < 0 || a >= BURST_T) return;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  f(c, a, a / BURST_T, b.seed);
  ctx.restore();
}

// 타자의 준비 동작(2026-11-02): 투수가 공을 놓으면(공 시각 0) 공이 반쯤 올 때까지 손을 당기고 앞발을 내디딘다.
// 공을 그냥 보내면 0.35초 동안 풀어 준다. 기다리는 동안은 방망이를 까딱인다(idle은 화면 시계)
function batterPre(tb, p, time) {
  if (!p || tb < 0) return { idle: time, load: 0 };
  if (tb <= p.T) return { idle: time, load: smooth(tb / (p.T * 0.5)) };
  return { idle: time, load: 1 - smooth((tb - p.T) / 0.35) };
}

// ===== 주자 그리기 =====
// 친 타자 주루 계획은 sim/batter.js, 지금 자리는 sim/runner.js, 뛰는 자세는 sim/runpose.js
// 지금 그릴 누상 주자들. 공을 던지는 동안은 리드한 자리에 서 있고, 결과가 나오면 계획대로 뛴다
function scenarioRunners() {
  if (game.mode !== 'scenario' || !game.scn || !['windup', 'pitch', 'result'].includes(game.state)) return [];
  const r = game.state === 'result' ? game.outcome : null;
  if (!r || game.replay != null) return game.scn.bases.flatMap((on, b) => (on ? [standingRunner(leadAt(b))] : []));
  return baseRunnersAt(scenarioRuns(r), game.flightT);
}
// 발을 찰 때 남는 흙(전력 질주만). 먼지는 0.45초 동안 뒤로 퍼지며 옅어지고, 흙덩이 셋이 뒤(카메라 쪽)로 튀어 떨어진다.
// 뒤에서 볼 때 빠르게 달리는 것이 보이는 신호다
function runDust(run) {
  const G = run.gait ?? SPRINT, tr = run.track, out = [];
  if (run.slide) {
    const { rest, down } = run.slide, k = run.speed > 0.1 ? clamp(run.speed / 6, 0.3, 1) * down : Math.max(0, 1 - rest / 0.7), grow = 1 + 1.5 * clamp(rest / 0.7, 0, 1);
    if (k <= 0) return out;
    for (const [a, b, r0] of [[0.9, 0.15, 0.22], [0.55, -0.2, 0.28], [0.1, 0.25, 0.3], [-0.3, -0.1, 0.26]]) {   // 몸을 따라 앞(발)에서 뒤(어깨)까지
      out.push({ x: run.x + run.dir[0] * a - run.dir[1] * b, y: 0.12 + 0.1 * grow, z: run.z + run.dir[1] * a + run.dir[0] * b, r: r0 * grow, alpha: 0.42 * k });
    }
    return out;
  }
  if (run.dive) {   // 머리부터 슬라이딩: 배가 땅에 닿으면(진행 0.6부터) 몸을 따라 흙먼지가 일고, 멈춘 뒤 0.7초에 걸쳐 퍼지며 가라앉는다
    const { u, rest } = run.dive, k = rest > 0 ? Math.max(0, 1 - rest / 0.7) : clamp(run.speed / 6, 0.3, 1) * smooth((u - 0.6) / 0.25), grow = 1 + 1.5 * clamp(rest / 0.7, 0, 1);
    if (k <= 0) return out;
    for (const [a, b, r0] of [[1.0, 0.1, 0.22], [0.5, -0.18, 0.28], [-0.05, 0.2, 0.3], [-0.6, -0.08, 0.26]]) {   // 몸을 따라 앞(손)에서 뒤(발)까지
      out.push({ x: run.x + run.dir[0] * a - run.dir[1] * b, y: 0.12 + 0.1 * grow, z: run.z + run.dir[1] * a + run.dir[0] * b, r: r0 * grow, alpha: 0.42 * k });
    }
    return out;
  }
  if (!G.dust || run.t == null) return out;
  const l = [-run.dir[1], run.dir[0]];
  for (const [off, side] of [[0, 1], [0.5, -1]]) {
    const n0 = Math.floor(run.ph + off);
    for (let n = n0; n > n0 - 3; n--) {
      const st = runStep(tr, G, n, off), i = phaseIndex(tr, n - off + st.D), age = run.t - tr.T[i], v0 = tr.V[i];   // 그 발을 뗀 때
      if (age < 0 || age > 0.45 || v0 < 3) continue;
      const p = alongRoute(run.route, plantDist(tr, n, off, st)), x0 = p[0] + l[0] * side * 0.1, z0 = p[1] + l[1] * side * 0.1, back = 0.1 + 0.8 * age, strong = clamp((v0 - 3) / 3, 0, 1);
      out.push({ x: x0 - run.dir[0] * back, y: 0.05 + 0.25 * age, z: z0 - run.dir[1] * back, r: 0.07 + 0.4 * age, alpha: 0.36 * (1 - age / 0.45) * strong });
      if (age > 0.35) continue;
      for (let j = 0; j < 3; j++) {   // 흙덩이: 걸음마다 같은 모양(걸음 번호로 정한 난수)
        const rnd = (m) => { const x = Math.sin((n * 7.13 + off * 3.7 + j * 1.91 + m * 0.37) * 12.9898) * 43758.5453; return x - Math.floor(x); };
        const sp = 1.6 + 0.9 * rnd(1), up = 1.3 + 0.9 * rnd(2), lat = (rnd(3) - 0.5) * 0.7;
        const y = 0.04 + up * age - 4.9 * age * age;
        if (y < 0) continue;
        out.push({ clod: true, x: x0 - run.dir[0] * sp * age + l[0] * lat * age, y, z: z0 - run.dir[1] * sp * age + l[1] * lat * age, r: 0.022, alpha: 0.85 * (1 - age / 0.35) * strong });
      }
    }
  }
  return out;
}
function drawDust(d) {
  const p = project(d.x, d.y, d.z);
  if (!p) return;
  if (d.clod) { ellipseAt(p, Math.max(0.8, d.r * p.s), Math.max(0.8, d.r * p.s), `rgba(120,86,56,${d.alpha.toFixed(3)})`); return; }
  ellipseAt(p, d.r * p.s, 0.55 * d.r * p.s, `rgba(201,163,120,${d.alpha.toFixed(3)})`);
  ellipseAt({ x: p.x, y: p.y - 0.3 * d.r * p.s }, 0.6 * d.r * p.s, 0.4 * d.r * p.s, `rgba(216,186,150,${(0.7 * d.alpha).toFixed(3)})`);
}
// 뼈대 전체를 x로 dx만큼 옮긴다(폰 그림 이동)
function shiftSkeleton(k, dx) {
  if (!dx) return k;
  const m = (q) => [q[0] + dx, q[1], q[2]], LR = (q) => ({ l: m(q.l), r: m(q.r) });
  return { ...k, pelvis: m(k.pelvis), chest: m(k.chest), head: m(k.head), brim: m(k.brim), hand: m(k.hand), tip: m(k.tip),
    hips: LR(k.hips), shoulders: LR(k.shoulders), knees: LR(k.knees), feet: LR(k.feet), elbows: LR(k.elbows), hands: LR(k.hands) };
}
function drawRunner(run) {
  const k = shiftSkeleton(runnerSkeleton(run), run.drawShift), C = batterColors(), dust = runDust(run);
  dust.filter((d) => d.z > run.z).forEach(drawDust);   // 주자보다 먼 먼지는 주자 뒤에
  drawFigureShadow(k);
  drawBatterFigure(k, (name) => C[name], 0);
  dust.filter((d) => d.z <= run.z).forEach(drawDust);
}
// 놓은 방망이: 스윙을 마친 손 높이에서 0.3초 동안 돌며 떨어져 타석 옆 땅에 눕는다
function drawDroppedBat(t) {
  const sd = batSide(), x0 = sd * (BATTER_X + batterShift() + 0.35), k = smooth((t - runStartOf(batsOf(game.outcome))) / 0.3);
  const a0 = [sd * (BATTER_X + batterShift() - 0.1), 1.45, 0.45], b0 = [sd * (BATTER_X + batterShift() - 0.5), 1.9, 0.9];   // 놓을 때 방망이(손 → 끝)
  const a1 = [x0, 0.04, 0.1], b1 = [x0 + sd * 0.6, 0.04, -0.45];
  const A = [0, 1, 2].map((i) => lerp(a0[i], a1[i], k)), B = [0, 1, 2].map((i) => lerp(b0[i], b1[i], k));
  const a = project(A[0], A[1], A[2]), b = project(B[0], B[1], B[2]);
  if (!a || !b) return;
  const C = batterColors();
  drawBat(a, b, 0.034 * a.s, 0.068 * b.s, b.s, (n) => C[n], fxOf(currentLook().bat), true);
}

// ===== 맞은 공 =====

// 공이 화면 밖으로 나가지 않게 카메라를 따라 돌린다(전체를 평행 이동)
// 화면이 따라갈 점: 공(송구 때는 받는 사람). 안타·홈런은 공 처리가 끝나면 친 타자를 따라가서 1루·2루에 닿거나 베이스를 도는 모습이 보인다(2026-11-02)
// 주자를 따라갈 때는 주자 몸이 아니라 가는 베이스 쪽을 앞서 잡아서, 주자가 화면 안을 달려 베이스로 들어가는 모습이 보이게 한다.
// 몸을 잡으면 화면 끝에 붙은 채 제자리에서 뛰는 것처럼 보였다(2026-11-02 사용자 '뒤에서 보니 안 달리는 느낌'). 앞서 잡는 거리는 화면 폭의 22%까지
function cameraFocus(r, t) {
  const play = fieldPlay(r), run = r.hit && t > play.end + 0.3 ? runnerAt(r, t) : null;
  if (!run) return play.focus(t);
  const goal = (run.goals.find((q) => q.at > run.dist + 0.3) ?? run.goals[run.goals.length - 1]).p, dx = goal[0] - run.x, dz = goal[1] - run.z, d = Math.hypot(dx, dz);
  const lead = d < 0.01 ? 0 : Math.min(0.5 * d, 0.22 * view.w * Math.max(1, run.z - cam.z) / view.f) / d;
  return { x: run.x + dx * lead, y: 1.2, z: run.z + dz * lead };
}
// 따라갈 타구: 홈런, 또는 페어 지역의 뜬공·직선타 중 비거리 70m 이상. 땅볼·파울·1루 승부·다시 보기는 타석 시점 그대로
const CHASE = { start: 0.25, rise: 0.5, backStart: 18, minBack: 8, lift: 0.8, k: 3.5, maxZ: 40, pace: 0.5, hrStop: 28, flyStop: 14, hold: 0.35, minDist: 70, ballMin: 0.006, zoneFade: 1.2 };
const chaseable = (r) => !!r && !r.took && r.kind !== 'whiff' && r.kind !== 'foul' && Math.abs(r.spray ?? 99) <= 45
  && (r.kind === 'hr' || ((r.type === 'fly' || r.type === 'line') && r.dist >= CHASE.minDist));
// 카메라가 갈 자리. 맞은 뒤 0.25초는 타석 시점(스윙·맞는 순간)이고, 그 뒤 타석 카메라에서 공이 떨어질 곳으로 가는 수평 직선 위를 나아간다
// (떨어질 곳은 타석에서 볼 때와 같은 쪽 화면에 남고, 좌우 나머지는 화면 밀기가 맞춘다). 공 뒤 거리는 처음 18m에서 떨어질 곳에 가까워질수록 8m까지
// 줄이고(높이 뜬 공에 너무 붙으면 방향이 고정이라 공이 위 시야 밖으로 나간다), 높이는 공 높이의 0.8배만큼 올린다. 홈런은 담장 28m 앞,
// 뜬공은 떨어질 곳 14m 앞이 마지막 자리이고 z 40m를 넘지 않는다(60m에서는 흐린 관중이 화면을 채웠다). 공이 떨어지면(잡히면, 홈런은 관중석에 들어가면)
// 0.35초 뒤 돌아오는 장면 없이 끊는다(2026-11-02 사용자 '공 떨어지는 것까지만, 돌아오는 것은 안 보여 줘도'). null이면 바로 타석 시점.
// 다듬기(2026-11-05 사용자 결정): 마지막 자리까지는 공이 떨어질 때 닿게 나눠 간다(공이 떨어질 때까지 지난 시간 비율 u의 CHASE.pace제곱만큼.
// 전에는 2초쯤 z 40m에 닿아 공이 떨어질 때까지 1.4~3초 같은 화면이었다). 높이는 처음 CHASE.rise초에 걸쳐 따라붙는다(전에는 앞으로 가기 전에
// 0.1초 사이 2m를 솟아 타자가 화면 아래로 휙 빠졌다)
// 공이 떨어지는 때(맞은 뒤 초): 잡히거나, 홈런은 관중석에 들어가 감춰지거나, 땅에 닿을 때
function chaseLand(r) {
  if (r.chaseLand !== undefined) return r.chaseLand;
  const T = flightDuration(r), play = fieldPlay(r);
  let land = r.kind === 'out' ? catchTime(r) : T;
  if (r.kind === 'hr') for (let t = 0; t < T; t += 1 / 60) if (play.ball(t).hidden) { land = t; break; }
  return (r.chaseLand = land);
}
function chaseEnd(r) { return chaseLand(r) + CHASE.hold; }
// 결과를 알리는 때(resultT): 함성·결과 제목·HIT·HOMERUN·아래 카드·위 점수판 불과 점수. 수비가 정하는 때(fieldPlay의 reveal, 2.6초 상한)이고,
// 카메라가 공 뒤로 날아가는 타구는 공이 떨어지고 타석 시점으로 돌아올 때(chaseEnd)까지 기다린다(2026-11-05 사용자 결정. 전에는 2.6초에
// 아래 카드·위 점수·함성이 공이 아직 날아가는 중에 먼저 나오고 HOMERUN·제목은 돌아온 뒤라 결과가 두 번에 나뉘었다). 이때 안타 함성만은
// 0.35초 앞, 공이 떨어질 때 낸다(update. 2026-11-03 결정 '공이 관중석에 들어가거나 떨어질 때 함성, 돌아오면 HOMERUN과 제목')
function revealOf(r) {
  const play = fieldPlay(r);
  return chaseable(r) ? Math.max(play.revealReal, play.realTime(chaseEnd(r))) : play.revealReal;
}
function chaseTarget() {
  const g = game, r = g.outcome;
  if (g.state !== 'result' || g.replayed || g.replay != null || g.skipAt != null || !chaseable(r) || g.flightT > chaseEnd(r)) return null;   // 건너뛰면 타석 시점으로 끊는다
  if (g.flightT < CHASE.start) return CAM_HOME;
  const T = flightDuration(r);
  const b = flightPos(r, Math.min(g.flightT, T)), land = flightPos(r, T);
  const lx = land.x - CAM_HOME.x, lz = land.z - CAM_HOME.z, L = Math.hypot(lx, lz) || 1, dx = lx / L, dz = lz / L;
  const along = (p) => (p[0] - CAM_HOME.x) * dx + (p[1] - CAM_HOME.z) * dz;
  const stop = r.kind === 'hr' ? along(polar(r.spray, fenceDist(r.spray) - CHASE.hrStop)) : L - CHASE.flyStop;
  const far = Math.min(stop, dz > 0.05 ? (CHASE.maxZ - CAM_HOME.z) / dz : 0), u = (g.flightT - CHASE.start) / Math.max(0.1, chaseLand(r) - CHASE.start);
  const y = CAM_HOME.y + CHASE.lift * Math.max(0, b.y - CAM_HOME.y) * smooth((g.flightT - CHASE.start) / CHASE.rise), ab = along([b.x, b.z]), back = lerp(CHASE.backStart, CHASE.minBack, smooth(ab / L));
  const s = Math.max(0, Math.min(ab - back, far * Math.pow(clamp(u, 0, 1), CHASE.pace)));
  return { x: CAM_HOME.x + dx * s, y, z: CAM_HOME.z + dz * s };
}
// 카메라를 한 장면만큼 옮긴다(목표로 지수 감쇠). 끊을 때는 화면 밀기도 한 번에 타석 시점 값으로 맞춘다. 홈런 흔들림은 카메라가 움직이기 시작하면 멈춘다
function chaseStep(dt) {
  const t = chaseTarget();
  if (!t) {
    const cut = camMoved() && game.state === 'result' && hasBattedBall() && !game.replayed;
    Object.assign(cam, CAM_HOME);
    if (cut) followBall(cameraFocus(game.outcome, game.flightT), 1);
    return;
  }
  const k = Math.min(1, dt * CHASE.k);
  cam.x += (t.x - cam.x) * k; cam.y += (t.y - cam.y) * k; cam.z += (t.z - cam.z) * k;
  if (camMoved()) view.shake = 0;
}
// 가운데 전광판이 HIT·HOMERUN을 띄우는 동안(그 0.6초 전부터)은 화면 밀기를 전광판이 화면 안에 남는 범위로 붙잡고, 주자는 그 뒤에 따라간다
// (2026-11-03 사용자 '전광판을 화면에 붙잡기'). 폰은 시야가 좁아 공·주자를 따라 화면이 밀리면 전광판이 밖으로 나가, 홈런 글자가 뜨는 동안
// 평균 절반만 보이고 끝에는 0%였다. 0.6초 전부터 돌아오면 폰 390폭의 안타 2,775개 모두 글자가 뜨는 동안 94% 넘게 보인다(0.4초는 좌익수 쪽
// 안타에서 75%까지 잘렸다). 따라가는 카메라가 공 뒤로 날아가 있는 동안은 붙잡지 않는다. 돌려주는 값은 panX의 [최소, 최대]
// 간발 판정(세이프·아웃 표시)이 뜨는 동안과 그 뒤 call초까지는 그 베이스도 화면 안(가장자리 base몫 안쪽)에 두고, 전광판과 함께 못 두면(폰) 베이스를 둔다
// (2026-11-05 사용자 결정 '폰에서 간발 세이프일 때 1루가 화면 밖'. 내야 안타는 HIT를 붙잡느라 판정 0.2초 앞에 카메라가 전광판 쪽으로 끌려가,
// 머리부터 슬라이딩과 세이프가 화면 밖이었다). 그 뒤 HIT 쪽으로 돌아온다. PC는 둘 다 들어가서 그대로다
const BOARD_HOLD = { lead: 0.6, margin: 4, call: 0.6, base: 0.1 };
const callNow = () => (hasBattedBall() ? fieldPlay(game.outcome).calls.find((c) => game.flightT < c.t + BOARD_HOLD.call) : null);
function boardHold() {
  const bm = boardMoment(), R = bm && !camMoved() && game.resultT >= bm.t0 - BOARD_HOLD.lead && game.resultT < bm.t1 ? scoreboardRect() : null;
  if (!R) return null;
  const x0 = R.x - view.panX, lo = BOARD_HOLD.margin - x0, hi = view.w - BOARD_HOLD.margin - (x0 + R.w);   // x0: 화면을 안 밀었을 때 전광판 왼쪽
  const hold = lo <= hi ? [lo, hi] : [(lo + hi) / 2, (lo + hi) / 2], c = callNow(), q = c && project(c.at[0], 0, c.at[1]);
  if (!q) return hold;
  const bx = q.x - view.panX, m = view.w * BOARD_HOLD.base, a = Math.max(hold[0], m - bx), b = Math.min(hold[1], view.w - m - bx);
  return a <= b ? [a, b] : null;
}
function followBall(pos, dt) {
  const p = project(pos.x, pos.y, pos.z);
  let tx = 0, ty = 0;
  if (p) {
    const bx = p.x - view.panX, by = p.y - view.panY;
    const mx = view.w * 0.18, my = view.h * 0.2;
    if (bx < mx) tx = mx - bx; else if (bx > view.w - mx) tx = view.w - mx - bx;
    if (by < my) ty = my - by;
  }
  const hold = boardHold();
  if (hold) tx = clamp(tx, hold[0], hold[1]);
  const k = Math.min(1, dt * 5);
  view.panX += clamp((tx - view.panX) * k, -panCap(dt), panCap(dt));
  view.panY += (ty - view.panY) * k;
}
// 화면을 좌우로 미는 빠르기 상한: 초당 시야(view.f)의 PAN_SPEED배(1이면 초당 57도쯤). 목표가 한 번에 바뀔 때(공이 떨어진 뒤 주자로 넘어갈 때,
// 전광판 붙잡기를 풀 때, 다음 공으로 타석 시점에 돌아갈 때) 화면이 휙 넘어갔다(2026-11-05 사용자 결정. 폰에서 HOMERUN이 끝나는 순간 1초에
// 폰 폭의 6배, PC는 홈런 뒤 화면 폭의 2배). 따라가는 카메라를 끊을 때(dt 1)는 한 번에 맞춘다
const PAN_SPEED = 1.0;
const panCap = (dt) => (dt < 0.5 ? PAN_SPEED * view.f * dt : Infinity);

// ===== 화면 위 정보 =====
const KIND_COLOR = { hr: '#ff6b4a', triple: '#4ade80', double: '#4ade80', single: '#4ade80', ball: '#facc15', out: '#9aa3b2', whiff: '#9aa3b2', foul: '#9aa3b2', strike: '#9aa3b2' };
// 10구 전광판 불: 안타(2루타 포함)는 초록, 참아서 골라낸 볼은 노랑, 나머지는 빨강. 홈런은 초록 별(2026-11-05 유저 피드백 '점수판에서 홈런은 다르게(별?)'.
// 처음에는 금색 별이었는데 사용자가 '볼과 같은 색이라 더 헷갈린다'고 해서 안타와 같은 초록에 모양만 별로 가른다).
// 공마다 코드 하나: S 단타·D 2루타·T 3루타·H 홈런·Y 볼·R 그 밖. G는 예전 판과 끝내기 상황 타석의 '어떤 안타'다
const LIGHT = { hit: '#3ddc6e', ball: '#facc15', miss: '#ff4d4d' };
const STAR_K = 1.2;   // 별은 불 반지름의 1.2배
const HIT_CODE = { single: 'S', double: 'D', triple: 'T', hr: 'H' };
const lightCode = (r) => (r.hit ? HIT_CODE[r.kind] : r.kind === 'ball' ? 'Y' : 'R');
const LIGHT_BY_CODE = { S: LIGHT.hit, D: LIGHT.hit, T: LIGHT.hit, G: LIGHT.hit, Y: LIGHT.ball, R: LIGHT.miss };

function drawLight(x, y, radius, color) {
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = radius * 1.8;
  ctx.fill();
  ctx.shadowBlur = 0;
}
// 다섯 꼭짓점 별(위가 꼭짓점). 꼭짓점 끝을 둥글게 하려고 같은 색 테두리를 두르고, 위아래 폭의 가운데가 y에 오게 조금 내린다
function starPath(g, x, y, R) {
  const cy = y + R * 0.1;
  g.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? R * 0.5 : R; g.lineTo(x + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  g.closePath();
}
// 불 하나: 홈런(H)은 꽉 찬 초록 별에 약한 빛, 나머지는 색 동그라미(drawLight)
function drawMark(x, y, radius, code) {
  if (code !== 'H') { drawLight(x, y, radius, LIGHT_BY_CODE[code]); return; }
  const R = radius * STAR_K;
  ctx.save();
  starPath(ctx, x, y, R);
  ctx.fillStyle = LIGHT.hit; ctx.shadowColor = LIGHT.hit; ctx.shadowBlur = R * 0.9; ctx.fill();
  ctx.shadowBlur = 0; ctx.lineJoin = 'round'; ctx.lineWidth = R * 0.16; ctx.strokeStyle = LIGHT.hit; ctx.stroke();
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(str, x, y, { size = 16, weight = 700, color = '#fff', align = 'center', shadow = false } = {}) {
  ctx.font = font(size, weight); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 10; }
  ctx.fillText(str, x, y);
  ctx.shadowBlur = 0;
}

function pill(str, x, y, { size = 14, bg = 'rgba(0,0,0,0.45)', color = '#fff' } = {}) {
  ctx.font = font(size, 700);
  const w = ctx.measureText(str).width + 22, h = size + 12;
  roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
  text(str, x, y + 1, { size, color });
}

function panel(r) { roundRect(r.x, r.y, r.w, r.h, 12); ctx.fillStyle = 'rgba(6,14,28,0.72)'; ctx.fill(); }

function hudLayout() {
  const m = view.mobile, pad = m ? 12 : 22;
  const cardW = m ? (view.w - pad * 3) / 2 : 236, cardH = m ? 132 : 150;
  const cardY = view.h - pad - cardH;
  // 결과 화면 아래 버튼 줄. 10구 도전은 [처음부터 | 다시 보기 | 다음 공]이고, 처음부터는 다음 공과 가장 먼 왼쪽 끝에 둔다
  const n = game.mode === 'challenge' ? 3 : 2, gap = m ? pad : 16;
  const btnW = m ? (view.w - pad * (n + 1)) / n : 150, btnY = m ? cardY - 56 : view.h - pad - 50;
  const rowX = m ? pad : view.w / 2 - (n * btnW + (n - 1) * gap) / 2;
  const slot = (i) => ({ x: rowX + i * (btnW + gap), y: btnY, w: btnW, h: 46 });
  return {
    pad, cardY,
    info: { x: pad, y: cardY, w: cardW, h: cardH },
    map: { x: view.w - pad - cardW, y: cardY, w: cardW, h: cardH },
    restart: n === 3 ? slot(0) : null, replay: slot(n - 2), next: slot(n - 1),
  };
}

// [바탕색, 글자색]. kakao는 카카오 로그인 버튼 색이다
const BUTTON_COLORS = {
  primary: ['#f2c94c', '#1b1405'], kakao: ['#fee500', '#191919'], danger: ['#e5484d', '#fff'], secondary: ['rgba(255,255,255,0.14)', '#fff'],
  dark: ['rgba(6,14,28,0.62)', '#fff'],   // 흰 홈플레이트 위에서도 글자가 보이게(결과 화면 아래 줄)
};
function button(r, label, style) {
  const [bg, fg] = BUTTON_COLORS[style] ?? BUTTON_COLORS.secondary;
  roundRect(r.x, r.y, r.w, r.h, 23);
  ctx.fillStyle = bg; ctx.fill();
  text(label, r.x + r.w / 2, r.y + r.h / 2 + 1, { size: 16, color: fg });
}

const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// ===== 전광판 =====
// 위쪽 줄을 야구장 LED 전광판처럼 그린다(2026-11-02 사용자 '전광판도 꾸며 줘' → 시안 A). 어두운 패널 안에 왼쪽 로고·모드, 가운데 지난 공·남은 기회
// 전구 불(아래 번호, 마지막 칸 '끝'), 오른쪽 7세그먼트 숫자(남은 기회 초록·점수 노랑). 끝내기 상황은 팀 점수·9회말·B·S·O·누상, 연습은 구종과 정타 수를
// 같은 패널에 둔다. 끝내기 찬스·끝내기 상황 안내는 패널 아래 깜빡이는 LED 띠다. 전에는 하늘 위에 동그라미와 글자만 떠 있었다.
// 패널·불·숫자는 보이는 값(boardView)이 바뀔 때만 따로 그려 두고(board.canvas) 붙인다. 매 화면에는 지금 공 불의 깜빡이는 테두리와 LED 띠만 그린다(폰 성능)
const LED_AMBER = '#ffb52e', LED_GREEN = '#7ef0a0', LED_OFF = 'rgba(255,181,46,0.09)', BOARD_M = 16;   // BOARD_M: 그려 둔 그림의 빛 번짐 여백(px)
const SEG7 = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
const board = { key: '', canvas: null, ring: null, renders: 0 };
// 전광판에 보이는 값. 결과 글자가 뜨기 전에는 이번 공의 불·점수·끝내기 상황판을 공이 맞기 전 그대로 둔다(1루 간발의 결과가 미리 보이지 않게)
// 끝내기 주루 플레이(홈 승부·태그업·병살)는 결과 글자 뒤에 정해져서, 정해질 때(ev.decide)까지 상황판·알림을 공이 맞기 전 그대로 둔다
const scnDecided = () => game.mode !== 'scenario' || !game.outcome?.scnPlay || game.flightT >= (fieldPlay(game.outcome).ev.decide ?? 0);
function boardView() {
  const early = game.state === 'result' && (game.resultT <= game.revealAt || !scnDecided()), playing = game.state !== 'over' && game.state !== 'title';
  const mode = game.mode === 'scenario' && game.scn ? 'scenario' : game.mode === 'practice' && game.practice ? 'practice' : 'challenge';
  const v = { mode, label: game.aim ? '조준 실험' : { challenge: '10구 도전', scenario: '끝내기 상황', practice: '연습' }[game.mode] ?? '', now: playing ? game.i : -1 };
  if (mode === 'scenario') {
    const s = early && game.scnBefore ? game.scnBefore : game.scn, [away, home] = sideNames(), first = game.i === 0 && (game.state === 'windup' || game.state === 'pitch');
    return { ...v, away, home, sa: s.away, sh: s.home, b: s.count.b, s: s.count.s, o: s.outs, bases: s.bases.map(Boolean), note: first ? `${s.label}. 역전하면 끝내기!` : '' };
  }
  if (mode === 'practice') {
    const pr = game.practice;
    return { ...v, type: `${typeName(pr.type)}${pr.slow ? ' · 느리게' : ''}`, stat: `정타 ${pr.perfect} / 스윙 ${pr.swings}`, avg: `평균 오차 ${pr.swings ? `${Math.round(pr.sumAbs / pr.swings)}ms` : '-'}` };
  }
  const lamps = [];   // 칸 수 = 지난 공 + 남은 기회(볼을 골라내면 한 칸 늘어난다)
  for (let i = 0; i < game.results.length + game.left; i++) { const res = early && i === game.i ? null : game.results[i]; lamps.push(res ? lightCode(res) : null); }
  return { ...v, score: game.score - (early ? game.gained : 0), left: game.left, lamps,
    note: game.lastChance && playing && game.state !== 'result' ? '9회말 2아웃 · 끝내기 찬스 · 점수 2배' : '' };   // 결과 화면에서는 결과 글자와 겹쳐서 뺀다
}
function boardLayout() {
  const m = view.mobile, pw = m ? view.w - 12 : Math.min(940, view.w - 240), ph = m ? 54 : 64;
  return { m, pw, ph, px: (view.w - pw) / 2, py: m ? 6 : 10, pad: m ? 12 : 18, leftW: m ? 66 : 120 };
}
function drawTopBar() {
  const v = boardView(), L = boardLayout(), key = JSON.stringify([view.w, view.h, view.dpr, v]);
  if (board.key !== key) { renderBoard(v, L); board.key = key; }
  ctx.drawImage(board.canvas, L.px - BOARD_M, L.py - BOARD_M, L.pw + 2 * BOARD_M, L.ph + 2 * BOARD_M);
  const q = board.ring;   // 지금 공 자리: 아직 불이 안 켜졌으면 흰 테두리가 깜빡인다
  if (q) { ctx.strokeStyle = `rgba(255,255,255,${0.65 + 0.35 * Math.sin(performance.now() / 180)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, q.r + 3, 0, Math.PI * 2); ctx.stroke(); }
  if (v.note) ledNote(v.note, L.py + L.ph + (L.m ? 20 : 24));
}
// 보이는 값 v를 board.canvas에 그린다. 패널 왼쪽 위가 (BOARD_M, BOARD_M)이다
function renderBoard(v, L) {
  const W = L.pw + 2 * BOARD_M, H = L.ph + 2 * BOARD_M, d = view.dpr;
  board.canvas ??= document.createElement('canvas');
  const c = board.canvas;
  if (c.width !== Math.round(W * d) || c.height !== Math.round(H * d)) { c.width = Math.round(W * d); c.height = Math.round(H * d); }
  const g = c.getContext('2d'), M = BOARD_M, { m, pw, ph, pad, leftW } = L, cy = M + ph / 2;
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  board.renders++; board.ring = null;
  const tx = (str, x, y, size, color = '#fff', align = 'center', weight = 800) => { g.font = font(size, weight); g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(str, x, y); };
  // 패널: 그림자, 위가 조금 밝은 검은 판, 바깥 테두리와 안쪽 홈
  g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
  ledPath(g, M, M, pw, ph, 10);
  const bg = g.createLinearGradient(0, M, 0, M + ph); bg.addColorStop(0, '#161d2e'); bg.addColorStop(1, '#080b13');
  g.fillStyle = bg; g.fill(); g.restore();
  ledPath(g, M + 0.5, M + 0.5, pw - 1, ph - 1, 10); g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.stroke();
  ledPath(g, M + 3.5, M + 3.5, pw - 7, ph - 7, 7); g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke();
  // 왼쪽: 로고와 모드
  const lx = M + pad;
  tx('walkoff', lx, cy - (m ? 6 : 7), m ? 15 : 19, '#fff', 'left', 900);
  tx(v.label, lx, cy + (m ? 11 : 13), m ? 9 : 11, LED_AMBER, 'left');
  const rx = M + pw - pad;
  if (v.mode === 'scenario') {   // 가운데 팀 점수와 9회말, 오른쪽 B·S·O와 누상
    const cx = M + pw / 2, h = m ? 20 : 26;
    seg7(g, String(v.sa), cx - (m ? 12 : 16), cy - 3, h, LED_AMBER, 'right');
    seg7(g, String(v.sh), cx + (m ? 12 : 16), cy - 3, h, LED_AMBER, 'left');
    tx(':', cx, cy - 3, m ? 16 : 20, 'rgba(255,255,255,0.5)');
    tx(v.away, cx - (m ? 34 : 50), cy - 3, m ? 11 : 14, '#fff', 'right');
    tx(v.home, cx + (m ? 34 : 50), cy - 3, m ? 11 : 14, '#fff', 'left');
    tx('9회말', cx, cy + (m ? 17 : 21), m ? 9 : 10, LED_AMBER);
    const dd = m ? 8 : 11, dx = rx - dd * 1.4;
    const base = (x, y, on) => {
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillStyle = on ? LED_AMBER : '#1b2232'; g.shadowColor = LED_AMBER; g.shadowBlur = on ? 8 : 0;
      g.fillRect(-dd / 2, -dd / 2, dd, dd); g.shadowBlur = 0; g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1; g.strokeRect(-dd / 2, -dd / 2, dd, dd); g.restore();
    };
    base(dx + dd, cy + 1, v.bases[0]); base(dx, cy + 1 - dd, v.bases[1]); base(dx - dd, cy + 1, v.bases[2]);
    const bx = dx - dd * 2 - (m ? 40 : 58), r = m ? 3.6 : 4.8, step = m ? 10 : 13, rs = m ? 13 : 15;
    [['B', v.b, 3, LIGHT.hit, cy - rs], ['S', v.s, 2, LIGHT.ball, cy], ['O', v.o, 2, LIGHT.miss, cy + rs]].forEach(([lab, n, max, color, y]) => {
      tx(lab, bx, y + 1, m ? 9 : 10, 'rgba(255,255,255,0.6)', 'left');
      for (let i = 0; i < max; i++) ledLamp(g, bx + (m ? 12 : 15) + i * step, y, r, i < n ? color : null);
    });
    return;
  }
  if (v.mode === 'practice') {   // 가운데 구종, 오른쪽 정타 수와 평균 오차
    tx(v.type, M + pw / 2, cy, m ? 15 : 19, '#fff', 'center', 900);
    tx(v.stat, rx, cy - (m ? 6 : 7), m ? 12 : 15, LED_AMBER, 'right');
    tx(v.avg, rx, cy + (m ? 11 : 13), m ? 9 : 11, 'rgba(255,255,255,0.5)', 'right', 700);
    return;
  }
  // 10구 도전: 오른쪽 점수(7세그먼트), PC는 남은 기회도
  seg7(g, v.score.toLocaleString(), rx, cy - (m ? 3 : 4), m ? 19 : 26, LED_AMBER);
  tx('점수', rx, cy + (m ? 17 : 21), m ? 8 : 10, 'rgba(255,255,255,0.45)', 'right', 700);
  const rightW = m ? 78 : 150;
  if (!m) {
    const bx = M + pw - rightW - 70;
    seg7(g, String(v.left).padStart(2, '0'), bx + 48, cy - 4, 22, LED_GREEN);
    tx('남은 기회', bx + 30, cy + 21, 10, 'rgba(255,255,255,0.45)', 'center', 700);
  }
  // 가운데: 지난 공·남은 기회 불과 번호. 마지막 칸(끝내기 찬스)은 노란 테두리와 '끝'
  const c0 = M + leftW + (m ? 14 : 30), c1 = M + pw - rightW - (m ? 14 : 110), n = v.lamps.length, y = cy - (m ? 4 : 5);
  const gap = n > 1 ? Math.min((c1 - c0) / (n - 1), (m ? 6 : 8) * 3.4) : 0, r = Math.min(m ? 6 : 8, gap * 0.36 || 8), x0 = (c0 + c1) / 2 - gap * (n - 1) / 2;
  v.lamps.forEach((code, i) => {
    const x = x0 + i * gap, last = i === n - 1;
    if (code === 'H') ledStar(g, x, y, r); else ledLamp(g, x, y, r, code && LIGHT_BY_CODE[code]);
    if (last && !code && i !== v.now) { g.strokeStyle = 'rgba(255,181,46,0.9)'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r + 3, 0, Math.PI * 2); g.stroke(); }
    tx(last && !code ? '끝' : String(i + 1), x, y + r + 10, 9, last && !code ? LED_AMBER : 'rgba(255,255,255,0.38)', 'center', 700);
    if (i === v.now && !code) board.ring = { x: L.px - M + x, y: L.py - M + y, r };   // 화면 좌표(매 화면 깜빡이는 테두리)
  });
}
// 홈런 불: 꺼진 유리알 자리에 꽉 찬 초록 별(불 반지름의 STAR_K배). 위가 밝은 초록이고 빛은 불보다 약하게 번진다
function ledStar(g, x, y, r) {
  const R = r * STAR_K, gr = g.createLinearGradient(0, y - R, 0, y + R);
  gr.addColorStop(0, '#d8ffe4'); gr.addColorStop(0.45, LIGHT.hit); gr.addColorStop(1, '#1e9a48');
  g.save();
  starPath(g, x, y, R);
  g.shadowColor = LIGHT.hit; g.shadowBlur = R * 1.1; g.fillStyle = gr; g.fill();
  g.shadowBlur = 0; g.lineJoin = 'round'; g.lineWidth = R * 0.16; g.strokeStyle = gr; g.stroke();
  g.restore();
}
function ledPath(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
// 전구 불: 켜지면 가운데가 밝고 빛이 번진다. 꺼진 불도 유리알과 반사가 보인다
function ledLamp(g, x, y, r, color) {
  g.save();
  const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  if (color) { g.shadowColor = color; g.shadowBlur = r * 2.2; gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, color); gr.addColorStop(1, color); }
  else { gr.addColorStop(0, '#2a3346'); gr.addColorStop(1, '#121825'); }
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0; g.strokeStyle = color ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.ellipse(x - r * 0.32, y - r * 0.4, r * 0.28, r * 0.17, -0.5, 0, Math.PI * 2); g.fill();
  g.restore();
}
// 7세그먼트 숫자(야구장 전광판처럼 살짝 기울임). 켜진 칸은 빛이 번지고 꺼진 칸은 옅게 보인다. 쉼표는 점에 꼬리를 달아 소수점으로 읽히지 않게. x·y는 기준점(글자 가운데 높이)
function seg7(g, str, x, y, h, color, align = 'right') {
  const w = h * 0.52, t = Math.max(1.6, h * 0.13), gap = h * 0.18, comma = h * 0.22, chars = String(str).split('');
  const widths = chars.map((c) => (c === ',' ? comma : w + gap)), total = widths.reduce((a, b) => a + b, 0) - gap, skew = h * 0.08;
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  const bar = (x0, y0, x1, y1, on) => {   // 끝이 뾰족한 막대 한 칸
    const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L, nx = -uy * t / 2, ny = ux * t / 2, sh = t * 0.5;
    g.beginPath(); g.moveTo(x0 + ux * 0.6, y0 + uy * 0.6);
    g.lineTo(x0 + ux * sh + nx, y0 + uy * sh + ny); g.lineTo(x1 - ux * sh + nx, y1 - uy * sh + ny); g.lineTo(x1 - ux * 0.6, y1 - uy * 0.6);
    g.lineTo(x1 - ux * sh - nx, y1 - uy * sh - ny); g.lineTo(x0 + ux * sh - nx, y0 + uy * sh - ny); g.closePath();
    g.shadowBlur = on ? h * 0.35 : 0; g.fillStyle = on ? color : LED_OFF; g.fill();
  };
  g.save(); g.shadowColor = color;
  chars.forEach((c, i) => {
    if (c === ',') {
      const px = cx + comma * 0.25, py = y + h / 2 - t * 0.2;
      g.fillStyle = color; g.shadowBlur = h * 0.3;
      g.beginPath(); g.arc(px, py, t * 0.55, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(px + t * 0.5, py); g.lineTo(px - t * 0.5, py + t * 1.5); g.lineTo(px - t * 0.1, py + t * 0.2); g.closePath(); g.fill();
    } else {
      const on = SEG7[c] ?? '', Lx = cx, Rx = cx + w, T = y - h / 2, B = y + h / 2, k = (yy) => (y - yy) / h * skew;
      for (const [sg, a, b] of [['a', [Lx, T], [Rx, T]], ['b', [Rx, T], [Rx, y]], ['c', [Rx, y], [Rx, B]], ['d', [Lx, B], [Rx, B]], ['e', [Lx, y], [Lx, B]], ['f', [Lx, T], [Lx, y]], ['g', [Lx, y], [Rx, y]]]) bar(a[0] + k(a[1]), a[1], b[0] + k(b[1]), b[1], on.includes(sg));
    }
    cx += widths[i];
  });
  g.restore();
  return total;
}
// 끝내기 찬스·끝내기 상황 안내: 패널 아래 깜빡이는 LED 띠
function ledNote(str, cy) {
  const m = view.mobile, size = m ? 12 : 14;
  ctx.font = font(size, 800);
  const w = ctx.measureText(str).width + (m ? 34 : 46), h = m ? 24 : 28, blink = 0.7 + 0.3 * Math.sin(performance.now() / 260);
  ctx.save();
  roundRect(view.w / 2 - w / 2, cy - h / 2, w, h, 6); ctx.fillStyle = '#12060a'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,70,60,0.75)'; ctx.lineWidth = 1.5; ctx.stroke();
  for (const e of [-1, 1]) { ctx.fillStyle = `rgba(255,70,60,${blink})`; ctx.beginPath(); ctx.arc(view.w / 2 + e * (w / 2 - 12), cy, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.shadowColor = '#ff5a3c'; ctx.shadowBlur = 8;
  text(str, view.w / 2, cy + 1, { size, weight: 800, color: `rgba(255,214,120,${0.85 + 0.15 * blink})` });
  ctx.restore();
}

// 타이밍 막대: 가운데 금색이 정타, 초록이 앞으로 가는 타구, 회색이 파울
function drawTimingBar(x, y, w, dt) {
  const toX = (ms) => x + (clamp(ms, -FOUL_MS, FOUL_MS) + FOUL_MS) / (2 * FOUL_MS) * w;
  const seg = (a, b, c) => { ctx.fillStyle = c; ctx.fillRect(toX(a), y - 3, toX(b) - toX(a), 6); };
  seg(-FOUL_MS, -FAIR_MS, 'rgba(255,255,255,0.25)'); seg(-FAIR_MS, FAIR_MS, 'rgba(74,222,128,0.6)');
  seg(-PERFECT_MS, PERFECT_MS, '#f2c94c'); seg(FAIR_MS, FOUL_MS, 'rgba(255,255,255,0.25)');
  const mx = toX(dt);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(mx, y - 4); ctx.lineTo(mx - 6, y - 13); ctx.lineTo(mx + 6, y - 13); ctx.closePath(); ctx.fill();
  text('빠름', x - 8, y + 1, { size: 11, weight: 600, color: 'rgba(255,255,255,0.65)', align: 'right', shadow: true });
  text('늦음', x + w + 8, y + 1, { size: 11, weight: 600, color: 'rgba(255,255,255,0.65)', align: 'left', shadow: true });
}

function pillRow(items, y, size) {
  ctx.font = font(size, 700);
  const widths = items.map(([s]) => ctx.measureText(s).width + 22), gap = 8;
  let x = view.w / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)) / 2;
  items.forEach(([s, bg, color], i) => { pill(s, x + widths[i] / 2, y, { size, bg, color }); x += widths[i] + gap; });
}

// 결과 제목 한 줄이 서는 자리: 위 점수판 패널 아래와 가운데 전광판 위 끝(타석 시점) 사이 빈자리 가운데. 글자 크기는 빈자리 높이의 0.95배까지
// (한글은 글자 높이가 크기의 0.9배쯤이라 패널·전광판을 가리지 않는다. 처음 0.72배는 아이폰 사파리(390×664, 빈자리 25px)에서 18px로 너무 작았다).
// 빈자리: 폰 390×844 60~141px, 390×664 60~85, 360×640 60~87, PC 1440×900 74~118, 1920×1080 74~142
function resultTitleBox(r = game.outcome) {
  const m = view.mobile, L = boardLayout(), top = L.py + L.ph, z = fenceDist(0) + SCOREBOARD.back;
  const bottom = view.cy - (SCOREBOARD.y1 - CAM_HOME.y) * view.f / (z - CAM_HOME.z);
  const size = Math.max(16, Math.min((m ? 32 : 44) * (r && r.kind === 'hr' ? 1.3 : 1), (bottom - top) * 0.95));
  return { y: Math.max(top + size / 2, (top + bottom) / 2), size, top, bottom };
}
const resultTitle = (r) => (r.kind !== 'hr' ? r.name : r.streak >= 3 ? `${r.streak}연속 홈런!` : r.streak === 2 ? '백투백 홈런!' : '홈런!');
function drawResultCard() {
  const r = game.outcome;
  if (!r || game.resultT < game.revealAt) return;
  // 제목 한 줄(제목과 얻은 점수)은 결과를 알리는 순간(안타·홈런은 전광판이 HIT·HOMERUN을 띄우는 때)에 함성과 함께 튀어나와 그 자리에 그대로 있는다
  // (2026-11-03 유저 피드백 '환호성 → 전광판 HIT → 결과 순서로 하나씩 나와 어색하다', 사용자 결정 '한 박자로 모으기'). 전에는 결과 카드가 전광판 자리를
  // 가려서 HIT·HOMERUN이 끝난 뒤(안타 1.2초·홈런 1.6초 뒤) 제목부터 통째로 나왔다. 홈런·큰 뜬공의 함성은 공이 관중석에 들어가거나 떨어질 때(카메라가 돌아오기 0.35초 앞, 두 박자)
  const bm = boardMoment(), beat = bm ? bm.t0 : game.revealAt;
  if (game.resultT < beat) return;
  const m = view.mobile, cx = view.w / 2, hr = r.kind === 'hr', T = resultTitleBox(r), title = resultTitle(r);
  const pts = game.gained > 0 ? `+${game.gained.toLocaleString()}${game.lastChance ? ' (2배)' : ''}` : '';
  const kt = easeOut((game.resultT - beat) / 0.2), sc = 1 + 0.15 * (1 - kt), small = T.size * 0.62;
  ctx.save(); ctx.globalAlpha = kt; ctx.translate(cx, T.y); ctx.scale(sc, sc);
  ctx.font = font(T.size, 900); const w1 = ctx.measureText(title).width;
  ctx.font = font(small, 900); const gap = pts ? T.size * 0.3 : 0, x0 = -(w1 + gap + (pts ? ctx.measureText(pts).width : 0)) / 2;
  text(title, x0, 0, { size: T.size, weight: 900, color: KIND_COLOR[r.kind], align: 'left', shadow: true });
  if (pts) text(pts, x0 + w1 + gap, 0, { size: small, weight: 900, color: '#f2c94c', align: 'left', shadow: true });
  ctx.restore();
  // 자세한 카드(비거리·칩·타이밍 막대·타구·이유)는 전광판이 HIT·HOMERUN을 다 띄운 뒤에 제목 아래로 나온다(전광판 자리를 가린다). 투수 머리 위까지만 쓴다
  if (!cardDetails()) return;
  const shownAt = bm ? bm.t1 : game.revealAt, k = easeOut((game.resultT - shownAt) / 0.25);
  ctx.globalAlpha = k;
  let y = T.y + T.size / 2 + (m ? 16 : 20) + (1 - k) * 10;
  if (hr) { text(`${r.name} · ${Math.round(carryOf(r))}m`, cx, y, { size: m ? 15 : 18, shadow: true }); y += m ? 28 : 30; }
  const chips = [];
  if (!r.took) {
    // 정타가 아닌데 ±15ms 안이면 존 밖 공이다. 그냥 '타이밍 정확'이라 쓰면 정타로 읽혀서, 잡혔을 때 '정타인데 아웃'으로 들렸다
    // 조준 판은 과녁을 벗어나도 정타가 아니다(그때 '존 밖 공'이라 쓰면 틀린 말이다)
    const why = r.aimZone === 'miss' ? '과녁 밖' : r.aimZone === 'edge' ? '과녁 가장자리' : '존 밖 공';
    const label = r.perfect ? '정타!' : Math.abs(r.dt) <= PERFECT_MS ? `타이밍 정확 · ${why}` : `${Math.abs(r.dt)}ms ${r.dt < 0 ? '빠름' : '늦음'}`;
    chips.push(r.perfect ? [label, '#f2c94c', '#1b1405'] : [label, 'rgba(0,0,0,0.5)', '#fff']);
  }
  if (r.streakBonus) chips.push([`연속 홈런 +${r.streakBonus.toLocaleString()}`, 'rgba(255,90,40,0.85)', '#ffffff']);
  if (r.hitBonus) chips.push([`${r.hitStreak}연속 안타 +${r.hitBonus}`, 'rgba(61,220,110,0.85)', '#0b1424']);
  if (r.bonus) chips.push(['기회 +1', 'rgba(61,220,110,0.22)', '#8ef0a8']);   // 얻은 점수는 제목 줄에 있다
  if (game.mode === 'scenario' && game.scnEvent && scnDecided()) {
    const end = game.scn.end;
    chips.push([game.scnEvent, end === 'win' ? '#f2c94c' : 'rgba(0,0,0,0.55)', end === 'win' ? '#1b1405' : end ? '#ff9a9a' : '#ffffff']);
  }
  if (chips.length) { pillRow(chips, y, m ? 13 : 14); y += m ? 30 : 32; }
  if (!r.took) { const bw = m ? 180 : 240; drawTimingBar(cx - bw / 2, y, bw, r.dt); y += m ? 22 : 24; }
  if (r.ev) { text(`타구 ${r.ev}km/h · 발사각 ${r.la}° · ${Math.round(carryOf(r))}m`, cx, y, { size: m ? 12 : 14, weight: 600, shadow: true }); y += m ? 20 : 21; }
  text(r.reason, cx, y, { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.82)', shadow: true });
  ctx.globalAlpha = 1;
}

function drawPitchInfo(rect) {
  const p = game.seq[game.i], def = PITCHES[p.type];
  panel(rect);
  const m = view.mobile, pad = 12;
  text(`${p.n}구 · ${PITCH_NAMES[p.type]}`, rect.x + pad, rect.y + 20, { size: m ? 14 : 16, align: 'left', color: PITCH_COLORS[p.type] });
  text(`${p.kmh}km/h`, rect.x + rect.w - pad, rect.y + 20, { size: m ? 13 : 15, align: 'right' });
  // 작은 존: 가로 -0.6~0.6m, 세로 0~1.5m
  const box = { x: rect.x + pad, y: rect.y + 38, w: m ? 64 : 76, h: rect.h - 50 };
  const sx = (x) => box.x + (x + 0.6) / 1.2 * box.w, sy = (y) => box.y + box.h - y / 1.5 * box.h;
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(sx(ZONE.left), sy(ZONE.top), sx(ZONE.right) - sx(ZONE.left), sy(ZONE.bottom) - sy(ZONE.top));
  ctx.fillStyle = PITCH_COLORS[p.type]; ctx.beginPath(); ctx.arc(sx(clamp(p.tx, -0.58, 0.58)), sy(clamp(p.ty, 0.03, 1.47)), 5, 0, Math.PI * 2); ctx.fill();
  const tx = box.x + box.w + 12, inZone = zoneMiss(p) === 0;
  const off = inZone ? null : zoneOff(p);
  text(inZone ? '스트라이크 존' : `존 밖 · ${off.dir} ${off.cm}cm`, tx, box.y + 10, { size: 13, align: 'left', color: inZone ? '#fff' : '#facc15' });
  const cm = (v) => Math.round(Math.abs(v) * 100);
  const lines = [];
  if (cm(def.brk.x) >= 5) lines.push(`${def.brk.x * (p.lefty ? -1 : 1) > 0 ? '→' : '←'}${cm(def.brk.x)}cm`);
  if (cm(def.brk.y) >= 5) lines.push(`${def.brk.y > 0 ? '↑' : '↓'}${cm(def.brk.y)}cm`);
  text('휜 정도', tx, box.y + 34, { size: 12, weight: 600, align: 'left', color: 'rgba(255,255,255,0.6)' });
  text(lines.join(' ') || '거의 안 휨', tx, box.y + 54, { size: m ? 12 : 13, align: 'left' });
  text(`도착 ${Math.round(p.T * 1000)}ms`, tx, box.y + 76, { size: 12, weight: 600, align: 'left', color: 'rgba(255,255,255,0.6)' });
}

function drawMiniMap(rect) {
  panel(rect);
  const r = game.outcome, ox = rect.x + rect.w / 2, oy = rect.y + rect.h - 12;
  const k = (rect.h - 30) / 125;
  const P = (a, d) => ({ x: ox + d * Math.sin(a * DEG) * k, y: oy - d * Math.cos(a * DEG) * k });
  ctx.beginPath(); ctx.moveTo(ox, oy);
  for (let a = -45; a <= 45; a += 5) { const q = P(a, fenceDist(a)); ctx.lineTo(q.x, q.y); }
  ctx.closePath(); ctx.fillStyle = '#1d6b3a'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(ox, oy);
  for (let a = -45; a <= 45; a += 9) { const q = P(a, 36); ctx.lineTo(q.x, q.y); }
  ctx.closePath(); ctx.fillStyle = '#9a6b45'; ctx.fill();
  const fielders = [...INFIELDERS, ...OUTFIELDERS];
  const fl = r && !r.took ? flightPos(r, game.flightT) : null;
  for (const f of fielders) {
    let q = P(f.a, f.d);
    if (fl && r.fielder === f) { const b = P(r.spray, fl.s); q = { x: lerp(q.x, b.x, fl.tau), y: lerp(q.y, b.y, fl.tau) }; }
    ctx.fillStyle = r && r.fielder === f ? '#ff6b4a' : 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  if (fl && r.kind !== 'whiff') {
    const end = P(r.spray, fl.s);
    ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  text('타구 방향', rect.x + 12, rect.y + 16, { size: 12, weight: 600, align: 'left', color: 'rgba(255,255,255,0.6)' });
}

function dim(alpha) { ctx.fillStyle = `rgba(4,9,18,${alpha})`; ctx.fillRect(0, 0, view.w, view.h); }

// ===== 버튼 =====
// 화면을 그리면서 버튼을 모아 두고, 누른 자리에 있는 버튼을 실행한다. 매 프레임 새로 모은다
const ui = { buttons: [] };

function addButton(r, label, style, onTap) {
  if (style === 'chip' || style === 'chipOn') {
    roundRect(r.x, r.y, r.w, r.h, r.h / 2);
    ctx.fillStyle = style === 'chipOn' ? '#ffffff' : 'rgba(255,255,255,0.12)'; ctx.fill();
    text(label, r.x + r.w / 2, r.y + r.h / 2 + 1, { size: 15, color: style === 'chipOn' ? '#0b1424' : 'rgba(255,255,255,0.8)' });
  } else if (style === 'link') {
    text(label, r.x + r.w / 2, r.y + r.h / 2, { size: 14, weight: 600, color: 'rgba(255,255,255,0.72)' });
    ctx.font = font(14, 600);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(r.x + r.w / 2 - tw / 2, r.y + r.h / 2 + 10, tw, 1);
  } else if (style === 'none') {   // 그리지 않고 누르는 자리만(랭킹 줄)
  } else button(r, label, style);
  ui.buttons.push({ r, onTap, label });
}

// 가로 totalW를 n칸으로 고르게 나눈 버튼 자리
function rowRects(cx, y, totalW, h, n, gap = 10) {
  const w = (totalW - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: cx - totalW / 2 + i * (w + gap), y, w, h }));
}

// ===== 설정: 좌타/우타 =====
// 이 브라우저에 남긴 설정을 넣는다(객체와 기본값은 game/state.js, 저장소와 랭킹 ID는 infra/store.js)
const defaultNick = () => `타자${Math.floor(1000 + Math.random() * 9000)}`;
Object.assign(settings, {
  bats: store.get('bats', 'R') === 'L' ? 'L' : 'R',
  offset: clamp(Number(store.get('offset', 0)) || 0, -150, 250),   // 타이밍 보정(ms). 판정할 때 이만큼 뺀다
  team: teamById(String(store.get('team', ''))) ? String(store.get('team', '')) : null,   // 처음 시작할 때 고른다
  nick: String(store.get('nick', '')).trim().slice(0, 10),
  playerId: ensurePlayerId(),
  vibrate: store.get('vibrate', true) !== false,   // 진동(안드로이드만). 메뉴에서 끈다
});
function setBats(b) { settings.bats = b; store.set('bats', b); }
function saveTeamAndNick(team, nick) {
  Object.assign(settings, { team, nick });
  store.set('team', team); store.set('nick', nick);
}
const batSide = () => (settings.bats === 'L' ? -1 : 1);

// ===== 진동 =====
// 진동을 내는 일은 infra/vibrate.js(안드로이드만 된다). 메뉴에서 끈 사람은 울리지 않는다
function buzz(pattern) {
  if (settings.vibrate) vibrate(pattern);
}
function toggleVibrate() {
  settings.vibrate = !settings.vibrate;
  store.set('vibrate', settings.vibrate);
  buzz(30);   // 켰으면 한 번 울려서 알려 준다
}   // 좌타는 홈플레이트 오른쪽에 서서 화면 좌우가 뒤집힌다

// ===== 타이밍 보정 =====
// 기기마다 화면과 터치가 늦게 반응하는 정도가 달라서, 공이 링에 닿을 때 8번 눌러 평소 어긋남을 잰다.
// 앞 2번은 손 풀기로 버리고 나머지의 중앙값을 쓴다. 박자 소리는 없다(게임은 눈으로 보고 친다)
const CALIB = { taps: 8, warmup: 2, period: 1.0, approach: 0.7, lead: 1.2 };
const fmtMs = (ms) => `${ms > 0 ? '+' : ''}${Math.round(ms)}ms`;

function startCalib() { Object.assign(game, { state: 'calib', calib: { start: performance.now(), taps: [], result: null } }); }
const calibBeat = (k) => game.calib.start + (CALIB.lead + k * CALIB.period) * 1000;

function calibTap(eventTime) {
  const c = game.calib;
  if (c.result != null) return;
  const k = Math.max(0, Math.round((eventTime - calibBeat(0)) / (CALIB.period * 1000)));
  const off = eventTime - calibBeat(k);
  if (Math.abs(off) > 350) return;   // 박자와 상관없이 누른 것은 버린다
  c.taps.push(off);
  Sound.tick();
  if (c.taps.length < CALIB.taps) return;
  const used = c.taps.slice(CALIB.warmup).sort((a, b) => a - b), mid = used.length / 2;
  c.result = clamp(Math.round(used.length % 2 ? used[Math.floor(mid)] : (used[mid - 1] + used[mid]) / 2), -150, 250);
}

function saveCalib(v) {
  settings.offset = v; store.set('offset', v);
  toast(v ? `타이밍 보정 ${fmtMs(v)}을 저장했어요` : '타이밍 보정을 껐어요');
  goTitle();
}

function drawCalib() {
  dim(0.78);
  const m = view.mobile, cx = view.w / 2, c = game.calib, ty = view.h * 0.56, ring = m ? 34 : 40;
  let y = view.h * 0.14;
  text('타이밍 보정', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 34 : 42;
  if (c.result == null) {
    text('공이 링에 닿는 순간 누르세요', cx, y, { size: m ? 14 : 17, weight: 500, color: 'rgba(255,255,255,0.85)' });
    for (let i = 0; i < CALIB.taps; i++) {
      ctx.beginPath(); ctx.arc(cx + (i - (CALIB.taps - 1) / 2) * 22, y + 34, 6, 0, Math.PI * 2);
      ctx.fillStyle = i < c.taps.length ? '#f2c94c' : 'rgba(255,255,255,0.2)'; ctx.fill();
    }
    const now = performance.now(), kNow = Math.floor((now - calibBeat(0)) / (CALIB.period * 1000));
    const lastBeat = calibBeat(Math.max(0, kNow));
    const glow = now >= calibBeat(0) && now - lastBeat < 120;
    ctx.strokeStyle = glow ? '#f2c94c' : 'rgba(255,255,255,0.8)'; ctx.lineWidth = glow ? 5 : 3;
    ctx.beginPath(); ctx.arc(cx, ty, ring, 0, Math.PI * 2); ctx.stroke();
    for (let k = Math.max(0, kNow - 1); k <= kNow + 2; k++) {
      const u = 1 - (calibBeat(k) - now) / (CALIB.approach * 1000);
      if (u < 0 || u > 1.12) continue;
      const v = Math.min(u, 1);
      ctx.globalAlpha = u > 1 ? 1 - (u - 1) / 0.12 : 1;
      ctx.fillStyle = '#fbfaf5';
      ctx.beginPath(); ctx.arc(cx, lerp(view.h * 0.26, ty, v), lerp(3, ring * 0.5, v * v), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    addButton({ x: cx - 70, y: view.h - (m ? 70 : 80), w: 140, h: 36 }, '그만두기', 'link', goTitle);
  } else {
    const r = c.result;
    text(r === 0 ? '딱 맞춰 눌렀어요' : `평소 ${Math.abs(r)}ms ${r > 0 ? '늦게' : '빠르게'} 눌러요`, cx, y + 40, { size: m ? 24 : 30, weight: 800, color: '#f2c94c' });
    text(r === 0 ? '보정 없이 판정해요' : `판정할 때 ${Math.abs(r)}ms를 ${r > 0 ? '빼고' : '더해'} 계산해요`, cx, y + (m ? 80 : 88), { size: m ? 14 : 17, weight: 500, color: 'rgba(255,255,255,0.85)' });
    const bw = m ? view.w - 48 : 340, [a, b] = rowRects(cx, y + (m ? 120 : 132), bw, 48, 2);
    addButton(a, '이 값으로 저장', 'primary', () => saveCalib(r));
    addButton(b, '다시 재기', 'secondary', startCalib);
    addButton({ x: cx - 90, y: y + (m ? 184 : 200), w: 180, h: 36 }, '보정 끄기 (0ms)', 'link', () => saveCalib(0));
  }
}

// ===== 하루 기록 =====
// 오늘의 10구(날짜마다 같은 공, 하루 첫 판만 기록)는 2026-10-30 사용자 결정으로 없앴다. 사람들은 그냥 마음껏 치고 싶어 했다.
// 서버는 예전 탭에서 오는 오늘의 10구 점수도 그날 공 순서로 검사해 받는다(worker/src/rules.js)
const SHARE_URL = 'https://hyunseungbeom.github.io/walkoff/';
const today = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
// 10구 도전을 끝까지 친 날(played.날짜)과 예전 오늘의 10구 기록(daily.날짜). 이 브라우저 기록이라 기기를 바꾸면 처음부터다
const playedDays = () => new Set(['played.', 'daily.'].flatMap((pre) => store.keys(pre).map((k) => k.slice(pre.length))));
// 며칠 이어서 쳤는지(2026-10-29 사용자 결정. 2026-10-30부터는 오늘의 10구 대신 10구 도전을 끝까지 친 날로 센다).
// 오늘 아직 안 쳤으면 어제까지 이어진 날 수(오늘 치면 이어진다)이고, 하루라도 빠지면 끊긴다
function playStreak(day = today()) {
  const played = playedDays();
  let n = 0;
  for (let d = played.has(day) ? day : addDay(day, -1); played.has(d); d = addDay(d, -1)) n++;
  return n;
}

const SHARE_EMOJI = { S: '🟢', D: '🟢', T: '🟢', G: '🟢', H: '⭐', Y: '🟡', R: '🔴' };
const rankOf = (score) => (score >= 4000 ? '끝내기 영웅' : score >= 2500 ? '클러치 히터' : score >= 1200 ? '주전 타자' : '내일 다시 도전');

function gameSummary() {
  const rs = game.results, c = (k) => rs.filter((r) => r.kind === k).length;
  const far = Math.max(0, ...rs.filter((r) => r.hit).map((r) => Math.round(r.dist || 0)));
  return { score: game.score, hr: c('hr'), hits: c('single') + c('double') + c('triple'), balls: c('ball'), far, lights: rs.map(lightCode).join('') };
}

const scenarioEndText = (end) => (end === 'win' ? '끝내기 승리!' : end === 'tie' ? '동점으로 끝' : '아쉬운 패배');
const emojiLine = (codes) => codes.split('').map((c) => SHARE_EMOJI[c]).join('');

// 공유 글. 첫 줄에 모드를 적고, 마지막 줄은 늘 게임 주소다
function shareText(s, mode = 'challenge') {
  const bats = s.bats === 'L' ? '좌타' : '우타';
  if (mode === 'scenario') {
    return [
      `walkoff 끝내기 상황 (${bats})`,
      `${scenarioEndText(s.end)} 원정 ${s.away} : ${s.home} 홈`,
      emojiLine(s.pa),
      `처음 상황: ${s.label}`,
      SHARE_URL,
    ].filter(Boolean).join('\n');
  }
  return [
    `walkoff 10구 도전 (${bats})`,
    emojiLine(s.lights),
    `${s.score.toLocaleString()}점${s.newBest ? ' · 새 최고 기록' : ''} · 홈런 ${s.hr}${s.far ? ` · 최장 ${s.far}m` : ''}`,
    SHARE_URL,
  ].join('\n');
}

// 결과 그림 카드(1080x1080). 끝 화면의 큰 줄을 옮겨 그리고 맨 아래에 주소를 새긴다.
// 2026-10-29 카톡 시험(share-test.html)에서 그림과 공유 글을 함께 보내면 둘 다 갔다(사용자 확인)
function drawShareCard(s, mode) {
  const c = document.createElement('canvas');
  c.width = c.height = 1080;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 1080);
  sky.addColorStop(0, '#07111f'); sky.addColorStop(1, '#16304f');
  g.fillStyle = sky; g.fillRect(0, 0, 1080, 1080);
  const t = (str, y, size, weight, color) => {
    g.font = font(size, weight); g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(str, 540, y, 1000);   // 너무 길면 가로로 줄여 카드 안에 넣는다
  };
  const scn = mode === 'scenario', bats = s.bats === 'L' ? '좌타' : '우타';
  t('끝내기', 110, 40, 700, '#f2c94c');
  t('walkoff', 195, 112, 900, '#fff');
  t(`${scn ? '끝내기 상황' : '10구 도전'} · ${bats}`, 320, 44, 600, 'rgba(255,255,255,0.75)');
  if (scn) {
    const [away, home] = sideNames();
    t(scenarioEndText(s.end), 455, 150, 900, s.end === 'win' ? '#f2c94c' : '#fff');
    t(`${away} ${s.away} : ${s.home} ${home} · 9회말`, 605, 52, 700, '#fff');
  } else {
    const streak = playStreak();   // 며칠 이어서 쳤는지(2일부터)
    t(s.score.toLocaleString(), 465, 200, 900, '#f2c94c');
    t(`${s.newBest ? '새 최고 기록!' : rankOf(s.score)}${streak >= 2 ? ` · ${streak}일 연속` : ''}`, 605, 52, 700, '#fff');
  }
  const codes = (scn ? s.pa : s.lights).split(''), gap = Math.min(72, 900 / Math.max(1, codes.length - 1));
  codes.forEach((ch, i) => {
    const x = 540 + (i - (codes.length - 1) / 2) * gap, r = Math.min(24, gap * 0.36);
    if (ch === 'H') {   // 홈런은 초록 별(끝 화면과 같은 모양)
      starPath(g, x, 715, r * STAR_K);
      g.fillStyle = LIGHT.hit; g.fill(); g.lineJoin = 'round'; g.lineWidth = r * STAR_K * 0.16; g.strokeStyle = LIGHT.hit; g.stroke();
      return;
    }
    g.beginPath(); g.arc(x, 715, r, 0, Math.PI * 2);
    g.fillStyle = LIGHT_BY_CODE[ch]; g.fill();
  });
  const cnt = (ch) => codes.filter((x) => x === ch).length;
  t(scn ? `타석 ${codes.length} · 안타 ${cnt('G')} · 볼넷 ${cnt('Y')} · 투구 ${s.pitches}개` : `홈런 ${s.hr} · 안타 ${s.hits} · 볼 ${s.balls}${s.far ? ` · 가장 멀리 ${s.far}m` : ''}`,
    810, 40, 600, 'rgba(255,255,255,0.88)');
  t('walkoff · hyunseungbeom.github.io/walkoff', 980, 36, 600, 'rgba(255,255,255,0.6)');
  return c;
}

// 끝 화면이 뜰 때 카드 그림을 미리 만들어 둔다. 아이폰은 누른 그 순간에 공유를 불러야 해서 누른 뒤에 만들면 늦다.
// 그림 공유를 쓰는 곳(모바일 공유 창)에서만 만든다
// 서버 답으로 '새 최고 기록'이 바뀌어 다시 그릴 때(settleBest)는 새 그림이 다 될 때까지 같은 판의 앞 그림을 쓴다
function prepareShareCard() {
  const old = game.shareCard?.summary === game.summary ? game.shareCard.file : null;
  game.shareCard = null;
  if (!view.mobile || !canShareFiles() || !game.summary || !['challenge', 'scenario'].includes(game.mode)) return;
  const card = { file: old, summary: game.summary };
  game.shareCard = card;
  try {
    pngFile(drawShareCard(game.summary, game.mode), 'walkoff.png', (file) => { card.file = file; });
  } catch { /* 그림을 못 만들면 글만 보낸다 */ }
}

// 모바일은 공유 창을 띄우고(그림 공유가 되면 카드 그림과 글을 함께), 안 되면 클립보드에 복사한다
async function shareResult() {
  if (game.sharing) return;   // 공유 창이 떠 있는 동안 또 누르면 무시한다(안드로이드 크롬은 InvalidStateError를 낸다)
  const text = shareText(game.summary, game.mode);
  if (canShareSheet() && view.mobile) {   // 공유 창을 보냈거나 닫았으면 끝, 공유 창이 안 되면 복사한다
    game.sharing = true;
    try { if (await shareSheet(text, game.shareCard?.file)) return; } finally { game.sharing = false; }
  }
  toast(await copyText(text) ? '복사했어요. 단톡방에 붙여 넣으세요' : '복사하지 못했어요');
}

function toast(msg) { game.toast = { text: msg, until: performance.now() + 2200 }; }
function drawToast() {
  if (game.toast && performance.now() < game.toast.until) pill(game.toast.text, view.w / 2, view.h - (view.mobile ? 36 : 44), { size: 15, bg: 'rgba(0,0,0,0.8)' });
}

// ===== 끝내기 상황 =====
// 규칙(상황 목록, 볼카운트·진루·득점·끝)은 core/scenario.js, 화면 글은 view/text.js
function makeScenario(rnd) {
  const scn = makeScenarioIn(rnd);
  scn.label = scenarioLabel(scn);
  return scn;
}
// 시험·영상용: 지금 판의 상황을 SCENARIOS[k]로 바꾼다(공을 던지기 전에)
function useScenario(k) {
  const base = SCENARIOS[k];
  game.scn = { ...base, bases: [...base.bases], count: { b: 0, s: 0 }, pa: [], end: null };
  game.scn.label = scenarioLabel(game.scn);
}

// 다음 공(core scenarioPitch: 3볼이면 존 안에, 2스트라이크면 유인구를 더). 서버도 같은 시드로 같은 공을 다시 만든다
const nextScenarioPitch = () => scenarioPitch(game.rnd, game.scn.count, game.seq.length + 1, game.throws === 'L');

// 공 하나의 결과를 상황에 반영하고 화면에 띄울 한 줄을 돌려준다. 볼·스트라이크만 늘면 빈 줄이다
function applyScenario(s, r) { return scenarioMessage(s, applyScenarioIn(s, r)); }

function finishScenario() {
  const s = game.scn;
  Object.assign(game, { state: 'over', t: 0, resultT: 0, outcome: null, swingAt: null, replay: null });
  game.summary = { end: s.end, away: s.away, home: s.home, pa: s.pa.join(''), pitches: game.seq.length, label: s.label, bats: settings.bats, score: game.score };
  submitScenario();
  const ss = store.get('scnStats', { plays: 0, wins: 0 });
  store.set('scnStats', { plays: ss.plays + 1, wins: ss.wins + (s.end === 'win' ? 1 : 0) });
  prepareShareCard();
  track('end', game.mode);
}

// 상단: 점수, 볼·스트라이크·아웃 불(실제 전광판처럼 초록·노랑·빨강), 주자 마름모
function drawScenarioOver() {
  const m = view.mobile, cx = view.w / 2, s = game.summary;
  let y = view.h * 0.19;
  text('끝내기 상황', cx, y, { size: m ? 17 : 21, color: 'rgba(255,255,255,0.75)' });
  y += m ? 54 : 68;
  text(scenarioEndText(s.end), cx, y,
    { size: m ? 44 : 64, weight: 900, color: s.end === 'win' ? '#f2c94c' : '#fff', shadow: true });
  y += m ? 48 : 60;
  const [away, home] = sideNames();
  text(`${away} ${s.away} : ${s.home} ${home} · 9회말`, cx, y, { size: m ? 18 : 22 });
  y += m ? 38 : 48;
  const pa = s.pa.split('');
  pa.forEach((c, i) => drawLight(cx + (i - (pa.length - 1) / 2) * (m ? 30 : 36), y, m ? 10 : 12, LIGHT_BY_CODE[c]));
  y += m ? 34 : 42;
  const cnt = (c) => pa.filter((x) => x === c).length;
  text(`타석 ${pa.length} · 안타 ${cnt('G')} · 볼넷 ${cnt('Y')} · 투구 ${s.pitches}개`, cx, y, { size: m ? 14 : 17, weight: 600, color: 'rgba(255,255,255,0.85)' });
  y += m ? 24 : 28;
  text(`처음 상황: ${s.label}`, cx, y, { size: m ? 12 : 14, weight: 500, color: 'rgba(255,255,255,0.6)' });
  y += m ? 26 : 30;
  // 점수와 받은 코인. 로그인 안 했으면 로그인하라는 줄(누르면 카카오 로그인)
  const c = game.scnCoin, coin = !loggedIn() ? '카카오로 로그인하면 코인을 받아요 ›' : c?.status === 'ok' ? `+${c.earned.toLocaleString()}코인${c.bonus > 0 ? ` (승리 보너스 ${c.bonus})` : ''}` : c?.status === 'sending' ? '코인 받는 중…' : c?.status === 'error' ? '연결하지 못해 다음에 열 때 보낼게요' : c ? '이 판은 코인을 받지 못했어요' : '';
  const line = `점수 ${(s.score ?? 0).toLocaleString()}${coin ? ` · ${coin}` : ''}`;
  text(line, cx, y, { size: m ? 14 : 16, weight: 700, color: c?.status === 'ok' ? '#f2c94c' : 'rgba(255,255,255,0.85)' });
  if (!loggedIn()) addButton({ x: cx - 160, y: y - 16, w: 320, h: 32 }, '끝내기 로그인 줄', 'none', startKakaoLogin);
  y += m ? 30 : 36;
  drawBatsToggle(y + 19);
  y += 38 + 18;
  drawRetryShareButtons(y, m ? view.w - 48 : 340, () => startGame('scenario'));
}

// 10구 도전·끝내기 상황 끝 화면: [결과 공유하기 | 다시 하기] 아래에 처음으로. 스페이스바가 다시 하기라서 그쪽을 강조한다
function drawRetryShareButtons(y, bw, retry) {
  const cx = view.w / 2, [a, b] = rowRects(cx, y, bw, 48, 2);
  addButton(a, '결과 공유하기', 'secondary', shareResult);
  addButton(b, '다시 하기', 'primary', retry);
  addButton({ x: cx - 70, y: y + 58, w: 140, h: 36 }, '처음으로', 'link', goTitle);
}

// 끝 화면을 캡처해서 보내도 주소가 함께 가도록 아래쪽에 새긴다
const SITE_LABEL = `walkoff · ${SHARE_URL.replace(/^https:\/\//, '').replace(/\/$/, '')}`;
function drawSiteMark() {
  text(SITE_LABEL, view.w / 2, view.h - (view.mobile ? 40 : 34), { size: view.mobile ? 12 : 13, weight: 600, color: 'rgba(255,255,255,0.5)' });
}

// ===== 연습 =====
// 구종과 빠르기를 골라 끝없이 친다. 점수와 기록은 남기지 않는다
const PRACTICE_TYPES = ['fastball', 'slider', 'curve', 'change', 'fork', 'mix'];
const typeName = (t) => (t === 'mix' ? '섞어서' : PITCH_NAMES[t]);

function nextPracticePitch() {
  const pr = game.practice, rnd = game.rnd;
  const p = makePitch(rnd, pr.type === 'mix' ? pickWeighted(rnd, PITCH_MIX) : pr.type, 0.75, { n: game.seq.length + 1, lefty: pr.throws === 'L' });
  if (pr.slow) p.T *= 1.35;   // 느리게: 같은 공이 35% 늦게 들어온다
  return p;
}

function setPractice(patch) {
  Object.assign(game.practice, patch);
  game.throws = game.practice.throws;   // 다음 공부터 바뀐 손으로 던진다
  store.set('practice', { type: game.practice.type, slow: game.practice.slow, throws: game.practice.throws });
}

// 공과 공 사이에만 보인다. 공이 날아올 때 누르면 스윙이라서
function drawPracticeControls(L) {
  const m = view.mobile, pr = game.practice;
  const [a, b, c, d] = rowRects(view.w / 2, L.replay.y - 50, m ? view.w - 24 : 520, 38, 4, 8);
  addButton(a, `${typeName(pr.type)} ▸`, 'chipOn', () => setPractice({ type: PRACTICE_TYPES[(PRACTICE_TYPES.indexOf(pr.type) + 1) % PRACTICE_TYPES.length] }));
  addButton(b, pr.slow ? '느리게 켬' : '느리게 끔', pr.slow ? 'chipOn' : 'chip', () => setPractice({ slow: !pr.slow }));
  addButton(c, pr.throws === 'L' ? '좌완 ▸' : '우완 ▸', 'chip', () => setPractice({ throws: pr.throws === 'L' ? 'R' : 'L' }));
  addButton(d, '연습 끝', 'chip', goTitle);
  if (!m) text('1~6: 구종 · S: 느리게 · L: 좌완/우완', view.w / 2, L.replay.y - 64, { size: 12, weight: 500, color: 'rgba(255,255,255,0.55)' });
}

// ===== 기록 =====
// 연습을 뺀 모든 판에서 구종별로 쌓는다
function recordPitch(p, r) {
  const st = store.get('stats', {});
  const s = st[p.type] || (st[p.type] = { seen: 0, swings: 0, hits: 0, perfect: 0, sumAbs: 0 });
  s.seen++;
  if (!r.took) {
    s.swings++; s.sumAbs += Math.min(Math.abs(r.dt), 300);
    if (r.hit) s.hits++;
    if (r.perfect) s.perfect++;
  }
  store.set('stats', st);
}

function drawRecords() {
  dim(0.84);
  const m = view.mobile, cx = view.w / 2, w = m ? view.w - 40 : 480, x0 = cx - w / 2;
  let y = view.h * 0.11;
  text('기록', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 44 : 54;
  const ss = store.get('scnStats', { plays: 0, wins: 0 });
  const rows = [
    ['10구 도전 최고', allTimeBest() ? `${allTimeBest().toLocaleString()}점` : '아직 없음'],   // 로그인했으면 계정 역대 최고
    ['끝내기 상황', ss.plays ? `${ss.wins}승 / ${ss.plays}판` : '아직 없음'],
  ];
  for (const [k, v] of rows) {
    text(k, x0, y, { size: m ? 14 : 16, weight: 600, color: 'rgba(255,255,255,0.7)', align: 'left' });
    text(v, x0 + w, y, { size: m ? 14 : 16, weight: 700, align: 'right' });
    y += m ? 30 : 34;
  }
  y += m ? 18 : 22;
  text('구종별 (연습 제외)', x0, y, { size: m ? 13 : 14, weight: 600, color: 'rgba(255,255,255,0.6)', align: 'left' });
  y += m ? 28 : 32;
  const colX = [0, 0.4, 0.55, 0.7, 0.85, 1].map((f) => x0 + w * f);
  const row = (cells, color) => cells.forEach((c, i) => text(c, colX[i], y, { size: m ? 13 : 15, weight: i ? 700 : 600, color, align: i ? 'right' : 'left' }));
  row(['구종', '본 공', '스윙', '안타', '정타', '평균 오차'], 'rgba(255,255,255,0.55)');
  const st = store.get('stats', {});
  for (const t of Object.keys(PITCHES)) {
    y += m ? 28 : 32;
    const s = st[t];
    row([PITCH_NAMES[t], ...(s ? [s.seen, s.swings, s.hits, s.perfect, s.swings ? `${Math.round(s.sumAbs / s.swings)}ms` : '-'] : ['-', '-', '-', '-', '-']).map(String)], '#fff');
  }
  y += m ? 48 : 56;
  addButton({ x: cx - 90, y, w: 180, h: 48 }, '처음으로', 'primary', goTitle);
}

// ===== 칭호·업적(2026-11-05 유저 피드백, 규칙은 core/titles.js) =====
// 10구 도전(조준 판 빼고)을 끝내면 그 판의 전광판으로 칭호를 정한다. 로그인했으면 서버(/scores)가 정해 계정에 남기고, 답의 newTitles(이 판으로 처음 받은 것)·
// titles(받은 것 모두)를 쓴다(게임이 '받았다'고 알리는 방식은 꾸미기 쉬워서). 로그인 안 했으면 이 기기에서 정해 이 브라우저에 남기고(walkoff.titles)
// 칭호 화면에만 보인다. 랭킹에는 계정 칭호만 나온다(메뉴 '역대'와 같은 계정 기준). 계정 칭호는 /me와 /scores 답으로 남겨 둔다(walkoff.accountTitles)
const myTitles = () => (loggedIn() ? store.get('accountTitles', []) : store.get('titles', []));
const titleNames = (ids) => ids.map((id) => titleById(id)?.name).filter(Boolean);
function startTitles() {   // recordGame. 로그인했으면 서버 답(settleTitles)을 기다린다
  game.newTitles = [];
  if (loggedIn()) return;
  const have = store.get('titles', []), got = titlesOf(game.summary.lights).filter((id) => !have.includes(id));
  if (!got.length) return;
  store.set('titles', TITLES.map((t) => t.id).filter((id) => have.includes(id) || got.includes(id)));
  game.newTitles = got;
}
// 칭호 배지: 금색 테두리 알약(왼쪽 끝 x, 가운데 높이 y). 메뉴 카드의 닉네임 옆·랭킹 줄에 쓴다. 폭을 돌려준다
function titleBadge(x, y, label, size) {
  ctx.font = font(size, 800);
  const w = ctx.measureText(label).width + 14, h = size + 8;
  roundRect(x, y - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(242,201,76,0.16)'; ctx.fill();
  ctx.strokeStyle = 'rgba(242,201,76,0.8)'; ctx.lineWidth = 1; ctx.stroke();
  text(label, x + w / 2, y + 0.5, { size, weight: 800, color: '#f2c94c' });
  return w;
}
const titleBadgeW = (label, size) => { ctx.font = font(size, 800); return ctx.measureText(label).width + 14; };
function settleTitles(s, data) {   // /scores·/me 답(옛 서버는 칭호가 없어 그대로)
  if (Array.isArray(data?.titles)) store.set('accountTitles', data.titles.filter((id) => titleById(id)));
  if (s && game.summary === s && Array.isArray(data?.newTitles)) game.newTitles = data.newTitles.filter((id) => titleById(id));
}
// 칭호 화면(메뉴 '기록' 묶음): 칭호마다 받았는지와 조건. 받은 것은 금색 표시. 작은 폰(375×548)에서도 들어가게 한 줄에 이름·조건을 둔다
function drawTitles() {
  dim(0.84);
  const m = view.mobile, cx = view.w / 2, w = m ? view.w - 40 : 480, x0 = cx - w / 2, have = myTitles(), gold = '#f2c94c';
  let y = view.h * (m ? 0.09 : 0.11);
  text('칭호', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 32 : 40;
  text(`${have.length} / ${TITLES.length} · ${loggedIn() ? '받은 칭호 가운데 가장 높은 것이 랭킹에 보여요' : '로그인하면 칭호가 랭킹에 보여요'}`, cx, y, { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.6)' });
  y += m ? 34 : 42;
  const rowH = m ? 46 : 52;
  for (const t of TITLES) {
    const got = have.includes(t.id);
    roundRect(x0, y - rowH / 2 + 3, w, rowH - 6, 12); ctx.fillStyle = got ? 'rgba(242,201,76,0.14)' : 'rgba(255,255,255,0.05)'; ctx.fill();
    if (got) { ctx.strokeStyle = 'rgba(242,201,76,0.55)'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x0 + 20, y, m ? 7 : 8, 0, Math.PI * 2);
    if (got) { ctx.fillStyle = gold; ctx.fill(); } else { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke(); }
    text(t.name, x0 + 38, y, { size: m ? 15 : 17, weight: 800, color: got ? gold : 'rgba(255,255,255,0.8)', align: 'left' });
    text(t.desc, x0 + w - 14, y, { size: m ? 12 : 14, weight: 600, color: got ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)', align: 'right' });
    y += rowH;
  }
  y += m ? 18 : 24;
  addButton({ x: cx - 90, y, w: 180, h: 48 }, '처음으로', 'primary', goTitle);
}

// ===== 팀 고르기 =====
// 처음 온 사람은 열자마자 팀과 닉네임을 고른다(2026-10-28 사용자 결정). 카카오로 시작하면 랭킹에 오르고,
// 로그인 없이도 할 수 있다. 메뉴에서 다시 바꿀 수 있다.
// 닉네임은 한글 입력기 때문에 캔버스로 받을 수 없어서 이 화면에서만 HTML 입력칸을 캔버스 위에 띄운다
const nickInput = document.createElement('input');
Object.assign(nickInput, { type: 'text', maxLength: 10, autocomplete: 'off', spellcheck: false, placeholder: '닉네임' });
nickInput.setAttribute('aria-label', '닉네임');
Object.assign(nickInput.style, {
  position: 'fixed', display: 'none', boxSizing: 'border-box', padding: '0 12px', zIndex: '2', outline: 'none',
  border: '2px solid rgba(255,255,255,0.35)', borderRadius: '12px', background: 'rgba(8,16,30,0.85)', color: '#fff',
  font: `700 16px ${FONT}`, textAlign: 'center',   // 16px보다 작으면 아이폰이 입력할 때 화면을 확대한다
});
document.body.appendChild(nickInput);

// next: 'start'(처음 온 사람) | 'menu'(메뉴에서 바꾸기). play면 고른 뒤 바로 경기를 시작한다(시작 화면을 눌러서 온 경우)
function openOnboard(next, play = false) {
  game.onboard = { next, play, team: settings.team };
  nickInput.value = settings.nick || defaultNick();
  game.state = 'onboard';
}

// how: 'kakao'(카카오로 시작) | 'local'(로그인 없이 하기, 메뉴에서는 저장)
function confirmOnboard(how = 'local') {
  const ob = game.onboard;
  if (!ob.team) { toast('팀을 골라 주세요'); return; }
  const nick = nickInput.value.trim().slice(0, 10) || defaultNick();
  saveTeamAndNick(ob.team, nick);
  nickInput.blur();
  pushProfile();
  if (how === 'local' && ob.next === 'start') skipLogin();   // 처음 화면에서 "나중에 로그인하기"를 골랐으면 그날은 다시 묻지 않는다
  if (how === 'kakao') startKakaoLogin();
  else if (ob.next === 'menu') { goTitle(); toast(`저장했어요 · ${teamById(ob.team).short} ${nick}`); }
  else if (ob.play) startDefault();
  else goTitle();   // 처음 온 사람은 시작 화면에서 규칙과 좌타·우타를 보고 시작한다
}

const UNOFFICIAL = 'KBO·각 구단과 관계없는 비공식 팬 게임이에요';
// 랭킹 기록은 친 날의 팀으로 남는다. 팀을 바꿨는데 랭킹의 팀이 그대로라는 제보가 있어 알린다(2026-10-30)
const TEAM_NOTE = '이미 친 기록은 그날 팀으로 남아요 · 새 팀은 다음 판부터';
function drawTeamChip(r, t, on) {
  roundRect(r.x, r.y, r.w, r.h, 12);
  ctx.fillStyle = on ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'; ctx.fill();
  if (on) { ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2.5; ctx.stroke(); }
  const d = r.h * 0.5, x = r.x + 12 + d / 2, y = r.y + r.h / 2;
  ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2);   // 유니폼 견본: 상의 색에 소매 색 테두리
  ctx.fillStyle = t.main; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = t.accent; ctx.stroke();
  text(t.name, x + d / 2 + 10, y + 1, { size: view.mobile ? 13 : 15, align: 'left' });
}

function drawOnboard() {
  dim(0.62);
  const m = view.mobile, cx = view.w / 2, ob = game.onboard, first = ob.next === 'start';
  let y = view.h * (m ? 0.08 : 0.12);
  text(first ? '내 팀을 고르세요' : '팀·닉네임 바꾸기', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 28 : 36;
  text('팀 색으로 유니폼이 바뀌고, 주간 랭킹에서 팀끼리 겨뤄요', cx, y, { size: m ? 12 : 15, weight: 500, color: 'rgba(255,255,255,0.75)' });
  y += m ? 24 : 34;
  const cols = m ? 2 : 5, gap = m ? 8 : 10, w = m ? view.w - 32 : 900, cw = (w - gap * (cols - 1)) / cols, ch = m ? 40 : 52;
  TEAMS.forEach((t, i) => {
    const r = { x: cx - w / 2 + (i % cols) * (cw + gap), y: y + Math.floor(i / cols) * (ch + gap), w: cw, h: ch };
    drawTeamChip(r, t, ob.team === t.id);
    ui.buttons.push({ r, label: t.name, onTap: () => { ob.team = t.id; } });
  });
  y += Math.ceil(TEAMS.length / cols) * (ch + gap) + (m ? 10 : 16);
  if (ob.next === 'menu') {   // 메뉴에서 팀을 바꿀 때만(처음 온 사람은 기록이 없다)
    text(TEAM_NOTE, cx, y, { size: m ? 11 : 12, weight: 600, color: 'rgba(242,201,76,0.85)' });
    y += m ? 18 : 22;
  }
  text(UNOFFICIAL, cx, y, { size: m ? 11 : 12, weight: 500, color: 'rgba(255,255,255,0.55)' });   // 구단 이름은 상표라서 공식 게임이 아니라고 밝힌다
  y += m ? 24 : 32;
  text('닉네임 · 랭킹에 보여요(10자까지)', cx, y, { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.7)' });
  y += m ? 12 : 18;
  const iw = m ? view.w - 64 : 300;
  Object.assign(nickInput.style, { display: 'block', left: `${cx - iw / 2}px`, top: `${y}px`, width: `${iw}px`, height: '44px' });
  y += 44 + (m ? 16 : 24);
  const bw = m ? view.w - 64 : 300;
  if (first && !loggedIn()) {
    addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, '카카오로 시작', 'kakao', () => confirmOnboard('kakao'));
    y += 48 + (m ? 16 : 20);
    text('카카오에서는 회원번호만 받아요 · 랭킹에만 써요', cx, y, { size: m ? 11 : 12, weight: 500, color: 'rgba(255,255,255,0.55)' });
    addButton({ x: cx - 100, y: y + 10, w: 200, h: 36 }, '나중에 로그인하기', 'link', () => confirmOnboard('local'));
  } else {
    addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, first ? '이 팀으로 시작' : '저장', 'primary', () => confirmOnboard('local'));
    addButton({ x: cx - 70, y: y + 58, w: 140, h: 36 }, first ? '뒤로' : '취소', 'link', goTitle);
  }
}

// ===== 주간 랭킹 =====
// 서버는 worker/(Cloudflare Workers + D1). 10구 도전 점수로 이번 주 최고 기록을 모아 한국 시간 월요일 0시에 새로 시작하는
// 주간 순위를 매긴다. 서버 주소·로그인 표·요청은 infra/api.js
const addDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// worker/src/rules.js의 weekStart와 같은 규칙이다(테스트로 맞춰 본다)
function weekStartOf(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();   // 0 일요일 … 6 토요일
  return addDay(day, -((dow + 6) % 7));
}
// 이번 주 최고 기록(메뉴 칩, 2026-11-05 사용자 결정 '이번 주와 역대 둘 다'. 메뉴 '최고'가 이번 주 랭킹의 내 기록과 달라 보였다).
// 이 기기에 주(한국 시간 월요일)마다 { week, best }. 로그인했으면 점수를 보내고 받은 서버의 이번 주 최고(다른 기기 포함, 랭킹과 같은 숫자),
// 아니면 이 기기에서 이번 주에 끝낸 10구 판의 최고(?seed= 판·조준 판은 빼고). 주가 바뀌면 없는 것으로 본다
function weekBest() {
  const w = loggedIn() ? store.get('accountBest', null) : store.get('weekBest', null);
  return w?.week === weekStartOf(today()) && w.best > 0 ? w.best : null;
}
// 로그인했으면 메뉴·기록 화면의 이번 주·역대 최고는 계정 기록(서버)만 보인다(2026-11-05 사용자 '역대는 계정으로 친 점수 중 역대급으로 잘 친 기록이어야
// 한다. 지난주든 한 달 전이든. 기기별로 말고'. 다른 기기에서 친 17,600점이 메뉴에 15,000점으로 보였다). 이 기기에 { week, best, allTime }으로 남겨 두고
// 메뉴를 열 때(1분에 한 번까지)와 랭킹 화면은 /rankings?player=, 판을 끝내면 /scores 답으로 고친다. 실패·429면 남겨 둔 값 그대로, 받은 적이 없으면
// 칩을 감춘다(기기 값을 잠깐 보였다가 바뀌지 않게). 로그인 전에 이 기기에서 친 판은 계정에 옮기지 않는다(서버가 확인할 수 없다). 로그아웃하면 이 기기 값
const allTimeBest = () => Number(loggedIn() ? store.get('accountBest', null)?.allTime : store.get('best', 0)) || 0;
function setAccountBest(week, best, allTime) {   // allTime이 없으면(옛 서버) 남겨 둔 값 그대로
  const cur = store.get('accountBest', null);
  store.set('accountBest', { week, best: best ?? null, allTime: allTime === undefined ? cur?.allTime ?? null : allTime });
}
const ACCOUNT_BEST_EVERY_MS = 60_000;
let accountBestAt = 0;
async function refreshAccountBest() {
  if (!loggedIn() || Date.now() - accountBestAt < ACCOUNT_BEST_EVERY_MS) return;
  accountBestAt = Date.now();
  try { const d = await fetchRanking(settings.playerId); if (loggedIn()) setAccountBest(d.week, d.me?.best, d.allTime); } catch { /* 남겨 둔 값 그대로 */ }
}
function setWeekBest(week, best, keepMax = true) {
  const cur = store.get('weekBest', null);
  store.set('weekBest', { week, best: keepMax && cur?.week === week ? Math.max(cur.best, best) : best });
}
const fmtMD = (day) => `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
function untilNextWeek(week) {
  const ms = Date.parse(`${addDay(week, 7)}T00:00:00+09:00`) - Date.now();
  return ms > 864e5 ? `새 주까지 ${Math.ceil(ms / 864e5)}일` : `새 주까지 ${Math.max(1, Math.ceil(ms / 3600e3))}시간`;
}

// 10구 도전이 끝나면 점수를 보낸다. 주간 랭킹은 이번 주 최고 기록이라(2026-10-29 사용자 결정) 칠 때마다 보내고,
// 서버는 그날 가장 높은 판만 남긴다. 로그인하고 친 판만 보낸다(2026-10-30 사용자 결정: 로그인 전 판은 연습으로만 남는다).
// 서버가 내준 시드로 친 판은 보내기 전에 이 브라우저에 남겨 두고(아직 못 보낸 판 중 가장 높은 판 하나), 네트워크·서버 오류면
// 다음에 열 때 보낸다. 서버가 거절한 판(날짜가 지났거나 이미 쓴 시드 등)은 버린다
function keepPending(body) {
  if (!body.token) return;
  const old = store.get('pending', null);
  const stale = !old || typeof old !== 'object' || !old.token || !(old.score >= 0) || old.day < addDay(today(), -2);   // 서버는 이틀 전 기록까지 받는다
  if (stale || body.score > old.score) store.set('pending', body);
}

// 남겨 둔 판을 보낸다. 받은 응답(내 순위)을 돌려준다. 서버 시드가 없는 판(예전 게임이 남긴 로그인 전 판)은 버린다
async function sendPending() {
  const body = store.get('pending', null);
  if (!body || typeof body !== 'object' || !loggedIn()) return null;
  if (!body.token) { store.remove('pending'); return null; }
  try {
    const { status, data } = await postScore(body);
    if (status === 401) { logout('expired'); return null; }
    if (status < 500) store.remove('pending');
    return status === 200 && data.ok ? data : null;
  } catch { return null; }
}

async function submitScore(s, mode) {
  if (!settings.team) return;
  if (!settings.nick) saveTeamAndNick(settings.team, defaultNick());
  if (!loggedIn()) return;   // 끝 화면에는 로그인하라는 줄이 나온다
  if (game.fixedSeed) { game.rankInfo = { status: 'unranked' }; return; }   // 주소에 ?seed=를 붙여 공 순서를 정한 판
  // 서버는 자기가 내준 시드(token)로 공 순서를 다시 만들어 전광판·점수를 맞춰 본다. 시드를 못 받은 판은 token 없이 가서 거절된다.
  // seed는 시드를 내주기 전의 서버가 보던 값이다
  // 불은 안타 종류(S·D·T·H)를 담아 보내고 서버가 그것으로 칭호를 정하고 점수 하한·상한을 본다(2026-11-05 칭호 서버부터. 그 전 서버는 G·Y·R만 받았다)
  const body = { nick: settings.nick, team: settings.team, day: s.date, score: s.score, lights: s.lights, mode, seed: game.seed, ...(game.ticket ? { token: game.ticket.token } : {}) };
  keepPending(body);
  game.rankInfo = { status: 'sending' };
  let res;
  try { res = await postScore(body); } catch { res = { status: 0, data: {} }; }
  const { status, data } = res;
  if (status === 401) { logout('expired'); settleBest(s, null); return; }   // 남겨 둔 판은 다시 로그인하면 보낸다
  if (status > 0 && status < 500 && store.get('pending', null)?.token === body.token) store.remove('pending');
  if (status === 200 && data.ok) {
    setWallet({ coins: data.coins });
    setAccountBest(weekStartOf(s.date), data.me?.best, data.allTime);   // 메뉴 '이번 주'·'역대'를 계정 기록으로(랭킹과 같은 숫자)
    game.rankInfo = { status: 'ok', me: data.me, myTeam: data.myTeam, newBest: data.accepted && data.me?.best === s.score, earned: data.earned ?? 0 };
    settleBest(s, data);   // 끝 화면 '최고 기록'도 계정 역대 최고로
    settleTitles(s, data);   // 이 판으로 처음 받은 칭호(서버가 정한다)
  } else { game.rankInfo = { status: status === 400 ? 'rejected' : 'error', error: data.error }; settleBest(s, null); }
}

// 끝내기 상황 코인(2026-11-04 사용자 결정 '이기면 코인, 서버 검증'): 로그인하고 서버 시드로 친 판이 끝나면 공마다 휘두른 때(moves)를 보낸다.
// 서버가 같은 core로 판을 다시 돌려 점수의 1/100 + 이기면 상황별 보너스를 준다(응답 earned는 이번에 받은 코인, coins는 지갑 합계).
// 네트워크·서버 오류면 이 브라우저에 남겨 두고 다음에 열 때 다시 보낸다(서버 표는 사흘 간다). 서버가 거절한 판(400)은 버린다
async function submitScenario() {
  if (!loggedIn() || !game.ticket) return;
  const body = { token: game.ticket.token, bats: settings.bats, moves: game.moves };
  store.set('scnPending', body);
  game.scnCoin = { status: 'sending' };
  let res;
  try { res = await postScenario(body); } catch { res = { status: 0, data: {} }; }
  const { status, data } = res;
  if (status === 401) { logout('expired'); return; }   // 남겨 둔 판은 다시 로그인하면 보낸다
  if (status > 0 && status < 500 && store.get('scnPending', null)?.token === body.token) store.remove('scnPending');
  if (status === 200 && data.ok) {
    setWallet({ coins: data.coins });
    game.scnCoin = { status: 'ok', earned: data.earned ?? 0, bonus: data.bonus ?? 0 };
  } else game.scnCoin = { status: status === 400 ? 'rejected' : 'error', error: data.error };
}
async function resendScenario() {
  const body = store.get('scnPending', null);
  if (!body || typeof body !== 'object' || !body.token || !loggedIn()) return;
  try {
    const { status, data } = await postScenario(body);
    if (status === 401) return;
    if (status < 500) store.remove('scnPending');
    if (status === 200 && data.ok) { setWallet({ coins: data.coins }); if (data.earned > 0) toast(`끝내기 상황 코인 +${data.earned}`); }
  } catch { /* 다음에 열 때 다시 */ }
}

// 로그인하거나 다시 열었을 때 남겨 둔 판을 보낸다
async function resendPending() {
  const d = await sendPending();
  if (d?.accepted) toast('기록을 랭킹에 올렸어요');
}

function openRanking(back) {
  Object.assign(game, { state: 'ranking', rankBack: back, rankView: null });
  loadRanking();
}
async function loadRanking() {
  game.ranking = { status: 'loading' };
  try {
    game.ranking = { status: 'ok', data: await fetchRanking(settings.playerId) };
    if (loggedIn()) setAccountBest(game.ranking.data.week, game.ranking.data.me?.best, game.ranking.data.allTime);
  } catch (e) { game.ranking = { status: 'error', busy: e?.status === 429 }; }
}
function closeRanking() {
  if (game.rankView) { game.rankView = null; return; }   // 사람 모습을 보고 있으면 목록으로
  if (game.rankBack === 'over') game.state = 'over'; else goTitle();
}
// 다른 사람 옷 보기(2026-11-03 사용자 결정, 랭킹 서버가 줄마다 그 사람이 입은 물건(look)을 보낸다). 계정이 없는 예전 기록은 null이라 기본 모습이다
function openRankLook(row) { game.rankView = { nick: row.nick, team: row.team, rank: row.rank, best: row.best ?? row.total ?? 0, look: cleanLook(row.look), title: titleById(row.title)?.name ?? null }; }
// 그 사람의 타자 모습(팀 색 + 입은 물건)을 상점 미리 보기처럼 크게, 3초마다 한 번 휘두른다(등번호는 휘두르면 보인다). 아래에 입은 물건 이름
function drawRankLook() {
  dim(0.86);
  const m = view.mobile, cx = view.w / 2, v = game.rankView, t = teamById(v.team);
  let y = view.h * (m ? 0.07 : 0.08);
  text(v.nick, cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 26 : 32;
  text(`${v.title ? `${v.title} · ` : ''}${t?.name ?? ''} · 이번 주 ${v.rank}위 · ${v.best.toLocaleString()}점`, cx, y, { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.7)' });   // 대표 칭호가 있으면 맨 앞
  y += m ? 18 : 22;
  const bw = m ? view.w - 40 : 420, bh = Math.min(m ? 360 : 420, view.h - y - (m ? 190 : 200)), box = { x: cx - bw / 2, y, w: bw, h: bh };
  drawLookFigure(box, v.look, v.team);
  y += bh + (m ? 22 : 26);
  const names = SHOP_SLOTS.map(([slot, label]) => [label, shopItem(v.look[slot])]).filter(([, it]) => it && it.price > 0).map(([label, it]) => (it.id === 'number-on' ? `등번호 ${v.look.no}` : `${label} ${it.name}`));   // 기본이 아닌 물건만, 종류 이름을 붙여서
  const lines = [''];   // 화면 폭에 맞춰 줄을 나눈다
  ctx.font = font(m ? 12 : 14, 600);
  for (const nm of names) { const cur = lines[lines.length - 1], next = cur ? `${cur} · ${nm}` : nm; if (cur && ctx.measureText(next).width > bw) lines.push(nm); else lines[lines.length - 1] = next; }
  lines.forEach((ln, i) => text(i === 0 && !names.length ? '기본 모습' : ln, cx, y + i * (m ? 18 : 20), { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.8)' }));
  addButton({ x: cx - 90, y: view.h - (m ? 96 : 104), w: 180, h: 48 }, '‹ 랭킹으로', 'primary', closeRanking);
}
function drawLookFigure(box, look, team) {
  roundRect(box.x, box.y, box.w, box.h, 14);
  const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
  g.addColorStop(0, 'rgba(20,40,70,0.9)'); g.addColorStop(0.62, 'rgba(26,74,48,0.9)'); g.addColorStop(1, 'rgba(120,86,52,0.9)');
  ctx.fillStyle = g; ctx.fill();
  lookOverride = { look, team };
  try {
    const u = (performance.now() / 1000) % 3, k = batterSkeleton(u < 1.4 ? null : Math.min(u - 1.4, SWING_TIME * 2));
    // 크기는 준비 자세와 휘두른 자세를 함께 담는 틀로 정해서 휘둘러도 그림이 커졌다 작아졌다 하지 않는다
    const pts = [batterSkeleton(null), batterSkeleton(SWING_TIME * 2)].flatMap((q) => [q.head, q.tip, q.hand, q.feet.l, q.feet.r, q.knees.l, q.knees.r]).map(batterPoint).filter(Boolean);
    if (pts.length < 2) return;
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y)) - 20, maxY = Math.max(...pts.map((p) => p.y)) + 12;
    const sc = Math.min((box.w * 0.8) / (maxX - minX), (box.h * 0.9) / (maxY - minY));
    ctx.save();
    roundRect(box.x, box.y, box.w, box.h, 14); ctx.clip();
    ctx.translate(box.x + box.w / 2, box.y + box.h * 0.05); ctx.scale(sc, sc); ctx.translate(-(minX + maxX) / 2, -minY);
    drawFigureShadow(k);
    const C = batterColors();
    drawBatterFigure(k, (name) => C[name], 0);
    ctx.restore();
  } finally { lookOverride = null; }
}

// 끝 화면 점수 아래 줄 끝에 붙이는 받은 코인: " · +64코인"
const coinNote = () => { const ri = game.rankInfo; return loggedIn() && ri?.earned > 0 ? ` · +${ri.earned}코인` : ''; };

// 끝 화면 한 줄: "이번 주 최고 기록! 3위 · 랭킹 보기 ›" 또는 "이번 주 최고 4,200점 · 3위 · 랭킹 보기 ›".
// 로그인하지 않았으면 로그인하라는 줄, 랭킹에 안 올라간 판이면 그 까닭
function rankLine() {
  if (!loggedIn()) return '카카오로 로그인하면 다음 판부터 랭킹에 올라가요 ›';
  const ri = game.rankInfo;
  if (ri?.status === 'unranked') return '주소로 정한 공은 랭킹에 안 올라가요 · 랭킹 보기 ›';
  if (!ri || ri.status === 'sending') return '이번 주 랭킹을 불러오는 중…';
  if (ri.status === 'rejected') return ri.error === 'seed_required' ? '랭킹 서버에 연결하지 못해 안 올라갔어요 · 랭킹 보기 ›' : '이 판은 랭킹에 올리지 못했어요 · 랭킹 보기 ›';
  if (ri.status === 'error') return '랭킹 서버에 연결하지 못했어요 · 랭킹 보기 ›';
  if (!ri.me) return '이번 주 랭킹 보기 ›';
  return ri.newBest ? `이번 주 최고 기록! ${ri.me.rank}위 · 랭킹 보기 ›` : `이번 주 최고 ${(ri.me.best ?? ri.me.total ?? 0).toLocaleString()}점 · ${ri.me.rank}위 · 랭킹 보기 ›`;
}

function drawRankRow(y, x0, w, cells, highlight) {
  const m = view.mobile, h = m ? 28 : 32;
  if (highlight) { roundRect(x0 - 8, y - h / 2, w + 16, h, 8); ctx.fillStyle = 'rgba(242,201,76,0.2)'; ctx.fill(); }
  const [rank, team, name, sub, total, badge] = cells, t = teamById(team), subX = x0 + w * (m ? 0.66 : 0.64);
  text(rank, x0 + 18, y, { size: m ? 13 : 15, weight: 800, color: '#f2c94c' });
  if (t) { ctx.beginPath(); ctx.arc(x0 + 46, y, 6, 0, Math.PI * 2); ctx.fillStyle = t.main; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.accent; ctx.stroke(); }
  text(name, x0 + 60, y, { size: m ? 13 : 15, weight: 700, align: 'left' });
  if (badge) {   // 대표 칭호 배지(2~4글자): 이름 뒤에 들어갈 자리가 있을 때만(폰은 줄이 좁다)
    ctx.font = font(m ? 13 : 15, 700);
    const bx = x0 + 60 + ctx.measureText(name).width + 6, bs = m ? 10 : 11;
    ctx.font = font(m ? 11 : 13, 600);
    if (bx + titleBadgeW(badge, bs) <= subX - ctx.measureText(sub).width / 2 - 6) titleBadge(bx, y, badge, bs);
  }
  text(sub, subX, y, { size: m ? 11 : 13, weight: 600, color: 'rgba(255,255,255,0.6)' });
  text(total, x0 + w, y, { size: m ? 13 : 15, weight: 800, align: 'right' });
}

function drawRanking() {
  if (game.rankView) { drawRankLook(); return; }
  dim(0.86);
  const m = view.mobile, cx = view.w / 2, w = m ? view.w - 40 : 560, x0 = cx - w / 2, rk = game.ranking ?? { status: 'loading' }, d = rk.data;
  let y = view.h * (m ? 0.08 : 0.1);
  text('이번 주 랭킹', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 28 : 34;
  const week = d?.week ?? weekStartOf(today());
  text(`${fmtMD(week)}(월) ~ ${fmtMD(addDay(week, 6))}(일) · ${untilNextWeek(week)}`, cx, y, { size: m ? 12 : 14, weight: 500, color: 'rgba(255,255,255,0.65)' });
  y += m ? 30 : 36;
  rowRects(cx, y, m ? 220 : 260, 36, 2, 8).forEach((r, i) => {
    const tab = i ? 'teams' : 'players';
    addButton(r, i ? '팀' : '개인', game.rankTab === tab ? 'chipOn' : 'chip', () => { game.rankTab = tab; });
  });
  y += 36 + (m ? 18 : 22);
  text(game.rankTab === 'players' ? '이번 주 최고 기록 순위예요 · 누르면 입은 모습' : '팀원들의 이번 주 최고 기록을 더한 순위예요', cx, y, { size: m ? 11 : 13, weight: 500, color: 'rgba(255,255,255,0.55)' });
  y += m ? 16 : 20;
  text(TEAM_NOTE, cx, y, { size: m ? 11 : 13, weight: 500, color: 'rgba(255,255,255,0.55)' });
  y += m ? 26 : 32;
  const note = (s) => text(s, cx, y + 20, { size: m ? 13 : 15, weight: 500, color: 'rgba(255,255,255,0.75)' });
  if (rk.status === 'loading') note('불러오는 중…');
  else if (rk.status === 'error') {
    note(rk.busy ? '요청이 많아요. 잠시 뒤 다시 해 주세요' : '랭킹을 불러오지 못했어요');   // busy: 서버 횟수 제한(429)
    addButton({ x: cx - 80, y: y + 44, w: 160, h: 42 }, '다시 시도', 'secondary', loadRanking);
  } else {
    const players = game.rankTab === 'players', rows = players ? d.players : d.teams;
    if (!rows.length) note('아직 이번 주 기록이 없어요. 한 판 쳐서 첫 줄에 올라 보세요');
    const shown = rows.slice(0, 10), mine = players ? rows.find((p) => p.me) : rows.find((t) => t.team === d.myTeam?.team);
    if (mine && !shown.includes(mine)) shown.push(null, mine);   // 10위 밖이면 … 아래에 내 줄
    const step = m ? 30 : 34;
    for (const row of shown) {
      if (!row) { text('…', cx, y, { size: 14, color: 'rgba(255,255,255,0.5)' }); y += step; continue; }
      const total = `${((players ? row.best : null) ?? row.total ?? 0).toLocaleString()}점`;   // 서버가 바뀌기 전이면 사람 점수도 total로 온다
      if (players) {
        drawRankRow(y, x0, w, [String(row.rank), row.team, row.nick, `${row.days}일`, total, titleById(row.title)?.short], row.me);
        const h = m ? 28 : 32;
        addButton({ x: x0 - 8, y: y - h / 2, w: w + 16, h }, `랭킹 줄 ${row.rank}`, 'none', () => openRankLook(row));
      }
      else drawRankRow(y, x0, w, [String(row.rank), row.team, teamById(row.team)?.name ?? row.team, `${row.players}명`, total], row === mine);
      y += step;
    }
    const lp = d.lastWeek?.player, lt = d.lastWeek?.team;
    if (lp || lt) {
      y += m ? 8 : 12;
      text(`지난주 1위 ${lp ? `${lp.nick}(${teamById(lp.team)?.short ?? ''}) ${(lp.best ?? lp.total ?? 0).toLocaleString()}점` : '-'} · 팀 1위 ${lt ? teamById(lt.team)?.short ?? lt.team : '-'}`, cx, y,
        { size: m ? 11 : 13, weight: 600, color: 'rgba(255,255,255,0.6)' });
    }
  }
  if (!loggedIn()) addButton({ x: cx - 150, y: view.h - (m ? 152 : 162), w: 300, h: 30 }, '카카오로 로그인하면 나도 올라가요 ›', 'link', startKakaoLogin);
  text(UNOFFICIAL, cx, view.h - (m ? 112 : 122), { size: m ? 11 : 12, weight: 500, color: 'rgba(255,255,255,0.5)' });
  addButton({ x: cx - 90, y: view.h - (m ? 96 : 104), w: 180, h: 48 }, '닫기', 'primary', closeRanking);
}

// ===== 카카오 로그인 =====
// 로그인한 사람만 주간 랭킹에 오른다(2026-10-28 사용자 결정). 카카오 로그인 화면으로 가고 돌아오는 일은 infra/auth.js,
// 로그인 표와 서버 요청은 infra/api.js, 10구 도전 시드는 infra/seeds.js
function startKakaoLogin() { goKakaoLogin(settings.playerId); }

// 카카오 로그인에서 돌아왔으면 로그인 표를 받고(infra/auth.js), 못 했으면 알린다
function loginReturned() {
  const back = readLoginReturn();
  if (back === 'canceled') toast('카카오 로그인을 취소했어요');
  else if (back === 'failed') toast('카카오 로그인을 하지 못했어요. 잠시 뒤 다시 해 주세요');
}

// 로그인 표로 계정을 확인하고 팀·닉네임을 맞춘다. 다른 기기에서 쓰던 계정이면 그 팀·닉네임으로 이어 가고,
// 새 계정이면 이 브라우저에서 고른 팀·닉네임을 올린다. 그다음 아직 못 올린 기록을 보낸다
async function syncAccount() {
  if (!auth.token) return;
  try {
    const res = await api('/me');
    if (res.status === 401) { logout('expired'); return; }
    if (!res.ok) return;
    const acct = await res.json();
    if (settings.playerId !== acct.playerId) { store.remove('accountBest'); store.remove('accountTitles'); accountBestAt = 0; }   // 다른 계정의 값을 보이지 않게
    settings.playerId = acct.playerId; store.set('playerId', acct.playerId);
    setWallet(acct);
    settleTitles(null, acct);
    let msg = '카카오로 로그인했어요';
    if (store.get('profileDirty', 0) && teamById(settings.team)) await pushProfile();   // 지난번에 바꾼 팀을 못 적었으면 서버의 옛 팀으로 덮지 않고 다시 보낸다
    else if (teamById(acct.team)) {
      if (acct.team !== settings.team || (acct.nick && acct.nick !== settings.nick)) msg = `이어서 해요 · ${teamById(acct.team).short} ${acct.nick || settings.nick}`;
      saveTeamAndNick(acct.team, acct.nick || settings.nick || defaultNick());
      if (game.state === 'onboard' && game.onboard.next === 'start') goTitle();
    } else await pushProfile();
    if (auth.fresh) toast(msg);
    auth.fresh = false;
    await resendPending();
    await resendScenario();
  } catch { /* 네트워크 오류면 다음에 열 때 다시 맞춘다 */ }
}

// 팀·닉네임을 계정에도 적는다. 다른 기기에서 이어 가고, 랭킹의 이름이 바로 바뀐다
// 저장하지 못하면(네트워크·서버 오류) 알리고 이 브라우저에 표시해 둔다. 다음에 열 때 syncAccount가 서버의 옛 팀으로 덮지 않고 다시 보낸다.
// 전에는 조용히 넘어가서, 다음에 열면 팀이 옛 팀으로 돌아갔다(2026-10-30 '팀이 안 바뀐다' 제보)
async function pushProfile() {
  if (!auth.token || !settings.team) return true;
  try {
    const res = await api('/me', { method: 'PUT', body: { nick: settings.nick || defaultNick(), team: settings.team } });
    if (res.status === 401) { logout('expired'); return false; }
    if (!res.ok) throw new Error(`profile ${res.status}`);
    store.remove('profileDirty');
    return true;
  } catch {
    store.set('profileDirty', 1);
    toast('팀·닉네임을 서버에 저장하지 못했어요. 다음에 열 때 다시 저장할게요');
    return false;
  }
}

function logout(reason) {
  Object.assign(auth, { token: null, fresh: false });
  seedTicket.ready = null;   // 받아 둔 시드는 그 계정 것이다
  store.remove('session'); store.remove('accountBest'); store.remove('accountTitles'); accountBestAt = 0;   // 메뉴 최고 기록·칭호는 다시 이 기기 값으로
  resetWallet();   // 코인과 꾸미기는 계정에 남는다. 이 브라우저는 기본 모습으로
  toast(reason === 'expired' ? '로그인이 풀렸어요. 메뉴에서 다시 로그인해 주세요' : '로그아웃했어요');
}
onSeedExpired(() => logout('expired'));   // 시드를 받다가 로그인이 풀렸을 때(infra/seeds.js)

// 랭킹 기록 지우기: 서버의 점수와 계정을 지우고, 이 브라우저는 새 ID로 시작한다
async function deleteAccount() {
  try {
    const res = await api('/me', { method: 'DELETE' });
    if (!res.ok && res.status !== 401) throw new Error(`delete ${res.status}`);
    Object.assign(auth, { token: null, fresh: false });
    seedTicket.ready = null;
    ['session', 'pending', 'playerId', 'accountBest', 'accountTitles'].forEach((k) => store.remove(k));
    resetWallet();
    settings.playerId = ensurePlayerId();
    goTitle();
    toast('랭킹 기록과 계정을 지웠어요');
  } catch { toast('지우지 못했어요. 잠시 뒤 다시 해 주세요'); }
}

// 로그인 안 한 사람이 시작 화면에서 10구 판을 시작하려고 하면 하루 한 번 카카오 로그인을 권한다(2026-10-29 사용자 요청).
// "나중에 하기"를 누르면 바로 시작하고 그날은 다시 묻지 않는다. 로그인하기 전에 친 판은 랭킹에 올리지 않는다(2026-10-30 사용자 결정)
const askLoginToday = () => !loggedIn() && store.get('loginLater', '') !== today();
const skipLogin = () => store.set('loginLater', today());
function drawLoginPrompt() {
  dim(0.82);
  const m = view.mobile, cx = view.w / 2, bw = m ? view.w - 64 : 320, sub = { size: m ? 11 : 12, weight: 500, color: 'rgba(255,255,255,0.55)' };
  let y = view.h * (m ? 0.26 : 0.28);
  text('카카오로 로그인할까요?', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 38 : 46;
  ['로그인하면 이번 주 최고 기록이 주간 랭킹에 올라가요.', '다른 폰이나 브라우저에서도 이어서 해요.'].forEach((l) => {
    text(l, cx, y, { size: m ? 14 : 16, weight: 600, color: 'rgba(255,255,255,0.85)' });
    y += m ? 22 : 26;
  });
  y += m ? 16 : 20;
  addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, '카카오로 로그인', 'kakao', startKakaoLogin);
  y += 48 + (m ? 16 : 20);
  text('카카오에서는 회원번호만 받아요 · 랭킹에만 써요', cx, y, sub);
  addButton({ x: cx - 80, y: y + 10, w: 160, h: 36 }, '나중에 하기', 'link', () => { skipLogin(); startDefault(); });
  text('로그인하기 전에 친 판은 랭킹에 안 올라가요', cx, y + 64, sub);
}

// 내 계정(로그인했을 때) 또는 카카오 로그인 안내(안 했을 때). 개인정보 안내도 여기 둔다
const PRIVACY = [
  '카카오에서는 회원번호만 받아 알아볼 수 없게 저장해요.',
  '닉네임·팀·점수와 함께 랭킹에만 써요.',
  '랭킹 기록 지우기를 누르면 바로 모두 지워요.',
];
function openAccount() { Object.assign(game, { state: 'account', account: { confirm: false } }); }
function drawAccount() {
  dim(0.86);
  const m = view.mobile, cx = view.w / 2, bw = m ? view.w - 64 : 320, ac = game.account, t = teamById(settings.team);
  let y = view.h * (m ? 0.16 : 0.2);
  text(loggedIn() ? '내 계정' : '카카오 로그인', cx, y, { size: m ? 22 : 28, weight: 800 });
  y += m ? 36 : 44;
  const lines = loggedIn() ? ['카카오로 로그인돼 있어요', t ? `${t.name} · ${settings.nick}` : ''] : ['로그인하면 이번 주 랭킹에 올라가고,', '다른 폰이나 브라우저에서도 이어서 해요'];
  lines.filter(Boolean).forEach((l) => { text(l, cx, y, { size: m ? 14 : 16, weight: 600, color: 'rgba(255,255,255,0.85)' }); y += m ? 22 : 26; });
  y += m ? 12 : 16;
  if (!loggedIn()) {
    addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, '카카오로 로그인', 'kakao', startKakaoLogin);
    y += 60;
  } else if (!ac.confirm) {
    addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, '로그아웃', 'secondary', () => { logout(); goTitle(); });
    addButton({ x: cx - bw / 2, y: y + 60, w: bw, h: 48 }, '랭킹 기록 지우기', 'secondary', () => { ac.confirm = true; });
    y += 120;
  } else {
    text('이번 주와 지난 기록, 계정을 모두 지워요. 되돌릴 수 없어요.', cx, y + 4, { size: m ? 12 : 14, weight: 600, color: '#ffb4b4' });
    const [a, b] = rowRects(cx, y + (m ? 24 : 28), bw, 48, 2);
    addButton(a, '지우기', 'danger', deleteAccount);
    addButton(b, '취소', 'secondary', () => { ac.confirm = false; });
    y += (m ? 24 : 28) + 60;
  }
  y += m ? 8 : 12;
  PRIVACY.forEach((l) => { text(l, cx, y, { size: m ? 11 : 13, weight: 500, color: 'rgba(255,255,255,0.55)' }); y += m ? 18 : 21; });
  addButton({ x: cx - 70, y: y + 8, w: 140, h: 36 }, '닫기', 'link', goTitle);
}

// ===== 상점과 내 물건 =====
// 판마다 점수의 1/100을 코인으로 받아 배트·헬멧·장갑·신발·유니폼·등번호·공 꼬리·타격음을 꾸민다(오늘의 10구 첫 판 2배는 오늘의 10구와 함께 없앴다)
// (2026-10-29 사용자 결정). 코인과 물건은 로그인한 사람만 서버에 남고, 가격은 서버(worker/src/shop.js)가 정한다.
// 물건 id·종류·가격은 core/catalog.js(랭킹 서버와 같이 쓴다)에 있고, 여기는 이름과 색·모양이다. 가격 0은 처음부터 가진 기본 물건이다
const SLOT_NAMES = { bat: '배트', helmet: '헬멧', glove: '장갑', shoe: '신발', uniform: '유니폼', number: '등번호', trail: '공 꼬리', sound: '타격음' };
const SHOP_SLOTS = SLOTS.map((slot) => [slot, SLOT_NAMES[slot]]);
const ITEM_LOOKS = {
  'bat-wood': { name: '원목', colors: { bat: '#c8955a', batEnd: '#8a5e32' } },
  'bat-maple': { name: '메이플', colors: { bat: '#e6c590', batEnd: '#b38952' } },
  'bat-black': { name: '검정', colors: { bat: '#2a2c33', batEnd: '#121317' } },
  'bat-red': { name: '빨강', colors: { bat: '#c8202c', batEnd: '#7d0f17' } },
  'bat-blue': { name: '파랑', colors: { bat: '#2457c5', batEnd: '#142f6e' } },
  'bat-silver': { name: '알루미늄', colors: { bat: '#cfd4dc', batEnd: '#8d939d' } },
  'bat-gold': { name: '금색', colors: { bat: '#eebf2c', batEnd: '#a67c0d' } },
  // 2026-10-30 사용자 요청으로 더한 물건. fx는 색만 바꾸는 물건과 달리 따로 그리는 모양·효과(drawBat·drawHelmet·drawShoe)
  'bat-fire': { name: '불꽃', colors: { bat: '#3a1a10', batEnd: '#b8401a' }, fx: 'fire' },
  'bat-lightning': { name: '번개', colors: { bat: '#262a66', batEnd: '#4b56c9' }, fx: 'lightning' },
  'bat-ice': { name: '얼음', colors: { bat: '#e4f6fc', batEnd: '#86cde9' }, fx: 'ice' },
  'bat-hammer': { name: '뿅망치', colors: { bat: '#f2c94c', batEnd: '#e0393e' }, fx: 'hammer' },
  'bat-leek': { name: '대파', colors: { bat: '#f1efdc', batEnd: '#3f9b3a' }, fx: 'leek' },
  // 2026-11-03 사용자 요청 '고가로 퀄리티 있게'로 더한 고가 물건(1,500~6,000코인). 움직이는 효과를 따로 그린다
  'bat-beam': { name: '광선', colors: { bat: '#eafcff', batEnd: '#38c8ff' }, fx: 'beam' },
  'bat-diamond': { name: '다이아몬드', colors: { bat: '#e4f7ff', batEnd: '#9edcf6' }, fx: 'diamond' },
  'helmet-team': { name: '팀 색' },
  'helmet-black': { name: '검정 무광', colors: { helmet: '#202227' } },
  'helmet-white': { name: '흰색', colors: { helmet: '#eceef2' } },
  'helmet-chrome': { name: '크롬 은색', colors: { helmet: '#bfc7d3' } },
  'helmet-gold': { name: '금색', colors: { helmet: '#e3b322' } },
  'helmet-turtle': { name: '거북이', colors: { helmet: '#3f8a4a' }, fx: 'turtle' },
  'helmet-rabbit': { name: '토끼', colors: { helmet: '#f3f0f2' }, fx: 'rabbit' },
  'helmet-bear': { name: '곰', colors: { helmet: '#7a4e2d' }, fx: 'bear' },
  'helmet-tiger': { name: '호랑이', colors: { helmet: '#e8892b' }, fx: 'tiger' },
  'helmet-lion': { name: '사자', colors: { helmet: '#e2b04c' }, fx: 'lion' },
  'helmet-dino': { name: '공룡', colors: { helmet: '#5fae4e' }, fx: 'dino' },
  'helmet-crown': { name: '왕관', fx: 'crown' },
  'helmet-astro': { name: '우주인', colors: { helmet: '#f2f4f8' }, fx: 'astro' },
  'glove-white': { name: '흰색', colors: { glove: '#e9e9ec' } },
  'glove-black': { name: '검정', colors: { glove: '#25272d' } },
  'glove-red': { name: '빨강', colors: { glove: '#d3232f' } },
  'glove-blue': { name: '파랑', colors: { glove: '#2a5bd0' } },
  'glove-neon': { name: '형광 노랑', colors: { glove: '#d8f53a' } },
  'shoe-black': { name: '검정', colors: { shoe: '#121418' } },
  'shoe-white': { name: '흰색', colors: { shoe: '#eef0f3' } },
  'shoe-red': { name: '빨강', colors: { shoe: '#c81e2b' } },
  'shoe-neon': { name: '형광 초록', colors: { shoe: '#3be86c' } },
  'shoe-gold': { name: '금색', colors: { shoe: '#e3b322' } },
  'shoe-bear': { name: '곰 발', colors: { shoe: '#7a4e2d' }, fx: 'bear' },
  'shoe-tiger': { name: '호랑이 발', colors: { shoe: '#e8892b' }, fx: 'tiger' },
  'shoe-rabbit': { name: '토끼 슬리퍼', colors: { shoe: '#f3f0f2' }, fx: 'rabbit' },
  'shoe-dino': { name: '공룡 발', colors: { shoe: '#5fae4e' }, fx: 'dino' },
  'shoe-duck': { name: '오리발', colors: { shoe: '#f39a1e' }, fx: 'duck' },
  'shoe-rocket': { name: '로켓 부츠', colors: { shoe: '#dfe3ea' }, fx: 'rocket' },
  'shoe-bolt': { name: '번개 운동화', colors: { shoe: '#27304a' }, fx: 'bolt' },
  'uniform-team': { name: '팀 색' },   // 유니폼 스타일을 바꿔도 소매·스타킹은 팀 색(팀 대항 랭킹이라)
  'uniform-home': { name: '홈(흰색)', colors: { jersey: '#eceef2', shade: '#c4c9d3', pants: '#eceef2', pantsShade: '#c4c9d3' } },
  'uniform-away': { name: '원정(회색)', colors: { jersey: '#9097a4', shade: '#717885', pants: '#9aa1ad', pantsShade: '#7b828e' } },
  'uniform-alt': { name: '얼터(검정)', colors: { jersey: '#1d2026', shade: '#121418', pants: '#dcdfe5', pantsShade: '#b4b9c2' } },
  'uniform-legend': { name: '금장', colors: { jersey: '#17191f', shade: '#0d0e12', pants: '#17191f', pantsShade: '#0d0e12' }, fx: 'legend' },
  'uniform-neon': { name: '네온', colors: { jersey: '#111628', shade: '#090c18', pants: '#111628', pantsShade: '#090c18' }, fx: 'neon' },
  'number-none': { name: '없음' },
  'number-on': { name: '등번호 달기' },
  'trail-none': { name: '없음' },
  'trail-fire': { name: '불꽃' },
  'trail-rainbow': { name: '무지개' },
  'trail-lightning': { name: '번개' },
  'trail-heart': { name: '하트' },
  'trail-star': { name: '별' },
  'trail-comet': { name: '혜성' },
  'trail-dragon': { name: '용' },
  'sound-wood': { name: "나무 '딱'" },
  'sound-metal': { name: "알루미늄 '깡'" },
  'sound-toy': { name: "장난감 '뿅'" },
  'sound-bomb': { name: "폭탄 '쾅'" },
  'sound-laser': { name: "레이저 '퓽'" },
  'sound-bell': { name: "종 '댕'" },
  'sound-drum': { name: "북 '둥'" },
  'sound-thunder': { name: "천둥 '콰광'" },
  'sound-8bit': { name: "8비트 '띠링'" },
};
const SHOP_ITEMS = ITEMS.map((it) => ({ ...it, ...ITEM_LOOKS[it.id] }));
const shopItem = (id) => SHOP_ITEMS.find((i) => i.id === id) ?? null;
const DEFAULT_LOOK = Object.fromEntries(SHOP_SLOTS.map(([slot]) => [slot, SHOP_ITEMS.find((i) => i.slot === slot && i.price === 0).id]));

// 착용 상태를 정리한다(서버의 lookOf와 같은 규칙). 이 브라우저에도 남겨서 다음에 열 때 서버 답이 오기 전에도 그 모습으로 그린다
function cleanLook(v) {
  const look = { ...DEFAULT_LOOK };
  for (const [slot] of SHOP_SLOTS) { const it = shopItem(v?.[slot]); if (it && it.slot === slot) look[slot] = it.id; }
  if (look.number === 'number-on' && Number.isInteger(v?.no) && v.no >= 0 && v.no <= 99) look.no = v.no;
  else look.number = 'number-none';
  return look;
}
const wallet = { coins: null, owned: [], look: cleanLook(store.get('look', null)) };   // coins가 null이면 모른다(로그인 안 함)
function setWallet(w) {
  if (typeof w?.coins === 'number') wallet.coins = w.coins;
  if (Array.isArray(w?.owned)) wallet.owned = w.owned;
  if (w?.look) { wallet.look = cleanLook(w.look); store.set('look', wallet.look); }
}
function resetWallet() { Object.assign(wallet, { coins: null, owned: [], look: { ...DEFAULT_LOOK } }); store.remove('look'); }
const owns = (id) => shopItem(id)?.price === 0 || wallet.owned.includes(id);
const wearing = (it) => wallet.look[it.slot] === it.id;

// 지금 그릴 모습. 상점에서 고르는 중이면 그 물건을 미리 입힌다
// 다른 사람 모습을 그리는 동안만 { look, team }(랭킹에서 사람을 누를 때). 타자 그리기가 모두 currentLook()·batterColors()를 거쳐서 이것만 바꾸면 된다
let lookOverride = null;
function currentLook() {
  if (lookOverride) return lookOverride.look;
  const sh = game.shop, it = game.state === 'shop' && sh?.sel ? shopItem(sh.sel) : null;
  if (!it) return wallet.look;
  const look = { ...wallet.look, [it.slot]: it.id };
  if (it.id === 'number-on') look.no = sh.no;
  return look;
}

// 팀 색 바탕 위에 유니폼 스타일과 배트·헬멧·장갑·신발 색을 덮는다. 유니폼 스타일은 소매·스타킹을 팀 색으로 둔다
function lookPalette(base, t, look) {
  const c = { ...base }, u = shopItem(look.uniform)?.colors;
  if (u) Object.assign(c, u, t ? { accent: t.main, sleeve: t.main } : {});   // 상점 유니폼도 소매·양말은 팀 색
  for (const slot of ['bat', 'helmet', 'glove', 'shoe']) Object.assign(c, shopItem(look[slot])?.colors ?? {});
  return c;
}

// 등번호: 몸통 등 쪽 점에 그리고, 등이 카메라를 향한 만큼만 보인다. 칠 준비 자세에서는 등이 3루 쪽이라 안 보이고,
// 스윙하면 몸이 돌아 보인다. 등 쪽으로 기울어진 만큼 가로로 줄여서 몸에 붙은 것처럼 보이게 한다
const isLight = (hex) => { const n = parseInt(String(hex).slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) > 160; };
// 등번호 자리와 크기. 등 가운데 아래(팔에 덜 가린다)에 키 0.26m로 두고, 숫자 폭이 그 높이의 등 폭(몸이 돌면 좁아 보인다)의
// 78%(한 자리는 50%)를 넘지 않게 가로로 줄인다. 전에는 키 0.3m에 폭을 안 봐서 두 자리면 등 밖으로 넘쳤다(2026-10-29 사용자 제보)
function backNumberFit(k, P, str) {
  const fc = k.facing(k.shTurn), lc = k.left(k.shTurn), at = V.add(k.chest, [-fc[0] * 0.14, -0.2, -fc[2] * 0.14]), q = P(at);
  if (!q) return null;
  const sd = k.world ? 1 : batSide(), wx = k.world ? at[0] : sd * (at[0] + batterShift()), d = [cam.x - wx, cam.y - at[1], cam.z - at[2]], len = V.len(d);
  const vis = (sd * -fc[0] * d[0] - fc[2] * d[2]) / len;   // 등 방향과 카메라 방향이 얼마나 같은지(0~1). 주자(화면 기준 좌표)는 뒤집지 않는다
  if (vis <= 0.2) return null;
  const a = P(V.add(at, V.mul(lc, 0.17))), b = P(V.add(at, V.mul(lc, -0.17)));   // 그 높이의 등 양 끝(상의 폭 0.34m, drawBatterFigure의 몸통 단면)
  if (!a || !b) return null;
  const size = Math.max(10, 0.26 * q.s), backW = Math.abs(a.x - b.x);
  ctx.font = font(size, 900);
  const textW = ctx.measureText(str).width;
  return { x: (a.x + b.x) / 2, y: q.y, s: q.s, size, backW, textW, sx: Math.min(vis, backW * (str.length > 1 ? 0.78 : 0.5) / textW) };
}

// 테스트용: 스윙 뒤 tau초 자세에서 등번호 no가 차지하는 자리와 등 폭
const backNumberBox = (no, tau) => backNumberFit(batterSkeleton(tau), batterPoint, String(no));

function drawBackNumber(k, P, col, jersey) {
  const look = currentLook();
  if (look.number !== 'number-on' || !Number.isInteger(look.no)) return;
  const str = String(look.no), fit = backNumberFit(k, P, str);
  if (!fit) return;
  const light = isLight(col('jersey')), t = teamById(settings.team);
  ctx.save();
  if (jersey && smoothPath(jersey)) ctx.clip();   // 상의 밖으로는 그리지 않는다
  ctx.translate(fit.x, fit.y); ctx.scale(fit.sx, 1);
  ctx.font = font(fit.size, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, 0.022 * fit.s);
  const ufx = fxOf(look.uniform), h = fit.size / 2;
  if (ufx === 'legend') {   // 금장: 짙은 테두리 위에 위가 밝은 금(가운데에 비친 띠). 2.6초마다 빛 한 줄기가 비스듬히 훑고 지나간다(글자 모양에만 칠해진다)
    ctx.strokeStyle = GOLD.edge; ctx.strokeText(str, 0, 0);
    ctx.fillStyle = gradientAlong({ x: 0, y: -h }, { x: 0, y: h }, [[0, GOLD.light], [0.48, GOLD.mid], [0.52, GOLD.deep], [1, GOLD.mid]]); ctx.fillText(str, 0, 0);
    const u = (fxTime() / 2.6 % 1) * 1.6 - 0.3, wd = fit.textW / 2;
    if (u > 0.12 && u < 0.88) { ctx.fillStyle = gradientAlong({ x: -wd, y: -h }, { x: wd, y: h }, [[u - 0.12, 'rgba(255,250,225,0)'], [u, 'rgba(255,250,225,0.85)'], [u + 0.12, 'rgba(255,250,225,0)']]); ctx.fillText(str, 0, 0); }
  } else if (ufx === 'neon') {   // 네온: 청록 번짐 테두리 위에 하얀 글자, 유니폼과 같이 숨 쉰다
    const k = neonBreath(), [r, g, b] = NEON.cyan;
    ctx.lineWidth = Math.max(4, 0.05 * fit.s); ctx.strokeStyle = `rgba(${r},${g},${b},${(0.12 + 0.14 * k).toFixed(3)})`; ctx.strokeText(str, 0, 0);
    ctx.lineWidth = Math.max(2, 0.02 * fit.s); ctx.strokeStyle = `rgba(${r},${g},${b},${(0.6 + 0.4 * k).toFixed(3)})`; ctx.strokeText(str, 0, 0);
    ctx.fillStyle = '#f2feff'; ctx.fillText(str, 0, 0);
  } else {
    ctx.strokeStyle = light ? '#ffffff' : 'rgba(0,0,0,0.55)'; ctx.strokeText(str, 0, 0);
    ctx.fillStyle = light ? (t ? t.main : '#1b1d24') : '#ffffff'; ctx.fillText(str, 0, 0);
  }
  ctx.restore();
}

// 공 꼬리: 날아가는 공의 지난 0.26초 자리를 점으로 잇는다. flightPos는 시간만으로 자리를 정해서 따로 기록할 필요가 없다.
// 하트·별은 하나 건너 하나씩 그려야 모양이 겹치지 않고, 번개는 그 자리들을 지그재그로 잇는다
function drawTrailDots(pts, kind, radiusOf) {
  if (fancyTrail(kind)) { drawFancyIcon(pts, kind, radiusOf); return; }   // 상점 칸의 견본(혜성·용)
  if (camMoved()) {   // 따라가는 카메라: 카메라 2m 안의 점은 빼고 크기에 상한을 둔다(바로 뒤에서 보면 100px 넘는 덩어리가 됐다)
    const cap = Math.max(6, view.h * 0.012), minS = view.f / 2, r0 = radiusOf;
    pts = pts.filter((q) => !(q.s >= minS)); radiusOf = (q) => Math.min(cap, r0(q));
  }
  if (kind === 'trail-lightning') { drawBoltTrail(pts, radiusOf); return; }
  const t = fxTime();
  pts.forEach((q, i) => {
    const k = 1 - i / pts.length;   // 공에 가까울수록 크고 진하다
    if (kind === 'trail-heart' || kind === 'trail-star') {
      if (i % 2) return;
      const r = radiusOf(q) * (0.35 + 0.65 * k);
      if (kind === 'trail-heart') drawHeart(q.x, q.y, r * 1.2, `rgba(255,${i % 4 ? 120 : 70},${i % 4 ? 170 : 120},${(0.9 * k).toFixed(2)})`);
      else drawStar(q.x, q.y, r * 1.5, t * 3 + i, i % 4 ? `rgba(255,255,255,${(0.9 * k).toFixed(2)})` : `rgba(255,214,70,${(0.95 * k).toFixed(2)})`);
      return;
    }
    ctx.beginPath(); ctx.arc(q.x, q.y, radiusOf(q) * (0.35 + 0.65 * k), 0, Math.PI * 2);
    ctx.fillStyle = kind === 'trail-rainbow'
      ? `hsla(${Math.round(i * 30 + performance.now() / 5) % 360}, 95%, 62%, ${(0.8 * k).toFixed(2)})`
      : `rgba(255, ${Math.round(70 + 160 * k)}, ${Math.round(40 * k)}, ${(0.85 * k).toFixed(2)})`;
    ctx.fill();
  });
}
function drawBoltTrail(pts, radiusOf) {
  if (pts.length < 2) return;
  const rnd = mulberry32(Math.floor(fxTime() * 16) + 7), r0 = radiusOf(pts[0]);
  const path = pts.map((q, i) => { const j = radiusOf(q) * (i ? 1.4 : 0.3); return { x: q.x + (rnd() - 0.5) * j, y: q.y + (rnd() - 0.5) * j }; });
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const [w, color] of [[1.2, 'rgba(110,190,255,0.3)'], [0.55, 'rgba(150,220,255,0.9)'], [0.22, '#ffffff']]) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, r0 * w);
    ctx.beginPath(); path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
  }
  ctx.restore();
}
function drawBallTrail(r, t) {
  const kind = currentLook().trail;
  if (kind === 'trail-none') return;
  if (fancyTrail(kind)) { drawFancyBallTrail(r, t, kind); return; }
  const pts = [];
  for (let i = 1; i <= 12; i++) {
    const tt = t - i * 0.022;
    if (tt <= 0) break;
    const f = flightPos(r, tt), q = project(f.x, f.y, f.z);
    if (q) pts.push(q);
  }
  drawTrailDots(pts, kind, (q) => Math.max(2, BALL_R * 2.2 * q.s));
}

// ===== 고급 공 꼬리: 혜성(4,000코인)·용(6,000코인) =====
// 2026-11-03 사용자 요청 '고가로 퀄리티 있게'. 점을 찍는 꼬리와 달리 지난 길을 띠 하나로 잇고 빛·심·가루를 겹친다.
// 지난 자리는 화면에서 꼬리 길이(FANCY.len × 화면 높이)가 될 때까지 거슬러 모은다(최대 1.6초). 따라가는 카메라는 공을 바로 뒤에서 봐서
// 0.26초 자리가 공 둘레 몇 px에 몰렸다. 카메라 FANCY.near m 안의 자리는 쓰지 않는다(바로 앞을 지나는 큰 덩어리가 되지 않게)
const FANCY = { dt: 1 / 45, win: 1.6, len: 0.26, near: 2.5, maxPts: 80 };
const fancyTrail = (kind) => kind === 'trail-comet' || kind === 'trail-dragon';
const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };   // 0~1 고정 난수(가루마다 늘 같은 값)

// at(tt)는 그 시각 공의 화면 자리({x, y, s}). 지금 공에서 거슬러 모으며 공에서 잰 화면 길이 d를 붙인다. 친 순간(0초)보다 앞으로는 가지 않는다
function trailPath(at, t, len, win) {
  const out = [], near = view.f / FANCY.near;
  for (let k = 0, d = 0; k * FANCY.dt <= win; k++) {
    const tt = Math.max(0, t - k * FANCY.dt), q = at(tt), p = out[out.length - 1];
    if (!q || (p && q.s > near)) break;
    if (p) d += Math.hypot(q.x - p.x, q.y - p.y);
    out.push({ x: q.x, y: q.y, s: q.s ?? 1, d });
    if (d >= len || tt === 0) break;
  }
  return out;
}
// 공에서 잰 길이로 step px마다 다시 찍는다(많아야 FANCY.maxPts개). 원근 배율 k(공 자리보다 가까우면 커진다, kMax배까지)와 꼬리 쪽 비율 u(공 0 ~ 끝 1)를 붙인다
function resampleTrail(src, step, kMax = 2) {
  const L = src.length > 1 ? src[src.length - 1].d : 0, out = [];
  if (L < 0.5) return out;
  const n = clamp(Math.ceil(L / step) + 1, 3, FANCY.maxPts);
  for (let i = 0, j = 0; i < n; i++) {
    const d = L * i / (n - 1);
    while (j < src.length - 2 && src[j + 1].d < d) j++;
    const a = src[j], b = src[j + 1], w = b.d > a.d ? clamp((d - a.d) / (b.d - a.d), 0, 1) : 0;
    out.push({ x: lerp(a.x, b.x, w), y: lerp(a.y, b.y, w), k: clamp(lerp(a.s, b.s, w) / src[0].s, 1, kMax), d, u: i / (n - 1), nx: 0, ny: -1 });
  }
  trailNormals(out);
  return out;
}
function trailNormals(P) {   // 진행 방향(꼬리 → 공)의 왼쪽 법선(화면). 겹친 자리는 앞 자리 법선을 쓴다
  for (let i = 0, nx = 0, ny = -1; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], fx = a.x - b.x, fy = a.y - b.y, l = Math.hypot(fx, fy);
    if (l > 0.05) { nx = fy / l; ny = -fx / l; }
    P[i].nx = nx; P[i].ny = ny;
  }
}
function trailAt(P, d) {   // 공에서 d px 떨어진 자리(고르게 찍은 P 위)
  const L = P[P.length - 1].d, x = clamp(d / (L || 1), 0, 1) * (P.length - 1), i = Math.min(P.length - 2, Math.floor(x));
  return { x: lerp(P[i].x, P[i + 1].x, x - i), y: lerp(P[i].y, P[i + 1].y, x - i) };
}
const trailReach = (P, c) => P.reduce((m, p) => Math.max(m, Math.hypot(p.x - c.x, p.y - c.y)), 0);
// 띠: 자리마다 법선 쪽으로 off(p)만큼 민 곳을 가운데로 w(p)만큼 양옆으로 벌린 닫힌 경로
function ribbonPath(P, w, off = null) {
  ctx.beginPath();
  for (let i = 0; i < P.length; i++) { const p = P[i], o = off ? off(p) : 0, h = w(p); ctx.lineTo(p.x + p.nx * (o + h), p.y + p.ny * (o + h)); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i], o = off ? off(p) : 0, h = w(p); ctx.lineTo(p.x + p.nx * (o - h), p.y + p.ny * (o - h)); }
  ctx.closePath();
}
function radialFrom(c, R, stops) {   // c에서 R까지 퍼지는 원형 그러데이션. 꼬리는 공에서 멀수록 흐려지게 이것으로 칠한다
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(1, R));
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
}
// 가루: 날아간 길의 정해진 시각(step초마다, 넷에 하나는 거른다)에 떨어져 퍼지며 제 수명 안에 사라진다. 떨어진 시각으로 정해서 공을 따라 미끄러지지 않는다.
// place(ts, age, k)가 그 가루의 지금 화면 자리({x, y, k})를 주면 each(q, 남은 비율, h)로 그린다
function trailDust(t, life, step, place, each) {
  for (let k = Math.floor(t / step); k >= 0 && t - k * step < life; k--) {
    const age = t - k * step, L = life * (0.5 + 0.5 * hash01(k + 0.5));
    if (hash01(k) < 0.25 || age > L) continue;
    const q = place(k * step, age, k);
    if (q) each(q, 1 - age / L, hash01(k + 0.25));
  }
}

// 경기 화면: 공 크기(drawBall과 같은 셈, 폰에서도 보이게 최소 3px)를 단위로 그린다. 가루는 날아간 길(3D)에 떨어뜨려 원근대로 퍼지고,
// 따라가는 카메라가 그 사이를 지나가면 화면 밖으로 흩어진다
function drawFancyBallTrail(r, t, kind) {
  const at = (tt) => { const f = flightPos(r, tt); return project(f.x, f.y, f.z); }, c = at(t);
  if (!c) return;
  const ball = camMoved() ? Math.max(BALL_R * 1.2 * c.s, view.h * CHASE.ballMin) : Math.max(2.5, BALL_R * 2 * c.s);
  const dragon = kind === 'trail-dragon', U = Math.max(ball, view.mobile ? 3 : 3.5) * (dragon ? 1.15 : 1);
  const P = resampleTrail(trailPath(at, t, view.h * FANCY.len, FANCY.win), Math.max(2.2, U * 0.7), dragon ? 1.5 : 2);   // 용은 덜 굵어진다(뒤에서 볼 때 가까운 몸이 머리를 덮었다)
  const place = (ts, age, k) => {   // 0.8~3m/s로 아무 쪽으로나 퍼지고 조금씩 가라앉는다
    const f = flightPos(r, ts), sp = (0.8 + 2.2 * hash01(k + 0.75)) * age, a = hash01(k + 0.125) * Math.PI * 2, b = hash01(k + 0.375) * 2 - 1, cb = Math.sqrt(1 - b * b);
    const q = project(f.x + Math.cos(a) * cb * sp, Math.max(0.03, f.y + b * sp - 1.2 * age * age), f.z + Math.sin(a) * cb * sp);
    return q && q.s < view.f / FANCY.near ? { x: q.x, y: q.y, k: clamp(q.s / c.s, 1, 2) } : null;
  };
  const dust = (each) => trailDust(t, dragon ? 0.7 : 0.9, dragon ? 0.04 : 0.018, place, each);
  if (dragon) drawDragon(P, c, U, t, dust, r); else drawComet(P, c, U, t, dust);
}

// 혜성: 공 둘레의 밝은 머리(빛 무리와 천천히 도는 네 갈래 빛살), 길게 가늘어지는 꼬리(흰빛 → 푸른빛 → 투명, 겹친 띠 둘)와 옆으로 갈라지는 금빛 먼지 꼬리, 꼬리를 따라 흘러가는
// 가는 빛줄기, 흩어지며 반짝이다 사라지는 별가루. 모두 더하는 빛('lighter')이라 밤하늘에서 빛나 보인다
function drawComet(P, c, U, t, dust) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  if (P.length > 2) {
    const R = Math.max(U * 3, trailReach(P, c));
    ribbonPath(P, (p) => U * (0.5 + 1.1 * p.u) * p.k, (p) => U * 2.2 * Math.pow(p.u, 1.4) * p.k);   // 금빛 먼지 꼬리: 푸른 꼬리에서 한쪽으로 휘며 퍼진다(진짜 혜성처럼 두 갈래)
    ctx.fillStyle = radialFrom(c, R, [[0, 'rgba(255,220,160,0.2)'], [0.6, 'rgba(255,190,120,0.1)'], [1, 'rgba(255,170,100,0)']]); ctx.fill();
    ribbonPath(P, (p) => U * 2.4 * Math.pow(1 - p.u, 0.75) * p.k);
    ctx.fillStyle = radialFrom(c, R, [[0, 'rgba(110,180,255,0.4)'], [0.5, 'rgba(60,120,255,0.16)'], [1, 'rgba(40,80,255,0)']]); ctx.fill();
    ribbonPath(P, (p) => U * 1.1 * Math.pow(1 - p.u, 1.15) * p.k);
    ctx.fillStyle = radialFrom(c, R, [[0, 'rgba(255,255,255,0.95)'], [0.2, 'rgba(200,235,255,0.8)'], [0.55, 'rgba(100,165,255,0.38)'], [1, 'rgba(50,90,255,0)']]); ctx.fill();
    ctx.strokeStyle = radialFrom(c, R, [[0, 'rgba(240,250,255,0.75)'], [0.65, 'rgba(150,200,255,0.25)'], [1, 'rgba(120,170,255,0)']]);
    ctx.lineWidth = Math.max(0.7, U * 0.16); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let j = 0; j < 3; j++) {   // 꼬리 속 빛줄기: 꼬리를 따라 흘러가며 흔들린다
      ctx.beginPath();
      for (let i = 0; i < P.length; i += 2) { const p = P[i], o = U * (0.15 + 0.9 * p.u) * p.k * Math.sin(p.u * 8 - t * 7 + j * 2.1); ctx.lineTo(p.x + p.nx * o, p.y + p.ny * o); }
      ctx.stroke();
    }
  }
  // 별가루: 흰빛·물빛, 열에 하나는 금빛. 사라지며 작아지고, 큰 것은 네 갈래로 반짝인다. 색은 정해 두고 globalAlpha만 바꾼다
  // (가루마다 rgba 문자열을 만들어 칠했더니 그것이 꼬리 그리기에서 가장 오래 걸렸다, 폰 CPU 4배 느리게)
  dust((q, f, h) => {
    const r = Math.max(0.6, U * (0.2 + 0.45 * h) * q.k * (0.45 + 0.55 * f)), col = h > 0.9 ? '#ffe196' : h > 0.5 ? '#96d7ff' : '#ebf5ff';
    ctx.globalAlpha = f * (0.6 + 0.4 * Math.sin(t * 22 + h * 40));
    if (r > 1.2 && h > 0.72) drawSparkle(q, r * 2, col); else { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); }
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = radialFrom(c, U * 4.5, [[0, 'rgba(255,255,255,0.9)'], [0.2, 'rgba(210,238,255,0.7)'], [0.5, 'rgba(110,180,255,0.25)'], [1, 'rgba(60,120,255,0)']]);
  ctx.beginPath(); ctx.arc(c.x, c.y, U * 4.5, 0, Math.PI * 2); ctx.fill();
  const pulse = 1 + 0.1 * Math.sin(t * 6);
  ctx.fillStyle = 'rgba(225,242,255,0.55)';
  for (const [a, l, w] of [[t * 0.6, 7, 0.2], [t * 0.6 + Math.PI / 2, 4.2, 0.16]]) {   // 빛살: 가늘고 긴 마름모 둘이 십자로 천천히 돈다
    const dx = Math.cos(a), dy = Math.sin(a), ll = l * U * pulse, ww = w * U;
    ctx.beginPath(); ctx.moveTo(c.x + dx * ll, c.y + dy * ll); ctx.lineTo(c.x - dy * ww, c.y + dx * ww); ctx.lineTo(c.x - dx * ll, c.y - dy * ll); ctx.lineTo(c.x + dy * ww, c.y - dx * ww);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// 용: 공(여의주)을 쫓는 붉은 용. 지난 길을 따라 꿈틀거리는 몸(빨강 비늘 줄이 번갈아 칠해지고 금빛 비늘 테, 금빛 배, 등 가시)이
// 끝으로 갈수록 가늘어지며 흐려진다. 공 쪽 머리에는 뿔·수염·갈기가 있고 눈이 빛나며, 공 둘레에는 금빛 기운과 불씨가 돈다.
// 등(가시·뿔) 쪽은 화면 위쪽이 되게 고르고, 거의 곧게 오르내릴 때는 고른 쪽을 지킨다(뿔이 깜빡이며 뒤집히지 않게)
const DRAGON = { red: '#cf1d26', row: '#a8121c', gold: '#f2b632', belly: '#f7da8c', horn: '#ffe7a8', line: '#4e050a' };
const dragonState = { owner: null, side: 0, dir: { x: 0, y: -1 } };
function drawDragon(P, c, U, t, dust, owner) {
  const W = U * 1.15, H = U * 5.2, gap = U * 1.35, L = P.length > 1 ? P[P.length - 1].d : 0, st = dragonState;
  if (st.owner !== owner) Object.assign(st, { owner, side: 0, dir: { x: 0, y: -1 } });
  // 머리와 목은 곧게: 머리 방향은 조금 먼 몸(gap + 1.8H)에서 공 쪽으로 잡고, 목까지는 그 방향 직선이다가 몸에서 지난 길로 넘어간다.
  // 따라가는 카메라가 꼭대기 근처 공을 뒤에서 보면 공 바로 뒤 길이 짧게 꺾여서, 그 길을 따르면 머리가 공을 거꾸로 물었다
  if (L > gap + 2) { const b = trailAt(P, gap + H * 1.8), dx = c.x - b.x, dy = c.y - b.y, dl = Math.hypot(dx, dy); if (dl > 2) st.dir = { x: dx / dl, y: dy / dl }; }
  const f = st.dir, nL = { x: f.y, y: -f.x };
  for (const p of P) { const w = smooth((p.d - gap - H * 0.9) / (H * 1.1)); p.x = lerp(c.x - f.x * p.d, p.x, w); p.y = lerp(c.y - f.y * p.d, p.y, w); }
  trailNormals(P);
  if (!st.side || Math.abs(nL.y) > 0.3) st.side = nL.y <= 0 ? 1 : -1;
  const side = st.side, v = { x: nL.x * side, y: nL.y * side };
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = radialFrom(c, U * 3.4, [[0, 'rgba(255,240,200,0.55)'], [0.35, 'rgba(255,180,70,0.32)'], [1, 'rgba(255,110,30,0)']]);   // 여의주 기운
  ctx.beginPath(); ctx.arc(c.x, c.y, U * 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,200,90,0.75)'; ctx.beginPath();
  for (let i = 0; i < 3; i++) {   // 여의주 둘레를 도는 불씨
    const a = t * 3.2 + i * 2.094, x = c.x + Math.cos(a) * U * 1.7, y = c.y + Math.sin(a) * U * 1.7;
    ctx.moveTo(x + U * 0.32, y); ctx.arc(x, y, U * 0.32, 0, Math.PI * 2);
  }
  ctx.fill();
  dust((q, fr, h) => {   // 불티: 작고 밝은 노란 알갱이가 주황으로 식으며 사라진다(별가루처럼 색은 정해 두고 globalAlpha만 바꾼다)
    const r = Math.max(0.6, U * (0.1 + 0.16 * h) * q.k * (0.5 + 0.5 * fr));
    ctx.globalAlpha = Math.min(1, 1.3 * fr); ctx.fillStyle = fr > 0.5 ? '#ffe9a0' : '#ffaa46';
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.restore();
  const neck = gap + H * 0.78, bodyLen = L - neck;
  if (bodyLen > U * 2) drawDragonBody(P, c, U, W, neck, bodyLen, side, t);
  drawDragonHead({ x: c.x - f.x * gap, y: c.y - f.y * gap }, f, v, H, t);
}
function drawDragonBody(P, c, U, W, neck, bodyLen, side, t) {
  const lam = clamp(bodyLen * 0.5, U * 9, U * 24), amp = W * 0.95, B = [];
  for (const p of P) {   // 몸의 물결: 머리에서 꼬리로 흘러간다(목은 곧게)
    if (p.d < neck) continue;
    const s = p.d - neck, u = s / bodyLen, o = amp * p.k * Math.sin(Math.PI * 2 * s / lam - t * 5) * smooth(s / (lam * 0.45));
    B.push({ x: p.x + p.nx * o, y: p.y + p.ny * o, k: p.k, u, d: s, nx: 0, ny: -1, w: W * p.k * (0.62 + 0.38 * smooth(u / 0.2)) * (1 - 0.86 * smooth((u - 0.38) / 0.62)) });
  }
  if (B.length < 3) return;
  trailNormals(B);
  const wOf = (p) => p.w;
  const R = Math.max(U * 4, trailReach(B, c)), fade = (col, a) => radialFrom(c, R, [[0, col], [0.7, col], [1, a]]);
  // 비늘 줄: 원근 배율을 넣은 일정한 간격(rl)마다 줄을 나누어 하나 건너 하나는 어두운 빨강으로 칠하고, 줄 경계에 꼬리 쪽으로 뾰족한 금빛 비늘 테를 긋는다
  const rows = new Path2D(), rims = new Path2D(), spikes = new Path2D(), plates = new Path2D(), rl = W * 1.35;
  let ph = 0;
  for (let i = 1; i < B.length; i++) {
    const a = B[i - 1], b = B[i], w = wOf(b), seg = Math.hypot(b.x - a.x, b.y - a.y), next = ph + seg / (rl * b.k);
    if (Math.floor(ph) % 2) {
      const wa = wOf(a) * 0.96, wb = w * 0.96;
      rows.moveTo(a.x + a.nx * wa, a.y + a.ny * wa); rows.lineTo(b.x + b.nx * wb, b.y + b.ny * wb); rows.lineTo(b.x - b.nx * wb, b.y - b.ny * wb); rows.lineTo(a.x - a.nx * wa, a.y - a.ny * wa); rows.closePath();
    }
    if (Math.floor(next) > Math.floor(ph)) {   // 줄 경계: 비늘 테(V), 배 마디, 두 줄에 하나는 등 가시
      const fx = -b.ny, fy = b.nx, tip = rl * b.k * 0.55, m = Math.floor(next);
      rims.moveTo(b.x + b.nx * w * 0.95, b.y + b.ny * w * 0.95); rims.lineTo(b.x - fx * tip, b.y - fy * tip); rims.lineTo(b.x - b.nx * w * 0.95, b.y - b.ny * w * 0.95);
      plates.moveTo(b.x - b.nx * side * w * 0.3, b.y - b.ny * side * w * 0.3); plates.lineTo(b.x - b.nx * side * w * 0.92, b.y - b.ny * side * w * 0.92);
      const sh = W * b.k * 0.95 * smooth(b.u / 0.08) * (1 - smooth((b.u - 0.45) / 0.45));
      if (m % 2 === 0 && sh > 0.6) {
        const tx = b.x + b.nx * side * w * 0.8, ty = b.y + b.ny * side * w * 0.8, bl = rl * b.k * 0.5;
        spikes.moveTo(tx + fx * bl * 0.4, ty + fy * bl * 0.4); spikes.lineTo(tx + b.nx * side * sh - fx * sh * 0.7, ty + b.ny * side * sh - fy * sh * 0.7); spikes.lineTo(tx - fx * bl, ty - fy * bl); spikes.closePath();
      }
    }
    ph = next;
  }
  for (const [u0, ph0] of [[0.17, 0], [0.5, 2.4]]) {   // 다리 둘(앞·뒤): 배 쪽으로 내밀어 헤엄치듯 젓고, 발끝에 금빛 발톱 셋
    const b = B[Math.round((B.length - 1) * u0)], w = b.w, fx = -b.ny, fy = b.nx, dn = { x: -b.nx * side, y: -b.ny * side }, sw = Math.sin(t * 6 + ph0);
    const hip = { x: b.x + dn.x * w * 0.5, y: b.y + dn.y * w * 0.5 }, knee = { x: hip.x + dn.x * w * 1.1 + fx * w * (0.5 + 0.4 * sw), y: hip.y + dn.y * w * 1.1 + fy * w * (0.5 + 0.4 * sw) };
    const foot = { x: knee.x + dn.x * w * 0.7 - fx * w * (0.45 - 0.3 * sw), y: knee.y + dn.y * w * 0.7 - fy * w * (0.45 - 0.3 * sw) };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = DRAGON.line; ctx.lineWidth = w * 0.95 + 1;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(knee.x, knee.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
    ctx.strokeStyle = DRAGON.red; ctx.lineWidth = w * 0.95; ctx.stroke();
    ctx.strokeStyle = DRAGON.gold; ctx.lineWidth = Math.max(0.7, w * 0.22); ctx.beginPath();
    for (const a of [-0.6, 0, 0.6]) { const cs = Math.cos(a), sn = Math.sin(a), dx = fx * cs - fy * sn, dy = fx * sn + fy * cs; ctx.moveTo(foot.x, foot.y); ctx.lineTo(foot.x + (dx * 0.8 + dn.x * 0.4) * w * 0.8, foot.y + (dy * 0.8 + dn.y * 0.4) * w * 0.8); }
    ctx.stroke();
  }
  ribbonPath(B, wOf);   // 몸(다리 위로)
  ctx.fillStyle = fade(DRAGON.red, 'rgba(207,29,38,0)'); ctx.fill();
  ctx.fillStyle = fade(DRAGON.row, 'rgba(168,18,28,0)'); ctx.fill(rows);
  ribbonPath(B, (p) => wOf(p) * 0.3, (p) => -side * wOf(p) * 0.58);   // 금빛 배
  ctx.fillStyle = fade(DRAGON.belly, 'rgba(247,218,140,0)'); ctx.fill();
  const lw = (k) => Math.max(0.7, W * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = fade(DRAGON.gold, 'rgba(242,182,50,0)'); ctx.lineWidth = lw(0.24); ctx.stroke(rims);
  if (W > 3.5) { ctx.strokeStyle = fade('rgba(176,110,30,0.8)', 'rgba(176,110,30,0)'); ctx.lineWidth = lw(0.1); ctx.stroke(plates); }
  ctx.beginPath();   // 등 쪽 윤기: 몸이 둥글어 보이게
  for (const p of B) { const o = side * wOf(p) * 0.5; ctx.lineTo(p.x + p.nx * o, p.y + p.ny * o); }
  ctx.strokeStyle = fade('rgba(255,170,140,0.55)', 'rgba(255,170,140,0)'); ctx.lineWidth = lw(0.16); ctx.stroke();
  ctx.fillStyle = fade(DRAGON.gold, 'rgba(242,182,50,0)'); ctx.fill(spikes);
  ctx.strokeStyle = fade(DRAGON.line, 'rgba(78,5,10,0)'); ctx.lineWidth = lw(0.08); ctx.stroke(spikes);
  ribbonPath(B, wOf);   // 윤곽
  ctx.strokeStyle = fade('rgba(78,5,10,0.85)', 'rgba(78,5,10,0)'); ctx.lineWidth = lw(0.09); ctx.stroke();
  const e = B[Math.round((B.length - 1) * 0.86)], bx = e.ny, by = -e.nx;   // 꼬리 끝 불꽃 지느러미(bx, by는 꼬리 쪽)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const ang = (i - 1) * 0.55 + 0.15 * Math.sin(t * 8 + i * 2), cs = Math.cos(ang), sn = Math.sin(ang), dx = bx * cs - by * sn, dy = bx * sn + by * cs;
    const len = W * e.k * (2.6 - 0.6 * Math.abs(i - 1)) * (0.85 + 0.15 * Math.sin(t * 11 + i)), wb = W * e.k * 0.32;
    const tip = { x: e.x + dx * len, y: e.y + dy * len }, mid = { x: e.x + dx * len * 0.45 - dy * wb, y: e.y + dy * len * 0.45 + dx * wb };
    ctx.fillStyle = i === 1 ? 'rgba(255,205,90,0.7)' : 'rgba(255,120,40,0.62)';
    ctx.beginPath(); ctx.moveTo(e.x + e.nx * wb, e.y + e.ny * wb); ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y); ctx.quadraticCurveTo(mid.x + dy * wb * 2, mid.y - dx * wb * 2, e.x - e.nx * wb, e.y - e.ny * wb); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}
// 머리: o는 코끝, f는 앞(공 쪽), v는 머리 위(등 쪽), H는 머리 길이(px). (a, b)는 코끝에서 앞으로 a·위로 b(머리 길이 단위)
function drawDragonHead(o, f, v, H, t) {
  const P = (a, b) => ({ x: o.x + (f.x * a + v.x * b) * H, y: o.y + (f.y * a + v.y * b) * H });
  const shape = (pts, fill, line) => { if (smoothPath(pts.map(([a, b]) => P(a, b)))) { ctx.fillStyle = fill; ctx.fill(); if (line) { ctx.strokeStyle = line; ctx.lineWidth = Math.max(0.6, H * 0.025); ctx.stroke(); } } };
  const curve = (pts, w, color) => {
    const [a, b, e] = pts.map(([x, y]) => P(x, y));
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.7, w * H); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(b.x, b.y, e.x, e.y); ctx.stroke();
  };
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  curve([[-0.8, 0.22], [-1.12, 0.5], [-1.5, 0.44]], 0.08, '#c99a52');   // 뒤쪽 뿔
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {   // 갈기: 머리 뒤로 흔들리는 불꽃 다발
    const a = -0.82 - i * 0.16, len = 0.5 + 0.12 * Math.sin(t * 9 + i * 1.7), up = 0.12 + 0.05 * i;
    const base1 = P(a + 0.08, up), base2 = P(a - 0.08, up - 0.12), tip = P(a - len, up + 0.18 + 0.06 * Math.sin(t * 7 + i)), mid = P(a - len * 0.45, up + 0.22);
    ctx.fillStyle = i % 2 ? 'rgba(255,150,40,0.75)' : 'rgba(255,205,80,0.75)';
    ctx.beginPath(); ctx.moveTo(base1.x, base1.y); ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y); ctx.quadraticCurveTo(mid.x, mid.y, base2.x, base2.y); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const [a, b, c2, d2] of [[-0.86, -0.06, -1.3, -0.3], [-0.94, 0.04, -1.42, -0.12]]) {   // 볼 지느러미
    const p0 = P(a, b - 0.05), p1 = P(c2, d2), p2 = P(a, b + 0.07); ctx.fillStyle = DRAGON.gold; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.closePath(); ctx.fill();
  }
  shape([[-0.1, -0.13], [-0.5, -0.12], [-0.86, -0.12], [-0.7, -0.3], [-0.22, -0.31], [-0.05, -0.21]], '#f3c35a', DRAGON.line);   // 아래턱(입을 벌렸다)
  shape([[-0.1, -0.03], [-0.52, -0.07], [-0.5, -0.13], [-0.12, -0.14]], '#5a0a10');   // 입 안
  if (H > 18) for (const [a, b, d] of [[-0.15, -0.04, -1], [-0.13, -0.19, 1]]) {   // 송곳니
    const p0 = P(a, b), p1 = P(a - 0.03, b + d * 0.09), p2 = P(a - 0.07, b); ctx.fillStyle = '#fffaf0'; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.closePath(); ctx.fill();
  }
  shape([[0, 0.04], [-0.05, 0.16], [-0.28, 0.15], [-0.5, 0.3], [-0.7, 0.33], [-0.95, 0.22], [-1.04, 0.0], [-0.88, -0.13], [-0.5, -0.06], [-0.14, -0.04]], DRAGON.red, DRAGON.line);   // 머리
  shape([[-0.06, 0.1], [-0.28, 0.15], [-0.46, 0.21], [-0.32, 0.08]], DRAGON.gold);   // 콧등 금빛 판
  const eye = P(-0.58, 0.14);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = radialFrom(eye, H * 0.22, [[0, 'rgba(255,240,150,0.9)'], [1, 'rgba(255,200,60,0)']]); ctx.beginPath(); ctx.arc(eye.x, eye.y, H * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ellipseAt(eye, H * 0.075, H * 0.075, '#fff6c2');
  if (H > 16) ellipseAt(eye, H * 0.022, H * 0.022, '#3a0306');
  curve([[-0.46, 0.22], [-0.6, 0.32], [-0.74, 0.25]], 0.05, DRAGON.gold);   // 눈썹
  curve([[-0.68, 0.26], [-1.02, 0.66], [-1.58, 0.6]], 0.1, DRAGON.horn);   // 앞쪽 뿔과 곁가지
  curve([[-1.0, 0.56], [-1.08, 0.7], [-1.04, 0.84]], 0.06, DRAGON.horn);
  const wv = Math.sin(t * 4), wv2 = Math.sin(t * 3.3 + 1);
  curve([[-0.1, -0.02], [-0.6, -0.5 + 0.12 * wv], [-1.75, -0.32 + 0.28 * wv2]], 0.045, '#ffd36b');   // 수염 둘
  curve([[-0.12, 0.08], [-0.55, 0.55 + 0.1 * wv2], [-1.6, 0.3 + 0.25 * wv]], 0.04, '#ffd36b');
  curve([[-0.42, -0.27], [-0.55, -0.42], [-0.72, -0.46]], 0.05, '#ffd36b');   // 턱수염
  ctx.restore();
}

// 상점 칸 견본: 칸의 네 점(공 → 꼬리)을 지난 길로 쓴다. 칸이 작아서 단위를 줄인다
function drawFancyIcon(pts, kind, radiusOf) {
  const c = pts[0], e = pts[pts.length - 1], sw = radiusOf(c) / 0.55, L = Math.hypot(e.x - c.x, e.y - c.y), t = fxTime();
  const P = resampleTrail([{ x: c.x, y: c.y, s: 1, d: 0 }, { x: e.x, y: e.y, s: 1, d: L }], 1.5), none = () => {};
  if (kind === 'trail-dragon') drawDragon(P, c, sw * 0.16, t, none, 'icon'); else drawComet(P, c, sw * 0.24, t, none);
  ellipseAt(c, sw * 0.13, sw * 0.13, '#ffffff');
}
// 상점 큰 미리 보기: 공이 at(0~1)을 따라 날아간다(u초, 1.1초에 끝). 가루는 화면에서 퍼진다
function drawFancyPreview(kind, at, u, ballR, box) {
  const path = (tt) => at(tt / 1.1), c = path(u), t = fxTime(), dragon = kind === 'trail-dragon', U = ballR * (dragon ? 1.1 : 1);
  const P = resampleTrail(trailPath(path, u, box.w * (dragon ? 0.55 : 0.5), 0.8), U * 0.6);
  const place = (ts, age, k) => {
    const q = path(ts), sp = (25 + 45 * hash01(k + 0.75)) * age, a = hash01(k + 0.125) * Math.PI * 2;
    return { x: q.x + Math.cos(a) * sp, y: q.y + Math.sin(a) * sp + 30 * age * age, k: 1 };
  };
  const dust = (each) => trailDust(u, dragon ? 0.7 : 0.9, dragon ? 0.04 : 0.018, place, each);
  if (dragon) drawDragon(P, c, U, t, dust, 'preview'); else drawComet(P, c, U, t, dust);
}

// 상점 화면(state 'shop'). view: 'shop'(파는 것 전부) | 'inventory'(내 물건: 가진 것만, 입기·기본으로 되돌리기)
// 등번호는 닉네임처럼 HTML 입력칸을 캔버스 위에 띄워 받는다
const noInput = document.createElement('input');
Object.assign(noInput, { type: 'text', inputMode: 'numeric', maxLength: 2, autocomplete: 'off', placeholder: '0~99' });
noInput.setAttribute('aria-label', '등번호');
Object.assign(noInput.style, { position: 'fixed', display: 'none', boxSizing: 'border-box', padding: '0 8px', zIndex: '2', outline: 'none',
  border: '2px solid rgba(255,255,255,0.35)', borderRadius: '12px', background: 'rgba(8,16,30,0.85)', color: '#fff', font: `800 16px ${FONT}`, textAlign: 'center' });
document.body.appendChild(noInput);
noInput.addEventListener('input', () => {
  noInput.value = noInput.value.replace(/\D/g, '').slice(0, 2);
  if (game.shop && noInput.value !== '') game.shop.no = Number(noInput.value);
});

async function refreshWallet() {
  if (!loggedIn()) return;
  try { const res = await api('/me'); if (res.ok) setWallet(await res.json()); else if (res.status === 401) logout('expired'); } catch { /* 이 브라우저에 남은 값으로 그린다 */ }
}
function openShop(view = 'shop') {
  game.shop = { view, tab: game.shop?.tab ?? 'bat', sel: null, no: Number.isInteger(wallet.look.no) ? wallet.look.no : 7, demo: performance.now(), busy: false };
  noInput.value = String(game.shop.no);
  game.state = 'shop';
  refreshWallet();
}
function selectItem(it) {
  const sh = game.shop;
  sh.sel = it.id; sh.demo = performance.now();
  if (it.slot === 'sound') { Sound.init(); Sound.crack(0.8, it.id); }   // 고르면 소리를 들려준다
}

async function shopRequest(path, body) {
  const res = await api(path, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) logout('expired');
  else setWallet(data);
  return { ok: res.ok, data };
}
async function equipItem(it, number, quiet = false) {
  try {
    const { ok, data } = await shopRequest('/shop/equip', number == null ? { item: it.id } : { item: it.id, number });
    if (!ok) { toast(data.error === 'bad_number' ? '0~99 사이 번호를 골라 주세요' : '입지 못했어요. 잠시 뒤 다시 해 주세요'); return false; }
    if (!quiet) toast(it.id === 'number-on' ? `등번호 ${number}번을 달았어요` : `${it.name} 입었어요`);
    return true;
  } catch { toast('입지 못했어요. 잠시 뒤 다시 해 주세요'); return false; }
}
async function buyItem(it) {
  const sh = game.shop;
  if (sh.busy) return;
  sh.busy = true;
  try {
    const { ok, data } = await shopRequest('/shop/buy', { item: it.id });
    if (!ok) { toast(data.error === 'not_enough_coins' ? '코인이 모자라요' : data.error === 'already_owned' ? '이미 가진 물건이에요' : '사지 못했어요. 잠시 뒤 다시 해 주세요'); return; }
    if (it.id === 'number-on') { toast('샀어요. 번호를 골라 달아 주세요'); return; }   // 등번호는 번호를 고른 뒤에 단다
    if (await equipItem(it, null, true)) toast(`샀어요 · ${it.name} 바로 입었어요`);
  } catch { toast('사지 못했어요. 잠시 뒤 다시 해 주세요'); } finally { sh.busy = false; }
}

// 코인 표시: 노란 동전 + 숫자. align 'right'면 x가 오른쪽 끝
function drawCoinPill(x, cy, coins, align = 'left') {
  const m = view.mobile, label = coins.toLocaleString(), h = m ? 26 : 30;
  ctx.font = font(m ? 13 : 15, 800);
  const w = ctx.measureText(label).width + (m ? 34 : 40), x0 = align === 'right' ? x - w : x;
  roundRect(x0, cy - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
  const r = h * 0.3, ccx = x0 + h / 2;
  ctx.beginPath(); ctx.arc(ccx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#f2c94c'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#a67c0d'; ctx.stroke();
  text(label, ccx + r + 6, cy + 1, { size: m ? 13 : 15, weight: 800, align: 'left' });
  return { x: x0, y: cy - h / 2, w, h };
}

// 물건 칸 하나: 견본 그림, 이름, 가격이나 상태. 배트·헬멧·신발은 타자에게 입히는 것과 같은 함수로 작게 그린다
function drawItemCard(r, it, on) {
  const m = view.mobile, t = teamById(settings.team), sw = r.h * (m ? 0.27 : 0.3), sx = r.x + (m ? 7 : 10) + sw, sy = r.y + r.h / 2;
  roundRect(r.x, r.y, r.w, r.h, 12);
  ctx.fillStyle = on ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'; ctx.fill();
  if (on) { ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2.5; ctx.stroke(); }
  const dot = (fill, ring) => { ctx.beginPath(); ctx.arc(sx, sy, sw, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); if (ring) { ctx.lineWidth = 3; ctx.strokeStyle = ring; ctx.stroke(); } };
  const c = it.colors ?? {}, col = (name) => c[name] ?? BATTER_COLOR[name];
  if (it.slot === 'bat') { dot('rgba(255,255,255,0.1)'); drawBat({ x: sx - sw * 0.6, y: sy + sw * 0.6 }, { x: sx + sw * 0.5, y: sy - sw * 0.5 }, sw * 0.16, sw * 0.3, sw * 3, col, it.fx, true); }
  else if (it.slot === 'helmet') {
    const hc = c.helmet ?? (t ? tint(t.main, 0.75) : BATTER_COLOR.helmet);
    dot('rgba(255,255,255,0.1)'); drawHelmet({ x: sx, y: sy + sw * 0.22 }, sw * 0.52 / 0.13, null, () => hc, it.fx, true);
  } else if (it.slot === 'glove') dot(c.glove, 'rgba(0,0,0,0.25)');
  else if (it.slot === 'shoe') {   // 로켓 부츠 견본은 아래로 짧게 뿜고(칸 밖으로 안 나가게), 번개 운동화는 가끔 불꽃이 튄다
    dot('rgba(255,255,255,0.1)');
    const rocket = it.fx === 'rocket', act = rocket ? { v: 2.5, back: { x: -0.3, y: 0.95 }, fore: 1, seed: 0 } : it.fx === 'bolt' ? { v: 0, seed: 1 } : null;
    drawShoe({ x: sx - sw * (rocket ? 0.1 : 0.33), y: sy + sw * (rocket ? -0.05 : 0.1) }, sw * 5.5, 1, col, it.fx, true, act);
  } else if (it.slot === 'uniform') {
    const ring = it.fx === 'legend' ? GOLD.mid : it.fx === 'neon' ? 'rgba(40,238,255,0.95)' : t ? (c.jersey ? t.main : t.accent) : BATTER_COLOR.accent;
    dot(c.jersey ?? (t ? t.main : BATTER_COLOR.jersey), ring);
    if (it.fx === 'legend') {   // 금 줄무늬와 가끔 반짝임
      for (const u of [-0.56, -0.19, 0.19, 0.56]) { const h = Math.sqrt(1 - u * u) * sw * 0.84; segment({ x: sx + u * sw, y: sy - h }, { x: sx + u * sw, y: sy + h }, 1.2, 1.2, 'rgba(226,186,80,0.5)'); }
      const sp = (fxTime() / 2.3) % 1;
      if (sp < 0.3) drawSparkle({ x: sx + sw * 0.62, y: sy - sw * 0.62 }, sw * 0.45 * Math.sin(Math.PI * sp / 0.3), GOLD.glint);
    } else if (it.fx === 'neon') {   // 숨 쉬는 분홍 안쪽 고리
      ctx.strokeStyle = `rgba(255,62,212,${(0.45 + 0.5 * neonBreath(0.6)).toFixed(3)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, sw * 0.55, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `rgba(40,238,255,${(0.15 + 0.25 * neonBreath()).toFixed(3)})`; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(sx, sy, sw, 0, Math.PI * 2); ctx.stroke();
    }
  }
  else if (it.slot === 'trail') {
    if (it.id === 'trail-none') dot('rgba(255,255,255,0.1)');
    else drawTrailDots([0, 1, 2, 3].map((i) => ({ x: sx + sw * 0.9 - i * sw * 0.55, y: sy + i * sw * 0.25 })), it.id, () => sw * 0.55);
  } else {
    dot('rgba(255,255,255,0.12)');
    text(it.slot === 'number' ? (it.id === 'number-on' ? (Number.isInteger(wallet.look.no) ? String(wallet.look.no) : '#') : '-') : '♪', sx, sy + 1, { size: m ? 13 : 15, weight: 800 });
  }
  const tx = sx + sw + (m ? 7 : 10), size = m ? 13 : 15;
  ctx.font = font(size, 700);
  const fit = Math.min(1, (r.x + r.w - 5 - tx) / ctx.measureText(it.name).width);   // 폰은 한 줄에 셋이라 긴 이름('토끼 슬리퍼')은 글자를 줄인다
  text(it.name, tx, sy - (m ? 8 : 9), { size: size * fit, weight: 700, align: 'left' });
  const status = wearing(it) ? ['착용 중', '#8ef0a8'] : owns(it.id) ? [it.price ? '보유' : '기본', 'rgba(255,255,255,0.6)'] : [`${it.price.toLocaleString()}코인`, '#f2c94c'];
  text(status[0], tx, sy + (m ? 10 : 12), { size: m ? 11 : 13, weight: 700, color: status[1], align: 'left' });
}

// 미리 보기 칸: 같은 타자 그림을 칸에 맞춰 줄여 그린다(모바일에서는 뒤의 타자가 화면 끝에 걸려 잘 안 보여서).
// 등번호를 고를 때는 스윙을 마친 자세로 등을 보여 주고, 공 꼬리를 고를 때는 공 하나가 꼬리를 달고 날아간다.
// 헬멧·신발을 고를 때는 머리·발을 크게 당겨 보여 준다(2026-10-30 동물 헬멧·신발을 더하면서. 몸 전체로는 폰에서 머리가 손톱만 했다).
// 배트는 머리 위로 세운 배트와 가슴 위를 담는다(2026-11-03 고가 배트를 더하면서. 몸 전체로는 배트가 가는 줄이라 광선·결정이 안 보였다)
const PREVIEW_ZOOM = {
  bat: (k) => [k.hand, V.add(k.tip, [-0.12, 0.1, 0]), V.add(k.tip, [0.12, 0.1, 0]), V.add(k.head, [-0.3, 0.2, 0]), V.add(k.chest, [0.3, -0.15, 0])],
  helmet: (k) => [V.add(k.head, [-0.3, 0.38, 0]), V.add(k.head, [0.3, -0.3, 0])],
  shoe: (k) => [V.add(k.feet.l, [-0.25, 0.2, 0]), V.add(k.feet.l, [0.3, -0.1, 0]), V.add(k.feet.r, [-0.25, 0.2, 0]), V.add(k.feet.r, [0.3, -0.1, 0])],
  // 유니폼은 헬멧부터 발까지(위로 솟은 방망이 끝은 빼서 몸이 크게 보인다. 2026-11-03 금장·네온 무늬를 보이려고 더함)
  uniform: (k) => [V.add(k.head, [0, 0.2, 0]), k.hand, V.add(k.feet.l, [0, -0.08, 0]), V.add(k.feet.r, [0, -0.08, 0]), V.add(k.knees.l, [-0.15, 0, 0]), V.add(k.knees.r, [0.15, 0, 0])],
};
// 로켓 부츠·번개 운동화는 뛸 때 효과가 나서 신발 탭 미리 보기는 옆에서 본 제자리 전력 질주(허리 아래를 크게)로 보여 준다.
// 오른쪽으로 곧게 뛰는 길을 한 번 만들어 두고, 최고 빠르기에서 두 걸음 주기를 되풀이하며 몸을 늘 같은 자리로 옮겨 그린다
const RUN_SHOE_FX = ['rocket', 'bolt'];
let demoLeg = null;
function demoRunSkeleton() {
  demoLeg ??= makeLeg(0, [[0, 0], [120, 0]], SPRINT);
  const cad = SPRINT.cad[0] + SPRINT.cad[1] * SPRINT.top, tt = 6 + fxTime() % (2 / cad);
  const run = { ...routeState(demoLeg.route, demoLeg.track, SPRINT, tt), drawShift: 0, lookFoul: false, top: SPRINT.top };
  return { ...shiftSkeleton(runnerSkeleton(run), -run.x), soles: { l: 0, r: 0 } };   // 밑창은 길 위 실제 자리로 카메라를 재서 옮기기 전 값이 틀린다(옆에서 보면 안 보인다)
}
// 배트 탭 미리 보기는 저절로 되풀이한다(2026-11-03 유저 피드백 '상점에 배트 효과도 보이면 좋겠다', 사용자 결정 '저절로 되풀이'):
// BAT_DEMO.cycle초마다 공이 와서 타자가 치고, 효과 배트면 맞는 순간 효과(drawBatBurst)가 터진다. 효과 없는 배트는 스윙만. 배트를 고르면 처음부터(sh.demo)
const BAT_DEMO = { cycle: 2.5, hit: 1.0, come: 0.35, fly: 0.4 };
function batDemoAt(sh) {   // 기다리는 동안은 배트를 세운 준비 자세(손을 당기는 준비 동작은 배트가 카메라 쪽으로 누워 안 보여서 뺀다)
  const u = ((performance.now() - sh.demo) / 1000) % BAT_DEMO.cycle;
  return { u, tau: u >= BAT_DEMO.hit ? u - BAT_DEMO.hit : null };
}
function drawBatDemoBall(d) {   // 미리 보기 상자 안(타자와 같은 변환)에서 공이 오고, 맞으면 날아간다
  const H = [HIT_SPOT.x, HIT_SPOT.y, HIT_SPOT.z], from = [H[0] + 0.15, H[1] + 0.35, H[2] + 7], to = [H[0] - 2.5, H[1] + 2.2, H[2] + 5];
  let q = null;
  if (d.tau == null && d.u > BAT_DEMO.hit - BAT_DEMO.come) { const k = (d.u - (BAT_DEMO.hit - BAT_DEMO.come)) / BAT_DEMO.come; q = from.map((v, i) => lerp(v, H[i], k)); }
  else if (d.tau != null && d.tau < BAT_DEMO.fly) { const k = easeOut(d.tau / BAT_DEMO.fly); q = H.map((v, i) => lerp(v, to[i], k)); }
  const p = q && project(q[0], q[1], q[2]);
  if (!p) return;
  ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, BALL_R * p.s), 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
}
function drawShopPreview(box) {
  const sh = game.shop, runDemo = sh.tab === 'shoe' && RUN_SHOE_FX.includes(fxOf(currentLook().shoe)), demo = sh.tab === 'bat' ? batDemoAt(sh) : null;
  const k = runDemo ? demoRunSkeleton() : batterSkeleton(sh.tab === 'number' ? SWING_TIME * 2 : demo?.tau ?? null);
  const frameK = demo ? batterSkeleton(null) : k, zoom = runDemo ? null : PREVIEW_ZOOM[sh.tab];   // 배트 탭 틀은 준비 자세로 잰다(휘두르는 동안 틀이 흔들리지 않게)
  roundRect(box.x, box.y, box.w, box.h, 14);
  const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
  g.addColorStop(0, 'rgba(20,40,70,0.9)'); g.addColorStop(0.62, 'rgba(26,74,48,0.9)'); g.addColorStop(1, 'rgba(120,86,52,0.9)');
  ctx.fillStyle = g; ctx.fill();
  if (runDemo) {   // 허리(1m)부터 땅까지, 몸 뒤 0.8m(불꽃)부터 앞 0.65m까지 담는 틀(신발이 크게 보이게). 발 따라 틀이 흔들리지 않게 고정된 자리로 잰다
    const back = project(-0.8, 0, 0), front = project(0.65, 0, 0), ground = project(0, 0, 0), top = project(0, 1.0, 0);
    if (!back || !front || !ground || !top) return;   // 따라가는 카메라가 아직 안 돌아왔다
    const sc = Math.min((box.w * 0.92) / (front.x - back.x), (box.h * 0.86) / (ground.y - top.y));
    ctx.save();
    roundRect(box.x, box.y, box.w, box.h, 14); ctx.clip();
    ctx.translate(box.x + box.w / 2, box.y + box.h * 0.93); ctx.scale(sc, sc); ctx.translate(-(back.x + front.x) / 2, -ground.y);
    drawFigureShadow(k);
    const C = batterColors();
    drawBatterFigure(k, (name) => C[name], 0);
    ctx.restore();
    return;
  }
  const pts = (zoom ? zoom(frameK) : [k.head, k.tip, k.hand, k.feet.l, k.feet.r, k.knees.l, k.knees.r]).map(batterPoint).filter(Boolean);
  if (demo) for (const [dx, dy] of [[-0.45, -0.3], [0.45, -0.3], [0, 0.35]]) { const p = project(HIT_SPOT.x + dx, HIT_SPOT.y + dy, HIT_SPOT.z); if (p) pts.push(p); }   // 맞는 자리 둘레(효과가 터지는 곳)도 담는다
  if (pts.length < 2) return;
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)) - (zoom ? 0 : 20), maxY = Math.max(...pts.map((p) => p.y)) + (zoom ? 0 : 12);
  const sc = Math.min((box.w * (zoom ? 0.9 : 0.8)) / (maxX - minX), (box.h * 0.9) / (maxY - minY));
  ctx.save();
  roundRect(box.x, box.y, box.w, box.h, 14); ctx.clip();
  if (zoom) { ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.scale(sc, sc); ctx.translate(-(minX + maxX) / 2, -(minY + maxY) / 2); }
  else { ctx.translate(box.x + box.w * (sh.tab === 'trail' ? 0.3 : 0.5), box.y + box.h * 0.05); ctx.scale(sc, sc); ctx.translate(-(minX + maxX) / 2, -minY); }
  drawFigureShadow(k);
  const C = batterColors();
  if (demo) drawBatDemoBall(demo);
  drawBatterFigure(k, (name) => C[name], 0);
  if (demo && demo.tau != null) {   // 효과 배트로 맞힌 순간 효과(게임과 같은 자리·같은 함수)
    const fx = fxOf(currentLook().bat), c = project(HIT_SPOT.x, HIT_SPOT.y, HIT_SPOT.z);
    if (c && BAT_BURSTS[fx]) drawBatBurst({ fx, t: demo.tau, seed: 7 }, c, demo.tau);
  }
  ctx.restore();
  const trail = currentLook().trail;
  if (sh.tab === 'trail' && trail !== 'trail-none') {   // 공이 왼쪽 아래에서 오른쪽 위로 날아간다(1.4초마다 다시)
    const u = ((performance.now() - sh.demo) / 1000) % 1.4;
    const at = (v) => ({ x: box.x + box.w * (0.38 + 0.55 * v), y: box.y + box.h * (0.62 - 0.5 * Math.sin(Math.min(1, v) * Math.PI * 0.75)) });
    const trailPts = [];
    for (let i = 1; i <= 12; i++) if (u - i * 0.025 > 0) trailPts.push(at((u - i * 0.025) / 1.1));
    if (u < 1.1) {
      if (fancyTrail(trail)) drawFancyPreview(trail, at, u, view.mobile ? 6 : 8, box);
      else drawTrailDots(trailPts, trail, () => (view.mobile ? 6 : 8));
      const b = at(u / 1.1);
      ctx.beginPath(); ctx.arc(b.x, b.y, view.mobile ? 6 : 8, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    }
  }
}

function drawShop() {
  dim(0.86);
  const m = view.mobile, cx = view.w / 2, sh = game.shop, W = m ? view.w - 24 : 760, x0 = cx - W / 2;
  let y = m ? 16 : 24;
  rowRects(cx, y, m ? 190 : 240, 34, 2, 6).forEach((r, i) => {   // [상점 | 내 물건]
    const v = i ? 'inventory' : 'shop';
    addButton(r, i ? '내 물건' : '상점', sh.view === v ? 'chipOn' : 'chip', () => { sh.view = v; sh.sel = null; });
  });
  if (wallet.coins != null) drawCoinPill(x0 + W, y + 17, wallet.coins, 'right');
  y += 34 + (m ? 10 : 14);
  const tcols = m ? 4 : 8, tw = (W - (tcols - 1) * 6) / tcols, th = m ? 30 : 34;
  // 폰은 물건 칸이 한 줄에 셋(2026-10-30 물건이 늘어 가장 많은 배트가 12개). 미리 보기 칸 높이는 물건이 가장 많은 탭도
  // 닫기 버튼까지 화면에 들어가게 남는 높이로 정한다(탭마다 칸 높이가 바뀌지 않게). 키가 작은 폰(640px)에서도 들어간다
  const icols = m ? 3 : 4, gap = m ? 6 : 8, iw = (W - (icols - 1) * gap) / icols, ih = m ? 44 : 54;
  const maxRows = Math.ceil(Math.max(...SHOP_SLOTS.map(([s]) => SHOP_ITEMS.filter((i) => i.slot === s).length)) / icols);
  const below = (m ? 10 : 14) + Math.ceil(SHOP_SLOTS.length / tcols) * (th + 6) + (m ? 6 : 10) + maxRows * (ih + 8) + (m ? 6 : 10) + 114 + 8;
  const pv = { x: x0, y, w: W, h: clamp(Math.min(view.h * 0.27, view.h - y - below), 110, 300) };
  drawShopPreview(pv);
  y += pv.h + (m ? 10 : 14);
  SHOP_SLOTS.forEach(([slot, label], i) => {
    const r = { x: x0 + (i % tcols) * (tw + 6), y: y + Math.floor(i / tcols) * (th + 6), w: tw, h: th };
    addButton(r, label, sh.tab === slot ? 'chipOn' : 'chip', () => { sh.tab = slot; sh.sel = null; sh.demo = performance.now(); });
  });
  y += Math.ceil(SHOP_SLOTS.length / tcols) * (th + 6) + (m ? 6 : 10);
  const list = SHOP_ITEMS.filter((it) => it.slot === sh.tab && (sh.view === 'shop' || owns(it.id)));
  list.forEach((it, i) => {
    const r = { x: x0 + (i % icols) * (iw + gap), y: y + Math.floor(i / icols) * (ih + 8), w: iw, h: ih };
    drawItemCard(r, it, sh.sel === it.id);
    ui.buttons.push({ r, label: it.name, onTap: () => selectItem(it) });
  });
  y += Math.ceil(list.length / icols) * (ih + 8) + (m ? 6 : 10);
  drawShopAction(y);
}

// 아래 버튼: 고른 물건에 따라 로그인 / 사기 / 착용하기 / 착용 중 / 등번호 달기
function drawShopAction(y) {
  const m = view.mobile, cx = view.w / 2, sh = game.shop, sel = shopItem(sh.sel), bw = m ? view.w - 64 : 320, note = (s) => text(s, cx, y + 10, { size: m ? 12 : 14, weight: 600, color: 'rgba(255,255,255,0.7)' });
  const btn = { x: cx - bw / 2, y: y + 24, w: bw, h: 46 };
  let showNo = false;
  if (!loggedIn()) {
    note('카카오로 로그인하면 코인을 모아 꾸밀 수 있어요');
    addButton(btn, '카카오로 로그인', 'kakao', startKakaoLogin);
  } else if (!sel) note(sh.view === 'shop' ? '고르면 위에서 미리 입어 봐요 · 코인은 점수의 1/100' : '가진 물건을 골라 입어요');
  else if (!owns(sel.id)) {
    const can = (wallet.coins ?? 0) >= sel.price;
    note(can ? `${sel.name} · ${sel.price.toLocaleString()}코인` : `코인이 ${(sel.price - (wallet.coins ?? 0)).toLocaleString()}개 모자라요`);
    addButton(btn, can ? `사기 · ${sel.price.toLocaleString()}코인` : '코인이 모자라요', can ? 'primary' : 'secondary', () => (can ? buyItem(sel) : toast('판을 더 쳐서 코인을 모아 보세요')));
  } else if (sel.id === 'number-on') {   // 번호 입력칸 + 달기
    showNo = true;
    note('0~99 사이 번호를 넣고 달기를 눌러요');
    const iw = m ? 90 : 100;
    Object.assign(noInput.style, { display: 'block', left: `${cx - bw / 2}px`, top: `${btn.y}px`, width: `${iw}px`, height: '46px' });
    addButton({ x: btn.x + iw + 10, y: btn.y, w: bw - iw - 10, h: 46 }, '달기', 'primary', () => {
      const n = Number(noInput.value);
      if (noInput.value === '' || !Number.isInteger(n) || n < 0 || n > 99) { toast('0~99 사이 번호를 골라 주세요'); return; }
      noInput.blur(); equipItem(sel, n);
    });
  } else if (wearing(sel)) { note(`${sel.name} · 착용 중`); addButton(btn, '착용 중', 'secondary', () => {}); }
  else { note(sel.price ? `${sel.name} · 보유` : `${sel.name} · 기본`); addButton(btn, '착용하기', 'primary', () => equipItem(sel)); }
  if (!showNo && noInput.style.display !== 'none') noInput.style.display = 'none';
  addButton({ x: cx - 70, y: btn.y + 54, w: 140, h: 36 }, '닫기', 'link', () => { noInput.blur(); goTitle(); });
}

// ===== 시작 화면과 끝 화면 =====
// 시작 화면에는 "탭해서 시작"과 [좌타 | 우타]만 둔다(2026-10-28 사용자 피드백). 빈 곳 어디를 눌러도 시작한다.
// 다른 모드와 설정은 오른쪽 위 메뉴에 있다. 누르면 늘 10구 도전(매번 다른 공)이다(2026-10-30 오늘의 10구를 없앰)
// 로그인 안 한 사람이 10구 판을 시작하면 먼저 카카오 로그인을 권한다(아래 drawLoginPrompt)
function startDefault() {
  if (!settings.team) { openOnboard('start', true); return; }
  if (askLoginToday()) game.state = 'loginPrompt';
  else startGame('challenge');
}

function drawTitle(time) {
  dim(0.6);
  const m = view.mobile, cx = view.w / 2, cy = view.h * 0.38;
  // 폰은 타자를 화면 안으로 당겨 그려서(MOBILE_BATTER_SHIFT) 글자 뒤에 겹친다. 글자 뒤에 위아래가 부드러운 어두운 띠를 깐다(2026-11-05 사용자가 시안 A로 고름)
  if (m) {
    const y0 = cy - 140, h = 280, g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, 'rgba(4,9,18,0)'); g.addColorStop(0.22, 'rgba(4,9,18,0.72)'); g.addColorStop(0.78, 'rgba(4,9,18,0.72)'); g.addColorStop(1, 'rgba(4,9,18,0)');
    ctx.fillStyle = g; ctx.fillRect(0, y0, view.w, h);
  }
  text('끝내기', cx, cy - (m ? 70 : 92), { size: m ? 16 : 20, weight: 700, color: '#f2c94c' });
  text('walkoff', cx, cy - (m ? 30 : 40), { size: m ? 52 : 76, weight: 900, shadow: true });
  const lines = ['기회 10번, 타이밍만 맞춰 쳐 내세요.', '존 밖 공을 골라내면 기회가 1번 늘어요.', '마지막 기회는 9회말 끝내기 찬스, 점수 2배예요.'];
  lines.forEach((l, i) => text(l, cx, cy + (m ? 28 : 36) + i * (m ? 24 : 30), { size: m ? 13 : 17, weight: 500, color: 'rgba(255,255,255,0.85)' }));
  drawBatsToggle(cy + (m ? 112 : 134));
  if (!m) text('← → 키로도 바꿀 수 있어요', cx, cy + 168, { size: 13, weight: 500, color: 'rgba(255,255,255,0.55)' });
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 4);
  pill(m ? '탭해서 시작' : '스페이스바 · 빈 곳 클릭으로 시작', cx, cy + (m ? 164 : 214), { size: m ? 16 : 18, bg: '#f2c94c', color: '#1b1405' });
  ctx.globalAlpha = 1;
  const streak = playStreak(), hot = !playedDays().has(today()) && streak >= 1;   // 이어 친 날이 있는데 오늘 아직 안 쳤으면 노랗게 보여 오늘도 치게 한다
  const line = hot ? (streak >= 2 ? `${streak}일 연속 중 · 오늘 치면 ${streak + 1}일` : '오늘 치면 2일 연속')
    : `${streak >= 2 ? `${streak}일 연속 · ` : ''}주간 랭킹은 이번 주 최고 기록이에요`;
  text(line, cx, cy + (m ? 196 : 250), { size: m ? 11 : 13, weight: hot ? 600 : 500, color: hot ? 'rgba(242,201,76,0.9)' : 'rgba(255,255,255,0.6)' });
  const mb = menuButtonRect();   // 오른쪽 위 '≡ 메뉴'(안 읽은 새 소식은 NEW), 메뉴를 한 번도 안 연 사람에게는 아래 말풍선
  drawMenuButton(mb, newsUnread());
  ui.buttons.push({ r: mb.hit, label: '메뉴', onTap: openMenu });
  if (hasPlayed() && !store.get('menuSeen', false)) ui.buttons.push({ r: drawMenuBubble(mb), label: '메뉴 안내', onTap: openMenu });
  if (loggedIn() && wallet.coins != null) {   // 메뉴 옆 코인. 누르면 상점
    const r = drawCoinPill(mb.x - 8, mb.y + mb.h / 2, wallet.coins, 'right');
    ui.buttons.push({ r, label: '코인', onTap: () => openShop('shop') });
  }
}

// ===== 새 소식(2026-11-04 사용자 결정, 문구는 사용자가 확인) =====
// 메뉴(≡)의 '새 소식'에 화면이 바뀐 업데이트를 하루 한 항목(2~3줄, 만든 사람 1인칭 해요체, 2026-11-06 사용자 결정)으로 최근 NEWS_MAX개만 둔다. 안 읽은 소식이 있으면 시작 화면 '≡ 메뉴' 단추와 메뉴의
// 새 소식 띠에 NEW(2026-11-05 전에는 빨간 점. 시작 화면은 그대로, 창을 띄우지 않는다). 읽은 기록은 이 브라우저에 마지막으로 본 소식 id(walkoff.newsSeen).
// 처음 온 사람(이 기기에 친 기록이 없음)은 열 때 모두 읽은 것으로 적어 점을 띄우지 않는다. 쳐 본 사람은 첫 소식부터 점이 뜬다
const NEWS = [   // id는 시간 순으로 커지는 글자(같은 날 줄을 더하면 끝 글자를 올려 읽은 사람에게도 NEW를 다시 띄운다), label은 화면 머리
  { id: '2026-11-06a', label: '11/6', items: [
    '패들렛에 올라온 의견대로 칭호를 넣어 봤어요. 홈런왕부터 아웃왕까지 6개예요.',
    "아웃왕은 받고 싶진 않겠지만… 조건은 메뉴 '칭호'에서 볼 수 있고, 로그인하면 랭킹에도 붙어요.",
  ] },
  { id: '2026-11-05f', label: '11/5', items: [   // 11/5에 네 번(a·c·d·f) 낸 소식을 한 항목으로 합치며 가장 늦은 id를 뒀다(읽은 사람에게 NEW를 다시 띄우지 않는다)
    "메뉴를 새로 꾸미고 '조준 타격(실험)'을 넣었어요. 배트로 공이 올 자리를 겨눠 치는 모드예요.",
    '홈런은 초록 별로 보이고, 1루에서 아슬아슬하면 주자가 머리부터 슬라이딩해요. 카메라도 날아가는 공을 끝까지 따라가요.',
    "조준 타격은 아직 실험이라 랭킹엔 안 올라가요. 쳐 보고 어땠는지 '의견 보내기'로 알려 주세요.",
  ] },
  { id: '2026-11-04c', label: '11/4', items: [
    '수비가 사람 같아졌어요. 외야수는 닿는 공을 끝까지 쫓아가 잡고, 잡은 공은 내야수에게 던져 줘요.',
    '끝내기 상황에서는 주자가 홈 승부, 태그업, 병살까지 해요. 로그인했다면 이길 때 코인도 받아요.',
    '홈런을 맞은 투수는 무릎을 짚고 고개를 숙여요. 미안하지만 보는 맛이 있어요.',
  ] },
  { id: '2026-11-03c', label: '11/3', items: [
    '상점에 비싼 물건 12가지를 들였어요. 불꽃 배트로 치면 진짜 불꽃이 터져요.',
    '공이 날아가는 동안 화면을 누르면 바로 결과로 넘어가요. 기다리기 지루하다는 의견이 있었거든요.',
    '3루타가 생겼고, 이제 당겨 쳐도 밀어 쳐도 홈런이 나와요. 뛰는 폼도 새로 만들었어요.',
  ] },
];
const NEWS_MAX = 5;
const hasPlayed = () => store.get('best', 0) > 0 || !!store.get('stats', null) || !!store.get('scnStats', null);
function initNews() {
  if (NEWS.length && !store.get('newsSeen', null) && !hasPlayed()) store.set('newsSeen', NEWS[0].id);
}
const newsUnread = () => NEWS.length > 0 && hasPlayed() && String(store.get('newsSeen', '')) < NEWS[0].id;
function openNews() {
  game.state = 'news';
  news.scroll = 0;
  if (NEWS.length) store.set('newsSeen', NEWS[0].id);
}
// 폭 w(px)에 맞춰 띄어쓰기 자리에서 줄을 나눈다(지금 ctx.font 기준)
function wrapWords(str, w) {
  const lines = [''];
  for (const word of str.split(' ')) { const cur = lines[lines.length - 1], next = cur ? `${cur} ${word}` : word; if (cur && ctx.measureText(next).width > w) lines.push(word); else lines[lines.length - 1] = next; }
  return lines;
}
// 소식이 화면보다 길면 휠·끌어 올리기로 넘긴다(game.newsScroll px). 위아래 끝을 잘라 그리고 오른쪽에 위치 막대를 둔다
const news = { scroll: 0, max: 0, drag: null };
function drawNews() {
  dim(0.88);
  const m = view.mobile, cx = view.w / 2, w = m ? view.w - 44 : 520, x0 = cx - w / 2, size = m ? 14 : 16, lh = m ? 21 : 24, bottom = view.h - (m ? 110 : 120);
  const top = view.h * (m ? 0.09 : 0.11);
  text('새 소식', cx, top, { size: m ? 22 : 28, weight: 800 });
  const y0 = top + (m ? 42 : 54), clipTop = y0 - size - 4;
  let y = y0 - news.scroll;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, clipTop, view.w, bottom - clipTop); ctx.clip();
  for (const n of NEWS.slice(0, NEWS_MAX)) {
    text(n.label, x0, y, { size: size + 1, weight: 800, color: '#f2c94c', align: 'left' });
    y += lh + 4;
    for (const it of n.items) {
      ctx.font = font(size, 500);
      wrapWords(it, w - 18).forEach((ln, i) => {
        if (i === 0) text('·', x0 + 2, y, { size, weight: 800, color: 'rgba(255,255,255,0.75)', align: 'left' });
        text(ln, x0 + 16, y, { size, weight: 500, color: 'rgba(255,255,255,0.88)', align: 'left' });
        y += lh;
      });
    }
    y += m ? 14 : 18;
  }
  ctx.restore();
  const contentH = y + news.scroll - y0, room = bottom - clipTop;
  news.max = Math.max(0, contentH - room + lh);
  news.scroll = clamp(news.scroll, 0, news.max);
  if (news.max > 0) {   // 위치 막대
    const barH = Math.max(30, room * room / (room + news.max)), barY = clipTop + (room - barH) * (news.scroll / news.max);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x0 + w + 8, clipTop, 3, room);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(x0 + w + 8, barY, 3, barH);
  }
  addButton({ x: cx - 80, y: view.h - (m ? 96 : 104), w: 160, h: 46 }, '메뉴로', 'primary', openMenu);
}

// ===== 메뉴(2026-11-05 사용자 '햄버거 메뉴가 잘 안 보이는 사람도 있다, 가독성 좋게, 꾸며 줬으면' → 오른쪽 세션 시안 A·말풍선) =====
// 시작 화면 오른쪽 위는 '≡ 메뉴' 알약 단추이고(전에는 배경 없는 흰 줄 셋) 안 읽은 새 소식이 있으면 오른쪽 위에 NEW를 단다.
// 메뉴를 한 번도 안 연 사람에게는 단추 아래 말풍선을 띄운다(walkoff.menuSeen. 새 소식 점처럼 처음 온 사람은 빼고 쳐 본 사람만).
// 메뉴는 내 정보 카드(팀 배지·닉네임·칩·닫기) + 새 소식 띠 + 의견 보내기 띠 + 놀기·기록·내 것·설정 묶음(금색 선 아이콘·이름·오른쪽 값)이고 PC는 780px 두 칸,
// 폰은 한 칸이다. 낮은 화면은 줄을 줄이고(MENU_SIZE.compact), 그래도 넘치면 끌어 넘긴다(그때는 줄을 뗄 때 누른다). 이모지는 쓰지 않는다
const menu = { scroll: 0, max: 0, drag: null, fade: { top: false, bottom: false } };
const MENU_FADE = 40;   // 넘칠 때 흐리게 하는 가장자리 높이(px)
// 의견 보내기(2026-11-05 사용자 '유저 보이스를 넣을 수 있게 링크를 게임 안에 넣자. 출시 전이니 피드백을 받아 더 재밌게 만들자'): 메뉴 '의견 보내기' 줄과
// 조준 판 끝 화면 링크가 패들렛을 새 탭으로 연다. 바깥 사이트라서 바깥 화살표(MENU_ICONS.out)를 단다. 이런 단추는 ui.buttons에 href를 둔다
const FEEDBACK_URL = 'https://padlet.com/ghtgrz4s5s/walkoff-s02561vkamvtbvubw2oe';
// 만든 사람 한마디(2026-11-06 사용자 결정): 메뉴 의견 띠의 설명 자리에 둔다. 폰은 한 줄에 안 들어가서 문장마다 한 줄씩 작은 글씨로 그린다
// (띠 높이는 그대로라 작은 폰에서 메뉴가 더 넘치지 않는다)
const FEEDBACK_NOTE = ['만든 사람이 의견을 하나하나 읽고 고쳐요.', '패들렛에 남겨 주세요!'];
// 새 탭이 막히면(새 창을 못 여는 앱 안 브라우저) 이 탭에서 연다. noopener를 주면 막혔는지 알 수 없어서 연 뒤에 opener를 끊는다
function openOutside(url) {
  const w = window.open(url, '_blank');
  if (!w) { location.href = url; return; }
  try { w.opener = null; } catch { /* 벌써 다른 사이트로 넘어갔으면 못 끊는다 */ }
}
const linkAt = (x, y) => ui.buttons.find((b) => b.href && inRect(b.r, x, y));
function openMenu() {
  game.state = 'menu'; menu.scroll = 0;
  if (!store.get('menuSeen', false)) store.set('menuSeen', 1);   // 말풍선은 메뉴를 한 번 열면 다시 안 띄운다
  refreshAccountBest();   // 로그인했으면 이번 주·역대 최고를 계정 기록으로(1분에 한 번까지)
}
// 아이콘: 24칸 SVG 경로(시안 mock.html, 원·둥근 네모도 경로로 바꿨다)를 금색 2px 선으로 그린다
const circlePath = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const MENU_ICONS = Object.fromEntries(Object.entries({
  scn: 'M6 5h12v8l-6 6-6-6z',
  practice: `M5 19L16 8M14 6l4 4${circlePath(18.5, 17.5, 2.5)}`,
  aim: `${circlePath(12, 12, 7)}M12 2v5M12 17v5M2 12h5M17 12h5`,
  rec: 'M8 4h8v5a4 4 0 0 1-8 0zM12 13v4M8 20h8M16 6h3a3 3 0 0 1-3 3M8 6H5a3 3 0 0 0 3 3',
  rank: 'M4 20v-6h5v6M9 20V9h6v11M15 20v-8h5v8',
  titles: `M8 3l3.5 7M16 3l-3.5 7${circlePath(12, 15, 5)}`,   // 메달
  team: 'M8 4l-5 3 2 4 3-1v10h8V10l3 1 2-4-5-3a4 4 0 0 1-8 0z',
  shop: circlePath(12, 12, 8) + circlePath(12, 12, 4.5),
  me: `${circlePath(12, 8, 4)}M4 21a8 8 0 0 1 16 0`,
  calib: `${circlePath(12, 13, 7)}M12 13V9M10 3h4M18 6l1.5-1.5`,
  vib: 'M10 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM4 9v6M20 9v6',
  voice: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  out: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',   // 바깥 사이트로 나가는 화살표
  close: 'M6 6l12 12M18 6L6 18',
}).map(([k, d]) => [k, new Path2D(d)]));
function menuIcon(name, x, y, size, color = '#f2c94c') {   // (x, y)가 왼쪽 위인 size px 칸에
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(MENU_ICONS[name]);
  ctx.restore();
}
// 지금 ctx.font로 폭 w를 넘으면 끝을 '…'로 줄인다
function fitText(str, w) {
  if (ctx.measureText(str).width <= w) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > w) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}
// 빨간 NEW 배지. x는 왼쪽 끝(right면 오른쪽 끝), cy는 세로 가운데. 폭을 돌려준다
function drawNewBadge(x, cy, align = 'left') {
  ctx.font = font(10, 800);
  const w = ctx.measureText('NEW').width + 12, h = 16, x0 = align === 'right' ? x - w : x;
  roundRect(x0, cy - h / 2, w, h, 8); ctx.fillStyle = '#ff4d4d'; ctx.fill();
  text('NEW', x0 + w / 2, cy + 0.5, { size: 10, weight: 800 });
  return w;
}
// 시작 화면 '≡ 메뉴' 단추: 그리는 알약(PC 44·폰 40px)과 누르는 자리 hit(위아래로 넓혀 48px)
function menuButtonRect() {
  const m = view.mobile, h = m ? 40 : 44, y = m ? 10 : 12;
  ctx.font = font(m ? 15 : 16, 800);
  const w = 13 + 18 + 9 + ctx.measureText('메뉴').width + 16, x = view.w - (m ? 10 : 14) - w;
  return { x, y, w, h, hit: { x, y: y - (48 - h) / 2, w, h: 48 } };
}
function drawMenuButton(b, unread) {
  const cy = b.y + b.h / 2;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
  roundRect(b.x, b.y, b.w, b.h, b.h / 2); ctx.fillStyle = 'rgba(6,14,28,0.85)'; ctx.fill(); ctx.restore();
  roundRect(b.x, b.y, b.w, b.h, b.h / 2); ctx.strokeStyle = 'rgba(242,201,76,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#f2c94c';
  for (let i = 0; i < 3; i++) { roundRect(b.x + 13, cy - 7.25 + i * 6, 18, 2.5, 1.25); ctx.fill(); }   // 줄 셋
  text('메뉴', b.x + 40, cy + 1, { size: view.mobile ? 15 : 16, weight: 800, align: 'left' });
  if (unread) drawNewBadge(b.x + b.w + 6, b.y, 'right');   // 안 읽은 새 소식
}
// 메뉴를 한 번도 안 연 사람에게 단추 아래 흰 말풍선(꼭지는 단추 가운데를 가리킨다). 누르는 자리(꼭지는 빼고, 단추 누르는 자리와 안 겹치게)를 돌려준다
function drawMenuBubble(b) {
  const m = view.mobile, size = m ? 13 : 14, str = '끝내기 상황·연습·랭킹은 여기 있어요';
  ctx.font = font(size, 700);
  const w = ctx.measureText(str).width + 26, h = size + 18, x = view.w - (m ? 8 : 12) - w, y = b.y + b.h + (m ? 10 : 12), ax = clamp(b.x + b.w / 2, x + 16, x + w - 16);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
  roundRect(x, y, w, h, 10); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
  ctx.beginPath(); ctx.moveTo(ax - 7, y + 0.5); ctx.lineTo(ax, y - 7); ctx.lineTo(ax + 7, y + 0.5); ctx.closePath(); ctx.fill();
  text(str, x + w / 2, y + h / 2 + 0.5, { size, weight: 700, color: '#141414' });
  return { x, y, w, h };
}
// 크기(시안 mock.html). 낮은 화면은 compact를 덮어쓴다. minRow는 줄을 줄여도 지킬 높이(그보다 낮아야 들어가면 끌어 넘긴다, 폰은 늘 44px)
const MENU_SIZE = {
  pc: { w: 780, top: 64, bottom: 24, side: 16, colGap: 14, headPad: 14, headPadX: 16, badge: 52, badgeFont: 18, nick: 20, chip: 12, newsGap: 10, newsH: 40, newsFont: 14,
    h3Top: 14, h3Bottom: 6, h3Font: 12, row: 54, gap: 6, rowPad: 14, icon: 34, label: 16, value: 13, foot: 28, footFont: 12, minRow: 40 },
  mo: { w: Infinity, top: 12, bottom: 12, side: 12, colGap: 0, headPad: 10, headPadX: 12, badge: 44, badgeFont: 16, nick: 17, chip: 11, newsGap: 8, newsH: 34, newsFont: 13,
    h3Top: 9, h3Bottom: 5, h3Font: 11, row: 44, gap: 5, rowPad: 12, icon: 30, label: 15, value: 12, foot: 24, footFont: 11, minRow: 44 },
  compact: { top: 8, bottom: 8, headPad: 8, badge: 40, badgeFont: 15, nick: 16, newsGap: 6, newsH: 30, h3Top: 6, h3Bottom: 3, gap: 4, foot: 20, minRow: 34 },
};
// 메뉴 자리: 묶음을 PC는 두 칸(놀기·기록 | 내 것·설정), 폰은 한 칸에 놓고 줄 높이를 남는 높이에 맞춘다. max는 넘쳐서 끌어 넘길 길이
function menuLayout(groups) {
  const m = view.mobile, cols = m ? [groups] : [groups.slice(0, 2), groups.slice(2)];
  const heads = Math.max(...cols.map((c) => c.length)), rows = Math.max(...cols.map((c) => c.reduce((n, g) => n + g[1].length, 0)));
  const size = (compact) => {
    const c = { ...MENU_SIZE[m ? 'mo' : 'pc'], ...(compact ? MENU_SIZE.compact : {}) };
    if (m) c.minRow = c.row;   // 폰은 줄을 44px 아래로 줄이지 않는다(카드·제목 여백만 줄이고 넘치면 끌어 넘긴다, 2026-11-05 사용자 결정)
    if (!m && !compact) c.top = clamp(view.h * 0.07, 12, c.top);
    const fixed = c.top + c.headPad * 2 + c.badge + 2 * (c.newsGap + c.newsH) + heads * (c.h3Top + c.h3Font + c.h3Bottom) + c.foot + c.bottom;   // 띠 둘(새 소식·의견 보내기)
    return { c, fixed, rowH: clamp((view.h - fixed) / rows - c.gap, c.minRow, c.row) };
  };
  let L = size(false);
  if ((view.h - L.fixed) / rows - L.c.gap < L.c.minRow) L = size(true);   // 보통 크기로는 minRow를 못 지키면
  const W = Math.min(L.c.w, view.w - 2 * L.c.side), height = L.fixed + rows * (L.rowH + L.c.gap);
  return { ...L, cols, W, x0: (view.w - W) / 2, max: Math.max(0, height - view.h) };
}
// 메뉴 한 줄: 아이콘 칸 + 이름(+ 파란 꼬리표 tag) + 오른쪽 값(넘치면 …)
function drawMenuRow(r, icon, name, value, c, tag = '') {
  roundRect(r.x, r.y, r.w, r.h, 12); ctx.fillStyle = 'rgba(10,16,28,0.8)'; ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.065)'; ctx.fill();   // 뒤의 경기장이 줄 글자 밑으로 비치지 않게 어두운 바탕부터
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.stroke();
  const is = Math.min(c.icon, r.h - 8), ix = r.x + c.rowPad, iy = r.y + (r.h - is) / 2, lx = ix + is + (view.mobile ? 10 : 12), mid = r.y + r.h / 2 + 0.5;
  roundRect(ix, iy, is, is, is * 0.3); ctx.fillStyle = 'rgba(242,201,76,0.14)'; ctx.fill();
  menuIcon(icon, ix + is * 0.2, iy + is * 0.2, is * 0.6);   // 34px 칸에 20px 아이콘
  text(name, lx, mid, { size: c.label, weight: 800, align: 'left' });
  let lw = ctx.measureText(name).width;
  if (tag) {   // 꼬리표('실험')
    ctx.font = font(11, 800);
    const tw = ctx.measureText(tag).width + 12, tx = lx + lw + 8;
    roundRect(tx, mid - 9, tw, 18, 6); ctx.fillStyle = 'rgba(80,170,255,0.2)'; ctx.fill();
    text(tag, tx + tw / 2, mid, { size: 11, weight: 800, color: '#8cc8ff' });
    lw += 8 + tw;
  }
  ctx.font = font(c.value, 500);
  text(fitText(value, r.x + r.w - c.rowPad - (lx + lw + 12)), r.x + r.w - c.rowPad, mid, { size: c.value, weight: 500, color: 'rgba(255,255,255,0.58)', align: 'right' });
}
// 내 정보 카드의 칩. parts는 [글자, 색] 조각들(숫자는 금색). 폭을 돌려준다
function drawMenuChip(x, cy, parts, size) {
  ctx.font = font(size, 700);
  const padX = size > 11 ? 9 : 7, w = parts.reduce((s, [str]) => s + ctx.measureText(str).width, 0) + padX * 2, h = size + 8;
  roundRect(x, cy - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
  let px = x + padX;
  for (const [str, color] of parts) { text(str, px, cy + 0.5, { size, weight: 700, color, align: 'left' }); px += ctx.measureText(str).width; }
  return w;
}
function drawMenu() {
  dim(0.9);   // 시안은 뒤를 흐리게 깔았다. 캔버스 흐림은 사파리에서 무거워서 더 어둡게만
  const m = view.mobile, best = allTimeBest(), streak = playStreak(), coins = loggedIn() ? wallet.coins : null, t = teamById(settings.team), gold = '#f2c94c';
  // 묶음: [제목, 줄들]. 줄은 [아이콘, 이름, 오른쪽 값, 누르면, 단추 이름(없으면 이름. 테스트가 이 이름으로 누른다), 꼬리표]
  const groups = [
    ['놀기', [['scn', '끝내기 상황', '9회말 역전 승부', () => startGame('scenario')], ['practice', '연습', '구종 골라 치기', () => startGame('practice')],
      ['aim', '조준 타격', '공을 겨눠 치기', () => startGame('challenge', false, { aim: true }), '조준 타격(실험)', '실험']]],
    ['기록', [['rec', '기록', best > 0 ? `역대 최고 ${best.toLocaleString()}` : '아직 없음', () => { game.state = 'records'; }],
      ['titles', '칭호', `${myTitles().length} / ${TITLES.length}`, () => { game.state = 'titles'; }, '칭호'], ['rank', '이번 주 랭킹', '내 순위 보기', () => openRanking('title')]]],
    ['내 것', [['team', '팀·닉네임', `${t ? t.short : '팀 없음'} · ${settings.nick || '-'}`, () => openOnboard('menu')],
      ['shop', '상점 · 내 물건', coins != null ? `코인 ${coins.toLocaleString()}` : '물건 구경', () => openShop('shop')],
      loggedIn() ? ['me', '내 계정', '카카오 로그인됨', openAccount] : ['me', '카카오 로그인', '랭킹에 이름 올리기', openAccount]]],
    ['설정', [['calib', '타이밍 보정', fmtMs(settings.offset), startCalib, `타이밍 보정 ${fmtMs(settings.offset)}`],
      ...(canVibrate ? [['vib', '진동', settings.vibrate ? '켜짐' : '꺼짐', toggleVibrate, settings.vibrate ? '진동 켜짐' : '진동 꺼짐']] : [])]],
  ];
  const L = menuLayout(groups), c = L.c, { x0, W } = L;
  menu.max = L.max; menu.scroll = clamp(menu.scroll, 0, menu.max);
  let y = c.top - menu.scroll;
  // 내 정보 카드: 팀 배지(팀 색), 닉네임, 칩(최고 기록·연속 기록 2일부터·코인), 오른쪽 닫기
  const hh = c.headPad * 2 + c.badge, team = t ? t.main : '#24314a', bg = ctx.createLinearGradient(x0, y, x0 + W, y + hh * 0.4);
  bg.addColorStop(0, hexAlpha(team, 0.55)); bg.addColorStop(0.55, 'rgba(20,26,40,0.9)'); bg.addColorStop(1, 'rgba(20,26,40,0.9)');
  roundRect(x0, y, W, hh, 16); ctx.fillStyle = bg; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
  const bx = x0 + c.headPadX, by = y + c.headPad, xs = 40, close = { x: x0 + W - c.headPadX - xs, y: y + hh / 2 - xs / 2, w: xs, h: xs };
  ctx.save(); roundRect(bx, by, c.badge, c.badge, 12); ctx.fillStyle = team; ctx.fill(); ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(bx, by + c.badge - 4, c.badge, 4); ctx.restore();   // 배지 아래쪽 그늘
  text(t ? t.short : '?', bx + c.badge / 2, by + c.badge / 2 + 1, { size: c.badgeFont, weight: 900 });
  const tx = bx + c.badge + (m ? 11 : 14), soft = 'rgba(255,255,255,0.85)', chips = [];
  const wb = weekBest();   // 이번 주(랭킹과 같은 숫자)와 역대(이 기기) 최고를 둘 다
  if (wb != null) chips.push([['이번 주 ', soft], [wb.toLocaleString(), gold]]);
  if (best > 0) chips.push([['역대 ', soft], [best.toLocaleString(), gold]]);
  if (streak >= 2) chips.push([[String(streak), gold], ['일 연속', soft]]);
  if (coins != null) chips.push([['코인 ', soft], [coins.toLocaleString(), gold]]);
  const top = titleById(topTitle(myTitles())), bw = top ? titleBadgeW(top.short, c.chip) + 8 : 0;   // 대표 칭호는 닉네임 옆 금색 배지(닉네임이 길면 줄인다)
  ctx.font = font(c.nick, 800);
  const nick = fitText(settings.nick || '-', close.x - 10 - tx - bw), nickY = chips.length ? by + c.badge * 0.3 : by + c.badge / 2;
  text(nick, tx, nickY, { size: c.nick, weight: 800, align: 'left' });
  if (top) { ctx.font = font(c.nick, 800); titleBadge(tx + ctx.measureText(nick).width + 8, nickY, top.short, c.chip); }
  ctx.font = font(c.chip, 700);
  const chipW = (parts) => parts.reduce((s, [str]) => s + ctx.measureText(str).width, 0) + (c.chip > 11 ? 18 : 14) + 6;
  const si = chips.findIndex((x) => x[1][0] === '일 연속');
  if (si >= 0 && chips.reduce((s, x) => s + chipW(x), tx) > close.x - 2) chips.splice(si, 1);   // 한 줄을 넘치면 연속 기록 칩부터 뺀다
  let chipX = tx;
  for (const parts of chips) {   // 닫기 단추 앞까지만
    ctx.font = font(c.chip, 700);
    if (chipX + chipW(parts) > close.x - 2) break;
    chipX += drawMenuChip(chipX, by + c.badge * 0.75, parts, c.chip) + 6;
  }
  ctx.beginPath(); ctx.arc(close.x + xs / 2, close.y + xs / 2, xs / 2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
  menuIcon('close', close.x + 10, close.y + 10, 20, '#ffffff');
  ui.buttons.push({ r: close, label: '닫기', onTap: goTitle });
  y += hh + c.newsGap;
  // 새 소식 띠: 맨 위 소식의 날짜와 첫 줄(넘치면 …), 안 읽었으면 NEW. 누르면 새 소식
  const nr = { x: x0, y, w: W, h: c.newsH }, nx0 = nr.x + (m ? 12 : 14), ny = nr.y + nr.h / 2, arrowX = nr.x + nr.w - (m ? 12 : 14), ng = ctx.createLinearGradient(nr.x, 0, nr.x + nr.w, 0);
  ng.addColorStop(0, 'rgba(255,77,77,0.24)'); ng.addColorStop(1, 'rgba(255,77,77,0.05)');
  roundRect(nr.x, nr.y, nr.w, nr.h, 12); ctx.fillStyle = ng; ctx.fill(); ctx.strokeStyle = 'rgba(255,77,77,0.5)'; ctx.stroke();
  let nx = nx0 + (newsUnread() ? drawNewBadge(nx0, ny) + 10 : 0);
  text('새 소식', nx, ny + 0.5, { size: c.newsFont, weight: 800, align: 'left' });
  nx += ctx.measureText('새 소식').width + 10;
  text('›', arrowX, ny, { size: c.newsFont + 6, weight: 700, color: 'rgba(255,255,255,0.5)', align: 'right' });
  if (NEWS.length) { ctx.font = font(c.newsFont, 500); text(fitText(`${NEWS[0].label} · ${NEWS[0].items[0]}`, arrowX - 16 - nx), nx, ny + 0.5, { size: c.newsFont, weight: 500, color: 'rgba(255,255,255,0.7)', align: 'left' }); }
  ui.buttons.push({ r: nr, label: '새 소식', onTap: openNews });
  y += nr.h + c.newsGap;
  // 의견 보내기 띠: 새 소식 띠 바로 아래(2026-11-05 사용자 결정 '의견을 많이 받는 것이 목적이라 위쪽에'. 메뉴 맨 아래 줄은 작은 폰에서 끌어야 보였다).
  // 말풍선 아이콘·이름·만든 사람 한마디(FEEDBACK_NOTE), 오른쪽 끝은 바깥 화살표. 누르면 패들렛을 새 탭으로
  const fr = { x: x0, y, w: W, h: c.newsH }, fy = fr.y + fr.h / 2, fis = c.newsFont + 4, fgr = ctx.createLinearGradient(fr.x, 0, fr.x + fr.w, 0);
  fgr.addColorStop(0, 'rgba(80,170,255,0.24)'); fgr.addColorStop(1, 'rgba(80,170,255,0.05)');
  roundRect(fr.x, fr.y, fr.w, fr.h, 12); ctx.fillStyle = fgr; ctx.fill(); ctx.strokeStyle = 'rgba(120,190,255,0.5)'; ctx.stroke();
  menuIcon('voice', nx0, fy - fis / 2, fis, '#8cc8ff');
  let fx = nx0 + fis + 8;
  text('의견 보내기', fx, fy + 0.5, { size: c.newsFont, weight: 800, align: 'left' });
  fx += ctx.measureText('의견 보내기').width + 10;
  menuIcon('out', arrowX - fis + 2, fy - fis / 2 + 1, fis - 2, '#8cc8ff');
  const noteW = arrowX - fis - 8 - fx, note = FEEDBACK_NOTE.join(' '), noteColor = 'rgba(255,255,255,0.7)';
  ctx.font = font(c.newsFont, 500);
  if (ctx.measureText(note).width <= noteW) text(note, fx, fy + 0.5, { size: c.newsFont, weight: 500, color: noteColor, align: 'left' });
  else {   // 폰: 두 줄(낮은 띠 30px에도 위아래 3px씩 남는다). 문장마다 한 줄이고, 그래도 넘치면(폴드 덮개 화면 344px) 낱말로 나눈다
    const ns = c.newsFont - 2, lh = ns + 2;
    ctx.font = font(ns, 500);
    let lines = FEEDBACK_NOTE;
    if (lines.some((ln) => ctx.measureText(ln).width > noteW)) { const ws = wrapWords(note, noteW); lines = [ws[0], ws.slice(1).join(' ')]; }
    lines.forEach((ln, i) => text(fitText(ln, noteW), fx, fy + 0.5 + (i - 0.5) * lh, { size: ns, weight: 500, color: noteColor, align: 'left' }));
  }
  ui.buttons.push({ r: fr, label: '의견 보내기', href: FEEDBACK_URL });
  y += fr.h;
  // 묶음: 금색 제목과 줄들
  const colW = (W - c.colGap * (L.cols.length - 1)) / L.cols.length;
  let bottom = y;
  L.cols.forEach((col, ci) => {
    const cx = x0 + ci * (colW + c.colGap);
    let cy = y;
    for (const [title, rows] of col) {
      cy += c.h3Top;
      text(title, cx + 4, cy + c.h3Font / 2, { size: c.h3Font, weight: 800, color: gold, align: 'left' });
      cy += c.h3Font + c.h3Bottom;
      for (const [icon, name, value, onTap, label = name, tag] of rows) {
        const r = { x: cx, y: cy, w: colW, h: L.rowH };
        drawMenuRow(r, icon, name, value, c, tag);
        ui.buttons.push({ r, label, onTap });
        cy += L.rowH + c.gap;
      }
    }
    bottom = Math.max(bottom, cy);
  });
  text('판 수만 익명으로 세고, 이름·계정은 보내지 않아요', view.w / 2, bottom + c.foot / 2, { size: c.footFont, weight: 500, color: 'rgba(255,255,255,0.42)' });   // 이용 통계(track) 안내
  // 넘치면 아래에 더 있을 때 아래 가장자리를, 위로 넘겼을 때 위 가장자리를 흐리게 한다(끝까지 넘기면 사라진다)
  menu.fade = { top: menu.max > 0 && menu.scroll > 0.5, bottom: menu.max > 0 && menu.scroll < menu.max - 0.5 };
  for (const [on, y0, y1] of [[menu.fade.top, 0, MENU_FADE], [menu.fade.bottom, view.h, view.h - MENU_FADE]]) {
    if (!on) continue;
    const fg = ctx.createLinearGradient(0, y0, 0, y1);
    fg.addColorStop(0, 'rgba(4,9,18,0.95)'); fg.addColorStop(1, 'rgba(4,9,18,0)');
    ctx.fillStyle = fg; ctx.fillRect(0, Math.min(y0, y1), view.w, MENU_FADE);
  }
  if (menu.max > 0) {   // 넘치면 오른쪽에 위치 막대
    const barH = Math.max(30, view.h * view.h / (view.h + menu.max)), barY = (view.h - barH) * (menu.scroll / menu.max);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(view.w - 5, 0, 3, view.h);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(view.w - 5, barY, 3, barH);
  }
}

// 바깥 사이트 링크 한 줄(파란 글자·밑줄 + 바깥 화살표, 가운데 cx). 누르는 자리(높이 30px)를 돌려준다
function drawOutLink(label, cx, cy, size) {
  ctx.font = font(size, 700);
  const tw = ctx.measureText(label).width, is = size + 2, w = tw + 5 + is, x = cx - w / 2, color = '#8cc8ff';
  text(label, x, cy, { size, weight: 700, color, align: 'left' });
  ctx.fillStyle = 'rgba(140,200,255,0.45)'; ctx.fillRect(x, cy + size * 0.75, tw, 1);
  menuIcon('out', x + tw + 5, cy - is / 2 - 1, is, color);
  return { x: x - 10, y: cy - 15, w: w + 20, h: 30 };
}

// [좌타 | 우타] 고르기. cy는 버튼 세로 가운데
function drawBatsToggle(cy) {
  const w = view.mobile ? 84 : 96, h = 38;
  rowRects(view.w / 2, cy - h / 2, w * 2 + 6, h, 2, 6).forEach((r, i) => {
    const b = i === 0 ? 'L' : 'R';
    addButton(r, b === 'L' ? '좌타' : '우타', settings.bats === b ? 'chipOn' : 'chip', () => setBats(b));
  });
}

// 끝 화면의 '새 칭호' 띠: 위 전광판 바로 아래에 띄워 끝 화면 줄들을 밀지 않는다(로그인했으면 서버 답 뒤에 떠서, 줄을 끼우면 아래 단추가 늦게 밀렸다.
// 작은 폰은 끝 화면 아래가 주소와 6px뿐이라 줄을 더할 자리도 없다)
function drawNewTitles() {
  const names = titleNames(game.newTitles ?? []);
  if (!names.length) return;
  // 폰은 작은 화면(375×548)에서 끝 화면 머리 글자와 닿지 않게 조금 작게, 전광판에 붙여 둔다
  const m = view.mobile, L = boardLayout(), y = L.py + L.ph + (m ? 18 : 28), str = `새 칭호: ${names.join(' · ')}!`, size = m ? 13 : 17;
  ctx.font = font(size, 800);
  const w = Math.min(view.w - 24, ctx.measureText(str).width + 30), h = size + (m ? 11 : 14);
  roundRect(view.w / 2 - w / 2, y - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(28,22,6,0.88)'; ctx.fill();
  ctx.strokeStyle = 'rgba(242,201,76,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
  text(str, view.w / 2, y + 1, { size, weight: 800, color: '#f2c94c' });
}
function drawGameOver() {
  dim(0.72);
  drawSiteMark();
  if (game.mode === 'scenario') { drawScenarioOver(); return; }
  if (!game.aim) drawNewTitles();
  const m = view.mobile, cx = view.w / 2, s = game.summary;
  let y = view.h * 0.19;
  // 조준 판은 의견 보내기 줄만큼 길어서, 낮은 화면(사파리 375×548)에서는 '처음으로' 밑줄이 아래 주소(drawSiteMark)와 8px 떨어지게 30px까지 당겨 올린다
  if (game.aim) y -= clamp(y + (m ? 466 : 529) - view.h, 0, 30);
  const streak = playStreak();   // 며칠 이어서 쳤는지(2일부터). 점수 줄은 코인까지 붙어 길어서 제목 옆에 둔다
  text(game.aim ? '조준 타격(실험)' : `10구 도전${streak >= 2 ? ` · ${streak}일 연속` : ''}`, cx, y, { size: m ? 17 : 21, color: 'rgba(255,255,255,0.75)' });
  y += m ? 54 : 70;
  text(s.score.toLocaleString(), cx, y, { size: m ? 56 : 80, weight: 900, color: '#f2c94c', shadow: true });
  y += m ? 50 : 64;
  // 조준 판은 이 기기 조준 최고 기록(walkoff.aimBest). 10구는 로그인했으면 계정 역대 최고, 서버 답을 기다리면 '확인 중'(startBest)
  const best = game.mode === 'challenge', kind = game.aim ? '조준 최고 기록' : '최고 기록';
  const bestText = game.newBest ? `새 ${kind}!` : game.best != null ? `${kind} ${game.best.toLocaleString()}점` : game.bestWait ? `${kind} 확인 중…` : rankOf(s.score);
  text((best ? bestText : rankOf(s.score)) + coinNote(), cx, y,
    { size: m ? 18 : 22, color: best && game.newBest ? '#f2c94c' : '#fff' });
  y += m ? 40 : 50;
  const lights = s.lights.split(''), lg = Math.min(m ? 30 : 36, (m ? view.w - 70 : 520) / Math.max(1, lights.length - 1));
  lights.forEach((c, i) => drawMark(cx + (i - (lights.length - 1) / 2) * lg, y, Math.min(m ? 10 : 12, lg * 0.36), c));
  y += m ? 36 : 44;
  text(`홈런 ${s.hr} · 안타 ${s.hits} · 볼 ${s.balls}${s.far ? ` · 가장 멀리 ${s.far}m` : ''}`, cx, y, { size: m ? 14 : 17, weight: 600, color: 'rgba(255,255,255,0.85)' });
  y += m ? 38 : 48;
  const bw = m ? view.w - 48 : 340;
  if (game.aim) {   // 실험판 안내와 의견 보내기 링크(패들렛, 새 탭)
    text('실험판이라 랭킹·코인·연속 기록에는 안 올라가요', cx, y, { size: m ? 13 : 15, weight: 600, color: 'rgba(255,255,255,0.6)' });
    y += m ? 24 : 28;
    const label = '조준 타격 어땠나요? 의견 보내기';
    ui.buttons.push({ r: drawOutLink(label, cx, y, m ? 14 : 16), label, href: FEEDBACK_URL });
    y += m ? 28 : 34;
  } else if (game.mode === 'challenge' && settings.team) {   // 이번 주 최고 기록 한 줄. 누르면 랭킹 화면(로그인 안 했으면 카카오 로그인)
    const lw = Math.min(view.w - 32, 420);
    addButton({ x: cx - lw / 2, y: y - 14, w: lw, h: 30 }, rankLine(), 'link', () => (loggedIn() ? openRanking('over') : startKakaoLogin()));
    y += m ? 30 : 36;
  }
  drawBatsToggle(y + 19);
  y += 38 + 18;
  if (game.aim) {   // 조준 판은 공유하지 않는다
    addButton({ x: cx - bw / 2, y, w: bw, h: 48 }, '다시 하기', 'primary', restartGame);
    addButton({ x: cx - 70, y: y + 58, w: 140, h: 36 }, '처음으로', 'link', goTitle);
  } else drawRetryShareButtons(y, bw, restartGame);
}

// ===== 게임 진행 =====
// 판 상태(game)는 game/state.js. title → windup(투수 와인드업) → pitch(공이 날아옴) → result → 다음 공 … → over

// 주소 끝 ?seed=숫자(infra/seeds.js의 urlSeed)가 있으면 그 시드, 없으면 지금 시각으로
const seedFromUrl = () => urlSeed() ?? (Date.now() % 2147483647);

// mode: 'challenge'(10구 도전, 매번 다른 공) | 'scenario'(끝내기 상황) | 'practice'(연습). opts.aim이면 10구 규칙의 조준 타격(실험)
// 로그인한 10구 도전은 서버가 내준 시드로 친다. 받아 둔 것이 없으면(막 열었을 때) 받을 때까지 잠깐 기다리고, 그동안 누른 것은 받지 않는다
function startGame(mode, waited = false, opts = {}) {
  const aim = mode === 'challenge' && !!opts.aim;   // 조준 판은 랭킹에 안 올라가서 서버 시드가 필요 없다
  const ranked = (mode === 'challenge' || mode === 'scenario') && loggedIn() && urlSeed() == null && !aim;   // 끝내기 상황도 서버 시드로 쳐야 코인을 받는다(2026-11-04)
  if (ranked && !waited && prefetchSeed() && !seedTicket.ready) {   // prefetchSeed는 받아 둔 것이 없거나 오래됐으면 새로 받기 시작한다
    const from = game.state, slow = setTimeout(() => toast('공을 받는 중…'), 400);
    game.waitingSeed = true;
    Promise.race([seedTicket.loading, new Promise((done) => setTimeout(done, SEED_WAIT_MS))]).then(() => {
      clearTimeout(slow);
      game.waitingSeed = false;
      if (game.toast?.text === '공을 받는 중…') game.toast = null;
      if (game.state === from) startGame(mode, true, opts);   // 기다리는 동안 다른 화면으로 갔으면 시작하지 않는다
    });
    return;
  }
  game.mode = mode;
  game.aim = aim; game.aims = [];
  game.ticket = ranked ? takeSeedTicket() : null;
  game.fixedSeed = mode === 'challenge' && urlSeed() != null;
  game.seed = game.ticket?.seed ?? seedFromUrl();
  Object.assign(game, { i: 0, score: 0, results: [], summary: null, newBest: false, scn: null, scnEvent: '', left: mode === 'challenge' ? CHANCES : 0, extra: 0, recorded: false, moves: [], scnCoin: null });
  game.throws = pitcherHand(game.seed);
  game.opponent = pickOpponent(game.seed);
  game.rankInfo = null;
  game.skipHint = takeSkipHint();
  game.aimHint = aim && takeAimHint();
  if (mode === 'scenario') {
    game.rnd = mulberry32(game.seed);
    game.scn = makeScenario(game.rnd);
    game.seq = [];
    game.seq.push(nextScenarioPitch());
  } else if (mode === 'practice') {
    game.rnd = mulberry32(game.seed);
    const saved = store.get('practice', {});
    game.practice = { type: PRACTICE_TYPES.includes(saved.type) ? saved.type : 'fastball', slow: !!saved.slow, throws: saved.throws === 'L' ? 'L' : 'R', swings: 0, perfect: 0, sumAbs: 0 };
    game.throws = game.practice.throws;
    game.seq = [];
    game.seq.push(nextPracticePitch());
  } else game.seq = makeSequence(game.seed, game.throws === 'L');
  startPitch();
  track('start', game.aim ? 'aim' : game.mode);
}
// 지금 판과 같은 모드로 처음부터(조준 판이면 조준 판으로)
const restartGame = () => startGame(game.mode, false, { aim: game.aim });

function startPitch() {
  Object.assign(game, { state: 'windup', t: -0.5, swingAt: null, outcome: null, gained: 0, resultT: 0, flightT: 0, contactPos: null, burst: null, mittDone: false, replay: null, replayed: false });
  game.lastChance = game.mode !== 'scenario' && game.left === 1;
}

function goTitle() { Object.assign(game, { state: 'title', t: 0, resultT: 0, outcome: null, swingAt: null, replay: null }); }

const ballTime = () => game.t - WINDUP;

// ===== 조준 타격(실험, 2026-11-05 사용자 아이디어·결정, 계획 ~/.claude/plans/piped-bouncing-bird.md) =====
// 메뉴 '조준 타격(실험)'은 10구 도전과 같은 규칙인데(game.mode 'challenge', game.aim) 타이밍과 함께 공이 지나는 자리를 겨눠야 한다.
// PC는 마우스로 겨누고 클릭(스페이스바는 마지막 마우스 자리, 움직인 적이 없으면 맞는 자리가 존 가운데)으로, 폰은 끌어 맞춘 뒤 떼는 순간 친다(손가락 하나만,
// 와인드업 중에 떼면 아무 일도 없고, 안 떼면 지켜본 공). PC·폰 모두 누른 자리가 배트 손잡이 끝이다(AIM_BAT). 과녁은 배트 축을 따라 잰 타원(m, 판정은 core AIM).
// 랭킹·서버 시드·연속 기록·최고 기록·코인·공유에는 넣지 않고 이 기기 조준 최고 기록(walkoff.aimBest)만 남긴다. 통계는 모드 'aim'으로 센다
// 과녁(m): 배트 축을 따라 x, 축에 수직으로 y. 마우스·터치를 따로 맞출 수 있게 나눠 둔다(처음엔 같다).
// 세로는 2026-11-05 사용자 '아직 너무 어렵다' → 1.5배(0.06 → 0.09)
// 2026-11-05 저녁 사용자 '조준 타격은 절대 못 친다, 너무 어렵다, 배트를 더 굵게' → 가로 1.5배·세로 2배(0.10·0.09 → 0.15·0.18). 그날 조준 판은
// 폰 117번 휘둘러 안타 8%(과녁 밖 83%), 마우스 29번에 17%였다(그냥 10구는 폰 78%·마우스 50%). 가운데 몫(core AIM.sweet)은 그대로
const AIM_RADIUS = { mouse: { x: 0.15, y: 0.18 }, touch: { x: 0.15, y: 0.18 } };
// 배트 커서(2026-11-05 사용자가 쳐 보고 '원 말고 배트 모양으로'. 그린 공은 쳐야 할 때보다 0.1초쯤 먼저 네모에 닿아서 네모를 신호로 치면 늦었다).
// 칠 자리 깊이(홈플레이트 앞면)에 그린다. 2026-11-05 저녁 사용자 결정('폰은 그전 배트 모양, 칠 자리에 비스듬히 누운 진짜 배트가 훨씬 좋았다. 지금은 위로
// 치우쳐 있다. PC도 마우스가 배트 잡는 곳에 가야'): PC·폰 모두 누른 자리(마우스·손가락)가 손잡이 끝이고, 배트는 손잡이에서 타자 반대쪽(우타 오른쪽, 좌타 왼쪽)으로
// 거의 옆으로 눕는다. 맞는 자리(굵은 쪽)가 낮을수록 굵은 쪽이 내려간다(존 위끝 위로는 high도, 존 아래끝에서 0.1m 아래부터는 low도. 진짜 스윙처럼).
// 손잡이에서 맞는 자리까지는 칠 자리 깊이의 reach m(폰 390 폭 100px쯤, PC 1440 폭 155px쯤, 실제 배트 0.70m의 반쯤)이고 맞는 자리 너머로 tip m 더 그린다.
// 굵기(wa 손잡이, wb 굵은 쪽)는 줄인 길이에 맞추되 작은 화면에서 보이게 실제 비율보다 조금 굵다.
// 실제 크기면 폰에서 존 왼쪽 공을 칠 때 손가락이 화면 밖으로 나갔다(360 폭에서도 존 네 모서리 공을 손가락이 화면 안인 채로 친다, 테스트가 본다).
// 전에는 PC는 맞는 자리가 마우스인 실제 크기 배트(15도), 폰은 손가락에서 위로 45도 100px였다
const AIM_BAT = { reach: 0.38, tip: 0.09, wa: 0.022, wb: 0.044, high: 2, low: 25 }, AIM_ZONE_ALPHA = 0.45;   // 조준 판의 존(네모)은 흐리게(볼·스트라이크는 보일 만큼)
// 칠 자리 깊이의 축척(1m가 몇 px인지)과 화면 y의 높이(m)
const aimScale = () => project(0, 0.8, 0);
const aimHeight = (y) => { const z = aimScale(); return z ? 0.8 + (z.y - y) / z.s : 0.8; };
// 맞는 자리 높이 h(m)에서 굵은 쪽이 수평에서 내려간 각(도)
const aimTilt = (h) => lerp(AIM_BAT.high, AIM_BAT.low, clamp((ZONE.top - h) / (ZONE.top - ZONE.bottom + 0.1), 0, 1));
// 배트 축(맞는 자리 → 손잡이, 단위 벡터, 위가 +)과 축에 수직인 위쪽. t는 굵은 쪽이 내려간 각(도)
function aimAxes(t = AIM_BAT.high) {
  const sd = batSide(), a = t * DEG;
  return { d: { x: -sd * Math.cos(a), y: Math.sin(a) }, n: { x: sd * Math.sin(a), y: Math.cos(a) } };
}
// 배트 커서의 손잡이 끝·배트 끝(화면 px). at은 맞는 자리({ x, y, kind, t }, t가 없으면 그 높이로 정한다), s는 그 깊이에서 1m가 몇 px인지
function aimBatPoints(at) {
  const z = aimScale(), s = z ? z.s : 0, { d } = aimAxes(at.t ?? aimTilt(aimHeight(at.y))), k = AIM_BAT.reach * s;
  return { knob: { x: at.x + d.x * k, y: at.y - d.y * k, s }, tip: { x: at.x - d.x * AIM_BAT.tip * s, y: at.y + d.y * AIM_BAT.tip * s, s }, s };
}
// 누른 자리(손잡이 끝, 화면 px)에서 맞는 자리와 기울기. 기울기가 맞는 자리 높이로 정해져서 몇 번 고쳐 맞춘다(한 번에 오차가 5분의 1 아래로 준다)
function gripSpot(x, y, kind = 'touch') {
  const L = AIM_BAT.reach * (aimScale()?.s ?? 0);
  let t = AIM_BAT.high, at = { x, y };
  for (let i = 0; i < 6; i++) { const { d } = aimAxes(t); at = { x: x - d.x * L, y: y + d.y * L }; t = aimTilt(aimHeight(at.y)); }
  return { ...at, kind, t };
}
// 맞는 자리(화면 px)를 치려면 누를 자리(손잡이 끝). 테스트가 쓴다
const aimGripFor = (x, y) => aimBatPoints({ x, y }).knob;
const aimPointer = { x: 0, y: 0, moved: false, touch: null };   // 마우스가 있는 자리, 누르고 있는 손가락 { id, x, y }
// 지금 커서(맞는 자리, 화면 px)와 과녁 종류(touch면 터치 과녁)
function aimCursor() {
  if (aimPointer.touch) return gripSpot(aimPointer.touch.x, aimPointer.touch.y, 'touch');
  if (aimPointer.moved) return gripSpot(aimPointer.x, aimPointer.y, 'mouse');
  const c = project(0, (ZONE.top + ZONE.bottom) / 2, 0);
  return { x: c.x, y: c.y, kind: 'mouse', t: aimTilt((ZONE.top + ZONE.bottom) / 2) };
}
// 커서(배트 맞는 자리)와 공이 지나는 자리(홈플레이트 앞면의 p.tx·p.ty, 지금 화면 밀기 그대로)의 차이를 그 깊이의 m로 바꿔, 배트 축을 따라 R.x·
// 축에 수직으로 R.y인 기운 타원으로 나눈다. x·y는 판정에 넘길 과녁 비율(y는 축에 수직인 위쪽 +, 발사각에 쓴다), dx·dy는 화면 쪽 m(오른쪽·위 +, 이유 글),
// wx·wy는 겨눈 자리, t는 그때 배트 기울기(다시 보기·결과 화면에 같은 배트를 그린다)
function aimFrom(at, p) {
  const c = project(p.tx, p.ty, 0), R = AIM_RADIUS[at.kind === 'touch' ? 'touch' : 'mouse'], t = at.t ?? aimTilt(aimHeight(at.y));
  const dx = (at.x - c.x) / c.s, dy = (c.y - at.y) / c.s, { d, n } = aimAxes(t);
  return { x: (dx * d.x + dy * d.y) / R.x, y: (dx * n.x + dy * n.y) / R.y, dx, dy, wx: p.tx + dx, wy: p.ty + dy, kind: at.kind, t };
}

// 배트 그림자 모양(손잡이 끝 a → 배트 끝 b, 굵기 wa → wb): 둥근 손잡이 끝, 가는 손잡이가 굵은 쪽으로 굵어지고 끝은 둥글다.
// 한 바퀴 선 하나라서 반투명으로 칠해도 겹친 데가 진해지지 않는다
function batShadowPath(a, b, wa, wb) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, ang = Math.atan2(uy, ux);
  // 손잡이 끝에서 배트 끝까지의 비율과 굵기: 0.38까지 손잡이, 0.72까지 부드럽게 굵어진다
  const prof = [[0, wa], ...Array.from({ length: 7 }, (_, i) => { const k = i / 6; return [0.38 + 0.34 * k, wa + (wb - wa) * k * k * (3 - 2 * k)]; }), [1, wb]];
  const pt = (u, w, side) => [a.x + ux * len * u - uy * w / 2 * side, a.y + uy * len * u + ux * w / 2 * side];
  const path = new Path2D();
  prof.forEach(([u, w], i) => (i ? path.lineTo(...pt(u, w, 1)) : path.moveTo(...pt(u, w, 1))));
  path.arc(b.x, b.y, wb / 2, ang + Math.PI / 2, ang - Math.PI / 2, true);
  for (let i = prof.length - 2; i >= 0; i--) path.lineTo(...pt(prof[i][0], prof[i][1], -1));
  path.arc(a.x, a.y, wa / 2, ang - Math.PI / 2, ang + Math.PI / 2, true);
  path.closePath();
  return path;
}
// 배트 커서(2026-11-05 사용자 '배트 그림자만 떠야 한다. 다 그려지니 어지럽다'): 한 색 반투명 그림자이고 맞는 자리 둘레(배트 축으로 과녁 rx만큼)만
// 조금 밝다. 상점 배트 무늬·효과는 쓰지 않는다(PC·폰 같다)
// 맞는 범위(2026-11-05 저녁 사용자 결정 '맞는 범위를 흐린 띠로'): 판정 타원(배트 축으로 rx, 수직으로 ry, aimFrom과 같은 크기)을 맞는 자리를 가운데로
// 반투명하게 깔고, 그 안의 가운데 몫(AIM.sweet, 정타가 나는 곳)은 조금 더 밝게 한 뒤 배트 그림자를 위에 그린다. 그림자 흐림(shadowBlur)은 쓰지 않는다(사파리에서 무겁다)
function aimBand(at, s, ang) {
  const R = AIM_RADIUS[at.kind === 'touch' ? 'touch' : 'mouse'];
  ctx.beginPath(); ctx.ellipse(at.x, at.y, R.x * s, R.y * s, ang, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(225,235,250,0.14)'; ctx.fill();
  ctx.strokeStyle = 'rgba(225,235,250,0.32)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(at.x, at.y, R.x * s * AIM.sweet, R.y * s * AIM.sweet, ang, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
}
function drawAimBat(at, alpha = 1) {
  const { knob, tip, s } = aimBatPoints(at);
  if (!s) return;
  const path = batShadowPath(knob, tip, AIM_BAT.wa * s, AIM_BAT.wb * s), len = Math.hypot(tip.x - knob.x, tip.y - knob.y) || 1, ux = (tip.x - knob.x) / len, uy = (tip.y - knob.y) / len;
  const r = AIM_RADIUS[at.kind === 'touch' ? 'touch' : 'mouse'].x * s, glow = ctx.createLinearGradient(at.x - ux * r, at.y - uy * r, at.x + ux * r, at.y + uy * r);
  glow.addColorStop(0, 'rgba(255,255,255,0)'); glow.addColorStop(0.5, 'rgba(255,255,255,0.42)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save(); ctx.globalAlpha = alpha;
  aimBand(at, s, Math.atan2(uy, ux));
  ctx.fillStyle = 'rgba(225,235,250,0.4)'; ctx.fill(path);
  ctx.clip(path);
  ctx.fillStyle = glow; ctx.fillRect(Math.min(knob.x, tip.x) - s, Math.min(knob.y, tip.y) - s, Math.abs(tip.x - knob.x) + 2 * s, Math.abs(tip.y - knob.y) + 2 * s);
  ctx.restore();
}
// 조준 판: 투구 중에는 배트 커서(PC는 마우스 자리, 폰은 누르고 있을 때만), 결과·다시 보기에서는 겨눈 배트와 공이 지난 자리를 점선으로 잇는다
const finePointer = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
function drawAimLayer(p) {
  if (camMoved() || !p) return;
  if (game.state === 'windup' || game.state === 'pitch') { if (aimPointer.touch || finePointer) drawAimBat(aimCursor()); return; }
  const a = game.aims[game.i], at = a && game.state === 'result' ? project(a.wx, a.wy, 0) : null, c = at && project(p.tx, p.ty, 0);
  if (!c) return;
  ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(at.x, at.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.restore();
  drawAimBat({ x: at.x, y: at.y, kind: a.kind, t: a.t }, 0.8);
  ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(3, BALL_R * c.s), 0, Math.PI * 2); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();   // 공이 지난 자리
}

// input: 무엇으로 쳤는지('mouse'·'touch'·'key', 스윙 통계). at: 조준 판에서 휘두른 자리(화면 px, 없으면 지금 커서)
function swing(eventTime, input = 'key', at = null) {
  const p = game.seq[game.i];
  const bt = ballTime() + Math.max(0, (eventTime - game.clockAt) / 1000);
  game.swingAt = bt;
  const dtMs = Math.round((bt - p.T) * 1000 - settings.offset);
  if (game.mode === 'scenario') game.moves[game.i] = dtMs;
  const aim = game.aim ? aimFrom(at ?? aimCursor(), p) : null;
  if (aim) game.aims[game.i] = aim;
  const r = judgeSwing(p, dtMs, settings.bats, aim);
  if (game.mode === 'challenge') trackSwing(game.aim ? 'aim' : 'challenge', input, r);   // 10구는 지금 조작의 기준선
  if (game.mode === 'challenge' && r.hit) {   // 연속 홈런·연속 안타 보너스 중 큰 쪽 하나
    const hits = hitStreakBefore(game.i) + 1, hb = hitStreakBonus(hits);
    if (r.kind === 'hr') { r.streak = hrStreakBefore(game.i) + 1; r.streakBonus = hrStreakBonus(r.streak); }
    if (hb > (r.streakBonus ?? 0)) { r.streakBonus = 0; r.hitStreak = hits; r.hitBonus = hb; }
    r.points += (r.streakBonus ?? 0) + (r.hitBonus ?? 0);
  }
  if (r.kind === 'whiff') Sound.whoosh();
  else {
    game.contactPos = ballPos(p, bt / p.T);
    game.hitstop = r.kind === 'hr' ? 0.14 : 0.09;
    game.flash = 1;
    const bfx = fxOf(currentLook().bat);
    game.burst = BAT_BURSTS[bfx] ? { fx: bfx, t: 0, seed: (game.seed * 31 + game.i * 7919) >>> 0 } : null;
    view.shake = r.kind === 'hr' ? 12 : r.kind === 'foul' ? 3 : 3 + r.ev / 45;
    if (r.kind === 'foul') { Sound.foul(); buzz(15); } else { Sound.crack(clamp((r.ev - 80) / 100, 0, 1), currentLook().sound); buzz(r.kind === 'hr' ? [50, 40, 110] : 30); }
  }
  finish(r);
}

// 관중 함성·환호는 결과 글자가 뜨는 순간에 한 번(2026-11-02 사용자 결정 '결과 글자와 함께'). 전에는 맞은 0.3초 뒤에 나서 1루 간발도 결과가 미리 들렸다.
// 연속 홈런과 끝내기 승리는 끝내기만큼 크게
function celebrate(r) {
  const win = game.mode === 'scenario' && game.scn?.end === 'win';
  if (r.kind === 'hr' || win) { const big = win || r.streak >= 2; Sound.roar(big ? 3 : 2); cheerCrowd(big ? 3 : 2, big ? 3.5 : 3, 0); }
  else if (r.hit) { Sound.roar(1); cheerCrowd(1, 1.6, 0); }
}

function finish(r) {
  if (game.mode !== 'practice' && !game.aim) recordPitch(game.seq[game.i], r);   // 조준 판(실험)은 기록 화면의 구종별 기록에 섞지 않는다
  if (game.mode === 'practice') {
    game.gained = 0;
    const pr = game.practice;
    if (!r.took) { pr.swings++; pr.sumAbs += Math.min(Math.abs(r.dt), 300); if (r.perfect) pr.perfect++; }
  } else if (game.mode === 'scenario') {
    game.gained = scenarioPoints(r);   // 10구와 같은 점수(볼·연속 보너스·2배는 없다, core scenarioPoints)
    game.score += game.gained;
    game.scnBefore = JSON.parse(JSON.stringify(game.scn));   // 결과 글자 전까지는 공이 맞기 전 상황판을 그린다
    game.scnEvent = applyScenario(game.scn, r);
    game.scnWinT = game.scn.end === 'win' ? walkoffTime(r) : null;   // 끝내기 승리면 이긴 점수가 홈을 밟을 때 끝 화면으로(update)
  } else {
    game.gained = (r.points + (r.perfect ? PERFECT_BONUS : 0)) * (game.lastChance ? 2 : 1);
    game.score += game.gained;
    game.left -= 1;
    if (r.kind === 'ball') {
      game.extra++; game.left++; r.bonus = true; r.reason = '잘 골라냈어요 · 기회 +1';
    }
  }
  game.results[game.i] = r;
  game.outcome = r;
  game.state = 'result';
  game.resultT = 0; game.flightT = 0;
  game.revealAt = r.took ? 0.15 : r.kind === 'whiff' ? 0.3 : revealOf(r);   // 아웃은 잡거나 1루에 닿을 때, 안타는 떨어질 때(느린 화면이면 그만큼 늦게), 따라가는 타구는 카메라가 돌아올 때
  game.cheered = false;   // 안타 환호는 결과 글자와 함께(update)
  game.skipAt = null;
  if (r.kind === 'ball') setTimeout(() => Sound.ding(), 150);
  if (game.mode === 'challenge' && challengeOver()) recordGame();   // 마지막 기회를 쓰면 '결과 보기'를 누르기 전에 기록한다
}

// 10구 도전이 끝났는지: 기회를 다 썼거나 미리 만든 공을 다 썼다
const challengeOver = () => game.left <= 0 || game.i + 1 >= game.seq.length;

function next() {
  if (game.mode === 'practice') {
    game.i++;
    game.seq.push(nextPracticePitch());
    startPitch();
    return;
  }
  if (game.mode === 'scenario') {
    if (game.scn.end) { finishScenario(); return; }
    game.i++;
    game.seq.push(nextScenarioPitch());
    startPitch();
    return;
  }
  if (challengeOver()) { finishGame(); return; }
  game.i++;
  startPitch();
}

// 판을 기록한다: 요약, 연속 기록, 최고 기록, 랭킹 점수(코인은 서버가 준다), 통계 끝 신호. 한 판에 한 번만.
// 마지막 기회를 쓰는 순간 finish에서 부른다(2026-10-30 사용자 결정 '10구 다 치면 코인'). 전에는 '결과 보기'를 눌러야 기록돼서,
// 마지막 결과 화면에서 처음부터·Esc·창 닫기로 나가면 기회를 다 쓴 판의 점수·코인·연속 기록이 빠졌다
function recordGame() {
  if (game.recorded) return;
  game.recorded = true;
  game.summary = { ...gameSummary(), bats: settings.bats, date: today() };
  if (game.aim) {   // 조준 타격(실험): 연속 기록·최고 기록·랭킹·코인에 넣지 않고 이 기기 조준 최고 기록만
    const best = store.get('aimBest', 0);
    game.newBest = game.score > best;
    game.best = Math.max(best, game.score);
    if (game.newBest) store.set('aimBest', game.score);
  } else if (game.mode === 'challenge') {
    store.set('played.' + today(), 1);   // 끝까지 친 날(연속 기록)
    const best = store.get('best', 0);   // 이 기기 최고(로그아웃했을 때 메뉴·끝 화면이 쓴다)
    if (game.score > best) store.set('best', game.score);
    startBest(best);
    startTitles();
    if (!loggedIn() && !game.fixedSeed) setWeekBest(weekStartOf(game.summary.date), game.score);   // 로그인했으면 서버 답으로(submitScore)
    submitScore(game.summary, 'challenge');   // 10구 도전도 주간 최고 기록에 들어간다(매번 다른 공이라 외워서 칠 수 없다)
  }
  track('end', game.aim ? 'aim' : game.mode);
}
// 끝 화면 '최고 기록 N점'·'새 최고 기록!'과 공유 글·카드의 '새 최고 기록'(2026-11-05 사용자 결정 '계정 기준으로, 다음 push에 같이').
// 로그인했으면 메뉴 '역대'와 같은 계정 역대 최고(남겨 둔 accountBest.allTime)와 견주고, 판을 보낸 뒤 /scores 답의 allTime(이 판까지 넣은 값)으로
// 고친다. 다른 기기에서 더 높게 친 사람에게 '새 최고 기록!'이 뜨지 않게 하려는 것이다. 남겨 둔 값을 넘었거나 아직 모르면 서버 답까지
// '최고 기록 확인 중…'이고, 서버에 안 올라간 판(?seed=·거절·연결 실패)은 새 기록이라 하지 않는다. 로그인 안 했으면 이 기기 최고(walkoff.best)
function startBest(deviceBest) {
  const s = game.summary;
  if (!loggedIn()) {
    Object.assign(game, { newBest: s.score > deviceBest, best: Math.max(deviceBest, s.score), bestWait: false });
    s.newBest = game.newBest;
    return;
  }
  const prev = store.get('accountBest', null)?.allTime ?? null, below = prev != null && s.score <= prev;   // 남겨 둔 값 아래면 서버 답을 기다리지 않아도 새 기록이 아니다
  Object.assign(game, { prevBest: prev, newBest: false, best: below ? prev : null, bestWait: !below && !game.fixedSeed && !!settings.team });
  s.newBest = false;
}
// 서버 답으로 고친다. data는 받아들인 /scores 답이고, 거절·연결 실패·로그인 풀림이면 null(남겨 둔 값 그대로, 새 기록 아님)
function settleBest(s, data) {
  if (game.summary !== s) return;   // 그사이 새 판을 시작했다
  const prev = game.prevBest, was = s.newBest;
  if (data && data.allTime != null) Object.assign(game, { newBest: !!data.accepted && data.allTime === s.score && (prev == null || s.score > prev), best: data.allTime });
  game.bestWait = false;
  s.newBest = game.newBest;
  if (s.newBest !== was) prepareShareCard();   // 공유 카드의 '새 최고 기록!'도 고친다
}

function finishGame() {
  recordGame();
  Object.assign(game, { state: 'over', t: 0, resultT: 0, outcome: null, swingAt: null, replay: null });
  if (!game.aim) prepareShareCard();   // 조준 판은 공유하지 않는다
}

// 다시 보기는 타석 시점에서 본다. 전에는 파울공을 따라 돌아간 화면 그대로 재생해서 공이 안 보였다(2026-10-29 사용자 제보).
// 한 번 다시 보면 그 타구는 다시 따라가지 않는다
function startReplay() { if (game.outcome) { game.replay = 0; game.replayed = true; view.panX = view.panY = 0; } }

function hasBattedBall() { const r = game.outcome; return r && !r.took && r.kind !== 'whiff'; }

function update(dt) {
  const now = performance.now();
  view.shake = Math.max(0, view.shake - dt * 45);
  game.flash = Math.max(0, game.flash - dt * 8);
  if (game.burst) game.burst.t += dt;   // 효과 배트의 효과는 맞는 순간 멈춤 동안에도 터진다
  if (game.hitstop > 0) { game.hitstop -= dt; game.clockAt = now; return; }
  game.t += dt; game.clockAt = now;
  const p = game.seq[game.i];

  if (game.state === 'windup' && ballTime() >= 0) { game.state = 'pitch'; Sound.release(); }
  if (game.state === 'pitch' && game.swingAt == null && ballTime() > p.T + FOUL_MS / 1000) { if (game.mode === 'scenario') game.moves[game.i] = null; finish(judgeTake(p)); }
  if ((game.state === 'pitch' || game.state === 'result') && !hasBattedBall() && !game.mittDone && ballTime() > p.T * 1.05) {
    game.mittDone = true; Sound.mitt();
  }
  if (game.state === 'result') {
    game.resultT += dt;
    game.flightT += dt * (hasBattedBall() && game.replay == null ? fieldPlay(game.outcome).rate(game.flightT) : 1);   // 1루 간발은 느리게
    // 함성은 결과를 알릴 때. 카메라가 공 뒤로 날아가는 안타는 공이 떨어질 때(홈런은 관중석에 들어갈 때) 먼저 낸다(revealOf)
    const landCheer = game.replay == null && game.outcome?.hit && chaseable(game.outcome) && game.flightT >= chaseLand(game.outcome);
    if (!game.cheered && hasBattedBall() && (game.resultT > game.revealAt || landCheer)) { game.cheered = true; celebrate(game.outcome); }
    if (game.replay != null) {
      const was = game.replay;
      game.replay += dt * 0.5;
      // 다시 보기에서 배트가 공에 닿는 순간 효과를 다시 터뜨린다. 다시 보기는 맞은 직후 끝나서 효과는 제 빠르기로 끝까지 보여 준다
      if (game.burst && was < game.swingAt && game.replay >= game.swingAt) game.burst.t = 0;
      if (game.replay > p.T * 1.08) game.replay = null;
    }
    // 끝내기 승리는 이긴 점수가 홈을 밟는 순간 경기가 끝난다(2026-11-02 사용자 '끝내기 승리인데 안 끝난다'. 전에는 '결과 보기'를 눌러야 했다).
    // HIT·HOMERUN은 다 띄운 뒤에 끝낸다(2026-11-05. 전에는 끝내기 홈런이 공이 날아가는 중에 끝 화면이 돼서 HOMERUN이 안 나왔다)
    if (game.mode === 'scenario' && game.scnWinT != null && game.replay == null && game.flightT >= game.scnWinT && game.resultT > game.revealAt + 0.8
      && game.resultT >= (boardMoment()?.t1 ?? 0)) { finishScenario(); return; }
  }
  if (game.state === 'over' || game.state === 'title') game.resultT += dt;

  if (game.state === 'result' && hasBattedBall() && !game.replayed) followBall(cameraFocus(game.outcome, game.flightT), dt);   // 송구 때는 받는 사람 쪽으로 먼저 간다
  else { const k = Math.min(1, dt * 4); view.panX -= clamp(view.panX * k, -panCap(dt), panCap(dt)); view.panY -= view.panY * k; }
  chaseStep(dt);   // 홈런·큰 뜬공은 카메라가 공 뒤로 날아간다
}

// ===== 입력: 스페이스바, 클릭, 탭 =====
// 공이 날아가는 동안 누르면 결과가 나오는 순간(한 박자: 함성·HIT·결과 제목)으로 건너뛴다(2026-11-03 유저 보이스 '치고 날아가는 모션 스킵은 없나요,
// 떨어질 때까지 기다리기 힘들다', 사용자 결정 '탭하면 바로 결과'). 맞은 뒤 SKIP_GUARD초 동안은 받지 않는다(치면서 두 번 누르는 실수).
// 공·수비·주자는 모두 flightT로 그려서 flightT를 결과가 정해지는 때로 옮기면 그 자리로 간다. 놓친 장면은 '다시 보기'로 본다
// 결과가 나온 뒤(revealAt 뒤)에 누르면 전처럼 다음 공으로 간다. 카메라가 공 뒤로 날아가는 타구는 돌아온 뒤가 revealAt이라(revealOf),
// 따라가는 동안 누르면 결과부터 나온다(2026-11-05. 전에는 2.6초가 지나면 따라가는 중에도 한 번에 다음 공으로 가서 HOMERUN을 못 봤다)
const SKIP_GUARD = 0.4;
const beatAt = () => boardMoment()?.t0 ?? game.revealAt;   // 결과를 알리는 순간(안타·홈런은 전광판이 HIT·HOMERUN을 띄우는 때로 revealAt과 같다)
const canSkip = () => game.state === 'result' && hasBattedBall() && game.replay == null && game.resultT >= SKIP_GUARD && game.resultT < game.revealAt;
function skipToBeat() {
  game.resultT = Math.max(game.resultT, game.revealAt);
  game.flightT = Math.max(game.flightT, fieldPlay(game.outcome).reveal);   // 1루 간발 느린 화면도 건너뛴다
  game.skipAt = game.resultT;   // 따라가는 카메라는 타석 시점으로 끊고(chaseTarget), 전광판은 지금 띄운다(boardMoment)
}
// 이 기기에서 처음 세 판만 공이 날아가는 동안 '탭하면 바로 결과'를 작게 띄운다(2026-11-03 사용자 결정 '처음 몇 번만 작게').
// 판을 시작할 때 센다(walkoff.skipHint, 보여 준 판 수). 저장소를 못 쓰면 띄우지 않는다(매번 처음이 되므로)
const SKIP_HINT_GAMES = 3;
function takeSkipHint(key = 'skipHint') {
  const n = Number(store.get(key, 0)) || 0;
  if (n >= SKIP_HINT_GAMES) return false;
  store.set(key, n + 1);
  return Number(store.get(key, 0)) === n + 1;
}
// 조준 판도 처음 세 판만 '공이 배트에 닿을 때 치세요'를 띄운다(2026-11-05 사용자 결정, walkoff.aimHint). 네모에 닿을 때 치면 늦어서
const takeAimHint = () => takeSkipHint('aimHint');
// 버튼 위를 누르면 그 버튼, 아니면 화면마다 정한 기본 동작(시작, 스윙, 다음 공)을 한다
function primaryAction(eventTime, x, y, kind = 'mouse') {   // kind: 누른 것(pointerType). x가 없으면 키
  Sound.init();
  if (game.waitingSeed) return;   // 서버 시드를 받는 중(startGame)
  if (x != null && game.state !== 'pitch' && game.state !== 'windup') {
    const b = ui.buttons.find((btn) => inRect(btn.r, x, y));
    if (b) { if (b.href) openOutside(b.href); else b.onTap(); return; }
  }
  if (game.state === 'title') startDefault();   // 버튼이 아닌 빈 곳을 누르면 시작
  else if (game.state === 'pitch' && game.swingAt == null) swing(eventTime, x == null ? 'key' : kind, game.aim && x != null ? gripSpot(x, y, 'mouse') : null);   // 조준 판의 클릭은 그 자리를 손잡이로
  else if (game.state === 'calib') calibTap(eventTime);
  else if ((game.state === 'records' || game.state === 'titles') && x == null) goTitle();
  else if (game.state === 'news' && x == null) openMenu();
  else if (game.state === 'ranking' && x == null) closeRanking();
  else if (canSkip()) skipToBeat();   // 건너뛰게 한 탭은 다음 공으로 넘어가지 않는다
  else if (game.state === 'result' && game.resultT > Math.max(0.35, game.revealAt)) next();
  else if (game.state === 'over' && game.resultT > 0.6 && x == null) {
    restartGame();
  }
}

let linkPress = null;   // 바깥 링크를 누른 손가락(pointerId)
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (game.state === 'news') { news.drag = { y: e.clientY, s: news.scroll }; canvas.setPointerCapture?.(e.pointerId); }   // 화면 밖으로 끌어도 따라간다
  // 넘치는 메뉴(낮은 화면)는 뗄 때 누른다. 끌어 넘기다 손가락 밑의 줄이 눌리지 않게
  if (game.state === 'menu' && menu.max > 0) { menu.drag = { x: e.clientX, y: e.clientY, s: menu.scroll, t: e.timeStamp, moved: false }; canvas.setPointerCapture?.(e.pointerId); return; }
  // 조준 판(폰·펜): 와인드업·투구 중에 누르면 손가락 위에 커서를 띄우고 뗄 때 친다(손가락 하나만)
  if (game.aim && e.pointerType !== 'mouse' && (game.state === 'windup' || game.state === 'pitch')) {
    Sound.init();
    if (!aimPointer.touch) { aimPointer.touch = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch { /* 이미 뗀 손가락 */ } }
    return;
  }
  // 바깥 링크(의견 보내기)는 터치·펜이면 뗄 때 연다. 브라우저는 터치를 뗄 때만 사람이 누른 것으로 쳐서 누를 때 연 새 탭은 막는다
  if (e.pointerType !== 'mouse' && game.state !== 'pitch' && game.state !== 'windup' && linkAt(e.clientX, e.clientY)) { linkPress = e.pointerId; return; }
  primaryAction(e.timeStamp, e.clientX, e.clientY, e.pointerType || 'mouse');
});
// 새 소식·메뉴 넘기기: 끌어 올리기와 휠
canvas.addEventListener('pointermove', (e) => {
  if (game.state === 'news' && news.drag) news.scroll = clamp(news.drag.s - (e.clientY - news.drag.y), 0, news.max);
  const d = menu.drag;
  if (game.state === 'menu' && d) { d.moved ||= Math.abs(e.clientY - d.y) > 8; menu.scroll = clamp(d.s - (e.clientY - d.y), 0, menu.max); }
  if (e.pointerType === 'mouse') Object.assign(aimPointer, { x: e.clientX, y: e.clientY, moved: true });   // 조준 판(PC) 커서
  const t = aimPointer.touch;
  if (t && e.pointerId === t.id) { t.x = e.clientX; t.y = e.clientY; }
});
addEventListener('pointerup', (e) => {
  news.drag = null;
  const d = menu.drag;
  menu.drag = null;
  if (d && !d.moved && game.state === 'menu') primaryAction(d.t, d.x, d.y);
  if (linkPress != null && e.pointerId === linkPress) {   // 링크 위에서 뗐을 때만 연다
    linkPress = null;
    const b = linkAt(e.clientX, e.clientY);
    if (b) openOutside(b.href);
  }
  const t = aimPointer.touch;
  if (t && e.pointerId === t.id) {   // 조준 판(폰): 떼는 순간 친다. 와인드업 중이거나 지켜본 공 판정이 났으면 아무 일도 없다
    aimPointer.touch = null;
    if (game.aim && game.state === 'pitch' && game.swingAt == null) swing(e.timeStamp, 'touch', gripSpot(e.clientX, e.clientY, 'touch'));
  }
});
addEventListener('pointercancel', (e) => {
  if (aimPointer.touch?.id === e.pointerId) aimPointer.touch = null;
  if (linkPress === e.pointerId) linkPress = null;
});
canvas.addEventListener('wheel', (e) => {
  if (game.state === 'news') { e.preventDefault(); news.scroll = clamp(news.scroll + e.deltaY, 0, news.max); }
  else if (game.state === 'menu' && menu.max > 0) { e.preventDefault(); menu.scroll = clamp(menu.scroll + e.deltaY, 0, menu.max); }
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.target === noInput) {   // 등번호를 입력하는 중에도 게임 키를 쓰지 않는다. 엔터는 달기
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ui.buttons.find((b) => b.label === '달기')?.onTap(); }
    else if (e.key === 'Escape') { noInput.blur(); goTitle(); }
    return;
  }
  if (e.target === nickInput) {   // 닉네임을 입력하는 중에는 게임 키를 쓰지 않는다
    // 엔터는 메뉴에서 바꿀 때만 저장한다. 처음 화면에서는 키보드만 닫는다(폰 키보드의 완료 키로 카카오 로그인이 열리지 않게)
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (game.onboard?.next === 'menu') confirmOnboard(); else nickInput.blur(); }
    else if (e.key === 'Escape') { nickInput.blur(); goTitle(); }
    return;
  }
  if (game.state === 'ranking' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { game.rankTab = e.code === 'ArrowLeft' ? 'players' : 'teams'; return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (!e.repeat) primaryAction(e.timeStamp);
  } else if (e.code === 'KeyR' && game.state === 'result') startReplay();
  else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && (game.state === 'title' || game.state === 'over')) setBats(e.code === 'ArrowLeft' ? 'L' : 'R');
  else if (e.code === 'Escape' && game.state !== 'title') goTitle();
  else if (game.mode === 'practice' && game.practice && !['title', 'over', 'records', 'titles', 'news', 'calib'].includes(game.state)) {
    if (/^Digit[1-6]$/.test(e.code)) setPractice({ type: PRACTICE_TYPES[Number(e.code.slice(5)) - 1] });
    else if (e.code === 'KeyS') setPractice({ slow: !game.practice.slow });
    else if (e.code === 'KeyL') setPractice({ throws: game.practice.throws === 'L' ? 'R' : 'L' });
  }
});
window.addEventListener('resize', resize);

// ===== 그리기 =====
function render(time) {
  ui.buttons = [];
  if (game.state !== 'onboard' && nickInput.style.display !== 'none') nickInput.style.display = 'none';
  if (game.state !== 'shop' && noInput.style.display !== 'none') noInput.style.display = 'none';
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.save();
  if (view.shake > 0) ctx.translate((Math.random() * 2 - 1) * view.shake, (Math.random() * 2 - 1) * view.shake);
  drawField();
  const playing = game.state === 'windup' || game.state === 'pitch' || game.state === 'result';
  const p = game.seq[game.i], r = game.outcome;
  const bt = ballTime();
  // 수비수·투수·1.5m 넘게 간 주자를 먼 것부터 그린다(1루수 뒤를 지나는 주자가 가려지게). 투수는 수비에 끼기 전까지 투구 그림
  const run = liveOutcome() ? runnerAt(game.outcome, game.flightT) : null, farRun = run && run.z > 1.5 ? run : null;
  drawDefense(time, [...(farRun ? [farRun] : []), ...scenarioRunners()], () => drawPitcher(playing ? game.t : 0, playing && game.t > 0.35 && bt < 0, playing && p ? !!p.lefty : game.throws === 'L'));
  if (game.state === 'windup' && p && (game.i === 0 || !!game.seq[game.i - 1].lefty !== !!p.lefty)) drawPitcherTag(p);

  if (hasBattedBall() && game.replay == null) {   // 다시 보기 동안 날아간 타구는 감춘다
    const fp = fieldPlay(r).ball(game.flightT);   // 친 공 → 글러브에 든 공 → 던진 공. 꼬리는 친 공에만
    if (fp.z > MOUND && !fp.hidden) { if (fp.trail) drawBallTrail(r, game.flightT); drawBall(fp, { glow: fp.trail, scale: 2, spin: fp.trail ? battedSpin(r, game.flightT) : null }); }
  }
  drawZone((game.state === 'result' ? 0.6 : 0.9) * (game.aim ? AIM_ZONE_ALPHA : 1));
  if (game.state === 'result' && game.resultT > game.revealAt) drawTrail(p, game.replay != null ? game.replay / p.T : 1.0);
  if (playing && bt >= 0) {
    const u = (game.replay != null ? game.replay : bt) / p.T;
    const hiddenByHit = hasBattedBall() && game.replay == null;
    const seen = game.replay == null && hardMatchup(p) ? clamp((u - 0.12) / 0.05, 0, 1) : 1;   // 좌타 대 좌완이면 처음 12%는 안 보인다
    if (!hiddenByHit && u <= 1.06 && seen > 0) drawBall(ballPos(p, u), { spin: { type: p.type, n: p.n, t: game.replay ?? bt, lefty: !!p.lefty }, alpha: seen });
    if (!hiddenByHit && u >= 1) drawPitchMark(p);   // 홈플레이트 앞면을 지난 뒤로 판정한 자리를 남긴다
  }
  if (hasBattedBall() && game.replay == null) {
    const fp = fieldPlay(r).ball(game.flightT);
    if (fp.z <= MOUND && !fp.hidden) { if (fp.trail) drawBallTrail(r, game.flightT); drawBall(fp, { glow: fp.trail, scale: 2, spin: fp.trail ? battedSpin(r, game.flightT) : null }); }
  }
  // 다시 보기 동안에는 타자도 공에 맞춰 다시 휘두른다(휘두르기 전에는 준비 자세)
  const tb = game.replay ?? bt;
  const tau = game.swingAt != null && playing && (game.replay == null || tb >= game.swingAt) ? Math.max(0, tb - game.swingAt) : null;
  // 친 타자는 방망이를 내려놓고 뛴다(타석을 비우니 뒤의 수비도 보인다. 전에는 타자를 흐리게 했다). 아니면 준비 동작과 함께 타석에
  if (run) { drawDroppedBat(game.flightT); if (!farRun) drawRunner(run); }
  else drawBatter(tau, playing ? batterPre(tb, p, time) : { idle: time, load: 0 });
  // 1루 간발: 판정한 순간부터 1.4초 동안 베이스 위에 세이프/아웃
  if (hasBattedBall() && game.replay == null) for (const c of fieldPlay(r).calls) {
    const u = game.flightT - c.t, q = u >= 0 && u < 1.4 ? project(c.at[0], 2.7, c.at[1]) : null;
    if (q) { ctx.save(); ctx.globalAlpha = clamp(Math.min(u / 0.12, (1.4 - u) / 0.3), 0, 1); pill(c.text, q.x, q.y, { size: view.mobile ? 15 : 20, bg: c.text === '세이프' ? 'rgba(22,130,70,0.9)' : 'rgba(190,40,40,0.9)' }); ctx.restore(); }
  }
  if (game.aim) drawAimLayer(p);
  if (game.flash > 0 && game.contactPos) {
    const c = project(game.contactPos.x, game.contactPos.y, game.contactPos.z);
    if (c) {
      const R = 120 * game.flash + 30;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
      g.addColorStop(0, `rgba(255,255,240,${0.9 * game.flash})`); g.addColorStop(1, 'rgba(255,255,240,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    }
  }
  if (game.burst && game.burst.t < BURST_T && !camMoved()) {   // 효과 배트로 맞힌 자리에서 터지는 효과
    const c = project(HIT_SPOT.x, HIT_SPOT.y, HIT_SPOT.z);
    if (c) drawBatBurst(game.burst, c, game.burst.t);
  }
  ctx.restore();

  if (game.state === 'title') { drawTitle(time); drawToast(); return; }
  if (game.state === 'calib') { drawCalib(); drawToast(); return; }
  if (game.state === 'records') { drawRecords(); drawToast(); return; }
  if (game.state === 'titles') { drawTitles(); drawToast(); return; }
  if (game.state === 'news') { drawNews(); drawToast(); return; }
  if (game.state === 'onboard') { drawOnboard(); drawToast(); return; }
  if (game.state === 'ranking') { drawRanking(); drawToast(); return; }
  if (game.state === 'account') { drawAccount(); drawToast(); return; }
  if (game.state === 'shop') { drawShop(); drawToast(); return; }
  if (game.state === 'loginPrompt') { drawLoginPrompt(); drawToast(); return; }
  if (game.state === 'menu') { drawMenu(); drawToast(); return; }
  if (game.state === 'over') { drawGameOver(); drawTopBar(); drawToast(); return; }
  drawTopBar();
  const L = hudLayout();
  if (game.aim && game.aimHint && (game.state === 'windup' || game.state === 'pitch')) {   // 처음 세 판: 존을 가리지 않게 아래쪽, 첫 공 안내 위
    text(finePointer ? '공이 배트에 닿을 때 치세요 · 클릭' : '공이 배트에 닿을 때 치세요 · 손 떼기', view.w / 2, view.h - L.pad - (game.i === 0 ? 48 : 20), { size: view.mobile ? 15 : 17, weight: 800, color: '#7fe3ff', shadow: true });
  }
  if (game.i === 0 && game.state !== 'result') {
    text(game.aim ? (finePointer ? '마우스로 겨누고 클릭 · 랭킹에는 안 올라가요' : '끌어서 겨누고 떼면 스윙 · 랭킹에는 안 올라가요') : view.mobile ? '공이 존에 올 때 탭' : '공이 존에 올 때 스페이스바 · 클릭', view.w / 2, view.h - L.pad - 20, { size: view.mobile ? 15 : 17, color: 'rgba(255,255,255,0.75)', shadow: true });
  }
  if (game.state === 'result') {
    drawResultCard();
    drawBallInfoLine();
    if (game.skipHint && canSkip()) text(view.mobile ? '탭하면 바로 결과' : '스페이스바 · 클릭하면 바로 결과', view.w / 2, view.h - L.pad - 20, { size: view.mobile ? 14 : 16, color: 'rgba(255,255,255,0.7)', shadow: true });
    if (game.resultT > game.revealAt) {
      drawPitchInfo(L.info);
      if (hasBattedBall()) drawMiniMap(L.map);
      const m = view.mobile;
      addButton(L.replay, m ? '다시 보기' : '다시 보기 (R)', 'dark', startReplay);
      const last = game.mode === 'scenario' ? !!game.scn.end : game.mode !== 'practice' && challengeOver();
      addButton(L.next, last ? '결과 보기' : m ? '다음 공' : '다음 공 (Space)', 'primary', next);
      // 10구 도전은 공을 보고 마음에 안 들면 처음부터 다시 한다(2026-10-29 사용자 피드백). 판마다 공이 달라 새 판과 같고,
      // 끝내지 않은 판은 랭킹에 보내지 않는다. 마지막 기회 뒤에는 판이 이미 기록돼서(recordGame) '다시 하기'다(2026-10-30 사용자 결정)
      if (L.restart) addButton(L.restart, last ? '다시 하기' : '처음부터', 'dark', restartGame);
      if (game.mode === 'practice') drawPracticeControls(L);
    }
  }
  drawToast();
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (!window.walkoff?.paused) { update(dt); render(now / 1000); }   // 영상 찍기 도구는 멈춰 두고 walkoff.update·render를 직접 부른다
  requestAnimationFrame(frame);
}

initNews();
resize();
loginReturned();
if (!settings.team) openOnboard('start');   // 처음 온 사람은 열자마자 팀 고르기
requestAnimationFrame(frame);
syncAccount();
prefetchSeed();   // 첫 판을 바로 시작할 수 있게 계정 확인과 함께 받는다

// 확인용: 브라우저 콘솔이나 자동 테스트에서 쓴다
window.walkoff = { game, settings, setBats, store, ui, judgeSwing, judgeTake, makeSequence, ballTime, startGame, goTitle, today, playStreak, shareText, startCalib, applyScenario, makeScenario, ballPos, pitcherHand, PITCHES, TEAMS, teamById, batterColors, pitcherColors, weekStartOf, openOnboard, confirmOnboard, openRanking, saveTeamAndNick, RANKING_API, auth, loggedIn, openAccount, keepPending, seedTicket, prefetchSeed, SHOP_ITEMS, SHOP_SLOTS, wallet, setWallet, currentLook, openShop, coinNote, batterSpan, drawShareCard, backNumberBox, view, batterSkeleton, pitcherHandAt, crowd, fieldPlay, fieldersAt, fieldersNow, FIELDERS, BASE1, BASE2, flightPos, flightDuration, project, startReplay, Sound, hrStreakBonus, hrStreakBefore, hitStreakBonus, hitStreakBefore, zoneOff, seamPoints, runnerAt, BASE3, batterPre, cameraFocus, runnerSkeleton, actorState, actorSkeleton, DEFENSE, groundPath, interceptGround, catchTime, sprintTime, boardView, board, runnerReach, scenarioRunners, scenarioRuns, walkoffTime, cam, CAM_HOME, chaseable, chaseEnd, battedSpin, cleanLook, scoreboardRect, boardMoment, pitcherCard, scoreboardCache, BOARD_HOLD, DUGOUT, SCENARIOS, useScenario, NEWS, news, newsUnread, openNews, menu, openMenu, menuButtonRect, aimPointer, aimCursor, AIM_RADIUS, AIM_BAT, aimAxes, aimBatPoints, aimTilt, aimHeight, gripSpot, aimGripFor, drawAimBat, weekBest, allTimeBest, resultTitleBox, canSkip, beatAt, scoreboardShows, ballInfo,
  update, render, swing, followBall, CHASE, tap: primaryAction, paused: false };
