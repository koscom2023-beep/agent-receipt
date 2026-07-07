import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, join } from "node:path";
import * as g from "./git.js";
import { claimSchema } from "./evidencekernel.js";

// (experimental) Claude Code transcript(JSONL) → claim.json 초안.
// 형식 변동에 관대(parse 실패줄 skip, 필드 없으면 무시) — 못 찾으면 빈 목록(절대 죽지 않음).
// git 검증이 아니라 self-report 보조. 이후 `claims --file` 로 git 실측과 대조한다.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function extractPaths(jsonl: string): string[] {
  const set = new Set<string>();
  for (const ln of jsonl.split("\n")) {
    if (!ln.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(ln);
    } catch {
      continue; // 손상/비JSON 라인 skip
    }
    const content = (o as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<Record<string, unknown>>) {
      if (c?.type === "tool_use" && typeof c?.name === "string" && EDIT_TOOLS.has(c.name)) {
        const input = c.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
        const fp = input?.file_path ?? input?.notebook_path;
        if (typeof fp === "string" && fp) set.add(fp);
      }
    }
  }
  return [...set];
}

function toRepoRel(p: string, root: string | null): string {
  if (!root || !isAbsolute(p)) return p;
  const rel = relative(root, p);
  return (rel.startsWith("..") || isAbsolute(rel) ? p : rel).replace(/\\/g, "/"); // 레포 밖이면 절대경로 유지·구분자 forward-slash 통일(3R·Windows)
}

// ── 백로그 D8 (council 2026-07-07) — LLM 분해 브릿지: 분해는 LLM·판정은 결정론(R6 원칙) ──
// LLM 을 절대 호출하지 않는다(네트워크 0·키 0). ①--llm-prompt = 아무 LLM 에나 줄 결정론 분해 프롬프트 방출
// (스키마 SSOT=claimSchema()) ②--from-llm = LLM 응답을 allowlist 로 정규화(발명 필드 드랍·미검증 라벨 박제)
// → 진짜 판정은 `research verify` 가 결정론으로(날조 quotedText 는 not-found 로 기계 격추 — DA-4 해소 구조).

// 스키마 SSOT 에서 claim 필드 allowlist 도출(하드코딩 드리프트 방지).
export function claimFieldAllowlist(): string[] {
  const props = (claimSchema() as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(props).sort();
}

/** `gen-claim --llm-prompt [--out <p>]` — 외부 LLM 용 분해 프롬프트(결정론 텍스트·스키마 임베드) 방출. */
export function runGenClaimLlmPrompt(outArg: string | undefined, cwd: string = process.cwd()): never {
  const schema = JSON.stringify(claimSchema(), null, 2);
  const prompt = [
    "You are decomposing an AI agent's work report / research text into independently verifiable claims",
    "for `agent-receipt research verify` — a deterministic, non-LLM checker.",
    "",
    'OUTPUT: JSON only — {"query": "<one-line topic>", "claims": [ { <claim fields per schema below> } ]}',
    "",
    "RULES (violations are mechanically caught downstream — do not rely on being trusted):",
    "1. quotedText MUST be a verbatim copy from the source. Never paraphrase, never invent — a fabricated quote fails as `not-found`.",
    "2. Attach evidence fields only when you actually have them; omit unknowns (a claim without evidence becomes `advisory`, not `verified`).",
    "3. One assertion per claim — split compound sentences into separate claims.",
    "4. Arithmetic claims: provide statedNumbers plus recompute {op, operands}.",
    "5. Use only fields in the schema below — unknown fields are dropped by `gen-claim --from-llm`.",
    "",
    "CLAIM SCHEMA (SSOT = `agent-receipt spec --format json`):",
    schema,
    "",
    "NOTE: Your output is a *proposal* (unverified decomposition). Judgment stays deterministic —",
    "`research verify` grades every check (A/B/C) and fails fabrications. 분해는 LLM, 판정은 결정론.",
  ].join("\n");
  if (outArg) {
    const p = isAbsolute(outArg) ? outArg : join(cwd, outArg);
    writeFileSync(p, prompt + "\n");
    console.log(`분해 프롬프트 저장: ${outArg}`);
    console.log("  → 아무 LLM 에나 이 프롬프트+원문을 주고, 응답 JSON 을 `gen-claim --from-llm <resp.json>` 으로 정규화하세요.");
  } else {
    process.stdout.write(prompt + "\n");
  }
  process.exit(0);
}

/**
 * `gen-claim --from-llm <resp.json> [--out <claim.json>]` — LLM 분해 응답을 결정론 정규화.
 * allowlist(스키마 SSOT) 밖 필드 드랍·statement 없는 claim 드랍·미검증 라벨을 파일에 박제.
 * 판정은 하지 않는다 — 다음 단계 `research verify --file` 이 결정론 판정(날조=not-found 격추).
 */
export function runGenClaimFromLlm(fileArg: string, outArg: string | undefined, cwd: string = process.cwd()): never {
  const p = isAbsolute(fileArg) ? fileArg : join(cwd, fileArg);
  if (!existsSync(p)) {
    console.error(`gen-claim --from-llm: 파일 없음: ${fileArg}`);
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    console.error(`gen-claim --from-llm: JSON 파싱 실패: ${fileArg} — LLM 응답에서 JSON 본문만 저장했는지 확인.`);
    process.exit(2);
  }
  const obj = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const rawClaims = Array.isArray(obj.claims) ? obj.claims : [];
  const allow = new Set(claimFieldAllowlist());
  const droppedKeys = new Set<string>();
  let droppedClaims = 0;
  const claims: Record<string, unknown>[] = [];
  for (const rc of rawClaims) {
    if (!rc || typeof rc !== "object" || Array.isArray(rc)) {
      droppedClaims++;
      continue;
    }
    const src = rc as Record<string, unknown>;
    if (typeof src.statement !== "string" || !src.statement.trim()) {
      droppedClaims++; // statement 없는 주장 = 표시 불가 — 드랍(발명해 채우지 않음)
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (allow.has(k)) kept[k] = src[k];
      else droppedKeys.add(k);
    }
    claims.push(kept);
  }
  if (!claims.length) {
    console.error("gen-claim --from-llm: 사용할 claim 0건(statement 필수) — LLM 응답 형식 확인.");
    process.exit(2);
  }
  const outDoc = {
    query: typeof obj.query === "string" && obj.query.trim() ? obj.query : "(query 없음)",
    note: "UNVERIFIED — LLM 분해 산출(발명 가능·판정 아님). 판정은 결정론: agent-receipt research verify --file <이 파일>",
    claims,
  };
  const out = outArg ?? join(cwd, "claims-from-llm.json");
  writeFileSync(out, JSON.stringify(outDoc, null, 2) + "\n");
  console.log(`정규화 완료(미검증): ${outArg ?? "claims-from-llm.json"} — claim ${claims.length}건 유지 · 드랍 ${droppedClaims}건${droppedKeys.size ? ` · 스키마 밖 필드 드랍: ${[...droppedKeys].sort().join(", ")}` : ""}`);
  console.log("  ⚠️ 이 파일은 LLM 의 *제안*입니다(발명 가능) — 판정: agent-receipt research verify --file " + (outArg ?? "claims-from-llm.json"));
  console.log("  (날조 quotedText 는 research verify 가 not-found 로 기계 격추 — 분해는 LLM·판정은 결정론.)");
  process.exit(0);
}

/**
 * `agent-receipt gen-claim --transcript <jsonl> [--out <claim.json>]` (experimental)
 * 에이전트 transcript 의 편집 tool_use 에서 파일 경로를 모아 claim.json 초안을 만든다.
 * git 검증 아님(self-report 보조) — 이후 `claims --file` 로 대조. 형식 변동에 관대(graceful).
 */
export function runGenClaim(transcript: string | undefined, outArg: string | undefined, cwd: string = process.cwd()): never {
  if (!transcript) {
    console.error("gen-claim: --transcript <path.jsonl> 가 필요합니다 (에이전트 transcript).");
    process.exit(2);
  }
  if (!existsSync(transcript)) {
    console.error(`gen-claim: transcript 없음: ${transcript}`);
    process.exit(2);
  }
  let raw = "";
  try {
    raw = readFileSync(transcript, "utf8");
  } catch (e: unknown) {
    console.error(`gen-claim: transcript 읽기 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const root = g.repoRoot();
  const files = [...new Set(extractPaths(raw).map((p) => toRepoRel(p, root)))].sort();
  const claim = {
    changedFiles: files,
    newFiles: [] as string[],
    summary: `transcript-derived (experimental, git 검증 아님): ${files.length} edited path(s)`,
  };
  const out = outArg ?? join(cwd, "claim.json");
  writeFileSync(out, JSON.stringify(claim, null, 2) + "\n");
  console.log(`claim 초안 생성(experimental): ${out} (${files.length} 파일)`);
  console.log(`  ⚠️ git 검증 아님 — self-report 보조. 대조: agent-receipt claims --file ${out}`);
  console.log("  (transcript 형식은 도구 버전마다 다를 수 있어 누락 가능 — 빈 목록이면 형식 확인.)");
  process.exit(0);
}
