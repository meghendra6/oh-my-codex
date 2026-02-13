import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeamSession,
  isTmuxAvailable,
  listTeamSessions,
  sanitizeTeamName,
  sendToWorker,
  waitForWorkerReady,
} from '../tmux-session.js';

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

describe('sanitizeTeamName', () => {
  it('lowercases and strips invalid chars', () => {
    assert.equal(sanitizeTeamName('My Team!'), 'my-team');
  });

  it('truncates to 30 chars', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitizeTeamName(long).length, 30);
  });

  it('rejects empty after sanitization', () => {
    assert.throws(() => sanitizeTeamName('!!!'), /empty/i);
  });
});

describe('sendToWorker validation', () => {
  it('rejects text over 200 chars', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, 'a'.repeat(200)),
      /< 200/i
    );
  });

  it('rejects injection marker', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, `hello [OMX_TMUX_INJECT]`),
      /marker/i
    );
  });
});

describe('tmux-dependent functions when tmux is unavailable', () => {
  it('isTmuxAvailable returns false', () => {
    withEmptyPath(() => {
      assert.equal(isTmuxAvailable(), false);
    });
  });

  it('createTeamSession throws', () => {
    withEmptyPath(() => {
      assert.throws(
        () => createTeamSession('My Team', 1, process.cwd()),
        /tmux is not available/i
      );
    });
  });

  it('listTeamSessions returns empty', () => {
    withEmptyPath(() => {
      assert.deepEqual(listTeamSessions(), []);
    });
  });

  it('waitForWorkerReady returns false on timeout', () => {
    withEmptyPath(() => {
      assert.equal(waitForWorkerReady('omx-team-x', 1, 1), false);
    });
  });
});
