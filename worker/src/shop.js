// 상점 물건과 코인 규칙(2026-10-29 사용자 결정). 물건 id·종류·가격은 게임과 같은 파일(js/core/catalog.js)을 그대로 쓴다(2026-11-03 코드 나누기.
// 전에는 여기에 복사본을 두고 테스트로 맞춰 봤다). 가격은 서버가 이 목록으로 정한다(게임이 보낸 가격은 믿지 않는다). 가격 0은 처음부터 가진 기본 물건이다
import { SLOTS, ITEMS } from '../../js/core/catalog.js';
export { SLOTS, ITEMS };

export const itemById = (id) => ITEMS.find((i) => i.id === id) ?? null;
export const DEFAULTS = Object.fromEntries(SLOTS.map((s) => [s, ITEMS.find((i) => i.slot === s && i.price === 0).id]));

// 판마다 점수의 1/100. 오늘의 10구 첫 판 2배(계정마다 하루 한 번)는 2026-10-30 오늘의 10구와 함께 없앴다
export const coinsFor = (score) => Math.floor(Math.max(0, score) / 100);
export const COIN_GAP_MS = 20_000;   // 같은 계정이 이보다 빨리 또 보내면 코인은 주지 않는다(10구 판은 30초 넘게 걸린다)

const parse = (json, fallback) => { try { return JSON.parse(json); } catch { return fallback; } };
export const ownedOf = (json) => { const v = parse(json, []); return Array.isArray(v) ? v.filter((id) => itemById(id)) : []; };

// 착용 상태: 종류마다 하나. 모르는 값이나 안 산 물건은 기본으로 돌리고, 등번호(no)는 등번호를 달았을 때만 남긴다
export function lookOf(equippedJson, owned) {
  const v = parse(equippedJson, {}), look = { ...DEFAULTS };
  for (const slot of SLOTS) {
    const it = itemById(v?.[slot]);
    if (it && it.slot === slot && (it.price === 0 || owned.includes(it.id))) look[slot] = it.id;
  }
  if (look.number === 'number-on' && Number.isInteger(v?.no) && v.no >= 0 && v.no <= 99) look.no = v.no;
  else look.number = 'number-none';
  return look;
}
