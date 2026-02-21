import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCodexLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxSessionName,
  launchOutsideTmuxSession,
  resolveCliInvocation,
  resolveCodexLaunchPolicy,
  parseTmuxPaneSnapshot,
  findHudWatchPaneIds,
  buildHudPaneCleanupTargets,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
  collectInheritableTeamWorkerArgs,
  resolveTeamWorkerLaunchArgsEnv,
  injectModelInstructionsBypassArgs,
} from '../index.js';
import { resolveHudPaneLines } from '../../utils/tmux-layout.js';

describe('normalizeCodexLaunchArgs', () => {
  it('maps --madmax to codex bypass flag', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--madmax']),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('does not forward --madmax and preserves other args', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--model', 'gpt-5', '--madmax', '--yolo']),
      ['--model', 'gpt-5', '--yolo', '--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('avoids duplicate bypass flags when both are present', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '--madmax',
      ]),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('deduplicates repeated bypass-related flags', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        '--madmax',
        '--dangerously-bypass-approvals-and-sandbox',
        '--madmax',
        '--dangerously-bypass-approvals-and-sandbox',
      ]),
      ['--dangerously-bypass-approvals-and-sandbox']
    );
  });

  it('leaves unrelated args unchanged', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--model', 'gpt-5', '--yolo']),
      ['--model', 'gpt-5', '--yolo']
    );
  });

  it('maps --high to reasoning override', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--high']),
      ['-c', 'model_reasoning_effort="high"']
    );
  });

  it('maps --xhigh to reasoning override', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--xhigh']),
      ['-c', 'model_reasoning_effort="xhigh"']
    );
  });

  it('uses the last reasoning shorthand when both are present', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--high', '--xhigh']),
      ['-c', 'model_reasoning_effort="xhigh"']
    );
  });

  it('maps --xhigh --madmax to codex-native flags only', () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(['--xhigh', '--madmax']),
      ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"']
    );
  });
});

describe('resolveCliInvocation', () => {
  it('resolves hooks to hooks command', () => {
    assert.deepEqual(resolveCliInvocation(['hooks']), {
      command: 'hooks',
      launchArgs: [],
    });
  });

  it('resolves --help to the help command instead of launch', () => {
    assert.deepEqual(resolveCliInvocation(['--help']), {
      command: 'help',
      launchArgs: [],
    });
  });

  it('keeps unknown long flags as launch passthrough args', () => {
    assert.deepEqual(resolveCliInvocation(['--model', 'gpt-5']), {
      command: 'launch',
      launchArgs: ['--model', 'gpt-5'],
    });
  });
});

describe('resolveCodexLaunchPolicy', () => {
  it('launches directly when outside tmux', () => {
    assert.equal(resolveCodexLaunchPolicy({}), 'direct');
  });

  it('uses tmux-aware launch path when already inside tmux', () => {
    assert.equal(resolveCodexLaunchPolicy({ TMUX: '/tmp/tmux-1000/default,123,0' }), 'inside-tmux');
  });
});

describe('launchOutsideTmuxSession', () => {
  it('falls back when new-session fails', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execTmux = ((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      throw new Error('new-session failed');
    }) as unknown as typeof import('child_process').execFileSync;

    assert.equal(launchOutsideTmuxSession({
      cwd: '/tmp/project',
      sessionName: 'omx-session',
      codexCmd: "'codex'",
      hudCmd: "'hud'",
      workerLaunchArgs: null,
    }, execTmux), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], 'new-session');
  });

  it('continues to attach when split/select fail and uses explicit targets', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (msg?: unknown) => { warnings.push(String(msg)); };
    try {
      const execTmux = ((file: string, args: readonly string[]) => {
        calls.push({ file, args });
        if (args[0] === 'new-session') return '%1\n';
        if (args[0] === 'split-window') throw new Error('split failed');
        if (args[0] === 'select-pane') throw new Error('select failed');
        return Buffer.from('');
      }) as unknown as typeof import('child_process').execFileSync;

      assert.equal(launchOutsideTmuxSession({
        cwd: '/tmp/project',
        sessionName: 'omx-session',
        codexCmd: "'codex'",
        hudCmd: "'hud'",
        workerLaunchArgs: null,
      }, execTmux), true);
    } finally {
      console.error = originalError;
    }

    const split = calls.find((c) => c.args[0] === 'split-window');
    const select = calls.find((c) => c.args[0] === 'select-pane');
    const attach = calls.find((c) => c.args[0] === 'attach-session');
    assert.ok(split);
    assert.ok(select);
    assert.ok(attach);
    assert.ok(split?.args.includes('-t'));
    assert.ok(split?.args.includes('%1'));
    assert.ok(select?.args.includes('%1'));
    assert.ok(warnings.some((w) => w.startsWith('[omx] warning: failed to create HUD pane in tmux; continuing without HUD.')));
    assert.ok(warnings.some((w) => w.startsWith('[omx] warning: failed to focus leader pane; continuing.')));
  });

  it('falls back when attach-session fails', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execTmux = ((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      if (args[0] === 'new-session') return '%1\n';
      if (args[0] === 'attach-session') throw new Error('attach failed');
      return Buffer.from('');
    }) as unknown as typeof import('child_process').execFileSync;

    assert.equal(launchOutsideTmuxSession({
      cwd: '/tmp/project',
      sessionName: 'omx-session',
      codexCmd: "'codex'",
      hudCmd: "'hud'",
      workerLaunchArgs: null,
    }, execTmux), false);
    assert.ok(calls.some((c) => c.args[0] === 'attach-session'));
    assert.ok(calls.some((c) => c.args[0] === 'kill-session'));
  });

  it('uses shared HUD pane resolver for split height', () => {
    const calls: Array<readonly string[]> = [];
    const prev = process.env.OMX_HUD_PANE_LINES;
    process.env.OMX_HUD_PANE_LINES = '9';
    try {
      const execTmux = ((_file: string, args: readonly string[]) => {
        calls.push(args);
        if (args[0] === 'new-session') return '%1\n';
        return Buffer.from('');
      }) as unknown as typeof import('child_process').execFileSync;

      launchOutsideTmuxSession({
        cwd: '/tmp/project',
        sessionName: 'omx-session',
        codexCmd: "'codex'",
        hudCmd: "'hud'",
        workerLaunchArgs: null,
      }, execTmux);
    } finally {
      if (typeof prev === 'string') process.env.OMX_HUD_PANE_LINES = prev;
      else delete process.env.OMX_HUD_PANE_LINES;
    }

    const split = calls.find((args) => args[0] === 'split-window');
    assert.ok(split);
    const lineIndex = split?.indexOf('-l') ?? -1;
    assert.notEqual(lineIndex, -1);
    assert.equal(split?.[lineIndex + 1], resolveHudPaneLines({ OMX_HUD_PANE_LINES: '9' }));
  });

  it('uses COLUMNS/LINES derived size flags for detached session', () => {
    const calls: Array<readonly string[]> = [];
    const prevColumns = process.env.COLUMNS;
    const prevLines = process.env.LINES;
    process.env.COLUMNS = '120';
    process.env.LINES = '40';
    try {
      const execTmux = ((_file: string, args: readonly string[]) => {
        calls.push(args);
        if (args[0] === 'new-session') return '%1\n';
        return Buffer.from('');
      }) as unknown as typeof import('child_process').execFileSync;

      launchOutsideTmuxSession({
        cwd: '/tmp/project',
        sessionName: 'omx-session',
        codexCmd: "'codex'",
        hudCmd: "'hud'",
        workerLaunchArgs: null,
      }, execTmux);
    } finally {
      if (typeof prevColumns === 'string') process.env.COLUMNS = prevColumns;
      else delete process.env.COLUMNS;
      if (typeof prevLines === 'string') process.env.LINES = prevLines;
      else delete process.env.LINES;
    }

    const newSession = calls.find((args) => args[0] === 'new-session');
    assert.ok(newSession);
    assert.ok(newSession?.includes('-x'));
    assert.ok(newSession?.includes('120'));
    assert.ok(newSession?.includes('-y'));
    assert.ok(newSession?.includes('40'));
  });
});

describe('tmux HUD pane helpers', () => {
  it('findHudWatchPaneIds detects stale HUD watch panes and excludes current pane', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tzsh\tzsh',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
        '%3\tnode\tnode /tmp/bin/omx.js hud --watch',
        '%4\tcodex\tcodex --model gpt-5',
      ].join('\n')
    );
    assert.deepEqual(findHudWatchPaneIds(panes, '%2'), ['%3']);
  });

  it('buildHudPaneCleanupTargets de-dupes pane ids and includes created pane', () => {
    assert.deepEqual(buildHudPaneCleanupTargets(['%3', '%3', 'invalid'], '%4'), ['%3', '%4']);
  });

  it('buildHudPaneCleanupTargets excludes leader pane from existing ids', () => {
    // %5 is the leader pane — it must not be included even if findHudWatchPaneIds let it through.
    assert.deepEqual(buildHudPaneCleanupTargets(['%3', '%5'], '%4', '%5'), ['%3', '%4']);
  });

  it('buildHudPaneCleanupTargets excludes leader pane even when it matches the created HUD pane id', () => {
    // Defensive edge case: if createHudWatchPane somehow returned the leader pane id, guard protects it.
    assert.deepEqual(buildHudPaneCleanupTargets(['%3'], '%5', '%5'), ['%3']);
  });

  it('buildHudPaneCleanupTargets is a no-op guard when leaderPaneId is absent', () => {
    assert.deepEqual(buildHudPaneCleanupTargets(['%3'], '%4'), ['%3', '%4']);
  });
});

describe('buildTmuxShellCommand', () => {
  it('preserves quoted config values for tmux shell-command execution', () => {
    assert.equal(
      buildTmuxShellCommand('codex', ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"']),
      `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model_reasoning_effort="xhigh"'`
    );
  });
});

describe('buildTmuxSessionName', () => {
  it('uses omx-directory-branch-session format', () => {
    const name = buildTmuxSessionName('/tmp/My Repo', 'omx-1770992424158-abc123');
    assert.match(name, /^omx-my-repo-[a-z0-9-]+-1770992424158-abc123$/);
  });

  it('sanitizes invalid characters', () => {
    const name = buildTmuxSessionName('/tmp/@#$', 'omx-+++');
    assert.match(name, /^omx-(unknown|[a-z0-9-]+)-[a-z0-9-]+-(unknown|[a-z0-9-]+)$/);
    assert.equal(name.includes('_'), false);
    assert.equal(name.includes(' '), false);
  });
});

describe('team worker launch arg inheritance helpers', () => {
  it('collectInheritableTeamWorkerArgs extracts bypass, reasoning, and model overrides', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-5']),
      ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-5']
    );
  });

  it('collectInheritableTeamWorkerArgs supports --model=<value> syntax', () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(['--model=gpt-5.3-codex']),
      ['--model', 'gpt-5.3-codex']
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv merges and normalizes with de-dupe + last reasoning/model wins', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="high" --model old-a --no-alt-screen --model=old-b',
        ['-c', 'model_reasoning_effort="xhigh"', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5'],
        true
      ),
      '--no-alt-screen --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="xhigh" --model old-b'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv can opt out of leader inheritance', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="xhigh"'],
        false
      ),
      '--no-alt-screen'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv uses inherited model when env model is absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--model=gpt-5.3-codex'],
        true
      ),
      '--no-alt-screen --model gpt-5.3-codex'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv uses default model when env and inherited models are absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--dangerously-bypass-approvals-and-sandbox'],
        true,
        'gpt-5.3-codex'
      ),
      '--no-alt-screen --dangerously-bypass-approvals-and-sandbox --model gpt-5.3-codex'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv keeps exactly one final model with precedence env > inherited > default', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--model env-model --model=env-model-final',
        ['--model', 'inherited-model'],
        true,
        'fallback-model'
      ),
      '--model env-model-final'
    );
  });

  it('resolveTeamWorkerLaunchArgsEnv prefers inherited model over default when env model is absent', () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--no-alt-screen',
        ['--model', 'inherited-model'],
        true,
        'fallback-model'
      ),
      '--no-alt-screen --model inherited-model'
    );
  });
});

describe('readTopLevelTomlString', () => {
  it('reads a top-level string value', () => {
    const value = readTopLevelTomlString(
      'model_reasoning_effort = "high"\n[mcp_servers.test]\nmodel_reasoning_effort = "low"\n',
      'model_reasoning_effort'
    );
    assert.equal(value, 'high');
  });

  it('ignores table-local values', () => {
    const value = readTopLevelTomlString(
      '[mcp_servers.test]\nmodel_reasoning_effort = "xhigh"\n',
      'model_reasoning_effort'
    );
    assert.equal(value, null);
  });
});

describe('injectModelInstructionsBypassArgs', () => {
  it('appends model_instructions_file override by default', () => {
    const args = injectModelInstructionsBypassArgs('/tmp/my-project', ['--model', 'gpt-5'], {});
    assert.deepEqual(
      args,
      ['--model', 'gpt-5', '-c', 'model_instructions_file="/tmp/my-project/AGENTS.md"']
    );
  });

  it('does not append when bypass is disabled via env', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['--model', 'gpt-5'],
      { OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: '0' }
    );
    assert.deepEqual(args, ['--model', 'gpt-5']);
  });

  it('does not append when model_instructions_file is already set', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['-c', 'model_instructions_file="/tmp/custom.md"'],
      {}
    );
    assert.deepEqual(args, ['-c', 'model_instructions_file="/tmp/custom.md"']);
  });

  it('respects OMX_MODEL_INSTRUCTIONS_FILE env override', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      [],
      { OMX_MODEL_INSTRUCTIONS_FILE: '/tmp/alt instructions.md' }
    );
    assert.deepEqual(
      args,
      ['-c', 'model_instructions_file="/tmp/alt instructions.md"']
    );
  });

  it('uses session-scoped default model_instructions_file when provided', () => {
    const args = injectModelInstructionsBypassArgs(
      '/tmp/my-project',
      ['--model', 'gpt-5'],
      {},
      '/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md'
    );
    assert.deepEqual(
      args,
      ['--model', 'gpt-5', '-c', 'model_instructions_file="/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md"']
    );
  });
});

describe('upsertTopLevelTomlString', () => {
  it('replaces an existing top-level key', () => {
    const updated = upsertTopLevelTomlString(
      'model_reasoning_effort = "low"\n[tui]\nstatus_line = []\n',
      'model_reasoning_effort',
      'high'
    );
    assert.match(updated, /^model_reasoning_effort = "high"$/m);
    assert.doesNotMatch(updated, /^model_reasoning_effort = "low"$/m);
  });

  it('inserts before the first table when key is missing', () => {
    const updated = upsertTopLevelTomlString(
      '[tui]\nstatus_line = []\n',
      'model_reasoning_effort',
      'xhigh'
    );
    assert.equal(updated, 'model_reasoning_effort = "xhigh"\n[tui]\nstatus_line = []\n');
  });
});
