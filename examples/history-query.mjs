// 예제 ②: 지문(접두 가능)으로 같은 주장의 시간축 이력 조회.
// 이 repo 안: node examples/history-query.mjs <receipts-dir> <cfp1:…|접두>
// 외부 소비자: import { buildViewData, buildHistory, resolveFingerprintPrefix } from "@promptia-labs/agent-receipt";
import { buildViewData, buildHistory, resolveFingerprintPrefix } from "../dist/index.js";

const [dir, prefix] = process.argv.slice(2);
if (!dir || !prefix) {
  console.error("사용법: node examples/history-query.mjs <receipts-dir> <cfp1:…|접두>");
  process.exit(2);
}
const rows = buildViewData(dir);
const r = resolveFingerprintPrefix(rows, prefix);
if (!r.fp) {
  console.error(r.candidates.length ? `접두 모호(${r.candidates.length}개): ${r.candidates.slice(0, 5).join(", ")}` : "일치 지문 없음");
  process.exit(2);
}
const h = buildHistory(rows, { claim: r.fp });
console.log(`이력 ${h.timeline.length}건 (시간축=verifiedAt 자가보고)`);
for (const t of h.timeline) {
  const ch = t.changes
    ? ` (+${t.changes.newFailures.length} −${t.changes.resolvedFailures.length} ~${t.changes.statusChanged.length})`
    : " (첫 등장)";
  console.log(`- ${t.verifiedAt ?? "-"} · ${t.verdict}${t.tampered ? " · ⚠tampered" : ""}${ch}`);
}
