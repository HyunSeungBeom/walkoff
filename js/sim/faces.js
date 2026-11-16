// 투수·수비수 얼굴(2026-11-16 사용자 '캐릭터의 눈코입이 생겼으면, 다 다르게 랜덤 매칭'). 판의 시드로 상대 팀 9명의 얼굴 부품을 고르고
// 장면마다 표정을 정한다. 같은 시드(다시 보기·도전장)면 같은 얼굴이다. 타자·주자(우리 팀 헬멧)는 그대로. 그리기는 main.js capHead
import { mulberry32 } from '../core/math.js';

export const FACE_PARTS = {
  eye: ['dot', 'wide', 'sleepy', 'stare'],              // 점, 가로 타원, 졸린 눈, 부릅뜬 눈
  brow: ['none', 'flat', 'up'],                         // 없음, 일자, 치켜뜬
  nose: ['dot', 'line', 'none'],                        // 점, 짧은 선, 없음
  mouth: ['flat', 'smile', 'o', 'smirk'],               // 일자, 미소, 작은 o, 씩
  extra: ['none', 'mustache', 'beard', 'eyeBlack'],     // 없음, 콧수염, 턱수염, 눈 밑 검은 칠
};
export const FACE_POS = ['투수', '포수', '1루수', '2루수', '유격수', '3루수', '좌익수', '중견수', '우익수'];
const OUTFIELD = ['좌익수', '중견수', '우익수'];

// 눈 넷과 덤 넷을 섞은 순서로 엇갈려 짝지어(i번째는 눈 i%4, 덤 (i + i/4)%4) 9명이 모두 다른 짝이고 눈·덤마다 2~3명이다.
// 그 짝을 자리에 섞어 나눠 준다. 작게 보이면 눈과 덤만 그려서 그것으로 갈린다. 눈썹·코·입은 따로 뽑는다. 판의 반쯤은 외야수 하나가 선글라스를 쓴다
export function facesFor(seed) {
  const rnd = mulberry32((seed ^ 0x6a09e667) >>> 0), { eye, brow, nose, mouth, extra } = FACE_PARTS;
  const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const E = shuffle(eye), X = shuffle(extra), pairs = shuffle(FACE_POS.map((_, i) => [E[i % 4], X[(i + Math.floor(i / 4)) % 4]]));
  const pick = (list) => list[Math.floor(rnd() * list.length)], shades = rnd() < 0.5 ? OUTFIELD[Math.floor(rnd() * 3)] : null;
  return Object.fromEntries(FACE_POS.map((pos, i) => [pos, { eye: pairs[i][0], extra: pairs[i][1], brow: pick(brow), nose: pick(nose), mouth: pick(mouth), shades: pos === shades }]));
}

// 친 공 장면(r, 수비 일정 play)의 t초 표정. 'wow' 홈런을 맞은 투수·수비수, 'grin' 뜬공·직선타를 잡은 수비수(잡은 뒤),
// 'sad' 안타에 몸을 날리거나 뛰어올랐다 놓친 수비수(그 뒤로 내내). 결과 장면 동안만이라 다음 공(r 없음)에는 기본(null)으로 돌아온다
export function faceMood(r, play, pos, t) {
  if (!r || !play) return null;
  if (r.kind === 'hr') return 'wow';
  if (r.kind === 'out') return r.type !== 'ground' && play.ev.fielder === pos && t >= play.ev.catch ? 'grin' : null;   // 땅볼 아웃은 웃지 않는다
  return play.acts[pos]?.some((e) => (e.name === 'dive' || e.name === 'leap') && e.t0 <= t) ? 'sad' : null;
}
