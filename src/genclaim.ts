import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, join } from "node:path";
import * as g from "./git.js";

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
