import type { Contract } from "./schema.js";

const line = "─".repeat(56);

// review = 사람이 commit 전 훑는 체크리스트(질문 목록). lint(advisory warning)와 역할이 다르다.
// 사실 항목은 ✓(충족)/⚠(미충족), 사람이 판단할 항목은 ☐(체크박스)로 표시. 항상 read-only exit 0.
export function runReview(contract: Contract): never {
  const denied = contract.scope.denied_paths;
  const has = (sub: string): boolean => denied.some((d) => d.includes(sub));
  const allowedN = contract.scope.allowed_paths.length;
  const cmds = contract.required_checks?.commands?.length ?? 0;

  type Item = { mark: boolean | null; q: string };
  const items: Item[] = [
    { mark: null, q: `allowed_paths(${allowedN}개)가 이번 작업에 충분히 좁은가? (넓을수록 범위검사가 약해짐)` },
    { mark: has(".env"), q: "denied_paths 에 .env* (비밀)이 포함됐는가?" },
    { mark: has("lock"), q: "denied_paths 에 lockfile(package-lock/pnpm-lock)이 포함됐는가?" },
    { mark: has("migrations"), q: "denied_paths 에 DB migrations 가 포함됐는가?" },
    { mark: has("vercel") || has(".vercel"), q: "denied_paths 에 배포 설정(vercel.json/.vercel)이 포함됐는가?" },
    { mark: cmds > 0 ? true : null, q: cmds > 0 ? `required_checks.commands(${cmds}개)가 실제 검사인가?` : "required_checks.commands 가 비어 있음 — 의도인가? (check 가 vacuous PASS)" },
    { mark: null, q: "receipt 를 기본 위치(.agent-guard/receipts/)에 저장할 것인가? (그 밖이면 verify 가 잡음)" },
    { mark: null, q: "AI 완료 claim(JSON)을 받아 `agent-receipt claims` 로 대조할 것인가?" },
    { mark: null, q: "commit/push/deploy 금지를 prompt 에 넣었는가? (prompt 출력은 이미 포함)" },
  ];

  const sym = (m: boolean | null): string => (m === true ? "✓" : m === false ? "⚠" : "☐");

  console.log("");
  console.log(line);
  console.log(`agent-receipt review: ${contract.id}  — commit 전 사람 체크리스트`);
  console.log(line);
  for (const it of items) console.log(`  ${sym(it.mark)} ${it.q}`);
  console.log(line);
  console.log("  (☐ = 사람이 판단 / ✓ = 충족 / ⚠ = 미충족. lint 는 별도 advisory 경고.)");
  console.log("");
  process.exit(0);
}
