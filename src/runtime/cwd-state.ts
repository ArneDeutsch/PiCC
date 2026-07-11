/**
 * Session-scoped effective-cwd state.
 *
 * Pi has no session-cwd mutation API, so the worktree cwd swap (plan §4.4 — load-bearing)
 * is implemented by routing every tool execution through this mutable state:
 * all PiClauDex tools and built-in tool overrides resolve paths/cwd via `get()` at
 * execute time. EnterWorktree pushes a new cwd; ExitWorktree restores the base.
 */
export class CwdState {
  private readonly base: string;
  private effective: string;
  /** Active worktree path when inside one. */
  private worktree: string | undefined;

  constructor(base: string) {
    this.base = base;
    this.effective = base;
  }

  get(): string {
    return this.effective;
  }

  getBase(): string {
    return this.base;
  }

  getWorktree(): string | undefined {
    return this.worktree;
  }

  enterWorktree(worktreePath: string): void {
    this.worktree = worktreePath;
    this.effective = worktreePath;
  }

  exitWorktree(): void {
    this.worktree = undefined;
    this.effective = this.base;
  }
}
