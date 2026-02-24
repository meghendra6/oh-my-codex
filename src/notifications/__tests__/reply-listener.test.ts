import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { sanitizeReplyInput, isReplyListenerProcess } from '../reply-listener.js';

async function waitForReplyListenerIdentity(pid: number, timeoutMs = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isReplyListenerProcess(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return isReplyListenerProcess(pid);
}

function canInspectProcessArgs(): boolean {
  if (process.platform === 'linux') return true;
  const result = spawnSync('ps', ['-p', String(process.pid), '-o', 'args='], {
    encoding: 'utf-8',
    timeout: 1000,
  });
  return result.status === 0 && !result.error;
}

describe('sanitizeReplyInput', () => {
  it('passes through normal text', () => {
    assert.equal(sanitizeReplyInput('hello world'), 'hello world');
  });

  it('strips control characters', () => {
    assert.equal(sanitizeReplyInput('hello\x00world'), 'helloworld');
    assert.equal(sanitizeReplyInput('test\x07bell'), 'testbell');
    assert.equal(sanitizeReplyInput('test\x1bescseq'), 'testescseq');
  });

  it('preserves newlines and normalizes CRLF to LF', () => {
    assert.equal(sanitizeReplyInput('line1\nline2'), 'line1\nline2');
    assert.equal(sanitizeReplyInput('line1\r\nline2'), 'line1\nline2');
  });

  it('escapes backslashes', () => {
    assert.equal(sanitizeReplyInput('path\\to\\file'), 'path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    assert.equal(sanitizeReplyInput('run `cmd`'), 'run \\`cmd\\`');
  });

  it('escapes $( command substitution', () => {
    assert.equal(sanitizeReplyInput('$(whoami)'), '\\$(whoami)');
  });

  it('escapes ${ variable expansion', () => {
    assert.equal(sanitizeReplyInput('${HOME}'), '\\${HOME}');
  });

  it('trims whitespace', () => {
    assert.equal(sanitizeReplyInput('  hello  '), 'hello');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeReplyInput(''), '');
  });

  it('handles whitespace-only string', () => {
    assert.equal(sanitizeReplyInput('   '), '');
  });

  it('handles combined dangerous patterns', () => {
    const input = '$(rm -rf /) && `evil` ${PATH}\nmore';
    const result = sanitizeReplyInput(input);
    // Should not contain unescaped backticks
    assert.ok(result.includes('\n'));
    // $( should be escaped to \$(
    assert.ok(result.includes('\\$('));
    // ${ should be escaped to \${
    assert.ok(result.includes('\\${'));
    // backticks should be escaped
    assert.ok(result.includes('\\`'));
  });

  it('preserves normal special characters', () => {
    assert.equal(sanitizeReplyInput('hello! @user #tag'), 'hello! @user #tag');
  });

  it('handles unicode text', () => {
    const result = sanitizeReplyInput('Hello world');
    assert.ok(result.length > 0);
  });
});

describe('isReplyListenerProcess', () => {
  it('returns false for the current process (test runner has no daemon marker)', () => {
    assert.equal(isReplyListenerProcess(process.pid), false);
  });

  it('returns true for a process whose command line contains the daemon marker', async (t) => {
    if (!canInspectProcessArgs()) {
      t.skip('process argv inspection is unavailable in this environment');
      return;
    }

    // Spawn a long-lived node process whose -e script contains 'pollLoop',
    // matching what startReplyListener injects into the daemon script.
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(err));
    });

    const pid = child.pid!;
    try {
      const result = await waitForReplyListenerIdentity(pid);
      assert.equal(result, true);
    } finally {
      child.kill();
    }
  });

  it('returns false for a process whose command line lacks the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a non-existent PID', () => {
    // PID 0 is never a valid user process
    assert.equal(isReplyListenerProcess(0), false);
  });
});
