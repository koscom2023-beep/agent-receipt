// ⚠️ 자동 검증 대상 미러. src/receipt.ts 의 receiptHash 를 브라우저에서 재계산하는 순수 사본이다.
//    직접 편집 금지에 준함: test/site-receipthash-parity.test.mjs 가 test/vectors/vectors.json 으로
//    이 미러가 참조 구현과 바이트 동일한지 강제한다(어긋나면 테스트 실패 → 드리프트 차단).
// no deps. sha256 = WebCrypto(crypto.subtle). Node 20+ 는 globalThis.crypto 로 동일 동작.
(function (global) {
  // src/receipt.ts stableStringify 와 동일: 모든 객체 키를 재귀 사전순 정렬, 배열은 순서 유지.
  function stableStringify(v) {
    return JSON.stringify(v, function (_k, val) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        var out = {};
        Object.keys(val).sort().forEach(function (k) { out[k] = val[k]; });
        return out;
      }
      return val;
    });
  }
  async function sha256hex(str) {
    var buf = new TextEncoder().encode(str);
    var d = await global.crypto.subtle.digest("SHA-256", buf);
    return "sha256:" + Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function sortArr(a) { return (a || []).slice().sort(); }

  // src/receipt.ts receiptHash 와 바이트 동일해야 한다. payload 키 순서는 무관(stableStringify 가 정렬).
  async function receiptHash(r) {
    var payload = {
      headHash: r.headHash,
      touched: sortArr(r.touched),
      staged: sortArr(r.staged),
      untracked: sortArr(r.untracked),
      outOfScope: sortArr(r.outOfScope),
      deniedHits: sortArr(r.deniedHits),
      magnitude: r.magnitude,
      criticalTouched: sortArr([].concat.apply([], (r.criticalPaths || []).map(function (c) { return c.touched; }))),
      checks: (r.checks || []).map(function (c) { return c.name + ":" + c.exitCode + ":" + c.requiredExit + ":" + c.ok; }).sort(),
      ok: r.ok,
      violations: sortArr(r.violations || []),
      branch: r.branch,
      contractId: r.contractId,
    };
    if (r.verdict) payload.verdict = r.verdict;
    if (r.contractSnapshot) payload.contractSnapshot = r.contractSnapshot;
    if (r.actions && r.actions.length) payload.actionsDigest = await sha256hex(stableStringify(r.actions));
    if (r.reconciliation) payload.reconciliationDigest = await sha256hex(stableStringify(r.reconciliation));
    if (r.contentHashes && r.contentHashes.length) {
      payload.contentHashes = r.contentHashes.map(function (c) { return c.path + ":" + (c.sha256 == null ? "null" : c.sha256); }).sort();
    }
    return sha256hex(stableStringify(payload));
  }

  // 봉인 판정: 재계산 결과와 receipt.contentHash 대조 + schemaVersion 갈래(스펙 §6).
  async function checkSeal(r) {
    var recomputed;
    try { recomputed = await receiptHash(r); } catch (e) { return { status: "error", detail: String(e) }; }
    var stated = typeof r.contentHash === "string" ? r.contentHash : "";
    if (recomputed === stated) return { status: "intact", recomputed: recomputed };
    var sv = parseFloat(String(r.schemaVersion == null ? "1.0" : r.schemaVersion));
    var preSeal = !isFinite(sv) || sv < 1.1;
    return { status: preSeal ? "reissue" : "tampered", recomputed: recomputed, stated: stated };
  }

  global.AgentReceiptSeal = { receiptHash: receiptHash, checkSeal: checkSeal, stableStringify: stableStringify };
})(typeof globalThis !== "undefined" ? globalThis : this);
