// P0-4 (정본 2026-07-16 owner GO): 완료 보고 자동 수집·검증을 실제 CLI 로 실측한다.
//
// 두 단계 종료: done → pending, Stop → last_assistant_message 수집 → claim 추출 → Completion
// Verification Receipt(사이드카) → handoffVerdict. 불변식: 기존 Work Receipt 는 절대 수정하지 않는다.
// transcript 를 최종 답변 원천으로 쓰지 않는다. pending 없으면 Stop 은 무동작. 추가 AI 판정·재호출 루프 없음.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");
if (!existsSync(tsxBin)) { console.error(`ENV ERROR: tsx 없음 (${tsxBin}). 먼저 'npm install'.`); process.exit(1); }

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: mkdtempSync(join(tmpdir(), "ag-comp-home-")),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  AGENT_RECEIPT_NO_NET: "1",
  NO_COLOR: "1",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, stdio: ["ignore", "ignore", "ignore"] });
}
function run(cwd: string, command: string, args: string[] = [], stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(tsxBin, [cli, command, ...args], { cwd, env: ENV, encoding: "utf8", input: stdin });
  if (res.error) throw new Error(`${command} spawn 실패: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function contractYaml(checks: string | null = null): string {
  const base = ["id: t", "title: t", "mode: patch_only", "scope:", "  allowed_paths:", '    - "src/**"', "  denied_paths:", '    - ".env*"'];
  if (checks) base.push("required_checks:", "  commands:", checks);
  return base.join("\n") + "\n";
}
function repo(checks: string | null = null): string {
  const base = mkdtempSync(join(tmpdir(), "ag-comp-"));
  const r = join(base, "repo");
  mkdirSync(join(r, "src"), { recursive: true });
  git(r, ["init", "-q"]);
  git(r, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(r, "src", "app.ts"), "export const a = 1;\n");
  mkdirSync(join(r, ".agent-guard"), { recursive: true });
  writeFileSync(join(r, ".agent-guard", "contract.yaml"), contractYaml(checks));
  git(r, ["add", "-A"]);
  git(r, ["commit", "-qm", "base"]);
  return r;
}
const C = (r: string) => join(r, ".agent-guard", "contract.yaml");
function work(r: string): void {
  writeFileSync(join(r, "src", "app.ts"), "export const a = 2;\n"); // 계약 범위 안 변경
}
function beginDone(r: string): void {
  run(r, "begin", ["--contract", C(r)]);
  work(r);
  run(r, "done", ["--contract", C(r)]);
}
function stopPayload(msg: string, sessionId = "claude-sess-1"): string {
  return JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: ".", last_assistant_message: msg });
}
function stop(r: string, payload: string): { status: number | null } {
  return run(r, "capture", ["--event", "stop", "--vendor", "claude"], payload);
}
function pending(r: string): any {
  const p = join(r, ".agent-guard", "pending-completion.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function sidecar(r: string): any {
  const dir = join(r, ".agent-guard", "receipts");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.endsWith(".completion.json"));
  return f ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null;
}
function workReceipt(r: string): { path: string; bytes: string; json: any } {
  const dir = join(r, ".agent-guard", "receipts");
  const f = readdirSync(dir).find((n) => n.endsWith(".json") && !n.endsWith(".completion.json"))!;
  const abs = join(dir, f);
  const bytes = readFileSync(abs, "utf8");
  return { path: abs, bytes, json: JSON.parse(bytes) };
}

// ── 시험 1: done 이 pending 을 만들고 handoff PENDING 을 표기 ──
{
  const r = repo();
  run(r, "begin", ["--contract", C(r)]);
  work(r);
  const d = run(r, "done", ["--contract", C(r)]);
  assert.match(d.stdout, /최종 전달 판정: PENDING/, "#1 done 은 handoff PENDING 표기");
  const p = pending(r);
  assert.ok(p && p.status === "pending", "#1 pending 생성");
  assert.equal(p.schemaVersion, "completion/1", "#1 schema");
  assert.ok(typeof p.workReceiptContentHash === "string", "#1 workReceiptContentHash");
  console.log("✓ #1 done → pending PENDING");
}

// ── 시험 2: 정상 흐름 — 참 커밋만 주장 → 전부 VERIFIED → handoff PASS ──
{
  const r = repo();
  beginDone(r);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r, env: ENV, encoding: "utf8" }).trim();
  const before = workReceipt(r).bytes;
  const s = stop(r, stopPayload(`작업 완료. 커밋 ${head} 를 만들었고 브랜치 main 에 있습니다.`));
  assert.equal(s.status, 0, "#2 Stop 비차단 exit 0");
  const sc = sidecar(r);
  assert.equal(sc.surface, "completion", "#2 사이드카 surface=completion");
  assert.equal(sc.verdict, "pass", "#2 불일치 없음 → pass");
  assert.equal(sc.summary.mismatch, 0, "#2 mismatch 0");
  assert.equal(pending(r).status, "finalized", "#2 pending 최종화");
  assert.equal(workReceipt(r).bytes, before, "🔴 #2 Work Receipt 바이트 불변(Stop 이 사후 수정 안 함)");
  const sp = run(r, "share", ["--contract", C(r), "--out", ".agent-guard/p.html"]);
  assert.match(sp.stdout, /handoff PASS/, "#2 share handoff PASS");
  console.log("✓ #2 정상 흐름 → VERIFIED → handoff PASS · Work Receipt 불변");
}

// ── 시험 3: 거짓 커밋 주장 → MISMATCH → handoff FAIL, Work Receipt 판정 불변 ──
{
  const r = repo();
  beginDone(r);
  const before = workReceipt(r);
  assert.equal(before.json.ok, true, "#3 작업 계약은 PASS(코드는 범위 준수)");
  stop(r, stopPayload("커밋 deadbeef1234 를 만들었습니다."));
  const sc = sidecar(r);
  const mm = sc.results.filter((x: any) => x.status === "MISMATCH");
  assert.equal(mm.length, 1, "#3 거짓 커밋 = MISMATCH 1건");
  assert.equal(sc.verdict, "fail", "#3 completion verdict=fail");
  const after = workReceipt(r);
  assert.equal(after.bytes, before.bytes, "🔴 #3 Work Receipt 원본 판정 불변(FAIL 로 다시 쓰지 않음)");
  const sp = run(r, "share", ["--contract", C(r), "--out", ".agent-guard/p.html"]);
  assert.match(sp.stdout, /handoff FAIL/, "#3 거짓 보고 → handoff FAIL('코드는 지켰으니 PASS' 금지)");
  console.log("✓ #3 거짓 커밋 → MISMATCH → handoff FAIL · Work Receipt 불변");
}

// ── 시험 4: 거짓 검사 주장 — 검사 실패인데 144/144 통과 주장 → MISMATCH ──
{
  const r = repo("    - name: t\n      command: 'exit 1'\n      required_exit: 0");
  run(r, "begin", ["--contract", C(r)]);
  work(r);
  run(r, "done", ["--contract", C(r)]);
  stop(r, stopPayload("전체 테스트 144/144 통과했습니다."));
  const sc = sidecar(r);
  const t = sc.results.find((x: any) => x.kind === "test");
  assert.ok(t, "#4 test 주장 추출");
  assert.equal(t.status, "MISMATCH", "#4 검사 실패 + AI 통과 주장 = MISMATCH");
  console.log("✓ #4 거짓 검사 주장 → MISMATCH");
}

// ── 시험 5: 근거 없는 배포 주장 → ABSTAIN(FAIL 아님) ──
{
  const r = repo();
  beginDone(r);
  stop(r, stopPayload("Vercel 배포 완료했습니다."));
  const sc = sidecar(r);
  const d = sc.results.find((x: any) => x.kind === "deploy");
  assert.ok(d, "#5 deploy 주장 추출");
  assert.equal(d.status, "ABSTAIN", "#5 배포 = 독립 증거 없음 → ABSTAIN(FAIL 아님)");
  console.log("✓ #5 근거 없는 배포 → ABSTAIN");
}

// ── 시험 6: Stop 은 왔지만 pending 없음 → 아무것도 하지 않음(무차별 저장 금지) ──
{
  const r = repo();
  run(r, "begin", ["--contract", C(r)]); // done 안 함 → pending 없음
  const s = stop(r, stopPayload("진행 상황 보고입니다. 커밋 deadbeef1234."));
  assert.equal(s.status, 0, "#6 무동작이지만 정상 종료");
  assert.equal(sidecar(r), null, "#6 pending 없으면 Verification Receipt 생성 안 함");
  assert.equal(pending(r), null, "#6 pending 파일 자체가 없음");
  console.log("✓ #6 pending 없는 Stop → 무동작");
}

// ── 시험 7: pending 있지만 Stop 미발화 → share 는 PENDING 표기(handoff 미확정) ──
{
  const r = repo();
  beginDone(r);
  const sp = run(r, "share", ["--contract", C(r), "--out", ".agent-guard/p.html"]);
  assert.match(sp.stdout, /handoff PENDING/, "#7 Stop 전 share = PENDING(강한 최종 증거 아님)");
  assert.equal(sidecar(r), null, "#7 완료 검증 사이드카 없음");
  console.log("✓ #7 Stop 전 share → PENDING");
}

// ── 시험 8: 중복 Stop → 멱등(Verification Receipt·completion 디렉터리 중복 없음) ──
{
  const r = repo();
  beginDone(r);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r, env: ENV, encoding: "utf8" }).trim();
  stop(r, stopPayload(`커밋 ${head}.`));
  stop(r, stopPayload("한 번 더 (재발화)."));
  const dirs = readdirSync(join(r, ".agent-guard", "completions"));
  assert.equal(dirs.length, 1, "#8 completion 디렉터리 1개(중복 없음)");
  const compFiles = readdirSync(join(r, ".agent-guard", "receipts")).filter((n) => n.endsWith(".completion.json"));
  assert.equal(compFiles.length, 1, "#8 Verification Receipt 사이드카 1개");
  console.log("✓ #8 중복 Stop → 멱등");
}

// ── 시험 9: 병렬 세션 충돌 → AMBIGUOUS_PROVIDER_SESSION(자동 최종화 중단) ──
{
  const r = repo();
  beginDone(r);
  // 첫 Stop 은 sessionId 없이(형식 미지원 시뮬 대신) — 여기선 세션 결합만 시험하려고 sessionId A 로 결합.
  // AMBIGUOUS 는 '결합된 세션 ≠ 새 세션' 이므로, 최종화 전에 서로 다른 두 sessionId 가 필요.
  // 시나리오: 첫 Stop 이 빈 최종답변(결합만 하고 미최종화) → 둘째 Stop 다른 세션 → ambiguous.
  const empty = JSON.stringify({ hook_event_name: "Stop", session_id: "sessA", last_assistant_message: "" });
  stop(r, empty); // 결합 sessA, 최종답변 비어서 미최종화(pending 유지)
  let p = pending(r);
  assert.ok(p.providerSession && p.providerSession.sessionId === "sessA", "#9 첫 세션 sessA 결합");
  assert.equal(p.status, "pending", "#9 빈 최종답변 → 미최종화(pending 유지)");
  const other = JSON.stringify({ hook_event_name: "Stop", session_id: "sessB", last_assistant_message: "다른 세션 최종답변." });
  stop(r, other);
  p = pending(r);
  assert.match(p.lastStopError ?? "", /AMBIGUOUS_PROVIDER_SESSION/, "#9 다른 세션 → AMBIGUOUS(자동 교체 금지)");
  assert.equal(sidecar(r), null, "#9 충돌 상태에서 완료 영수증 생성 안 함");
  console.log("✓ #9 병렬 세션 충돌 → AMBIGUOUS");
}

// ── 시험 10: verify --json 14키 불변 + Work Receipt 스키마 불변(회귀 가드) ──
{
  const r = repo();
  beginDone(r);
  stop(r, stopPayload("완료."));
  const v = run(r, "verify", ["--contract", C(r), "--json"]);
  const j = JSON.parse(v.stdout);
  assert.equal(Object.keys(j).length, 14, "#10 verify --json 14키 불변");
  const wr = workReceipt(r).json;
  assert.equal(wr.schemaVersion, "1.1", "#10 Work Receipt 스키마 1.1 불변(completion 이 안 건드림)");
  assert.ok(!("handoffVerdict" in wr), "#10 Work Receipt 에 handoffVerdict 를 저장하지 않음(읽기 전용 조립)");
  assert.ok(!("completion" in wr), "#10 Work Receipt 에 완료 데이터 미주입");
  console.log("✓ #10 verify 14키 · Work Receipt 스키마 불변");
}

// ── 시험 11: 완료 원문은 로컬만 — 사이드카·share-proof 에 원문 미포함(비밀 보호) ──
{
  const r = repo();
  beginDone(r);
  const secret = "완료. 토큰 sk-verysecrettoken1234567890abcd 사용함.";
  stop(r, stopPayload(secret));
  const scRaw = JSON.stringify(sidecar(r));
  assert.ok(!scRaw.includes("sk-verysecrettoken"), "🔴 #11 Verification Receipt 에 원문/비밀 미포함(input.sha256 만)");
  // 로컬 원문은 존재해야 한다.
  const cdir = join(r, ".agent-guard", "completions", readdirSync(join(r, ".agent-guard", "completions"))[0]);
  assert.ok(readFileSync(join(cdir, "assistant-message.txt"), "utf8").includes("sk-verysecret"), "#11 로컬 원문에는 존재(로컬 전용)");
  run(r, "share", ["--contract", C(r), "--out", ".agent-guard/p.html"]);
  const html = readFileSync(join(r, ".agent-guard", "p.html"), "utf8");
  assert.ok(!html.includes("sk-verysecrettoken"), "🔴 #11 share-proof 에 비밀 미노출(마스킹 경로)");
  console.log("✓ #11 완료 원문 로컬 전용 · 비밀 마스킹");
}

// ── 시험 12: P0-4F — Stop 전 share 는 PENDING HTML, Stop 최종화가 같은 파일을 최종본으로 재렌더 ──
{
  const r = repo();
  beginDone(r);
  run(r, "share", ["--contract", C(r), "--out", ".agent-guard/deliver.html"]);
  const before = readFileSync(join(r, ".agent-guard", "deliver.html"), "utf8");
  assert.ok(before.includes("PENDING"), "#12 Stop 전 = PENDING HTML");
  stop(r, stopPayload("커밋 deadbeef1234 만들었습니다."));
  const after = readFileSync(join(r, ".agent-guard", "deliver.html"), "utf8");
  assert.ok(after.includes("MISMATCH") && after.includes("deadbeef1234"), "#12 Stop 후 같은 파일이 최종본으로 재렌더(MISMATCH 표기)");
  assert.ok(after.includes("FAIL"), "#12 재렌더된 handoff = FAIL");
  console.log("✓ #12 P0-4F share 전 PENDING → Stop 재렌더 최종본");
}

// ── 시험 13: Codex wire fixture(turn_id + model) 파싱 — vendor=codex·세션/턴 결합(실기 미검증·형식만) ──
{
  const r = repo();
  beginDone(r);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r, env: ENV, encoding: "utf8" }).trim();
  const codex = JSON.stringify({ hook_event_name: "Stop", session_id: "codex-9", turn_id: "turn-7", model: "gpt-5", cwd: ".", last_assistant_message: `커밋 ${head} 생성.` });
  run(r, "capture", ["--event", "stop"], codex); // --vendor auto → codex 추론
  const sc = sidecar(r);
  assert.equal(sc.completionMeta.vendor, "codex", "#13 Codex wire 형식 → vendor=codex");
  assert.equal(sc.completionMeta.turnId, "turn-7", "#13 turn_id 결합");
  assert.equal(pending(r).providerSession.name, "codex", "#13 공급자 세션 name=codex");
  console.log("✓ #13 Codex wire fixture(형식만·실기 미검증)");
}

console.log("completion.test.ts OK (13/13)");
