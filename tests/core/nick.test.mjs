// 닉네임 규칙(js/core/nick.js, 2026-11-19 공개 화면 지키기)을 브라우저 없이 본다. 서버와 게임이 같은 파일을 쓴다.
// 통과할 쪽은 지금 랭킹에 있는 닉네임 모양(한글 2~9자, '타자1234' 같은 기본 닉네임, 숫자 2자 + 한글)과 욕과 글자가 겹치는 보통 낱말에서 가져왔다.
// 실행: node --test 'tests/core/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNick, NICK_MAX } from '../../js/core/nick.js';

const why = (nick) => checkNick(nick).why ?? 'ok';

test('닉네임 글자: 한글 완성형·영문·숫자 1~10자만. 앞뒤 빈칸은 빼고 NFC로 맞춘 값을 돌려준다', () => {
  assert.equal(NICK_MAX, 10);
  assert.deepEqual(checkNick('  민성  '), { ok: true, nick: '민성' });
  assert.deepEqual(checkNick('가나다라마바사아자차'), { ok: true, nick: '가나다라마바사아자차' });   // 한글 10자
  assert.deepEqual(checkNick('각'), { ok: true, nick: '각' });   // 풀어 쓴 자모(NFD)는 합쳐서 받는다
  assert.deepEqual(checkNick(1234), { ok: true, nick: '1234' });   // 서버는 받은 값을 글자로 바꿔 본다
  for (const nick of ['', '   ', null, undefined]) assert.equal(why(nick), 'empty', String(nick));
  assert.equal(why('가나다라마바사아자차카'), 'long');   // 11자
  assert.equal(why('abcdefghijk'), 'long');
  const chars = ['ㅤ', 'ㅤ타자', '타​자', '타 자', '타자⠀', 'ᅟᅠ', 'ﾠ',   // 한글 채움 문자·폭 없는 빈칸·점자 빈칸(투명 닉네임)
    '타 자', '타자!', '타_자', 'a.b', 'ㅋㅋ타자', 'ㅅㅂ', 'ㅗ', '⚾타자', '타자♥', 'ｔａｊａ', 'тaja', 'a\u0007b', '漢字'];   // 빈칸·기호·낱자·이모지·전각·키릴 문자·제어 문자·한자
  for (const nick of chars) assert.equal(why(nick), 'chars', JSON.stringify(nick));
});

test('통과: 지금 랭킹 모양의 닉네임, 기본 닉네임 9,000개 모두, 욕과 글자가 겹치는 보통 낱말', () => {
  for (let n = 1000; n <= 9999; n++) assert.equal(why(`타자${n}`), 'ok', `타자${n}`);   // 게임·서버가 만드는 기본 닉네임은 늘 통과해야 한다
  const shapes = ['민성', '골든', '가람', '홈런왕', '타격천재', '끝내기홈런왕', '오늘도안타', '야구가좋아요', '엘지팬구년차', '두산사랑해요', '롯데자이언츠',
    '한화이글스', '기아타이거즈', '23번타자', '07오타니', '4번타자', 'KIA타이거즈', 'SSG랜더스', 'NC다이노스', 'kt위즈', 'LG트윈스', 'babyshark', 'Ohtani17', 'walkoffman', 'homerun', 'gmail'];
  // 욕·사칭 낱말과 글자가 겹치지만 보통 낱말이다(앞뒤 낱말에 걸쳐 생기는 것 포함)
  const nearMiss = ['시발점', '시발역', '다시발사', '일시불', '아저씨바보', '새끼손가락', '새끼발가락', '새끼줄', '팔등신', '8등신', '등신대',
    '전염병', '화염병', '메갈로돈', '제일베스트', '애널리스트', '정액제', '타자지존', '남자지존', '감자지훈', '바보지만', '먹보지존', '나를보지마', '자지않는타자',
    '자지러지게', '개구리', '개나리', '개미', '개념타자', '개그맨', '개성파', '신발', '씨름', '씨앗', '쌍둥이', '쌍방울', '미친타격', '엿장수', '애미', '18번타자',
    '2018우승', '18년우승', '보존', '가시방석', '행운지킴이', '고양이', '강아지', '시바견', 'badminton', 'Dickey', 'rotor', 'Fukuoka', 'kimchi'];
  for (const nick of [...shapes, ...nearMiss]) assert.equal(why(nick), 'ok', nick);
});

test('막힘: 욕·깎아내리는 말·성 관련 낱말과 흔한 바꿔 쓰기(숫자·영문 끼우기, 겹쳐 쓰기, 숫자로 읽기, 영어 자판으로 친 한글)', () => {
  const plain = ['씨발', '시발놈', '병신', '개새끼', '지랄', '좆밥', '존나잘침', '니애미', '느금마', '썅', '미친놈', '꺼져라개새', '엿먹어라', '섹스', '야동왕',
    '자지', '보지털', '자지왕', '정신병자', '쪽바리', '짱깨', '한남충', '김치녀', '틀딱', '꼴데', '카지노', '먹튀검증'];
  const disguised = ['시1발', '씨8발', '시a발', '병1신', '개9새끼', '씨이이발', '시시발', '1자지', '18놈', '씨8', '10새끼',
    'tlqkf', 'Tlqkf', 'TLQKF', 'qudtls', 'wlfkf', 'tprtm', 'whssk', 'fuck', 'FUCK', 'fuuuck', 'sh1t', 'b1tch', 'shitty', 'f4ggot', 'pussy', 'porn', 'sexy', 'nigga'];
  for (const nick of [...plain, ...disguised]) assert.equal(why(nick), 'word', nick);
});

test('막힘: 사칭(운영자·관리자·공식·admin·GM, 2026-11-19 사용자 \'막기\'), 게임 이름 그대로, 전화번호 같은 긴 숫자', () => {
  for (const nick of ['운영자', 'walkoff운영자', '관리자1', '운영진', '운영팀', '관리팀', 'KBO공식', '공식계정', 'admin', 'Admin1', 'adminkim', 'GM', 'gm1', 'GM타자', '타자GM',
    'dnsdudwk',   // 영어 자판으로 친 '운영자'
    'walkoff', 'WALKOFF', '끝내기', '워크오프', '01012345', '12345678', '타자12345678']) assert.equal(why(nick), 'word', nick);
  for (const nick of ['끝내기홈런', 'walkoff1', '워크오프킹', 'GMKIM', '타자1234567']) assert.equal(why(nick), 'ok', nick);   // 게임 이름은 전체가 그 말일 때만, 숫자는 7자리까지
});
