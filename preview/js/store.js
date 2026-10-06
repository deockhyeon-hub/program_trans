// 상태 저장소: 채팅방/기록을 계정별로 이 기기의 localStorage에 보관한다.
// 서버와 동기화하므로 각 항목에 updatedAt(마지막 수정 시각)과 deleted(삭제 표시)를 함께 둔다.

const LEGACY_STATE_KEY = "biztr.state.v1";
// 로그인 이전 기록은 딱 한 계정에만 옮긴다 (같은 PC를 여러 사람이 쓰는 경우 대비).
const LEGACY_DONE_KEY = "biztr.legacy.migrated";
const SETTINGS_KEY = "biztr.settings.v1";
const statePrefix = "biztr.state.v2.";

const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 용량 초과 또는 저장소 차단
  }
}

export function newRoom({ name, lang = "EN", tone = "neutral", context = "", glossary = "" } = {}) {
  const now = Date.now();
  return {
    id: uid(),
    name: name || "새 채팅방",
    lang,
    tone,
    context,
    glossary,
    messages: [],
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
}

export function newMessage(source, direction) {
  const now = Date.now();
  return {
    id: uid(),
    source,
    direction,
    translation: "",
    note: "",
    status: "pending",
    error: "",
    // 이미지 첨부: 메타정보만 여기 두고 원본은 IndexedDB(js/images.js)에 따로 넣는다.
    images: [],
    userNote: "",
    ts: now,
    updatedAt: now,
    deleted: false,
  };
}

function normalizeImages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i && typeof i === "object")
    .slice(0, 4)
    .map((i) => ({
      name: String(i.name || "image").slice(0, 80),
      mediaType: String(i.mediaType || "image/png"),
      width: Number(i.width) || 0,
      height: Number(i.height) || 0,
    }));
}

function normalizeMessage(m) {
  return {
    id: typeof m.id === "string" ? m.id : uid(),
    source: m.source,
    direction: m.direction === "target->ko" ? "target->ko" : "ko->target",
    translation: typeof m.translation === "string" ? m.translation : "",
    note: typeof m.note === "string" ? m.note : "",
    // 새로고침으로 끊긴 요청은 재시도할 수 있게 오류로 돌린다.
    status: m.status === "done" ? "done" : "error",
    error: m.status === "done" ? "" : m.error || "번역이 중단되었습니다.",
    images: normalizeImages(m.images),
    userNote: typeof m.userNote === "string" ? m.userNote : "",
    ts: Number(m.ts) || Date.now(),
    updatedAt: Number(m.updatedAt) || Number(m.ts) || Date.now(),
    deleted: !!m.deleted,
  };
}

function normalizeRooms(rooms) {
  if (!Array.isArray(rooms)) return [];
  return rooms
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      ...newRoom(r),
      id: typeof r.id === "string" ? r.id : uid(),
      createdAt: Number(r.createdAt) || Date.now(),
      updatedAt: Number(r.updatedAt) || Number(r.createdAt) || Date.now(),
      deleted: !!r.deleted,
      messages: (Array.isArray(r.messages) ? r.messages : [])
        .filter((m) => m && typeof m.source === "string")
        .map(normalizeMessage),
    }));
}

export function stateKey(userId) {
  return statePrefix + (userId || "local");
}

export function loadState(userId, { createDefault = true } = {}) {
  const key = stateKey(userId);
  let saved = read(key, null);

  // 로그인 이전에 이 기기에서 쓰던 기록을 첫 로그인 때 한 번 옮겨 온다.
  if (!saved && !localStorage.getItem(LEGACY_DONE_KEY)) {
    const legacy = read(LEGACY_STATE_KEY, null);
    if (legacy?.rooms?.length) {
      saved = legacy;
      try {
        localStorage.setItem(LEGACY_DONE_KEY, String(Date.now()));
      } catch {
        /* 무시 */
      }
    }
  }

  const rooms = normalizeRooms(saved?.rooms);
  const alive = rooms.filter((r) => !r.deleted);
  // 서버에서 기록을 받아오기 전이라면 빈 기본 방을 만들지 않는다 (중복 생성 방지).
  if (!alive.length && createDefault) rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));

  const candidates = rooms.filter((r) => !r.deleted);
  const activeRoomId = candidates.some((r) => r.id === saved?.activeRoomId)
    ? saved.activeRoomId
    : candidates[0]?.id ?? null;

  return { rooms, activeRoomId, lastSyncAt: Number(saved?.lastSyncAt) || 0 };
}

export function saveState(userId, state) {
  return write(stateKey(userId), {
    rooms: state.rooms,
    activeRoomId: state.activeRoomId,
    lastSyncAt: state.lastSyncAt || 0,
  });
}

export function loadSettings() {
  // theme: auto | light | dark, textSize: m | l | xl (이 기기에만 저장)
  return { model: "claude-sonnet-5", theme: "auto", textSize: "m", ...read(SETTINGS_KEY, {}) };
}

export const saveSettings = (settings) => write(SETTINGS_KEY, settings);

export function exportBackup(state) {
  return JSON.stringify(
    {
      app: "biz-translator",
      version: 1,
      exportedAt: new Date().toISOString(),
      rooms: state.rooms.filter((r) => !r.deleted),
    },
    null,
    2,
  );
}

export function parseBackup(json) {
  const data = JSON.parse(json);
  if (data?.app !== "biz-translator") throw new Error("이 앱의 백업 파일이 아닙니다.");
  const rooms = normalizeRooms(data.rooms);
  if (!rooms.length) throw new Error("백업에 채팅방이 없습니다.");
  return rooms;
}

/* ---------- 동기화용 변환 ---------- */

/** 서버로 보낼 변경분만 추린다. */
export function collectChanges(state, since) {
  const rooms = state.rooms
    .filter((r) => (r.updatedAt || 0) > since)
    .map((r) => ({
      id: r.id,
      name: r.name,
      lang: r.lang,
      tone: r.tone,
      context: r.context,
      glossary: r.glossary,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deleted: r.deleted ? 1 : 0,
    }));

  const messages = [];
  for (const room of state.rooms) {
    for (const m of room.messages) {
      if ((m.updatedAt || 0) <= since) continue;
      if (m.status === "pending") continue; // 번역 중인 건 아직 보내지 않는다
      messages.push({
        id: m.id,
        roomId: room.id,
        ts: m.ts,
        source: m.source,
        direction: m.direction,
        translation: m.translation,
        note: m.note,
        error: m.error,
        updatedAt: m.updatedAt,
        deleted: m.deleted ? 1 : 0,
      });
    }
  }
  return { rooms, messages };
}

/** 서버에서 받은 변경분을 로컬 상태에 합친다. 최신 updatedAt이 이긴다. */
export function mergeFromServer(state, payload) {
  let maxSeen = 0;

  for (const sr of payload.rooms || []) {
    maxSeen = Math.max(maxSeen, sr.updated_at || 0);
    const local = state.rooms.find((r) => r.id === sr.id);
    const fields = {
      name: sr.name,
      lang: sr.lang,
      tone: sr.tone || "neutral",
      context: sr.context || "",
      glossary: sr.glossary || "",
      createdAt: sr.created_at || Date.now(),
      updatedAt: sr.updated_at || Date.now(),
      deleted: !!sr.deleted,
    };
    if (!local) {
      state.rooms.push({ ...newRoom(fields), ...fields, id: sr.id, messages: [] });
    } else if ((sr.updated_at || 0) > (local.updatedAt || 0)) {
      Object.assign(local, fields);
    }
  }

  for (const sm of payload.messages || []) {
    maxSeen = Math.max(maxSeen, sm.updated_at || 0);
    const room = state.rooms.find((r) => r.id === sm.room_id);
    if (!room) continue;
    const fields = {
      source: sm.source,
      direction: sm.direction === "target->ko" ? "target->ko" : "ko->target",
      translation: sm.translation || "",
      note: sm.note || "",
      error: sm.error || "",
      status: sm.translation ? "done" : "error",
      ts: sm.ts || Date.now(),
      updatedAt: sm.updated_at || Date.now(),
      deleted: !!sm.deleted,
    };
    if (!fields.translation && !fields.error) fields.error = "번역이 중단되었습니다.";

    const local = room.messages.find((m) => m.id === sm.id);
    if (!local) {
      // 이미지 원본은 찍은 기기에만 있다. 다른 기기에서는 추출된 글자만 보인다.
      room.messages.push({ id: sm.id, images: [], userNote: "", ...fields });
    } else if ((sm.updated_at || 0) > (local.updatedAt || 0)) {
      if (local.status !== "pending") Object.assign(local, fields);
    }
  }

  for (const room of state.rooms) room.messages.sort((a, b) => a.ts - b.ts);
  return maxSeen;
}
