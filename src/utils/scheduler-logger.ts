import { createLogger, resolveLogFilePath } from './logger';

export const schedulerLogFilePath = resolveLogFilePath('scheduler.log');

export const schedulerLogger = createLogger('scheduler', schedulerLogFilePath);
