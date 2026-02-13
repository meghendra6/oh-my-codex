import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  ABSOLUTE_MAX_WORKERS,
  DEFAULT_MAX_WORKERS,
  cleanupTeamState,
  createTask,
  getTeamSummary,
  initTeamState,
  listTasks,
  readTask,
  readWorkerHeartbeat,
  readWorkerStatus,
  updateTask,
  updateWorkerHeartbeat,
  writeAtomic,
  writeWorkerInbox,
} from '../state.js';

describe('team state', () => {
  it('initTeamState creates correct directory structure and config.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const cfg = await initTeamState('team-1', 'do stuff', 'executor', 2, cwd);

      const root = join(cwd, '.omx', 'state', 'team', 'team-1');
      assert.equal(existsSync(root), true);
      assert.equal(existsSync(join(root, 'workers')), true);
      assert.equal(existsSync(join(root, 'workers', 'worker-1')), true);
      assert.equal(existsSync(join(root, 'workers', 'worker-2')), true);
      assert.equal(existsSync(join(root, 'tasks')), true);

      const configPath = join(root, 'config.json');
      assert.equal(existsSync(configPath), true);
      const diskCfg = JSON.parse(readFileSync(configPath, 'utf8')) as unknown as { [key: string]: unknown };

      assert.equal(cfg.name, 'team-1');
      assert.equal(diskCfg.name, 'team-1');
      assert.equal(diskCfg.task, 'do stuff');
      assert.equal(diskCfg.agent_type, 'executor');
      assert.equal(diskCfg.worker_count, 2);
      assert.equal(diskCfg.max_workers, DEFAULT_MAX_WORKERS);
      assert.equal(diskCfg.tmux_session, 'omx-team-team-1');
      assert.equal(typeof diskCfg.next_task_id, 'number');
      assert.ok(Array.isArray(diskCfg.workers));
      assert.equal(diskCfg.workers.length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState rejects workerCount > max_workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('team-2', 't', 'executor', DEFAULT_MAX_WORKERS + 1, cwd, DEFAULT_MAX_WORKERS),
        /exceeds maxWorkers/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('initTeamState rejects maxWorkers > ABSOLUTE_MAX_WORKERS', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('team-abs', 't', 'executor', 1, cwd, ABSOLUTE_MAX_WORKERS + 1),
        /exceeds ABSOLUTE_MAX_WORKERS/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createTask auto-increments IDs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-3', 't', 'executor', 1, cwd);
      const t1 = await createTask(
        'team-3',
        { subject: 'a', description: 'd', status: 'pending' },
        cwd
      );
      const t2 = await createTask(
        'team-3',
        { subject: 'b', description: 'd', status: 'pending' },
        cwd
      );

      assert.equal(t1.id, '1');
      assert.equal(t2.id, '2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('listTasks returns sorted by ID', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-4', 't', 'executor', 1, cwd);
      await createTask('team-4', { subject: 'a', description: 'd', status: 'pending' }, cwd);
      await createTask('team-4', { subject: 'b', description: 'd', status: 'pending' }, cwd);
      await createTask('team-4', { subject: 'c', description: 'd', status: 'pending' }, cwd);

      const tasks = await listTasks('team-4', cwd);
      assert.deepEqual(
        tasks.map((t) => t.id),
        ['1', '2', '3']
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTask returns null for non-existent task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-5', 't', 'executor', 1, cwd);
      const task = await readTask('team-5', '999', cwd);
      assert.equal(task, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTask returns null for malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-6', 't', 'executor', 1, cwd);
      const badPath = join(cwd, '.omx', 'state', 'team', 'team-6', 'tasks', 'task-1.json');
      await writeFile(badPath, '{not json', 'utf8');
      const task = await readTask('team-6', '1', cwd);
      assert.equal(task, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('updateTask merges updates correctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-7', 't', 'executor', 1, cwd);
      const created = await createTask(
        'team-7',
        { subject: 's', description: 'd', status: 'pending', owner: undefined },
        cwd
      );

      const updated = await updateTask(
        'team-7',
        created.id,
        { status: 'completed', owner: 'worker-1', result: 'done', completed_at: new Date().toISOString() },
        cwd
      );

      assert.ok(updated);
      assert.equal(updated?.id, created.id);
      assert.equal(updated?.status, 'completed');
      assert.equal(updated?.owner, 'worker-1');
      assert.equal(updated?.result, 'done');

      const reread = await readTask('team-7', created.id, cwd);
      assert.equal(reread?.status, 'completed');
      assert.equal(reread?.owner, 'worker-1');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeAtomic creates file and is safe to call concurrently (basic)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      const p = join(cwd, 'atomic.txt');
      await Promise.all([writeAtomic(p, 'a'), writeAtomic(p, 'b')]);
      assert.equal(existsSync(p), true);
      const content = readFileSync(p, 'utf8');
      assert.ok(content === 'a' || content === 'b');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns {state:\'unknown\'} on missing file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-8', 't', 'executor', 1, cwd);
      const status = await readWorkerStatus('team-8', 'worker-1', cwd);
      assert.equal(status.state, 'unknown');
      assert.ok(!Number.isNaN(Date.parse(status.updated_at)));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerHeartbeat returns null on missing file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-9', 't', 'executor', 1, cwd);
      const hb = await readWorkerHeartbeat('team-9', 'worker-1', cwd);
      assert.equal(hb, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writeWorkerInbox writes content to the correct path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-10', 't', 'executor', 1, cwd);
      await writeWorkerInbox('team-10', 'worker-1', 'hello worker', cwd);

      const inboxPath = join(cwd, '.omx', 'state', 'team', 'team-10', 'workers', 'worker-1', 'inbox.md');
      assert.equal(existsSync(inboxPath), true);
      assert.equal(readFileSync(inboxPath, 'utf8'), 'hello worker');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('getTeamSummary aggregates task counts correctly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-11', 't', 'executor', 2, cwd);
      const t1 = await createTask('team-11', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      await createTask('team-11', { subject: 'ip', description: 'd', status: 'in_progress' }, cwd);
      await createTask('team-11', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-11', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      // Simulate a worker who is turning without progress on task 1.
      await updateWorkerHeartbeat(
        'team-11',
        'worker-1',
        { pid: 123, last_turn_at: new Date().toISOString(), turn_count: 6, alive: true },
        cwd
      );
      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-11',
        'workers',
        'worker-1',
        'status.json'
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t1.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        )
      );

      const summary = await getTeamSummary('team-11', cwd);
      assert.ok(summary);
      assert.equal(summary?.teamName, 'team-11');
      assert.equal(summary?.workerCount, 2);
      assert.deepEqual(summary?.tasks, {
        total: 4,
        pending: 1,
        in_progress: 1,
        completed: 1,
        failed: 1,
      });

      assert.ok(summary?.nonReportingWorkers.includes('worker-1'));
      const w1 = summary?.workers.find((w) => w.name === 'worker-1');
      assert.equal(w1?.alive, true);
      assert.equal(w1?.turnsWithoutProgress, 6);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cleanupTeamState removes the directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await initTeamState('team-12', 't', 'executor', 1, cwd);
      const root = join(cwd, '.omx', 'state', 'team', 'team-12');
      assert.equal(existsSync(root), true);
      await cleanupTeamState('team-12', cwd);
      assert.equal(existsSync(root), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('validateTeamName rejects invalid names (via initTeamState throwing)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-state-'));
    try {
      await assert.rejects(
        () => initTeamState('Bad Name', 't', 'executor', 1, cwd),
        /Invalid team name/
      );
      await assert.rejects(
        () => initTeamState('-bad', 't', 'executor', 1, cwd),
        /Invalid team name/
      );
      await assert.rejects(
        () => initTeamState('a'.repeat(31), 't', 'executor', 1, cwd),
        /Invalid team name/
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
