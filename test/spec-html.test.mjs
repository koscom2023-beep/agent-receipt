// site/spec.html · site/spec-ko.html 이 SPEC.md · SPEC.ko.md 로부터 최신 생성본인지 강제(단일 원천 드리프트 차단).
//   소스를 고치고 재생성 안 하면 실패 → `node scripts/build-spec-html.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderSpecHtml } from "../scripts/build-spec-html.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => readFileSync(join(root, p), "utf8");

const pairs = [
  { md: "SPEC.md", html: "site/spec.html", lang: "en" },
  { md: "SPEC.ko.md", html: "site/spec-ko.html", lang: "ko" },
];

const fail = [];
for (const p of pairs) {
  try {
    const regenerated = renderSpecHtml(R(p.md), { lang: p.lang });
    assert.equal(regenerated, R(p.html), `${p.html} 이 ${p.md} 와 어긋남`);
    const committed = R(p.html);
    // 규범 스모크: 봉인 preimage 코드블록의 핵심 줄이 그대로 실렸는지.
    assert.ok(committed.includes("criticalTouched: sort(flatten(criticalPaths[].touched))"), `${p.html}: seal preimage 라인 누락`);
    assert.ok(committed.includes('<html lang="' + p.lang + '"'), `${p.html}: lang 속성 불일치`);
  } catch (e) {
    fail.push(e.message);
  }
}

if (fail.length) {
  console.error("spec-html.test: FAIL. 스펙 HTML 이 소스와 어긋남. `node scripts/build-spec-html.mjs` 재생성 필요.");
  for (const f of fail) console.error("  " + f);
  process.exit(1);
}
console.log("spec-html.test: OK. spec.html + spec-ko.html = 소스 최신 생성본(규범 블록 포함)");
