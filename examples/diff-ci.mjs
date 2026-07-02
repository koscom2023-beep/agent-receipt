// 예제 ③: CI 회귀 게이트 — base/head 영수증 집합 비교, 신규 실패 있으면 exit 1.
// 이 repo 안: node examples/diff-ci.mjs <base-dir> <head-dir>
// 외부 소비자: import { buildViewData, buildGraphDiff } from "@promptia-labs/agent-receipt";
import { buildViewData, buildGraphDiff } from "../dist/index.js";

const [baseDir, headDir] = process.argv.slice(2);
if (!baseDir || !headDir) {
  console.error("사용법: node examples/diff-ci.mjs <base-dir> <head-dir>");
  process.exit(2);
}
const d = buildGraphDiff(buildViewData(baseDir), buildViewData(headDir));
console.log(`신규 ${d.newFailures.length} · 해소 ${d.resolvedFailures.length} · 상태변화 ${d.statusChanged.length} · 지속 ${d.persistingCount}`);
for (const [subj, c] of Object.entries(d.bySubject)) {
  console.log(`- ${subj}: 신규 ${c.new} · 해소 ${c.resolved} · 지속 ${c.persisting}`);
}
// 신규 실패 = 집합 비교 사실(판단 아님). 해소 ≠ 고침의 증명.
process.exit(d.newFailures.length ? 1 : 0);
