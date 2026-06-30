// 14차 council(무결점) — 파일락/원자쓰기 + 키 안전(개인키 절대 덮어쓰기 금지·매칭쌍).
// `node test/lock-keys.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign as edSign, verify as edVerify, createPublicKey } from "node:crypto";
import { withFileLock, writeFileAtomic } from "../dist/lock.js";
import { ensureSigningKey } from "../dist/keys.js";

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

const base = join(tmpdir(), "agent-receipt-lockkeys-test");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });

// ── lock ──
check("writeFileAtomic — 내용 정확·temp 잔존 없음", () => {
  const p = join(base, "atomic.txt");
  writeFileAtomic(p, "hello-atomic");
  assert.equal(readFileSync(p, "utf8"), "hello-atomic");
  assert.ok(!readdirSync(base).some((f) => f.includes(".tmp.")), "temp 파일 잔존");
});
check("withFileLock — fn 실행·반환·락 해제", () => {
  const lp = join(base, "a.lock");
  const r = withFileLock(lp, () => 42);
  assert.equal(r, 42);
  assert.ok(!existsSync(lp), "락 파일 해제 안 됨");
});
check("withFileLock — 점유중(non-stale)이면 재시도 후 throw·fn 미실행", () => {
  const lp = join(base, "held.lock");
  const fd = openSync(lp, "wx"); // 수동 점유(해제 안 함)
  let ran = false;
  assert.throws(() => withFileLock(lp, () => { ran = true; }, { retries: 1, staleMs: 999999 }));
  assert.equal(ran, false, "점유중인데 fn 실행됨");
  closeSync(fd);
  rmSync(lp, { force: true });
});
check("withFileLock — stale 락(오래됨)은 강탈하고 실행", () => {
  const lp = join(base, "stale.lock");
  const fd = openSync(lp, "wx");
  closeSync(fd);
  utimesSync(lp, new Date(Date.now() - 60000), new Date(Date.now() - 60000)); // mtime 60s 전
  let ran = false;
  const r = withFileLock(lp, () => { ran = true; return "ok"; }, { staleMs: 1000 });
  assert.ok(ran && r === "ok", "stale 락 강탈 실패");
});

// ── keys: 개인키 보존(데이터 손실 fix) ──
const keyCwd = join(base, "keyrepo");
mkdirSync(keyCwd, { recursive: true });
const privAbs = join(keyCwd, ".agent-guard", "keys", "private.pem");
const pubAbs = join(keyCwd, ".agent-guard", "keys", "public.pem");

check("ensureSigningKey — 생성 + 반환 키쌍이 *매칭*(서명↔검증)", () => {
  const { key, publicPem } = ensureSigningKey(keyCwd);
  assert.ok(existsSync(privAbs) && existsSync(pubAbs));
  const msg = Buffer.from("zero-defect");
  const sig = edSign(null, msg, key);
  assert.ok(edVerify(null, msg, createPublicKey(publicPem), sig), "반환 key/publicPem 불일치쌍");
});
check("🔴 ensureSigningKey — public.pem 만 지워도 private.pem 절대 불변(키 회전·데이터 손실 금지)", () => {
  const privBefore = readFileSync(privAbs);
  rmSync(pubAbs); // 사용자가 공개키만 삭제(재생성되겠지 오해)
  const { key, publicPem } = ensureSigningKey(keyCwd);
  const privAfter = readFileSync(privAbs);
  assert.deepEqual(privAfter, privBefore, "개인키가 덮어써짐 — 과거 서명·앵커 전부 무효(데이터 손실)");
  assert.ok(existsSync(pubAbs), "public.pem 재유도 안 됨");
  // 재유도된 pub 가 보존된 priv 와 매칭(과거 서명 계속 검증됨)
  const msg = Buffer.from("after-pub-delete");
  assert.ok(edVerify(null, msg, createPublicKey(publicPem), edSign(null, msg, key)), "재유도 pub 가 priv 와 불일치");
});
check("ensureSigningKey — priv 보존된 채 멱등 호출(둘 다 있으면 그대로)", () => {
  const a = readFileSync(privAbs);
  ensureSigningKey(keyCwd);
  assert.deepEqual(readFileSync(privAbs), a);
});

rmSync(base, { recursive: true, force: true });

if (fail.length) {
  console.error(`lock-keys: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`lock-keys: ${pass} pass, 0 fail`);
