// 서버 통신: 계정, 번역 프록시, 기기 간 동기화
// API 키는 서버(Cloudflare Worker)에만 있고 이 앱에는 없다.

export const API_BASE = "https://biz-translator-api.deockhyeon.workers.dev";

const AUTH_KEY = "biztr.auth.v1";

export class ApiError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const MSG_OFFLINE = "인터넷이 끊겨 있습니다. 연결되면 자동으로 다시 시도합니다.";
export const MSG_NETWORK = "서버에 연결하지 못했습니다. 앱을 다시 열거나 연결되면 자동으로 다시 시도합니다.";
export const MSG_TIMEOUT = "서버 응답이 너무 늦습니다. 다시 시도해 주세요.";

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// 한 번 보내기. 제한 시간이 지나면 끊는다(휴대폰에서 연결이 조용히 멈춰 있는 경우가 있다).
async function sendOnce(path, { method, body, token, signal, timeoutMs }) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  } catch (err) {
    if (signal?.aborted) throw err; // 사용자가 취소한 것
    if (timedOut) return { error: new ApiError(MSG_TIMEOUT, 0, "timeout") };
    return { error: new ApiError(isOffline() ? MSG_OFFLINE : MSG_NETWORK, 0, isOffline() ? "offline" : "network") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 연결이 잠깐 끊기면(휴대폰 전파 · 앱 전환) 두어 번 더 보낸다.
// 503(서버가 「잠깐 다시」 라고 한 것)도 한 번 더 보낸다.
async function request(path, { method = "GET", body, token, signal, timeoutMs = 25000, tries = 3 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0) {
      if (isOffline()) break; // 인터넷이 없으면 기다려 봐야 소용없다
      await wait(i === 1 ? 800 : 2000);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
    const out = await sendOnce(path, { method, body, token, signal, timeoutMs });
    if (out.error) {
      last = out.error;
      if (out.error.code === "timeout") break; // 오래 기다린 뒤라 또 기다리게 하지 않는다
      continue;
    }
    const { res, data } = out;
    if (res.ok) return data;
    last = new ApiError(data?.error || `요청 실패 (${res.status})`, res.status, data?.code || "");
    if (res.status !== 503 || i >= 1) break; // 503 은 한 번만 더
  }
  throw last;
}

/* ---------- 계정 ---------- */

// 가입은 다시 보내면 「이미 가입」 · 「이미 쓴 초대 코드」 로 헷갈리게 실패하므로 한 번만 보낸다.
export const signup = (payload) => request("/api/auth/signup", { method: "POST", body: payload, tries: 1 });
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
    // 이미지 번역은 20~60초까지 걸린다. 번역은 돈이 드는 일이라 끊김 때 한 번만 더 보낸다.
    timeoutMs: 120000,
    tries: 2,
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
