// 닉네임 규칙(2026-11-19 사용자 '공개 화면 지키기'). 랭킹 서버(worker/src/rules.js validateProfile·gifts.js parseFind)와
// 게임(닉네임 정하기, 받은 도전장 game/duel.js)이 같은 규칙을 쓰고, 마지막 판단은 서버가 한다.
// 글자는 한글 완성형·영문·숫자로 1~10자다(빈칸·기호·낱자·이모지 없음, 2026-11-19 사용자). 투명 닉네임에 쓰는 한글 채움 문자(U+3164)와
// 폭 없는 빈칸, 생김새만 같은 다른 나라 글자는 이 단계에서 막힌다. 그 위에서 욕·깎아내리는 말·사칭(운영자 등, 사용자 '막기')·광고를 목록과 견준다.
// 목록은 공개 레포라 누구나 볼 수 있다(감수). 게임은 어느 낱말에 걸렸는지 알리지 않는다(돌아갈 길을 알려 주지 않으려고)

export const NICK_MAX = 10;

// 글자 사이에 숫자·영문을 끼우거나(시1발) 같은 글자를 겹쳐 써도(씨이이발) 걸리게, 한글만 남긴 사본과 겹친 글자를 하나로 줄인 사본에서 찾는다
const WORDS = [
  // 욕
  '씨발', '시발', '씨빨', '시빨', '씨팔', '시팔', '싯팔', '씹팔', '씨바', '쓰바', '씨벌', '시벌', '쓰벌', '씨불', '시불', '씨이발', '시이발', '씨잇발', '시잇발',
  '씨부랄', '시부랄', '씨부럴', '십새', '씹새', '씹년', '씹놈', '씹창', '씹할', '씹질', '병신', '븅신', '빙신', '병쉰', '병싄', '병딱', '븅딱', '등신',
  '지랄', '염병', '썅', '좆', '좃', '존나', '존내', '엿먹', '엿같', '새끼', '쌔끼', '섀끼', '쉐끼', '새꺄', '쌔꺄', '개새', '개새끼', '개색', '개쉐', '개쉑',
  '개같', '개년', '개놈', '개자식', '호로자식', '후레자식', '쌍놈', '쌍년', '미친놈', '미친년', '미친새',
  '니애미', '느금', '니미', '니기미', '느개비', '애미뒤', '애미없', '애비없', '엠창', '엄창',
  // 성
  '섹스', '쎅스', '섹쓰', '야동', '딸딸이', '딸치', '자지털', '자지빨', '큰자지', '왕자지', '내자지', '니자지', '보지털', '보지빨', '보짓물',
  '개보지', '내보지', '니보지', '왕보지', '큰보지', '젖꼭지', '젖탱이', '빨통', '강간', '성폭행', '몰카', '창녀', '창년', '갈보', '화냥', '빠구리',
  '정액', '질싸', '애널', '오나홀',
  // 깎아내리는 말(장애·나라·지역·성별)과 구단 비하
  '찐따', '정신병자', '정박아', '쪽바리', '쪽발이', '짱깨', '짱개', '깜둥이', '조센징', '전라디언', '개쌍도', '한남충', '김치녀', '된장녀', '메갈', '워마드',
  '일베', '맘충', '틀딱', '노알라', '꼴데',
  // 광고
  '바카라', '카지노', '먹튀', '텔레그램', '오픈채팅', '토토사이트',
  // 사칭
  '운영자', '관리자', '운영진', '운영팀', '관리팀', '공식',
];
// 이 글자로 시작하는 닉네임만 막는다. 가운데에 오는 것은 보통 낱말이 많아서다(타자지존·바보지만·먹보지존)
const START = ['자지', '보지', '보짓'];
const LATIN = ['fuck', 'shit', 'bitch', 'asshole', 'pussy', 'cunt', 'nigger', 'nigga', 'faggot', 'slut', 'whore', 'porn', 'sex', 'penis', 'vagina', 'nazi', 'hitler', 'admin'];
// 욕과 글자가 겹치는 보통 낱말. 먼저 이 낱말에서 끊어 놓고 견주므로 이 낱말을 넘어 이어진 글자는 보지 않는다
const SAFE = [
  '시발점', '시발역', '시발택시', '다시발', '일시불', '아저씨', '새끼손', '새끼발', '새끼줄', '팔등신', '구등신', '8등신', '9등신', '등신대',
  '전염병', '감염병', '화염병', '메갈로', '일베스트', '정액제', '정액권', '애널리', '자지러', '자지마', '자지말', '자지않', '자지못', '보지마', '보지말', '보지않', '보지못',
  'badminton',
];
const EXACT = ['walkoff', '끝내기', '워크오프'];   // 닉네임 전체가 이 말일 때만(끝내기홈런왕은 된다)
// 숫자로 읽는 욕(18놈 = 씹할 놈. '18년'은 해·나이로도 써서 뺀다), 운영자를 뜻하는 GM(영문 사이에 끼지 않은 것), 전화번호 같은 긴 숫자(8자리부터)
const PATTERNS = [/18(놈|새|련|롬)/, /(씨|시|쓰)8/, /10(새|색|섹)/, /개18/, /(^|[^a-z])gm(?![a-z])/, /\d{8}/];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

// 한글 자판 두벌식 자리(첫소리·가운데소리·끝소리 순서는 유니코드 한글 음절 순서). 겹모음·겹받침은 두 번 누른다
const L_KEYS = 'r R s e E f a q Q t T d w W c z x v g'.split(' ');
const V_KEYS = 'k o i O j p u P h hk ho hl y n nj np nl b m ml l'.split(' ');
const T_KEYS = ['', ...'r R rt s sw sg e f fr fa fq ft fx fv fg a q qt t T d w c z x v g'.split(' ')];
function keysOf(word) {
  let out = '';
  for (const ch of word) {
    const i = ch.charCodeAt(0) - 0xac00;
    out += L_KEYS[Math.floor(i / 588)] + V_KEYS[Math.floor((i % 588) / 28)] + T_KEYS[i % 28];
  }
  return out;
}
// 한/영을 안 바꾸고 친 욕(tlqkf = 시발). 다섯 번 넘게 누르는 낱말만 보고(짧으면 영어 낱말에 섞여 나온다: 개새 roto → protocol),
// 영어 사전에 나오는 자리(개색 rotor, 개년 rosus)도 뺀다
const KEYS = [...new Set(WORDS.map(keysOf).filter((k) => k.length >= 5 && !['rotor', 'rosus'].includes(k.toLowerCase())))];

const hangulOf = (s) => s.replace(/[^가-힣]/g, '');
const latinOf = (s) => s.replace(/[013457]/g, (d) => LEET[d]).replace(/[^a-z]/g, '');
const squeeze = (s) => s.replace(/(.)\1+/g, '$1');
const has = (s, list) => list.some((w) => s.includes(w) || squeeze(s).includes(w));

function badWord(nick) {
  const low = nick.toLowerCase();
  if (EXACT.includes(low) || PATTERNS.some((re) => re.test(low))) return true;
  const parts = SAFE.reduce((list, w) => list.flatMap((p) => p.split(w)), [low]);
  if (START.some((w) => hangulOf(parts[0]).startsWith(w))) return true;
  if (parts.some((p) => has(hangulOf(p), WORDS) || has(latinOf(p), LATIN))) return true;
  return (nick.match(/[A-Za-z]{5,}/g) ?? []).some((run) => KEYS.some((k) => run.includes(k) || run.toLowerCase().includes(k.toLowerCase())));
}

// 닉네임 검사. 앞뒤 빈칸을 빼고 글자를 NFC로 맞춘 닉네임(저장할 값)을 돌려준다.
// why: empty(비었다) · long(10자 넘음) · chars(한글·영문·숫자 밖의 글자) · word(목록에 걸림)
export function checkNick(raw) {
  const nick = String(raw ?? '').normalize('NFC').trim();
  if (!nick) return { ok: false, why: 'empty' };
  if ([...nick].length > NICK_MAX) return { ok: false, why: 'long' };
  if (!/^[가-힣A-Za-z0-9]+$/.test(nick)) return { ok: false, why: 'chars' };
  return badWord(nick) ? { ok: false, why: 'word' } : { ok: true, nick };
}
