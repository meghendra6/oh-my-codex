import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../generator.js';

describe('config generator notify', () => {
  it('writes notify as a TOML array by default (Codex expects a sequence)', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = \["node", ".*notify-hook\.js"\]$/m);
      assert.doesNotMatch(toml, /^notify = ".*"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes notify as string when OMX_NOTIFY_FORMAT=string', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    const prev = process.env.OMX_NOTIFY_FORMAT;
    try {
      process.env.OMX_NOTIFY_FORMAT = 'string';
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.match(toml, /^notify = ".*"$/m);
      assert.doesNotMatch(toml, /^notify = \[/m);
      assert.match(toml, /notify = "node /);
    } finally {
      if (prev === undefined) {
        delete process.env.OMX_NOTIFY_FORMAT;
      } else {
        process.env.OMX_NOTIFY_FORMAT = prev;
      }
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('handles paths with spaces in array format', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx config gen space-'));
    const wd = join(base, 'pkg root');
    try {
      await mkdir(wd, { recursive: true });
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      const m = toml.match(/^notify = \["node", "(.*)"\]$/m);
      assert.ok(m, 'notify array not found');
      assert.match(m[1], /pkg root/);
      assert.match(m[1], /notify-hook\.js$/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('escapes backslashes in array format for Windows-style paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-config-gen-win-'));
    const wd = join(base, 'C:\\Users\\alice\\pkg');
    try {
      await mkdir(wd, { recursive: true });
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      const m = toml.match(/^notify = \["node", "(.*)"\]$/m);
      assert.ok(m, 'notify array not found');
      assert.ok(
        m[1].includes('C:\\\\Users\\\\alice\\\\pkg'),
        `expected escaped Windows path, got: ${m[1]}`
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not emit developer_instructions or model_reasoning_effort', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.doesNotMatch(toml, /developer_instructions/);
      assert.doesNotMatch(toml, /model_reasoning_effort/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('re-runs setup by replacing OMX block cleanly', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      await mergeConfig(configPath, wd);

      let toml = await readFile(configPath, 'utf-8');
      toml += '\n# user tail\n[user.settings]\nname = "kept"\n';
      await writeFile(configPath, toml);

      await mergeConfig(configPath, wd);
      const rerun = await readFile(configPath, 'utf-8');

      assert.equal(
        (rerun.match(/# oh-my-codex \(OMX\) Configuration/g) ?? []).length,
        1
      );
      assert.equal((rerun.match(/# End oh-my-codex/g) ?? []).length, 1);
      assert.equal((rerun.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.match(rerun, /^collab = true$/m);
      assert.match(rerun, /^child_agents_md = true$/m);
      assert.match(rerun, /^\[user.settings\]$/m);
      assert.match(rerun, /^name = "kept"$/m);
      assert.match(rerun, /^notify = \["node", ".*notify-hook\.js"\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates a legacy OMX block notify array into current format', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const legacy = [
        '[features]',
        'web_search_request = true',
        '',
        '# ============================================================',
        '# oh-my-codex (OMX) Configuration',
        '# Managed by omx setup - manual edits preserved on next setup',
        '# ============================================================',
        '',
        'notify = ["node", "/tmp/notify-hook.js"]',
        '',
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/tmp/state-server.js"]',
        '',
        '# ============================================================',
        '# End oh-my-codex',
        '',
      ].join('\n');
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.match(merged, /^notify = \["node", ".*notify-hook\.js"\]$/m);
      assert.equal((merged.match(/# oh-my-codex \(OMX\) Configuration/g) ?? []).length, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('merges into existing [features] table without duplicating it', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const original = [
        '[features]',
        'custom_user_flag = false',
        'child_agents_md = false',
        '',
        '[user.settings]',
        'name = "kept"',
        '',
      ].join('\n');
      await writeFile(configPath, original);

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, 'utf-8');

      assert.equal((merged.match(/^\[features\]$/gm) ?? []).length, 1);
      assert.match(merged, /^custom_user_flag = false$/m);
      assert.match(merged, /^collab = true$/m);
      assert.match(merged, /^child_agents_md = true$/m);
      assert.match(merged, /^\[user.settings\]$/m);
      assert.match(merged, /^name = "kept"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates a legacy OMX block and preserves user settings', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-config-gen-'));
    try {
      const configPath = join(wd, 'config.toml');
      const legacy = [
        '[user.before]',
        'name = "kept-before"',
        '',
        '# oh-my-codex (OMX) Configuration',
        '# legacy block without top divider',
        'notify = ["node", "/tmp/legacy notify-hook.js"]',
        '[mcp_servers.omx_state]',
        'command = "node"',
        'args = ["/tmp/state-server.js"]',
        '# End oh-my-codex',
        '',
        '[user.after]',
        'name = "kept-after"',
        '',
      ].join('\n');
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, 'utf-8');

      assert.equal(
        (toml.match(/oh-my-codex \(OMX\) Configuration/g) ?? []).length,
        1
      );
      assert.match(toml, /^\[user.before\]$/m);
      assert.match(toml, /^name = "kept-before"$/m);
      assert.match(toml, /^\[user.after\]$/m);
      assert.match(toml, /^name = "kept-after"$/m);
      assert.match(toml, /^notify = \["node", ".*notify-hook\.js"\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
