#!/usr/bin/env node
// 번역 결과의 «AI 티» 세기 — 사람 말투 규칙(v3)이 실제로 듣는지 숫자로 본다. 고치지는 않는다.
//   node tools/humanize/lint.mjs <items.json> [--by-rule] [--show]
//   items.json = [{ id, lang: "ko"|"en"|"vi"|..., text, source }]  (text = 번역문, source = 원문)
// 규칙: rules/slop-gate-*.json (hwajongpark/slop-gate, MIT) + house-rules.json (im-not-ai · humanizer-ko · blader/humanizer · vietnamese-humanizer 에서 추림).
// 원문에 이미 있는 티(예: 원문의 em dash)는 세지 않는다. 결과는 «100건당 티 수» 로 비교한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));
const sg = (name) => load(`rules/slop-gate-${name}.json`);
const house = load("house-rules.json").packs;

function compile(rules, flags = "") {
  return rules.map((r) => ({ ...r, re: r.match ? new RegExp(r.match, `g${flags.includes("i") ? "i" : ""}u`) : null, unless: r.unlessSource ? new RegExp(r.unlessSource, "u") : null }));
}
const PACKS = {
  ko: [...compile(sg("korean").rules), ...compile(house.ko)],
  en: [...compile(sg("vocabulary").rules, "i"), ...compile(house.en, "i")],
  vi: [...compile(sg("vietnamese").rules, "i"), ...compile(house.vi, "i")],
};
const PUNCT = compile(sg("punctuation").rules);

function special(id, text) {
  if (id === "mixedPronoun") {
    const casual = /(?<![\p{L}\p{M}])(bên mình|bên bạn)(?![\p{L}\p{M}])/iu.test(text);
    const formal = /(?<![\p{L}\p{M}])(chúng tôi|Quý công ty)(?![\p{L}\p{M}])/iu.test(text);
    return casual && formal ? 1 : 0;
  }
  if (id === "aDensity") {
    const n = (text.match(/(?<![\p{L}\p{M}])ạ(?=\s*[.!?…]|\s*$)/gmu) || []).length;
    return n > 2 ? n - 2 : 0;
  }
  return 0;
}

export function lintOne({ lang, text, source = "" }) {
  const hits = [];
  const pack = PACKS[lang] || [];
  for (const r of [...PUNCT, ...pack]) {
    if (r.special) {
      const n = special(r.special, text);
      if (n) hits.push({ id: r.id, n });
      continue;
    }
    if (r.unless && r.unless.test(source)) continue;
    const found = text.match(r.re) || [];
    if (!found.length) continue;
    const inSource = source ? (source.match(new RegExp(r.re.source, r.re.flags)) || []).length : 0;
    const n = found.length - inSource;
    if (n > 0) hits.push({ id: r.id, n, sample: found[0] });
  }
  return hits;
}

export function lintAll(items) {
  const byRule = {};
  const byLang = {};
  let total = 0;
  const rows = items.map((it) => {
    const hits = lintOne(it);
    const n = hits.reduce((a, h) => a + h.n, 0);
    total += n;
    const L = (byLang[it.lang] ||= { items: 0, tells: 0, withTell: 0 });
    L.items += 1;
    L.tells += n;
    if (n) L.withTell += 1;
    for (const h of hits) byRule[h.id] = (byRule[h.id] || 0) + h.n;
    return { id: it.id, lang: it.lang, n, hits };
  });
  for (const L of Object.values(byLang)) L.per100 = Math.round((L.tells / L.items) * 1000) / 10;
  return { items: items.length, tells: total, per100: Math.round((total / Math.max(1, items.length)) * 1000) / 10, byLang, byRule, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node tools/humanize/lint.mjs <items.json> [--by-rule] [--show]");
    process.exit(2);
  }
  const res = lintAll(JSON.parse(fs.readFileSync(file, "utf8")));
  console.log(`items ${res.items} · tells ${res.tells} · per 100 ${res.per100}`);
  for (const [k, v] of Object.entries(res.byLang)) console.log(`  ${k}: ${v.items} items · ${v.tells} tells · ${v.withTell} with a tell · per 100 ${v.per100}`);
  if (process.argv.includes("--by-rule")) for (const [k, v] of Object.entries(res.byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (process.argv.includes("--show")) for (const r of res.rows.filter((x) => x.n)) console.log(`  [${r.id}] ${r.hits.map((h) => `${h.id}«${h.sample || ""}»`).join(" ")}`);
  process.exit(0);
}
