import { writeSync } from "node:fs";

/**
 * stdout 전량 동기 write — 큰 결과를 낸 뒤 즉시 `process.exit()` 해도 안 잘리게.
 *
 * 실측(2026-07-03): `graph view --format json` 888KB 출력이 파이프로는 64KB(리눅스 파이프 버퍼)·
 * execFileSync 로는 212KB 만 도착해 JSON.parse 가 "Unterminated string" 으로 죽었다(파일 리다이렉트만
 * 무증상). 두 원인이 겹친다:
 *   ① `console.log` → 비동기 stdout. `process.exit()` 가 flush 전에 프로세스를 끝냄.
 *   ② `writeSync(1, str)` 한 방 — fd 1 이 non-blocking 파이프면 **부분 write** 후 쓴 바이트 수를
 *      반환하는데 그 값을 무시하면 나머지가 버려진다(EAGAIN 을 던지기도 함).
 * → 반환 바이트를 세어 전량 쓸 때까지 루프하고 EAGAIN 은 재시도한다. 리더(jq·wc·execFileSync)가
 *   파이프를 비우면 진행된다. 개행은 console.log 와 동일하게 맞춰 출력 바이트 불변(골든 안전).
 */
export function printSync(str: string): void {
  const buf = Buffer.from(str + "\n", "utf8"); // console.log(str) 와 동일: 항상 개행 1개(골든 바이트 패리티)

  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; // 파이프 버퍼 참 — 리더가 비울 때까지 재시도
      throw e;
    }
  }
}
