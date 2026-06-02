import { existsSync } from "node:fs";
import { join } from "node:path";

// --contract/-c 를 지정하지 않았을 때 자동으로 찾을 기본 계약 위치(우선순위 순서).
// 더 앞선 항목이 존재하면 그것을 쓴다.
export const DEFAULT_CONTRACT_PATHS = [
  ".agent-guard/contract.yaml",
  ".agent-guard/contract.json",
  "agent-guard.yaml",
  "agent-guard.json",
] as const;

/**
 * 기본 위치에서 계약 파일을 우선순위대로 탐색한다.
 * @returns 첫 번째로 존재하는 계약 경로. 하나도 없으면 undefined.
 *
 * 주의: --contract/-c 가 지정된 경우 cli.ts 는 이 함수를 호출하지 않는다(기존 동작 보존).
 */
export function discoverContract(cwd: string = process.cwd()): string | undefined {
  for (const rel of DEFAULT_CONTRACT_PATHS) {
    const candidate = join(cwd, rel);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
