// Claude Code asked to resume a session it doesn't have (claude --resume <id>): "No conversation found with session ID:
// <id>". It happens when the session's folder didn't reach the job that runs the pass (a Studio instance replaced while
// the change waited, a pass that ran on another machine), and it used to fail the change with its uncommitted work
// (2026-11-02: c_d27f9425937c, c_61c00d89ad8d). agents.ts agentPass then starts a new session told the same instead.

/** Whether a pass's output says the session it was told to resume doesn't exist. */
export function sessionGone(text: string | null | undefined): boolean {
  return /No conversation found with session ID/i.test(String(text ?? ''));
}

/** The prompt for the new session that stands in for a gone one: the brief, where the work is, then what was asked. */
export function freshSessionPrompt(prompt: string) {
  return `Read .hawkes/brief.md: it's your whole task. Your earlier session couldn't be found, so this one starts fresh: your work so far is in the worktree (\`git status\`, \`git log\`). ${prompt}`;
}
