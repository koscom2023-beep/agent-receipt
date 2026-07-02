#!/usr/bin/env node
// ── dogfood: 이 저장소가 자기 검증 영수증을 자기 도구로 쌓는다 (L4) ──
// 무엇: fixtures/dogfood/ 의 바이트 고정 픽스처를 research/council verify --out 으로 검증해
//   .agent-guard/vreceipts/(gitignore)에 영수증을 축적하고, 쌓인 것을 graph query/failures/
//   history/diff 로 실제 소비(스모크)한다. 실행할 때마다 이력이 실데이터로 자란다.
// 규율:
//   - 항상 exit 0 — 증거 *생성*은 게이트가 아니다(게이트=기존 테스트 스위트·이 스크립트의
//     정확성 게이트는 test/dogfood.test.mjs). 내부 실패는 ⚠ 1줄로 정직하게 출력.
//   - 네트워크 0·외부 전송 0. CLI(dist/cli.js)만 호출 — 사용자와 같은 표면.
//   - 변조 교보재는 고정 이름 1개(덮어쓰기) — tampered tier 를 실물로 상시 검증하되 오염 증식 금지.
//   - 지금 실증되는 것: 축적 이력·같은 (입력·버전·verdict) 접힘(occurrences)·tampered 플래그·
//     reported tier. 시간이 만들어주는 것: reverifies 체인(도구 버전이 바뀌면 같은 입력의
//     receiptId 가 갈라지며 자연 발생) — 과장하지 않는다.
// 출력 디렉터리는 env DOGFOOD_OUT_DIR 로 재지정 가능(테스트 격리용).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const outDir = process.env.DOGFOOD_OUT_DIR || join(root, ".agent-guard", "vreceipts");
const prevDir = join(outDir, "..", "vreceipts-prev-snapshot");

const run = (args) => {
  // verify 는 fail 픽스처에서 exit 1 이 정상 — 캡처하고 계속.
  try {
    return { out: execFileSync("node", [cli, ...args], { cwd: root, encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: typeof e.status === "number" ? e.status : -1 };
  }
};

try {
  mkdirSync(outDir, { recursive: true });
  // diff 데모용: 이번 실행 *이전* 상태 스냅샷(실행 전 vs 후 = 이번 실행이 추가한 실패가 "신규").
  rmSync(prevDir, { recursive: true, force: true });
  cpSync(outDir, prevDir, { recursive: true });

  const ts = Date.now();
  const gen = [
    ["research", join(root, "fixtures", "dogfood", "research-pass.json"), `vr-${ts}-research-pass.json`],
    ["research", join(root, "fixtures", "dogfood", "research-fail.json"), `vr-${ts}-research-fail.json`],
    ["council", join(root, "fixtures", "dogfood", "council-decision.json"), `vr-${ts}-council.json`],
    // Phase5 신규 체크(schema/version/file) 커버 — 전부 순수/바이트안정 가능 종류만.
    // git-fact 3종(commit/fileChanged/diffContains)+receipt 는 커밋해시·영수증 id 가 바이트안정 불가라
    // 여기 못 들어옴 — 실레포/실영수증 테스트(test/gitfacts·research-verify)가 담당(정직 분담).
    ["research", join(root, "fixtures", "dogfood", "research-newchecks.json"), `vr-${ts}-research-newchecks.json`],
  ];
  let made = 0;
  for (const [surface, file, name] of gen) {
    const r = run([surface, "verify", "--file", file, "--out", join(outDir, name)]);
    if (existsSync(join(outDir, name))) made++;
    else console.log(`⚠ dogfood: ${surface} 영수증 미생성(${name}) exit=${r.code}`);
  }

  // 변조 교보재(고정 이름 1개·덮어쓰기): 갓 만든 pass 영수증을 복사해 subject 를 바꿔 봉인을 깨뜨린다.
  // → graph 가 tampered 로 표시하는지 실물로 상시 검증(숨김이 아니라 노출이 설계).
  const fresh = join(outDir, `vr-${ts}-research-pass.json`);
  if (existsSync(fresh)) {
    const t = JSON.parse(readFileSync(fresh, "utf8"));
    t.subject = String(t.subject) + " [TAMPERED-ON-PURPOSE: dogfood exhibit]";
    writeFileSync(join(outDir, "vr-tampered-exhibit.json"), JSON.stringify(t, null, 2) + "\n");
  }

  // ── 쌓인 것을 실제 소비(graph 4표면 스모크) ──
  const q = run(["graph", "query", "--dir", outDir, "--format", "json"]);
  const total = q.code === 0 ? JSON.parse(q.out).total : -1;

  const f = run(["graph", "failures", "--dir", outDir, "--by", "check", "--format", "json"]);
  const failures = f.code === 0 ? JSON.parse(f.out).matched : -1;

  const v = run(["graph", "view", "--dir", outDir, "--format", "json"]);
  let tampered = -1;
  let fp = null;
  if (v.code === 0) {
    const g = JSON.parse(v.out);
    tampered = g.summary.tamperedCount;
    const withClaim = g.receipts.find((r) => (r.claims ?? []).length);
    fp = withClaim ? withClaim.claims[0].fingerprint : null;
  }

  let historyLen = -1;
  if (fp) {
    const h = run(["graph", "history", "--dir", outDir, "--claim", fp, "--format", "json"]);
    if (h.code === 0) historyLen = JSON.parse(h.out).receipts;
  }

  const d = run(["graph", "diff", "--base-dir", prevDir, "--head-dir", outDir, "--format", "json"]);
  const newFailures = d.code === 0 || d.code === 1 ? JSON.parse(d.out).newFailures.length : -1;

  console.log("────────────────────────────────────────────");
  console.log("dogfood(자기 영수증) 요약 — 생성은 비차단·정확성 게이트는 test/dogfood.test.mjs");
  console.log(`  이번 실행 생성: ${made}건(research pass/fail/newchecks·council) + 변조 교보재 1건(고정·의도됨)`);
  console.log(`  누적 영수증: ${total}건 · 실패 이벤트: ${failures}건 · tampered 표시: ${tampered}건(교보재 포함)`);
  console.log(`  history(대표 주장): 영수증 ${historyLen}건 축적 — 실행할수록 자람`);
  console.log(`  diff(직전 상태 → 현재): 신규 실패 ${newFailures}건(첫 실행만 신규·이후 지속으로 수렴)`);
  console.log("  참고: reverifies 체인은 도구 버전이 바뀌면 자연 발생(receiptId 가 버전 포함) — 지금은 접힘(occurrences)으로 쌓임.");
  console.log("────────────────────────────────────────────");
} catch (e) {
  console.log(`⚠ dogfood 생략(비차단): ${e && e.message ? e.message : e}`);
}
process.exit(0);
