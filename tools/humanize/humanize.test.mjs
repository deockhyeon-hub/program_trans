// 기계 다듬기(humanizeOutput) 시험. 워커 파일을 복사해 읽어 함수만 꺼내 쓴다.
//   node tools/humanize/humanize.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "../../worker/index.js"), "utf8");
const tmp = path.join(os.tmpdir(), `biztr-humanize-${process.pid}.mjs`);
fs.writeFileSync(tmp, `${src}\nexport { humanizeOutput as __humanizeOutput, buildSystemPromptV2 as __prompt };\n`);
const { __humanizeOutput: H, __prompt: P } = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) { pass += 1; return; }
  fail += 1;
  console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}
const ko = (t, s, img = false) => H(t, { source: s, toKorean: true, fromImage: img }).text;
const en = (t, s) => H(t, { source: s, toKorean: false }).text;

// em dash
eq("emdash mid", en("by hand — from labels to seals.", "수작업으로"), "by hand, from labels to seals.");
eq("emdash nospace", en("by hand—from labels", "수작업"), "by hand, from labels");
eq("emdash end", en("Done —", "끝"), "Done");
eq("emdash kept when source has it", en("A — B", "A — B"), "A — B");
eq("en dash untouched", en("– item one\n– item two", "- 하나"), "– item one\n– item two");
eq("hyphen untouched", en("5~6 weeks, follow-up", "x"), "5~6 weeks, follow-up");
// 연결어미 쉼표
eq("comma -며", ko("생산 전이며, 라벨만 만들었어요.", "x"), "생산 전이며 라벨만 만들었어요.");
eq("comma -었고", ko("확인했고, 보내드릴게요.", "x"), "확인했고 보내드릴게요.");
eq("comma -지만", ko("늦었지만, 괜찮아요.", "x"), "늦었지만 괜찮아요.");
eq("comma noun 재고 kept", ko("재고, 출고 일정 알려주세요.", "x"), "재고, 출고 일정 알려주세요.");
eq("comma noun 창고 kept", ko("창고, 사무실 모두", "x"), "창고, 사무실 모두");
eq("comma 그리고 list kept", ko("크림, 토너, 미스트", "x"), "크림, 토너, 미스트");
eq("comma not in en", en("Yes, and also, we", "x"), "Yes, and also, we");
// 괄호 풀이
eq("paren ko gloss", ko("이 업체는 보증금(선금) 요구하나요", "Nhà nay có bảo cọc không"), "이 업체는 보증금 요구하나요");
eq("paren ko gloss 2", ko("메인(히어로) 이미지", "main hero"), "메인 이미지");
eq("paren en gloss in source", ko("명판(nameplate) 사진", "photo of the nameplate"), "명판 사진");
eq("paren en not in source kept", ko("착륙 원가(landing cost)", "chi phí"), "착륙 원가(landing cost)");
eq("paren name", ko("실버리 호텔(The Silveri Hotel)에서 만나요", "Meet at The Silveri Hotel"), "The Silveri Hotel에서 만나요");
eq("paren name one word", ko("담당자 응우옌(Nguyen) 님", "Nguyen"), "담당자 Nguyen 님");
eq("paren kept when source has parens", ko("보증금(선금)", "cọc (deposit)"), "보증금(선금)");
eq("paren kept for image", ko("보증금(선금)", "", true), "보증금(선금)");
eq("paren number kept", ko("수량(5,000개)", "x"), "수량(5,000개)");
eq("paren code kept", ko("상업송장(CI)", "x"), "상업송장(CI)");
// 빗금
eq("slash ko", ko("여긴 보증금/계약금 달라고 하나요?", "Nhà nay có bảo cọc không"), "여긴 보증금 달라고 하나요?");
eq("slash kept source", ko("입고/출고", "nhập/xuất"), "입고/출고");
eq("slash number kept", ko("5/6 출고", "x"), "5/6 출고");
eq("slash en kept", ko("A/S 문의", "x"), "A/S 문의");
eq("slash kept for image", ko("보증금/계약금", "", true), "보증금/계약금");
// ~고자 합니다
eq("gojahanda", ko("견적을 문의드리고자 합니다.", "x"), "견적을 문의드리려고 합니다.");
eq("gojahanda share", ko("공유해 드리고자 합니다", "x"), "공유해 드리려고 합니다");
eq("gojahanda hao-ni", ko("확인하고자 하오니 회신 바랍니다", "x"), "확인하려고 하니 회신 바랍니다");
eq("gojahanda irregular kept", ko("의견을 듣고자 합니다", "x"), "의견을 듣고자 합니다");
eq("gojahanda en untouched", en("문의드리고자 합니다", "x"), "문의드리고자 합니다");
// 숫자 · 이름 · 따옴표는 그대로
eq("numbers kept", ko("14,900개, 5~6주", "14,900 5~6"), "14,900개, 5~6주");
// 지침: v2 는 그대로, v3 에만 새 절
const room = { lang: "VI", tone: "neutral", context: "", glossary: "" };
eq("v2 prompt has no voice", P(room, "", "v2").includes("SOUND LIKE A PERSON"), false);
eq("v3 prompt has voice", P(room, "", "v3").includes("SOUND LIKE A PERSON"), true);
eq("v3 prompt VI rules", P(room, "", "v3").includes("Into Vietnamese"), true);
eq("v3 prompt EN room", P({ ...room, lang: "EN" }, "", "v3").includes("Into English"), true);
eq("v3 prompt other room", P({ ...room, lang: "JA" }, "", "v3").includes("Into Japanese"), true);
eq("v2 default arg unchanged", P(room, ""), P(room, "", "v2"));

console.log(`humanize: ${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
