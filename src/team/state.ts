import { readFile, writeFile, mkdir, rm, rename, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { omxStateDir } from '../utils/paths.js';

export interface TeamConfig {
  name: string;
  task: string;
  agent_type: string;
  worker_count: number;
  max_workers: number; // default 6, configurable up to 20
  workers: WorkerInfo[];
  created_at: string;
  tmux_session: string; // "omx-team-{name}"
  next_task_id: number;
}

export interface WorkerInfo {
  name: string; // "worker-1"
  index: number; // tmux window index (1-based)
  role: string; // agent type
  assigned_tasks: string[]; // task IDs
  pid?: number;
}

export interface WorkerHeartbeat {
  pid: number;
  last_turn_at: string;
  turn_count: number;
  alive: boolean;
}

export interface WorkerStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown';
  current_task_id?: string;
  reason?: string;
  updated_at: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  owner?: string; // worker name
  result?: string; // completion summary
  error?: string; // failure reason
  blocked_by?: string[]; // task IDs
  created_at: string;
  completed_at?: string;
}

export interface TeamSummary {
  teamName: string;
  workerCount: number;
  tasks: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  workers: Array<{ name: string; alive: boolean; lastTurnAt: string | null; turnsWithoutProgress: number }>;
  nonReportingWorkers: string[];
}

export const DEFAULT_MAX_WORKERS = 6;
export const ABSOLUTE_MAX_WORKERS = 20;

// Team state directory: .omx/state/team/{teamName}/
function teamDir(teamName: string, cwd: string): string {
  return join(omxStateDir(cwd), 'team', teamName);
}

// Validate team name: alphanumeric + hyphens only, max 30 chars
function validateTeamName(name: string): void {
  const re = /^[a-z0-9][a-z0-9-]{0,29}$/;
  if (!re.test(name)) {
    throw new Error(
      `Invalid team name: "${name}". Team name must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).`
    );
  }
}

function isWorkerHeartbeat(value: unknown): value is WorkerHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.last_turn_at === 'string' &&
    typeof v.turn_count === 'number' &&
    typeof v.alive === 'boolean'
  );
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const state = v.state;
  const allowed = ['idle', 'working', 'blocked', 'done', 'failed', 'unknown'];
  if (typeof state !== 'string' || !allowed.includes(state)) return false;
  return typeof v.updated_at === 'string';
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const allowed = ['pending', 'in_progress', 'completed', 'failed'];
  if (typeof v.id !== 'string') return false;
  if (typeof v.subject !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  if (typeof v.status !== 'string' || !allowed.includes(v.status)) return false;
  if (typeof v.created_at !== 'string') return false;
  return true;
}

// Atomic write: write to {path}.tmp.{pid}, then rename
export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf8');

  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' && existsSync(filePath)) {
      return;
    }
    throw error;
  }
}

// Initialize team state directory + config.json
// Creates: .omx/state/team/{name}/, workers/{worker-1}..{worker-N}/, tasks/
// Throws if workerCount > maxWorkers (default 6)
export async function initTeamState(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  cwd: string,
  maxWorkers: number = DEFAULT_MAX_WORKERS
): Promise<TeamConfig> {
  validateTeamName(teamName);

  if (maxWorkers > ABSOLUTE_MAX_WORKERS) {
    throw new Error(`maxWorkers (${maxWorkers}) exceeds ABSOLUTE_MAX_WORKERS (${ABSOLUTE_MAX_WORKERS})`);
  }

  if (workerCount > maxWorkers) {
    throw new Error(`workerCount (${workerCount}) exceeds maxWorkers (${maxWorkers})`);
  }

  const root = teamDir(teamName, cwd);
  const workersRoot = join(root, 'workers');
  const tasksRoot = join(root, 'tasks');

  await mkdir(workersRoot, { recursive: true });
  await mkdir(tasksRoot, { recursive: true });

  const workers: WorkerInfo[] = [];
  for (let i = 1; i <= workerCount; i++) {
    const name = `worker-${i}`;
    const worker: WorkerInfo = { name, index: i, role: agentType, assigned_tasks: [] };
    workers.push(worker);
    await mkdir(join(workersRoot, name), { recursive: true });
  }

  const config: TeamConfig = {
    name: teamName,
    task,
    agent_type: agentType,
    worker_count: workerCount,
    max_workers: maxWorkers,
    workers,
    created_at: new Date().toISOString(),
    tmux_session: `omx-team-${teamName}`,
    next_task_id: 1,
  };

  await writeAtomic(join(root, 'config.json'), JSON.stringify(config, null, 2));
  return config;
}

async function writeConfig(cfg: TeamConfig, cwd: string): Promise<void> {
  const p = join(teamDir(cfg.name, cwd), 'config.json');
  await writeAtomic(p, JSON.stringify(cfg, null, 2));
}

function normalizeNextTaskId(raw: unknown): number {
  const asNum = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(asNum)) return 1;
  const floored = Math.floor(asNum);
  return Math.max(1, floored);
}

// Read team config
export async function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  try {
    const p = join(teamDir(teamName, cwd), 'config.json');
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as TeamConfig;
  } catch {
    return null;
  }
}

// Write worker identity file
export async function writeWorkerIdentity(
  teamName: string,
  workerName: string,
  identity: WorkerInfo,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'identity.json');
  await writeAtomic(p, JSON.stringify(identity, null, 2));
}

// Read worker heartbeat (returns null on missing/malformed)
export async function readWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string
): Promise<WorkerHeartbeat | null> {
  try {
    const p = join(teamDir(teamName, cwd), 'workers', workerName, 'heartbeat.json');
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isWorkerHeartbeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Atomic write worker heartbeat
export async function updateWorkerHeartbeat(
  teamName: string,
  workerName: string,
  heartbeat: WorkerHeartbeat,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'heartbeat.json');
  await writeAtomic(p, JSON.stringify(heartbeat, null, 2));
}

// Read worker status (returns {state:'unknown'} on missing/malformed)
export async function readWorkerStatus(teamName: string, workerName: string, cwd: string): Promise<WorkerStatus> {
  try {
    const p = join(teamDir(teamName, cwd), 'workers', workerName, 'status.json');
    if (!existsSync(p)) {
      return { state: 'unknown', updated_at: new Date().toISOString() };
    }
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isWorkerStatus(parsed)) {
      return { state: 'unknown', updated_at: new Date().toISOString() };
    }
    return parsed;
  } catch {
    return { state: 'unknown', updated_at: new Date().toISOString() };
  }
}

// Write prompt to worker's inbox.md (atomic)
export async function writeWorkerInbox(
  teamName: string,
  workerName: string,
  prompt: string,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'inbox.md');
  await writeAtomic(p, prompt);
}

function taskFilePath(teamName: string, taskId: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'tasks', `task-${taskId}.json`);
}

async function withTeamLock<T>(teamName: string, cwd: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDir(teamName, cwd), '.lock.create-task');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring team task lock for ${teamName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// Create a task (auto-increment ID)
export async function createTask(
  teamName: string,
  task: Omit<TeamTask, 'id' | 'created_at'>,
  cwd: string
): Promise<TeamTask> {
  return withTeamLock(teamName, cwd, async () => {
    const cfg = await readTeamConfig(teamName, cwd);
    if (!cfg) throw new Error(`Team ${teamName} not found`);

    const nextNumeric = normalizeNextTaskId(cfg.next_task_id);
    const nextId = String(nextNumeric);

    const created: TeamTask = {
      ...task,
      id: nextId,
      created_at: new Date().toISOString(),
    };

    await writeAtomic(taskFilePath(teamName, nextId, cwd), JSON.stringify(created, null, 2));

    // Advance counter after the task is safely persisted.
    cfg.next_task_id = nextNumeric + 1;
    await writeConfig(cfg, cwd);
    return created;
  });
}

// Read a task (returns null on missing/malformed)
export async function readTask(teamName: string, taskId: string, cwd: string): Promise<TeamTask | null> {
  try {
    const p = taskFilePath(teamName, taskId, cwd);
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isTeamTask(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Update a task (merge updates, atomic write)
export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<TeamTask>,
  cwd: string
): Promise<TeamTask | null> {
  const existing = await readTask(teamName, taskId, cwd);
  if (!existing) return null;

  if (updates.status && !['pending', 'in_progress', 'completed', 'failed'].includes(updates.status)) {
    throw new Error(`Invalid task status: ${updates.status}`);
  }

  const merged: TeamTask = {
    ...existing,
    ...updates,
    id: existing.id,
    created_at: existing.created_at,
  };

  await writeAtomic(taskFilePath(teamName, taskId, cwd), JSON.stringify(merged, null, 2));
  return merged;
}

// List all tasks sorted by numeric ID
export async function listTasks(teamName: string, cwd: string): Promise<TeamTask[]> {
  const tasksRoot = join(teamDir(teamName, cwd), 'tasks');
  if (!existsSync(tasksRoot)) return [];

  const files = await readdir(tasksRoot);
  const tasks: TeamTask[] = [];

  for (const f of files) {
    const m = /^task-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const t = await readTask(teamName, m[1], cwd);
    if (t) tasks.push(t);
  }

  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  return tasks;
}

// Get team summary with aggregation and non-reporting worker detection
export async function getTeamSummary(teamName: string, cwd: string): Promise<TeamSummary | null> {
  const cfg = await readTeamConfig(teamName, cwd);
  if (!cfg) return null;

  const tasks = await listTasks(teamName, cwd);
  const counts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  };

  for (const t of tasks) {
    if (t.status === 'pending') counts.pending++;
    else if (t.status === 'in_progress') counts.in_progress++;
    else if (t.status === 'completed') counts.completed++;
    else if (t.status === 'failed') counts.failed++;
  }

  const workers = cfg.workers || [];
  const workerSummaries: TeamSummary['workers'] = [];
  const nonReportingWorkers: string[] = [];

  for (const w of workers) {
    const hb = await readWorkerHeartbeat(teamName, w.name, cwd);
    const status = await readWorkerStatus(teamName, w.name, cwd);

    const alive = hb?.alive ?? false;
    const lastTurnAt = hb?.last_turn_at ?? null;

    const currentTaskId = status.current_task_id;
    const currentTask = currentTaskId ? await readTask(teamName, currentTaskId, cwd) : null;

    const turnsWithoutProgress =
      hb && currentTask && (currentTask.status === 'pending' || currentTask.status === 'in_progress')
        ? hb.turn_count
        : 0;

    if (status.state === 'working' && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
    }

    workerSummaries.push({ name: w.name, alive, lastTurnAt, turnsWithoutProgress });
  }

  return {
    teamName: cfg.name,
    workerCount: cfg.worker_count,
    tasks: counts,
    workers: workerSummaries,
    nonReportingWorkers,
  };
}

// Delete team state directory
export async function cleanupTeamState(teamName: string, cwd: string): Promise<void> {
  await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}
