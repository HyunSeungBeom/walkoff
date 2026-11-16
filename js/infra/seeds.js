// 시드: 랭킹에 올라가는 10구 도전은 서버가 판마다 내준 시드로 친다(2026-10-30, worker/src/seeds.js). 게임이 시드를 정하던 때는
// 볼이 많이 나오는 시드를 골라 보내거나 같은 공 순서를 미리 익혀 칠 수 있었다. 서버는 점수를 받을 때 자기가 낸 시드인지,
// 한 번만 쓰였는지, 그 판을 칠 시간이 지났는지를 본다.
// 시작할 때 기다리지 않게 다음 판 시드를 미리 하나 받아 둔다. 로그인 안 했거나 주소에 ?seed=를 붙였으면 받지 않는다
// 코인을 받는 끝내기 상황도 서버 시드로 친다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김).
// 이번 주 투수(2026-11-16): 서버는 표를 내준 주의 투수 유형(style)을 같이 주고 그 유형의 공 순서로 점수를 검사한다. 받아 둔 표는 주가 바뀌면 버린다
import { api, auth, loggedIn } from './api.js';
import { isStyle } from '../core/pitches.js';

export const SEED_KEEP_MS = 6 * 3600e3;   // 받아 둔 시드가 이보다 오래됐으면 버리고 새로 받는다(서버는 받은 뒤 사흘까지 받는다)
export const SEED_WAIT_MS = 3000;         // 받는 중에 시작하면 이만큼까지 기다린다. 그래도 못 받으면 랭킹 없이 친다
export const seedTicket = { ready: null, loading: null };   // ready: { token, seed, at, style }
// 한국 시간 월요일 0시마다 1씩 오르는 주 번호(1970-01-05 월요일부터)
const kstWeek = (ms) => Math.floor((ms + 9 * 3600e3 - 4 * 864e5) / (7 * 864e5));

// 주소 끝 ?seed=숫자. 같은 공 순서를 다시 칠 때 쓴다(랭킹에는 안 올라간다)
export function urlSeed() {
  const s = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isFinite(s) && s > 0 ? s : null;
}
// ?seed=와 같이 쓰는 ?pitcher=유형(power·finesse·forkball·classic). 다른 주 투수를 미리 쳐 볼 때 쓴다. 모르는 값이면 null
export function urlStyle() {
  const s = new URLSearchParams(location.search).get('pitcher');
  return isStyle(s) ? s : null;
}

// 시드를 받다가 로그인이 풀린 것(401)을 알면 부른다. 지갑·알림까지 정리하는 logout은 main에 있어서 main이 넣어 준다
let expired = () => {};
export const onSeedExpired = (fn) => { expired = fn; };

export function prefetchSeed() {
  if (!loggedIn() || urlSeed() != null) return null;
  const now = Date.now(), r = seedTicket.ready;
  if (r && (now - r.at > SEED_KEEP_MS || kstWeek(r.at) !== kstWeek(now))) seedTicket.ready = null;   // 지난주에 받은 표는 지난주 투수라서 버린다
  if (seedTicket.ready || seedTicket.loading) return seedTicket.loading;
  const by = auth.token;
  seedTicket.loading = (async () => {
    try {
      const res = await api('/seeds', { method: 'POST' });
      if (res.status === 401) { if (auth.token === by) expired(); return; }
      const d = await res.json().catch(() => ({}));
      // style이 없으면(유형이 생기기 전 서버) 서버도 정통파로 검사한다
      if (auth.token === by && res.ok && typeof d.token === 'string' && Number.isInteger(d.seed) && d.seed > 0) seedTicket.ready = { token: d.token, seed: d.seed, at: Date.now(), style: isStyle(d.style) ? d.style : 'classic' };
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
