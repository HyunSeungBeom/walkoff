// 카카오 로그인(2026-10-28 사용자 결정): 카카오 로그인 화면으로 보내고, 돌아오면 랭킹 서버가 준 로그인 표를 받는다.
// 로그인한 뒤 계정·지갑을 맞추는 일과 로그아웃은 main이 한다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
import { auth, RANKING_API } from './api.js';
import { store } from './store.js';

// 카카오 로그인 화면으로 간다. 확인값을 이 브라우저에 적어 두고, 돌아왔을 때 같은 값인지 본다. playerId는 이 브라우저의 랭킹 ID
export function goKakaoLogin(playerId) {
  const n = `n${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  store.set('loginNonce', n);
  // 저장소에 쓴 확인값이 브라우저에 넘어갈 틈을 주고 떠난다. 바로 떠나면 값이 넘어가기 전에 페이지가 닫힐 수 있다(CI 테스트에서 봤다)
  const url = `${RANKING_API}/auth/kakao/start?${new URLSearchParams({ n, pid: playerId, return: location.href.split('#')[0] })}`;
  setTimeout(() => { location.href = url; }, 50);
}

// 카카오 로그인에서 돌아오면 주소 뒤에 #login=표&n=확인값(실패하면 #login_error=까닭&n=확인값)이 붙는다.
// 이 브라우저가 보낸 확인값과 같을 때만 받고, 표가 주소째 공유되지 않게 주소에서 바로 지운다
// 돌려주는 값: 'ok'(표를 받음), 'canceled'(카카오에서 취소), 'failed'(못 함), null(돌아온 것이 아니거나 이 브라우저가 보낸 확인값이 아님)
export function readLoginReturn() {
  if (!/(^#|&)(login|login_error)=/.test(location.hash)) return null;
  const q = new URLSearchParams(location.hash.slice(1)), sent = store.get('loginNonce', null);
  try { history.replaceState(null, '', location.href.split('#')[0]); } catch { location.hash = ''; }
  store.remove('loginNonce');
  if (!sent || q.get('n') !== sent) return null;
  if (!q.get('login')) return q.get('login_error') === 'canceled' ? 'canceled' : 'failed';
  Object.assign(auth, { token: q.get('login'), fresh: true });
  store.set('session', auth.token);
  return 'ok';
}
