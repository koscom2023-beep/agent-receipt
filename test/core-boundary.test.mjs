// 코어 경계(3차·4차 회의 실행형): 검증 코어 모듈은 surface/오케스트레이션 모듈을 import 하면 안 된다.
// 의존 방향 = surface → core(허용) 뿐, core ↛ surface(금지). 이걸 어기면 "증인이 행위자를 알게" 되어
// 중립·추출가능 경계가 부패한다. CI 가 잡는다. `node test/core-boundary.test.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// 결정론 검증 코어 + 영수증 + 공유 Evidence Kernel. 이들은 판단/오케스트레이션(surface)을 몰라야 한다.
const CORE = ["claimdiff.ts", "ledger.ts", "replay.ts", "receipt.ts", "evidencekernel.ts"];
// surface/오케스트레이션 모듈(research·council 등 — 코어를 재사용하되 코어가 이들을 알면 안 됨).
const SURFACE = ["research", "council"];

for (const c of CORE) {
  check(`${c} 는 surface 를 import 하지 않음(core ↛ surface)`, () => {
    const txt = readFileSync(join(srcDir, c), "utf8");
    for (const s of SURFACE) {
      const re = new RegExp(`from\\s+["'][./]*${s}(\\.js)?["']`);
      assert.ok(!re.test(txt), `${c} 가 ${s} 를 import 함 — 경계 부패`);
    }
  });
}

// research 는 반대로 core 를 import 해도 된다(방향 정상) — 지금은 self-contained 라 아무것도 강제 안 함.
check("research.ts 존재(surface 모듈 실재)", () => {
  const txt = readFileSync(join(srcDir, "research.ts"), "utf8");
  assert.ok(txt.includes("verifyCitationInText"), "research 커널 심볼 부재");
});

if (fail.length) { console.error(`core-boundary: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`core-boundary: ${pass} pass ✅`);
