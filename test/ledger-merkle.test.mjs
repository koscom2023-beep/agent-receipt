// 백로그: R3 Merkle 투명로그의 원장 실배선 — entryHash leaf·root·일관성(원장 위 포크 탐지).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerMerkleLeaves } from "../dist/ledger.js";

// 순수: entryHash 만 leaf(미체인 레거시 라인 제외)
assert.deepEqual(ledgerMerkleLeaves([{ entryHash: "a" }, { entryHash: "b" }, {}]), ["a", "b"], "entryHash만·미체인 제외");

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ar-ledmerkle-"));
mkdirSync(join(dir, ".agent-guard"), { recursive: true });
const lines = ["e0", "e1", "e2", "e3"].map((h) => JSON.stringify({ timestamp: "t", entryHash: h })).join("\n") + "\n";
writeFileSync(join(dir, ".agent-guard", "ledger.jsonl"), lines);

// root: 원장 4엔트리 위 Merkle root
const root = spawnSync("node", [cli, "ledger", "merkle", "root"], { cwd: dir, encoding: "utf8" });
assert.equal(root.status, 0, "root exit0");
assert.ok(/tree size : 4/.test(root.stdout), "4 엔트리");
assert.ok(/root\s+: [0-9a-f]{64}/.test(root.stdout), "root 64hex");

// 일관성 self-check(old-size 2) 통과
const cons = spawnSync("node", [cli, "ledger", "merkle", "consistency", "--old-size", "2"], { cwd: dir, encoding: "utf8" });
assert.equal(cons.status, 0, "일관성 self-check exit0");
assert.ok(/append-only 로 확장됨/.test(cons.stdout), "일관성 OK 메시지");

// 포크 탐지: 게시된 old-root(정상 2엔트리) vs 과거 엔트리 개찬된 원장 → 불일치 exit1
// 정상 2엔트리의 root 를 별 디렉터리에서 구해 old-root 로 제시
const dir2 = mkdtempSync(join(tmpdir(), "ar-ledmerkle2-"));
mkdirSync(join(dir2, ".agent-guard"), { recursive: true });
writeFileSync(join(dir2, ".agent-guard", "ledger.jsonl"), ["e0", "e1"].map((h) => JSON.stringify({ entryHash: h })).join("\n") + "\n");
const r2 = spawnSync("node", [cli, "ledger", "merkle", "root"], { cwd: dir2, encoding: "utf8" });
const oldRoot = r2.stdout.match(/root\s+: ([0-9a-f]{64})/)[1];
// 개찬 원장: 과거 e0 를 TAMPERED 로 바꾼 4엔트리
const forked = mkdtempSync(join(tmpdir(), "ar-ledforked-"));
mkdirSync(join(forked, ".agent-guard"), { recursive: true });
writeFileSync(join(forked, ".agent-guard", "ledger.jsonl"), ["TAMPERED", "e1", "e2", "e3"].map((h) => JSON.stringify({ entryHash: h })).join("\n") + "\n");
const fork = spawnSync("node", [cli, "ledger", "merkle", "consistency", "--old-size", "2", "--old-root", oldRoot], { cwd: forked, encoding: "utf8" });
assert.equal(fork.status, 1, "게시 old-root 와 개찬 원장 불일치=포크 탐지 exit1");

console.log("ledger-merkle.test: OK — 원장 entryHash 위 Merkle root·일관성·cross-time 포크 탐지(재체인 공격 잡음)");
