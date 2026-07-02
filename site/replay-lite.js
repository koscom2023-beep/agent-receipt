// ⚠️ 진본은 src/vreceipt.ts 의 replayVerificationReceipt — 이 파일은 그 봉인 3줄의 *검증된 사본*이다.
// (커널과 달리 sync node:crypto 를 브라우저로 기계변환할 수 없어 예외적으로 재구현 — council DA① 조건부 수용.)
// 동등성은 test/site-replay-equivalence.test.mjs 가 npm test 마다 실영수증+변조 변형으로 잠근다.
// 범위: contentHash/receiptId 재계산(무결)만 — 입력 재해시·commit 재조회는 파일시스템/git이라 CLI 몫(정직).
// 사이트 내부용 — SDK 공개 계약 아님. 드롭된 파일은 브라우저 메모리에서만 처리(업로드 0).

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** vreceipt.ts replayVerificationReceipt 의 무결 판정부와 동일 산식(비동기 판). */
export async function replayLite(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "not-an-object" };
  }
  if (receipt.kind !== "verification-receipt") {
    return { ok: false, reason: "not-a-verification-receipt", kind: String(receipt.kind ?? "(none)") };
  }
  const stated = receipt.contentHash;
  const body = { ...receipt };
  delete body.contentHash;
  const contentHashOk = typeof stated === "string" && (await sha256Hex(JSON.stringify(body))) === stated;
  const input = receipt.input || {};
  const tool = receipt.tool || {};
  const recomputedId = await sha256Hex(String(receipt.schemaVersion) + String(input.sha256) + String(tool.version) + String(receipt.verdict));
  const receiptIdOk = typeof receipt.receiptId === "string" && recomputedId === receipt.receiptId;
  return {
    ok: true,
    contentHashOk,
    receiptIdOk,
    tampered: !(contentHashOk && receiptIdOk),
    subject: typeof receipt.subject === "string" ? receipt.subject : "",
    verdict: typeof receipt.verdict === "string" ? receipt.verdict : "",
    surface: typeof receipt.surface === "string" ? receipt.surface : "",
    verifiedAt: typeof receipt.verifiedAt === "string" ? receipt.verifiedAt : "",
    receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : "",
    resultCount: Array.isArray(receipt.results) ? receipt.results.length : 0,
  };
}
