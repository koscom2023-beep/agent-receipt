import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";
import { rekorAnchorPath } from "./receiptStore.js";

// ── badge (Phase9·회의 #6) — "공개 로그로 점프하는" README 배지 스니펫 ──
// 원칙: 배지는 장식이 아니라 링크다 — 제3자 Rekor 앵커(.rekor.json 사이드카·anchor --upload 산출물)가
//   있어야만 발급한다. 앵커 없는 배지 = 자가주장을 검증처럼 꾸미는 것이라 거부(exit 2·정직).
// 네트워크 0: 이미 저장된 사이드카의 verifyUrl 을 재사용할 뿐, 여기서 아무것도 등록/조회하지 않는다.
// SVG 는 사이트가 정적으로 서빙(https://receipt.promptia.kr/badge.svg) — 외부 배지 서비스 의존 0.

const line = "─".repeat(56);
const BADGE_SVG_URL = "https://receipt.promptia.kr/badge.svg";

export function runBadge(receiptArg: string | undefined): never {
  if (!receiptArg) {
    console.error("badge: --receipt <path> 가 필요합니다 (Rekor 앵커된 영수증 — Work/Verification 모두 가능).");
    process.exit(2);
  }
  const abs = isAbsolute(receiptArg) ? receiptArg : join(process.cwd(), receiptArg);
  if (!existsSync(abs)) {
    console.error(`badge: 영수증 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const sidecar = rekorAnchorPath(abs);
  if (!existsSync(sidecar)) {
    console.error("badge: Rekor 앵커 사이드카(.rekor.json)가 없음 — 먼저 `agent-receipt anchor --upload --receipt <p>`.");
    console.error("  (공개 로그 없는 배지는 자가주장을 검증처럼 꾸미는 장식이라 발급하지 않습니다.)");
    process.exit(2);
  }
  let verifyUrl = "";
  let logIndex: unknown = null;
  try {
    const a = JSON.parse(readFileSync(sidecar, "utf8")) as { verifyUrl?: unknown; logIndex?: unknown };
    if (typeof a.verifyUrl === "string" && a.verifyUrl) verifyUrl = a.verifyUrl;
    logIndex = a.logIndex ?? null;
  } catch {
    console.error(`badge: 사이드카 파싱 실패: ${basename(sidecar)}`);
    process.exit(2);
  }
  if (!verifyUrl) {
    console.error("badge: 사이드카에 verifyUrl 없음(구버전 앵커?) — anchor --upload 재실행.");
    process.exit(2);
  }
  console.log("");
  console.log(line);
  console.log(`badge — 공개 검증 링크 배지 (Rekor logIndex ${String(logIndex ?? "?")})`);
  console.log(line);
  console.log("README 에 붙여넣기 (배지 클릭 = 제3자 투명성 로그에서 직접 검증):");
  console.log("");
  console.log(`[![agent-receipt: Rekor-anchored](${BADGE_SVG_URL})](${verifyUrl})`);
  console.log("");
  console.log("  보증: 배지는 '이 영수증 해시가 그 시점에 공개 로그에 존재'로 점프하는 링크 —");
  console.log("  내용의 옳음이 아니라 존재·시점의 제3자 검증가능성입니다(발급 조건=앵커 실재).");
  console.log(line);
  console.log("");
  process.exit(0);
}
