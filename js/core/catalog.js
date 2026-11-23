// 팀 id와 상점 물건(id·종류·가격). 랭킹 서버(worker/src/rules.js·shop.js)가 이 파일을 그대로 가져다 쓴다(2026-11-03 코드 나누기.
// 전에는 서버에 복사본을 두고 tests/core가 같은지 봤다). 이름·색·모양은 화면 쪽(main.js의 TEAM_LOOKS·ITEM_LOOKS)이 맡는다

export const TEAM_IDS = ['kia', 'kt', 'lg', 'nc', 'ssg', 'doosan', 'lotte', 'samsung', 'kiwoom', 'hanwha'];   // KBO 10개 구단. 팀 고르기 화면도 이 순서다
// 팀 대항전(2026-11-23): 팀 점수는 그 주 팀원 최고 기록 가운데 위에서 이만큼의 합이다. 같은 팀 친구를 데려올수록 오르되 사람 수만으로 이기지는 않게
export const TEAM_TOP = 5;
// 지난주 1등 팀에서 친 사람의 이름 옆 표시는 이 날(한국 시간)부터 보인다. 처리방침에 적은 날 2026-11-24 + 7일(2026-11-23 사용자 '새로 보이는 값은 7일 뒤부터').
// 주 중간인 화요일이라 11-30 주 목록에 11-23 주 1등 팀 표시가 12-01부터 붙는다(2026-11-24 사용자, 대결과 같은 날)
export const CHAMP_FROM = '2026-12-01';

export const SLOTS = ['bat', 'helmet', 'glove', 'shoe', 'uniform', 'number', 'trail', 'sound'];

// 가격은 서버가 정한다(게임이 보낸 가격은 믿지 않는다). 가격 0은 처음부터 가진 기본 물건이다
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
  { id: 'bat-beam', slot: 'bat', price: 5000 },   // 2026-11-03 더한 고가 물건
  { id: 'bat-diamond', slot: 'bat', price: 4000 },
  { id: 'bat-baguette', slot: 'bat', price: 600 },   // 2026-11-10 더한 물건(보통 값 12개·비싼 것 4개)
  { id: 'bat-rainbow', slot: 'bat', price: 1500 },
  { id: 'bat-phoenix', slot: 'bat', price: 8000 },
  { id: 'bat-choco', slot: 'bat', price: 600 },   // 2026-11-12 더한 물건(13개, 사용자가 왼쪽 칸 후보에서 모두 고름)
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
  { id: 'helmet-crown', slot: 'helmet', price: 4000 },
  { id: 'helmet-astro', slot: 'helmet', price: 3000 },
  { id: 'helmet-panda', slot: 'helmet', price: 500 },
  { id: 'helmet-cat', slot: 'helmet', price: 500 },
  { id: 'helmet-halo', slot: 'helmet', price: 7000 },
  { id: 'helmet-penguin', slot: 'helmet', price: 500 },
  { id: 'glove-white', slot: 'glove', price: 0 },
  { id: 'glove-black', slot: 'glove', price: 100 },
  { id: 'glove-red', slot: 'glove', price: 100 },
  { id: 'glove-blue', slot: 'glove', price: 100 },
  { id: 'glove-neon', slot: 'glove', price: 150 },
  { id: 'glove-gold', slot: 'glove', price: 600 },
  { id: 'glove-leopard', slot: 'glove', price: 500 },
  { id: 'glove-fire', slot: 'glove', price: 1200 },
  { id: 'glove-catpaw', slot: 'glove', price: 500 },
  { id: 'glove-bearpaw', slot: 'glove', price: 500 },
  { id: 'glove-silver', slot: 'glove', price: 300 },
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
  { id: 'shoe-rocket', slot: 'shoe', price: 3000 },
  { id: 'shoe-bolt', slot: 'shoe', price: 2500 },
  { id: 'shoe-cat', slot: 'shoe', price: 400 },
  { id: 'shoe-panda', slot: 'shoe', price: 400 },
  { id: 'uniform-team', slot: 'uniform', price: 0 },
  { id: 'uniform-home', slot: 'uniform', price: 300 },
  { id: 'uniform-away', slot: 'uniform', price: 300 },
  { id: 'uniform-alt', slot: 'uniform', price: 500 },
  { id: 'uniform-legend', slot: 'uniform', price: 5000 },
  { id: 'uniform-neon', slot: 'uniform', price: 4000 },
  { id: 'uniform-stripe', slot: 'uniform', price: 600 },
  { id: 'uniform-retro', slot: 'uniform', price: 800 },
  { id: 'uniform-rainbow', slot: 'uniform', price: 8000 },
  { id: 'uniform-check', slot: 'uniform', price: 700 },
  { id: 'uniform-flower', slot: 'uniform', price: 800 },
  { id: 'uniform-galaxy', slot: 'uniform', price: 7000 },
  { id: 'number-none', slot: 'number', price: 0 },
  { id: 'number-on', slot: 'number', price: 300 },
  { id: 'trail-none', slot: 'trail', price: 0 },
  { id: 'trail-fire', slot: 'trail', price: 600 },
  { id: 'trail-rainbow', slot: 'trail', price: 800 },
  { id: 'trail-lightning', slot: 'trail', price: 800 },
  { id: 'trail-heart', slot: 'trail', price: 600 },
  { id: 'trail-star', slot: 'trail', price: 600 },
  { id: 'trail-comet', slot: 'trail', price: 4000 },
  { id: 'trail-dragon', slot: 'trail', price: 6000 },
  { id: 'trail-note', slot: 'trail', price: 600 },
  { id: 'trail-blossom', slot: 'trail', price: 800 },
  { id: 'trail-golddragon', slot: 'trail', price: 10000 },
  { id: 'trail-maple', slot: 'trail', price: 800 },
  { id: 'trail-snow', slot: 'trail', price: 800 },
  { id: 'sound-wood', slot: 'sound', price: 0 },
  { id: 'sound-metal', slot: 'sound', price: 400 },
  { id: 'sound-toy', slot: 'sound', price: 300 },
  { id: 'sound-bomb', slot: 'sound', price: 700 },
  { id: 'sound-laser', slot: 'sound', price: 500 },
  { id: 'sound-bell', slot: 'sound', price: 400 },
  { id: 'sound-drum', slot: 'sound', price: 300 },
  { id: 'sound-thunder', slot: 'sound', price: 2500 },
  { id: 'sound-8bit', slot: 'sound', price: 1500 },
  { id: 'sound-duck', slot: 'sound', price: 300 },
  { id: 'sound-cat', slot: 'sound', price: 300 },
  // 2026-11-23 더한 물건(사용자가 F 칸 시안에서 고름): 잘 팔리는 종류 보강, 세트 채우기
  { id: 'bat-scratcher', slot: 'bat', price: 600 },
  { id: 'bat-mackerel', slot: 'bat', price: 600 },
  { id: 'bat-umbrella', slot: 'bat', price: 500 },
  { id: 'bat-guitar', slot: 'bat', price: 1500 },
  { id: 'trail-paw', slot: 'trail', price: 600 },
  { id: 'trail-coin', slot: 'trail', price: 1500 },
  { id: 'trail-bubble', slot: 'trail', price: 600 },
  { id: 'trail-plane', slot: 'trail', price: 800 },
  { id: 'sound-dog', slot: 'sound', price: 300 },
  { id: 'sound-frog', slot: 'sound', price: 300 },
  { id: 'sound-gong', slot: 'sound', price: 500 },
  { id: 'sound-clap', slot: 'sound', price: 400 },
  { id: 'glove-pandapaw', slot: 'glove', price: 500 },
  { id: 'glove-rabbitpaw', slot: 'glove', price: 500 },
  { id: 'glove-dinoclaw', slot: 'glove', price: 500 },
  { id: 'glove-tigerpaw', slot: 'glove', price: 500 },
  { id: 'shoe-penguin', slot: 'shoe', price: 400 },
  // 겨울 한정(SALES.winter). 산타 썰매는 겨울 레전드(사용자 '레전드 상품 하나')
  { id: 'helmet-santa', slot: 'helmet', price: 800, sale: 'winter' },
  { id: 'helmet-rudolph', slot: 'helmet', price: 800, sale: 'winter' },
  { id: 'bat-bungeo', slot: 'bat', price: 600, sale: 'winter' },
  { id: 'glove-mitten', slot: 'glove', price: 400, sale: 'winter' },
  { id: 'shoe-furboot', slot: 'shoe', price: 400, sale: 'winter' },
  { id: 'uniform-santa', slot: 'uniform', price: 3000, sale: 'winter' },
  { id: 'trail-gift', slot: 'trail', price: 800, sale: 'winter' },
  { id: 'sound-jingle', slot: 'sound', price: 500, sale: 'winter' },
  { id: 'trail-sleigh', slot: 'trail', price: 10000, sale: 'winter' },
];

// 기간 한정 물건(2026-11-23 사용자 '겨울 한정'). 판매 첫날·마지막 날은 한국 시간 날짜다. 기간이 지나도 가진 사람은 계속 입고,
// 못 가진 사람의 상점에서는 숨긴다. 사기·선물은 서버가 이것으로 막는다(worker/src/index.js·gifts.js)
export const SALES = { winter: { from: '2026-12-01', to: '2026-12-31' } };
// 그날(한국 시간 'YYYY-MM-DD') 그 물건을 살 수 있는지: 'soon' 아직, 'on' 파는 중, 'over' 끝남. 기간이 없는 물건은 늘 'on'
export function saleOn(it, day) {
  const s = SALES[it?.sale];
  if (!s) return 'on';
  return day < s.from ? 'soon' : day > s.to ? 'over' : 'on';
}

// 선물하기(2026-11-10 사용자 결정): 상점 물건만 보내고, 한 사람이 하루(한국 시간)에 GIFTS_PER_DAY번, 10구 랭킹 판을 GIFT_MIN_GAMES판 넘게 친 계정만 보낸다(부계정 막기).
// 서버(worker/src/gifts.js)가 정하고, 게임은 안내 글에 쓴다
export const GIFTS_PER_DAY = 3;
export const GIFT_MIN_GAMES = 10;
