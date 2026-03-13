import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

type SchedulerLogLevel = 'INFO' | 'WARN' | 'ERROR';

type SchedulerLogContextValue = string | number | boolean | null | undefined;

type SchedulerLogContext = Record<string, SchedulerLogContextValue>;

const LOG_DIRECTORY_PATH = path.resolve(process.cwd(), 'logs');

export const schedulerLogFilePath = path.join(LOG_DIRECTORY_PATH, 'scheduler.log');

const formatContextValue = (value: SchedulerLogContextValue): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (value === null) {
    return 'null';
  }

  return String(value);
};

const formatContext = (context: SchedulerLogContext): string => {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatContextValue(value)}`)
    .join(' ');
};

const writeToLogFile = (line: string): void => {
  try {
    mkdirSync(LOG_DIRECTORY_PATH, { recursive: true });
    appendFileSync(schedulerLogFilePath, `${line}\n`, 'utf-8');
  } catch (error) {
    console.error('[scheduler] failed to write scheduler log file', error);
  }
};

const writeToConsole = (level: SchedulerLogLevel, line: string, error?: unknown): void => {
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
  level: SchedulerLogLevel,
  message: string,
  context: SchedulerLogContext = {},
  error?: unknown,
): void => {
  const timestamp = new Date().toISOString();
  const contextText = formatContext(context);
  const line = [timestamp, level, '[scheduler]', message, contextText]
    .filter((segment) => segment.length > 0)
    .join(' ');

  writeToConsole(level, line, error);
  writeToLogFile(line);

  if (error instanceof Error && error.stack) {
    writeToLogFile(`${timestamp} ${level} [scheduler] stack=${JSON.stringify(error.stack)}`);
  }
};

export const schedulerLogger = {
  info(message: string, context?: SchedulerLogContext): void {
    log('INFO', message, context);
  },
  warn(message: string, context?: SchedulerLogContext): void {
    log('WARN', message, context);
  },
  error(message: string, context?: SchedulerLogContext, error?: unknown): void {
    log('ERROR', message, context, error);
  },
};
