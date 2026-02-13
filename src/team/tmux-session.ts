import { spawnSync } from 'child_process';

export interface TeamSession {
  name: string; // tmux session name: "omx-team-{teamName}"
  workerCount: number;
  cwd: string;
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

function sleepSeconds(seconds: number): void {
  // shelling out keeps implementation consistent with the project's pattern
  spawnSync('sleep', [String(seconds)], { encoding: 'utf-8' });
}

// Sanitize team name: lowercase, alphanumeric + hyphens, max 30 chars
export function sanitizeTeamName(name: string): string {
  const lowered = name.toLowerCase();
  const replaced = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');

  const truncated = replaced.slice(0, 30).replace(/-$/, '');
  if (truncated.trim() === '') {
    throw new Error('sanitizeTeamName: empty after sanitization');
  }
  return truncated;
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}

// Create tmux session with N worker windows
// Window 0: "monitor" (for HUD)
// Windows 1..N: "worker-{i}" each running codex.
// Returns TeamSession or throws if tmux not available
export function createTeamSession(teamName: string, workerCount: number, cwd: string): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }

  const safeTeamName = sanitizeTeamName(teamName);
  const sessionName = `omx-team-${safeTeamName}`;

  const session = runTmux(['new-session', '-d', '-s', sessionName, '-n', 'monitor', '-c', cwd]);
  if (!session.ok) {
    throw new Error(`failed to create tmux session: ${session.stderr}`);
  }

  for (let i = 1; i <= workerCount; i++) {
    const cmd = `env OMX_TEAM_WORKER=${safeTeamName}/worker-${i} codex`;
    const win = runTmux(['new-window', '-t', sessionName, '-n', `worker-${i}`, '-c', cwd, cmd]);
    if (!win.ok) {
      throw new Error(`failed to create worker window ${i}: ${win.stderr}`);
    }
    sleepSeconds(0.5);
  }

  return { name: sessionName, workerCount, cwd };
}

function paneTarget(sessionName: string, workerIndex: number): string {
  return `${sessionName}:${workerIndex}`;
}

function paneLooksReady(captured: string): boolean {
  const content = captured.trimEnd();
  if (content === '') return false;

  const lines = content
    .split('\n')
    .map(l => l.replace(/\r/g, ''))
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '');

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  if (/^\s*>\s*/.test(lastLine)) return true;

  // fallback heuristic: codex output tends to contain its name early on
  if (/codex/i.test(content)) return true;

  return false;
}

function paneHasTrustPrompt(captured: string): boolean {
  return /Do you trust the contents of this directory\?/i.test(captured);
}

// Poll tmux capture-pane for Codex prompt indicator (> or similar)
// Uses exponential backoff: 1s, 2s, 4s, 8s (total ~15s)
// Returns true if ready, false on timeout
export function waitForWorkerReady(sessionName: string, workerIndex: number, timeoutMs: number = 15000): boolean {
  const backoffMs = [1000, 2000, 4000, 8000];
  const startedAt = Date.now();

  const check = (): boolean => {
    const result = runTmux(['capture-pane', '-t', paneTarget(sessionName, workerIndex), '-p']);
    if (!result.ok) return false;
    if (paneHasTrustPrompt(result.stdout)) {
      // Opt-in only: do not auto-trust directories unless explicitly configured.
      if (process.env.OMX_TEAM_AUTO_TRUST === '1') {
        runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex), 'Enter']);
        return false;
      }
      return false;
    }
    return paneLooksReady(result.stdout);
  };

  if (check()) return true;

  for (const delay of backoffMs) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return false;

    const remaining = timeoutMs - elapsed;
    sleepSeconds(Math.max(0, Math.min(delay, remaining)) / 1000);

    if (check()) return true;
  }

  return false;
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export function sendToWorker(sessionName: string, workerIndex: number, text: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }

  const target = paneTarget(sessionName, workerIndex);

  const send = runTmux(['send-keys', '-t', target, '-l', '--', text]);
  if (!send.ok) {
    throw new Error(`sendToWorker: failed to send text: ${send.stderr}`);
  }

  const enter = runTmux(['send-keys', '-t', target, 'Enter']);
  if (!enter.ok) {
    throw new Error(`sendToWorker: failed to send Enter: ${enter.stderr}`);
  }
}

// Get PID of the shell process in a worker's tmux pane
export function getWorkerPanePid(sessionName: string, workerIndex: number): number | null {
  const result = runTmux(['list-panes', '-t', paneTarget(sessionName, workerIndex), '-F', '#{pane_pid}']);
  if (!result.ok) return null;

  const firstLine = result.stdout.split('\n')[0]?.trim();
  if (!firstLine) return null;

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid)) return null;
  return pid;
}

// Check if worker's tmux pane has a running process
export function isWorkerAlive(sessionName: string, workerIndex: number): boolean {
  const result = runTmux([
    'list-panes',
    '-t',
    paneTarget(sessionName, workerIndex),
    '-F',
    '#{pane_dead} #{pane_current_command} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;

  const parts = line.split(/\s+/);
  if (parts.length < 3) return false;

  const paneDead = parts[0];
  const paneCommand = parts[1] || '';
  const pid = Number.parseInt(parts[2], 10);

  if (paneDead === '1') return false;
  if (!Number.isFinite(pid)) return false;
  if (!/codex/i.test(paneCommand)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill a specific worker: send C-c, wait, then kill-window if still alive
export function killWorker(sessionName: string, workerIndex: number): void {
  runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex), 'C-c']);
  sleepSeconds(2);

  if (isWorkerAlive(sessionName, workerIndex)) {
    runTmux(['kill-window', '-t', paneTarget(sessionName, workerIndex)]);
  }
}

// Kill entire tmux session. Tolerates already-dead sessions.
export function destroyTeamSession(sessionName: string): void {
  try {
    runTmux(['kill-session', '-t', sessionName]);
  } catch {
    // tolerate
  }
}

// List all tmux sessions matching omx-team-* pattern
export function listTeamSessions(): string[] {
  const result = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (!result.ok) return [];

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(name => name.startsWith('omx-team-'));
}
