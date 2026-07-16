import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadContract } from "./schema.js";
import * as g from "./git.js";
import { DEFAULT_CONTRACT_PATHS, discoverContract } from "./discover.js";
import { resolveSession } from "./session.js";
import { binaryPath, installedVersion, npmLatest, compareVersions } from "./version.js";
import { loadObservationHealth, zeroMeaning, ZERO_MEANING_TEXT } from "./observation.js";

const line = "─".repeat(56);

type Finding = { level: "ok" | "warn" | "err"; msg: string };

/**
 * `agent-receipt doctor` — 환경/설정 건강 점검(read-only): git repo / 계약 발견·유효 / baseline 상태.
 * 계약 품질(allowed/denied/forbidden_actions)은 `lint` 가 담당. exit = 오류(✗) 있으면 1, 아니면 0.
 */
export function runDoctor(cwd: string = process.cwd()): never {
  const f: Finding[] = [];

  const isRepo = g.isGitRepo();
  f.push(isRepo ? { level: "ok", msg: "git 저장소" } : { level: "err", msg: "git 저장소 아님 — verify/start 사용 불가" });

  const cPath = discoverContract(cwd);
  let hasContract = false;
  if (!cPath) {
    f.push({ level: "warn", msg: "계약 없음 — 'agent-receipt init --preset generic' 권장" });
  } else {
    const rel = DEFAULT_CONTRACT_PATHS.find((p) => existsSync(join(cwd, p))) ?? cPath;
    try {
      const c = loadContract(cPath);
      hasContract = true;
      f.push({ level: "ok", msg: `계약 발견: ${rel}` });
      // Promptia preset 감지(id: promptia) → denied_paths 핵심 누락은 lint 가 점검.
      if (c.id === "promptia") {
        f.push({ level: "ok", msg: "preset: promptia 감지 — denied_paths 핵심 누락은 'agent-receipt lint' 가 점검" });
      }
    } catch (e) {
      f.push({ level: "err", msg: `계약 형식 오류: ${(e as Error).message.split("\n")[0]}` });
    }
  }

  if (isRepo) {
    const s = resolveSession(cwd);
    if (!s.session) f.push({ level: "ok", msg: "baseline 없음 (full-tree 검사)" });
    else if (s.applied) f.push({ level: "ok", msg: "baseline 활성" });
    else f.push({ level: "warn", msg: `baseline 무효(${s.reason}) — 'agent-receipt reset' 권장` });
  }

  // 관찰 배선 진단(P0-1 · 2026-07-16 정본)
  // 이 도구의 가장 큰 실패는 "안 보이는데 보이는 척"이었다. 훅이 죽어 있으면 여기서 말한다.
  // 판정 자체(INCOMPLETE)는 verdict.ts 가 하고, doctor 는 사람이 고치러 갈 자리를 보여준다.
  const obs = isRepo ? loadObservationHealth(cwd) : null;
  if (obs) {
    if (obs.verdict === "observed") f.push({ level: "ok", msg: `행동 관찰 정상. 기록 ${obs.actions}건 (세션 ${obs.sessions})` });
    else if (obs.verdict === "wired-silent") f.push({ level: "warn", msg: `행동 관찰 침묵. 훅은 배선됐는데 기록 0건. ${obs.fix}` });
    else if (obs.verdict === "degraded") f.push({ level: "warn", msg: `행동 관찰 손상. ${obs.text}` });
    else f.push({ level: "ok", msg: "행동 관찰 미배선. 이 저장소의 영수증은 git 변경 한정이다('capture install --write' 로 확장)" });
  }

  if (hasContract) f.push({ level: "ok", msg: "계약 품질은 'agent-receipt lint' 로 점검" });

  console.log("");
  console.log(line);
  console.log("agent-receipt doctor");
  console.log(line);

  // ── 설치/버전 진단(advisory — git/계약 진단과 별개, exit code 에 영향 없음) ──
  // npm latest 조회 실패(오프라인/미발행/네트워크)는 doctor 를 실패시키지 않는다 — 참고 표시만.
  const cur = installedVersion();
  const latest = npmLatest();
  console.log("설치:");
  console.log(`  실행 파일 : ${binaryPath()}`);
  console.log(`  현재 버전 : ${cur}`);
  if (latest === null) {
    console.log("  npm latest: 확인 안 함 (오프라인/조회 생략)");
    console.log("  업데이트   : 확인 불가 (advisory — git 진단과 무관)");
  } else {
    console.log(`  npm latest: ${latest}`);
    const cmp = compareVersions(cur, latest);
    if (cmp === null) {
      console.log("  업데이트   : 비교 불가 (advisory)");
    } else if (cmp < 0) {
      console.log(`  업데이트   : ⚠️ 새 버전이 있습니다: ${cur} → ${latest}`);
      console.log("               npm install -g @promptia-labs/agent-receipt@latest");
    } else {
      console.log("  업데이트   : OK (최신)");
    }
  }
  console.log(line);

  // 관찰 상세(P0-1). "무엇을 볼 수 있었나"를 숫자로 낸다. 0 을 찍을 땐 0 의 뜻을 함께 낸다(P0-2).
  // 훅 '승인' 여부는 Claude Code 내부 상태라 디스크에서 읽을 수 없다. 그래서 승인됨이라고 주장하지 않고,
  // 관측 가능한 사실(배선 + 수신)만 낸다. 배선됐는데 수신 0 이면 승인 대기이거나 세션이 배선 전에 시작된 것이다.
  if (obs) {
    console.log("관찰(행동 기록):");
    if (obs.sites.length) {
      for (const s of obs.sites) console.log(`  훅 배선    : 배선됨 · ${s.path} (${s.events.join(", ")})`);
    } else {
      console.log("  훅 배선    : 없음 (이 저장소는 git 변경만 관찰합니다)");
    }
    console.log(`  기록 파일  : .agent-guard/capture.jsonl ${obs.logExists ? "있음" : "없음"}`);
    console.log(`  측정 창    : ${obs.windowStart ?? "없음(전체 기록을 창으로 봄)"}`);
    console.log(`  수신 행동  : ${obs.actions}건 (측정 창 안)${obs.degraded ? ` · 열화 마커 ${obs.degraded}건` : ""}`);
    // 창 밖 잔재는 반드시 드러낸다. 이걸 수신으로 세면 죽은 훅이 살아 있어 보인다(2026-07-16 실측 진범).
    if (obs.stale) console.log(`  창 밖 잔재 : ${obs.stale}건 (이전 창 기록이라 이번 세션 관찰이 아님)`);
    console.log(`  마지막 수신: ${obs.lastTs ?? "없음"}`);
    if (obs.actions === 0) {
      const z = zeroMeaning(obs);
      console.log(`  0 의 뜻    : ${ZERO_MEANING_TEXT[z]}`);
    }
    if (obs.fix) console.log(`  고치는 법  : ${obs.fix}`);
    console.log(line);
  }

  for (const x of f) console.log(`  ${x.level === "ok" ? "✓" : x.level === "warn" ? "⚠" : "✗"} ${x.msg}`);
  console.log(line);
  const errs = f.filter((x) => x.level === "err").length;
  const warns = f.filter((x) => x.level === "warn").length;
  console.log(errs ? `결과: 문제 ${errs}건 (경고 ${warns})` : `결과: OK (경고 ${warns})`);
  console.log("");
  process.exit(errs ? 1 : 0);
}
