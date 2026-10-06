// 서버 통신: 계정, 번역 프록시, 기기 간 동기화
// API 키는 서버(Cloudflare Worker)에만 있고 이 앱에는 없다.

export const API_BASE = "https://biz-translator-api.deockhyeon.workers.dev";

const AUTH_KEY = "biztr.auth.v1";

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/* ---------- 세션 보관 ---------- */

export function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.token || !data?.user) return null;
    if (data.expiresAt && data.expiresAt < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  } catch {
    /* 저장소가 막혀 있어도 이번 세션은 동작한다 */
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* 무시 */
  }
}

/* ---------- 요청 ---------- */

async function request(path, { method = "GET", body, token, signal } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError("서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.", 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `요청 실패 (${res.status})`, res.status);
  }
  return data;
}

/* ---------- 계정 ---------- */

export const signup = (payload) => request("/api/auth/signup", { method: "POST", body: payload });
export const login = (payload) => request("/api/auth/login", { method: "POST", body: payload });
export const me = (token) => request("/api/auth/me", { token });
export const logout = (token) => request("/api/auth/logout", { method: "POST", token });
export const needsInvite = () => request("/api/auth/needs-invite");

/* ---------- 번역 ---------- */

export function translateRemote({ token, model, room, text, userNote = "", images = [], history = [], signal }) {
  return request("/api/translate", {
    method: "POST",
    token,
    signal,
    body: {
      model,
      text,
      // 이미지를 보낼 때만 채워진다. userNote는 "표만 번역해줘" 같은 사용자 지시.
      userNote,
      images,
      room: { lang: room.lang, tone: room.tone, context: room.context, glossary: room.glossary },
      history,
    },
  });
}

/* ---------- 동기화 ---------- */

export const syncPull = (token, since = 0) =>
  request(`/api/sync?since=${encodeURIComponent(since)}`, { token });

export const syncPush = (token, payload) =>
  request("/api/sync", { method: "POST", token, body: payload });

/* ---------- 관리자 ---------- */

export const createInvites = (token, payload) =>
  request("/api/admin/invites", { method: "POST", token, body: payload });

export const adminOverview = (token) => request("/api/admin/overview", { token });
