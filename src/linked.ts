import { minimatch } from "minimatch";
import type { Contract } from "./schema.js";

// 0.9: touched 파일을 계약 기준 3분류(표시 전용).
//   ★ verify --json 의 outOfScope 14키 의미는 절대 바꾸지 않는다 — 이건 사람용 surface 의 라벨링일 뿐이다.
//   linkedTests 는 "allowed 밖이지만 linked_test_paths 매칭(직접 가드 테스트)" → verify 는 여전히 outOfScope 로 본다.
export interface TouchedClassification {
  allowed: string[];
  linkedTests: string[];
  trueOutOfScope: string[];
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(file, p, { dot: true }));
}

export function classifyTouched(files: string[], contract: Contract): TouchedClassification {
  const allowedGlobs = contract.scope.allowed_paths;
  const linkedGlobs = contract.linked_test_paths ?? [];
  const allowed: string[] = [];
  const linkedTests: string[] = [];
  const trueOutOfScope: string[] = [];
  for (const f of files) {
    if (allowedGlobs.length === 0 || matchesAny(f, allowedGlobs)) {
      // allowed 비면 positive 범위검사 꺼짐(verify 와 동일) → 전부 allowed 취급.
      allowed.push(f);
    } else if (linkedGlobs.length && matchesAny(f, linkedGlobs)) {
      linkedTests.push(f);
    } else {
      trueOutOfScope.push(f);
    }
  }
  return { allowed, linkedTests, trueOutOfScope };
}
