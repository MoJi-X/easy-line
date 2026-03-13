import express, { type Request, type Response } from 'express';

import { config } from './config';
import webhookRouter from './routes/webhook';
import chatRouter from './routes/chat';
import taskRouter from './routes/tasks';
import { schedulerService } from './services/scheduler';
import { errorHandler, notFoundHandler } from './errors/error-handler';

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

schedulerService.start();

const server = app.listen(config.port, () => {
  console.info(`Server is running on port ${config.port}`);
});

let isShuttingDown = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(`[app] received ${signal}, shutting down`);
  schedulerService.stop();

  server.close(() => {
    console.info('[app] HTTP server closed');
    process.exit(0);
  });
};

process.once('SIGINT', () => {
  shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
