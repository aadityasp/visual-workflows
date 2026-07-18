/**
 * Role sniffing for Claude Code subagents whose subagent_type hides their
 * real role. gsd (get-shit-done) spawns its planner/researcher roles as
 * 'general-purpose' agents whose prompt carries a "read agents/gsd-X.md"
 * instruction (docs/discovery/gsd.md) — the prompt, not the type, names the
 * role. Sniffing it lets a /gsd run show "gsd-planner" panels instead of
 * anonymous general-purpose boxes.
 */
export function sniffAgentRole(
  subagentType: string | undefined,
  prompt: string | undefined,
): string | undefined {
  if (prompt) {
    const m = /\bagents\/(gsd-[a-z-]+)\.md\b/.exec(prompt);
    if (m) return m[1];
  }
  return subagentType;
}
