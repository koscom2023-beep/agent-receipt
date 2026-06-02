// 내장 preset 레지스트리(단일 출처). init/draft-contract/presets 가 공유한다.
// 외부 registry/network 없음 — templates/ 에 동봉된 builtin 만.
export interface PresetMeta {
  file: string; // templates/ 안의 계약 파일명
  title: string; // 한 줄 이름
  when: string; // 추천 상황
}

export const PRESETS: Record<string, PresetMeta> = {
  generic: {
    file: "generic.yaml",
    title: "범용 patch-only",
    when: "아무 프로젝트나 시작점. allowed_paths 비움(denied 보호 중심).",
  },
  "nextjs-supabase": {
    file: "nextjs-supabase.yaml",
    title: "Next.js + Supabase",
    when: "migrations/lockfile/vercel.json denied + tsc 체크 포함.",
  },
  promptia: {
    file: "promptia.yaml",
    title: "Promptia 전용",
    when: "Promptia 구조(app/src/.../database/e2e) allowed + .env/migrations/vercel/exports denied.",
  },
  strict: {
    file: "strict.yaml",
    title: "엄격(strict)",
    when: "위험 작업·외주 검수. allowed 좁게 + untracked/staged 검사 on.",
  },
  relaxed: {
    file: "relaxed.yaml",
    title: "느슨(relaxed)",
    when: "탐색/프로토타이핑. denied 중심, ambient 노이즈에 관대.",
  },
};

const line = "─".repeat(56);

/** `agent-receipt presets` — 내장 preset 목록·설명 출력(read-only, local builtin only). exit 0. */
export function runPresets(): never {
  console.log("");
  console.log(line);
  console.log("agent-receipt presets — 내장 계약 preset (local builtin)");
  console.log(line);
  for (const [name, m] of Object.entries(PRESETS)) {
    console.log(`  ${name}`);
    console.log(`      ${m.title} — ${m.when}`);
  }
  console.log(line);
  console.log("  사용:  agent-receipt init --preset <name>   /   초안:  agent-receipt draft-contract --preset <name>");
  console.log("");
  process.exit(0);
}
