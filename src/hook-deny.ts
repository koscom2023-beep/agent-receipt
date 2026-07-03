/** 훅 stdout — 벤더별 가드 deny JSON (실측: Claude PreToolUse · Cursor preToolUse/beforeShellExecution). */
export type HookVendor = "claude" | "cursor";

export function inferHookVendor(payload: unknown): HookVendor {
  const o = (payload ?? {}) as Record<string, unknown>;
  if (typeof o.cursor_version === "string") return "cursor";
  const ev = String(o.hook_event_name ?? o.hookEventName ?? "");
  if (ev && ev[0] === ev[0].toLowerCase()) return "cursor";
  if (typeof o.transcript_path === "string" && ev.startsWith("Pre")) return "claude";
  if (typeof o.permission_mode === "string") return "claude";
  if (typeof o.hook_event_name === "string" && /^PreToolUse|PostToolUse/.test(o.hook_event_name)) return "claude";
  if (typeof o.session_id === "string" && !o.conversation_id) return "claude";
  if (typeof o.conversation_id === "string") return "cursor";
  return "claude";
}

export function formatGuardDeny(vendor: HookVendor, reason: string, hookEventName = "PreToolUse"): string {
  if (vendor === "cursor") {
    return JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message: reason,
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}
