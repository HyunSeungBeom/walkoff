// walkoff 랭킹 서버(Cloudflare Workers + D1). 10구 도전 점수를 받아 이번 주(한국 시간 월~일) 최고 기록으로 개인·팀 순위를 돌려준다.
// 점수는 카카오로 로그인한 사람만 낼 수 있고(2026-10-28 사용자 결정), 서버가 판마다 내준 시드로 친 판만 받는다(2026-10-30, seeds.js).
// 로그인 표는 쿠키가 아니라 Authorization 머리글로 받는다(게임과 서버 주소가 달라서 쿠키는 브라우저가 막는다)
import { kstDay, weekStart, addDays, validateSubmission, validateProfile, aggregate } from './rules.js';
import { allowedReturn, authorizeUrl, kakaoUserId, accountKey, newSession, newState, verify, sessionPlayer } from './auth.js';
import { itemById, coinsFor, COIN_GAP_MS, ownedOf, lookOf } from './shop.js';
import { validateEvent, recordEvent } from './stats.js';
import { issueSeed, findSeed, useSeed } from './seeds.js';

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
const ACCOUNT_COLS = 'player_id, nick, team, coins, owned, equipped';
const accountById = (db, pid) => db.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE player_id = ?`).bind(pid).first();
async function account(request, env, now) {
  const pid = await sessionPlayer(env, request, now);
  return pid ? accountById(env.DB, pid) : null;
}
// 게임에 돌려주는 지갑: 코인, 산 물건, 착용(look)
const wallet = (a) => { const owned = ownedOf(a.owned); return { coins: a.coins, owned, look: lookOf(a.equipped, owned) }; };

// 판마다 코인을 준다(점수의 1/100). 20초 안에 또 오면 주지 않는다.
// 조건을 UPDATE 안에 넣어서 같은 판을 두 번 보내도(네트워크 오류 뒤 다시 보내기 등) 한 번만 준다
async function earnCoins(db, playerId, score, now) {
  const earned = coinsFor(score);
  if (earned <= 0) return 0;
  const r = await db.prepare('UPDATE accounts SET coins = coins + ?, coin_at = ? WHERE player_id = ? AND coin_at <= ?').bind(earned, now, playerId, now - COIN_GAP_MS).run();
  return r.meta.changes > 0 ? earned : 0;
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
      // 이용 통계(stats.js). 게임은 sendBeacon으로 보내서 본문이 text/plain으로 온다. 로그인은 보지 않는다
      if (url.pathname === '/events' && method === 'POST') {
        const checked = validateEvent(await request.text().then((t) => JSON.parse(t)).catch(() => null));
        if (!checked.ok) return json({ ok: false, error: checked.error }, 400);
        await recordEvent(env.DB, checked.value, kstDay(now));
        return new Response(null, { status: 204, headers: HEADERS });
      }

      const acct = ['/seeds', '/scores', '/me', '/shop/buy', '/shop/equip'].includes(url.pathname) ? await account(request, env, now) : null;
      // 10구 도전 한 판의 시드와 일회용 표(seeds.js). 게임은 기다리지 않고 시작하려고 다음 판 표를 미리 받아 둔다
      if (url.pathname === '/seeds' && method === 'POST') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        const issued = await issueSeed(env.DB, acct.player_id, now);
        return json(issued, issued.ok ? 200 : 429);
      }
      if (url.pathname === '/scores' && method === 'POST') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        const body = await request.json().catch(() => null);
        const ticket = body?.mode === 'challenge' ? await findSeed(env.DB, body.token) : null;
        const checked = validateSubmission(body, now, acct.player_id, ticket);
        if (!checked.ok) return json({ ok: false, error: checked.error }, 400);
        const s = checked.value;
        // 같은 사람·같은 날은 그날 가장 높은 판만 남긴다(주간 순위는 이번 주 최고 기록). accepted는 그날 기록이 새로 생기거나 올랐다는 뜻.
        // 계정에는 마지막으로 쓴 닉네임·팀을 적어 둔다. 10구 도전의 표는 같은 묶음에서 쓴 것으로 적는다(점수가 못 들어가면 표도 남는다).
        // 같은 표로 동시에 두 번 보내면 둘 다 들어갈 수 있지만, 같은 공 순서라 그날 가장 높은 점수 하나만 남고 코인은 20초 간격으로 한 번이다
        const [res] = await env.DB.batch([
          env.DB.prepare(`INSERT INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (player_id, day) DO UPDATE SET score = excluded.score, lights = excluded.lights, nick = excluded.nick, team = excluded.team
            WHERE excluded.score > daily_scores.score`)
            .bind(s.playerId, s.day, s.week, s.nick, s.team, s.score, s.lights),
          env.DB.prepare('UPDATE accounts SET nick = ?, team = ? WHERE player_id = ?').bind(s.nick, s.team, s.playerId),
          ...(ticket ? [useSeed(env.DB, ticket, now)] : []),
        ]);
        const earned = await earnCoins(env.DB, s.playerId, s.score, now);
        const [r, after] = await Promise.all([rankings(env.DB, s.week, s.playerId), accountById(env.DB, s.playerId)]);
        return json({ ok: true, accepted: res.meta.changes > 0, week: s.week, me: r.me, myTeam: r.myTeam, count: r.count, coins: after.coins, earned });
      }
      if (url.pathname === '/me') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        if (method === 'GET') return json({ ok: true, playerId: acct.player_id, nick: acct.nick, team: acct.team, ...wallet(acct) });
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
            env.DB.prepare('DELETE FROM seed_tokens WHERE player_id = ?').bind(acct.player_id),
            env.DB.prepare('DELETE FROM accounts WHERE player_id = ?').bind(acct.player_id),
          ]);
          return json({ ok: true });
        }
      }
      // ===== 상점 =====
      if (url.pathname === '/shop/buy' && method === 'POST') {
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        const it = itemById((await request.json().catch(() => null))?.item);
        if (!it) return json({ ok: false, error: 'unknown_item' }, 400);
        if (it.price === 0) return json({ ok: false, error: 'free_item' }, 400);
        // 코인이 넉넉하고 아직 안 가진 물건일 때만 한 문장으로 코인을 빼고 물건을 넣는다(두 번 눌러도 한 번만 산다)
        const r = await env.DB.prepare(`UPDATE accounts SET coins = coins - ?, owned = json_insert(owned, '$[#]', ?)
          WHERE player_id = ? AND coins >= ? AND NOT EXISTS (SELECT 1 FROM json_each(accounts.owned) WHERE json_each.value = ?)`)
          .bind(it.price, it.id, acct.player_id, it.price, it.id).run();
        const after = await accountById(env.DB, acct.player_id);
        if (r.meta.changes === 0) return json({ ok: false, error: ownedOf(after.owned).includes(it.id) ? 'already_owned' : 'not_enough_coins', ...wallet(after) }, 400);
        return json({ ok: true, ...wallet(after) });
      }
      if (url.pathname === '/shop/equip' && method === 'POST') {   // 기본 물건이나 산 물건만 입는다. 등번호는 0~99
        if (!acct) return json({ ok: false, error: 'login_required' }, 401);
        const b = await request.json().catch(() => null), it = itemById(b?.item), owned = ownedOf(acct.owned);
        if (!it) return json({ ok: false, error: 'unknown_item' }, 400);
        if (it.price > 0 && !owned.includes(it.id)) return json({ ok: false, error: 'not_owned' }, 400);
        const look = lookOf(acct.equipped, owned);
        look[it.slot] = it.id;
        if (it.id === 'number-on') {
          if (!Number.isInteger(b.number) || b.number < 0 || b.number > 99) return json({ ok: false, error: 'bad_number' }, 400);
          look.no = b.number;
        } else if (it.slot === 'number') delete look.no;
        await env.DB.prepare('UPDATE accounts SET equipped = ? WHERE player_id = ?').bind(JSON.stringify(look), acct.player_id).run();
        return json({ ok: true, ...wallet({ ...acct, equipped: JSON.stringify(look) }) });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
