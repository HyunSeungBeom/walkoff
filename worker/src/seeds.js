// 10구 도전 시드(2026-10-30). 랭킹에 올라가는 판은 서버가 판마다 내준 시드로 친다.
// 게임이 시드를 정하던 때는 볼이 많이 나오는 시드를 골라 보내거나, 같은 시드로 공 순서를 미리 익혀 칠 수 있었다.
// 표 하나로는 점수를 한 번만 내고, 표를 받고 나서 그 판을 칠 시간이 지나야 받는다(rules.js의 validateSubmission).
// 타이밍은 여전히 게임이 재서 보내므로 정타만 친 것처럼 꾸민 판까지 막지는 못한다
// 서명한 표(2026-11-18 사용자, 홍보 전 서버 지키기): 표를 DB에 적지 않고 서버 서명(auth.js sign)만 붙여 주고, 점수·끝내기 코인과 함께 온 표만
// used_seeds에 한 줄 적는다. 전에는 표마다 seed_tokens에 넣고(표·기본 키 색인·player 색인 3줄) 사흘 뒤 지워(3줄) D1 쓰기의 81%였고,
// 받은 표의 3분의 2는 끝까지 안 친 판의 것이었다. 한 사람이 받는 수는 횟수 제한 바인딩(index.js, SEEDS_LIMIT)이 계정마다 센다.
// 바꾸기 전에 받은 예전 표(UUID, seed_tokens)는 사흘 안에 올 수 있어서 그대로 받는다
import { sign, verify } from './auth.js';

export const SEED_TTL_MS = 3 * 864e5;   // 표를 쓸 수 있는 기간. 늦게 보낸 기록은 이틀 전 것까지 받으므로 그보다 길게 둔다
export const MIN_PITCH_MS = 1500;       // 공 하나에 드는 가장 짧은 시간. 와인드업만 1.5초이고 공이 날아오고 결과를 보는 시간이 더 든다

// 게임이 전에 쓰던 시드(Date.now() % 2147483647)와 같은 범위 1 ~ 2^31-1
const randomSeed = () => (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1) || 1;
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const at13 = (ms) => String(ms).padStart(13, '0');
// 쓴 표의 열쇠: 내준 시각(13자리)과 표마다 다른 글자. 시각이 앞이라 기한이 지난 줄을 기본 키 범위로 지운다(dropOldSeeds)
const usedId = (p) => `${at13(p.i)}.${p.n}`;

// 표 내용: 종류 sd, 받은 계정 p, 시드 s, 내준 시각 i(이번 주 투수 유형도 이 시각으로 정한다, rules.js styleAt), 표마다 다른 글자 n
export const signSeed = (secret, playerId, seed, issuedAt) => sign(secret, { t: 'sd', p: playerId, s: seed, i: issuedAt, n: nonce(), exp: issuedAt + SEED_TTL_MS });

// 표를 하나 내준다. DB에는 적지 않는다
export async function issueSeed(secret, playerId, now) {
  const seed = randomSeed();
  return { ok: true, token: await signSeed(secret, playerId, seed, now), seed };
}

// 점수와 함께 온 표를 ticketError가 보는 모양({ id, player_id, seed, issued_at, used_at })으로. 없거나 서명·모양이 틀리면 null.
// 기한은 ticketError가 본다(seed_expired로 알리려고 verify에는 기한을 맡기지 않는다)
const OLD_TOKEN = /^[0-9a-f-]{36}$/;
export async function findSeed(db, secret, token) {
  if (typeof token !== 'string' || token.length > 400) return null;
  if (OLD_TOKEN.test(token)) return db.prepare('SELECT id, player_id, seed, issued_at, used_at FROM seed_tokens WHERE id = ?').bind(token).first();
  const p = await verify(secret, token, 'sd', 0);
  if (!p || typeof p.p !== 'string' || !Number.isInteger(p.s) || !Number.isInteger(p.i) || typeof p.n !== 'string') return null;
  const id = usedId(p), used = await db.prepare('SELECT used_at FROM used_seeds WHERE id = ?').bind(id).first();
  return { id, player_id: p.p, seed: p.s, issued_at: p.i, used_at: used?.used_at ?? null, signed: true };
}

// 한 판과 함께 온 표를 쓸 수 있는지(10구 도전 점수 rules.js, 끝내기 코인 scenario.js). 쓸 수 있으면 null, 아니면 오류 이름.
// pitches는 그 판의 공 수다. 표를 받고 나서 그 판을 칠 시간이 지나야 받는다
export function ticketError(token, ticket, playerId, nowMs, pitches) {
  if (!token) return 'seed_required';
  if (!ticket || ticket.player_id !== playerId) return 'bad_seed';   // 없는 표이거나 남의 표
  if (ticket.used_at != null) return 'seed_used';
  if (nowMs - ticket.issued_at > SEED_TTL_MS) return 'seed_expired';
  if (nowMs - ticket.issued_at < pitches * MIN_PITCH_MS) return 'too_fast';
  return null;
}

// 표를 쓴 것으로 적는다(10구 점수는 점수와 같은 묶음에서 적어서 점수가 못 들어가면 표도 남는다. 끝내기는 코인 전에).
// 이미 적힌 표면 바뀌는 줄이 없다(changes 0)
export const useSeed = (db, ticket, now) => (ticket.signed
  ? db.prepare('INSERT INTO used_seeds (id, used_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(ticket.id, now)
  : db.prepare('UPDATE seed_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, ticket.id));
// 기한이 지난 쓴 표를 지운다(쓴 표를 적는 묶음에 같이 넣는다). 기한이 지난 표는 어차피 받지 않는다
export const dropOldSeeds = (db, now) => db.prepare('DELETE FROM used_seeds WHERE id < ?').bind(at13(now - SEED_TTL_MS));
