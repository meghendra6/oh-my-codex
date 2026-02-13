import { join } from 'path';
import { existsSync } from 'fs';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  createTeamSession,
  waitForWorkerReady,
  sendToWorker,
  isWorkerAlive,
  getWorkerPanePid,
  killWorker,
  destroyTeamSession,
  listTeamSessions,
  type TeamSession,
} from './tmux-session.js';
import {
  initTeamState,
  readTeamConfig,
  writeWorkerIdentity,
  readWorkerHeartbeat,
  readWorkerStatus,
  writeWorkerInbox,
  createTask as createStateTask,
  readTask,
  updateTask,
  listTasks,
  getTeamSummary,
  cleanupTeamState,
  type TeamConfig,
  type WorkerInfo,
  type WorkerHeartbeat,
  type WorkerStatus,
  type TeamTask,
  type TeamSummary,
} from './state.js';
import {
  generateWorkerOverlay,
  applyWorkerOverlay,
  stripWorkerOverlay,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
} from './worker-bootstrap.js';
import {
  type TeamPhase,
  type TerminalPhase,
  createTeamState as createOrchestratorState,
  transitionPhase,
  isTerminalPhase,
} from './orchestrator.js';

/** Snapshot of the team state at a point in time */
export interface TeamSnapshot {
  teamName: string;
  phase: TeamPhase | TerminalPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
}

/** Runtime handle returned by startTeam */
export interface TeamRuntime {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

/**
 * Start a new team: init state, create tmux session, bootstrap workers.
 */
export async function startTeam(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[] }>,
  cwd: string,
): Promise<TeamRuntime> {
  // 1. Check tmux
  if (!isTmuxAvailable()) {
    throw new Error('Team mode requires tmux. Install with: apt install tmux / brew install tmux');
  }

  // 2. Sanitize team name
  const sanitized = sanitizeTeamName(teamName);
  const sessionName = `omx-team-${sanitized}`;
  const agentsMdPath = join(cwd, 'AGENTS.md');
  const overlay = generateWorkerOverlay(sanitized);
  let overlayApplied = false;
  let sessionCreated = false;

  try {
    // 3. Init state directory + config
    const config = await initTeamState(sanitized, task, agentType, workerCount, cwd);

    // 4. Create tasks
    for (const t of tasks) {
      await createStateTask(sanitized, {
        subject: t.subject,
        description: t.description,
        status: 'pending',
        owner: t.owner,
        blocked_by: t.blocked_by,
      }, cwd);
    }

    // 5. Apply generic AGENTS.md overlay
    await applyWorkerOverlay(agentsMdPath, overlay);
    overlayApplied = true;

    // 6. Create tmux session with workers
    createTeamSession(sanitized, workerCount, cwd);
    sessionCreated = true;

    // 7. Wait for all workers to be ready, then bootstrap them
    const allTasks = await listTasks(sanitized, cwd);
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;

      // Get tasks assigned to this worker
      const workerTasks = allTasks.filter(t => t.owner === workerName);

      // Write worker identity
      const identity: WorkerInfo = {
        name: workerName,
        index: i,
        role: agentType,
        assigned_tasks: workerTasks.map(t => t.id),
      };

      // Get pane PID and store it
      const panePid = getWorkerPanePid(sessionName, i);
      if (panePid) identity.pid = panePid;

      await writeWorkerIdentity(sanitized, workerName, identity, cwd);

      // Wait for worker readiness
      const ready = waitForWorkerReady(sessionName, i);
      if (!ready) {
        throw new Error(`Worker ${workerName} did not become ready in tmux session ${sessionName}`);
      }

      // Write inbox and send trigger
      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks);
      await writeWorkerInbox(sanitized, workerName, inbox, cwd);

      const trigger = generateTriggerMessage(workerName, sanitized);
      sendToWorker(sessionName, i, trigger);
    }

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      config,
      cwd,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];

    if (sessionCreated) {
      try {
        destroyTeamSession(sessionName);
      } catch (cleanupError) {
        rollbackErrors.push(`destroyTeamSession: ${String(cleanupError)}`);
      }
    }

    if (overlayApplied) {
      try {
        await stripWorkerOverlay(agentsMdPath);
      } catch (cleanupError) {
        rollbackErrors.push(`stripWorkerOverlay: ${String(cleanupError)}`);
      }
    }

    try {
      await cleanupTeamState(sanitized, cwd);
    } catch (cleanupError) {
      rollbackErrors.push(`cleanupTeamState: ${String(cleanupError)}`);
    }

    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; rollback encountered errors: ${rollbackErrors.join(' | ')}`);
    }

    throw error;
  }
}

/**
 * Monitor team state by polling files. Returns a snapshot.
 */
export async function monitorTeam(teamName: string, cwd: string): Promise<TeamSnapshot | null> {
  const config = await readTeamConfig(teamName, cwd);
  if (!config) return null;

  const sessionName = config.tmux_session;
  const allTasks = await listTasks(teamName, cwd);

  const workers: TeamSnapshot['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  for (const w of config.workers) {
    const alive = isWorkerAlive(sessionName, w.index);
    const status = await readWorkerStatus(teamName, w.name, cwd);
    const heartbeat = await readWorkerHeartbeat(teamName, w.name, cwd);

    // Calculate turns without progress
    let turnsWithoutProgress = 0;
    if (heartbeat && status.state === 'working' && status.current_task_id) {
      const task = await readTask(teamName, status.current_task_id, cwd);
      if (task && task.status === 'in_progress') {
        // If heartbeat shows activity but task hasn't changed, count turns
        turnsWithoutProgress = heartbeat.turn_count; // simplified: would need previous snapshot to track delta
      }
    }

    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });

    if (!alive) {
      deadWorkers.push(w.name);
      // Find in-progress tasks owned by this dead worker
      const deadWorkerTasks = allTasks.filter(t => t.owner === w.name && t.status === 'in_progress');
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }

  // Count tasks
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    in_progress: allTasks.filter(t => t.status === 'in_progress').length,
    completed: allTasks.filter(t => t.status === 'completed').length,
    failed: allTasks.filter(t => t.status === 'failed').length,
  };

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.in_progress === 0;

  // Determine phase from state file (simplified -- read from mode state if available)
  // For now use a heuristic based on task statuses
  let phase: TeamPhase | TerminalPhase = 'team-exec';
  if (allTasksTerminal && taskCounts.failed === 0) phase = 'complete';
  else if (allTasksTerminal && taskCounts.failed > 0) phase = 'team-fix';

  return {
    teamName,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
  };
}

/**
 * Assign a task to a worker by writing inbox and sending trigger.
 */
export async function assignTask(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const task = await readTask(teamName, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Update task owner
  await updateTask(teamName, taskId, { owner: workerName }, cwd);

  // Write inbox
  const inbox = generateTaskAssignmentInbox(workerName, teamName, taskId, task.description);
  await writeWorkerInbox(teamName, workerName, inbox, cwd);

  // Send trigger
  const config = await readTeamConfig(teamName, cwd);
  if (!config) throw new Error(`Team ${teamName} not found`);

  const workerInfo = config.workers.find(w => w.name === workerName);
  if (!workerInfo) throw new Error(`Worker ${workerName} not found in team`);

  const trigger = generateTriggerMessage(workerName, teamName);
  sendToWorker(config.tmux_session, workerInfo.index, trigger);
}

/**
 * Reassign a task from one worker to another.
 */
export async function reassignTask(
  teamName: string,
  taskId: string,
  _fromWorker: string,
  toWorker: string,
  cwd: string,
): Promise<void> {
  await assignTask(teamName, toWorker, taskId, cwd);
}

/**
 * Graceful shutdown: send shutdown inbox to all workers, wait, force kill, cleanup.
 */
export async function shutdownTeam(teamName: string, cwd: string): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  if (!config) {
    // No config -- just try to kill tmux session and clean up
    try { destroyTeamSession(`omx-team-${teamName}`); } catch { /* ignore */ }
    await cleanupTeamState(teamName, cwd);
    return;
  }

  const sessionName = config.tmux_session;

  // 1. Send shutdown inbox to each worker
  const shutdownContent = generateShutdownInbox();
  for (const w of config.workers) {
    try {
      await writeWorkerInbox(teamName, w.name, shutdownContent, cwd);
      const trigger = generateTriggerMessage(w.name, teamName);
      sendToWorker(sessionName, w.index, trigger);
    } catch { /* worker might already be dead */ }
  }

  // 2. Wait up to 15s for workers to exit
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const anyAlive = config.workers.some(w => isWorkerAlive(sessionName, w.index));
    if (!anyAlive) break;
    // Sleep 2s
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 3. Force kill remaining workers
  for (const w of config.workers) {
    try {
      if (isWorkerAlive(sessionName, w.index)) {
        killWorker(sessionName, w.index);
      }
    } catch { /* ignore */ }
  }

  // 4. Destroy tmux session
  try { destroyTeamSession(sessionName); } catch { /* ignore */ }

  // 5. Strip AGENTS.md overlay
  const agentsMdPath = join(cwd, 'AGENTS.md');
  try { await stripWorkerOverlay(agentsMdPath); } catch { /* ignore */ }

  // 6. Cleanup state
  await cleanupTeamState(teamName, cwd);
}

/**
 * Resume monitoring an existing team.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const config = await readTeamConfig(teamName, cwd);
  if (!config) return null;

  // Check if tmux session still exists
  const sessions = listTeamSessions();
  if (!sessions.includes(config.tmux_session)) return null;

  return {
    teamName,
    sanitizedName: teamName,
    sessionName: config.tmux_session,
    config,
    cwd,
  };
}
