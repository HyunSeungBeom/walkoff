// 화면 글: 판정 결과 이름('좌중간 2루타')과 이유 문장, 존 밖 문구, 조사, 구종 이름·색, 끝내기 상황 글.
// 판정 규칙(core)은 결과 코드만 돌려주고 글은 여기서 붙인다. 문구를 바꿔도 서버와 같이 쓰는 규칙 파일은 그대로다(2026-11-03 코드 나누기 2단계)
import { REACH_M, zoneMiss, zoneOff } from '../core/pitches.js';
import { AIM, PERFECT_MS } from '../core/judge.js';
import { hrExtra } from '../core/flight.js';

export const PITCH_NAMES = { fastball: '직구', slider: '슬라이더', curve: '커브', change: '체인지업', fork: '포크' };
export const PITCH_COLORS = { fastball: '#ffffff', slider: '#7fd1ff', curve: '#c49bff', change: '#8ef0a8', fork: '#ffb86b' };

export function hasBatchim(word) {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0;
}
export const eun = (word) => word + (hasBatchim(word) ? '은' : '는');

// 존에서 빠진 쪽(core zoneOff의 side)과 거리를 글로. '존 아래로 8cm'
const SIDE_TEXT = { low: '아래', high: '위', in: '몸쪽', out: '바깥쪽' };
export const zoneOffText = (p, bats) => { const o = zoneOff(p, bats); return { dir: SIDE_TEXT[o.side], cm: o.cm }; };
export const offText = (p, bats) => { const o = zoneOffText(p, bats); return `존 ${o.dir}${/[래위]$/.test(o.dir) ? '로' : '으로'} ${o.cm}cm`; };
// 조준 타격(실험): 커서가 공에서 벗어난 쪽과 거리. aim.dx·dy는 m(오른쪽·위가 +, main.js aimFrom). '공 아래 4cm'
const aimSide = (a) => (Math.abs(a.dy) >= Math.abs(a.dx) ? (a.dy > 0 ? '위' : '아래') : a.dx > 0 ? '오른쪽' : '왼쪽');
export const aimText = (a) => `공 ${aimSide(a)} ${Math.round(Math.hypot(a.dx, a.dy) * 100)}cm`;

export function fieldArea(spray) {
  if (spray < -20) return '좌';
  if (spray < -8) return '좌중';
  if (spray <= 8) return '중';
  if (spray <= 20) return '우중';
  return '우';
}

// 결과 이름. 안타·홈런은 방향(spray)으로, 아웃은 잡은 수비수와 타구 종류로, 내야 안타는 공을 잡은 수비수로
const alongName = (s, what) => (s < -35 ? `좌익선상 ${what}` : s < -8 ? `좌중간 ${what}` : s <= 8 ? `중월 ${what}` : s <= 35 ? `우중간 ${what}` : `우익선상 ${what}`);
const OUT_NAME = { ground: '땅볼', line: '직선타', fly: '뜬공', pop: '뜬공' };
export function resultName(r) {
  const area = fieldArea(r.spray);
  if (r.kind === 'whiff') return '헛스윙';
  if (r.kind === 'foul') return '파울';
  if (r.kind === 'out') return `${r.fielder.pos} ${OUT_NAME[r.type]}`;
  if (r.kind === 'hr') return `${area}월 홈런`;
  if (r.kind === 'triple') return alongName(r.spray, '3루타');
  if (r.kind === 'double') return alongName(r.spray, '2루타');
  if (r.infield) return `${r.fielder.pos} 내야 안타`;
  return area.startsWith('좌') ? '좌전 안타' : area.startsWith('우') ? '우전 안타' : '중전 안타';
}

// 앞으로 간 타구의 이유 한 줄. 여러 까닭 가운데 먼저 맞는 것 하나를 보여 준다
export function reasonFor(r, p, miss) {
  if (r.kind === 'hr') return r.perfect ? '완벽한 타이밍이에요' : `${Math.round(r.dist + hrExtra(r.ev))}m 날아갔어요`;
  if (r.split) return '정타라 수비 사이로 빠졌어요';
  if (r.aim && r.aimZone === 'edge') {   // 조준 타격: 과녁 가장자리
    if (r.aim.y > AIM.sweet && r.type === 'ground') return '공 위를 쳐 땅볼이 됐어요';
    if (r.aim.y < -AIM.sweet && (r.type === 'fly' || r.type === 'pop')) return '공 아래를 쳐 떴어요';
    return `${aimText(r.aim)} 가장자리에 맞아 약했어요`;
  }
  if (miss > 0) return `${offText(p, r.bats)} 빠진 공이라 힘이 덜 실렸어요`;
  if (p.type === 'fork' && r.type === 'ground') return '포크는 끝에서 떨어져서 공 윗부분을 치기 쉬워요';
  if (r.kind === 'triple') return '담장을 맞고 외야수 사이로 빠졌어요';
  if (r.wall) return '조금만 더 갔으면 홈런이었어요';
  if (p.ty > 1.0 && (r.type === 'fly' || r.type === 'pop')) return '높은 공은 뜨기 쉬워요';
  if (p.ty < 0.65 && r.type === 'ground') return '낮은 공은 땅볼이 되기 쉬워요';
  if (r.gap) return `${r.gap}을 빠져나갔어요`;
  if (Math.abs(r.dt) <= PERFECT_MS) return '타이밍은 완벽했어요';
  return r.dt > 0 ? '늦어서 밀어친 타구예요' : '빨라서 당겨친 타구예요';
}

// 스윙 결과의 이유. 헛스윙·파울은 공과 타이밍으로, 1루 경주로 정해진 땅볼은 1루에 닿은 차이로, 나머지는 reasonFor
export function swingReason(r, p) {
  const miss = zoneMiss(p), slow = p.type === 'curve' || p.type === 'change', name = PITCH_NAMES[p.type];
  if (r.kind === 'whiff') {
    if (r.aimMiss && r.aim) return `${aimText(r.aim)}로 헛스윙`;   // 조준 타격: 타이밍은 맞았는데 과녁 밖
    if (miss > REACH_M) return `${offText(p, r.bats)} 빠진 공이었어요`;
    return r.dt < 0 ? (slow ? `${eun(name)} 느려요. 더 기다렸다 치세요` : '너무 빨리 휘둘렀어요') : '너무 늦게 휘둘렀어요';
  }
  if (r.kind === 'foul') return r.dt < 0 ? (slow ? `${eun(name)} 느려요. 조금 더 기다리세요` : '빨라서 당겨친 파울') : '늦어서 밀린 파울';
  const race = r.race;
  if (r.infield) return !race.arrive ? '느린 타구라 던질 틈이 없었어요' : `${race.how === 'dive' ? '몸을 날려 잡았지만 ' : ''}1루에 ${(-race.margin).toFixed(2)}초 먼저 닿았어요`;
  if (race && race.margin < 0.15) return `간발의 차로 아웃 · ${race.margin.toFixed(2)}초`;
  return reasonFor(r, p, miss);
}

// 판정 결과에 이름(name)과 이유(reason)를 붙인다. 게임은 판정 바로 뒤에 부른다
export function labelSwing(r, p) {
  r.name = resultName(r);
  r.reason = swingReason(r, p);
  return r;
}
export function labelTake(r, p, bats) {
  r.name = r.kind === 'strike' ? '루킹 스트라이크' : '볼';
  r.reason = r.kind === 'strike' ? '존에 들어온 공이었어요' : `${offText(p, bats)} 빠졌어요 · 선구안 보너스`;
  return r;
}

// ===== 끝내기 상황 =====
export function basesLabel(bases) {
  const on = [1, 2, 3].filter((n) => bases[n - 1]);
  return on.length === 3 ? '만루' : on.length ? `${on.join('·')}루` : '주자 없음';
}
export const scenarioLabel = (s) => `9회말 ${s.outs ? `${s.outs}아웃` : '무사'} ${basesLabel(s.bases)} · ${s.away - s.home}점 차`;

// 공 하나를 반영한 결과(core/scenario.js의 applyScenario)를 화면에 띄울 한 줄로. 볼·스트라이크만 늘면 빈 줄이다
const PLAY_TEXT = { 'k-looking': '루킹 삼진', 'k-swinging': '헛스윙 삼진', 'sac-fly': '희생플라이', 'tag-up': '태그업 진루', 'hold': '3루에서 멈춤' };
const OUT_PLAY = { dp: '병살', fc: '야수 선택', 'out-home': '홈에서 아웃' };   // 아웃이 나는 주루 플레이(2026-11-04)
export function scenarioMessage(s, { runs, pa, play }) {
  const msg = play === 'walk' ? (runs ? '밀어내기 볼넷' : '볼넷') : play === 'out' ? `${s.outs}아웃` : OUT_PLAY[play] ? `${OUT_PLAY[play]} · ${s.outs}아웃` : PLAY_TEXT[play] ?? '';
  if (s.home > s.away) return `끝내기! ${s.home}-${s.away} 승리`;
  if (s.outs >= 3) return `${OUT_PLAY[play] ? `${OUT_PLAY[play]} · ` : ''}${s.home === s.away ? '3아웃 · 동점으로 끝' : '3아웃 · 경기 끝'}`;
  if (runs) return `${msg ? `${msg} · ` : ''}${runs}점! ${s.home === s.away ? '동점' : `${s.away - s.home}점 차`}`;
  if (play === 'fc') return `${msg} · ${basesLabel(s.bases)}`;
  if (OUT_PLAY[play]) return msg;
  if (pa === 'G') return `${play === 'hold' ? '3루에서 멈춤' : '출루'} · ${basesLabel(s.bases)}`;
  return msg;
}
