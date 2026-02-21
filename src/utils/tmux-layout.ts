const DEFAULT_HUD_PANE_LINES = 4;
const MIN_HUD_PANE_LINES = 1;
const MAX_HUD_PANE_LINES = 12;

const DEFAULT_TEAM_MAIN_PANE_WIDTH_PERCENT = 50;
const MIN_TEAM_MAIN_PANE_WIDTH_PERCENT = 35;
const MAX_TEAM_MAIN_PANE_WIDTH_PERCENT = 75;

function parseInteger(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveHudPaneLines(env: NodeJS.ProcessEnv): string {
  const parsed = parseInteger(env.OMX_HUD_PANE_LINES);
  if (parsed === null) return String(DEFAULT_HUD_PANE_LINES);
  return String(clamp(parsed, MIN_HUD_PANE_LINES, MAX_HUD_PANE_LINES));
}

export function resolveTeamMainPaneWidthPercent(env: NodeJS.ProcessEnv): string {
  const parsed = parseInteger(env.OMX_TEAM_MAIN_PANE_WIDTH_PERCENT);
  const percent = parsed === null
    ? DEFAULT_TEAM_MAIN_PANE_WIDTH_PERCENT
    : clamp(parsed, MIN_TEAM_MAIN_PANE_WIDTH_PERCENT, MAX_TEAM_MAIN_PANE_WIDTH_PERCENT);
  return `${percent}%`;
}

export function resolveTeamMainPaneWidthCells(windowWidth: number, env: NodeJS.ProcessEnv): string | null {
  if (!Number.isFinite(windowWidth) || windowWidth < 40) return null;
  const percentRaw = resolveTeamMainPaneWidthPercent(env);
  const percent = Number.parseInt(percentRaw.replace('%', ''), 10);
  if (!Number.isFinite(percent)) return String(Math.floor(windowWidth / 2));
  const desired = Math.floor((windowWidth * percent) / 100);
  const minCells = 20;
  const maxCells = Math.max(minCells, windowWidth - 10);
  const clamped = Math.max(minCells, Math.min(maxCells, desired));
  return String(clamped);
}

export function resolveDetachedSessionSize(env: NodeJS.ProcessEnv): { cols: string; rows: string } | null {
  const cols = parseInteger(env.TMUX_COLUMNS) ?? parseInteger(env.COLUMNS);
  const rows = parseInteger(env.TMUX_LINES) ?? parseInteger(env.LINES);
  if (cols === null || rows === null) return null;
  if (cols < 40 || rows < 10) return null;
  return { cols: String(cols), rows: String(rows) };
}
