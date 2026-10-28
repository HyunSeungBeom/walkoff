// 카카오 로그인과 로그인 표. 비밀값(SESSION_SECRET, ID_SALT, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET)은
// Cloudflare 설정(wrangler secret)에만 있고 레포에는 없다
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// 서명한 표: 내용(JSON)과 서명을 점으로 잇는다. 내용은 누구나 읽을 수 있으니 비밀은 넣지 않는다
export async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

// 서명이 맞고, 종류(t)가 같고, 기한(exp)이 남았을 때만 내용을 돌려준다
export async function verify(secret, token, type, nowMs) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(parts[1]), enc.encode(parts[0])))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return p && p.t === type && typeof p.exp === 'number' && p.exp > nowMs ? p : null;
  } catch { return null; }
}

// 카카오 회원번호는 그대로 저장하지 않고 비밀값으로 바꾼 값만 계정 열쇠로 쓴다
export async function accountKey(salt, kakaoId) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(salt), enc.encode(`kakao:${kakaoId}`));
  return b64url(new Uint8Array(sig));
}

const SESSION_MS = 180 * 864e5;   // 로그인은 180일 동안 유지한다
const STATE_MS = 30 * 60e3;       // 카카오 로그인 화면에 머무를 수 있는 시간
export const newSession = (env, playerId, nowMs) => sign(env.SESSION_SECRET, { t: 's', p: playerId, exp: nowMs + SESSION_MS });
export const newState = (env, s, nowMs) => sign(env.SESSION_SECRET, { t: 'st', ...s, exp: nowMs + STATE_MS });

// Authorization: Bearer <표>에서 사람 ID를 꺼낸다
export async function sessionPlayer(env, request, nowMs) {
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '');
  return m ? (await verify(env.SESSION_SECRET, m[1], 's', nowMs))?.p ?? null : null;
}

// 로그인 뒤 돌아갈 게임 주소. 배포 주소와 이 컴퓨터에서 띄운 주소만 받는다
export function allowedReturn(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  const site = u.protocol === 'https:' && u.host === 'hyunseungbeom.github.io' && u.pathname.startsWith('/walkoff/');
  return local || site ? u.href : null;
}

// 카카오 주소. 로컬 확인 때만 KAKAO_AUTH_BASE·KAKAO_API_BASE로 가짜 카카오를 가리킨다
const authBase = (env) => env.KAKAO_AUTH_BASE || 'https://kauth.kakao.com';
const apiBase = (env) => env.KAKAO_API_BASE || 'https://kapi.kakao.com';

export function authorizeUrl(env, redirectUri, state) {
  const q = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, response_type: 'code', state });
  return `${authBase(env)}/oauth/authorize?${q}`;
}

// 인가 코드를 카카오 회원번호로 바꾼다. 카카오 토큰은 회원번호를 읽는 데만 쓰고 저장하지 않는다
export async function kakaoUserId(env, redirectUri, code) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, code });
  if (env.KAKAO_CLIENT_SECRET) form.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const res = await fetch(`${authBase(env)}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: form.toString(),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(`kakao token ${res.status} ${tok.error ?? ''}`);
  const me = await fetch(`${apiBase(env)}/v2/user/me`, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const user = await me.json().catch(() => ({}));
  if (!me.ok || user.id == null) throw new Error(`kakao me ${me.status}`);
  return String(user.id);
}
