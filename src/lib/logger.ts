// Structured JSON-lines logger: one JSON object per line, level-filtered.
// Machine-readable first (grep/jq friendly), human-tolerable second.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => emit('debug', msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => emit('info', msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => emit('warn', msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => emit('error', msg, fields),
};
