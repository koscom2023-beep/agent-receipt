import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as g from "./git.js";
import { costOf, priceFor, PRICING_AS_OF, type UsageTokens } from "./pricing.js";

// ── transcript 리더 (council 2026-07-03·화폐화 토대) ──
// Claude Code 는 세션 기록을 ~/.claude/projects/<escaped-cwd>/<session>.jsonl 에 남긴다(로컬·no-cloud).
// 거기엔 메시지별 usage(input/output/cache_read/cache_creation)·model·tool_use 이름·timestamp 가 있다 —
// 훅 payload 엔 없던 *실제 청구 데이터*(Anthropic 자신의 usage). 이걸 읽어 요약만 뽑는다.
// 🔴 정직/안전 규율:
//   · 값(프롬프트 본문·파일 내용·비밀) 절대 저장/전송 안 함 — 집계 숫자만.
//   · 버전 감지: usage 필드가 하나도 없으면 "미지원 포맷"으로 명시 off(조용한 오계량 금지).
//   · 미문서 내부 포맷이라 fragile — 파싱 실패는 crash 아니라 unsupported.
//   · cache_read 큼 = 낭비 아님(캐시가 90% 아낀 증거). 지표는 cache_creation·총 컨텍스트 성장.

const KNOWN_USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

export interface TranscriptSummary {
  supported: boolean;
  reason?: string; // supported=false 일 때 사람에게 보일 이유
  sessionFile?: string;
  messages: number; // usage 있는 어시스턴트 메시지 수
  tokens: UsageTokens;
  byModel: Array<{ model: string; tokens: UsageTokens; cost: number | null }>;
  toolCounts: Array<{ tool: string; count: number }>;
  cost: number | null; // 전체 리스트가 기준(모델 하나라도 가격 미상이면 부분 — hasUnpriced 로 표기)
  hasUnpriced: boolean;
  firstTs?: string;
  lastTs?: string;
  contextPeak: number; // 한 메시지의 최대 (input+cache_read+cache_creation) = 컨텍스트 크기 정점
  pricingAsOf: string;
}

// cwd → Claude Code 프로젝트 디렉터리명. 관찰 규칙(실측): 절대경로의 '/'·'.' → '-'.
// 예: /home/sah4444/agent-receipt → -home-sah4444-agent-receipt (실측 디렉터리와 일치).
export function projectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptDir(cwd: string = process.cwd()): string {
  return join(homedir(), ".claude", "projects", projectDirName(cwd));
}

// 세션 파일 선택: env CLAUDE_CODE_SESSION_ID 우선(현 세션), 없으면 가장 최근 수정 .jsonl.
export function findSessionFile(cwd: string = process.cwd(), sessionId?: string): string | null {
  const dir = transcriptDir(cwd);
  if (!existsSync(dir)) return null;
  const sid = sessionId ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (sid) {
    const p = join(dir, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      const m = statSync(p).mtimeMs;
      if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
    }
  } catch {
    return null;
  }
  return newest?.path ?? null;
}

const zero = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
function add(a: UsageTokens, b: UsageTokens): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheCreation += b.cacheCreation;
}

// 순수 파서 — 라인 배열에서 요약 산출(테스트 결정론·파일 IO 밖). 미지 포맷이면 supported:false.
export function summarizeTranscriptLines(lines: string[], sessionFile?: string): TranscriptSummary {
  const total = zero();
  const perModel = new Map<string, UsageTokens>();
  const tools = new Map<string, number>();
  let messages = 0;
  let sawUsageField = false;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let contextPeak = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 깨진 라인은 건너뜀(fragile 포맷 방어)
    }
    const ts = typeof r?.timestamp === "string" ? r.timestamp : undefined;
    if (ts) {
      firstTs = firstTs ?? ts;
      lastTs = ts;
    }
    const msg = r?.message;
    if (msg && typeof msg === "object") {
      // tool_use 이름 카운트(값 미저장 — 이름만)
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content) {
        if (c && c.type === "tool_use" && typeof c.name === "string") tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
      }
      const u = msg.usage;
      if (u && typeof u === "object") {
        if (KNOWN_USAGE_FIELDS.some((k) => k in u)) sawUsageField = true;
        const tok: UsageTokens = {
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          cacheCreation: Number(u.cache_creation_input_tokens) || 0,
        };
        if (tok.input || tok.output || tok.cacheRead || tok.cacheCreation) {
          messages += 1;
          add(total, tok);
          const model = typeof msg.model === "string" ? msg.model : "(unknown)";
          const pm = perModel.get(model) ?? zero();
          add(pm, tok);
          perModel.set(model, pm);
          const ctx = tok.input + tok.cacheRead + tok.cacheCreation; // 이 턴이 처리한 컨텍스트 크기
          if (ctx > contextPeak) contextPeak = ctx;
        }
      }
    }
  }

  if (!sawUsageField) {
    return {
      supported: false,
      reason: "이 Claude Code 세션 기록에 usage(토큰) 필드가 없습니다 — 지원 포맷이 아닙니다(비용 계량 off).",
      sessionFile,
      messages: 0,
      tokens: zero(),
      byModel: [],
      toolCounts: [],
      cost: null,
      hasUnpriced: false,
      contextPeak: 0,
      pricingAsOf: PRICING_AS_OF,
    };
  }

  let cost = 0;
  let hasUnpriced = false;
  const byModel = [...perModel.entries()].map(([model, tokens]) => {
    const c = costOf(tokens, model);
    if (c == null) hasUnpriced = true;
    else cost += c;
    return { model, tokens, cost: c };
  });
  byModel.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (a.model < b.model ? -1 : 1));
  const toolCounts = [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || (a.tool < b.tool ? -1 : 1));

  return {
    supported: true,
    sessionFile,
    messages,
    tokens: total,
    byModel,
    toolCounts,
    cost: byModel.length ? cost : null,
    hasUnpriced,
    firstTs,
    lastTs,
    contextPeak,
    pricingAsOf: PRICING_AS_OF,
  };
}

// 디스크에서 현 세션 요약(없으면 supported:false·이유). 읽기전용.
export function summarizeCurrentSession(cwd: string = process.cwd(), sessionId?: string): TranscriptSummary {
  const file = findSessionFile(cwd, sessionId);
  if (!file) {
    return {
      supported: false,
      reason: "이 저장소의 Claude Code 세션 기록을 찾지 못했습니다(~/.claude/projects/…). 비용 계량 off.",
      messages: 0,
      tokens: zero(),
      byModel: [],
      toolCounts: [],
      cost: null,
      hasUnpriced: false,
      contextPeak: 0,
      pricingAsOf: PRICING_AS_OF,
    };
  }
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      supported: false,
      reason: "세션 기록을 읽지 못했습니다(권한/삭제?). 비용 계량 off.",
      sessionFile: file,
      messages: 0,
      tokens: zero(),
      byModel: [],
      toolCounts: [],
      cost: null,
      hasUnpriced: false,
      contextPeak: 0,
      pricingAsOf: PRICING_AS_OF,
    };
  }
  return summarizeTranscriptLines(raw.split("\n"), file);
}

// 컨텍스트 bloat 신호 임계(council 결정 4·보수적). 정점 컨텍스트가 이 이상이면 fresh-session 권유 1줄.
export const CONTEXT_BLOAT_TOKENS = 200_000;
export { costOf, priceFor };
