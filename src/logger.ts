export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

function write(level: string, message: string, details?: Record<string, unknown>): void {
  const safeDetails = details ? ` ${JSON.stringify(details)}` : '';
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}${safeDetails}\n`);
}

export const logger: Logger = {
  info: (message, details) => write('INFO', message, details),
  warn: (message, details) => write('WARN', message, details),
  error: (message, details) => write('ERROR', message, details),
};
