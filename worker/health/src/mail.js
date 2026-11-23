// @ts-check
// 알림 메일 원문(2026-11-20, 새 의존성 없이). Cloudflare send_email은 RFC 5322 원문을 받고 From·Message-ID 머리글이 꼭 있어야 한다.
// 한글 제목·이름은 RFC 2047 encoded-word(=?UTF-8?B?…?=), 본문은 UTF-8 base64. 줄 끝은 CRLF이고 한 줄은 76자를 넘지 않는다
const enc = new TextEncoder();
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

// 머리글 값: 아스키만이면 그대로, 아니면 encoded-word 여러 개로 접어 잇는다. 하나에 39바이트까지라 'Subject: '를 붙여도 76자 안이고,
// 글자 하나(한글 3바이트)를 두 낱말로 쪼개지 않는다(RFC 2047 5절)
export function encodeHeader(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let cur = '';
  for (const ch of text) {
    if (cur && enc.encode(cur + ch).length > 39) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join('\r\n ');
}

const ADDRESS = /^[^\s<>@"',;]+@[^\s<>@"',;]+\.[a-z]{2,}$/i;

// 로그에 메일 주소가 남지 않게 가린다(보내기 오류 글에 받는 주소가 들 수 있다)
export const hideMail = (s) => String(s).replace(/[^\s<>@"',;:]+@[^\s<>@"',;:]+/g, '<메일>');

// 메일 원문. date·id는 시험이 정해 넣는다(id는 Message-ID의 @ 앞)
export function rawMail({ from, fromName, to, subject, text, date = new Date(), id = crypto.randomUUID() }) {
  for (const a of [from, to]) if (!ADDRESS.test(a)) throw new Error('메일 주소 모양이 아니다');
  return [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(enc.encode(text.replace(/\r?\n/g, '\r\n'))).replace(/.{1,76}/g, '$&\r\n'),
  ].join('\r\n');
}
