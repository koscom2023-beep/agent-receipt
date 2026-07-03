// Cursor 훅 어댑터 + deny stdout (멀티벤더) — fixtures/multiagent/*.json
// `node test/cursor-hook.test.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { normalizeAgentPath, adaptCursorHookPayload, parseHookStdin, sanitizeLooseJson } from "../dist/cursor-hook.js";
import { formatGuardDeny, inferHookVendor } from "../dist/hook-deny.js";
import { normalizeCursorEnvelope, classifyEvent } from "../dist/capture.js";

const FIX = join(process.cwd(), "fixtures", "multiagent");
const CLI = join(process.cwd(), "dist", "cli.js");

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

check("normalizeAgentPath — WSL UNC → posix", () => {
  const p = normalizeAgentPath("\\\\wsl.localhost\\Ubuntu\\home\\sah4444\\agent-receipt\\src\\a.ts");
  assert.equal(p, "/home/sah4444/agent-receipt/src/a.ts");
});

check("adaptCursorHookPayload — Shell → Bash alias", () => {
  const raw = JSON.parse(readFileSync(join(FIX, "cursor-preToolUse-shell.json"), "utf8"));
  const a = adaptCursorHookPayload(raw);
  assert.equal(a.tool_name, "Bash");
  assert.ok(String(a.tool_input.command).includes("curl"));
});

check("normalizeCursorEnvelope — UNC write path → classify write", () => {
  const raw = JSON.parse(readFileSync(join(FIX, "cursor-preToolUse-write-unc.json"), "utf8"));
  const env = normalizeCursorEnvelope(raw);
  assert.equal(env.source, "cursor");
  const recs = classifyEvent(env, "pre", "T");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].op, "write");
  assert.ok(recs[0].path.includes("secrets/token.txt"));
});

check("afterFileEdit fixture — synthetic Write + path", () => {
  const raw = JSON.parse(readFileSync(join(FIX, "cursor-afterFileEdit-unc.json"), "utf8"));
  const env = normalizeCursorEnvelope(raw);
  assert.equal(env.tool_name, "Write");
  assert.ok(String(env.tool_input.file_path).startsWith("/home/"));
});

check("inferHookVendor — conversation_id → cursor", () => {
  assert.equal(inferHookVendor({ conversation_id: "x", tool_name: "Read" }), "cursor");
  assert.equal(inferHookVendor({ session_id: "s", transcript_path: "/p", hook_event_name: "PreToolUse" }), "claude");
});

check("inferHookVendor — 실측 afterFileEdit(transcript_path 있어도 cursor)", () => {
  const raw = JSON.parse(readFileSync(join(FIX, "cursor-afterFileEdit-probe.json"), "utf8"));
  assert.equal(inferHookVendor(raw), "cursor");
});

check("실측 afterFileEdit probe → write 분류(값·edits 미저장)", () => {
  const raw = JSON.parse(readFileSync(join(FIX, "cursor-afterFileEdit-probe.json"), "utf8"));
  const env = normalizeCursorEnvelope(raw);
  const recs = classifyEvent(env, "post", "T");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].op, "write");
  assert.ok(recs[0].path.includes("example.ts"));
  assert.ok(!JSON.stringify(recs).includes('"edits"'));
});

check("formatGuardDeny — cursor permission vs claude permissionDecision", () => {
  const c = JSON.parse(formatGuardDeny("cursor", "blocked"));
  assert.equal(c.permission, "deny");
  const cl = JSON.parse(formatGuardDeny("claude", "blocked"));
  assert.equal(cl.hookSpecificOutput.permissionDecision, "deny");
});

check("CLI capture pre --vendor cursor → permission deny (guard block)", () => {
  const d = mkdtempSync(join(tmpdir(), "ar-cursor-"));
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  writeFileSync(join(d, ".agent-guard", "policy.yaml"), `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  const raw = {
    conversation_id: "c-cli",
    tool_name: "Write",
    tool_input: { file_path: "secrets/token.txt" },
  };
  const r = spawnSync("node", [CLI, "capture", "--event", "pre", "--vendor", "cursor"], {
    cwd: d,
    input: JSON.stringify(raw),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.permission, "deny");
});

check("CLI capture pre --vendor cursor — 선두 BOM payload 도 파싱·가드(wsl.exe 실측)", () => {
  const d = mkdtempSync(join(tmpdir(), "ar-cursor-bom-"));
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  writeFileSync(join(d, ".agent-guard", "policy.yaml"), `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  const raw = {
    conversation_id: "c-bom",
    tool_name: "Write",
    tool_input: { file_path: "secrets/token.txt" },
  };
  const r = spawnSync("node", [CLI, "capture", "--event", "pre", "--vendor", "cursor"], {
    cwd: d,
    input: "\uFEFF" + JSON.stringify(raw), // 실제 Cursor(wsl.exe) payload 의 선두 BOM 재현 — 벗기지 않으면 파싱 실패로 degraded → deny 안 나옴
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.permission, "deny");
});

check("parseHookStdin — 손상 payload(BOM·CRLF·홑백슬래시 transcript_path) 복구", () => {
  // 실측 재현(wsl.exe 전송손상): 선두 BOM + transcript_path 홑백슬래시(무효 JSON·안 쓰는 필드) + 끝 CRLF.
  // file_path(우리 쓰는 필드)는 UNC 정상 이스케이프(\\\\) — 복구가 이걸 건드리면 안 됨.
  const brokenJson = String.raw`{"conversation_id":"c-corrupt","tool_name":"Write","tool_input":{"file_path":"\\\\wsl.localhost\\Ubuntu\\home\\u\\a.ts"},"transcript_path":"C:\Users\test\.cursor\x"}`;
  const corrupt = "\uFEFF" + brokenJson + "\r\n";
  assert.throws(() => JSON.parse(corrupt)); // 엄격 파싱은 반드시 실패(손상 재현 확증)
  const o = parseHookStdin(corrupt); // 폴백 복구
  assert.equal(o.conversation_id, "c-corrupt");
  assert.ok(String(o.tool_input.file_path).includes("wsl.localhost")); // 우리 쓰는 필드 보존
});

check("sanitizeLooseJson — 클린 JSON·유효 이스케이프는 파싱결과 불변(byte-invariant)", () => {
  const clean = JSON.stringify({ a: "x\\y", b: "line\nbreak", c: "café", p: "\\\\wsl\\path" });
  assert.deepEqual(JSON.parse(sanitizeLooseJson(clean)), JSON.parse(clean));
});

check("CLI capture pre --vendor cursor — 손상 payload도 file_path 추출·가드(실측 통짜)", () => {
  const d = mkdtempSync(join(tmpdir(), "ar-cursor-corrupt-"));
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  writeFileSync(join(d, ".agent-guard", "policy.yaml"), `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  // file_path=secrets/(가드 대상) · transcript_path=손상(홑백슬래시) · 선두 BOM · 끝 CRLF
  const brokenJson = String.raw`{"conversation_id":"c-corrupt","tool_name":"Write","tool_input":{"file_path":"secrets/token.txt"},"transcript_path":"C:\Users\test\.cursor\x"}`;
  const r = spawnSync("node", [CLI, "capture", "--event", "pre", "--vendor", "cursor"], {
    cwd: d,
    input: "\uFEFF" + brokenJson + "\r\n",
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.permission, "deny"); // 복구 없으면 파싱실패→degraded→deny 안 나옴
});

if (fail.length) {
  console.error(`cursor-hook: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`cursor-hook: ${pass} pass, 0 fail`);
