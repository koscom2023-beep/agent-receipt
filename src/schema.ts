import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// 필수 명령(테스트, tsc 등) 한 줄을 표현하는 스키마
const CommandCheck = z.object({
  name: z.string(),
  command: z.string(),
  required_exit: z.number().default(0),
});

// 작업 계약서 전체 스키마. YAML이 이 모양을 안 지키면 로딩 단계에서 막힌다.
export const ContractSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  mode: z.string().default("patch_only"),

  branch: z.object({ expected: z.string().optional() }).optional(),

  scope: z.object({
    allowed_paths: z.array(z.string()).default([]),
    denied_paths: z.array(z.string()).default([]),
  }),

  // 0.9: linked test 분류(표시 전용 — verify --json outOfScope 14키 의미 불변). 둘 다 optional.
  linked_test_paths: z.array(z.string()).default([]),
  expected_linked_tests: z.array(z.string()).default([]),

  forbidden_actions: z.array(z.string()).default([]),

  required_checks: z
    .object({
      nul: z.object({ paths: z.array(z.string()).default([]) }).optional(),
      commands: z.array(CommandCheck).default([]),
    })
    .default({ commands: [] }),

  git: z
    .object({
      require_no_staged_untracked: z.boolean().default(false),
      require_only_allowed_files_staged: z.boolean().default(false),
      require_no_denied_path_diff: z.boolean().default(true),
      require_no_push: z.boolean().default(false),
    })
    .default({}),

  report: z.object({ required_items: z.array(z.string()).default([]) }).optional(),
});

export type Contract = z.infer<typeof ContractSchema>;

export function loadContract(path: string): Contract {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`계약서 파일을 못 찾음: ${path}`);
  }

  const data = parseYaml(raw);
  const parsed = ContractSchema.safeParse(data);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`계약서 형식 오류 (${path}):\n${msg}`);
  }
  return parsed.data;
}
