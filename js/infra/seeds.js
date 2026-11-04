// 시드: 랭킹에 올라가는 10구 도전은 서버가 판마다 내준 시드로 친다(2026-10-30, worker/src/seeds.js). 게임이 시드를 정하던 때는
// 볼이 많이 나오는 시드를 골라 보내거나 같은 공 순서를 미리 익혀 칠 수 있었다. 서버는 점수를 받을 때 자기가 낸 시드인지,
// 한 번만 쓰였는지, 그 판을 칠 시간이 지났는지를 본다.
// 시작할 때 기다리지 않게 다음 판 시드를 미리 하나 받아 둔다. 로그인 안 했거나 주소에 ?seed=를 붙였으면 받지 않는다
// 코인을 받는 끝내기 상황도 서버 시드로 친다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
import { api, auth, loggedIn } from './api.js';

export const SEED_KEEP_MS = 6 * 3600e3;   // 받아 둔 시드가 이보다 오래됐으면 버리고 새로 받는다(서버는 받은 뒤 사흘까지 받는다)
export const SEED_WAIT_MS = 3000;         // 받는 중에 시작하면 이만큼까지 기다린다. 그래도 못 받으면 랭킹 없이 친다
export const seedTicket = { ready: null, loading: null };   // ready: { token, seed, at }

// 주소 끝 ?seed=숫자. 같은 공 순서를 다시 칠 때 쓴다(랭킹에는 안 올라간다)
export function urlSeed() {
  const s = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isFinite(s) && s > 0 ? s : null;
}

// 시드를 받다가 로그인이 풀린 것(401)을 알면 부른다. 지갑·알림까지 정리하는 logout은 main에 있어서 main이 넣어 준다
let expired = () => {};
export const onSeedExpired = (fn) => { expired = fn; };

export function prefetchSeed() {
  if (!loggedIn() || urlSeed() != null) return null;
  if (seedTicket.ready && Date.now() - seedTicket.ready.at > SEED_KEEP_MS) seedTicket.ready = null;
  if (seedTicket.ready || seedTicket.loading) return seedTicket.loading;
  const by = auth.token;
  seedTicket.loading = (async () => {
    try {
      const res = await api('/seeds', { method: 'POST' });
      if (res.status === 401) { if (auth.token === by) expired(); return; }
      const d = await res.json().catch(() => ({}));
      if (auth.token === by && res.ok && typeof d.token === 'string' && Number.isInteger(d.seed) && d.seed > 0) seedTicket.ready = { token: d.token, seed: d.seed, at: Date.now() };
    } catch { /* 이번에 못 받으면 시작할 때 다시 받는다 */ }
    finally { seedTicket.loading = null; }
  })();
  return seedTicket.loading;
}
// 받아 둔 시드를 이번 판에 쓰고, 다음 판 것을 받기 시작한다
export function takeSeedTicket() {
  const t = seedTicket.ready;
  seedTicket.ready = null;
  prefetchSeed();
  return t;
}
