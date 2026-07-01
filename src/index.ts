// ── agent-receipt SDK (L7 씨앗) ──
// 라이브러리 표면: 외부가 `import { evaluateClaim } from "@promptia-labs/agent-receipt"` 로 쓴다.
// CLI 는 여전히 bin(dist/cli.js)이 primary — 이건 import 용 export 만 모은다(3차 "추출 seam"의 실체화).
// 정직: 라이브러리화의 씨앗이지, 채택(adoption)은 여전히 시장의 몫(L8).

export {
  SCHEMA_VERSION,
  CHECK_REGISTRY,
  CHECK_KINDS,
  claimSchema,
  evaluateClaim,
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
} from "./evidencekernel.js";
export type {
  CitationStatus,
  NumberStatus,
  DateStatus,
  LinkStatus,
  HashStatus,
  SignatureStatus,
  ClaimEvaluation,
  EvalClaimInput,
  CheckDescriptor,
} from "./evidencekernel.js";

export { buildVerificationReceipt, tierProvenance, replayVerificationReceipt } from "./vreceipt.js";
export type { VReceiptInput } from "./vreceipt.js";

export { loadReceipts, queryReceipts } from "./graph.js";
export type { VRRow, GraphFilters } from "./graph.js";
