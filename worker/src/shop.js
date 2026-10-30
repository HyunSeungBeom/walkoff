// 상점 물건과 코인 규칙(2026-10-29 사용자 결정). 게임(index.html)의 SHOP_ITEMS와 id·종류·가격이 같아야 하고 테스트가 맞춰 본다.
// 가격은 서버가 정한다(게임이 보낸 가격은 믿지 않는다). 가격 0은 처음부터 가진 기본 물건이다
export const SLOTS = ['bat', 'helmet', 'glove', 'shoe', 'uniform', 'number', 'trail', 'sound'];

export const ITEMS = [
  { id: 'bat-wood', slot: 'bat', price: 0 },
  { id: 'bat-maple', slot: 'bat', price: 120 },
  { id: 'bat-black', slot: 'bat', price: 150 },
  { id: 'bat-red', slot: 'bat', price: 150 },
  { id: 'bat-blue', slot: 'bat', price: 150 },
  { id: 'bat-silver', slot: 'bat', price: 400 },
  { id: 'bat-gold', slot: 'bat', price: 1000 },
  { id: 'bat-fire', slot: 'bat', price: 1200 },   // 2026-10-30 더한 물건
  { id: 'bat-lightning', slot: 'bat', price: 1200 },
  { id: 'bat-ice', slot: 'bat', price: 1000 },
  { id: 'bat-hammer', slot: 'bat', price: 800 },
  { id: 'bat-leek', slot: 'bat', price: 500 },
  { id: 'helmet-team', slot: 'helmet', price: 0 },
  { id: 'helmet-black', slot: 'helmet', price: 150 },
  { id: 'helmet-white', slot: 'helmet', price: 150 },
  { id: 'helmet-chrome', slot: 'helmet', price: 600 },
  { id: 'helmet-gold', slot: 'helmet', price: 1000 },
  { id: 'helmet-turtle', slot: 'helmet', price: 500 },
  { id: 'helmet-rabbit', slot: 'helmet', price: 500 },
  { id: 'helmet-bear', slot: 'helmet', price: 500 },
  { id: 'helmet-tiger', slot: 'helmet', price: 700 },
  { id: 'helmet-lion', slot: 'helmet', price: 700 },
  { id: 'helmet-dino', slot: 'helmet', price: 700 },
  { id: 'glove-white', slot: 'glove', price: 0 },
  { id: 'glove-black', slot: 'glove', price: 100 },
  { id: 'glove-red', slot: 'glove', price: 100 },
  { id: 'glove-blue', slot: 'glove', price: 100 },
  { id: 'glove-neon', slot: 'glove', price: 150 },
  { id: 'shoe-black', slot: 'shoe', price: 0 },
  { id: 'shoe-white', slot: 'shoe', price: 100 },
  { id: 'shoe-red', slot: 'shoe', price: 120 },
  { id: 'shoe-neon', slot: 'shoe', price: 150 },
  { id: 'shoe-gold', slot: 'shoe', price: 800 },
  { id: 'shoe-bear', slot: 'shoe', price: 400 },
  { id: 'shoe-tiger', slot: 'shoe', price: 400 },
  { id: 'shoe-rabbit', slot: 'shoe', price: 400 },
  { id: 'shoe-dino', slot: 'shoe', price: 400 },
  { id: 'shoe-duck', slot: 'shoe', price: 300 },
  { id: 'uniform-team', slot: 'uniform', price: 0 },
  { id: 'uniform-home', slot: 'uniform', price: 300 },
  { id: 'uniform-away', slot: 'uniform', price: 300 },
  { id: 'uniform-alt', slot: 'uniform', price: 500 },
  { id: 'number-none', slot: 'number', price: 0 },
  { id: 'number-on', slot: 'number', price: 300 },
  { id: 'trail-none', slot: 'trail', price: 0 },
  { id: 'trail-fire', slot: 'trail', price: 600 },
  { id: 'trail-rainbow', slot: 'trail', price: 800 },
  { id: 'trail-lightning', slot: 'trail', price: 800 },
  { id: 'trail-heart', slot: 'trail', price: 600 },
  { id: 'trail-star', slot: 'trail', price: 600 },
  { id: 'sound-wood', slot: 'sound', price: 0 },
  { id: 'sound-metal', slot: 'sound', price: 400 },
  { id: 'sound-toy', slot: 'sound', price: 300 },
  { id: 'sound-bomb', slot: 'sound', price: 700 },
  { id: 'sound-laser', slot: 'sound', price: 500 },
  { id: 'sound-bell', slot: 'sound', price: 400 },
  { id: 'sound-drum', slot: 'sound', price: 300 },
];
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
