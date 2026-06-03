import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadContract } from "./schema.js";
import * as g from "./git.js";
import { DEFAULT_CONTRACT_PATHS, discoverContract } from "./discover.js";
import { resolveSession } from "./session.js";
import { binaryPath, installedVersion, npmLatest, compareVersions } from "./version.js";

const line = "─".repeat(56);

type Finding = { level: "ok" | "warn" | "err"; msg: string };

/**
 * `agent-receipt doctor` — 환경/설정 건강 점검(read-only): git repo / 계약 발견·유효 / baseline 상태.
 * 계약 품질(allowed/denied/forbidden_actions)은 `lint` 가 담당. exit = 오류(✗) 있으면 1, 아니면 0.
 */
export function runDoctor(cwd: string = process.cwd()): never {
  const f: Finding[] = [];

  const isRepo = g.isGitRepo();
  f.push(isRepo ? { level: "ok", msg: "git 저장소" } : { level: "err", msg: "git 저장소 아님 — verify/start 사용 불가" });

  const cPath = discoverContract(cwd);
  let hasContract = false;
  if (!cPath) {
    f.push({ level: "warn", msg: "계약 없음 — 'agent-receipt init --preset generic' 권장" });
  } else {
    const rel = DEFAULT_CONTRACT_PATHS.find((p) => existsSync(join(cwd, p))) ?? cPath;
    try {
      const c = loadContract(cPath);
      hasContract = true;
      f.push({ level: "ok", msg: `계약 발견: ${rel}` });
      // Promptia preset 감지(id: promptia) → denied_paths 핵심 누락은 lint 가 점검.
      if (c.id === "promptia") {
        f.push({ level: "ok", msg: "preset: promptia 감지 — denied_paths 핵심 누락은 'agent-receipt lint' 가 점검" });
      }
    } catch (e) {
      f.push({ level: "err", msg: `계약 형식 오류: ${(e as Error).message.split("\n")[0]}` });
    }
  }

  if (isRepo) {
    const s = resolveSession(cwd);
    if (!s.session) f.push({ level: "ok", msg: "baseline 없음 (full-tree 검사)" });
    else if (s.applied) f.push({ level: "ok", msg: "baseline 활성" });
    else f.push({ level: "warn", msg: `baseline 무효(${s.reason}) — 'agent-receipt reset' 권장` });
  }

  if (hasContract) f.push({ level: "ok", msg: "계약 품질은 'agent-receipt lint' 로 점검" });

  console.log("");
  console.log(line);
  console.log("agent-receipt doctor");
  console.log(line);

  // ── 설치/버전 진단(advisory — git/계약 진단과 별개, exit code 에 영향 없음) ──
  // npm latest 조회 실패(오프라인/미발행/네트워크)는 doctor 를 실패시키지 않는다 — 참고 표시만.
  const cur = installedVersion();
  const latest = npmLatest();
  console.log("설치:");
  console.log(`  실행 파일 : ${binaryPath()}`);
  console.log(`  현재 버전 : ${cur}`);
  if (latest === null) {
    console.log("  npm latest: 확인 안 함 (오프라인/조회 생략)");
    console.log("  업데이트   : 확인 불가 (advisory — git 진단과 무관)");
  } else {
    console.log(`  npm latest: ${latest}`);
    const cmp = compareVersions(cur, latest);
    if (cmp === null) {
      console.log("  업데이트   : 비교 불가 (advisory)");
    } else if (cmp < 0) {
      console.log(`  업데이트   : ⚠️ 새 버전이 있습니다: ${cur} → ${latest}`);
      console.log("               npm install -g @promptia-labs/agent-receipt@latest");
    } else {
      console.log("  업데이트   : OK (최신)");
    }
  }
  console.log(line);

  for (const x of f) console.log(`  ${x.level === "ok" ? "✓" : x.level === "warn" ? "⚠" : "✗"} ${x.msg}`);
  console.log(line);
  const errs = f.filter((x) => x.level === "err").length;
  const warns = f.filter((x) => x.level === "warn").length;
  console.log(errs ? `결과: 문제 ${errs}건 (경고 ${warns})` : `결과: OK (경고 ${warns})`);
  console.log("");
  process.exit(errs ? 1 : 0);
}
