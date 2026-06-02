import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "./presets.js";

// repo 최상위에 있으면 allowed_paths 후보로 넣을 디렉터리(스캔). 순서가 곧 출력 순서.
const CANDIDATE_DIRS = [
  "app", "src", "components", "lib", "hooks", "pages", "public", "scripts", "tests", "e2e", "packages", "database", "extensions", "docs", "styles",
];
const DEFAULT_DENIED = [
  ".env*", "package-lock.json", "pnpm-lock.yaml", "supabase/migrations/**", "vercel.json", ".vercel/**", "exports/**", "docs/arch/json/**",
];

function detectAllowed(cwd: string): string[] {
  const found = CANDIDATE_DIRS.filter((d) => existsSync(join(cwd, d)));
  return (found.length ? found : ["src"]).map((d) => `"${d}/**"`);
}

function scanDraft(cwd: string): string {
  const allowed = detectAllowed(cwd);
  const L: string[] = [];
  L.push("# agent-receipt draft contract — repo 스캔 기반 초안. 검토 후 수정하세요.");
  L.push("# 스키마 SSOT: CONTRACT.md. 이 명령은 .agent-guard/contract.yaml 을 덮어쓰지 않습니다.");
  L.push("id: draft");
  L.push("title: draft contract");
  L.push("mode: patch_only");
  L.push("scope:");
  L.push("  allowed_paths:");
  for (const a of allowed) L.push(`    - ${a}`);
  L.push("  denied_paths:");
  for (const d of DEFAULT_DENIED) L.push(`    - "${d}"`);
  L.push("forbidden_actions:");
  L.push("  - push");
  L.push("  - deploy");
  L.push("required_checks:");
  L.push("  commands: []");
  L.push("git:");
  L.push("  require_no_staged_untracked: false");
  L.push("  require_only_allowed_files_staged: false");
  L.push("  require_no_denied_path_diff: true");
  L.push("  require_no_push: false");
  L.push("");
  return L.join("\n");
}

/**
 * `agent-receipt draft-contract [--preset <name>] [--out <path>] [--print]`
 * 계약 초안을 생성한다(비대화형). 기본은 stdout, --out 있을 때만 파일 저장(기존 파일 덮어쓰기 금지).
 *  - --preset: 해당 builtin template 을 초안으로(스캔 대신).
 *  - 미지정: repo 최상위를 스캔해 allowed_paths 후보를 만든다.
 * 출력은 A1 동결 스키마(loadContract) 와 호환된다. exit 0/1(덮어쓰기)/2(usage).
 */
export function runDraftContract(
  preset: string | undefined,
  outArg: string | undefined,
  print: boolean,
  cwd: string = process.cwd(),
): never {
  let body: string;
  if (preset) {
    if (!(preset in PRESETS)) {
      console.error(`draft-contract: 알 수 없는 preset: ${preset} — 'agent-receipt presets' 로 목록 확인.`);
      process.exit(2);
    }
    body = readFileSync(fileURLToPath(new URL(`../templates/${PRESETS[preset].file}`, import.meta.url)), "utf8");
  } else {
    body = scanDraft(cwd);
  }
  const text = body.endsWith("\n") ? body : body + "\n";

  if (outArg) {
    const out = isAbsolute(outArg) ? outArg : join(cwd, outArg);
    if (existsSync(out)) {
      console.error(`draft-contract: 이미 존재: ${outArg} — 덮어쓰지 않습니다.`);
      process.exit(1);
    }
    writeFileSync(out, text);
    console.log(`초안 저장: ${outArg}`);
    console.log("  검토 후 .agent-guard/contract.yaml 로 옮기거나 --contract 로 지정해 사용하세요.");
    if (print) process.stdout.write(text);
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
}
