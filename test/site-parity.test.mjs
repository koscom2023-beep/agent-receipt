// KO(/) ↔ EN(/en) 페이지 쌍 표류 방지 — council DA② 수용 조건. 핵심 요소가 양쪽에 똑같이 있어야 한다.
// `node test/site-parity.test.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (p) => readFileSync(join(site, p), "utf8");

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const pairs = [["index.html", "en/index.html"], ["playground.html", "en/playground.html"]];
const MUST_BOTH = {
  "index.html": ["hero-try", "h-quote", "h-go", 'id="drop"', "drop-file", "replay-lite.js", "/kernel.js", "sample-receipt.json", 'id="gallery"', "#p=soc2"],
  "playground.html": ["/kernel.js", "mode-simple", "mode-json", 's-quote', 'id="share"', '#s=', 'data-p="soc2"', 'data-p="verdrift"', 'data-p="numdrift"'],
};
for (const [koF, enF] of pairs) {
  const ko = read(koF), en = read(enF);
  check(`${koF} ↔ ${enF}: 핵심 요소 동시 존재`, () => {
    for (const m of MUST_BOTH[koF]) {
      assert.ok(ko.includes(m), `KO에 없음: ${m}`);
      assert.ok(en.includes(m), `EN에 없음: ${m}`);
    }
  });
}
check("언어 순수성: EN 페이지에 한글 없음(영어 전용 요구)", () => {
  for (const f of ["en/index.html", "en/playground.html"]) {
    const t = read(f).replace(/한국어/g, ""); // 언어 토글 라벨('한국어')만은 대상 언어 표기 관례상 허용
    assert.ok(!/[가-힣]/.test(t), `${f} 에 한글 잔존`);
  }
});
check("언어 토글: KO→/en, EN→/ 상호 링크", () => {
  assert.ok(read("index.html").includes('href="/en"'));
  assert.ok(read("en/index.html").includes('href="/"'));
  assert.ok(read("playground.html").includes('href="/en/playground"'));
  assert.ok(read("en/playground.html").includes('href="/playground"'));
});
check("프리셋 키 집합 동일(양쪽 playground)", () => {
  const keys = (t) => [...t.matchAll(/data-p="([a-z]+)"/g)].map((m) => m[1]).sort().join(",");
  assert.equal(keys(read("playground.html")), keys(read("en/playground.html")));
});

if (fail.length) { console.error(`site-parity: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`site-parity: ${pass} pass ✅`);
