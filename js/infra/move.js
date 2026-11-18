// 옛 주소에서 새 주소로 이 기기 기록 넘기기(2026-11-17 사용자 '홍보 준비(도메인·주소 옮기기)', 주소는 infra/site.js).
// 저장소(walkoff.*)는 주소마다 따로라, 그냥 옮기면 새 주소에서 연속 기록·타이밍 보정·설정·로그인이 비어 보인다(코인·칭호는 서버 계정에 있다).
// 옛 주소에서 열면(넘기기를 켰을 때, MOVE_ON) 처음 한 번은 walkoff.* 값을 모두 주소 뒤 # 조각에 실어(서버로 가지 않는다) 새 주소로 가고,
// 넘긴 표시(walkoff.moved)를 남겨 다음부터는 값 없이 바로 간다. 옛 주소의 값은 로그인 표(session)만 지우고 그대로 둔다
// (옛 출처 hyunseungbeom.github.io는 블로그와 같이 써서 블로그가 불러오는 바깥 스크립트가 180일짜리 표를 읽을 수 있다, 2026-11-18 보안 검토).
// 새 주소는 받은 값 가운데 아직 없는 키만 넣고(이미 있으면 덮지 않는다) 바로 # 조각을 지운다. 로그인 표(session)도 넘긴다(2026-11-17 사용자 '로그인은 이어 주기').
// 다만 옛 주소에서 넘어왔을 때(document.referrer)만 받고, 아니면 아무 값도 넣지 않는다(2026-11-18 보안 검토): 남이 만든 #move= 주소로
// 자기 표(그 계정으로 치게), 닉네임·팀(로그인하면 계정에 올라간다), 타이밍 보정을 심을 수 없게. 옛 주소 응답과 index.html에는 referrer를 막는 설정이 없다.
// 다른 모듈보다 먼저 돌아야 한다(state.js·api.js가 처음 읽을 때 저장소를 본다). 그래서 index.html이 게임보다 먼저 읽고 main.js도 맨 처음 가져온다.
// 옛 주소에서는 여기서 멈춰(throw) 게임을 띄우지 않는다: 이 모듈을 가져오는 main.js도 같은 오류로 멈춰 서버 요청·통계를 보내지 않는다
import { MOVE_ON, NEW_SITE, OLD_SITE, moveUrl, packMove, siteOf, unpackMove } from './site.js';

const PREFIX = 'walkoff.', MOVED = 'walkoff.moved', SESSION = 'walkoff.session';
const STAY = ['moved', 'loginNonce'];   // 넘기지 않는 값: 넘긴 표시, 그 주소에서 로그인을 시작할 때만 쓰는 확인값

export let movedIn = false;   // 새 주소: 이번에 옛 주소의 기록을 받았다(통계로 센다)

// 옛 주소: 처음이면 기록을 싣고, 넘긴 표시를 남긴 뒤 새 주소로 간다. 로그인 표는 옛 주소에 남기지 않는다. 저장소를 못 쓰면 기록 없이 간다
function leaveOld() {
  let data = null;
  try {
    if (!localStorage.getItem(MOVED)) {
      const values = {};
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(PREFIX) && !STAY.includes(k.slice(PREFIX.length))) values[k.slice(PREFIX.length)] = localStorage.getItem(k);
      }
      if (Object.keys(values).length) data = packMove(values);
      localStorage.setItem(MOVED, String(Date.now()));
    }
    localStorage.removeItem(SESSION);
  } catch { /* 저장소를 못 쓰는 브라우저(사생활 보호 모드) */ }
  location.replace(moveUrl(location.href, data));
}

// 새 주소: 옛 주소에서 넘어왔으면 # 조각의 기록 가운데 없는 키만 넣는다. 조각은 어느 쪽이든 바로 지운다(주소째 공유되지 않게, 물음표 뒤는 남긴다)
function arrive() {
  const values = unpackMove(location.hash);
  try { history.replaceState(null, '', location.href.split('#')[0]); } catch { location.hash = ''; }
  let fromOld = false;
  try { fromOld = new URL(document.referrer).origin === new URL(OLD_SITE).origin; } catch { /* 넘어온 곳을 모른다 */ }
  if (!values || !fromOld) return;
  try {
    for (const [k, v] of Object.entries(values)) {
      if (!STAY.includes(k) && localStorage.getItem(PREFIX + k) == null) localStorage.setItem(PREFIX + k, v);
    }
  } catch { return; /* 저장소를 못 쓰면 받을 수도 없다 */ }
  movedIn = true;
}

const site = siteOf(location.href);
if (site === OLD_SITE && MOVE_ON) {
  leaveOld();
  throw new Error('walkoff는 새 주소로 옮겼어요');
}
if (site === NEW_SITE && location.hash.startsWith('#move=')) arrive();
