// walkoff 랭킹 서버(Cloudflare Workers + D1). 오늘의 10구 하루 첫 판 점수를 받아
// 이번 주(한국 시간 월~일) 개인·팀 순위를 돌려준다. 공개 점수판이라 로그인과 쿠키는 쓰지 않는다
import { kstDay, weekStart, addDays, validateSubmission, aggregate } from './rules.js';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });

async function weekRows(db, week) {
  const { results } = await db.prepare('SELECT player_id, day, nick, team, score FROM daily_scores WHERE week = ?1').bind(week).all();
  return results;
}

// 이번 주 순위와 지난주 1등(사람, 팀)
async function rankings(db, week, playerId) {
  const [rows, lastRows] = await Promise.all([weekRows(db, week), weekRows(db, addDays(week, -7))]);
  const now = aggregate(rows, playerId), last = aggregate(lastRows, null);
  return { week, nextWeek: addDays(week, 7), ...now, lastWeek: { player: last.players[0] ?? null, team: last.teams[0] ?? null } };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/rankings' && request.method === 'GET') {
        const asked = url.searchParams.get('week') ?? '';
        const week = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? weekStart(asked) : weekStart(kstDay(Date.now()));
        return json(await rankings(env.DB, week, url.searchParams.get('player')));
      }
      if (url.pathname === '/scores' && request.method === 'POST') {
        const checked = validateSubmission(await request.json().catch(() => null), Date.now());
        if (!checked.ok) return json({ ok: false, error: checked.error }, 400);
        const s = checked.value;
        // 같은 사람·같은 날은 첫 판만 남긴다
        const res = await env.DB.prepare('INSERT OR IGNORE INTO daily_scores (player_id, day, week, nick, team, score, lights) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
          .bind(s.playerId, s.day, s.week, s.nick, s.team, s.score, s.lights).run();
        const r = await rankings(env.DB, s.week, s.playerId);
        return json({ ok: true, accepted: res.meta.changes > 0, week: s.week, me: r.me, myTeam: r.myTeam, count: r.count });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
