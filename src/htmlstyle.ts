// UX U5 — 4개 HTML 산출물(share-proof·inbox·dashboard·evidence-browser)의 공유 스타일 SSOT.
// 목표: "화면은 유지, 얼굴만 하나"(회의 U5). 따뜻한 종이(감열 영수증) 팔레트 + 한 벌 폰트 + 판정 위계 색.
// U8(a11y) 동봉: 판정은 색+아이콘+텍스트 3중 신호(verdictVisual 단일 출처) — 색만으로 구분하지 않는다.
// 자체완결 정적 원칙 유지: 외부 리소스 0(폰트도 시스템·로컬). 전부 CSS 문자열이라 no-deps.

/** 공유 색·폰트 토큰. 각 빌더 <style> 맨 앞에 넣는다(뒤 규칙이 var 로 참조). */
export function sharedTokens(): string {
  // 상위집합: 의미 이름(--paper/--ink/--rule)과 기존 evidence-browser 이름(--bg/--text/--mut/--border…)을 모두 제공,
  // 전부 따뜻한 종이 팔레트 값으로 매핑(4개 산출물이 같은 얼굴). 외부 리소스 0.
  return `:root{
  --paper:#faf9f6;--bg:#faf9f6;--paper-raised:#ffffff;--bg-raised:#ffffff;--bg-hover:#f1eee7;
  --ink:#211d18;--text:#211d18;--ink-soft:#6b6459;--mut:#6b6459;
  --rule:#e6e1d8;--border:#e6e1d8;--rule-soft:#efece5;--border-soft:#efece5;
  --pass:#1a7f37;--fail:#c0392b;--warn:#8a6d00;--incomplete:#6b6459;--accent:#b5502a;
  --pass-bg:#1a7f3714;--fail-bg:#c0392b12;--warn-bg:#8a6d0014;--incomplete-bg:#6b645912;--accent-bg:#b5502a12;
  --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Pretendard,Roboto,"Helvetica Neue",Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;
}

/** 공유 기본 규칙(판정 배지 색 클래스 포함 — U8 a11y 색 축). 레이아웃별 CSS 는 각 빌더가 이어붙인다. */
export function sharedBase(): string {
  return `*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:var(--font-ui);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
code,.hash{font-family:var(--font-mono)}
.v-pass{color:var(--pass)}.v-fail{color:var(--fail)}.v-warn{color:var(--warn)}.v-incomplete{color:var(--incomplete)}
details.limits{margin:.6rem 0;color:var(--ink-soft);font-size:.82rem}
details.limits>summary{cursor:pointer;color:var(--ink-soft);font-size:.82rem;list-style:disclosure-closed}
details.limits[open]>summary{list-style:disclosure-open}`;
}

export type VerdictKey = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "INCOMPLETE" | "none";
export type VerdictVisual = { cls: string; icon: string; label: string; cssVar: string };

// U8 — 판정 3중 신호(색 클래스 + 아이콘 + 텍스트)의 단일 출처. 색만으로 구분 금지.
const VERDICT_VISUAL: Record<VerdictKey, VerdictVisual> = {
  PASS: { cls: "v-pass", icon: "✅", label: "PASS", cssVar: "var(--pass)" },
  PASS_WITH_WARNINGS: { cls: "v-warn", icon: "⚠️", label: "PASS_WITH_WARNINGS", cssVar: "var(--warn)" },
  FAIL: { cls: "v-fail", icon: "❌", label: "FAIL", cssVar: "var(--fail)" },
  INCOMPLETE: { cls: "v-incomplete", icon: "◌", label: "INCOMPLETE", cssVar: "var(--incomplete)" },
  none: { cls: "v-incomplete", icon: "◌", label: "판정 없음", cssVar: "var(--incomplete)" },
};

export function verdictVisual(v: VerdictKey | string | null | undefined): VerdictVisual {
  const key = (v ?? "none") as VerdictKey;
  return VERDICT_VISUAL[key] ?? VERDICT_VISUAL.none;
}

/** 접히는 "한계·범위" 블록(U4 — 정직 라벨은 유지하되 1클릭으로 접어 긍정 결과를 크게). */
export function limitsDetails(summaryLabel: string, bodyHtml: string): string {
  return `<details class="limits"><summary>${summaryLabel}</summary>${bodyHtml}</details>`;
}
