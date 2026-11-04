// 저장소: 이 브라우저(localStorage)에만 남는다. 키 앞에 'walkoff.'를 붙인다. 사생활 보호 모드처럼 저장소를 못 쓰면 기본값으로 돈다
// (2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('walkoff.' + key);
      if (v == null) return fallback;
      try { return JSON.parse(v); } catch { return v; }
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('walkoff.' + key, typeof value === 'string' ? value : JSON.stringify(value)); } catch { /* 저장 못 해도 지금 판은 된다 */ }
  },
  keys(prefix) {
    try { return Object.keys(localStorage).filter((k) => k.startsWith('walkoff.' + prefix)).map((k) => k.slice('walkoff.'.length)); } catch { return []; }
  },
  remove(key) {
    try { localStorage.removeItem('walkoff.' + key); } catch { /* 저장소를 못 쓰면 지울 것도 없다 */ }
  },
};

// 랭킹에서 이 브라우저를 구별하는 무작위 ID. 이름이나 기기 정보는 담지 않는다
export function ensurePlayerId() {
  const saved = String(store.get('playerId', ''));
  if (/^[a-z0-9-]{8,40}$/.test(saved)) return saved;
  const id = globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  store.set('playerId', id);
  return id;
}
