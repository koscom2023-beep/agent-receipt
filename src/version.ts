import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 패키지 이름(npm latest 조회용) — package.json 과 동일 단일 출처.
export const PKG_NAME = "@promptia-labs/agent-receipt";

// 설치된 버전 = 이 패키지의 package.json. dist/version.js·src/version.ts 모두 루트 기준 ../package.json.
// 계약/git 무관 — 어디서든 동작(읽기 실패 시 "unknown", 절대 throw 안 함).
export function installedVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// 현재 실행 파일 경로(진단용). argv[1] = 실행된 cli 스크립트(전역 설치면 bin 경로).
export function binaryPath(): string {
  return process.argv[1] ?? "(unknown)";
}

/**
 * npm 레지스트리 latest 버전(advisory). 절대 throw 하지 않는다 — 실패 시 null.
 *  - AGENT_RECEIPT_NO_NET=1 이면 네트워크 조회 생략(오프라인/CI/golden 결정론).
 *  - 짧은 timeout. 네트워크 실패·미발행·npm 부재 모두 null(doctor 를 실패시키지 않음).
 */
export function npmLatest(timeoutMs = 4000): string | null {
  if (process.env["AGENT_RECEIPT_NO_NET"] === "1") return null;
  try {
    const out = execSync(`npm view ${PKG_NAME} version`, {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const v = out.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// 숫자 3-part semver 비교(새 의존성 없이). a<b→-1, a==b→0, a>b→1. 비교 불가(프리릴리스/형식오류)→null.
export function compareVersions(a: string, b: string): number | null {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  if (pa.length < 3 || pb.length < 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
