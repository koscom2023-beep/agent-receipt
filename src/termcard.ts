import type { Receipt } from "./receipt.js";
import { verdictVisual } from "./htmlstyle.js";

// 터미널 판정 카드 — HTML 첫3초 히어로(U6)의 터미널판. 순수 렌더러(문자열 조립·no-deps).
// 회의 결정: 아이콘·라벨은 verdictVisual(SSOT) 재사용 · 색은 조건부 · 동아시아폭 정렬 · 판정 미화 금지.

// ── ANSI ──
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

/** 판정 → ANSI 색(verdictVisual 의 의미와 1:1). 색만이 아니라 아이콘+라벨과 함께 3중 신호. */
function verdictColor(key: string): string {
  switch (key) {
    case "PASS":
      return ANSI.green;
    case "FAIL":
      return ANSI.red;
    case "PASS_WITH_WARNINGS":
      return ANSI.yellow;
    default:
      return ANSI.gray; // INCOMPLETE·none
  }
}

/** 색 사용 여부 — TTY 이고 NO_COLOR 미설정일 때만(FORCE_COLOR=1 은 강제 허용). 파이프/CI/리다이렉트엔 무색. */
export function useColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.FORCE_COLOR === "1") return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return !!stream.isTTY;
}

// ── 동아시아폭: ANSI 제거 후 코드포인트 순회, CJK/전각=2, 나머지=1 ──
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals · Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana·Katakana·CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc Symbols·Dingbats(✅❌⚠️ 등 이모지 — 현대 터미널 2칸)
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji (대략 2칸)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

/** 폭 0 문자 — 변이 선택자(FE00-FE0F·⚠️의 뒷글자)·ZWJ·결합 표식. */
function isZeroWidth(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f);
}

/** 표시 폭(ANSI 무시·CJK/이모지=2·변이선택자/ZWJ=0). */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0 || isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** 평문(ANSI 없음)을 표시폭 max 로 자름 — 넘치면 끝에 …(카드 우변이 안 밀리게). */
export function clip(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const cw = isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (w + cw > max - 1) break; // …자리 1칸 확보
    out += ch;
    w += cw;
  }
  return out + "…";
}

// ── 카드 조립 ──
const INNER = 52; // 테두리 안쪽 표시폭

function pad(content: string, width = INNER): string {
  const gap = width - dispWidth(content);
  return content + " ".repeat(Math.max(0, gap));
}

export interface TermCardOpts {
  color?: boolean; // 미지정 시 useColor() 판정
  title?: string; // 상단 라벨(기본 AI WORK RECEIPT)
}

/** 저장된 Work Receipt → 터미널 카드 문자열(줄바꿈 포함·끝에 개행 없음). */
export function renderTermCard(r: Receipt, opts: TermCardOpts = {}): string {
  const color = opts.color ?? useColor();
  const c = (code: string, s: string): string => (color ? code + s + ANSI.reset : s);
  const dim = (s: string): string => c(ANSI.dim, s);

  const vkey = (r.verdict?.verdict ?? (r.ok ? "PASS" : "FAIL")) as string;
  const vv = verdictVisual(vkey); // 아이콘·라벨 SSOT
  const vcol = verdictColor(vkey);

  const top = "  " + dim("┌" + "─".repeat(INNER) + "┐");
  const midRule = "  " + dim("├" + "─".repeat(INNER) + "┤");
  const bottom = "  " + dim("└" + "─".repeat(INNER) + "┘");
  const row = (inner: string): string => "  " + dim("│") + " " + pad(inner, INNER - 2) + " " + dim("│");

  const VAL = INNER - 2; // 테두리 안쪽 사용폭

  // 상단 제목(넘치면 자름)
  const titleTxt = clip((opts.title ?? "AI WORK RECEIPT") + (r.contractId ? "  ·  " + r.contractId : "") + (r.title ? "  ·  " + r.title : ""), VAL);

  // 판정 히어로(색+아이콘+라벨 3중 · 미화 금지: FAIL 은 빨강으로 크게). 이유는 배지 폭 제외 후 자름.
  const rawReason = r.verdict?.reasons?.length ? r.verdict.reasons.slice(0, 1).join(" · ") : r.ok ? "계약 준수 · 검사 통과" : "위반/범위 밖 · explain 참조";
  const badgeTxt = vv.icon + "  " + vv.label;
  const reasonHint = clip(rawReason, VAL - dispWidth(badgeTxt) - 3);
  const hero = c(ANSI.bold + vcol, badgeTxt) + "   " + dim(reasonHint);

  // 사실 줄(라벨 4칸 + 3칸 여백 = 값 폭 VAL-7)
  const mag = r.magnitude;
  const changed = `${r.touched.length} files   ` + c(ANSI.green, "+" + mag.added) + " / " + c(ANSI.red, "-" + mag.deleted);
  const contractLine = clip(r.contractSnapshot ? `${r.contractSnapshot.kind ?? "?"}${r.contractSnapshot.deniedGlobs?.length ? " · denied: " + r.contractSnapshot.deniedGlobs.slice(0, 2).join(", ") : ""}` : "(계약 스냅샷 없음)", VAL - 7);
  const checksArr = r.checks.slice(0, 3).map((ck) => `${clip(ck.name, 12)} ` + c(ck.ok ? ANSI.green : ANSI.red, ck.ok ? "OK" : "✗"));
  const checksLine = r.checks.length ? checksArr.join(" · ") + (r.checks.length > 3 ? dim(` +${r.checks.length - 3}`) : "") : dim("검사 명령 없음");
  const sealLine = dim(r.contentHash.length > 24 ? r.contentHash.slice(0, 24) + "…" : r.contentHash);

  const lines = [
    top,
    row(dim(titleTxt)),
    midRule,
    row(""),
    row(hero),
    row(""),
    row(dim("변경") + "   " + changed),
    row(dim("계약") + "   " + contractLine),
    row(dim("검사") + "   " + checksLine),
    row(dim("봉인") + "   " + sealLine),
    row(""),
    midRule,
    row(dim("범위와 한계 ▸  자세히: agent-receipt explain")),
    bottom,
  ];
  return lines.join("\n");
}
