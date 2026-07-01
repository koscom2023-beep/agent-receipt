import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import * as g from "./git.js";

// ── 환경/출처(provenance) 캡처 ──
// SLSA "무엇이·어디서·언제·어떻게" 발상의 로컬 최소판: git/node/os + 계약·정책 해시 + 패키지 버전.
// 원칙: AI 모델명을 자동 감지하지 않는다(추측 금지). claim 에 model/tool 이 있으면 호출부가
//       "AI 주장 메타데이터"로만 별도 기록한다(여기서는 안 넣음).
// 한계: 이 메타는 git 작업트리 기준이며, .gitignore·레포 밖·OS·DB 변경은 담지 않는다.

export interface Environment {
  generatedAt: string;
  repoRoot: string | null;
  branch: string;
  headHash: string;
  gitVersion: string | null;
  nodeVersion: string;
  npmVersion: string | null;
  os: { platform: string; arch: string; release: string };
  agentReceiptVersion: string;
  package: { name: string; version: string } | null;
  contractHash: string | null;
  policyHash: string | null;
  // provenance(에이전트/모델) — 명시값만. 자동 추측 0. flag(--agent/--model) > env(AGENT_RECEIPT_AGENT/MODEL) > none.
  provenance: { agent: string | null; model: string | null; source: "flag" | "env" | "none" };
  // 어느 에이전트 세션이 이 영수증을 만들었나(추적성). Claude Code 세션 안(훅 포함)이면 CLAUDE_CODE_SESSION_ID,
  // 사람이 직접 실행하면 null → "에이전트 세션 산출 아님"을 의미있게 구분. contentHash 입력엔 미포함(environment 전체 제외).
  agentSession: string | null;
  note: string;
}

export function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

// 파일 내용의 sha256. 없거나 못 읽으면 null. (계약/정책 해시용 — 결정론적 무결성 식별자)
export function hashFileOrNull(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return sha256(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// 새 의존성 없이 외부 도구 버전을 best-effort 로 얻는다. 실패/부재면 null(차단 아님).
function toolVersion(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// 설치된 패키지 자신의 package.json(개발 시 repo 루트, 배포 시 dist/ 상위). init.ts 의 templatePath 패턴과 동일.
function selfPackage(): { name: string; version: string } | null {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    const o = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
    if (typeof o.name === "string" && typeof o.version === "string") {
      return { name: o.name, version: o.version };
    }
    return null;
  } catch {
    return null;
  }
}

export interface CaptureOpts {
  contractPath?: string;
  policyPath?: string;
  agent?: string; // 명시 에이전트명(--agent). 없으면 env AGENT_RECEIPT_AGENT, 그래도 없으면 null.
  model?: string; // 명시 모델명(--model). 없으면 env AGENT_RECEIPT_MODEL, 그래도 없으면 null.
}

// 추론 금지(council C2): flag 우선, 다음 명시 env 변수, 둘 다 없으면 null/none. 도구별 env 추측 안 함.
function resolveProvenance(opts: CaptureOpts): Environment["provenance"] {
  const envAgent = process.env.AGENT_RECEIPT_AGENT?.trim() || null;
  const envModel = process.env.AGENT_RECEIPT_MODEL?.trim() || null;
  const flagAgent = opts.agent?.trim() || null;
  const flagModel = opts.model?.trim() || null;
  const agent = flagAgent ?? envAgent;
  const model = flagModel ?? envModel;
  const source: "flag" | "env" | "none" = flagAgent || flagModel ? "flag" : envAgent || envModel ? "env" : "none";
  return { agent, model, source };
}

export function captureEnvironment(opts: CaptureOpts = {}): Environment {
  const pkg = selfPackage();
  return {
    generatedAt: new Date().toISOString(),
    repoRoot: g.repoRoot(),
    branch: g.currentBranch(),
    headHash: g.headHash(),
    gitVersion: toolVersion("git", ["--version"]),
    nodeVersion: process.version,
    npmVersion: toolVersion("npm", ["--version"]),
    os: { platform: process.platform, arch: process.arch, release: release() },
    agentReceiptVersion: pkg?.version ?? "(unknown)",
    package: pkg,
    contractHash: hashFileOrNull(opts.contractPath),
    policyHash: hashFileOrNull(opts.policyPath),
    provenance: resolveProvenance(opts),
    agentSession: process.env.CLAUDE_CODE_SESSION_ID?.trim() || null,
    note: "git 작업트리 기준 환경 메타 — .gitignore·레포 밖·OS·DB·외부 서비스는 담지 않음. 에이전트/모델은 자동 추측하지 않고 명시값(--agent/--model 또는 AGENT_RECEIPT_AGENT/MODEL)만 기록.",
  };
}
