import { createLogger, resolveLogFilePath, type Logger } from './logger';

export const appLogFilePath = resolveLogFilePath('app.log');

export const createAppLogger = (moduleName: string): Logger => {
  return createLogger(moduleName, appLogFilePath);
};

export const appLogger = createAppLogger('app');
