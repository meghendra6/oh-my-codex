import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
