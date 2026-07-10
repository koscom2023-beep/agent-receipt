// site/spec.html 이 SPEC.md 로부터 최신 생성본인지 강제(단일 원천 드리프트 차단).
//   SPEC.md 를 고치고 site/spec.html 을 재생성 안 하면 실패 → `node scripts/build-spec-html.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderSpecHtml } from "../scripts/build-spec-html.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "SPEC.md"), "utf8");
const committed = readFileSync(join(root, "site", "spec.html"), "utf8");
const regenerated = renderSpecHtml(md);

try {
  assert.equal(regenerated, committed);
  // 규범 스모크: 봉인 preimage 코드블록의 핵심 줄이 그대로 실렸는지.
  assert.ok(committed.includes("criticalTouched: sort(flatten(criticalPaths[].touched))"), "seal preimage 라인 누락");
  assert.ok(committed.includes("<h2>3. Seal"), "§3 헤딩 누락");
} catch (e) {
  console.error("spec-html.test: FAIL. site/spec.html 이 SPEC.md 와 어긋남. `node scripts/build-spec-html.mjs` 재생성 필요.");
  console.error("  " + e.message);
  process.exit(1);
}
console.log("spec-html.test: OK. site/spec.html = SPEC.md 최신 생성본(규범 블록 포함)");
