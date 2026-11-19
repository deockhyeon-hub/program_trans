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
  toast: $("toast"), chat: $("chat"), clipOffer: $("clip-offer"), clipOfferImg: $("clip-offer-img"), clipAsk: $("clip-ask"),
};

const liveRooms = () => state.rooms.filter((r) => !r.deleted);
const liveMessages = (room) => room.messages.filter((m) => !m.deleted);

function activeRoom() {
  const rooms = liveRooms();
  return rooms.find((r) => r.id === state.activeRoomId) ?? rooms[0];
}

/* ---------- 한 방 모드 (2026-11-19 시험) ----------
 * 대표: 「베트남 · 영어 상관없이 채팅방은 1개. 외국어는 국문으로, 한국어를 넣으면 영어 · 베트남어 버튼 2개.」
 * 서버 · 저장 구조는 그대로 둔다: 언어마다 방이 하나씩 있고(영어 방 · 베트남어 방), 화면만 모든 방의 메시지를
 * 시간순으로 한 줄에 보여 준다. 새 메시지는 그 언어의 방에 들어간다 → 언어별 말투 · 메모 · 용어집 · 앞 대화(문맥)가
 * 섞이지 않고, 예전 화면을 쓰는 기기도 그대로 동기화된다. 켜기: 주소 끝 ?one=1 (끄기 ?one=0), 이 기기에만 저장.
 */
const LANG_ORDER = ["EN", "VI"];
const oneMode = () => settings.ui === "one";

// 언어별 대표 방(같은 언어 방이 여럿이면 가장 최근에 쓴 방), 영어 · 베트남어 순서 고정
function langRooms() {
  const byLang = new Map();
  for (const room of liveRooms()) {
    const last = liveMessages(room).at(-1)?.ts || room.updatedAt || 0;
    const cur = byLang.get(room.lang);
    if (!cur || last > cur.last) byLang.set(room.lang, { room, last });
  }
  const rank = (code) => { const i = LANG_ORDER.indexOf(code); return i < 0 ? 99 : i; };
  return [...byLang.values()].map((x) => x.room).sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang));
}
const roomForLang = (lang) => langRooms().find((r) => r.lang === lang) || null;

function timeline() {
  const items = [];
  for (const room of liveRooms()) for (const msg of liveMessages(room)) items.push({ room, msg });
  return items.sort((a, b) => a.msg.ts - b.msg.ts);
}

// 한국어를 넣었을 때 먼저 권할 언어 = 가장 최근 대화의 언어(방금 온 메시지에 답하는 경우가 많다)
function primaryLang() {
  const langs = langRooms().map((r) => r.lang);
  const last = timeline().at(-1);
  if (last && langs.includes(last.room.lang)) return last.room.lang;
  if (langs.includes(settings.lastLang)) return settings.lastLang;
  return langs[0] || "EN";
}

// 외국어 글이 어느 방으로 갈지 짐작한다. 번역은 모델이 언어를 스스로 알아보므로 짐작이 틀려도 번역은 맞고,
// 끝난 뒤 모델이 알려 준 언어(detectedLanguage)가 다르면 맞는 방으로 옮긴다(moveMessage).
const VI_MARKS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹĩũ]/i;
const VI_WORDS = /(?<!\p{L})(khong|ko|duoc|dc|cua|nhe|minh|roi|lam|gui|hang|bao nhieu|voi|vay|nha|oi|sao|nhu|thi|cung|dang|chua|nhung|nay|ben|san pham)(?!\p{L})/giu;
function guessLang(text) {
  const has = (code) => !!roomForLang(code);
  const viWords = new Set((text.match(VI_WORDS) || []).map((w) => w.toLowerCase())).size;
  if (has("VI") && (VI_MARKS.test(text) || viWords >= 3)) return "VI";
  if (has("JA") && /[\u3040-\u30ff]/.test(text)) return "JA";
  if (has("ZH") && /[\u4e00-\u9fff]/.test(text)) return "ZH";
  if (has("EN")) return "EN";
  return primaryLang();
}

// 모델이 돌려준 언어 이름("Vietnamese", "vi", "Tiếng Việt" …) → 언어 코드
function langCodeOf(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return "";
  if (/viet|việt|^vi$/.test(s)) return "VI";
  if (/english|^en$/.test(s)) return "EN";
  const hit = LANGUAGES.find((l) => l.code.toLowerCase() === s || s.startsWith(l.name.toLowerCase().split(" ")[0]));
  return hit ? hit.code : "";
}

function findMessage(id) {
  for (const room of state.rooms) {
    const msg = room.messages.find((m) => m.id === id);
    if (msg) return { room, msg };
  }
  return null;
}

// 이 방의 메시지가 지금 화면에 보이는가
// (보통 모드도 activeRoom() 으로 비교: 새로 받은 기기는 activeRoomId 가 비어 있어 번역해도 화면이 안 바뀌던 것 고침, 11-19)
const shown = (room) => (oneMode() ? !room.deleted : room.id === activeRoom()?.id);

const langTo = (code) => `${languageByCode(code).label.replace(/\s*\(.*\)/, "")}로`;

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
  const newLabel = document.querySelector("#btn-new-room .tr-nav__lb");
  if (newLabel) newLabel.textContent = oneMode() ? "언어 추가" : "새 채팅방";
  if (oneMode()) {
    // 목록 = 한 방(번역 채팅) + 언어별 설정(누르면 말투 · 메모 · 용어집 창)
    const one = h("li", "tr-room on");
    one.dataset.one = "1";
    one.setAttribute("aria-current", "true");
    const last = timeline().at(-1)?.msg;
    const txt = h("div", "tr-room__txt");
    txt.append(h("span", "tr-room__nm", "번역 채팅"), h("span", "tr-room__last", last ? (last.source || last.translation || "이미지") : "외국어는 한국어로, 한국어는 고른 언어로"));
    one.append(h("span", "ds-tag", "전체"), txt);
    const items = [one, h("li", "tr-room__sec tr-nav__lb", "언어별 설정")];
    for (const room of langRooms()) {
      const li = h("li", "tr-room cfg");
      li.dataset.id = room.id;
      li.title = `${room.name} · 말투 · 메모 · 용어집`;
      const t = h("div", "tr-room__txt");
      t.append(h("span", "tr-room__nm", room.name), h("span", "tr-room__last", `${TONE_LABEL[room.tone] || TONE_LABEL.neutral} · 누르면 설정`));
      li.append(langTag(room.lang), t);
      items.push(li);
    }
    el.roomList.replaceChildren(...items);
    return;
  }
  el.roomList.replaceChildren(...liveRooms().map((room) => {
    const lang = languageByCode(room.lang);
    const li = h("li", room.id === activeRoom()?.id ? "tr-room on" : "tr-room");
    li.dataset.id = room.id;
    li.title = room.name;
    if (room.id === activeRoom()?.id) li.setAttribute("aria-current", "true");
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
  // 접힌 메뉴에서는 아이콘만 보이므로 이름을 풍선으로
  $("me-ico").parentElement.title = `${name} · ${$("me-role").textContent}`;
}

const deskHint = document.querySelector(".tr-composer__hint.tr-desk") || {};
const DESK_HINT = deskHint.textContent || "";

function renderHead() {
  if (oneMode()) {
    const labels = langRooms().map((r) => languageByCode(r.lang).label);
    el.roomName.textContent = "번역 채팅";
    el.roomMeta.textContent = `외국어 → 한국어 · 한국어 → ${labels.join(" · ")}`;
    el.input.placeholder = "한국어 또는 외국어로 입력하세요";
    $("btn-room-settings").textContent = "언어별 설정";
    deskHint.textContent = "Enter = 진한 단추 · Shift+Enter 줄바꿈 · 외국어는 한국어로, 한국어는 고른 언어로 · 사진은 캡처 뒤 Ctrl+V";
    return;
  }
  $("btn-room-settings").textContent = "채팅방 설정";
  deskHint.textContent = DESK_HINT;
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

function messageNode(msg, room = activeRoom()) {
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
  // 흘려받는 번역문(partial)이 있으면 써지는 대로 보여 준다.
  if (msg.status === "pending") {
    if (msg.partial) node.append(h("div", "tr-bubble typing", msg.partial));
    node.append(h("span", "ds-badge progress", msg.partial ? "번역 중" : hasImages ? "글자를 읽고 번역하는 중" : "번역 중"));
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
    const lang = languageByCode(room.lang).label;
    if (oneMode()) tools.append(langTag(room.lang));
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
  if (oneMode()) {
    const items = timeline();
    if (!items.length) {
      const empty = h("div", "tr-empty");
      const labels = langRooms().map((r) => `「${langTo(r.lang)}」`).join(" ");
      empty.append(
        h("strong", "", "한 방에서 모든 언어를 번역합니다"),
        h("p", "", "외국어를 넣으면 한국어로 번역합니다."),
        h("p", "", `한국어를 넣으면 ${labels} 단추가 나옵니다. 누른 언어로 번역합니다.`),
      );
      el.messages.replaceChildren(empty);
      return;
    }
    el.messages.replaceChildren(...items.map(({ room, msg }) => messageNode(msg, room)));
    if (scroll) el.messages.scrollTop = el.messages.scrollHeight;
    return;
  }
  const room = activeRoom();
  if (!room) return;
  const list = liveMessages(room);
  if (!list.length) {
    const empty = h("div", "tr-empty");
    const lang = languageByCode(room.lang).label;
    empty.append(
      h("strong", "", "비즈니스 문맥에 맞춰 번역합니다"),
      h("p", "", `한국어를 입력하면 ${lang}로, ${lang}를 입력하면 한국어로 번역합니다. 직역이 아니라 실제 업무 메일·메신저에서 쓰는 자연스러운 표현으로 다듬습니다.`),
      h("p", "", desktopPointer.matches
        ? "이미지도 됩니다. 메일 캡처·견적서 사진을 끌어다 놓거나 Ctrl+V로 붙여넣으면 속의 글자를 읽어 번역합니다."
        : "사진도 됩니다. 카톡·Zalo 사진을 길게 눌러 「공유 → Biz 번역」 을 고르면 이 앱에 바로 붙습니다. 복사한 사진은 입력칸 옆 클립보드 단추, 갤러리 캡처는 사진 단추로 고릅니다."),
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
  updateComposer();
}

// 한 방 모드 입력칸 단추: 한국어면 「영어로」 「베트남어로」(칠한 쪽 = Enter), 외국어면 「한국어로」 하나.
let langBtnKey = "";
function updateComposer() {
  const box = $("lang-btns");
  if (!box || !state) return;
  const text = el.input.value.trim();
  const korean = oneMode() && !attachments.length && !!text && looksKorean(text);
  box.hidden = !korean;
  el.send.hidden = korean;
  el.send.textContent = oneMode() && text && !attachments.length ? "한국어로" : "번역";
  if (!korean) return;
  const primary = primaryLang();
  const langs = langRooms().map((r) => r.lang);
  const key = `${langs.join(",")}|${primary}|${desktopPointer.matches}`;
  if (key === langBtnKey) return;
  langBtnKey = key;
  box.replaceChildren(...langs.map((code) => {
    const btn = h("button", code === primary ? "ds-btn pri tr-langbtn" : "ds-btn tr-langbtn");
    btn.type = "button";
    btn.dataset.lang = code;
    btn.title = `${langTo(code)} 번역${code === primary ? " (Enter)" : ""}`;
    btn.append(h("span", "tr-langbtn__code", code), h("span", "", langTo(code)));
    if (code === primary && desktopPointer.matches) btn.append(h("kbd", "tr-langbtn__key", "Enter"));
    return btn;
  }));
}

/* ---------- 번역 ---------- */

const AUTO_RETRY_MAX = 2;               // 한 메시지를 저절로 다시 보내는 최대 횟수
const AUTO_RETRY_WINDOW = 30 * 60000;   // 보낸 지 30분 안의 것만 (오래된 것을 몰래 다시 번역하지 않는다)
let retryingInterrupted = false;

// 연결이 끊겨 실패한 번역을 다시 보낸다. 휴대폰에서 번역을 기다리다 다른 앱으로 넘어가면
// 요청이 끊기는데, 돌아왔을 때 사람이 「재시도」 를 누르지 않아도 되게 한다.
async function retryInterrupted() {
  if (!auth?.token || !state || retryingInterrupted) return;
  if (navigator.onLine === false || document.visibilityState === "hidden") return;
  const since = Date.now() - AUTO_RETRY_WINDOW;
  const jobs = [];
  for (const room of liveRooms()) {
    for (const m of liveMessages(room)) {
      if (m.status === "error" && m.autoRetry && (m.autoTries || 0) < AUTO_RETRY_MAX && m.ts >= since) jobs.push([room, m]);
    }
  }
  if (!jobs.length) return;
  retryingInterrupted = true;
  try {
    for (const [room, m] of jobs.slice(-5)) {
      m.autoRetry = false;
      m.autoTries = (m.autoTries || 0) + 1;
      await runTranslation(room, m);
    }
  } finally {
    retryingInterrupted = false;
  }
}

/* ---------- 흘려받기 화면 갱신 ---------- */
// 번역문이 글자 단위로 들어오므로 화면 전체를 다시 그리지 않고 해당 말풍선만 고친다(한 화면 한 번).
const livePending = new Set();
let liveFrame = 0;

function nearBottom() {
  const box = el.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 160;
}

function paintLive(room, msg) {
  if (!state || !shown(room)) return;
  livePending.add(msg);
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const stick = nearBottom();
    for (const m of livePending) {
      if (m.status !== "pending") continue;
      const node = [...el.messages.querySelectorAll("article.tr-msg")].find((n) => n.dataset.id === m.id);
      if (!node) continue;
      const me = m.direction === "ko->target";
      node.classList.toggle("me", me);
      node.classList.toggle("partner", !me);
      let bubble = node.querySelector(".tr-bubble");
      const badge = node.querySelector(".ds-badge");
      if (m.partial) {
        if (!bubble) {
          bubble = h("div", "tr-bubble typing", "");
          node.insertBefore(bubble, badge);
        }
        bubble.textContent = m.partial;
        if (badge) badge.textContent = "번역 중";
      } else if (bubble) {
        bubble.remove();
      }
    }
    livePending.clear();
    if (stick) el.messages.scrollTop = el.messages.scrollHeight;
  });
}

// 이미지에서 읽은 원문은 번역보다 조금 늦게 따로 온다.
function applySource(room, msg, text) {
  const src = String(text || "").trim();
  if (!src) return;
  msg.source = src;
  if (!state.rooms.includes(room) || !room.messages.includes(msg)) return;
  if (msg.status === "pending") return; // 번역이 끝날 때 같이 저장된다
  touch(msg);
  persist();
  renderRooms();
  if (shown(room)) renderMessages({ scroll: nearBottom() });
}

async function runTranslation(room, msg) {
  msg.status = "pending";
  msg.error = "";
  msg.partial = "";
  if (shown(room)) renderMessages();

  // 이미지 원본은 찍은 기기에만 있다. 다른 기기면 추출된 글자만으로 다시 번역한다.
  let images = [];
  let stored = [];
  if (msg.images?.length) {
    stored = await loadImages(msg.id).catch(() => []);
    images = (stored || []).map(toPayload);
    if (!images.length && !msg.source) {
      Object.assign(msg, {
        status: "error",
        error: "이 기기에는 원본 이미지가 남아 있지 않습니다. 이미지를 다시 첨부해 주세요.",
      });
      touch(msg);
      persist();
      if (shown(room)) renderMessages();
      return;
    }
  }

  let moveTo = null;
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
      onEvent: (ev) => {
        if (ev.type === "meta") {
          msg.direction = ev.direction;
          paintLive(room, msg);
        } else if (ev.type === "delta") {
          msg.partial = (msg.partial || "") + ev.text;
          paintLive(room, msg);
        } else if (ev.type === "reset") {
          msg.partial = "";
          paintLive(room, msg);
        } else if (ev.type === "source") {
          applySource(room, msg, ev.text);
        }
      },
    });
    delete msg.partial;
    // 이미지에서 읽어낸 글자를 원문으로 삼는다. 그래야 다른 기기·다음 번역 문맥에도 남는다.
    if (images.length && result.extractedText) msg.source = result.extractedText;
    Object.assign(msg, {
      status: "done",
      direction: result.direction,
      translation: result.translation,
      note: result.note,
      error: "",
      autoRetry: false,
      autoTries: 0,
    });
    // 한 방 모드: 짐작한 방과 모델이 알아본 언어가 다르면(예: 성조 없는 베트남어 · 영어 메일 캡처) 맞는 방으로 옮긴다.
    if (oneMode() && result.direction === "target->ko") {
      const code = langCodeOf(result.detectedLanguage);
      if (code && code !== room.lang) moveTo = roomForLang(code);
    }
  } catch (err) {
    if (err.status === 401) {
      handleSignedOut("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    delete msg.partial;
    // 연결 끊김(0) · 잠깐의 서버 문제(503)는 앱이 다시 보이거나 인터넷이 돌아오면 저절로 다시 보낸다.
    const passing = err.status === 0 || err.status === 503;
    Object.assign(msg, {
      status: "error",
      error: err.message || "알 수 없는 오류가 발생했습니다.",
      autoRetry: passing && (msg.autoTries || 0) < AUTO_RETRY_MAX,
    });
  }

  // 번역 중에 메시지나 채팅방이 삭제됐을 수 있다.
  if (!state.rooms.includes(room) || !room.messages.includes(msg)) return;
  if (moveTo && moveTo !== room) {
    // 번역 중에 동기화로 이미 서버에 갔을 수 있어(서버는 방을 바꾸지 않는다) 새 메시지로 옮기고 원래 것은 지운 표시만 남긴다.
    const copy = newMessage(msg.source, msg.direction);
    Object.assign(copy, { translation: msg.translation, note: msg.note, status: msg.status, error: "", ts: msg.ts, userNote: msg.userNote || "" });
    if (msg.images?.length) {
      // 사진 원본(이 기기 IndexedDB)도 새 메시지 번호로 옮긴다. saveImages 는 메모리에 바로 넣어 썸네일이 곧바로 보인다.
      copy.images = msg.images;
      if (stored.length) saveImages(copy.id, stored);
      removeImages(msg.id);
    }
    moveTo.messages.push(copy);
    touch(moveTo);
    msg.deleted = true;
  }
  touch(msg);
  persist();
  renderRooms();
  if (shown(room)) renderMessages();
}

// targetLang: 한 방 모드에서 「영어로」 「베트남어로」 단추로 고른 언어(없으면 칠한 단추 = primaryLang)
function send(targetLang) {
  const text = el.input.value.trim();
  const images = attachments;
  if (!text && !images.length) return;
  let room = activeRoom();
  const direction = looksKorean(text) ? "ko->target" : "target->ko";
  if (oneMode()) {
    let lang;
    if (images.length) lang = primaryLang();                 // 사진: 외국어면 한국어로, 한국어면 이 언어로(모델이 방향을 정함)
    else if (direction === "ko->target") lang = typeof targetLang === "string" ? targetLang : primaryLang();
    else lang = guessLang(text);
    room = roomForLang(lang) || langRooms()[0] || room;
    if (direction === "ko->target" && !images.length && room) {
      settings.lastLang = room.lang;
      saveSettings(settings);
    }
  }
  if (!room) return;

  const msg = newMessage(images.length ? "" : text, direction);
  if (images.length) {
    msg.images = images.map(toMeta);
    msg.userNote = text;          // 함께 적은 말은 번역 대상이 아니라 지시로 다룬다
    msg.direction = "target->ko"; // 대개 외국어 문서다. 최종 방향은 모델이 정한다.
    saveImages(msg.id, images);   // 메모리 캐시는 즉시 채워져서 썸네일이 바로 보인다
  }

  room.messages.push(msg);
  touch(room);
  el.input.value = "";
  setAttachments([]);
  autosize();
  if (oneMode()) renderRooms();
  persist({ sync: false });
  runTranslation(room, msg);
}

/* ---------- 이미지 첨부 ---------- */

function setAttachments(list) {
  attachments = list;
  updateComposer();
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

/* ---------- 클립보드 붙여넣기 (2026-10-23) ----------
 * ① 대화창에 마우스를 올리면 입력칸에 커서가 간다 → 캡처 뒤 바로 Ctrl+V.
 * ② (11-19 대표 지시로 붙여넣기 단추는 뺐다. 허락은 「복사한 사진 바로 보기 켜기」 안내 · 설정에서 받는다.)
 * ③ 읽기 허락을 한 번 받은 뒤에는, 창으로 돌아오거나 마우스를 올리면 새로 복사한 이미지를
 *    알약(복사한 이미지 붙여넣기)으로 띄운다. 누르면 붙는다.
 */
const desktopPointer = matchMedia("(hover: hover) and (pointer: fine)");
let lastClipSig = "";      // 이미 붙였거나 알약으로 보여 준 이미지 (같은 것을 또 권하지 않는다)
let offer = null;          // { file, sig, url }
let clipChecking = false;
let clipCheckedAt = 0;

async function clipSig(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    let sum = 0;
    for (let i = 0; i < head.length; i += 1) sum = (sum * 31 + head[i]) >>> 0;
    return `${file.type}:${file.size}:${sum}`;
  } catch {
    return `${file.type}:${file.size}`;
  }
}

// 클립보드를 한 번만 읽는다(아이폰은 읽을 때마다 「붙여넣기」 말풍선을 띄우므로 글도 같은 번에 꺼낸다).
async function readClipboard({ withText = false } = {}) {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  const files = [];
  let text = "";
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await item.getType(type);
      files.push(new File([blob], `복사한 이미지.${type.split("/")[1] || "png"}`, { type }));
    } else if (withText && !text && item.types.includes("text/plain")) {
      text = await (await item.getType("text/plain")).text();
    }
  }
  return { files, text };
}

async function readClipboardImages() {
  return (await readClipboard())?.files || null;
}

// 휴대폰에서는 입력칸에 커서를 주면 자판이 올라와 화면을 가린다 → PC 에서만.
function focusInputOnDesktop() {
  if (desktopPointer.matches) el.input.focus({ preventScroll: true });
}

function hideClipOffer() {
  if (offer?.url) URL.revokeObjectURL(offer.url);
  offer = null;
  el.clipOffer.hidden = true;
  el.clipOfferImg.removeAttribute("src");
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
}

// 클립보드 읽기 허락 상태: "granted" | "prompt" | "denied" | ""(알 수 없음: 아이폰 사파리 · 파이어폭스)
let clipPermWatched = false;
const CLIP_ASK_OFF = "biztr.clipAsk.off";
async function clipPermission() {
  if (!navigator.clipboard?.read || !navigator.permissions?.query) return "";
  try {
    const perm = await navigator.permissions.query({ name: "clipboard-read" });
    if (!clipPermWatched) {
      clipPermWatched = true;
      perm.onchange = () => { updateClipAsk(); checkClipboardOffer(); };
    }
    return perm.state;
  } catch {
    return "";
  }
}

// 「복사한 사진 바로 보기 켜기」 안내 (2026-11-19, 대표: 「모바일은 자동으로 미리보기 → 누르면 삽입」).
// 미리보기는 클립보드 읽기 허락이 있어야 뜨는데, 허락을 묻는 창은 사람이 무언가를 눌렀을 때만 뜬다.
// 10-23 부터 「붙여넣기 단추를 한 번 누르면」 켜지게 해 두었지만 아무도 모르고 지났다(이 PC 도 prompt 그대로였음).
// → 허락이 아직이면 입력칸 위에 켜기 안내를 한 줄 띄운다. 닫으면 다시 안 뛴다. 아이폰은 허락 상태를 알 수 없어 안 띄운다.
async function updateClipAsk() {
  if (!el.clipAsk) return; // 옛 화면(HTML)이 캐시에서 열린 경우
  const state = await clipPermission();
  const show = state === "prompt" && !localStorage.getItem(CLIP_ASK_OFF) && !el.app.hidden;
  el.clipAsk.hidden = !show || !el.clipOffer.hidden;
}

async function enableClipPreview() {
  if (el.clipAsk) el.clipAsk.hidden = true;
  let files = null;
  try {
    files = (await readClipboard())?.files || null; // 여기서 브라우저가 「클립보드 허용?」 을 묻는다
  } catch {
    /* 거절 또는 닫음 */
  }
  const state = await clipPermission();
  if (state === "granted") {
    toast("켜졌습니다. 이제 캡처 · 복사하고 돌아오면 사진 미리보기가 뜹니다.");
    if (files?.length) { clipCheckedAt = 0; checkClipboardOffer(); }
    return;
  }
  if (state === "denied") {
    localStorage.setItem(CLIP_ASK_OFF, "1");
    toast(desktopPointer.matches
      ? "허용하지 않아 꺼져 있습니다. 주소창 왼쪽 아이콘 → 사이트 설정 → 클립보드 → 허용으로 다시 켤 수 있습니다."
      : "허용하지 않아 꺼져 있습니다. 크롬 ⋮ → 설정 → 사이트 설정 → 클립보드에서 다시 켤 수 있습니다.");
    return;
  }
  updateClipAsk(); // 창을 그냥 닫았으면 안내를 다시 보인다
}

// 앱으로 돌아온 직후에는 창이 아직 포커스를 못 받아 클립보드를 못 읽을 때가 있다(휴대폰) → 여러 번 본다.
function checkClipboardSoon() {
  for (const ms of [250, 900, 2200]) setTimeout(checkClipboardOffer, ms);
}

// 읽기 허락이 이미 있을 때만 살짝 들여다본다(처음부터 허락 창을 띄우지 않는다).
async function checkClipboardOffer() {
  if (!navigator.clipboard?.read || !navigator.permissions?.query) return;
  if (el.app.hidden || clipChecking || Date.now() - clipCheckedAt < 500) return;
  if (!document.hasFocus() || document.querySelector("dialog[open]")) return;
  clipChecking = true;
  clipCheckedAt = Date.now();
  try {
    const perm = await clipPermission();
    if (perm !== "granted") return;
    const files = await readClipboardImages();
    const file = files?.[0];
    if (!file) {
      hideClipOffer();
      return;
    }
    const sig = await clipSig(file);
    if (sig === lastClipSig || sig === offer?.sig || attachments.length >= MAX_IMAGES) {
      if (sig === lastClipSig) hideClipOffer();
      return;
    }
    hideClipOffer();
    offer = { file, sig, url: URL.createObjectURL(file) };
    el.clipOfferImg.src = offer.url;
    el.clipOffer.hidden = false;
    if (el.clipAsk) el.clipAsk.hidden = true;
  } catch {
    /* 클립보드를 못 읽으면 알약만 안 띄운다 */
  } finally {
    clipChecking = false;
  }
}

// 대화창에 마우스가 오면 입력칸에 커서를 둔다 → Ctrl+V 가 바로 된다.
function armPaste() {
  if (!desktopPointer.matches || el.app.hidden || document.querySelector("dialog[open]")) return;
  const active = document.activeElement;
  // 다른 칸에 글을 쓰는 중이거나, 대화 글을 골라 복사하려는 중이면 건드리지 않는다.
  if (active && active !== el.input && active.matches?.("input, textarea, select, [contenteditable='true']")) return;
  if (String(window.getSelection?.() || "").trim()) return;
  if (active !== el.input) el.input.focus({ preventScroll: true });
  checkClipboardOffer();
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
  $("dlg-room-title").textContent = oneMode()
    ? (room ? `${languageByCode(room.lang).label} 설정` : "언어 추가")
    : (room ? "채팅방 설정" : "새 채팅방");
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
  // 복사한 사진 바로 보기: 허락 상태를 알 수 있는 브라우저(PC · 안드로이드 크롬)에서만
  const clipSec = $("set-clip");
  if (clipSec) {
    clipPermission().then((state) => {
      clipSec.hidden = !state;
      $("set-clip-state").textContent = state === "granted" ? "켜져 있습니다. 캡처 · 복사하고 돌아오면 입력칸 위에 미리보기가 뜹니다."
        : state === "denied" ? "브라우저에서 막혀 있습니다. 주소창 왼쪽 아이콘(휴대폰은 크롬 ⋮ → 설정 → 사이트 설정) → 클립보드 → 허용."
        : "캡처 · 복사한 사진을 입력칸 위에 미리 보여 줍니다. 처음 한 번 「허용」이 필요합니다.";
      $("set-clip-on").hidden = state !== "prompt";
    });
  }
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
  $("btn-room-settings").addEventListener("click", () => {
    if (!oneMode()) return openRoomDialog(activeRoom());
    // 한 방 모드: 휴대폰은 메뉴(언어별 설정 목록), PC 는 지금 주로 쓰는 언어의 설정 창
    if (matchMedia("(max-width:700px)").matches) return openSidebar();
    return openRoomDialog(roomForLang(primaryLang()));
  });
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-logout").addEventListener("click", signOut);
  $("btn-nav-mini").addEventListener("click", () => setNavMini(!el.app.classList.contains("mini")));
  $("btn-open-sidebar").addEventListener("click", openSidebar);
  $("btn-close-sidebar").addEventListener("click", closeSidebar);
  el.backdrop.addEventListener("click", closeSidebar);

  el.roomList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id], li[data-one]");
    if (!li) return;
    if (li.dataset.one) { closeSidebar(); return; }
    if (oneMode()) {
      closeSidebar();
      openRoomDialog(state.rooms.find((r) => r.id === li.dataset.id));
      return;
    }
    selectRoom(li.dataset.id);
  });

  el.messages.addEventListener("click", (e) => {
    const thumb = e.target.closest(".tr-imgs img");
    if (thumb?.src) {
      showImage(thumb.src);
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const found = findMessage(btn.closest(".tr-msg").dataset.id);
    if (!found) return;
    const { room, msg } = found;
    if (btn.dataset.action === "copy") copyText(msg.translation);
    if (btn.dataset.action === "retry") {
      msg.autoTries = 0; // 사람이 누른 재시도는 자동 횟수를 되돌린다
      runTranslation(room, msg);
    }
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

  el.send.addEventListener("click", () => send());
  el.input.addEventListener("input", () => { autosize(); updateComposer(); });
  $("lang-btns")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-lang]");
    if (btn) send(btn.dataset.lang);
  });

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
    hideClipOffer();
    clipSig(files[0]).then((sig) => { lastClipSig = sig; });
    addImageFiles(files);
    if (document.activeElement !== el.input) focusInputOnDesktop();
  });

  // 붙여넣기 단추 · 복사한 사진 미리보기 · 바로 보기 켜기 안내
  ($("clip-offer-btn") || el.clipOffer).addEventListener("click", () => {
    if (!offer) return;
    const { file, sig } = offer;
    lastClipSig = sig;
    hideClipOffer();
    addImageFiles([file]);
    focusInputOnDesktop();
  });
  $("clip-offer-x")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (offer) lastClipSig = offer.sig; // 같은 사진은 다시 권하지 않는다
    hideClipOffer();
  });
  $("clip-ask-on")?.addEventListener("click", enableClipPreview);
  $("clip-ask-x")?.addEventListener("click", () => {
    localStorage.setItem(CLIP_ASK_OFF, "1");
    el.clipAsk.hidden = true;
    toast("나중에 켜려면 설정(톱니바퀴) → 「복사한 사진 바로 보기 켜기」 를 누르세요.");
  });
  // 설정 창에서 다시 켜기(안내를 닫았거나 허락 창을 놓쳤을 때)
  $("set-clip-on")?.addEventListener("click", async () => {
    localStorage.removeItem(CLIP_ASK_OFF);
    el.dlgSettings.close();
    await enableClipPreview();
  });
  // 안드로이드 크롬: 입력칸을 「사진도 받는 칸」으로 알린다(-webkit-user-modify: read-write).
  // 그러면 입력칸을 길게 눌러 「붙여넣기」 했을 때 사진이 paste 이벤트로 온다. 크롬이 키보드 사진 넣기
  // (chrome://flags/#enable-android-media-insertion)를 켜면 삼성 키보드의 클립보드 칩도 같은 길로 들어온다
  // (깃허브 getpaseo/paseo#5474, 크롬 153 실측: 평범한 textarea 는 못 받고 이 스타일을 준 textarea 는 받음).
  if (/Android/i.test(navigator.userAgent)) el.input.classList.add("tr-input--rich");

  // 대화창에 마우스를 올리면 바로 붙여넣을 수 있게
  let hoveringChat = false;
  el.chat.addEventListener("mouseenter", () => { hoveringChat = true; armPaste(); });
  el.chat.addEventListener("mouseleave", () => { hoveringChat = false; });
  // 캡처하러 다른 창에 갔다가 돌아오면(창 포커스) 한 번 더
  window.addEventListener("focus", () => {
    if (hoveringChat) armPaste();
    else checkClipboardSoon();
  });
  // 휴대폰: 카톡 · Zalo 에서 사진을 복사하고 앱으로 돌아오면(화면이 다시 보이면) · 입력칸을 누르면
  // 「복사한 사진 넣기」 미리보기를 띄운다(읽기 허락을 한 번 받은 뒤. 안드로이드 크롬 · PC).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { checkClipboardSoon(); updateClipAsk(); }
  });
  window.addEventListener("pageshow", () => checkClipboardSoon());
  el.input.addEventListener("focus", () => checkClipboardOffer());

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
  // 안드로이드: 크롬 실험 설정 주소를 치지 않고 복사만 (대표: 「크롬에 입력하는 항목이 너무 많은데?」)
  // 웹 페이지는 chrome:// 주소를 열 수 없어서 복사 → 주소창에 붙여넣기가 가장 짧다.
  $("set-flag-copy")?.addEventListener("click", async () => {
    const field = $("set-flag-url");
    try {
      await navigator.clipboard.writeText(field.value);
    } catch {
      field.focus();
      field.select();
      document.execCommand?.("copy");
    }
    toast("복사했습니다. 크롬 주소창을 길게 눌러 「붙여넣기」 하세요.");
  });
  $("set-invite-create").addEventListener("click", issueInvites);

  // 다른 기기에서 바뀐 내용을 가져온다.
  // 끊겨서 실패한 번역도 이때 다시 보낸다.
  window.addEventListener("focus", () => { runSync(); retryInterrupted(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { runSync(); retryInterrupted(); }
  });
  window.addEventListener("online", () => { runSync(); retryInterrupted(); });
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
  takeSharedFiles();
  updateClipAsk();
  checkClipboardSoon();
  // 번역 중에 앱이 닫혔던 것은 첫 동기화 뒤 다시 보낸다.
  runSync({ silent: false }).then(() => retryInterrupted());
}

// 다른 앱에서 「공유 → Biz 번역」 으로 보낸 사진 · 글 (sw.js 가 맡아 둔 것)
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has("share")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("biztr-share");
    const metaRes = await cache.match("shared/meta");
    if (!metaRes) return;
    const meta = await metaRes.json();
    const files = [];
    for (const name of meta.names || []) {
      const res = await cache.match(name);
      if (!res) continue;
      const blob = await res.blob();
      files.push(new File([blob], "공유한 이미지", { type: blob.type || "image/png" }));
    }
    for (const key of await cache.keys()) await cache.delete(key);
    if (files.length) await addImageFiles(files);
    if (meta.text && !files.length) {
      insertAtCursor(el.input, meta.text);
      autosize();
    }
    if (files.length) toast("공유한 사진을 붙였습니다. 번역을 누르세요.");
  } catch {
    toast("공유한 사진을 받지 못했습니다. 사진 단추로 골라 주세요.");
  }
}

function init() {
  $("room-f-lang").replaceChildren(...LANGUAGES.map((l) => {
    const opt = h("option", "", `${l.label} (${l.name})`);
    opt.value = l.code;
    return opt;
  }));
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) document.documentElement.classList.add("is-ios");
  if (/Android/i.test(navigator.userAgent)) document.documentElement.classList.add("is-android");
  // 한 방 모드 켜기 · 끄기: 주소 끝 ?one=1 · ?one=0 (이 기기에 저장하고 주소에서 뛴다)
  const query = new URLSearchParams(location.search);
  if (query.has("one")) {
    settings.ui = query.get("one") === "0" ? "" : "one";
    saveSettings(settings);
    query.delete("one");
    history.replaceState(null, "", location.pathname + (query.toString() ? `?${query}` : ""));
  }

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
