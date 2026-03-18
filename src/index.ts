import type { Server } from 'node:http';

import express, { type Request, type Response } from 'express';

import { errorHandler, notFoundHandler } from './errors/error-handler';
import { appLogger } from './utils/app-logger';

type ShutdownReason = NodeJS.Signals | 'uncaughtException' | 'bootstrapFailure';

let server: Server | null = null;
let isShuttingDown = false;

const shutdown = (reason: ShutdownReason, exitCode = 0): void => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  appLogger.info('application shutdown started', { reason, exitCode });

  if (!server) {
    process.exit(exitCode);
    return;
  }

  server.close(() => {
    appLogger.info('HTTP server closed', { reason, exitCode });
    process.exit(exitCode);
  });
};

process.on('unhandledRejection', (reason) => {
  appLogger.error('unhandled promise rejection', {}, reason);
});

process.on('uncaughtException', (error) => {
  appLogger.error('uncaught exception', {}, error);
  shutdown('uncaughtException', 1);
});

process.once('SIGINT', () => {
  appLogger.info('shutdown signal received', { signal: 'SIGINT' });
  shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  appLogger.info('shutdown signal received', { signal: 'SIGTERM' });
  shutdown('SIGTERM');
});

const bootstrap = (): void => {
  try {
    const { config } = require('./config') as typeof import('./config');
    const { taskRepository } = require('./services/task-repository') as typeof import('./services/task-repository');
    const { schedulerService } = require('./services/scheduler') as typeof import('./services/scheduler');
    const webhookRouter = (require('./routes/webhook') as typeof import('./routes/webhook')).default;
    const chatRouter = (require('./routes/chat') as typeof import('./routes/chat')).default;
    const taskRouter = (require('./routes/tasks') as typeof import('./routes/tasks')).default;

    taskRepository.subscribe((event) => {
      schedulerService.notifyTasksUpdated(event);
    });
    schedulerService.notifyTasksUpdated({
      action: 'reload',
      tasks: taskRepository.listAllTasks(),
    });

    const app = express();

    app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok' });
    });

    app.use(webhookRouter);
    app.use(express.json());
    app.use(chatRouter);
    app.use('/api', taskRouter);

    app.use(notFoundHandler);
    app.use(errorHandler);

    server = app.listen(config.port, () => {
      appLogger.info('server started', { port: config.port });
    });
  } catch (error) {
    appLogger.error('application bootstrap failed', {}, error);
    shutdown('bootstrapFailure', 1);
  }
};

bootstrap();
