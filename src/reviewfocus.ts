import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as g from "./git.js";

// ── 리뷰 압축 (council 2026-07-03 R1~R3) ──
// "전체 N개 중 이 파일들 먼저" — 결정론 고정 티어(가중치 점수 금지·설명가능):
//   T1 위험경로 히트 > T2 의존성 매니페스트 > T3 대형 diff(비테스트·비문서) > T4 신규 파일(src) > 부수.
// 발동 임계 total ≥ 4(그 밑은 그냥 다 보는 게 빠름 → 침묵=기존 출력 불변). 헤더는 '우선 검토 후보' —
// 보증 아님(D dissent: top-N 오정렬 시 4번째 파일 사고 책임 → 문구 완화 + 부수 파일 전부 나열).
// 절감 %·시간 환산 없음(결정 4 승계) — "후보 3 / 전체 18" 사실만.

export const FOCUS_MIN_TOTAL = 4;
const LARGE_DIFF_LINES = 80;
const TOP_N = 3;

const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "requirements.txt",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
]);
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/i;
const isTestPath = (p: string): boolean => TEST_DIR.test(p) || TEST_FILE.test(p);
const isDocPath = (p: string): boolean => /^docs\//i.test(p) || /\.mdx?$/i.test(p);
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export interface FocusFile {
  path: string;
  tier: 1 | 2 | 3 | 4;
  reason: string; // 고정 라벨(자유문 금지)
  added: number;
  deleted: number;
}
export interface ReviewFocus {
  top: FocusFile[];
  rest: string[]; // 부수로 분류된 나머지 — 전부 나열(숨긴 것 없음이 신뢰)
  total: number;
}

export function buildReviewFocus(args: {
  touched: string[];
  untracked: string[];
  riskHits: string[]; // denied/critical/policy 히트 경로(이미 계산된 것 재사용 — 여기서 재판정 안 함)
  perFile: Map<string, { added: number; deleted: number }>;
}): ReviewFocus | null {
  const candidates = [...new Set([...args.touched, ...args.untracked])];
  if (candidates.length < FOCUS_MIN_TOTAL) return null;
  const risk = new Set(args.riskHits);
  const newf = new Set(args.untracked);

  const ranked: FocusFile[] = [];
  for (const p of candidates) {
    const st = args.perFile.get(p) ?? { added: 0, deleted: 0 };
    if (risk.has(p)) ranked.push({ path: p, tier: 1, reason: "위험경로", ...st });
    else if (MANIFESTS.has(base(p))) ranked.push({ path: p, tier: 2, reason: "의존성 매니페스트", ...st });
    else if (st.added + st.deleted >= LARGE_DIFF_LINES && !isTestPath(p) && !isDocPath(p))
      ranked.push({ path: p, tier: 3, reason: "대형 diff", ...st });
    else if (newf.has(p) && !isTestPath(p) && !isDocPath(p)) ranked.push({ path: p, tier: 4, reason: "신규 파일", ...st });
  }
  if (!ranked.length) return null; // 티어 해당 0 = 정렬 근거 없음 → 섹션 자체 생략(전부 동급)
  ranked.sort((a, b) => a.tier - b.tier || b.added + b.deleted - (a.added + a.deleted) || (a.path < b.path ? -1 : 1)); // 코드포인트 비교(로케일 비의존)
  const top = ranked.slice(0, TOP_N);
  const inTop = new Set(top.map((f) => f.path));
  const rest = candidates.filter((p) => !inTop.has(p)).sort((a, b) => (a < b ? -1 : 1));
  return { top, rest, total: candidates.length };
}

/** 사람용 표시줄. focus=null 이면 [] → 출력 불변(골든 안전). */
export function focusLines(f: ReviewFocus | null): string[] {
  if (!f) return [];
  const L: string[] = [`우선 검토 후보 ${f.top.length} / 전체 ${f.total} (정렬 제안 — 보증 아님·나머지도 검토 대상)`];
  f.top.forEach((x, i) => {
    const size = x.added + x.deleted ? ` (+${x.added}/-${x.deleted})` : "";
    L.push(`  ${i + 1}. ${x.path} — ${x.reason}${size}`);
  });
  if (f.rest.length) {
    const head = f.rest.slice(0, 5).join(", ");
    L.push(`  · 부수로 분류: ${head}${f.rest.length > 5 ? ` 외 ${f.rest.length - 5}개` : ""}`);
  }
  return L;
}

// ── 확인 신호 (council R2 — *관찰이지 판정 아님*: skip 추가가 정당할 수도 있음 → '확인하세요'지 '잡았다' 아님) ──
// v1 은 오탐 낮고 정보량 높은 2종만: ①테스트 파일에 skip/only/xit/xdescribe *추가* ②의존성 *추가*.
// TODO/FIXME 신호는 정상 개발에서 흔해 제외(D 반례·Cost 소수의견으로 기록·실측 후 재론). added-lines 만 스캔.

const SKIP_ONLY = /\.(only|skip)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/;

export interface RedFlags {
  skipOnly: Array<{ path: string; count: number }>;
  depsAdded: string[];
}

export function collectRedFlags(touched: string[], untracked: string[] = [], cwd: string = process.cwd()): RedFlags {
  const newf = new Set(untracked);
  const skipOnly: Array<{ path: string; count: number }> = [];
  for (const p of [...new Set([...touched, ...untracked])]) {
    if (!isTestPath(p)) continue;
    try {
      // 추적 파일=diff 추가줄 · 신규 파일=전체가 추가줄(untracked 는 git diff 에 안 잡힘)
      const added = newf.has(p) ? readFileSync(join(cwd, p), "utf8").split("\n") : g.diffAddedLines(p);
      const count = added.filter((l) => SKIP_ONLY.test(l)).length;
      if (count) skipOnly.push({ path: p, count });
    } catch {
      /* fail-open — 신호 하나 못 만드는 게 크래시보다 낫다 */
    }
  }
  let depsAdded: string[] = [];
  if (touched.includes("package.json") || untracked.includes("package.json")) {
    try {
      const prev = g.headFileContent("package.json");
      const cur = readFileSync(join(cwd, "package.json"), "utf8");
      if (prev) {
        // JSON 키 집합 차(dependencies+devDependencies 만·peer/optional 은 v1 제외) — diff 정규식의 scripts 오탐 원천 차단.
        const keys = (s: string): Set<string> => {
          const j = JSON.parse(s) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]);
        };
        const before = keys(prev);
        depsAdded = [...keys(cur)].filter((k) => !before.has(k)).sort((a, b) => (a < b ? -1 : 1));
      }
    } catch {
      /* fail-open */
    }
  }
  return { skipOnly, depsAdded };
}

/** 신호 없으면 null → 출력 불변. 비난조 금지(User Advocate) — 확인 요청 프레이밍. */
export function redFlagLine(rf: RedFlags): string | null {
  const parts: string[] = [];
  const so = rf.skipOnly.reduce((s, x) => s + x.count, 0);
  if (so) parts.push(`테스트 skip/only 추가 ${so}곳(${rf.skipOnly.map((x) => x.path).join(", ")})`);
  if (rf.depsAdded.length) parts.push(`의존성 추가 ${rf.depsAdded.length}개(${rf.depsAdded.join(", ")})`);
  if (!parts.length) return null;
  return `⚠️ 확인 신호(관찰·판정 아님): ${parts.join(" · ")}`;
}
