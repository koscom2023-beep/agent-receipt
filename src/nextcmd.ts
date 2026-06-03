import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { loadContract } from "./schema.js";
import { resolveSession } from "./session.js";
import { runVerify } from "./checks.js";

/**
 * `agent-receipt next` — 현재 상태에서 "지금 해야 할 한 명령"만 추천한다(0.9, read-only).
 * router(run)/mode 의 상태 판정을 단일 명령 추천으로 압축. exit 0(정상 추천) / 1(FAIL 상태).
 */
export function runNext(cwd: string = process.cwd()): never {
  const cPath = discoverContract(cwd);
  if (!cPath) {
    console.log("다음: agent-receipt init --preset <name>   (계약 생성 — 아직 없음)");
    process.exit(0);
  }
  try {
    loadContract(cPath);
  } catch {
    console.log("다음: agent-receipt doctor   (계약 형식 오류 — 어디가 깨졌는지 확인)");
    process.exit(0);
  }
  const contract = loadContract(cPath);

  if (!g.isGitRepo()) {
    console.log("다음: agent-receipt check   (git 저장소 아님 — 명령 점검만 가능)");
    process.exit(0);
  }

  const sess = resolveSession(cwd);
  if (!sess.session) {
    console.log("다음: agent-receipt begin --kind <recon|implementation|...>   (작업 시작 baseline)");
    process.exit(0);
  }
  if (!sess.applied) {
    console.log("다음: agent-receipt reset → agent-receipt begin   (baseline 무효 — 재시작)");
    process.exit(0);
  }

  const v = runVerify(contract);
  if (!v.ok) {
    console.log("다음: agent-receipt explain   (verify FAIL — 왜인지 + 다음 조치)");
    process.exit(1);
  }

  const kind = sess.session.kind;
  if (v.touched.length === 0) {
    console.log("다음: agent-receipt close-recon   (변경 0 — 정찰 세션 종료 + reset)");
    process.exit(0);
  }
  if (kind === "recon" || kind === "release-check") {
    console.log("다음: 변경 감지 — 정찰 세션인데 코드가 바뀌었습니다. 되돌리거나, 구현이면 reset 후 begin --kind implementation");
    process.exit(0);
  }
  console.log("다음: agent-receipt finish   (변경 있음 — done+commit-check+audit-pack+커밋블록)");
  process.exit(0);
}
