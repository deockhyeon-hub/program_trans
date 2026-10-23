// 번역 요청: 실제 호출은 서버(Cloudflare Worker)가 한다.
// Anthropic API 키는 서버 비밀값이라 이 앱에는 들어 있지 않다.

import { translateRemote, ApiError } from "./api.js";

export const LANGUAGES = [
  { code: "EN", name: "English", label: "영어" },
  { code: "JA", name: "Japanese", label: "일본어" },
  { code: "ZH", name: "Chinese (Simplified)", label: "중국어 (간체)" },
  { code: "TW", name: "Chinese (Traditional)", label: "중국어 (번체)" },
  { code: "VI", name: "Vietnamese", label: "베트남어" },
  { code: "TH", name: "Thai", label: "태국어" },
  { code: "ID", name: "Indonesian", label: "인도네시아어" },
  { code: "ES", name: "Spanish", label: "스페인어" },
  { code: "FR", name: "French", label: "프랑스어" },
  { code: "DE", name: "German", label: "독일어" },
  { code: "PT", name: "Portuguese", label: "포르투갈어" },
  { code: "RU", name: "Russian", label: "러시아어" },
  { code: "AR", name: "Arabic", label: "아랍어" },
];

// 서버(v2)가 한 줄씩 500자로 잘라 쓴다. 상대가 쓰는 호칭 · 용어를 따라가려면 조금 넉넉히 보낸다.
const HISTORY_LIMIT = 12;

export class TranslateError extends Error {
  constructor(message, { status = 0, retryable = false, code = "" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function languageByCode(code) {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

// 한글 비중으로 입력 방향을 추정한다 (대기 중 말풍선 위치용. 최종 방향은 모델이 판정).
export function looksKorean(text) {
  const hangul = (text.match(/[가-힣ㄱ-ㆎ]/g) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters > 0 && hangul / letters >= 0.3;
}

export async function translate({ token, model, room, text, userNote = "", images = [], history = [], signal, onEvent }) {
  if (!token) throw new TranslateError("로그인이 필요합니다.", { status: 401 });

  // 서버에는 문맥 파악에 필요한 최소한만 보낸다.
  const trimmed = history
    .filter((m) => m.status === "done")
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ direction: m.direction, source: m.source, translation: m.translation }));

  try {
    const data = await translateRemote({ token, model, room, text, userNote, images, history: trimmed, signal, onEvent });
    return {
      direction: data.direction === "target->ko" ? "target->ko" : "ko->target",
      detectedLanguage: data.detectedLanguage ?? "",
      translation: (data.translation ?? "").trim(),
      note: (data.note ?? "").trim(),
      // 이미지에서 읽어낸 원문 (이미지를 보냈을 때만 채워진다)
      extractedText: (data.extractedText ?? "").trim(),
      // 이미지: 원문(읽은 글자)이 번역보다 조금 늦게 따로 온다(onEvent 의 source).
      sourcePending: !!data.sourcePending,
      model: data.model ?? model,
    };
  } catch (err) {
    if (err.name === "AbortError") throw err;
    if (err instanceof ApiError) {
      throw new TranslateError(err.message, {
        status: err.status,
        code: err.code || "",
        retryable: err.status === 0 || err.status === 429 || err.status >= 500,
      });
    }
    throw new TranslateError(err.message || "번역에 실패했습니다.", { retryable: true });
  }
}
