// 진동: 안드로이드 브라우저(카톡 안 브라우저 포함)만 된다(navigator.vibrate). 아이폰은 웹 진동을 지원하지 않고, 숨긴 스위치로 진동을 내던
// 우회 방법도 iOS 26.5에서 막혀서 넣지 않았다(2026-10-29). 아이폰에는 메뉴의 진동 항목도 보이지 않는다.
// 메뉴에서 진동을 끈 사람은 main이 거른다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
export const canVibrate = typeof navigator.vibrate === 'function' && navigator.maxTouchPoints > 0;   // 데스크톱 크롬에도 함수는 있지만 울릴 게 없다
export function vibrate(pattern) {
  if (!canVibrate) return;
  try { navigator.vibrate(pattern); } catch { /* 진동을 못 해도 경기는 그대로 */ }
}
