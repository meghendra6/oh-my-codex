---
name: team
description: N coordinated agents on shared task list using tmux-based orchestration
---

# Team Skill

Spawn N coordinated Codex CLI sessions as worker agents, each in its own tmux window, working on a shared task list. Communication flows through file-based inboxes and shared state files. The lead session orchestrates work by writing task assignments, monitoring progress via heartbeat files, and detecting completion or failure.

## Usage

```
$team N:agent-type "task description"
$team "task description"
$team ralph "task description"
```

### Parameters

- **N** - Number of worker agents (1-6, configurable up to 20). Optional; defaults to auto-sizing based on task decomposition.
- **agent-type** - Worker role for the `team-exec` stage (e.g., executor, build-fixer, designer). Optional; defaults to executor.
- **task** - High-level task to decompose and distribute among workers.
- **ralph** - Optional modifier. Wraps the team pipeline in Ralph's persistence loop.

### Examples

```bash
$team 3:executor "fix all TypeScript errors across the project"
$team 4:build-fixer "fix build errors in src/"
$team "refactor the auth module"
$team ralph "build a complete REST API for user management"
```

## Architecture

```
User: "$team 3:executor fix all TypeScript errors"
           |
           v
   [LEAD CODEX SESSION]
           |
           +-- 1. Parse input (N=3, type=executor, task=...)
           |
           +-- 2. Analyze & decompose (explore/architect via spawn_agent)
           |       -> produces task list with file-scoped assignments
           |
           +-- 3. Create team state
           |       -> state_write(mode="team", phase="team-plan", ...)
           |       -> initTeamState(.omx/state/team/{name}/)
           |
           +-- 4. Create tmux session: omx-team-{name}
           |       -> window 0: "monitor" (HUD)
           |       -> window 1: "worker-1" (env: OMX_TEAM_WORKER={name}/worker-1)
           |       -> window 2: "worker-2" (env: OMX_TEAM_WORKER={name}/worker-2)
           |       -> window 3: "worker-3" (env: OMX_TEAM_WORKER={name}/worker-3)
           |
           +-- 5. Wait for worker readiness (poll tmux capture-pane)
           |
           +-- 6. Bootstrap workers via file-based inbox
           |       -> Write prompt to .omx/state/team/{name}/workers/{id}/inbox.md
           |       -> send-keys trigger: "Read and follow instructions in ..."
           |
           +-- 7. Monitor loop (poll state files)
           |       <- heartbeat.json (auto-updated by notify hook)
           |       <- tasks/{id}.json (updated by workers)
           |       -> Detect completion, failure, death
           |       -> Reassign via new inbox + trigger
           |
           +-- 8. Shutdown
                   -> send shutdown inbox + trigger
                   -> tmux kill-session
                   -> state_clear(mode="team")
```

## Communication Protocol

### Lead -> Worker (File-Based Inbox)

The lead NEVER sends large prompts via tmux send-keys. Instead:

1. Write the full prompt to `.omx/state/team/{name}/workers/{id}/inbox.md`
2. Send a short trigger (<200 chars) via `tmux send-keys`: "Read and follow the instructions in .omx/state/team/{name}/workers/{id}/inbox.md"
3. Worker reads the inbox file and executes

### Worker -> Lead (State Files)

Workers communicate by writing JSON state files:

- **Task status**: `.omx/state/team/{name}/tasks/task-{id}.json` (status, result, error)
- **Worker status**: `.omx/state/team/{name}/workers/{id}/status.json` (idle/working/blocked/done/failed)
- **Heartbeat** (automatic): `.omx/state/team/{name}/workers/{id}/heartbeat.json` (updated by notify hook after each turn)

### Worker Identity

Each worker knows its identity via the `OMX_TEAM_WORKER` environment variable, set when the tmux window is created:

```bash
tmux new-window -t {session} -n worker-1 "env OMX_TEAM_WORKER={team}/worker-1 codex"
```

The notify hook reads this to:
1. Update the worker's heartbeat file automatically
2. Skip global mode state iteration (prevents state corruption)
3. Skip tmux prompt injection (only the lead injects)

## State File Layout

```
.omx/state/team/{team-name}/
  config.json                      # Team metadata
  workers/
    worker-1/
      heartbeat.json               # Auto-updated by notify hook
      status.json                  # Written by worker
      identity.json                # Written at bootstrap
      inbox.md                     # Written by lead (current instructions)
    worker-2/
      ...
  tasks/
    task-1.json                    # {id, subject, description, status, owner, result, error, blocked_by}
    task-2.json
    ...
```

## Staged Pipeline

The team follows the canonical 5-stage pipeline from `src/team/orchestrator.ts`:

| Stage | Purpose | Agents |
|-------|---------|--------|
| team-plan | Analyze & decompose | explore (haiku), planner (opus) |
| team-prd | Extract requirements | analyst (opus), product-manager |
| team-exec | Execute subtasks | executor (sonnet), or task-specific |
| team-verify | Validate quality | verifier (sonnet), reviewers |
| team-fix | Fix defects (loop) | executor, build-fixer, debugger |

Terminal states: `complete`, `failed`, `cancelled`.

## Worker Protocol

Workers follow this protocol (injected via AGENTS.md overlay + inbox):

1. Read inbox file at the path sent via terminal
2. Read task file at `.omx/state/team/{name}/tasks/task-{id}.json`
3. Write `{"status": "in_progress"}` to the task file
4. Do the work
5. Write `{"status": "completed", "result": "summary"}` to the task file
6. Write `{"state": "idle"}` to status file
7. Wait for new instructions

### Worker Rules

- Do NOT edit files outside the paths listed in your task
- If you need to modify a shared file, write `{"state": "blocked", "reason": "..."}` and wait
- ALWAYS write results to the task file before reporting done

## Monitoring & Progress Detection

The lead monitors via `monitorTeam()` which reads all state files and returns a `TeamSnapshot`:

- **Task counts**: total, pending, in_progress, completed, failed
- **Worker liveness**: PID-based detection via tmux pane PID
- **Dead workers**: Workers whose tmux pane PIDs are gone
- **Non-reporting workers**: Active heartbeat but stale task status (>5 turns)
- **Recommendations**: "Reassign task-3 from dead worker-2", "Send reminder to non-reporting worker-1"

## Error Recovery

- **Dead worker**: Detected via PID monitoring. Lead reassigns their in-progress tasks to alive workers.
- **Non-reporting worker**: Detected by cross-referencing heartbeat turns with task updates. Lead sends reminder via inbox.
- **All workers dead**: Lead reports failure and cleans up.
- **Task failure**: Worker writes `{"status": "failed", "error": "reason"}`. Lead decides whether to reassign or transition to team-fix phase.

## Shutdown Protocol

1. Write shutdown inbox to each worker with exit instructions
2. Send short trigger via send-keys
3. Wait up to 15 seconds for workers to exit
4. Force kill remaining workers via tmux kill-window
5. Destroy tmux session via tmux kill-session
6. Strip AGENTS.md overlay
7. Clean up state: `rm -rf .omx/state/team/{name}/`
8. Clear mode state: `state_clear(mode="team")`

## Team + Ralph Composition

When invoked with `ralph` modifier, both modes activate:
- Team state has `linked_ralph: true`
- Ralph state has `linked_team: true`
- Ralph wraps the team pipeline with persistence and architect verification
- Coordinated cancellation: cancel team first, then ralph

## Requirements

- **tmux** must be installed (`apt install tmux` / `brew install tmux`)
- Team mode fails fast with a clear error if tmux is not available
- Maximum 6 workers by default (configurable up to 20 via `.omx-config.json`)

## V1 Limitations

- **No git worktree isolation**: Workers share the project directory. File conflicts are mitigated by scoping tasks to non-overlapping file sets and explicit worker rules. Git worktree isolation is planned for V2.
- **No inter-worker messaging**: Workers cannot communicate directly. All coordination goes through the lead via state files.
