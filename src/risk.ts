import { loadSavedReceipt } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";
import type { Receipt } from "./receipt.js";

// ── AI 작업 위험 신호 (12차 council) — 읽기전용 투영: 한 작업이 '검토·범위·안정성' 위험을 안고 git 에 착지했나 ──
// 🔴 정체성: 코드 품질/기술부채를 *측정하지 않는다*(그건 SonarQube/AST 영역). 우리는 "무엇이/검토 없이 git 에 착지했나"는 *출처-사실*만 본다.
//   전부 영수증이 이미 가진 데이터(범위이탈·규모·검사·capture)로 산출·코드 내용 미열람·per-task(n=1 작동). 점수·등급·예측 없음.

// 테스트 '파일'을 *경로 패턴*으로만 판정(내용·충분성 평가 0). __tests__/ · test(s)/ · spec/ · *.test.* · *.spec.* · *_test.*
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$/i;

export interface RiskFlag {
  code: string;
  label: string;
  detail: string;
}
export interface RiskResult {
  flags: RiskFlag[];
  captureActive: boolean; // capture 로그가 존재했나(없으면 행위 위험 미관측)
}

/** 순수: 영수증 → 위험 신호 목록(A2 범위·A3 미검토수용·A4 민감/불안정). 코드 내용 미열람. */
export function buildRiskFlags(r: Receipt): RiskResult {
  const flags: RiskFlag[] = [];
  // A2 — 범위·고위험 경로(선언 vs 실제)
  if (r.deniedHits?.length) flags.push({ code: "denied-path", label: "금지 경로 변경", detail: `${r.deniedHits.length}건: ${r.deniedHits.slice(0, 5).join(", ")}` });
  if (r.outOfScope?.length) flags.push({ code: "out-of-scope", label: "계약 범위 밖 변경", detail: `${r.outOfScope.length}건` });
  const crit = (r.criticalPaths ?? []).filter((c) => c.touched.length);
  if (crit.length) flags.push({ code: "critical-path", label: "고위험 경로 touch", detail: crit.map((c) => c.glob).join(", ") });

  // A3 — 미검토 수용 외형(큰 변경 + 필수검사 미통과/0 + 테스트 경로 파일 0). 사실만, 품질판단 0.
  const mag = r.magnitude ?? { filesChanged: 0, added: 0, deleted: 0, newFiles: 0 };
  const testFiles = (r.touched ?? []).filter((p) => TEST_PATH.test(p)).length;
  const checksWeak = !r.checks?.length || r.checks.some((c) => !c.ok);
  const sizable = (mag.filesChanged ?? 0) >= 3 || (mag.added ?? 0) >= 50;
  if (sizable && checksWeak && testFiles === 0) {
    const why = !r.checks?.length ? "필수검사 0개" : "필수검사 미통과";
    flags.push({ code: "unreviewed-acceptance", label: "검증 없이 수용된 큰 변경", detail: `${mag.filesChanged}파일 +${mag.added}/-${mag.deleted}줄 · ${why} · 테스트 경로 파일 추가 0` });
  }

  // A4 — 민감/불안정 행위(capture). 관측된 op + 경로 '이름'만.
  const s = r.actionsSummary;
  const captureActive = r.actions !== undefined;
  if (s) {
    if (s.secretFilesRead) flags.push({ code: "secret-read", label: "비밀 경로 읽기", detail: `${s.secretFilesRead}건` });
    if (s.externalCalls) flags.push({ code: "external-call", label: "외부 네트워크 호출", detail: `${s.externalCalls}건` });
    if (s.createdThenDeleted) flags.push({ code: "created-deleted", label: "생성 후 삭제(헛발질·불안정 가능)", detail: `${s.createdThenDeleted}건` });
  }
  return { flags, captureActive };
}

/** 순수: 위험 신호 → 사람용 텍스트. owner 보고용 쉬운 말·'부채 측정 아님' 라벨. */
export function renderRiskMd(r: Receipt): string {
  const { flags, captureActive } = buildRiskFlags(r);
  const L: string[] = [];
  L.push(`# AI 작업 위험 신호 — ${r.contractId}${r.title ? ` (${r.title})` : ""}`);
  L.push("");
  L.push("> 이건 **코드 품질·기술부채를 *측정*하는 게 아닙니다**(그건 별도 정적분석 도구의 일). “무엇이 / 검토·범위·안정성 면에서 위험하게 git 에 착지했나”라는 **출처-사실 신호**일 뿐 — 점수·등급·예측 없음.");
  L.push("");
  if (!flags.length) {
    L.push("- 위험 신호 없음(이 영수증 기준).");
  } else {
    for (const f of flags) L.push(`- ⚠️ **${f.label}** — ${f.detail}`);
  }
  L.push("");
  if (!captureActive) L.push("> capture 미설치/비활성 — 비밀읽기·외부호출 같은 git 밖 행위 위험은 **미관측**(없음 아님). `capture install` 후 재확인.");
  L.push("> AI 주장 ↔ git 실제 대조(숨긴 변경)는 `claims`, git↔capture 대사는 `capture show`, 추세·재발은 `insights` 참조.");
  L.push(`> ${LIMIT_NOTE}`);
  return L.join("\n");
}

/** 순수: 위험 신호 → 안정 JSON. */
export function renderRiskJson(r: Receipt): string {
  const { flags, captureActive } = buildRiskFlags(r);
  return JSON.stringify(
    {
      contractId: r.contractId,
      kind: "ai-work-risk-signals",
      note: "provenance/review/scope risk signals — NOT a code-quality or technical-debt measurement. No scores/grades/predictions.",
      captureActive,
      flags,
      limitNote: LIMIT_NOTE,
    },
    null,
    2,
  );
}

/** `agent-receipt risk [--receipt <p>] [--format md|json]` — 저장 receipt 의 AI 작업 위험 신호(읽기전용 투영). receipt 미변경. */
export function runRisk(receiptPath: string | undefined, format: string | undefined, cwd: string = process.cwd()): never {
  const { receipt: r } = loadSavedReceipt(receiptPath, "risk", cwd); // 13차 council: 공용 로더
  process.stdout.write((format === "json" ? renderRiskJson(r) : renderRiskMd(r)) + "\n");
  process.exit(0);
}
