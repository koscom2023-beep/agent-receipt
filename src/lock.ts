import { openSync, closeSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";

// ── 파일 락 + 원자 쓰기 (14차 council·무결점) — stdlib·신규 의존성 0 ──
// capture/ledger/keys 의 'read→chain→append/write' TOCTOU 레이스를 직렬화하고, 전체 덮어쓰기를 원자화한다.
// 락 = O_EXCL('wx') 로 락 파일을 *배타 생성*(존재하면 실패=점유중). 점유중이면 백오프 재시도, mtime 오래된 stale 락은 강탈(crash 데드락 방지).
// 원칙: 우리 .agent-guard 파일에만·로컬·짧은 임계구간. 분산/네트워크 락 아님.

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // busy-spin 없는 동기 sleep
  } catch {
    const until = Date.now() + ms; // SharedArrayBuffer 불가 환경 fallback
    while (Date.now() < until) {
      /* spin */
    }
  }
}

/**
 * `lockPath` 락을 잡고 `fn` 실행 후 해제(finally). 점유중이면 백오프 재시도, staleMs 초과한 stale 락은 강탈.
 * 끝내 못 잡으면 throw — 호출부가 정직하게 처리(capture 훅=degraded 마커, ledger 명령=에러).
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: { retries?: number; baseMs?: number; staleMs?: number } = {}): T {
  const retries = opts.retries ?? 60;
  const baseMs = opts.baseMs ?? 4;
  const staleMs = opts.staleMs ?? 10_000;
  let fd: number | undefined;
  for (let i = 0; ; i++) {
    try {
      fd = openSync(lockPath, "wx"); // O_CREAT|O_EXCL — 존재하면 EEXIST
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          try {
            rmSync(lockPath, { force: true }); // stale 강탈
          } catch {
            /* 경쟁 — 다음 루프 */
          }
          continue;
        }
      } catch {
        continue; // 락이 방금 사라짐 → 재시도
      }
      if (i >= retries) throw new Error(`lock 획득 실패(${retries}회 재시도): ${lockPath}`);
      sleepSync(baseMs + Math.min(i, 20)); // 가벼운 선형 백오프(최대 ~24ms)
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* noop */
      }
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* noop */
    }
  }
}

/** 전체 덮어쓰기를 원자적으로(temp+rename). 같은 파일시스템 rename=POSIX 원자 → 인터럽트 시 부분파일 노출 없음(옛 파일 유지). mode=개인키 등 0o600. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, path);
}
