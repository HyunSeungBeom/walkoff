// 게임 주소(2026-11-17 사용자 '홍보 준비(도메인·주소 옮기기)'). 새 주소 walkoff.kr은 Cloudflare Pages에 올리고(CI), 옛 주소(github.io)는 그대로 둔 채
// 열면 이 기기 기록을 한 번 넘기고 새 주소로 보낸다(infra/move.js). 주소를 바꿀 때는 여기만 고친다. 서버(worker/src/auth.js SITES)도 같은 값이어야 하고
// tests/meta.spec.js가 본다. 브라우저 밖(CI의 미리보기 태그 바꾸기, 테스트)에서도 읽어서 이 파일은 화면·저장소를 쓰지 않는다
export const OLD_SITE = 'https://hyunseungbeom.github.io/walkoff/';
export const NEW_SITE = 'https://walkoff.kr/';
// 옛 주소 넘기기. 새 주소가 PC·아이폰에서 잘 열리는 것을 본 뒤 켠다(2026-11-20 켬, 작업 글 walkoff-domain.md 5절). 켜면 새 주소가 사람들이 치는 주소다(HOME).
// 끌 때는 index.html의 미리보기 태그도 HOME으로 같이 돌린다(tests/meta.spec.js가 본다)
export const MOVE_ON = true;
export const HOME = MOVE_ON ? NEW_SITE : OLD_SITE;

// 주소(href)가 옛·새 주소 가운데 어느 쪽인지(OLD_SITE·NEW_SITE). 둘 다 아니면 null(이 컴퓨터·테스트, Cloudflare가 따로 주는 pages.dev 주소)
export function siteOf(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  return [OLD_SITE, NEW_SITE].find((s) => { const b = new URL(s); return u.origin === b.origin && u.pathname.startsWith(b.pathname); }) ?? null;
}
// 공유 글·카드에 적는 주소: 지금 열린 주소(옛 주소에서 친 사람은 옛 주소를 보낸다). 그 밖의 주소에서는 사람들이 치는 주소
export const shareSite = (href) => siteOf(href) ?? HOME;

// 옛 주소에서 새 주소로 갈 주소. 물음표 뒤(도전장 ?vs=, ?seed=, ?fps=1)는 그대로 들고 가고, 넘길 기록(packMove)이 있으면 # 조각에 싣는다.
// # 조각은 서버로 가지 않는다. 옛 주소의 # 조각(카카오 로그인에서 돌아온 표 등)은 들고 가지 않는다
export function moveUrl(href, data = null) {
  const to = new URL(NEW_SITE);
  to.search = new URL(href).search;
  if (data) to.hash = `move=${data}`;
  return to.href;
}

// 넘길 기록 { 키(앞의 walkoff.를 뗀 것): 저장된 글자 }를 # 조각에 실을 글자로 바꾼다(JSON을 UTF-8 base64url로, 한글 닉네임도 그대로 간다)
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export function packMove(values) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, d: values }));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 받은 # 조각('#move=...')을 { 키: 글자 }로 되돌린다. 모양이 틀리면 null. 키 이름이 이상하거나 글자가 아닌 값은 버린다
export function unpackMove(hash) {
  const m = /^#move=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (o?.v !== 1 || !o.d || typeof o.d !== 'object' || Array.isArray(o.d)) return null;
    return Object.fromEntries(Object.entries(o.d).filter(([k, v]) => KEY_RE.test(k) && typeof v === 'string'));
  } catch { return null; }
}
