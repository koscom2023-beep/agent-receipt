// 배치A-2·A-5 e2e — review 사이드카 정식화(approve/reject/note·하위호환) + inbox 키/배지 + share-proof 표면.
// `node test/review-sidecar.test.mjs`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

const repo = join(process.env.TMPDIR || "/tmp", `ar-review-${process.pid}`);
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
git("init"); git("config", "user.email", "rev@t.c"); git("config", "user.name", "rev"); git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "f.txt"), "x\n");
git("add", "-A"); git("commit", "-m", "init");
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8" });

run(["init", "--preset", "generic"]);
run(["begin", "--kind", "implementation"]);
writeFileSync(join(repo, "f.txt"), "x\ny\n");
run(["done"]);
const rdir = join(repo, ".agent-guard", "receipts");
const receipt = readdirSync(rdir).filter((n) => n.endsWith(".json") && !n.includes("approval")).sort().pop();
const rpath = join(".agent-guard", "receipts", receipt);

// 1) reject + note — hosted 4필드 + 구키 병기
let r = run(["review", "reject", "--receipt", rpath, "--note", "테스트 없음"]);
check("review reject — 사이드카 4필드+구키+자가보고 고지", () => {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("status: rejected") && r.stdout.includes("자가보고"), r.stdout);
  const sc = JSON.parse(readFileSync(join(rdir, receipt + ".approval.json"), "utf8"));
  assert.equal(sc.status, "rejected");
  assert.ok(sc.reviewer && sc.reviewedAt !== undefined && sc.note === "테스트 없음", "hosted 4필드");
  assert.ok(sc.approver && sc.approvedAt, "구키 병기(하위호환)");
});

// 2) inbox 반영 — reviewStatus + byReview + 신규 키 6종
r = run(["inbox", "--format", "json"]);
check("inbox — reviewStatus/byReview + 그룹핑 키 6종(null 안전)", () => {
  const d = JSON.parse(r.stdout);
  const row = d.rows.find((x) => x.file.endsWith(receipt));
  assert.equal(row.reviewStatus, "rejected");
  assert.equal(d.summary.byReview.rejected, 1);
  assert.ok("branch" in row && "sessionId" in row && "vendor" in row && "captureQuality" in row && "repoLabel" in row, "키 6종 존재");
  assert.ok(["full", "degraded", "none"].includes(row.captureQuality));
  assert.ok(typeof row.branch === "string" && row.branch.length > 0, "branch 기록(main/master 환경차 무관)");
});

// 3) share-proof 에 검토 기록 표면(자가보고 라벨)
run(["share-proof", "--out", "p.html"]);
check("share-proof — 'Review recorded: rejected' + 권위 아님 라벨", () => {
  const h = readFileSync(join(repo, "p.html"), "utf8");
  assert.ok(h.includes("Review recorded: rejected"), "status 표면");
  assert.ok(h.includes("not an authority") && h.includes("테스트 없음"), "자가보고 라벨+note");
});

// 4) approve 로 뒤집기 + approvals 목록 status 표기
run(["review", "approve", "--receipt", rpath, "--note", "수정 확인"]);
r = run(["approvals"]);
check("approvals 목록 — status 표기 + 자가보고 고지", () => {
  assert.ok(r.stdout.includes("✓ approved") && r.stdout.includes("수정 확인"), r.stdout);
  assert.ok(r.stdout.includes("자가보고"), "권위 아님 고지");
});

// 5) note 만 — 상태 보존
run(["review", "note", "--receipt", rpath, "--note", "메모만"]);
check("review note — 기존 status 보존(approved 유지)", () => {
  const sc = JSON.parse(readFileSync(join(rdir, receipt + ".approval.json"), "utf8"));
  assert.equal(sc.status, "approved");
  assert.equal(sc.note, "메모만");
});

// 6) 구식 사이드카(status 없음) = approved 하위호환
const legacy = receipt + ".legacy.json"; // 새 영수증 흉내: 원본 복사
writeFileSync(join(rdir, legacy), readFileSync(join(rdir, receipt)));
writeFileSync(join(rdir, legacy + ".approval.json"), JSON.stringify({ approver: "old", approvedAt: "2026-01-01T00:00:00Z", receipt: legacy, note: "" }));
r = run(["inbox", "--format", "json", "--all"]);
check("구식 approval(status 없음) = approved 로 간주(하위호환)", () => {
  const d = JSON.parse(r.stdout);
  const row = d.rows.find((x) => x.file.endsWith(legacy));
  assert.equal(row.reviewStatus, "approved");
});

// 7) 최초 note = needs-review
const third = receipt + ".third.json";
writeFileSync(join(rdir, third), readFileSync(join(rdir, receipt)));
run(["review", "note", "--receipt", join(".agent-guard", "receipts", third), "--note", "보류"]);
check("최초 note = needs-review", () => {
  const sc = JSON.parse(readFileSync(join(rdir, third + ".approval.json"), "utf8"));
  assert.equal(sc.status, "needs-review");
});

rmSync(repo, { recursive: true, force: true });
if (fail.length) {
  console.error(`review-sidecar.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`review-sidecar.test: OK (${pass}) — 4필드+구키·inbox 배지/키6종·share 표면·하위호환·note 보존/최초 needs-review`);

// ── 감사 fix(2026-07-07): 반려≠승인 — hasApproval/approvalsCountFor status-aware ──
{
  const dir = join(process.env.TMPDIR || "/tmp", `ar-reject-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const rp = join(dir, ".agent-guard", "receipts", "receipt-2026-01-01T00-00-00-000Z.json");
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, JSON.stringify({ ok: true, summary: "t" }));
  const side = rp + ".approval.json";
  // ① rejected 사이드카 = 승인 아님
  writeFileSync(side, JSON.stringify({ status: "rejected", reviewer: "r", reviewedAt: "t", note: "no" }));
  const rs = await import("../dist/receiptStore.js");
  assert.equal(rs.hasApproval(rp), false, "rejected 사이드카가 승인으로 둔갑");
  assert.equal(rs.approvalsCountFor(rp), 0, "rejected 인데 approvalsCount 1");
  assert.equal(rs.approvalStatusFor(rp), "rejected");
  // ② needs-review = 승인 아님
  writeFileSync(side, JSON.stringify({ status: "needs-review", reviewer: "r", reviewedAt: "t", note: "" }));
  assert.equal(rs.hasApproval(rp), false, "needs-review 가 승인으로 둔갑");
  // ③ legacy(status 없음) = approved 하위호환 유지
  writeFileSync(side, JSON.stringify({ approver: "old", approvedAt: "t" }));
  assert.equal(rs.hasApproval(rp), true, "legacy 사이드카 하위호환 깨짐");
  assert.equal(rs.approvalStatusFor(rp), "approved");
  // ④ 손상 JSON = 승인 아님(가짜 상태 금지)
  writeFileSync(side, "{broken");
  assert.equal(rs.hasApproval(rp), false, "손상 사이드카가 승인 취급");
  console.log("reject≠approval: 4 pass");
}
