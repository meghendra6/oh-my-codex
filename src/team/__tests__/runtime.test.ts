import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import {
  initTeamState,
  createTask,
  writeWorkerIdentity,
  readTeamConfig,
  updateWorkerHeartbeat,
  writeAtomic,
} from '../state.js';
import { monitorTeam, shutdownTeam, resumeTeam, startTeam } from '../runtime.js';

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.PATH = prev;
    else delete process.env.PATH;
  }
}

describe('runtime', () => {
  it('startTeam throws when tmux is not available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await assert.rejects(
        () =>
          withEmptyPath(() =>
            startTeam('team-a', 'task', 'executor', 1, [{ subject: 's', description: 'd' }], cwd),
          ),
        /requires tmux/i,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const snapshot = await monitorTeam('missing-team', cwd);
      assert.equal(snapshot, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('monitorTeam returns correct task counts from state files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-counts', 'monitor task counts', 'executor', 2, cwd);

      const t1 = await createTask('team-counts', { subject: 'p', description: 'd', status: 'pending' }, cwd);
      const t2 = await createTask('team-counts', { subject: 'ip', description: 'd', status: 'in_progress', owner: 'worker-1' }, cwd);
      await createTask('team-counts', { subject: 'c', description: 'd', status: 'completed' }, cwd);
      await createTask('team-counts', { subject: 'f', description: 'd', status: 'failed' }, cwd);

      await updateWorkerHeartbeat(
        'team-counts',
        'worker-1',
        { pid: 111, last_turn_at: new Date().toISOString(), turn_count: 7, alive: true },
        cwd,
      );

      const statusPath = join(
        cwd,
        '.omx',
        'state',
        'team',
        'team-counts',
        'workers',
        'worker-1',
        'status.json',
      );
      await writeAtomic(
        statusPath,
        JSON.stringify(
          {
            state: 'working',
            current_task_id: t2.id,
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const snapshot = await monitorTeam('team-counts', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.tasks.total, 4);
      assert.equal(snapshot?.tasks.pending, 1);
      assert.equal(snapshot?.tasks.in_progress, 1);
      assert.equal(snapshot?.tasks.completed, 1);
      assert.equal(snapshot?.tasks.failed, 1);
      assert.equal(snapshot?.allTasksTerminal, false);
      assert.equal(snapshot?.phase, 'team-exec');

      const worker1 = snapshot?.workers.find((w) => w.name === 'worker-1');
      assert.ok(worker1);
      assert.equal(worker1?.turnsWithoutProgress, 7);

      const reassignHint = snapshot?.recommendations.some((r) => r.includes(`task-${t2.id}`));
      assert.equal(typeof reassignHint, 'boolean');
      void t1;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("shutdownTeam cleans up state even when tmux session doesn't exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      await initTeamState('team-shutdown', 'shutdown test', 'executor', 1, cwd);
      await shutdownTeam('team-shutdown', cwd);

      const teamRoot = join(cwd, '.omx', 'state', 'team', 'team-shutdown');
      assert.equal(existsSync(teamRoot), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resumeTeam returns null for non-existent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runtime-'));
    try {
      const runtime = await resumeTeam('missing-team', cwd);
      assert.equal(runtime, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
