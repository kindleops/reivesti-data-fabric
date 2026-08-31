// Structured logs only. The Data Fabric is headless: the run log is the operator UI.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
};

export type Logger = {
  child(bindings: Record<string, unknown>): Logger;
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LoggerOptions = {
  bindings?: Record<string, unknown>;
  minLevel?: LogLevel;
  sink?: (record: LogRecord) => void;
  now?: () => Date;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const bindings = options.bindings ?? {};
  const minLevel = options.minLevel ?? (process.env['DF_LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? ((r: LogRecord) => { process.stdout.write(`${JSON.stringify(r)}\n`); });

  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink({ ts: now().toISOString(), level, event, ...bindings, ...fields });
  };

  return {
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
    log,
    debug: (e, f) => { log('debug', e, f); },
    info: (e, f) => { log('info', e, f); },
    warn: (e, f) => { log('warn', e, f); },
    error: (e, f) => { log('error', e, f); },
  };
}

/** Captures records instead of printing them. Used by tests and run reports. */
export function captureLogger(minLevel: LogLevel = 'debug'): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { logger: createLogger({ minLevel, sink: (r) => { records.push(r); } }), records };
}

/** Discards output entirely. */
export function silentLogger(): Logger {
  return createLogger({ sink: () => {}, minLevel: 'error' });
}
