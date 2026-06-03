import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as g from "./git.js";
import { LIMIT_NOTE } from "./disclosure.js";

// 0.9: 코드 변경 없는 정찰/판단도 증거로 남긴다(audit-pack 포함). git 우회가 아니라
//      "이 커밋 시점의 판단"을 headHash 와 함께 기록 — notes/decisions 는 tool 산출(verify 제외).
const NOTE_TYPES = ["recon", "contract-draft", "no-code-decision", "next-options"] as const;
type NoteType = (typeof NOTE_TYPES)[number];

export function runNote(typeArg: string | undefined, message: string | undefined, cwd: string = process.cwd()): never {
  if (!typeArg || !(NOTE_TYPES as readonly string[]).includes(typeArg)) {
    console.error(`note: --type <${NOTE_TYPES.join("|")}> 가 필요합니다.`);
    process.exit(2);
  }
  const type = typeArg as NoteType;
  const subdir = type === "no-code-decision" ? "decisions" : "notes";
  const dir = join(cwd, ".agent-guard", subdir);
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, "-");
  const rel = join(".agent-guard", subdir, `${type}-${stamp}.json`);
  const record = {
    kind: "agent-receipt.note",
    type,
    message: message ?? "",
    headHash: g.headHash(),
    branch: g.currentBranch(),
    timestamp: ts,
    disclosure: LIMIT_NOTE,
  };
  writeFileSync(join(cwd, rel), JSON.stringify(record, null, 2) + "\n");

  console.log(`note 저장(${type}): ${rel}`);
  console.log("  코드 변경 없는 정찰/판단도 audit-pack 에 증거로 포함됩니다 (tool 산출 — verify 제외).");
  console.log("  " + LIMIT_NOTE);
  process.exit(0);
}
