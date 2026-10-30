// 10구 도전 시드(2026-10-30). 랭킹에 올라가는 판은 서버가 판마다 내준 시드로 친다.
// 게임이 시드를 정하던 때는 볼이 많이 나오는 시드를 골라 보내거나, 같은 시드로 공 순서를 미리 익혀 칠 수 있었다.
// 표 하나로는 점수를 한 번만 내고, 표를 받고 나서 그 판을 칠 시간이 지나야 받는다(rules.js의 validateSubmission).
// 타이밍은 여전히 게임이 재서 보내므로 정타만 친 것처럼 꾸민 판까지 막지는 못한다
export const SEED_TTL_MS = 3 * 864e5;   // 표를 쓸 수 있는 기간. 늦게 보낸 기록은 이틀 전 것까지 받으므로 그보다 길게 둔다
export const SEEDS_PER_HOUR = 300;      // 한 사람이 한 시간에 받을 수 있는 표. 쉬지 않고 쳐도 한 시간에 100판 남짓이다
export const MIN_PITCH_MS = 1500;       // 공 하나에 드는 가장 짧은 시간. 와인드업만 1.5초이고 공이 날아오고 결과를 보는 시간이 더 든다

// 게임이 전에 쓰던 시드(Date.now() % 2147483647)와 같은 범위 1 ~ 2^31-1
const randomSeed = () => (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1) || 1;

// 표를 하나 내준다. 그 사람의 기한 지난 표는 이때 지운다
export async function issueSeed(db, playerId, now) {
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM seed_tokens WHERE player_id = ? AND issued_at > ?').bind(playerId, now - 3600e3).first();
  if (recent.n >= SEEDS_PER_HOUR) return { ok: false, error: 'too_many_seeds' };
  const token = crypto.randomUUID(), seed = randomSeed();
  await db.batch([
    db.prepare('DELETE FROM seed_tokens WHERE player_id = ? AND issued_at <= ?').bind(playerId, now - SEED_TTL_MS),
    db.prepare('INSERT INTO seed_tokens (id, player_id, seed, issued_at) VALUES (?, ?, ?, ?)').bind(token, playerId, seed, now),
  ]);
  return { ok: true, token, seed };
}

// 점수와 함께 온 표. 없거나 모양이 틀리면 null
export const findSeed = (db, token) => (typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token)
  ? db.prepare('SELECT id, player_id, seed, issued_at, used_at FROM seed_tokens WHERE id = ?').bind(token).first()
  : null);

// 점수를 남길 때 같은 묶음(batch)에서 표를 쓴 것으로 적는다. 점수가 못 들어가면 표도 그대로 남는다
export const useSeed = (db, ticket, now) => db.prepare('UPDATE seed_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, ticket.id);
