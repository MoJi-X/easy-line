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

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
