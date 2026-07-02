// 예제 ①: 영수증 디렉터리 읽기 → 중립 요약 + subject 상태판.
// 이 repo 안: node examples/read-receipts.mjs <receipts-dir>
// 외부 소비자: import { buildViewData, buildSummary, buildSubjects } from "@promptia-labs/agent-receipt";
import { buildViewData, buildSummary, buildSubjects } from "../dist/index.js";

const dir = process.argv[2];
if (!dir) {
  console.error("사용법: node examples/read-receipts.mjs <receipts-dir>");
  process.exit(2);
}
const rows = buildViewData(dir);
const s = buildSummary(rows);
console.log(`영수증 ${s.total}건 · pass ${s.pass} · fail ${s.fail} · tampered ${s.tamperedCount} (중립 카운트·판단 아님)`);
for (const sub of buildSubjects(rows)) {
  console.log(`- ${sub.subject}: 영수증 ${sub.receipts} · fail ${sub.fail} · 실패 이벤트 ${sub.failureEvents}`);
}
