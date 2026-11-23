// @ts-check
// 상태 알림 Worker의 한 바퀴(2026-11-20 사용자 'Cloudflare 예약 실행', 작업 글 walkoff-health-cron.md): 세 곳을 보고, 지난 상태와 견줘 보낼 메일과 새 상태를 정한다.
// 바깥(fetch·시계·기다리기·메일)은 index.js가 넘긴다. 시험은 가짜로 돈다(test/health.test.js)
import { attempt, checkApi, checkGame } from './checks.js';

// 볼 곳. 게임 주소는 js/infra/site.js(NEW_SITE·OLD_SITE), 서버는 js/infra/api.js의 주소와 같아야 한다(test/health.test.js가 본다)
export const NEW_SITE = 'https://walkoff.kr/';
export const OLD_SITE = 'https://hyunseungbeom.github.io/walkoff/';
export const API = 'https://walkoff-api.walkoff-api.workers.dev';
// 보내는 주소(wrangler.toml allowed_sender_addresses와 같다). 받는 주소는 비밀값 ALERT_TO라 레포에 없다
export const FROM = 'alerts@walkoff.kr';
export const RETRY_MS = 25_000;         // 한 번 실패하면 이만큼 뒤 한 번 더 본다
export const REMIND_MS = 60 * 60_000;   // 같은 곳 장애 메일은 1시간에 한 번까지

// 시험(비밀값 ALERT_TEST=1)은 바깥 요청 없이 일부러 실패해 장애 메일을 내고, 비밀값을 지우면 복구 메일을 낸다(배포 뒤 메일 시험)
export const targets = (test) => [
  { key: 'new', name: '새 주소', url: NEW_SITE, run: (get) => checkGame(get, NEW_SITE, { mainOnly: true }), look: 'Cloudflare 대시보드 Workers & Pages › walkoff › Deployments(앞 배포로 Rollback)' },
  { key: 'old', name: '옛 주소', url: OLD_SITE, run: (get) => checkGame(get, OLD_SITE, { mainOnly: true }), look: 'https://github.com/HyunSeungBeom/walkoff/actions , https://www.githubstatus.com/' },
  { key: 'api', name: '서버', url: `${API}/rankings`, run: (get) => checkApi(get, API), look: 'Cloudflare 대시보드 Workers & Pages › walkoff-api › Logs·Deployments' },
  { key: 'test', name: '시험', url: '(바깥 요청 없음)', run: async () => { if (test) throw new Error('시험 모드(비밀값 ALERT_TEST)라 일부러 실패'); return '시험 모드 꺼짐'; }, look: '비밀값 ALERT_TEST를 지우면 5분 안에 복구 메일이 온다' },
];

const KIND = { down: '장애', still: '아직 장애', up: '복구' };

// 한 바퀴. prev는 KV에 둔 지난 상태 { [key]: { ok, since, note, mailed, lastMail } }이고, 처음 보는 곳은 정상이었다고 본다.
//  - 정상 → 실패: 장애 메일. 같은 곳에 1시간 안에 메일을 보냈으면(오르락내리락) 1시간이 찰 때까지 미룬다
//  - 실패가 이어짐: 마지막 메일에서 1시간이 지나면 '아직 장애' 메일
//  - 실패 → 정상: 이번 장애에 메일을 보냈으면 복구 메일
// 못 보낸 메일은 보낸 것으로 치지 않아 다음 바퀴에 다시 보낸다. 상태가 바뀐 바퀴(changed)에만 KV에 쓴다(무료 하루 쓰기 1,000번)
export async function round({ get, sleep, now, send, prev = {}, test = false }) {
  const results = await Promise.all(targets(test).map(async (t) => ({ ...t, ...(await attempt(() => t.run(get), { wait: RETRY_MS, sleep })) })));
  const at = now(), next = {}, sent = [], failed = [];
  for (const r of results) {
    const p = typeof prev[r.key]?.ok === 'boolean' ? prev[r.key] : { ok: true };
    const s = r.ok ? { ok: true } : { ok: false, since: p.ok ? at : p.since, note: p.ok ? r.note : p.note, mailed: !p.ok && !!p.mailed };
    if (p.lastMail) s.lastMail = p.lastMail;
    const due = !p.lastMail || at - p.lastMail >= REMIND_MS;
    const kind = r.ok ? (!p.ok && p.mailed ? 'up' : null) : due ? (s.mailed ? 'still' : 'down') : null;
    if (kind) {
      try {
        await send(mailFor(kind, r, kind === 'up' ? p : s, at, results));
        sent.push(`${KIND[kind]} ${r.name}`);
        if (kind !== 'up') Object.assign(s, { mailed: true, lastMail: at });
      } catch (e) { failed.push(`${KIND[kind]} ${r.name}: ${e?.code ? `${e.code} ` : ''}${e?.message ?? e}`); }
    }
    next[r.key] = s;
  }
  return { next, changed: JSON.stringify(next) !== JSON.stringify(prev), results, sent, failed };
}

const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`; };
const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 메일 제목·본문. 받는 사람은 운영자 한 사람이라 무엇이·언제부터·어디를 볼지만 짧게. st는 이번 장애의 상태(since·처음 note)
export function mailFor(kind, r, st, at, results) {
  const others = results.filter((x) => x.key !== r.key && x.key !== 'test').map((x) => `${x.name} ${x.ok ? '정상' : '실패'}`).join(' · ');
  const long = span(at - st.since), end = kst(at);
  const subject = `[walkoff] ${KIND[kind]}: ${r.name} (${kind === 'up' ? `장애 ${long}` : kind === 'still' ? `${long}째` : clip(r.note)})`;
  const lines = kind === 'up'
    ? [`[복구] ${r.name} ${r.url}`, `지금: ${r.note}`, `장애: ${kst(st.since)} ~ ${end.slice(0, 10) === kst(st.since).slice(0, 10) ? end.slice(11) : end} 한국 시간 (${long}), 처음 내용: ${st.note}`]
    : [`[${KIND[kind]}] ${r.name} ${r.url}`, `내용: ${r.note} (${RETRY_MS / 1000}초 뒤 한 번 더 봐도 실패)`, `처음 본 때: ${kst(st.since)} 한국 시간${kind === 'still' ? ` (${long}째)` : ''}`, `볼 곳: ${r.look}`];
  return {
    subject,
    text: [...lines, ...(others ? [`다른 곳: ${others}`] : []), '', '5분마다 보고, 같은 곳 장애 메일은 1시간에 한 번까지 보냅니다. 되살아나면 복구 메일을 한 통 보냅니다.', '— walkoff-health(Cloudflare Worker, 코드는 레포 worker/health)'].join('\n'),
  };
}
