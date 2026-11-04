// 결과 공유: 모바일 공유 창(그림을 같이 보낼 수 있으면 카드 그림과 글을 함께), 안 되면 클립보드에 복사한다.
// 공유 글과 카드 그림은 main이 만든다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
export const canShareSheet = () => !!navigator.share;
export const canShareFiles = () => !!navigator.canShare;

// 그림(canvas)을 공유할 png 파일로 만든다. 다 되면 done(file)
export function pngFile(canvas, name, done) {
  canvas.toBlob((blob) => { if (blob) done(new File([blob], name, { type: 'image/png' })); }, 'image/png');
}

// 공유 창을 띄운다. 보냈거나 사람이 닫았으면 true, 공유 창이 안 되면 false(그때는 복사한다)
export async function shareSheet(text, file) {
  const data = file && navigator.canShare?.({ files: [file], text }) ? { files: [file], text } : { text };
  try { await navigator.share(data); return true; } catch (e) { return !!(e && e.name === 'AbortError'); }
}

// 클립보드에 복사한다. 안 되면 숨긴 글 칸으로 한 번 더. 복사했으면 true
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 아래 방법으로 한 번 더 */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
