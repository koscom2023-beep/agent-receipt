// Stage 1b(6차 council) — Rekor 앵커 sidecar 기록 → share-proof 검증 링크 임베드.
// 잠금: buildRekorAnchor 형태 · 앵커 없으면 바이트 동일 · 앵커 있으면 클릭형 href(자동로드 src 0) · sidecar 목록 제외 · loader.
// `node test/rekor-anchor.test.mjs`. 네트워크(실 Rekor 등록)는 owner 수동이라 미검(순수+fs 부분만 잠금).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRekorAnchor } from "../dist/anchor.js";
import { toProofHtml } from "../dist/shareproof.js";
import { listReceipts, loadRekorAnchor, rekorAnchorPath, hasRekorAnchor } from "../dist/receiptStore.js";

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

// ── 순수: buildRekorAnchor ──
check("buildRekorAnchor — verifyUrl/apiUrl/필드 정답값", () => {
  const a = buildRekorAnchor("ABC123", 42);
  assert.equal(a.uuid, "ABC123");
  assert.equal(a.logIndex, 42);
  assert.equal(a.verifyUrl, "https://search.sigstore.dev/?uuid=ABC123");
  assert.equal(a.apiUrl, "https://rekor.sigstore.dev/api/v1/log/entries/ABC123");
});
check("buildRekorAnchor — logIndex null 허용", () => {
  assert.equal(buildRekorAnchor("u", null).logIndex, null);
});

// 최소 Receipt(toProofHtml 이 쓰는 필드만).
const r = {
  schemaVersion: "1.0",
  ok: true,
  contractId: "demo",
  title: null,
  branch: { current: "main", expected: null, ok: true },
  headHash: "abc1234",
  timestamp: "2026-01-01T00:00:00.000Z",
  touched: ["a.ts"],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  violations: [],
  session: null,
  checks: [{ name: "build", exitCode: 0, requiredExit: 0, ok: true }],
  magnitude: { filesChanged: 1, added: 2, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  policy: null,
  environment: {},
  disclosure: "x",
  actions: [{ tool: "Bash", op: "network", host: "api.example", flag: "EXTERNAL_NETWORK_CALL" }],
  actionsSummary: { total: 1, secretFilesRead: 0, externalCalls: 1, createdThenDeleted: 0, gitVisible: 0 },
  contentHash: "sha256:deadbeef",
};

// ── 바이트 불변: 앵커 없으면 도입 전과 동일 ──
check("앵커 미전달 = null = undefined → 출력 바이트 동일", () => {
  assert.equal(toProofHtml(r), toProofHtml(r, null));
  assert.equal(toProofHtml(r), toProofHtml(r, undefined));
});
check("앵커 없으면 앵커 섹션·검증URL 흔적 0(비앵커 영수증 오염 금지)", () => {
  const h = toProofHtml(r);
  assert.ok(!h.includes("Third-party anchor"), "앵커 섹션 누출");
  assert.ok(!h.includes("transparency log"), "검증 문구 누출");
  assert.ok(!h.includes("sigstore.dev"), "검증 URL 누출");
  assert.ok(!h.includes("https://"), "외부 URL 누출(비앵커는 자동로드/링크 0)");
});

// ── 앵커 있으면 클릭형 검증 링크 임베드 ──
const html = toProofHtml(r, buildRekorAnchor("UUID-XYZ", 7));
check("앵커 섹션 + 클릭형 검증 href", () => {
  assert.ok(html.includes("Third-party anchor"), "앵커 섹션 누락");
  assert.ok(html.includes('href="https://search.sigstore.dev/?uuid=UUID-XYZ"'), "검증 href 누락");
  assert.ok(html.includes("transparency log"), "검증 문구 누락");
});
check("logIndex·UUID 표시", () => {
  assert.ok(html.includes("UUID-XYZ"), "uuid 미표시");
  assert.ok(html.includes(">7<") || html.includes("7"), "logIndex 미표시");
});
check("앵커 있어도 자동로드(src=) 0 — 열람만으로 유출 없음", () => {
  assert.ok(!html.includes("src="), "src= 존재(외부 자동로드 위험)");
});
check("앵커 정직 라벨 — keyless 신원 아님 명시", () => {
  assert.ok(html.includes("not a keyless"), "정직 라벨 누락");
  assert.ok(html.includes("tamper-evident"), "기존 정직 라벨도 유지");
});
check("앵커 값도 HTML esc(injection 방어)", () => {
  const evil = toProofHtml(r, buildRekorAnchor('"><script>x</script>', 1));
  assert.ok(!evil.includes("<script>x</script>"), "uuid 미이스케이프(주입)");
  assert.ok(evil.includes("&lt;script&gt;"), "esc 누락");
});

// ── fs 왕복: sidecar 경로·목록 제외·loader ──
const cwd = join(tmpdir(), "agent-receipt-rekor-test");
rmSync(cwd, { recursive: true, force: true });
const recDir = join(cwd, ".agent-guard", "receipts");
mkdirSync(recDir, { recursive: true });
const receiptAbs = join(recDir, "2026-01-01T00-00-00.000Z.json");
writeFileSync(receiptAbs, JSON.stringify({ ok: true, contentHash: "sha256:x" }) + "\n");
const anchorAbs = rekorAnchorPath(receiptAbs);
writeFileSync(anchorAbs, JSON.stringify(buildRekorAnchor("FS-UUID", 99), null, 2) + "\n");

check("rekorAnchorPath — sidecar 규칙(영수증경로 + .rekor.json)", () => {
  assert.equal(anchorAbs, receiptAbs + ".rekor.json");
});
check("listReceipts — .rekor.json sidecar 는 영수증으로 안 잡힘", () => {
  const names = listReceipts(cwd).map((e) => e.name);
  assert.deepEqual(names, ["2026-01-01T00-00-00.000Z.json"], `목록 오염: ${names.join(",")}`);
});
check("hasRekorAnchor / loadRekorAnchor — 존재 시 파싱", () => {
  assert.ok(hasRekorAnchor(receiptAbs));
  const a = loadRekorAnchor(receiptAbs);
  assert.equal(a?.uuid, "FS-UUID");
  assert.equal(a?.logIndex, 99);
  assert.equal(a?.verifyUrl, "https://search.sigstore.dev/?uuid=FS-UUID");
});
check("loadRekorAnchor — 없으면 null", () => {
  assert.equal(loadRekorAnchor(join(recDir, "nope.json")), null);
});
check("loadRekorAnchor — 깨진 sidecar 면 null(증거 위조 안 함)", () => {
  const bad = join(recDir, "bad.json");
  writeFileSync(rekorAnchorPath(bad), "{ not json");
  assert.equal(loadRekorAnchor(bad), null);
});
rmSync(cwd, { recursive: true, force: true });

if (fail.length) {
  console.error(`rekor-anchor: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`rekor-anchor: ${pass} pass, 0 fail`);
