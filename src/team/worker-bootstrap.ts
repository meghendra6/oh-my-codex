import type { TeamTask } from './state.js';

const TEAM_OVERLAY_START = '<!-- OMX:TEAM:WORKER:START -->';
const TEAM_OVERLAY_END = '<!-- OMX:TEAM:WORKER:END -->';

/**
 * Generate generic AGENTS.md overlay for team workers.
 * This is the SAME for all workers -- no per-worker identity.
 * Per-worker context goes in the inbox file.
 */
export function generateWorkerOverlay(teamName: string): string {
  return `${TEAM_OVERLAY_START}
<team_worker_protocol>
You are a team worker in team "${teamName}". Your identity and assigned tasks are in your inbox file.

## Protocol
1. Read your inbox file at the path provided in your first instruction
2. Read your task from .omx/state/team/${teamName}/tasks/{id}.json
3. Update task status to "in_progress" by writing {"status": "in_progress"} to the task file
4. Do the work using your tools
5. On completion: write {"status": "completed", "result": "summary of what was done"} to the task file
6. Update your status: write {"state": "idle"} to .omx/state/team/${teamName}/workers/{your-name}/status.json
7. Wait for new instructions (the lead will send them via your terminal)

## Rules
- Do NOT edit files outside the paths listed in your task description
- If you need to modify a shared file, report to the lead by writing to your status file with state "blocked"
- ALWAYS write results to the task file before reporting done
- If blocked, write {"state": "blocked", "reason": "..."} to your status file
</team_worker_protocol>
${TEAM_OVERLAY_END}`;
}

/**
 * Apply worker overlay to AGENTS.md. Idempotent -- strips existing overlay first.
 */
export async function applyWorkerOverlay(agentsMdPath: string, overlay: string): Promise<void> {
  // Read existing content, strip any existing overlay, append new overlay
  // Uses the START/END markers to find and replace
  let content = '';
  try {
    const { readFile } = await import('fs/promises');
    content = await readFile(agentsMdPath, 'utf-8');
  } catch {
    // File doesn't exist yet, start empty
  }

  // Strip existing overlay if present
  content = stripOverlayFromContent(content);

  // Append new overlay
  content = content.trimEnd() + '\n\n' + overlay + '\n';

  const { writeFile } = await import('fs/promises');
  await writeFile(agentsMdPath, content);
}

/**
 * Strip worker overlay from AGENTS.md content. Idempotent.
 */
export async function stripWorkerOverlay(agentsMdPath: string): Promise<void> {
  const { readFile, writeFile } = await import('fs/promises');
  try {
    const content = await readFile(agentsMdPath, 'utf-8');
    const stripped = stripOverlayFromContent(content);
    if (stripped !== content) {
      await writeFile(agentsMdPath, stripped);
    }
  } catch {
    // File doesn't exist, nothing to strip
  }
}

function stripOverlayFromContent(content: string): string {
  const startIdx = content.indexOf(TEAM_OVERLAY_START);
  const endIdx = content.indexOf(TEAM_OVERLAY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + TEAM_OVERLAY_END.length).trimStart();
  return before + (after ? '\n\n' + after : '') + '\n';
}

/**
 * Generate initial inbox file content for worker bootstrap.
 * This is written to .omx/state/team/{team}/workers/{worker}/inbox.md by the lead.
 */
export function generateInitialInbox(
  workerName: string,
  teamName: string,
  agentType: string,
  tasks: TeamTask[],
): string {
  const taskList = tasks
    .map((t) => {
      let entry = `- **Task ${t.id}**: ${t.subject}\n  Description: ${t.description}\n  Status: ${t.status}`;
      if (t.blocked_by && t.blocked_by.length > 0) {
        entry += `\n  Blocked by: ${t.blocked_by.join(', ')}`;
      }
      return entry;
    })
    .join('\n');

  return `# Worker Assignment: ${workerName}

**Team:** ${teamName}
**Role:** ${agentType}
**Worker Name:** ${workerName}

## Your Assigned Tasks

${taskList}

## Instructions

1. Start with the first non-blocked task
2. Read the task file at \`.omx/state/team/${teamName}/tasks/task-{id}.json\`
3. Write \`{"status": "in_progress"}\` to the task file to claim it
4. Complete the work described in the task
5. Write \`{"status": "completed", "result": "brief summary"}\` to the task file
6. Write \`{"state": "idle"}\` to \`.omx/state/team/${teamName}/workers/${workerName}/status.json\`
7. Wait for the next instruction from the lead

## Scope Rules
- Only edit files described in your task descriptions
- Do NOT edit files that belong to other workers
- If you need to modify a shared/common file, write \`{"state": "blocked", "reason": "need to edit shared file X"}\` to your status file and wait
`;
}

/**
 * Generate inbox content for a follow-up task assignment.
 */
export function generateTaskAssignmentInbox(
  workerName: string,
  teamName: string,
  taskId: string,
  taskDescription: string,
): string {
  return `# New Task Assignment

**Worker:** ${workerName}
**Task ID:** ${taskId}

## Task Description

${taskDescription}

## Instructions

1. Read the task file at \`.omx/state/team/${teamName}/tasks/task-${taskId}.json\`
2. Write \`{"status": "in_progress"}\` to claim it
3. Complete the work
4. Write \`{"status": "completed", "result": "brief summary"}\` when done
5. Write \`{"state": "idle"}\` to your status file
`;
}

/**
 * Generate inbox content for shutdown.
 */
export function generateShutdownInbox(): string {
  return `# Shutdown Request

All tasks are complete. Please wrap up any remaining work and exit your session.

Type \`exit\` or press Ctrl+C to end your Codex session.
`;
}

/**
 * Generate the SHORT send-keys trigger message.
 * Always < 200 characters, ASCII-safe.
 */
export function generateTriggerMessage(workerName: string, teamName: string): string {
  return `Read and follow the instructions in .omx/state/team/${teamName}/workers/${workerName}/inbox.md`;
}
