// 오늘의 미션(2026-11-23 사용자 '오늘의 미션', 규칙은 게임과 같은 js/core/missions.js). 10구 랭킹 판을 받을 때(/scores) 서버가 다시 돌린 판의
// 공마다 결과로 그날 미션 수를 세어 내 계정(accounts.missions, JSON)의 그날 진행에 더하고, 새로 채운 미션의 코인을 같은 UPDATE로 준다.
// 날은 서버가 받은 때의 한국 시간 날짜다(자정을 넘겨 끝낸 판은 새 날 미션에 든다). 게임이 '해냈다'고 알리는 방식은 꾸미기 쉬워서 쓰지 않는다
import { missionsOn, gameFacts, missionGain, advanceMissions, cleanMissionState } from '../../js/core/missions.js';
import { seqOf } from './rules.js';

// 계정 칸의 값(JSON 글)을 그날(day) 진행으로. 다른 날 값·망가진 값은 그날 빈 진행
export function missionsIn(raw, day) {
  let v = null;
  try { v = JSON.parse(raw ?? 'null'); } catch { /* 빈 진행 */ }
  return cleanMissionState(v, day);
}

// 다시 돌린 10구 판(rules.js validateSubmission의 value: results·seed·style·score)으로 그날 진행을 올린다. raw는 요청 처음에 읽은 계정 칸.
// 읽은 칸 그대로일 때만 고쳐 써서(같은 사람의 두 판이 동시에 와도 한쪽 수가 지워지지 않게) 어긋나면 다시 읽어 두 번 더 한다.
// 바뀌는 것이 없으면 쓰지 않는다(판당 D1 쓰기 한 줄을 아낀다). { state: 그날 진행, done: 이 판으로 채운 미션 차례, coins: 이 판으로 받은 미션 코인, bonus }
export async function grantMissions(db, playerId, raw, day, s) {
  const gain = missionGain(missionsOn(day), gameFacts(s.results, seqOf(s.seed, s.style), s.score));
  for (let k = 0; k < 3; k++) {
    const prev = missionsIn(raw, day), r = advanceMissions(prev, day, gain);
    if (JSON.stringify(r.state) === JSON.stringify(prev)) return r;
    const res = await db.prepare('UPDATE accounts SET missions = ?, coins = coins + ? WHERE player_id = ? AND missions IS ?')
      .bind(JSON.stringify(r.state), r.coins, playerId, raw ?? null).run();
    if (res.meta.changes > 0) return r;
    raw = (await db.prepare('SELECT missions FROM accounts WHERE player_id = ?').bind(playerId).first())?.missions ?? null;
  }
  return { state: missionsIn(raw, day), done: [], coins: 0, bonus: 0 };
}
