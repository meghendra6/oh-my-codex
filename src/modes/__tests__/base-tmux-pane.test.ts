import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMode } from '../base.js';

describe('modes/base tmux pane capture', () => {
  it('captures tmux_pane_id in mode state on startMode()', async () => {
    const prev = process.env.TMUX_PANE;
    process.env.TMUX_PANE = '%123';
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-pane-'));
    try {
      await startMode('ralph', 'test', 1, wd);
      const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralph-state.json'), 'utf-8'));
      assert.equal(raw.tmux_pane_id, '%123');
      assert.ok(typeof raw.tmux_pane_set_at === 'string' && raw.tmux_pane_set_at.length > 0);
    } finally {
      if (typeof prev === 'string') process.env.TMUX_PANE = prev;
      else delete process.env.TMUX_PANE;
      await rm(wd, { recursive: true, force: true });
    }
  });
});

