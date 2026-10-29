// walkoff 랭킹 서버(Cloudflare Workers + D1). 10구 판(오늘의 10구 첫 판, 10구 도전) 점수를 받아
// 이번 주(한국 시간 월~일) 최고 기록으로 개인·팀 순위를 돌려준다. 점수는 카카오로 로그인한 사람만 낼 수 있다(2026-10-28 사용자 결정).
// 로그인 표는 쿠키가 아니라 Authorization 머리글로 받는다(게임과 서버 주소가 달라서 쿠키는 브라우저가 막는다)
import { kstDay, weekStart, addDays, validateSubmission, validateProfile, aggregate } from './rules.js';
import { allowedReturn, authorizeUrl, kakaoUserId, accountKey, newSession, newState, verify, sessionPlayer } from './auth.js';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'cache-control': 'no-store',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const SITE = 'https://hyunseungbeom.github.io/walkoff/';

async function weekRows(db, week) {
  const { results } = await db.prepare('SELECT player_id, day, nick, team, score FROM daily_scores WHERE week = ?').bind(week).all();
  return results;
}

// 합계 방식이던 예전 게임(fa4649a까지)은 사람 점수를 total로 읽는다. 열어 둔 탭까지 다 바뀔 때까지 같은 값을 total로도 보낸다
const withTotal = (p) => (p ? { ...p, total: p.best } : null);

// 이번 주 순위와 지난주 1등(사람, 팀)
async function rankings(db, week, playerId) {
  const [rows, lastRows] = await Promise.all([weekRows(db, week), weekRows(db, addDays(week, -7))]);
  const now = aggregate(rows, playerId), last = aggregate(lastRows, null);
  return {
    week, nextWeek: addDays(week, 7), ...now, players: now.players.map(withTotal), me: withTotal(now.me),
    lastWeek: { player: withTotal(last.players[0]), team: last.teams[0] ?? null },
  };
}

// ===== 카카오 로그인 =====
// 게임 → /auth/kakao/start → 카카오 로그인 → /auth/kakao/callback → 게임 주소#login=표&n=확인값.
// 확인값(n)은 게임이 만들어 이 브라우저에 적어 두고, 돌아왔을 때 같은지 본다(남이 만든 로그인 주소를 막는다)
const callbackUrl = (url) => `${url.origin}/auth/kakao/callback`;
const backTo = (url, params) => Response.redirect(`${url}#${new URLSearchParams(params)}`, 302);

async function loginStart(url, env, now) {
  const n = url.searchParams.get('n') ?? '', pid = url.searchParams.get('pid') ?? '';
  const back = allowedReturn(url.searchParams.get('return') ?? '');
  if (!back || !/^[A-Za-z0-9_-]{8,64}$/.test(n)) return json({ ok: false, error: 'bad_login_request' }, 400);
  if (!env.KAKAO_REST_KEY || !env.SESSION_SECRET || !env.ID_SALT) return backTo(back, { login_error: 'not_ready', n });
  const state = await newState(env, { n, r: back, pid: /^[a-z0-9-]{8,40}$/.test(pid) ? pid : '' }, now);
  return Response.redirect(authorizeUrl(env, callbackUrl(url), state), 302);
}

// 돌아갈 주소를 모를 때(오래 머물렀거나 주소가 망가짐) 보여 주는 안내
function expiredPage() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>walkoff</title>
<body style="margin:0;padding:48px 24px;font:16px/1.6 system-ui,sans-serif;text-align:center;background:#0b1424;color:#fff">
<p>로그인 시간이 지났어요.<br>게임으로 돌아가서 다시 눌러 주세요.</p><p><a style="color:#f2c94c" href="${SITE}">게임으로 돌아가기</a></p>`;
  return new Response(html, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// 처음 로그인하면 계정을 만든다. 이 브라우저가 쓰던 ID가 다른 계정에 묶여 있지 않으면 그대로 이어 써서
// 로그인 전 기록이 이어진다. 다른 기기에서 로그인하면 이미 있는 계정의 ID를 돌려준다
async function findOrCreateAccount(db, key, pid) {
  const find = () => db.prepare('SELECT player_id FROM accounts WHERE kakao_key = ?').bind(key).first();
  const found = await find();
  if (found) return found.player_id;
  const taken = !pid || await db.prepare('SELECT 1 AS x FROM accounts WHERE player_id = ?').bind(pid).first();
  await db.prepare('INSERT OR IGNORE INTO accounts (kakao_key, player_id) VALUES (?, ?)').bind(key, taken ? crypto.randomUUID() : pid).run();
  return (await find()).player_id;   // 두 번 눌러 동시에 들어와도 계정은 하나
}

async function loginCallback(url, env, now) {
  const st = await verify(env.SESSION_SECRET, url.searchParams.get('state') ?? '', 'st', now);
  if (!st) return expiredPage();
  const code = url.searchParams.get('code');
  if (!code) return backTo(st.r, { login_error: url.searchParams.get('error') === 'access_denied' ? 'canceled' : 'kakao', n: st.n });
  let kakaoId;
  try { kakaoId = await kakaoUserId(env, callbackUrl(url), code); } catch (e) {
    console.error(e);
    return backTo(st.r, { login_error: 'kakao', n: st.n });
  }
  const playerId = await findOrCreateAccount(env.DB, await accountKey(env.ID_SALT, kakaoId), st.pid);
  return backTo(st.r, { login: await newSession(env, playerId, now), n: st.n });
}

// 로그인 표의 계정. 기록을 지운 계정의 표는 받지 않는다
async function account(request, env, now) {
  const pid = await sessionPlayer(env, request, now);
  return pid ? env.DB.prepare('SELECT player_id, nick, team FROM accounts WHERE player_id = ?').bind(pid).first() : null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    const url = new URL(request.url), now = Date.now(), method = request.method;
    try {
      if (url.pathname === '/rankings' && method === 'GET') {
        const asked = url.searchParams.get('week') ?? '';
        const week = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? weekStart(asked) : weekStart(kstDay(now));
        return json(await rankings(env.DB, week, url.searchParams.get('player')));
      }
      if (url.pathname === '/auth/kakao/start' && method === 'GET') return await loginStart(url, env, now);
      if (url.pathname === '/auth/kakao/callback' && method === 'GET') return await loginCallback(url, env, now);

      const acct = url.pathname === '/scores' || url.pathname === '/me' ? await account(request, env, now) : null;
      if (url.pathname === '/scores' && method === 'POST') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        const checked = validateSubmission(await request.json().catch(() => null), now, acct.player_id);
        if (!checked.ok) return json({ ok: false, error: checked.error }, 400);
        const s = checked.value;
        // 같은 사람·같은 날은 그날 가장 높은 판만 남긴다(주간 순위는 이번 주 최고 기록). accepted는 그날 기록이 새로 생기거나 올랐다는 뜻.
        // 계정에는 마지막으로 쓴 닉네임·팀을 적어 둔다
        const [res] = await env.DB.batch([
          env.DB.prepare(`INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (player_id, day) DO UPDATE SET score = excluded.score, lights = excluded.lights, nick = excluded.nick, team = excluded.team
            WHERE excluded.score > daily_scores.score`)
            .bind(s.playerId, s.day, s.week, s.nick, s.team, s.score, s.lights),
          env.DB.prepare('UPDATE accounts SET nick = ?, team = ? WHERE player_id = ?').bind(s.nick, s.team, s.playerId),
        ]);
        const r = await rankings(env.DB, s.week, s.playerId);
        return json({ ok: true, accepted: res.meta.changes > 0, week: s.week, me: r.me, myTeam: r.myTeam, count: r.count });
      }
      if (url.pathname === '/me') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        if (method === 'GET') return json({ ok: true, playerId: acct.player_id, nick: acct.nick, team: acct.team });
        if (method === 'PUT') {   // 팀·닉네임 바꾸기. 닉네임은 랭킹에 바로 보이게 지난 기록에도 고쳐 쓴다(팀은 그날 팀 그대로)
          const checked = validateProfile(await request.json().catch(() => null));
          if (!checked.ok) return json({ ok: false, error: checked.error }, 400);
          const { nick, team } = checked.value;
          await env.DB.batch([
            env.DB.prepare('UPDATE accounts SET nick = ?, team = ? WHERE player_id = ?').bind(nick, team, acct.player_id),
            env.DB.prepare('UPDATE daily_scores SET nick = ? WHERE player_id = ?').bind(nick, acct.player_id),
          ]);
          return json({ ok: true });
        }
        if (method === 'DELETE') {   // 기록 지우기: 점수와 계정을 모두 지운다
          await env.DB.batch([
            env.DB.prepare('DELETE FROM daily_scores WHERE player_id = ?').bind(acct.player_id),
            env.DB.prepare('DELETE FROM accounts WHERE player_id = ?').bind(acct.player_id),
          ]);
          return json({ ok: true });
        }
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
