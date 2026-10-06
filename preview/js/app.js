import { LANGUAGES, languageByCode, looksKorean, translate } from "./translator.js";
import {
  loadState, saveState, stateKey, loadSettings, saveSettings,
  newRoom, newMessage, exportBackup, parseBackup,
  collectChanges, mergeFromServer,
} from "./store.js";
import * as api from "./api.js";
import {
  MAX_IMAGES, prepareImage, toPayload, toMeta,
  saveImages, loadImages, removeImages,
} from "./images.js";

const $ = (id) => document.getElementById(id);

let auth = api.loadAuth();          // { token, user, expiresAt }
let state = null;                    // 로그인 후 채워진다
let settings = loadSettings();
let editingRoomId = null;            // null이면 새 채팅방 생성 중
let authMode = "login";              // "login" | "signup"
let syncing = false;
let syncTimer = null;
let attachments = [];                // 아직 보내지 않은 첨부 이미지
let dragDepth = 0;                   // dragenter/leave가 자식 요소마다 터져서 세어 둬야 한다

const el = {
  app: $("app"), backdrop: $("backdrop"), auth: $("auth"),
  roomList: $("room-list"), roomName: $("room-name"), roomMeta: $("room-meta"),
  messages: $("messages"), input: $("input"), send: $("btn-send"),
  attachments: $("attachments"), fileImage: $("file-image"), dropzone: $("dropzone"),
  dlgRoom: $("dlg-room"), dlgSettings: $("dlg-settings"), dlgImage: $("dlg-image"),
  toast: $("toast"),
};

const liveRooms = () => state.rooms.filter((r) => !r.deleted);
const liveMessages = (room) => room.messages.filter((m) => !m.deleted);

function activeRoom() {
  const rooms = liveRooms();
  return rooms.find((r) => r.id === state.activeRoomId) ?? rooms[0];
}

const touch = (item) => { item.updatedAt = Date.now(); };

function persist({ sync = true } = {}) {
  if (!saveState(auth?.user?.id, state)) {
    toast("저장 공간이 부족합니다. 설정에서 기록을 내보낸 뒤 오래된 채팅방을 정리해 주세요.");
  }
  if (sync) scheduleSync();
}

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- 동기화 ---------- */

function scheduleSync() {
  if (!auth?.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { runSync(); }, 1200);
}

async function runSync({ silent = true } = {}) {
  if (!auth?.token || syncing || !state) return;
  syncing = true;
  try {
    const since = state.lastSyncAt || 0;

    const changes = collectChanges(state, since);
    if (changes.rooms.length || changes.messages.length) {
      await api.syncPush(auth.token, changes);
    }

    const pulled = await api.syncPull(auth.token, since);
    const maxSeen = mergeFromServer(state, pulled);
    state.lastSyncAt = Math.max(since, maxSeen);

    ensureRoom();
    saveState(auth.user.id, state);
    renderAll();
  } catch (err) {
    if (err.status === 401) {
      handleSignedOut("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    // 서버에 닿지 못해도 빈 화면을 보여주지는 않는다.
    if (ensureRoom()) {
      saveState(auth.user.id, state);
      renderAll();
    }
    if (!silent) toast(err.message || "동기화하지 못했습니다.");
  } finally {
    syncing = false;
  }
}

/** 방이 하나도 없거나 현재 방이 사라졌을 때 정리한다. */
function ensureRoom() {
  let changed = false;
  if (!liveRooms().length) {
    state.rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
    changed = true;
  }
  if (!activeRoom()) {
    state.activeRoomId = liveRooms()[0].id;
    changed = true;
  }
  return changed;
}

/* ---------- 렌더링 (이든팜 공통 디자인 부품 — design/docs/화면규칙.md 7-3절) ---------- */

// 선 아이콘 (공통 규칙: 선 1.8 · 16)
const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  retry: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  delete: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
};

function iconButton(action, label) {
  const btn = h("button", "ds-ib");
  btn.type = "button";
  btn.dataset.action = action;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[action]}</svg>`;
  return btn;
}

// 언어 = 분류 꼬리표(dsTag 규칙). 같은 언어는 어느 방에서나 같은 색.
const LANG_TAG = { EN: 1, VI: 2, TH: 3, ZH: 4, JA: 5, ID: 6, FR: 7, DE: 8, TW: 4, ES: 6, PT: 7, RU: 3, AR: 8 };
const TONE_LABEL = { formal: "격식", neutral: "정중·표준", friendly: "친근" };

function hashIndex(text, n) {
  let x = 0;
  for (const ch of String(text)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return (x % n) + 1;
}

function langTag(code) {
  const tag = h("span", `ds-tag c${LANG_TAG[code] || hashIndex(code, 8)}`, code);
  tag.title = languageByCode(code).label;
  return tag;
}

function renderRooms() {
  el.roomList.replaceChildren(...liveRooms().map((room) => {
    const lang = languageByCode(room.lang);
    const li = h("li", room.id === state.activeRoomId ? "tr-room on" : "tr-room");
    li.dataset.id = room.id;
    li.title = room.name;
    if (room.id === state.activeRoomId) li.setAttribute("aria-current", "true");
    const last = liveMessages(room).at(-1);
    const preview = last ? (last.source || last.translation || "이미지") : `한국어 ↔ ${lang.label}`;
    const txt = h("div", "tr-room__txt");
    txt.append(h("span", "tr-room__nm", room.name), h("span", "tr-room__last", preview));
    li.append(langTag(room.lang), txt);
    return li;
  }));
}

/** 메뉴 맨 아래 내 계정: 이름 꼬리표(dsWho 규칙 — 성까지 전체 이름) + 역할 */
function renderMe() {
  const user = auth?.user;
  if (!user) return;
  const name = user.name || (user.email || "").split("@")[0];
  const tag = $("me-name");
  tag.textContent = name;
  tag.className = `ds-who w${hashIndex(user.email || name, 16)}`;
  tag.title = user.email || name;
  $("me-role").textContent = user.role === "admin" ? "관리자" : "직원";
}

function renderHead() {
  const room = activeRoom();
  if (!room) return;
  const lang = languageByCode(room.lang);
  el.roomName.textContent = room.name;
  el.roomMeta.textContent = `한국어 ↔ ${lang.label} · ${TONE_LABEL[room.tone] || TONE_LABEL.neutral}`;
  el.input.placeholder = `한국어 또는 ${lang.label}로 입력하세요`;
}

/** 첨부 이미지 썸네일. 원본은 이 기기 IndexedDB에만 있어서 비동기로 채운다. */
function imagesNode(msg) {
  const box = h("div", "tr-imgs");
  msg.images.forEach((meta, index) => {
    const img = document.createElement("img");
    img.alt = meta.name || "첨부한 이미지";
    img.loading = "lazy";
    img.dataset.index = String(index);
    box.append(img);
  });

  loadImages(msg.id).then((items) => {
    for (const img of [...box.querySelectorAll("img")]) {
      const item = items?.[Number(img.dataset.index)];
      if (item?.dataUrl) img.src = item.dataUrl;
      else img.replaceWith(h("div", "tr-thumb-missing", "이 기기에 원본 없음"));
    }
  }).catch(() => { /* 썸네일은 못 보여도 번역문은 보인다 */ });

  return box;
}

function messageNode(msg) {
  const side = msg.direction === "ko->target" ? "me" : "partner";
  const node = h("article", `tr-msg ${side}${msg.status === "done" ? "" : ` ${msg.status}`}`);
  node.dataset.id = msg.id;

  const hasImages = !!msg.images?.length;
  if (hasImages) node.append(imagesNode(msg));
  if (msg.userNote) node.append(h("p", "tr-src", msg.userNote));
  if (msg.source) {
    if (hasImages) node.append(h("span", "ds-tag tr-ocr", "이미지에서 읽은 글자"));
    node.append(h("p", "tr-src", msg.source));
  }

  // 진행 중 = 상태 알약(progress). 오류 = 사라지지 않는 띠(critical).
  if (msg.status === "pending") {
    node.append(h("span", "ds-badge progress", hasImages ? "글자를 읽고 번역하는 중" : "번역 중"));
    return node;
  }

  if (msg.status === "done") {
    node.append(h("div", "tr-bubble", msg.translation));
    if (msg.note) {
      const note = h("p", "tr-note");
      note.append(h("b", "", "참고"), h("span", "", msg.note));
      node.append(note);
    }
  } else {
    node.append(h("div", "ds-banner critical tr-err", msg.error));
  }

  const tools = h("div", "tr-tools");
  if (msg.status === "done") {
    const lang = languageByCode(activeRoom().lang).label;
    tools.append(h("span", "tr-dir", msg.direction === "ko->target" ? `한국어 → ${lang}` : `${lang} → 한국어`));
    tools.append(iconButton("copy", "번역문 복사"), iconButton("retry", "다시 번역"));
  } else {
    const retry = h("button", "ds-btn sm", "재시도");
    retry.type = "button";
    retry.dataset.action = "retry";
    tools.append(retry);
  }
  tools.append(iconButton("delete", "삭제"));
  node.append(tools);
  return node;
}

function renderMessages({ scroll = true } = {}) {
  const room = activeRoom();
  if (!room) return;
  const list = liveMessages(room);
  if (!list.length) {
    const empty = h("div", "tr-empty");
    const lang = languageByCode(room.lang).label;
    empty.append(
      h("strong", "", "비즈니스 문맥에 맞춰 번역합니다"),
      h("p", "", `한국어를 입력하면 ${lang}로, ${lang}를 입력하면 한국어로 번역합니다. 직역이 아니라 실제 업무 메일·메신저에서 쓰는 자연스러운 표현으로 다듬습니다.`),
      h("p", "", "이미지도 됩니다. 메일 캡처·견적서 사진을 끌어다 놓거나 Ctrl+V로 붙여넣으면 속의 글자를 읽어 번역합니다."),
    );
    el.messages.replaceChildren(empty);
    return;
  }
  el.messages.replaceChildren(...list.map(messageNode));
  if (scroll) el.messages.scrollTop = el.messages.scrollHeight;
}

function renderAll() {
  if (!state) return;
  renderRooms();
  renderHead();
  renderMessages();
}

/* ---------- 번역 ---------- */

async function runTranslation(room, msg) {
  msg.status = "pending";
  msg.error = "";
  if (room.id === state.activeRoomId) renderMessages();

  // 이미지 원본은 찍은 기기에만 있다. 다른 기기면 추출된 글자만으로 다시 번역한다.
  let images = [];
  if (msg.images?.length) {
    const stored = await loadImages(msg.id).catch(() => []);
    images = (stored || []).map(toPayload);
    if (!images.length && !msg.source) {
      Object.assign(msg, {
        status: "error",
        error: "이 기기에는 원본 이미지가 남아 있지 않습니다. 이미지를 다시 첨부해 주세요.",
      });
      touch(msg);
      persist();
      if (room.id === state.activeRoomId) renderMessages();
      return;
    }
  }

  try {
    const history = liveMessages(room).slice(0, liveMessages(room).indexOf(msg));
    const result = await translate({
      token: auth.token,
      model: settings.model,
      room,
      text: images.length ? "" : msg.source,
      userNote: images.length ? msg.userNote || "" : "",
      images,
      history,
    });
    // 이미지에서 읽어낸 글자를 원문으로 삼는다. 그래야 다른 기기·다음 번역 문맥에도 남는다.
    if (images.length && result.extractedText) msg.source = result.extractedText;
    Object.assign(msg, {
      status: "done",
      direction: result.direction,
      translation: result.translation,
      note: result.note,
      error: "",
    });
  } catch (err) {
    if (err.status === 401) {
      handleSignedOut("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    Object.assign(msg, { status: "error", error: err.message || "알 수 없는 오류가 발생했습니다." });
  }

  // 번역 중에 메시지나 채팅방이 삭제됐을 수 있다.
  if (!state.rooms.includes(room) || !room.messages.includes(msg)) return;
  touch(msg);
  persist();
  renderRooms();
  if (room.id === state.activeRoomId) renderMessages();
}

function send() {
  const text = el.input.value.trim();
  const images = attachments;
  if (!text && !images.length) return;
  const room = activeRoom();
  if (!room) return;

  const msg = newMessage(images.length ? "" : text, looksKorean(text) ? "ko->target" : "target->ko");
  if (images.length) {
    msg.images = images.map(toMeta);
    msg.userNote = text;          // 함께 적은 말은 번역 대상이 아니라 지시로 다룬다
    msg.direction = "target->ko"; // 대개 외국어 문서다. 최종 방향은 모델이 정한다.
    saveImages(msg.id, images);   // 메모리 캐시는 즉시 채워져서 썸네일이 바로 보인다
  }

  room.messages.push(msg);
  el.input.value = "";
  setAttachments([]);
  autosize();
  persist({ sync: false });
  runTranslation(room, msg);
}

/* ---------- 이미지 첨부 ---------- */

function setAttachments(list) {
  attachments = list;
  const box = el.attachments;
  if (!attachments.length) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  const nodes = attachments.map((image, index) => {
    const item = h("div", "tr-attach__it");
    const thumb = document.createElement("img");
    thumb.src = image.dataUrl;
    thumb.alt = image.name;
    const remove = h("button", "ds-x", "✕");
    remove.type = "button";
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `${image.name} 빼기`);
    item.append(thumb, remove);
    return item;
  });
  nodes.push(h("span", "tr-attach__hint", `이미지 ${attachments.length}장 · 속의 글자를 읽어 번역합니다`));
  box.replaceChildren(...nodes);
  box.hidden = false;
}

async function addImageFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f && f.type.startsWith("image/"));
  if (!files.length) return;
  const room = MAX_IMAGES - attachments.length;
  if (room <= 0) {
    toast(`이미지는 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다.`);
    return;
  }

  const added = [];
  for (const file of files.slice(0, room)) {
    try {
      added.push(await prepareImage(file));
    } catch (err) {
      toast(err.message || "이미지를 읽지 못했습니다.");
    }
  }
  if (added.length) setAttachments([...attachments, ...added]);
  if (files.length > room) toast(`이미지는 한 번에 ${MAX_IMAGES}장까지만 보냅니다.`);
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function showImage(dataUrl) {
  $("dlg-image-view").src = dataUrl;
  el.dlgImage.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("번역문을 복사했습니다.");
  } catch {
    toast("복사하지 못했습니다. 길게 눌러 직접 복사해 주세요.");
  }
}

/* ---------- 채팅방 ---------- */

function selectRoom(id) {
  state.activeRoomId = id;
  persist({ sync: false });
  closeSidebar();
  renderAll();
}

function openRoomDialog(room) {
  editingRoomId = room?.id ?? null;
  $("dlg-room-title").textContent = room ? "채팅방 설정" : "새 채팅방";
  $("room-f-name").value = room?.name ?? "";
  $("room-f-lang").value = room?.lang ?? "EN";
  $("room-f-tone").value = room?.tone ?? "neutral";
  $("room-f-context").value = room?.context ?? "";
  $("room-f-glossary").value = room?.glossary ?? "";
  $("room-f-delete").hidden = !room;
  el.dlgRoom.showModal();
}

function saveRoomDialog() {
  const lang = $("room-f-lang").value;
  const fields = {
    name: $("room-f-name").value.trim() || `${languageByCode(lang).label} 채팅방`,
    lang,
    tone: $("room-f-tone").value,
    context: $("room-f-context").value.trim(),
    glossary: $("room-f-glossary").value.trim(),
  };
  if (editingRoomId) {
    const room = state.rooms.find((r) => r.id === editingRoomId);
    Object.assign(room, fields);
    touch(room);
  } else {
    const room = newRoom(fields);
    state.rooms.unshift(room);
    state.activeRoomId = room.id;
    closeSidebar();
  }
  persist();
  renderAll();
}

function deleteRoom() {
  const room = state.rooms.find((r) => r.id === editingRoomId);
  if (!room || !confirm(`'${room.name}' 채팅방과 기록을 모두 삭제할까요?`)) return;
  room.deleted = true;
  touch(room);
  for (const m of room.messages) if (m.images?.length) removeImages(m.id);
  if (!liveRooms().length) state.rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
  if (state.activeRoomId === room.id) state.activeRoomId = liveRooms()[0].id;
  el.dlgRoom.close("cancel");
  persist();
  renderAll();
}

/* ---------- 설정 · 백업 ---------- */

/** 화면 테마·글자 크기를 적용한다. 첫 화면은 js/theme-boot.js 가 먼저 처리한다. */
function applyDisplay({ theme, textSize } = settings) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  // 대화 글자는 공통 6단계 안에서만: 보통 16 / 크게 20 (옛 설정 "xl" 은 크게로)
  if (textSize === "l" || textSize === "xl") root.dataset.size = "l";
  else delete root.dataset.size;
}

/* 메뉴 접기 (화면규칙 7절: 폭 60 · 아이콘만 · 기억 · 1000px 이하는 접힌 채 시작) */
const NAV_MINI_KEY = "biztr.nav.mini";

function setNavMini(on, { remember = true } = {}) {
  el.app.classList.toggle("mini", on);
  const btn = $("btn-nav-mini");
  const label = on ? "메뉴 펼치기" : "메뉴 접기";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  if (remember) {
    try { localStorage.setItem(NAV_MINI_KEY, on ? "1" : "0"); } catch { /* 무시 */ }
  }
}

function initNavMini() {
  let saved = null;
  try { saved = localStorage.getItem(NAV_MINI_KEY); } catch { /* 무시 */ }
  if (window.innerWidth <= 1000) setNavMini(true, { remember: false });
  else setNavMini(saved === "1", { remember: false });
}

function openSettings() {
  $("set-f-model").value = settings.model;
  $("set-f-theme").value = settings.theme || "auto";
  $("set-f-size").value = settings.textSize === "l" || settings.textSize === "xl" ? "l" : "m";
  $("set-account-email").textContent = auth?.user?.email ?? "";
  $("set-account-role").textContent = auth?.user?.role === "admin" ? "관리자" : "직원";
  $("set-admin").hidden = auth?.user?.role !== "admin";
  $("set-invite-result").hidden = true;
  $("set-invite-result").textContent = "";
  el.dlgSettings.showModal();
}

async function issueInvites() {
  try {
    const count = Number($("set-invite-count").value) || 1;
    const data = await api.createInvites(auth.token, { count, expiresDays: 30 });
    const box = $("set-invite-result");
    box.hidden = false;
    box.textContent = `${data.codes.join("\n")}\n\n30일 안에 사용해야 합니다. 한 코드는 한 명만 쓸 수 있습니다.`;
  } catch (err) {
    toast(err.message || "초대 코드를 만들지 못했습니다.");
  }
}

function downloadBackup() {
  const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `biz-translator-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  try {
    const rooms = parseBackup(await file.text());
    for (const room of rooms) {
      touch(room);
      for (const m of room.messages) touch(m);
      const index = state.rooms.findIndex((r) => r.id === room.id);
      if (index >= 0) state.rooms[index] = room;
      else state.rooms.push(room);
    }
    persist();
    renderAll();
    toast(`채팅방 ${rooms.length}개를 가져왔습니다.`);
  } catch (err) {
    toast(err.message || "백업 파일을 읽지 못했습니다.");
  }
}

/* ---------- 로그인 ---------- */

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("auth-title").textContent = signup ? "회원가입" : "로그인";
  $("auth-sub").textContent = signup
    ? "가입 후에는 PC와 휴대폰 어디서 열어도 같은 기록을 씁니다."
    : "로그인하면 이 계정의 채팅방과 기록을 그대로 이어서 씁니다.";
  $("auth-signup-fields").hidden = !signup;
  $("auth-submit").textContent = signup ? "가입하고 시작하기" : "로그인";
  $("auth-toggle").textContent = signup ? "이미 계정이 있습니다. 로그인" : "계정이 없습니다. 회원가입";
  $("auth-password").autocomplete = signup ? "new-password" : "current-password";
  showAuthError("");
}

function showAuthError(message) {
  const box = $("auth-error");
  box.textContent = message;
  box.hidden = !message;
}

function showAuthScreen(message) {
  el.auth.hidden = false;
  el.app.hidden = true;
  if (message) showAuthError(message);
  $("auth-email").focus();
}

function hideAuthScreen() {
  el.auth.hidden = true;
  el.app.hidden = false;
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  showAuthError("");

  try {
    const payload = authMode === "signup"
      ? {
          email,
          password,
          name: $("auth-name").value.trim(),
          invite: $("auth-invite").value.trim(),
        }
      : { email, password };
    const data = authMode === "signup" ? await api.signup(payload) : await api.login(payload);
    auth = { token: data.token, user: data.user, expiresAt: data.expiresAt };
    api.saveAuth(auth);
    $("auth-password").value = "";
    startApp();
  } catch (err) {
    showAuthError(err.message || "로그인하지 못했습니다.");
  } finally {
    btn.disabled = false;
  }
}

function handleSignedOut(message) {
  api.clearAuth();
  auth = null;
  state = null;
  setAttachments([]);
  clearTimeout(syncTimer);
  showAuthScreen(message || "");
  setAuthMode("login");
}

async function signOut() {
  const token = auth?.token;
  el.dlgSettings.close("cancel");
  handleSignedOut("로그아웃했습니다.");
  if (token) api.logout(token).catch(() => { /* 서버 정리는 실패해도 무방 */ });
}

/* ---------- 기타 UI ---------- */

function openSidebar() { el.app.classList.add("sidebar-open"); el.backdrop.hidden = false; }
function closeSidebar() { el.app.classList.remove("sidebar-open"); el.backdrop.hidden = true; }

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
  el.input.style.overflowY = el.input.scrollHeight > 160 ? "auto" : "hidden";
}

function bindEvents() {
  $("auth-form").addEventListener("submit", submitAuth);
  $("auth-toggle").addEventListener("click", () => setAuthMode(authMode === "signup" ? "login" : "signup"));

  $("btn-new-room").addEventListener("click", () => openRoomDialog(null));
  $("btn-room-settings").addEventListener("click", () => openRoomDialog(activeRoom()));
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-logout").addEventListener("click", signOut);
  $("btn-nav-mini").addEventListener("click", () => setNavMini(!el.app.classList.contains("mini")));
  $("btn-open-sidebar").addEventListener("click", openSidebar);
  $("btn-close-sidebar").addEventListener("click", closeSidebar);
  el.backdrop.addEventListener("click", closeSidebar);

  el.roomList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) selectRoom(li.dataset.id);
  });

  el.messages.addEventListener("click", (e) => {
    const thumb = e.target.closest(".tr-imgs img");
    if (thumb?.src) {
      showImage(thumb.src);
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const room = activeRoom();
    const msg = room.messages.find((m) => m.id === btn.closest(".tr-msg").dataset.id);
    if (!msg) return;
    if (btn.dataset.action === "copy") copyText(msg.translation);
    if (btn.dataset.action === "retry") runTranslation(room, msg);
    if (btn.dataset.action === "delete") {
      msg.deleted = true;
      touch(msg);
      if (msg.images?.length) removeImages(msg.id);
      persist();
      renderRooms();
      renderMessages({ scroll: false });
    }
  });

  el.dlgImage.addEventListener("click", () => el.dlgImage.close());

  el.send.addEventListener("click", send);
  el.input.addEventListener("input", autosize);

  // 이미지 첨부: 버튼 / 붙여넣기 / 드래그 앤 드롭 세 가지
  $("btn-attach").addEventListener("click", () => el.fileImage.click());
  el.fileImage.addEventListener("change", (e) => {
    addImageFiles(e.target.files);
    e.target.value = ""; // 같은 파일을 연속으로 고를 수 있게 비운다
  });

  el.attachments.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-index]");
    if (!btn) return;
    const index = Number(btn.dataset.index);
    setAttachments(attachments.filter((_, i) => i !== index));
  });

  document.addEventListener("paste", (e) => {
    if (el.app.hidden || document.querySelector("dialog[open]")) return;
    const files = [...(e.clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault(); // 이미지 파일명이 입력란에 들어가지 않게 막는다
    addImageFiles(files);
  });

  window.addEventListener("dragenter", (e) => {
    if (el.app.hidden || !hasFiles(e)) return;
    dragDepth += 1;
    el.dropzone.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (el.app.hidden || !hasFiles(e)) return;
    e.preventDefault(); // 이게 없으면 drop 이벤트가 오지 않는다
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropzone.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    dragDepth = 0;
    el.dropzone.hidden = true;
    if (el.app.hidden || !hasFiles(e)) return;
    e.preventDefault();
    addImageFiles(e.dataTransfer.files);
  });

  el.input.addEventListener("keydown", (e) => {
    // 한글 조합 중 Enter는 전송하지 않는다. 터치 기기에서는 Enter가 줄바꿈이다.
    const touchDevice = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touchDevice) {
      e.preventDefault();
      send();
    }
  });

  for (const btn of document.querySelectorAll(".dlg-cancel")) {
    btn.addEventListener("click", () => btn.closest("dialog").close("cancel"));
  }

  // 저장은 폼 submit에서 처리한다 (취소·Esc는 submit을 일으키지 않는다).
  el.dlgRoom.querySelector("form").addEventListener("submit", saveRoomDialog);
  $("room-f-delete").addEventListener("click", deleteRoom);

  // 테마·글자 크기는 고르는 즉시 미리 보여주고, 취소하면 되돌린다.
  const previewDisplay = () => applyDisplay({ theme: $("set-f-theme").value, textSize: $("set-f-size").value });
  $("set-f-theme").addEventListener("change", previewDisplay);
  $("set-f-size").addEventListener("change", previewDisplay);
  el.dlgSettings.addEventListener("close", () => applyDisplay(settings));

  el.dlgSettings.querySelector("form").addEventListener("submit", () => {
    settings = {
      ...settings,
      model: $("set-f-model").value,
      theme: $("set-f-theme").value,
      textSize: $("set-f-size").value,
    };
    applyDisplay(settings);
    if (!saveSettings(settings)) toast("설정을 저장하지 못했습니다.");
    else toast("설정을 저장했습니다.");
  });
  $("set-f-export").addEventListener("click", downloadBackup);
  $("set-f-import").addEventListener("click", () => $("set-f-file").click());
  $("set-f-file").addEventListener("change", (e) => {
    const [file] = e.target.files;
    if (file) importBackup(file);
    e.target.value = "";
  });
  $("set-f-logout").addEventListener("click", signOut);
  $("set-invite-create").addEventListener("click", issueInvites);

  // 다른 기기에서 바뀐 내용을 가져온다.
  window.addEventListener("focus", () => { runSync(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runSync();
  });
}

function startApp() {
  hideAuthScreen();
  // 첫 동기화 전에는 기본 방을 만들지 않는다. 서버 기록과 중복되기 때문이다.
  const firstTime = !localStorage.getItem(stateKey(auth.user.id));
  state = loadState(auth.user.id, { createDefault: !firstTime });
  if (!firstTime) saveState(auth.user.id, state);
  renderMe();
  renderAll();
  autosize();
  runSync({ silent: false });
}

function init() {
  $("room-f-lang").replaceChildren(...LANGUAGES.map((l) => {
    const opt = h("option", "", `${l.label} (${l.name})`);
    opt.value = l.code;
    return opt;
  }));
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) document.documentElement.classList.add("is-ios");

  applyDisplay(settings);
  initNavMini();
  bindEvents();
  setAuthMode("login");

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 캐시 없이도 동작 */ });
  }

  if (auth?.token) startApp();
  else showAuthScreen();
}

init();
