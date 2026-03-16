import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export type LogContextValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogContextValue>;

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext, error?: unknown): void;
}

const LOG_DIRECTORY_PATH = path.resolve(process.cwd(), 'logs');

export const resolveLogFilePath = (fileName: string): string => {
  return path.join(LOG_DIRECTORY_PATH, fileName);
};

const formatContextValue = (value: LogContextValue): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (value === null) {
    return 'null';
  }

  return String(value);
};

const formatContext = (context: LogContext): string => {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatContextValue(value)}`)
    .join(' ');
};

const writeToLogFile = (
  moduleName: string,
  filePath: string,
  line: string,
): void => {
  try {
    mkdirSync(LOG_DIRECTORY_PATH, { recursive: true });
    appendFileSync(filePath, `${line}\n`, 'utf-8');
  } catch (error) {
    console.error(
      `[${moduleName}] failed to write log file path=${JSON.stringify(filePath)}`,
      error,
    );
  }
};

const writeToConsole = (
  level: LogLevel,
  line: string,
  error?: unknown,
): void => {
  if (level === 'ERROR') {
    if (error) {
      console.error(line, error);
      return;
    }

    console.error(line);
    return;
  }

  if (level === 'WARN') {
    console.warn(line);
    return;
  }

  console.info(line);
};

const log = (
  level: LogLevel,
  moduleName: string,
  filePath: string,
  message: string,
  context: LogContext = {},
  error?: unknown,
): void => {
  const timestamp = new Date().toISOString();
  const contextText = formatContext(context);
  const line = [timestamp, level, `[${moduleName}]`, message, contextText]
    .filter((segment) => segment.length > 0)
    .join(' ');

  writeToConsole(level, line, error);
  writeToLogFile(moduleName, filePath, line);

  if (error instanceof Error && error.stack) {
    writeToLogFile(
      moduleName,
      filePath,
      `${timestamp} ${level} [${moduleName}] stack=${JSON.stringify(error.stack)}`,
    );
  }
};

export const createLogger = (
  moduleName: string,
  filePath: string,
): Logger => {
  return {
    info(message: string, context?: LogContext): void {
      log('INFO', moduleName, filePath, message, context);
    },
    warn(message: string, context?: LogContext): void {
      log('WARN', moduleName, filePath, message, context);
    },
    error(message: string, context?: LogContext, error?: unknown): void {
      log('ERROR', moduleName, filePath, message, context, error);
    },
  };
};

export const maskUserId = (userId: string | null | undefined): string => {
  if (!userId || userId.length < 6) {
    return '****';
  }

  return `${userId.slice(0, 2)}***${userId.slice(-2)}`;
};

export const maskToken = (token: string | null | undefined): string => {
  if (!token || token.length < 8) {
    return '****';
  }

  return `${token.slice(0, 4)}***${token.slice(-4)}`;
};
