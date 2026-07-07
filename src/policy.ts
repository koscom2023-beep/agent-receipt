import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { minimatch } from "minimatch";
import * as g from "./git.js";
import { touchedFull } from "./evidence.js";

// ── policy.yaml ──
// contract = "이번 작업에서 허용된 파일 범위"(휘발), policy = "프로젝트 상시 규칙"(영속). 둘은 별개 파일·별개 SSOT.
// policy 는 verify --json 의 14키를 절대 확장하지 않는다(별도 표면). 자동 commit/revert 하지 않는다 — 검사·표시만.

export const POLICY_REL = join(".agent-guard", "policy.yaml");

const PolicySchema = z.object({
  // 0.9: 작업 모드(standard 기본 — 하위호환). measure_first/observe_only 는 commit-check self-report 체크리스트만.
  mode: z.enum(["standard", "measure_first", "observe_only"]).default("standard"),
  requireReceipt: z.boolean().default(false),
  requireClaims: z.boolean().default(false),
  requireCheck: z.boolean().default(false),
  requireApprovalFor: z.array(z.string()).default([]),
  forbidAlways: z.array(z.string()).default([]),
  protectAlways: z.array(z.string()).default([]),
  maxUntrackedAllowed: z.number().optional(),
  // 실시간 가드 모드(guard.ts) — warn(기본): capture 레코드에 표시만 / block: PreToolUse 에서 금지 경로 쓰기를 도구 실행 전 차단.
  guard: z.enum(["warn", "block"]).default("warn"),
  // 루프 개입(council 2026-07-03 L1~L2) — 같은 test/build/lint 명령이 *사이 파일변경 0*으로 N회째 재실행될 때
  // guard 모드에 따라 warn/deny. 미설정=완전 off(디스크 스캔조차 안 함). strict 프로필에도 미포함(별도 명시 opt-in).
  loop_repeat_threshold: z.number().int().min(2).optional(),
  // P1 v0.18 (council D3) — done 의 exit 게이트 opt-in: 세션 판정이 임계 이상이면 done 이 exit 1.
  //   fail=FAIL 만(현행과 동일·명시용) · incomplete=FAIL+INCOMPLETE · warn=FAIL+INCOMPLETE+PASS_WITH_WARNINGS.
  //   미설정=현행 그대로(receipt.ok 만). 판정/출력은 불변 — exit 코드만 올림(발동 시 done 이 원인 1줄 자백).
  //   ⚠ warn 임계는 고위험 경로(critical_paths)를 일상적으로 만지는 repo 에 비권장(알람 피로 — DA 지적).
  fail_on_done: z.enum(["fail", "incomplete", "warn"]).optional(),
});

// 0.9: 모드별 self-report 체크리스트(도구는 git diff 만 봄 — 의미 위반은 자동검출 불가, 사람/AI self-report).
export function modePrinciples(mode: string): string[] {
  if (mode === "measure_first") {
    return ["작업 모드 measure_first 체크리스트(self-report·guidance — 강제 아님, 사람 검토 필요): AI호출 0 · DB write 0 · 관측부착 0 · pipeline wiring 0 · 점수교체 0 (git diff 로는 의미 위반 자동검출 불가)"];
  }
  if (mode === "observe_only") {
    return ["작업 모드 observe_only 체크리스트(self-report·guidance — 강제 아님, 사람 검토 필요): DB write 0 · 점수교체 0 · trigger 변경 0 · 차단/fail-closed 0 · behavior 변경 0 (git diff 로는 의미 위반 자동검출 불가)"];
  }
  return [];
}

export type Policy = z.infer<typeof PolicySchema>;

export function policyPath(cwd: string = process.cwd()): string {
  return join(cwd, POLICY_REL);
}

export function policyExists(cwd: string = process.cwd()): boolean {
  return existsSync(policyPath(cwd));
}

// 형식 오류를 throw 하지 않고 안전하게 로드(verify/receipt/commit-check 용 — 14키 절대 안 깸).
export function loadPolicySafe(cwd: string = process.cwd()): { policy: Policy | null; error: string | null } {
  const p = policyPath(cwd);
  if (!existsSync(p)) return { policy: null, error: null };
  let data: unknown;
  try {
    data = parseYaml(readFileSync(p, "utf8"));
  } catch (e: any) {
    return { policy: null, error: `policy.yaml 파싱 실패: ${e?.message ?? e}` };
  }
  const parsed = PolicySchema.safeParse(data);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    return { policy: null, error: `policy.yaml 형식 오류:\n${msg}` };
  }
  return { policy: parsed.data, error: null };
}

export interface PolicyObs {
  forbidAlwaysHits: string[];
  protectAlwaysHits: string[];
  approvalNeededHits: string[];
}

// 상시 규칙 glob 을 full working tree 변경에 매칭(차단 아님 — 관찰/표시용). checks.ts 와 동일 규칙(dot:true).
export function policyObservations(policy: Policy, files: string[]): PolicyObs {
  const m = (globs: string[]): string[] => files.filter((f) => globs.some((gl) => minimatch(f, gl, { dot: true })));
  return {
    forbidAlwaysHits: m(policy.forbidAlways),
    protectAlwaysHits: m(policy.protectAlways),
    approvalNeededHits: m(policy.requireApprovalFor),
  };
}

export function hasAnyObs(o: PolicyObs): boolean {
  return o.forbidAlwaysHits.length > 0 || o.protectAlwaysHits.length > 0 || o.approvalNeededHits.length > 0;
}

// ── 내장 프로필(인라인 YAML — templates/ 비의존, 외부 registry 없음) ──
export const POLICY_PROFILES: Record<string, string> = {
  "solo-founder":
    `# agent-receipt policy — solo-founder\n` +
    `# contract=이번 작업 범위, policy=상시 규칙. 자동 차단/커밋 없음 — 검사·표시만.\n` +
    `requireReceipt: true\nrequireClaims: false\nrequireCheck: false\n` +
    `forbidAlways:\n  - ".env*"\n` +
    `requireApprovalFor:\n  - "package-lock.json"\n  - "supabase/migrations/**"\n` +
    `protectAlways: []\n`,
  "vibe-coder":
    `# agent-receipt policy — vibe-coder (가볍게: 경고 중심)\n` +
    `requireReceipt: false\nrequireClaims: false\nrequireCheck: false\n` +
    `forbidAlways:\n  - ".env*"\n` +
    `requireApprovalFor: []\n` +
    `protectAlways:\n  - "package-lock.json"\n  - "pnpm-lock.yaml"\n`,
  "agency-client":
    `# agent-receipt policy — agency-client (고객 검수 대비)\n` +
    `requireReceipt: true\nrequireClaims: true\nrequireCheck: false\n` +
    `forbidAlways:\n  - ".env*"\n` +
    `requireApprovalFor:\n  - "package-lock.json"\n  - "supabase/migrations/**"\n  - "vercel.json"\n` +
    `protectAlways: []\n`,
  "team-strict":
    `# agent-receipt policy — team-strict (엄격)\n` +
    `requireReceipt: true\nrequireClaims: true\nrequireCheck: true\n` +
    `forbidAlways:\n  - ".env*"\n` +
    `requireApprovalFor:\n  - "package-lock.json"\n  - "pnpm-lock.yaml"\n  - "supabase/migrations/**"\n  - "vercel.json"\n  - ".vercel/**"\n` +
    `protectAlways:\n  - "exports/**"\n  - "docs/arch/json/**"\n` +
    `maxUntrackedAllowed: 0\n`,
  strict:
    `# agent-receipt policy — strict (실시간 가드 block: 금지 경로 쓰기를 도구 실행 전에 차단)\n` +
    `# 기본 프로필들은 guard: warn(기록만). 이 프로필만 block — 오탐 시 guard: warn 으로 즉시 해제.\n` +
    `guard: block\n` +
    `requireReceipt: true\nrequireClaims: false\nrequireCheck: false\n` +
    `forbidAlways:\n  - ".env*"\n  - "secrets/**"\n  - "**/*.pem"\n  - "**/id_rsa*"\n` +
    `requireApprovalFor:\n  - "package-lock.json"\n  - "supabase/migrations/**"\n` +
    `protectAlways: []\n`,
  promptia:
    `# agent-receipt policy — promptia (본진 상시 규칙)\n` +
    `requireReceipt: true\nrequireClaims: false\nrequireCheck: false\n` +
    `forbidAlways:\n  - ".env*"\n` +
    `requireApprovalFor:\n  - "package-lock.json"\n  - "pnpm-lock.yaml"\n  - "supabase/migrations/**"\n  - "vercel.json"\n  - ".vercel/**"\n` +
    `protectAlways:\n  - "exports/**"\n  - "docs/arch/json/**"\n`,
};

const line = "─".repeat(56);

export type PolicySub = "init" | "check" | "show";

function runPolicyInit(profile: string | undefined, cwd: string): never {
  const prof = profile ?? "solo-founder";
  if (!(prof in POLICY_PROFILES)) {
    console.error(
      `알 수 없는 profile: ${prof} — 사용: agent-receipt policy init --profile <${Object.keys(POLICY_PROFILES).join("|")}>`,
    );
    process.exit(2);
  }
  const dir = join(cwd, ".agent-guard");
  const out = policyPath(cwd);
  if (existsSync(out)) {
    console.error(`이미 존재함: ${out} — 덮어쓰지 않습니다. 먼저 제거 후 다시 실행하세요.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, POLICY_PROFILES[prof]);
  console.log(`생성됨 (profile: ${prof}):\n  - ${out}`);
  console.log("  contract=이번 작업 범위, policy=상시 규칙. 검사: `agent-receipt policy check` / `commit-check`");
  process.exit(0);
}

function runPolicyShow(cwd: string): never {
  const { policy, error } = loadPolicySafe(cwd);
  if (error) {
    console.error("\n" + error + "\n");
    process.exit(2);
  }
  if (!policy) {
    console.log("\npolicy 없음 (.agent-guard/policy.yaml). 생성: agent-receipt policy init --profile <name>\n");
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log("agent-receipt policy (상시 규칙 — contract 와 별개)");
  console.log(line);
  if (policy.mode !== "standard") console.log(`mode           : ${policy.mode}`);
  if (policy.guard !== "warn") console.log(`guard          : ${policy.guard} (금지 경로 쓰기 실시간 차단)`); // 기본(warn)은 미표시 — 기존 출력 불변
  if (policy.fail_on_done) console.log(`fail_on_done   : ${policy.fail_on_done} (done 판정이 임계 이상이면 exit 1 — warn 임계는 고위험 경로를 일상 수정하는 repo 에 비권장)`); // 미설정은 미표시 — 기존 출력 불변
  console.log(`requireReceipt : ${policy.requireReceipt}`);
  console.log(`requireClaims  : ${policy.requireClaims}`);
  console.log(`requireCheck   : ${policy.requireCheck}`);
  console.log(`maxUntracked   : ${policy.maxUntrackedAllowed ?? "(제한 없음)"}`);
  console.log(`forbidAlways   : ${policy.forbidAlways.length ? policy.forbidAlways.join(", ") : "(없음)"}`);
  console.log(`protectAlways  : ${policy.protectAlways.length ? policy.protectAlways.join(", ") : "(없음)"}`);
  console.log(`approvalFor    : ${policy.requireApprovalFor.length ? policy.requireApprovalFor.join(", ") : "(없음)"}`);
  console.log(line);
  console.log("");
  process.exit(0);
}

function runPolicyCheck(cwd: string): never {
  const { policy, error } = loadPolicySafe(cwd);
  if (error) {
    console.error("\n" + error + "\n");
    process.exit(2);
  }
  if (!policy) {
    console.log("\npolicy 없음 (.agent-guard/policy.yaml). 생성: agent-receipt policy init --profile <name>\n");
    process.exit(0);
  }
  if (!g.isGitRepo()) {
    console.error("policy check 는 git 저장소에서 실행하세요 (변경 관찰 필요).");
    process.exit(2);
  }
  const files = touchedFull();
  const obs = policyObservations(policy, files);
  console.log("");
  console.log(line);
  console.log("agent-receipt policy check (상시 규칙 ↔ 현재 변경)");
  console.log(line);
  if (obs.forbidAlwaysHits.length) {
    console.log(`forbidAlways  : ✗ ${obs.forbidAlwaysHits.length}건 닿음 — ${obs.forbidAlwaysHits.join(", ")}`);
  } else {
    console.log("forbidAlways  : ✓ 변경 없음");
  }
  console.log(
    obs.protectAlwaysHits.length
      ? `protectAlways : ⚠️ ${obs.protectAlwaysHits.length}건 닿음 — ${obs.protectAlwaysHits.join(", ")}`
      : "protectAlways : ✓ 변경 없음",
  );
  console.log(
    obs.approvalNeededHits.length
      ? `approvalFor   : ⚠️ 승인 필요 경로 ${obs.approvalNeededHits.length}건 — ${obs.approvalNeededHits.join(", ")} (승인 확인은 commit-check)`
      : "approvalFor   : ✓ 승인 필요 경로 변경 없음",
  );
  console.log(line);
  // forbidAlways 가 닿으면 FAIL(상시 금지). 그 외(protect/approval)는 표시·게이트는 commit-check.
  const ok = obs.forbidAlwaysHits.length === 0;
  console.log(ok ? "결과: PASS ✅ (상시 금지 경로 변경 없음)" : "결과: FAIL ❌ (forbidAlways 변경 — 검토 필요, 자동 revert 안 함)");
  console.log("이 도구는 git 작업트리 기준입니다 — .gitignore·레포 밖·OS·DB·외부 서비스는 보지 못합니다.");
  console.log(line);
  console.log("");
  process.exit(ok ? 0 : 1);
}

/** `agent-receipt policy <init|check|show>` — contract 불필요(.agent-guard/policy.yaml 만). */
export function runPolicy(sub: string | undefined, profile: string | undefined, cwd: string = process.cwd()): never {
  if (sub === "init") runPolicyInit(profile, cwd);
  if (sub === "show") runPolicyShow(cwd);
  if (sub === "check") runPolicyCheck(cwd);
  console.error("사용: agent-receipt policy <init [--profile <name>] | check | show>");
  process.exit(2);
}
