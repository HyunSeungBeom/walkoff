// 물건 선물하기와 #번호(2026-11-10 패들렛 의견 '아이템 선물하기 기능? 돈이 남아요', 사용자 결정). 친구 기능 없이 닉네임을 적어 보낸다.
// 닉네임은 겹칠 수 있어서(accounts.nick은 UNIQUE가 아님) 계정마다 바뀌지 않는 무작위 번호(tag, 게임은 '골든#4821'로 보인다)로 가른다.
// 번호는 닉네임을 바꿔도 그대로다. 선물은 상점 물건만이고(코인은 주고받지 않는다), 보낸 사람 코인에서 상점 값이 그대로 빠진다
import { kstDay } from './rules.js';
import { ownedOf, lookOf } from './shop.js';
import { titlesIn, shownTitle } from './titles.js';
import { GIFTS_PER_DAY, GIFT_MIN_GAMES } from '../../js/core/catalog.js';   // 하루 보내는 수, 보낼 수 있는 계정의 랭킹 판 수(넘게). 게임도 안내 글에 쓴다
export { GIFTS_PER_DAY, GIFT_MIN_GAMES };

export const FIND_LIMIT = 10;       // 찾기 결과 수
const TAG_FULL = 8000;              // 4자리 번호(0~9999)가 80% 넘게 차면 5자리(10000~99999)로 늘린다

const randInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

// 번호가 없는 계정에 번호를 준다(새 계정은 findOrCreateAccount, 마이그레이션 0010 뒤에 생긴 번호 없는 계정은 처음 불러올 때).
// 무작위로 뽑아 이미 있으면 다시 뽑는다. 4자리에서 세 번 겹치면 그때만 4자리가 얼마나 찼는지 한 번 센다(평소에는 세지 않는다).
// 덜 찼어도 열 번 겹치면(80% 가까이 찼다) 5자리로 넘어가서 번호를 못 받는 일이 없게 한다.
// 이미 번호가 있으면 그 번호를 돌려준다(두 기기에서 동시에 들어와도 하나). 번호는 UNIQUE 색인이 마지막으로 지킨다
export async function giveTag(db, playerId) {
  let wide = false;
  for (let k = 0; k < 20; k++) {
    const tag = wide ? 10000 + randInt(90000) : randInt(10000);
    const r = await db.prepare('UPDATE accounts SET tag = ? WHERE player_id = ? AND tag IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE tag = ?)').bind(tag, playerId, tag).run();
    if (r.meta.changes > 0) return tag;
    const row = await db.prepare('SELECT tag FROM accounts WHERE player_id = ?').bind(playerId).first();
    if (!row || row.tag != null) return row?.tag ?? null;
    if (!wide && k === 2) wide = (await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE tag < 10000').first()).n >= TAG_FULL;
    if (k >= 9) wide = true;
  }
  return null;
}

// 찾기 글: '골든'(그 닉네임 모두) 또는 '골든#4821'(그 한 명). 번호는 게임이 4자리(5자리)로 보이는 그대로 받는다
export function parseFind(raw) {
  const q = String(raw ?? '').trim(), m = /^(.+?)\s*#(\d{4,5})$/.exec(q);
  const nick = (m ? m[1] : q).trim();
  if (!nick || [...nick].length > 10) return null;
  return { nick, tag: m ? Number(m[2]) : null };
}

// 받는 사람 찾기: 정확히 같은 닉네임(앞뒤 빈칸 뺌)만, 나는 빼고, 판을 많이 친 사람부터 FIND_LIMIT명.
// 랭킹처럼 닉네임·번호·팀·대표 칭호·입은 물건을 주고 계정 ID는 주지 않는다
export async function findPlayers(db, q, meId) {
  const { results } = await db.prepare(`SELECT nick, tag, team, owned, equipped, titles FROM accounts
    WHERE nick = ? AND tag IS NOT NULL AND player_id != ?${q.tag != null ? ' AND tag = ?' : ''} ORDER BY games DESC, tag LIMIT ${FIND_LIMIT}`)
    .bind(q.nick, meId, ...(q.tag != null ? [q.tag] : [])).all();
  return results.map((a) => ({ nick: a.nick, tag: a.tag, team: a.team, title: shownTitle(a.equipped, titlesIn(a.titles)), look: lookOf(a.equipped, ownedOf(a.owned)) }));
}

const sentToday = async (db, playerId, day) => (await db.prepare('SELECT COUNT(*) AS n FROM gifts WHERE sender = ? AND day = ?').bind(playerId, day).first()).n;
export const giftsLeft = async (db, playerId, now) => Math.max(0, GIFTS_PER_DAY - await sentToday(db, playerId, kstDay(now)));

// 못 보내는 까닭(없으면 null). from·to는 accounts 줄(coins·games·owned), sent는 그날 보낸 수
function giftError(from, to, it, sent) {
  if (!to) return 'no_player';
  if (to.player_id === from.player_id) return 'self';
  if (from.games <= GIFT_MIN_GAMES) return 'not_enough_games';
  if (sent >= GIFTS_PER_DAY) return 'daily_limit';
  if (from.coins < it.price) return 'not_enough_coins';
  if (ownedOf(to.owned).includes(it.id)) return 'already_owned';
  return null;
}

// 선물 한 번: 기록을 넣고, 보낸 사람 코인을 빼고, 받는 사람 물건에 넣는다(쓰기 3번). 셋을 한 묶음(batch)으로 하고,
// 기록을 넣는 문장이 조건(코인이 넉넉하다·받는 사람이 아직 없다·그날 보낸 수)을 다시 봐서 넣었을 때만 나머지 둘이 그 기록(id)을 보고 바뀐다.
// 그래서 두 번 누르거나 같은 물건을 둘이 동시에 보내도 한 번만 간다. 받은 물건은 바로 받는 사람 것이고 입는 것은 받는 사람이 한다(거절은 없다)
export async function sendGift(db, from, toTag, it, now) {
  const day = kstDay(now);
  const findTo = () => (Number.isInteger(toTag) ? db.prepare('SELECT player_id, nick, tag, owned FROM accounts WHERE tag = ?').bind(toTag).first() : null);
  const [to, sent] = await Promise.all([findTo(), sentToday(db, from.player_id, day)]);
  const error = giftError(from, to, it, sent);
  if (error) return { error, games: from.games };
  const id = crypto.randomUUID();
  const [ins] = await db.batch([
    db.prepare(`INSERT INTO gifts (id, sender, receiver, item, price, day, sent_at) SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT coins FROM accounts WHERE player_id = ?) >= ?
        AND NOT EXISTS (SELECT 1 FROM accounts, json_each(accounts.owned) WHERE accounts.player_id = ? AND json_each.value = ?)
        AND (SELECT COUNT(*) FROM gifts WHERE sender = ? AND day = ?) < ?`)
      .bind(id, from.player_id, to.player_id, it.id, it.price, day, now, from.player_id, it.price, to.player_id, it.id, from.player_id, day, GIFTS_PER_DAY),
    db.prepare('UPDATE accounts SET coins = coins - ? WHERE player_id = ? AND EXISTS (SELECT 1 FROM gifts WHERE id = ?)').bind(it.price, from.player_id, id),
    db.prepare(`UPDATE accounts SET owned = json_insert(owned, '$[#]', ?) WHERE player_id = ? AND EXISTS (SELECT 1 FROM gifts WHERE id = ?)`).bind(it.id, to.player_id, id),
  ]);
  if (ins.meta.changes > 0) return { to: { nick: to.nick, tag: to.tag }, left: GIFTS_PER_DAY - sent - 1 };
  // 그 사이 다른 요청이 먼저 바꿨다(코인을 썼거나, 받는 사람이 같은 물건을 받았거나, 다른 탭에서 보냈다). 다시 읽어 까닭을 알린다
  const [me, to2, sent2] = await Promise.all([db.prepare('SELECT player_id, coins, games FROM accounts WHERE player_id = ?').bind(from.player_id).first(), findTo(), sentToday(db, from.player_id, day)]);
  return { error: (me && giftError(me, to2, it, sent2)) ?? 'try_again', games: from.games };
}

// 받는 사람의 안 본 선물(메뉴 '선물이 왔어요' 띠). 새것부터 10개(같은 밀리초면 나중에 넣은 것부터), 보낸 사람의 지금 닉네임·번호와 함께
export async function inboxOf(db, playerId) {
  const { results } = await db.prepare(`SELECT g.id, g.item, g.sent_at, a.nick, a.tag FROM gifts g LEFT JOIN accounts a ON a.player_id = g.sender
    WHERE g.receiver = ? AND g.seen = 0 ORDER BY g.sent_at DESC, g.rowid DESC LIMIT 10`).bind(playerId).all();
  return results.map((g) => ({ id: g.id, item: g.item, at: g.sent_at, from: { nick: g.nick ?? null, tag: g.tag ?? null } }));
}

// 띠를 눌러 본 선물을 본 것으로 적는다(내가 받은 것만, 한 번에 10개까지)
export async function markSeen(db, playerId, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)).slice(0, 10);
  if (!list.length) return 0;
  const r = await db.prepare(`UPDATE gifts SET seen = 1 WHERE receiver = ? AND seen = 0 AND id IN (${list.map(() => '?').join(', ')})`).bind(playerId, ...list).run();
  return r.meta.changes;
}
