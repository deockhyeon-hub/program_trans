// 이미지 첨부 처리
//  - 파일 선택 / 드래그 앤 드롭 / 붙여넣기로 받은 이미지를 번역용으로 다듬는다.
//  - 글자를 읽어야 하므로 과하게 줄이지 않는다. 긴 변 1568px은 Anthropic 권장 상한이라
//    그보다 크면 토큰만 더 쓰고 인식률은 좋아지지 않는다.
//  - 원본 이미지는 서버에 보내기만 하고 저장하지 않는다. 다시 번역할 때 쓰려고
//    이 기기의 IndexedDB에만 둔다 (localStorage는 용량이 작아 이미지에 못 쓴다).

export const MAX_IMAGES = 4;

const MAX_EDGE = 1568;
const PNG_LIMIT = 1_200_000; // 이보다 크면 JPEG로 다시 뽑는다
const SEND_LIMIT = 4_000_000; // 한 장당 전송 상한 (원본 바이트 기준)

/* ---------- 변환 ---------- */

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

async function toBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close?.() };
    } catch {
      /* HEIC 등 브라우저가 못 여는 형식이면 <img>로 한 번 더 시도한다 */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("이 형식의 이미지는 브라우저가 열 수 없습니다. JPG나 PNG로 저장해서 올려 주세요."));
      img.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** File → 번역에 바로 쓸 수 있는 형태로 정리한다. */
export async function prepareImage(file) {
  const bmp = await toBitmap(file);
  try {
    if (!bmp.width || !bmp.height) throw new Error("이미지 크기를 알 수 없습니다.");

    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    // 투명 배경 PNG는 흰 바탕을 깔아야 검은 글씨가 검은 배경에 묻히지 않는다.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp.source, 0, 0, width, height);

    // 글자는 PNG가 또렷하다. 사진처럼 커지면 JPEG로 바꾼다.
    let blob = await toBlob(canvas, "image/png");
    let mediaType = "image/png";
    if (!blob || blob.size > PNG_LIMIT) {
      const jpeg = await toBlob(canvas, "image/jpeg", 0.92);
      if (jpeg && (!blob || jpeg.size < blob.size)) {
        blob = jpeg;
        mediaType = "image/jpeg";
      }
    }
    if (!blob) throw new Error("이미지를 변환하지 못했습니다.");
    if (blob.size > SEND_LIMIT) throw new Error("이미지가 너무 큽니다. 잘라서 올려 주세요.");

    return {
      name: file.name || "image",
      mediaType,
      dataUrl: await blobToDataUrl(blob),
      width,
      height,
      bytes: blob.size,
    };
  } finally {
    bmp.done();
  }
}

/** 서버로 보낼 형태 (base64 본문만). */
export function toPayload(image) {
  const comma = image.dataUrl.indexOf(",");
  return { mediaType: image.mediaType, data: comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl };
}

/** 메시지에 저장할 정보 (원본 데이터는 빼고 크기·이름만). */
export function toMeta(image) {
  return { name: image.name, mediaType: image.mediaType, width: image.width, height: image.height };
}

/* ---------- 이 기기 보관 (IndexedDB) ---------- */

const DB_NAME = "biztr-images";
const STORE = "byMessage";
const cache = new Map(); // 같은 화면에서 반복해 읽지 않도록

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("no indexeddb"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("indexeddb open failed"));
    }).catch(() => null);
  }
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let result = null;
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveImages(messageId, images) {
  cache.set(messageId, images);
  await withStore("readwrite", (store) => store.put(images, messageId));
}

export async function loadImages(messageId) {
  if (cache.has(messageId)) return cache.get(messageId);
  const stored = await withStore("readonly", (store) => store.get(messageId));
  const images = Array.isArray(stored) ? stored : [];
  cache.set(messageId, images);
  return images;
}

export async function removeImages(messageId) {
  cache.delete(messageId);
  await withStore("readwrite", (store) => store.delete(messageId));
}
