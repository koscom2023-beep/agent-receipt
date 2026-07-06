// ── agent-receipt SDK 배럴 (L7) ──
// 외부: `import { evaluateClaim } from "@promptia-labs/agent-receipt"`.
// CLI(bin=dist/cli.js)는 여전히 primary — 이 배럴은 import 표면만 모은다.
//
// 구획(공개 계약의 경계 — docs/SDK.md 가 SoT):
//   [Stable]      아래 "Stable" 블록 — semver 약속 대상. 0.x 에서도 깨지 않는 것을 목표로 하고,
//                 깨야 할 땐 CHANGELOG + 최소 1 minor 의 deprecation 유예를 거친다.
//   [Provisional] 아래 "Provisional" 블록 — 쓸 수 있으나 예고 없이 바뀔 수 있음(계약 아님).
//   [내부]        이 배럴에 없는 모든 것 — deep import(dist/*.js 직접)는 어떤 보장도 없다.
// graph JSON 계약(CLI `graph view --format json`)과 이 SDK 는 *같은 함수*가 생산한다 — 의미론 동일.

// ════════════════ Stable — semver 약속 대상 ════════════════

// 평가(표준 포맷의 단일 의미론) + 스키마/버전
export {
  SCHEMA_VERSION,
  CLAIM_FINGERPRINT_VERSION,
  claimFingerprintV1,
  CHECK_KINDS,
  claimSchema,
  evaluateClaim,
} from "./evidencekernel.js";
export type { ClaimEvaluation, EvalClaimInput, Grade } from "./evidencekernel.js";
export { CHECK_GRADES, GRADE_RANK } from "./evidencekernel.js";

// Verification Receipt 생산/재검증
export { buildVerificationReceipt, tierProvenance, replayVerificationReceipt } from "./vreceipt.js";
export type { VReceiptInput } from "./vreceipt.js";
export { runBench, scoreClaim, computeMetrics, verdictOf } from "./bench.js";
export type { Verdict, BenchClaim, ClaimScore, BenchMetrics } from "./bench.js";
export { leafHash, nodeHash, merkleRoot, merkleRootHex, inclusionProof, verifyInclusion, consistencyProof, verifyConsistency, runMerkle } from "./merkle.js";
export { buildClaimVerificationStatement, claimVerificationPredicateSchema, CLAIM_VERIFICATION_PREDICATE_TYPE, runPredicate } from "./predicate.js";
export { VERIFICATION_CROSSWALK, CROSSWALK_SOURCE, renderCrosswalkMd, renderCrosswalkJson, runCrosswalk } from "./controls.js";

// 로딩 → 그래프/집계/triage/diff/이력/상태판 (CLI graph 표면과 같은 함수)
export {
  loadReceipts, queryReceipts, buildViewData,
  buildGraph,
  buildSummary, buildFailures, buildFailureEvents, buildIndexes,
  filterFailureEvents,
  buildGraphDiff, failureKey,
  buildHistory, resolveFingerprintPrefix,
  buildSubjects,
  EXCEPTION_KINDS,
} from "./graph.js";
export type {
  ExceptionKind,
  VRRow, GraphFilters,
  GraphNode, GraphEdge, GraphEdgeType, EdgeBasis,
  GraphSummary, FailureEntry, FailureEvent, GraphIndexes, FailureFilters,
  GraphDiffResult, DiffMatchMode,
  HistoryItem, HistoryChange,
  SubjectRollup,
} from "./graph.js";

// ════════════════ Provisional — 예고 없이 변경 가능(계약 아님) ════════════════
// 저수준 커널 헬퍼·개별 check 함수·레지스트리 자료구조. evaluateClaim 이 표준 진입점이며,
// 이들은 그 내부 부품의 노출이다. 외부 요구가 생기면 Stable 로 승격한다(승격=non-breaking).
export {
  CHECK_REGISTRY,
  citationStatus,
  verifyCitationInText,
  normalizeForCitation,
  numberStatus,
  parseNumbersFromText,
  recompute,
  dateStatus,
  canonicalizeDate,
  linkStatus,
  hashStatus,
  signatureStatus,
  commitStatus,
  fileChangedStatus,
  diffContainsStatus,
  schemaStatus,
  schemaMismatches,
  versionStatus,
  semverSatisfies,
  parseSemver,
  fileStatus,
  receiptStatus,
  artifactStatus,
} from "./evidencekernel.js";
export type {
  CitationStatus,
  NumberStatus,
  DateStatus,
  LinkStatus,
  HashStatus,
  SignatureStatus,
  CommitStatus,
  FileChangedStatus,
  DiffContainsStatus,
  SchemaStatus,
  SchemaMismatch,
  VersionStatus,
  FileStatus,
  ReceiptStatus,
  ReceiptFacts,
  ArtifactStatus,
  ArtifactFacts,
  ArtifactConstraints,
  CheckDescriptor,
} from "./evidencekernel.js";
