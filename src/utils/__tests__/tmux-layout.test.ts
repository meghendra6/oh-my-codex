import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDetachedSessionSize,
  resolveHudPaneLines,
  resolveTeamMainPaneWidthCells,
  resolveTeamMainPaneWidthPercent,
} from '../tmux-layout.js';

describe('resolveHudPaneLines', () => {
  it('uses default when unset/invalid', () => {
    assert.equal(resolveHudPaneLines({}), '4');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '' }), '4');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '-1' }), '4');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: 'abc' }), '4');
  });

  it('clamps to 1..12', () => {
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '1' }), '1');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '12' }), '12');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '99' }), '12');
    assert.equal(resolveHudPaneLines({ OMX_HUD_PANE_LINES: '0' }), '1');
  });
});

describe('resolveTeamMainPaneWidthPercent', () => {
  it('uses default when unset/invalid', () => {
    assert.equal(resolveTeamMainPaneWidthPercent({}), '50%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '' }), '50%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '-1' }), '50%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: 'abc' }), '50%');
  });

  it('clamps to 35..75', () => {
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '35' }), '35%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '75' }), '75%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '10' }), '35%');
    assert.equal(resolveTeamMainPaneWidthPercent({ OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '99' }), '75%');
  });
});

describe('resolveTeamMainPaneWidthCells', () => {
  it('returns half width when width is valid', () => {
    assert.equal(resolveTeamMainPaneWidthCells(120, {}), '60');
  });

  it('returns null when width is too small/invalid', () => {
    assert.equal(resolveTeamMainPaneWidthCells(39, {}), null);
    assert.equal(resolveTeamMainPaneWidthCells(Number.NaN, {}), null);
  });

  it('uses configured percent when provided', () => {
    assert.equal(resolveTeamMainPaneWidthCells(100, { OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '70' }), '70');
  });

  it('enforces minimum fallback cells to keep leader pane usable', () => {
    assert.equal(resolveTeamMainPaneWidthCells(40, { OMX_TEAM_MAIN_PANE_WIDTH_PERCENT: '35' }), '20');
  });
});

describe('resolveDetachedSessionSize', () => {
  it('returns size only when TMUX_COLUMNS/TMUX_LINES are valid and large enough', () => {
    assert.deepEqual(resolveDetachedSessionSize({ TMUX_COLUMNS: '120', TMUX_LINES: '40' }), { cols: '120', rows: '40' });
    assert.equal(resolveDetachedSessionSize({ TMUX_COLUMNS: '39', TMUX_LINES: '40' }), null);
    assert.equal(resolveDetachedSessionSize({ TMUX_COLUMNS: '120', TMUX_LINES: '9' }), null);
    assert.equal(resolveDetachedSessionSize({ TMUX_COLUMNS: 'abc', TMUX_LINES: '40' }), null);
    assert.equal(resolveDetachedSessionSize({ TMUX_COLUMNS: '120' }), null);
  });

  it('falls back to COLUMNS/LINES when TMUX_* are absent', () => {
    assert.deepEqual(resolveDetachedSessionSize({ COLUMNS: '100', LINES: '30' }), { cols: '100', rows: '30' });
  });

  it('prefers TMUX_* over COLUMNS/LINES when both are present', () => {
    assert.deepEqual(
      resolveDetachedSessionSize({ TMUX_COLUMNS: '120', TMUX_LINES: '40', COLUMNS: '90', LINES: '20' }),
      { cols: '120', rows: '40' },
    );
  });
});
