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

// 번역은 흘려받는다(2026-10-23). 서버가 한 줄에 사건 하나씩 보낸다(NDJSON):
//   start → meta{direction} → delta{text}… → done{result} → (이미지면) source{text}
//   도중에 reset(다시 쓰기) 또는 error{status,error,code}
// done 이 오면 바로 돌려주고, 뒤따라 오는 source(이미지에서 읽은 원문)는 onEvent 로 알린다.
// 옛 서버처럼 JSON 한 덩어리로 와도 받는다.
const TRANSLATE_TIMEOUT = 120000; // 전체
const TRANSLATE_IDLE = 45000;     // 아무 소식 없이 이만큼 지나면 끊긴 것으로 본다

function streamTranslateOnce(body, { token, signal, onEvent }) {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    let settled = false;
    let started = false;
    let reason = "";
    let idleTimer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve({ ...out, started });
    };
    const stopAll = () => {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const kick = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { reason = "timeout"; ctl.abort(); }, TRANSLATE_IDLE);
    };
    const totalTimer = setTimeout(() => { reason = "timeout"; ctl.abort(); }, TRANSLATE_TIMEOUT);
    const onAbort = () => { reason = "user"; ctl.abort(); };
    signal?.addEventListener("abort", onAbort);
    kick();

    const netError = () => {
      if (reason === "user") return { abort: true };
      if (reason === "timeout") return { error: new ApiError(MSG_TIMEOUT, 0, "timeout") };
      return { error: new ApiError(isOffline() ? MSG_OFFLINE : MSG_NETWORK, 0, isOffline() ? "offline" : "network") };
    };

    (async () => {
      let res;
      try {
        res = await fetch(API_BASE + "/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch {
        stopAll();
        finish(netError());
        return;
      }
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.includes("ndjson") || !res.body) {
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        stopAll();
        if (res.ok && data) finish({ result: data });
        else finish({ error: new ApiError(data?.error || `요청 실패 (${res.status})`, res.status, data?.code || "") });
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.type === "done") {
          finish({ result: ev.result });
          // 이미지 원문을 기다릴 때는 조금 더 듣는다.
          if (!ev.result?.sourcePending) { stopAll(); ctl.abort(); }
          return;
        }
        if (ev.type === "error") {
          finish({ error: new ApiError(ev.error || "번역에 실패했습니다.", ev.status || 502, ev.code || "") });
          stopAll();
          ctl.abort();
          return;
        }
        if (ev.type === "delta" || ev.type === "meta") started = true;
        if (ev.type === "source") {
          stopAll();
          ctl.abort();
        }
        try { onEvent?.(ev); } catch { /* 화면 갱신 실패는 번역을 막지 않는다 */ }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          buf += dec.decode(value, { stream: true });
          let k;
          while ((k = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, k).trim();
            buf = buf.slice(k + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            handle(ev);
          }
        }
      } catch {
        /* 끊김 또는 우리가 끊은 것 */
      }
      stopAll();
      if (!settled) finish(netError());
    })();
  });
}

export async function translateRemote({ token, model, room, text, userNote = "", images = [], history = [], signal, onEvent }) {
  const body = {
    model,
    text,
    // 이미지를 보낼 때만 채워진다. userNote는 "표만 번역해줘" 같은 사용자 지시.
    userNote,
    images,
    room: { lang: room.lang, tone: room.tone, context: room.context, glossary: room.glossary },
    history,
    stream: true,
  };
  // 번역은 돈이 드는 일이라 끊김 때 한 번만 더 보낸다.
  let last = null;
  for (let i = 0; i < 2; i += 1) {
    if (i > 0) {
      if (isOffline()) break;
      await wait(800);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
    const out = await streamTranslateOnce(body, { token, signal, onEvent });
    if (out.abort) throw new DOMException("Aborted", "AbortError");
    if (out.result) return out.result;
    last = out.error;
    if (out.started) onEvent?.({ type: "reset" }); // 반쯤 쓴 글을 지우고 다시
    if (last.code === "timeout") break; // 오래 기다린 뒤라 또 기다리게 하지 않는다
    if (last.status !== 0 && last.status !== 503) break; // 끊김 · 503 만 한 번 더
  }
  throw last;
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
