// 3라운드 감사 fix — 비밀 누출(userinfo·export redact)·anchor 폴백 하드닝·자기산출물 제외.
// `node test/round3-audit.test.mjs`.
import assert from "node:assert/strict";
import { redactText } from "../dist/redact.js";
import { classifyEvent } from "../dist/capture.js";
import { extractRekorUuid } from "../dist/anchor.js";
import { isToolOutput } from "../dist/session.js";

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

// ── #9 redact: shell export 형 비밀 ──
check("redact — export SENSITIVE_KEY=값 마스킹(행두 export 누락 버그)", () => {
  const r = redactText("export API_KEY=plainsecret123");
  assert.ok(r.count >= 1, "export KEY= 미마스킹");
  assert.ok(!r.text.includes("plainsecret123"), "값 평문 노출");
});
check("redact — export AWS_SECRET_ACCESS_KEY=값(접두 shape 없는 비밀)도 마스킹", () => {
  const r = redactText("export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcd");
  assert.ok(!r.text.includes("wJalrXUtnFEMIabcd"), "AWS secret 평문 노출");
});
check("redact — 비밀 아닌 export 는 불변(과잉가림 없음)", () => {
  assert.equal(redactText("export PATH=/usr/bin").text, "export PATH=/usr/bin");
});

// ── #1 capture: URL userinfo(자격증명) 미저장 ──
check("classifyEvent — curl user:pass@host 의 자격증명 디스크 미저장", () => {
  const recs = classifyEvent(
    { tool_name: "Bash", tool_input: { command: "curl https://admin:SuperSecretPass123@internal.example.com/x" } },
    "post",
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].op, "network");
  assert.ok(!recs[0].host.includes("SuperSecretPass123"), "비밀번호 평문 저장");
  assert.ok(!recs[0].host.includes("@"), "userinfo 잔존");
  assert.equal(recs[0].host, "internal.example.com");
});
check("classifyEvent — 자격증명 없는 일반 URL 은 host 그대로", () => {
  const recs = classifyEvent({ tool_name: "Bash", tool_input: { command: "curl https://api.github.com/x?token=ghp_abc" } }, "post");
  assert.equal(recs[0].host, "api.github.com");
});

// ── #6 anchor: 폴백 하드닝(409 한정 + 길이 40+) ──
check("extractRekorUuid — 201 엔트리맵 키=UUID", () => {
  const u = "a".repeat(64);
  const r = extractRekorUuid(JSON.stringify({ [u]: { logIndex: 7 } }), 201);
  assert.equal(r.uuid, u);
  assert.equal(r.logIndex, 7);
});
check("🔴 extractRekorUuid — 201 비-엔트리맵 본문의 잡 hex(CSRF)는 가짜 UUID 로 안 잡음(null)", () => {
  assert.equal(extractRekorUuid('<html><meta content="0123456789abcdef0123456789abcdef"></html>', 201), null);
});
check("extractRekorUuid — 409 메시지의 64hex UUID 추출", () => {
  const u = "b".repeat(64);
  const r = extractRekorUuid(JSON.stringify({ code: 409, message: `exists: ${u}` }), 409);
  assert.equal(r.uuid, u);
});
check("extractRekorUuid — 짧은 hex(16~32)는 UUID 로 오인 안 함", () => {
  assert.equal(extractRekorUuid(JSON.stringify({ code: 409, message: "id: 0123456789abcdef" }), 409), null);
});

// ── #7/#8 isToolOutput: 도구 자기 산출물 제외(거짓 잔차/거짓 경보 방지) ──
check("isToolOutput — capture.jsonl/.head.json/proof/anchors 제외", () => {
  assert.ok(isToolOutput(".agent-guard/capture.jsonl"));
  assert.ok(isToolOutput(".agent-guard/capture.head.json"));
  assert.ok(isToolOutput(".agent-guard/proof-2026-06-30.html"));
  assert.ok(isToolOutput(".agent-guard/anchors/x.dsse.json"));
});
check("isToolOutput — 사용자 파일(contract/README/src)은 제외 안 함", () => {
  assert.ok(!isToolOutput(".agent-guard/contract.yaml"));
  assert.ok(!isToolOutput(".agent-guard/README.md"));
  assert.ok(!isToolOutput("src/app.ts"));
});

if (fail.length) {
  console.error(`round3-audit: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`round3-audit: ${pass} pass, 0 fail`);
