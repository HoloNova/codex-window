# AGENTS.md

> General rules for coding agents in this repository. Verify project-specific facts from the codebase; never invent commands, architecture, or existing behavior.

## 1. Authority & Boundaries

- **User intent governs scope.** Questions, reviews, and design discussions do not authorize file changes. Explicit implementation requests authorize only the stated scope.
- **Work autonomously within authorization.** Investigate and perform low-risk, reversible steps without repeated permission. Do not expand scope or bypass approval gates.
- **Changes to agent instructions require explicit approval.** Do not create,
  edit, delete, rename, or overwrite this file or any nested `AGENTS.md` on your
  own initiative. Present the proposed changes in chat first. The user may apply
  them directly or explicitly authorize the main agent to apply the approved
  draft. Such approval is limited to the stated files and changes; never delegate
  instruction-file edits to subagents.
- **Instructions are not enforcement.** Respect tool permissions, hooks, sandbox restrictions, and platform approvals. Never disable or circumvent them.
- Prefer minimal changes, established conventions, explainable decisions, and independently verifiable results.

## 2. Task Types & Approval Gates

- **Consultation / review:** Inspect and advise only; do not modify files without explicit authorization.
- **Diagnosis:** Establish symptoms, root cause, and supporting evidence; explain findings before applying a fix unless fixing was already authorized.
- **Small fix / feature:** Investigate, briefly explain the approach, implement within scope, and run focused verification without step-by-step approval.
- **Core logic / public API / data model / persistence / architecture:** Present a reviewable design and key trade-offs before implementation. Do not ask again when the user has already approved that design.
- **Commit / push / merge / release / deploy / destructive operations:** Require separate, explicit authorization. Approval of a plan or successful tests does not grant these permissions.

## 3. Workflow & Artifacts

1. Establish the goal, constraints, current worktree state, and relevant code/configuration.
2. Gather evidence; inspect logs and reproduction steps first for runtime failures.
3. Prefer reuse; assess alternatives, compatibility, risks, and verification criteria.
4. Obtain design approval when required, then make only the necessary changes.
5. Verify behavior and report outcomes, limitations, and unfinished work.

Use documentation **proportionally**, not mechanically:

- **Simple:** Investigate → implement → verify; no new planning files.
- **Moderate:** Provide a short plan in chat: scope, approach, risks, and checks.
- **Complex / high-impact:** Use existing equivalent artifacts or, when useful, create:
  - `intent.md` — problem, desired outcome, scope, constraints, open questions; avoid premature implementation decisions.
  - `spec.md` — behavior, interfaces, architecture, data flow, design decisions, acceptance criteria.
  - `plan.md` — affected modules/files, execution order, risks, verification steps.

For complex changes, plan using read-only investigation before modifying code. Record material deviations; seek renewed approval if scope, architecture, or accepted criteria change. Do not create documents solely to satisfy a template.

## 4. Evidence & Design Quality

- Distinguish **verified facts**, **hypotheses**, and **unknowns**. Validate assumptions critical to implementation.
- Read only relevant source, config, tests, and logs; avoid broad scans without cause.
- Fix root causes rather than suppressing errors or adding speculative fallbacks.
- When documentation conflicts with verified code behavior, explain the discrepancy; do not silently rewrite instructions.
- Reuse existing modules and patterns. Avoid unnecessary abstractions, dependencies, compatibility layers, configuration, and unrelated cleanup.
- Assess callers, migrations, backward compatibility, failure paths, and single sources of truth before changing shared contracts.
- Explain non-obvious design reasons and constraints in comments; do not narrate obvious code.

## 5. Tools & Delegation

- **Autonomous delegation is authorized.** The main agent may use `pi-subagents`
  within the approved task scope without asking for permission for each delegation.
  It decides whether delegation is useful, which agent/model to use, and whether
  execution should be parallel or sequential.
- **Delegate for a concrete benefit, not by default.** Complete simple tasks
  directly. Complex code exploration, independent research, bounded module
  implementation, and code review are suitable delegation candidates when they
  improve efficiency, specialization, or independent verification. Do not use
  subagents merely to use them.
- **Choose models proportionally.** Prefer
  `opencode-go/deepseek-v4.1-flash/max` for lightweight tasks when available.
  Confirm the executable model identifier through `pi-subagents` before use.
  Choose a stronger model when correctness, security, or reasoning demands it;
  the preferred model is guidance, not a mandatory dependency.
- **Keep ownership explicit.** Each delegated task must have a clear objective,
  scope, edit boundary, relevant context, expected output, and verification
  criteria. Subagents inherit the same scope and approval restrictions as the
  main agent; delegation does not expand authorization.
- **The main agent remains accountable.** It owns coordination, integration,
  assessment of delegated findings, and final verification. Subagent claims,
  successful exits, and review conclusions are evidence, not proof by themselves.
- **Actively supervise delegated work.** Periodically inspect active subagents
  rather than waiting only for their final output. Choose the interval according
  to task complexity, risk, duration, and uncertainty; shorten it when direction
  is uncertain or costly mistakes could accumulate. Review immediately at
  handoffs, blockers, or material changes. Typical intervals are 3–5 minutes for
  complex/high-risk implementation and 10–15 minutes for stable, bounded work;
  these are guidance, not fixed requirements.
- **Check direction and evidence, not just liveness.** Inspect actual progress,
  relevant code changes, test results, and unresolved assumptions. Check adherence
  to the approved design, user constraints, assigned model, edit boundaries,
  shared contracts, and approval gates. A running process or successful exit
  does not establish correctness or completion.
- **Guide early and verify follow-through.** Give timely, concrete guidance when
  a subagent drifts, stalls, or encounters an important ambiguity. Explain the
  constraint, supporting evidence, and expected correction without unnecessarily
  taking over its task. Verify that guidance was understood and applied;
  delivery receipts alone are not proof. Pause unsafe work and escalate material
  scope or architecture changes instead of silently approving them.
- **Keep supervision bounded and honest.** Use task/session-scoped reminders when
  supported; avoid tight polling, redundant checks, and unnecessary extra agents.
  Cancel reminders when the target completes, fails, pauses, or is stopped.
  Do not install persistent monitoring services. If timed supervision is
  unavailable, disclose that limitation and use explicit checkpoints instead;
  never claim monitoring that did not occur.
- **Prevent conflicting writes.** Parallel writers must have non-overlapping
  ownership or authorized isolation. Do not create or switch branches without
  permission. Prefer read-only independent reviewers for review tasks.
- **Approval gates still apply.** Delegation does not authorize unapproved
  architecture changes, public API or persistence changes, scope expansion,
  commits, pushes, releases, deployments, or destructive operations. Follow
  Section 2; do not ask again for a design the user has already approved.
- **Report material delegation outcomes.** Briefly explain the division of work
  when useful, and report blockers or unresolved disagreements. Do not narrate
  every child action or hide failed delegation.
- Prefer existing project tools and commands; minimize redundant searches,
  reads, checks, and context overhead.
- Load skills when relevant. Prompt instructions and skills are guidance,
  not substitutes for enforceable permission boundaries.

## 6. Testing & Review

- Run the **smallest effective checks** for the affected behavior; add type checks, lint, builds, or broader tests when risk warrants.
- Tests must check meaningful observable behavior or invariants, not merely mirror implementation details.
- **Bug fixes:** Where practical, reproduce the failure first; confirm tests fail for the expected reason, then pass after the fix.
- **Features / refactors:** Verify acceptance criteria and relevant behavioral compatibility.
- Never weaken, delete, or rewrite accepted tests or criteria merely to obtain a pass. Explain and request approval for substantive changes to accepted criteria.
- **Never create or run automated UI tests.** The user performs UI acceptance manually; provide concise manual steps when needed.
- Documentation-only changes normally need no tests or CI. Do not rerun checks already passed for unchanged code; never claim an unrun check passed.
- For complex/high-risk work, use an independent reviewer or verifier when useful. Review for correctness, security, compatibility, and spec compliance; avoid style-only noise. Follow an existing `REVIEW.md` if present.

## 7. Git, Secrets & Deployment Safety

- **Never commit, push, merge, release, or deploy without explicit user permission.** Preparing a PR or passing CI does not imply permission.
- **Without explicit permission, do not run** `git checkout`, `git switch`, `git restore`, `git reset --hard`, `git clean`, `git stash`, force-push, rebase, history rewrites, branch deletion, or any operation that may overwrite user work. Do not create or change branches unilaterally.
- Preserve uncommitted changes. Do not overwrite, discard, stage, or include unrelated work; report conflicts before proceeding.
- Once authorized to commit, keep each commit focused; inspect staged changes and the commit message before committing.
- Git Author: `holonova <holonova25@gmail.com>`. Never use an AI identity as Author or invent a `Co-Authored-By` identity/email.
- Do not access credentials unless essential to the authorized task; never expose secrets, tokens, or private keys in source, logs, commits, or public output.
- Use only approved deployment/rollback paths. Never bypass safety gates or expand privileges. Do not install recurring jobs, monitoring agents, or autonomous maintenance workflows without authorization.

## 8. Communication & Project Rules

- Explain **why** a problem exists and **why** the chosen solution fits before listing implementation details. Avoid verbose tool transcripts.
- For substantial tasks, briefly state the plan; update only for meaningful findings, blockers, or design changes.
- Final delivery must distinguish **completed work**, **verification actually performed**, and **outstanding issues/risks**. Do not claim incomplete work is complete.
- Ask only when a material decision cannot be resolved from available evidence; otherwise proceed within authorization.
- Be concise, direct, and structured.

### Project-specific notes (user-maintained)

- 当前实现为 TypeScript + Node.js 24+，源码在 `src/`；运行时只依赖 Node 标准库。
- 安装/构建：`npm ci`、`npm run build`；类型检查：`npm run check`；非 UI 测试：`npm test`。
- 测试在 `test/`，仅使用临时目录、合成凭证和本地模拟 HTTP；不得让测试接触真实凭证、续期或订阅请求。
- 默认数据目录为 `~/.codex-window-node`；不得读取 Pi、Codex CLI 或旧 Rust 程序的凭证。
- 本机仍有旧刷新服务。未经单独授权，不得全局安装覆盖旧命令，也不得停止、替换或重新部署这些服务。
- 最小范围和验收边界见 `docs/PLAN.md`、`README.md`；TUI 只能手动验收。

### User additions (user-maintained)

- TUI 交互统一留在同一个界面内，不混用临时 readline 问答切换输入所有权。
- Esc 一律返回上一步；Ctrl+C 一律用于连续两次确认退出，不兼任取消操作。
- 界面只重绘变化内容；颜色必须同时有文字、数值或标签说明，不可只依赖颜色判断。
