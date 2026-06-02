import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "./presets.js";

// preset 목록(generic|nextjs-supabase|promptia|strict|relaxed)은 presets.ts 가 단일 출처.
const PRESET_NAMES = Object.keys(PRESETS).join("|");

// 템플릿은 패키지 안에 동봉된다(개발 시 repo 루트의 templates/). 모듈 위치 기준으로 찾는다.
function templatePath(name: string): string {
  return fileURLToPath(new URL(`../templates/${name}`, import.meta.url));
}

/**
 * `agent-guard init --preset <generic|nextjs-supabase|promptia|strict|relaxed>`
 * - .agent-guard/contract.yaml (선택한 preset)
 * - .agent-guard/README.md (에이전트 안내)
 * 둘 중 하나라도 이미 있으면 아무것도 쓰지 않고 실패(덮어쓰기 금지).
 * 항상 process.exit 로 끝난다(기존 명령 흐름과 분리).
 */
export function runInit(preset: string | undefined, cwd: string = process.cwd()): never {
  if (!preset || !(preset in PRESETS)) {
    console.error(
      `알 수 없는 preset: ${preset ?? "(없음)"} — 사용: agent-receipt init --preset <${PRESET_NAMES}>`
    );
    process.exit(2);
  }

  const dir = join(cwd, ".agent-guard");
  const contractOut = join(dir, "contract.yaml");
  const readmeOut = join(dir, "README.md");

  // 덮어쓰기 금지: 하나라도 존재하면 어떤 파일도 쓰지 않고 실패한다.
  for (const f of [contractOut, readmeOut]) {
    if (existsSync(f)) {
      console.error(`이미 존재함: ${f} — 덮어쓰지 않습니다. 먼저 제거 후 다시 실행하세요.`);
      process.exit(1);
    }
  }

  const contractBody = readFileSync(templatePath(PRESETS[preset].file), "utf8");
  const readmeBody = readFileSync(templatePath("agent-readme.md"), "utf8");

  mkdirSync(dir, { recursive: true });
  writeFileSync(contractOut, contractBody);
  writeFileSync(readmeOut, readmeBody);

  console.log(`생성됨 (preset: ${preset}):\n  - ${contractOut}\n  - ${readmeOut}`);
  process.exit(0);
}
